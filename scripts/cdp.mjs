// A small Chrome DevTools Protocol client for egg's browser checks.
// Node 22 or newer, no dependencies.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Start a throwaway headless Chrome; returns { port, stop }. */
export async function launchChrome(port = 9355) {
  const profile = mkdtempSync(join(tmpdir(), "egg-chrome-"));
  const child = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,900",
    "--no-first-run",
    "--no-default-browser-check",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "about:blank",
  ], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      break;
    } catch {
      await sleep(100);
    }
  }
  return {
    port,
    async stop() {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        // Chrome may still be writing; the folder is in the temp directory
      }
    },
  };
}

/** Connect to the first page target. */
export async function firstPage(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find((t) => t.type === "page");
  if (!target) throw new Error("no page target");
  return attach(target.webSocketDebuggerUrl);
}

export async function attach(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let next = 0;
  const pending = new Map();
  const errors = [];
  const listeners = [];
  ws.onmessage = (message) => {
    const msg = JSON.parse(message.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    if (msg.method === "Target.attachedToTarget") childFrames.push({ sessionId: msg.params.sessionId, ...msg.params.targetInfo });
    if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    for (const l of listeners) l(msg);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      pending.set(++next, { resolve, reject });
      ws.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  /** Out-of-process frames (sandboxed iframes may be), attached as they appear. */
  const childFrames = [];
  const page = {
    send,
    errors,
    on: (fn) => listeners.push(fn),
    close: () => ws.close(),
    async eval(expression, contextId) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
      return r.result.value;
    },
    async goto(url, wait = 2000) {
      await send("Page.navigate", { url });
      await sleep(wait);
    },
    async waitFor(expression, { timeout = 20000, label = expression } = {}) {
      const end = Date.now() + timeout;
      for (;;) {
        const v = await page.eval(expression).catch(() => null);
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
        await sleep(250);
      }
    },
    /** A trusted key press. */
    async key(key, { code } = {}) {
      const named = { Enter: 13, Escape: 27, " ": 32 };
      const vk = named[key] ?? key.toUpperCase().charCodeAt(0);
      const keyCode = code ?? (key === " " ? "Space" : key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key);
      const text = key.length === 1 ? key : key === "Enter" ? "\r" : undefined;
      const shift = key.length === 1 && /[A-Z?$]/.test(key) ? 8 : 0;
      await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code: keyCode, windowsVirtualKeyCode: vk, modifiers: shift, ...(text ? { text } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: keyCode, windowsVirtualKeyCode: vk, modifiers: shift });
      await sleep(200);
    },
    async type(text) {
      await send("Input.insertText", { text });
      await sleep(150);
    },
    /** Evaluate inside a frame, in an isolated world that shares the frame's DOM. */
    async evalInFrame(frameId, expression) {
      const { executionContextId } = await send("Page.createIsolatedWorld", { frameId, worldName: "egg-check" });
      return page.eval(expression, executionContextId);
    },
    /** Evaluate in an out-of-process frame's own session. */
    async evalInChild(sessionId, expression) {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
      return r.result.value;
    },
    childFrames,
    async frames() {
      const { frameTree } = await send("Page.getFrameTree");
      const out = [];
      const walk = (node) => {
        out.push(node.frame);
        for (const child of node.childFrames ?? []) walk(child);
      };
      walk(frameTree);
      return out;
    },
    async shot(file) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(file, Buffer.from(r.data, "base64"));
    },
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  return page;
}
