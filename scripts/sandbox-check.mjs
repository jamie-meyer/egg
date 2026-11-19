// Proves that a generated view cannot reach the page that shows it, that
// page's storage or cookies, or the network.
//
// A local server stands in for bb's page. It serves egg's own sandbox code
// to the page, so views are sanitised by Chrome's parser exactly as in egg.
//
// Part 1, the parent page. The host page sets a cookie, a localStorage value
// and a global, and shows two hostile views:
//   - "as shipped": egg's own frames, allowlist and policies;
//   - "scripts on": one frame with scripts allowed (by the sandbox and the
//     policy) and nothing taken out, to show that even then parent access
//     throws and fetches are blocked.
// The views try parent and top access, cookies, storage, fetch, XHR, an
// image, a stylesheet, a CSS background, a meta refresh, a beacon and a
// WebSocket, all pointing at the local server.
//
// Part 2, the way out by navigation. Every view in test/hostile.ts is shown
// three ways, so that no barrier is the only one:
//   - "shipped": allowlist, inner sandboxed frame, egg's outer frame;
//   - "frame-only": nothing taken out, inside egg's two frames;
//   - "allowlist-only": allowlist, one sandboxed frame, no outer frame.
// Each is loaded, then every element in it gets a real (trusted) mouse
// click at its centre, then every link, area, button and form is clicked or
// submitted from DevTools as well. An http: listener must see no request
// from any way, and stand-in https: listeners (one per way, counting any
// connection) must see nothing from "shipped" or "allowlist-only". In
// "frame-only", Chrome may open a connection to an https: link's host on
// mouse down (a preconnect, no request); the check reports it.
//
// Needs Chrome. Run outside any command sandbox: node scripts/sandbox-check.mjs
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { createServer as createTcpServer } from "node:net";
import { PLAIN_THEME, frameDocument, viewPage } from "../src/sandbox.ts";
import { hostileCases } from "../test/hostile.ts";
import { firstPage, launchChrome, sleep } from "./cdp.mjs";

const sandboxJs = stripTypeScriptTypes(readFileSync(new URL("../src/sandbox.ts", import.meta.url), "utf8"));
const EXPECTED = new Set(["/host", "/sandbox.js", "/favicon.ico"]);
const requests = [];
let hostPage = "";
const server = createServer((req, res) => {
  requests.push(req.url);
  if (req.url === "/host") {
    res.setHeader("content-type", "text/html");
    res.end(hostPage);
  } else if (req.url === "/sandbox.js") {
    res.setHeader("content-type", "text/javascript");
    res.end(sandboxJs);
  } else {
    res.statusCode = 204;
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

// Stand-ins for https: servers. Chrome's TLS handshake fails, but the
// connection arriving is enough to show that a request left.
const WAYS = ["shipped", "frame-only", "allowlist-only"];
const tls = {};
for (const way of WAYS) {
  const listener = { connections: 0, server: createTcpServer((s) => { listener.connections++; s.destroy(); }) };
  await new Promise((r) => listener.server.listen(0, "127.0.0.1", r));
  listener.url = `https://127.0.0.1:${listener.server.address().port}`;
  tls[way] = listener;
}

// egg's page around an empty view, built here in Node: there is nothing to parse.
const noParser = () => ({ documentElement: null, body: null });
const emptyPage = () => viewPage("html", "", PLAIN_THEME, noParser);
const json = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

/**
 * The host page builds its frames with egg's code: `frames` is a list of
 * { id, way, html } (html is sanitised in the page) or { id, srcdoc, sandbox }.
 */
const host = (frames, prelude = "") => `<!doctype html><html><head><title>host</title><style>body{margin:0}iframe{position:absolute;top:0;width:460px;height:400px;border:0}</style></head><body>${prelude}
<script type="module">
import { frameDocument, viewDocument, viewPage, VIEW_SANDBOX } from "/sandbox.js";
const frames = ${json(frames)};
frames.forEach((f, i) => {
  const el = document.createElement("iframe");
  el.id = f.id;
  el.style.left = (i * 480) + "px";
  el.setAttribute("sandbox", f.sandbox ?? VIEW_SANDBOX);
  el.srcdoc = f.srcdoc ?? (f.way === "allowlist-only" ? viewPage("html", f.html) : viewDocument("html", f.html));
  document.body.append(el);
});
document.body.dataset.ready = "1";
</script></body></html>`;

const chrome = await launchChrome(9356);
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

const page = await firstPage(chrome.port);
// Follow frames that Chrome puts in processes of their own, nested ones too.
const sessions = new Set();
page.on((msg) => {
  if (msg.method === "Target.attachedToTarget") {
    const id = msg.params.sessionId;
    sessions.add(id);
    page.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, id).catch(() => {});
  }
  if (msg.method === "Target.detachedFromTarget") sessions.delete(msg.params.sessionId);
});

/** Every frame in every process: [{ session, frameId, url }]. */
async function allFrames() {
  const out = [];
  for (const session of [undefined, ...sessions]) {
    const tree = await page.send("Page.getFrameTree", {}, session).catch(() => null);
    if (!tree) continue;
    const walk = (node) => {
      out.push({ session, frameId: node.frame.id, url: node.frame.url });
      for (const child of node.childFrames ?? []) walk(child);
    };
    walk(tree.frameTree);
  }
  return out;
}

/** Evaluate in a frame, in an isolated world that shares its DOM (scripts may be off in the frame). */
async function evalIn(frame, expression) {
  try {
    const { executionContextId } = await page.send("Page.createIsolatedWorld", { frameId: frame.frameId, worldName: "egg-check" }, frame.session);
    const r = await page.send("Runtime.evaluate", { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true }, frame.session);
    return r.exceptionDetails ? undefined : r.result.value;
  } catch {
    return undefined;
  }
}

/** The frames that show a view, keyed by the text of its marker. */
async function viewFrames() {
  const found = new Map();
  for (const f of await allFrames()) {
    const mark = await evalIn(f, "document.querySelector('.egg-case')?.textContent ?? null");
    if (mark) found.set(mark, f);
  }
  return found;
}

async function trustedClick(x, y) {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
}

const unexpected = () => requests.filter((u) => !EXPECTED.has(u));

try {
  // ---- Part 1: the parent page, its cookie and storage ----
  const hostileView = (leak) => `<p class="egg-case">parent</p><h1>hostile view</h1>
<meta http-equiv="refresh" content="1;url=${leak}/refresh">
<link rel="stylesheet" href="${leak}/css"><link rel="prefetch" href="${leak}/prefetch">
<style>body{background:url(${leak}/bg)}</style>
<a id="go" href="${leak}/link">a link</a><img src="${leak}/img">
<script>
const out = {};
const tryIt = (name, fn) => { try { out[name] = "reached: " + String(fn()); } catch (e) { out[name] = "blocked: " + e.name; } };
tryIt("parent.document", () => parent.document.title);
tryIt("parent global", () => parent.eggSecret);
tryIt("top.location", () => top.location.href);
tryIt("set parent title", () => { parent.document.title = "pwned"; return "set"; });
tryIt("own cookie", () => document.cookie);
tryIt("localStorage", () => localStorage.getItem("eggSecret"));
tryIt("beacon", () => navigator.sendBeacon("${leak}/beacon", "x"));
tryIt("websocket", () => new WebSocket("ws://127.0.0.1:${port}${leak.slice(base.length)}/ws"));
tryIt("xhr", () => { const x = new XMLHttpRequest(); x.open("GET", "${leak}/xhr"); x.send(); return "sent"; });
document.getElementById("go").click();
fetch("${leak}/fetch").then(() => { out.fetch = "reached"; }, (e) => { out.fetch = "blocked: " + e.name; }).finally(() => { document.body.dataset.result = JSON.stringify(out); });
</script>`;
  // Worse than shipped: scripts allowed by both the sandbox and the policy,
  // nothing taken out, one frame; only the opaque origin and connect-src stand.
  const scriptsOn = emptyPage()
    .replace("script-src 'none'", "script-src 'unsafe-inline'")
    .replace("<body></body>", `<body data-variant="scripts">${hostileView(`${base}/scripts`).replace('class="egg-case">parent', 'class="egg-case">scripts')}</body>`);
  hostPage = host(
    [{ id: "shipped", way: "shipped", html: hostileView(`${base}/shipped`) }, { id: "scripts", srcdoc: scriptsOn, sandbox: "allow-scripts" }],
    `<script>document.cookie = "eggSecret=1"; localStorage.setItem("eggSecret", "1"); window.eggSecret = "1";</script>`,
  );
  await page.goto(`${base}/host`, 3500);
  const fromShipped = requests.filter((u) => u.startsWith("/shipped/"));
  const fromScripts = requests.filter((u) => u.startsWith("/scripts/"));
  check(fromShipped.length === 0, `as shipped: the network saw nothing from the view (${JSON.stringify(fromShipped)})`);
  // With scripts on and no outer frame, the one way out left is the frame
  // navigating itself (a clicked link); that is why egg turns scripts off,
  // takes link targets out and adds the outer frame. Everything else must
  // still be blocked.
  check(fromScripts.every((u) => u === "/scripts/link"), `scripts on: nothing reached the network but the frame navigating itself (${JSON.stringify(fromScripts)})`);
  check((await page.eval("document.title")) === "host", "the parent's title is untouched");
  check(
    (await page.eval("[...document.querySelectorAll('iframe')].every((f) => f.contentDocument === null)")) === true,
    "from the parent, both views are opaque (contentDocument is null)",
  );
  const views = await viewFrames();
  const inShipped = views.get("parent");
  check(!!inShipped, `as shipped: the view rendered in egg's inner frame (${views.size} view frames found)`);
  if (inShipped) {
    check((await evalIn(inShipped, "document.querySelector('h1')?.textContent ?? null")) === "hostile view", "as shipped: the view's content renders");
    check((await evalIn(inShipped, "document.body.dataset.result ?? null")) === null, "as shipped: the view's script never ran");
    check((await evalIn(inShipped, "document.body.querySelector('script, meta, link, [href], [src]') === null")) === true, "as shipped: no script, refresh, link or address is left in the view");
  }
  // The scripts-on frame navigated itself away (that is the leak above), so
  // its result is read from a fresh load without the link.
  hostPage = host([{ id: "scripts", srcdoc: scriptsOn.replace('document.getElementById("go").click();', ""), sandbox: "allow-scripts" }]);
  await page.goto(`${base}/host`, 2500);
  const inScripts = (await viewFrames()).get("scripts");
  const raw = inScripts ? await evalIn(inScripts, "document.body.dataset.result ?? null") : null;
  const result = raw ? JSON.parse(raw) : null;
  console.log("     scripts on, what the view's script saw:", result);
  check(result !== null, "scripts on: the script ran (so the attempts were real)");
  if (result) {
    for (const key of ["parent.document", "parent global", "top.location", "set parent title", "own cookie", "localStorage", "fetch"]) {
      check(String(result[key]).startsWith("blocked"), `scripts on: ${key} is ${result[key]}`);
    }
  }
  check((await page.eval("document.cookie.includes('eggSecret=1') && localStorage.getItem('eggSecret') === '1'")) === true, "the parent's cookie and storage are as they were");

  // ---- Part 2: hostile views, loaded and clicked ----
  const perWay = Object.fromEntries(WAYS.map((way) => [way, hostileCases(`${base}/${way}`, tls[way].url)]));
  const names = perWay.shipped.map((c) => c.name);
  const preconnects = [];
  for (const [index, name] of names.entries()) {
    requests.length = 0;
    const tlsBefore = Object.fromEntries(WAYS.map((w) => [w, tls[w].connections]));
    const frames = WAYS.map((way) => {
      const c = perWay[way][index];
      const html = `<p class="egg-case">${way}/${name}</p>${c.html}`;
      if (way !== "frame-only") return { id: way, way, html };
      // Nothing taken out: egg's policy first, then the raw view, inside egg's outer frame.
      const inner = emptyPage().replace("<body></body>", `<body>${html}</body>`);
      return { id: way, srcdoc: frameDocument(inner) };
    });
    hostPage = host(frames);
    await page.goto(`${base}/host`, 1800);
    const found = await viewFrames();
    const rendered = WAYS.filter((w) => found.has(`${w}/${name}`));
    // A real click at the centre of every element in each view.
    let clicks = 0;
    for (const [i, way] of WAYS.entries()) {
      const f = found.get(`${way}/${name}`);
      if (!f) continue;
      const points = (await evalIn(f, `[...document.body.querySelectorAll("*")].filter((e) => !e.matches(".egg-case")).slice(0, 40).map((e) => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width, r.height]; }).filter(([, , w, h]) => w > 0 && h > 0)`)) ?? [];
      for (const [x, y] of points) {
        if (x > 455 || y > 395) continue;
        await trustedClick(i * 480 + x, y);
        clicks++;
        await sleep(60);
      }
    }
    await sleep(500);
    // Then every link, area, button and form, from DevTools, in whatever is still there.
    for (const f of (await viewFrames()).values()) {
      await evalIn(f, `(() => { for (const e of document.querySelectorAll("a, area, button, input, summary")) { try { e.click(); } catch {} } for (const form of document.forms) { try { form.requestSubmit(); } catch {} } })()`);
    }
    await sleep(900);
    const seen = unexpected();
    const connections = Object.fromEntries(WAYS.map((w) => [w, tls[w].connections - tlsBefore[w]]));
    check(
      seen.length === 0 && connections.shipped === 0 && connections["allowlist-only"] === 0,
      `${name}: nothing arrived from the shipped or allowlist-only view (${rendered.length}/3 rendered, ${clicks} real clicks; http ${JSON.stringify(seen)}, https connections ${JSON.stringify(connections)})`,
    );
    // With the markup left in, Chrome still opens a connection to an https:
    // link's host when the mouse goes down on it (a preconnect), before and
    // apart from any navigation; no request is sent and the outer frame
    // cannot stop it. Only the allowlist does, by leaving no address.
    if (connections["frame-only"] > 0) {
      preconnects.push(name);
      console.log(`     frame-only ${name}: ${connections["frame-only"]} https connection(s) without a request (preconnect on mouse down)`);
    }
    check(rendered.length === 3, `${name}: all three ways rendered (${rendered.join(", ")})`);
  }
  // Control: the first bypass with neither barrier (raw, one sandboxed
  // frame) must leak when clicked, or the clicks above proved nothing.
  requests.length = 0;
  const control = hostileCases(`${base}/control`, tls.shipped.url)[0];
  hostPage = host([{ id: "control", srcdoc: emptyPage().replace("<body></body>", `<body>${control.html}</body>`) }]);
  await page.goto(`${base}/host`, 1500);
  await trustedClick(20, 20);
  await sleep(1000);
  check(requests.some((u) => u.startsWith("/control/")), `control: with neither barrier, a click on ${control.name} does leak (${JSON.stringify(unexpected())})`);
  console.log(`     the outer frame stopped every navigation in the frame-only way; preconnects seen there: ${preconnects.length ? preconnects.join(", ") : "none"}`);
  page.close();
} finally {
  await chrome.stop();
  server.close();
  for (const way of WAYS) tls[way].server.close();
}
console.log(failed ? "sandbox check FAILED" : "sandbox check passed");
process.exit(failed ? 1 : 0);
