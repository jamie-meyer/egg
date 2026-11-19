// Proves that a generated view cannot reach the page that shows it, that
// page's storage or cookies, or the network.
//
// A local server serves a host page that sets a cookie, a localStorage
// value and a global, and shows two hostile views:
//   - "as shipped": egg's own srcdoc and sandbox attribute;
//   - "scripts on": the same document with scripts allowed (by the sandbox
//     and the policy) and nothing taken out, to show that even then parent
//     access throws and fetches are blocked.
// The views try parent and top access, cookies, storage, fetch, XHR, an
// image, a stylesheet, a CSS background, a meta refresh, a beacon and a
// WebSocket, all pointing at the local server. The check passes when the
// server sees nothing but the host page and the parent is untouched.
//
// Needs Chrome. Run outside any command sandbox: node scripts/sandbox-check.mjs
import { createServer } from "node:http";
import { VIEW_SANDBOX, viewDocument } from "../src/sandbox.ts";
import { firstPage, launchChrome, sleep } from "./cdp.mjs";

const requests = [];
const server = createServer((req, res) => {
  requests.push(req.url);
  if (req.url === "/host") {
    res.setHeader("content-type", "text/html");
    res.end(hostPage);
  } else {
    res.statusCode = 204;
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const hostileView = (leak) => `<!doctype html><html><head><title>view</title></head><body>
<meta http-equiv="refresh" content="1;url=${leak}/refresh">
<link rel="stylesheet" href="${leak}/css"><link rel="prefetch" href="${leak}/prefetch">
<style>body{background:url(${leak}/bg)}</style>
<a id="go" href="${leak}/link">a link</a>
<h1>hostile view</h1><img src="${leak}/img">
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
</script></body></html>`;

const asShipped = viewDocument("html", hostileView(`${base}/shipped`));
// Worse than shipped: scripts allowed by both the sandbox and the policy,
// nothing taken out; only the opaque origin and connect-src stand.
const scriptsOn = asShipped
  .replace("script-src 'none'", "script-src 'unsafe-inline'")
  .replace(/<body>[\s\S]*$/, hostileView(`${base}/scripts`).replace(/^[\s\S]*?<body>/, '<body data-variant="scripts">'));
const attr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

const hostPage = `<!doctype html><html><head><title>host</title></head><body>
<script>document.cookie = "eggSecret=1"; localStorage.setItem("eggSecret", "1"); window.eggSecret = "1";</script>
<iframe id="shipped" sandbox="${VIEW_SANDBOX}" srcdoc="${attr(asShipped)}"></iframe>
<iframe id="scripts" sandbox="allow-scripts" srcdoc="${attr(scriptsOn)}"></iframe>
</body></html>`;

const chrome = await launchChrome(9356);
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};
try {
  const page = await firstPage(chrome.port);
  await page.goto(`${base}/host`, 3500);
  await sleep(2500);
  const fromShipped = requests.filter((u) => u.startsWith("/shipped/"));
  const fromScripts = requests.filter((u) => u.startsWith("/scripts/"));
  check(fromShipped.length === 0, `as shipped: the network saw nothing from the view (${JSON.stringify(fromShipped)})`);
  // With scripts on, the one way out left is the frame navigating itself
  // (a clicked link); that is why egg turns scripts off and takes link
  // targets out. Everything else must still be blocked.
  check(fromScripts.every((u) => u === "/scripts/link"), `scripts on: nothing reached the network but the frame navigating itself (${JSON.stringify(fromScripts)})`);
  check((await page.eval("document.title")) === "host", "the parent's title is untouched");
  check(
    (await page.eval("[...document.querySelectorAll('iframe')].every((f) => f.contentDocument === null)")) === true,
    "from the parent, both views are opaque (contentDocument is null)",
  );
  // A view runs in-process or, where Chrome isolates sandboxed frames, in a frame of its own.
  const inProcess = (await page.frames()).slice(1);
  const children = page.childFrames.filter((t) => t.type === "iframe");
  const views = inProcess.length === 2
    ? inProcess.map((f) => (expr) => page.evalInFrame(f.id, expr))
    : children.map((t) => (expr) => page.evalInChild(t.sessionId, expr));
  check(views.length === 2, `both views rendered as frames (${inProcess.length} in process, ${children.length} isolated)`);
  const variants = await Promise.all(views.map((v) => v("document.body.dataset.variant ?? 'shipped'")));
  const inShipped = views[variants.indexOf("shipped")];
  const inScripts = views[variants.indexOf("scripts")];
  const shippedResult = await inShipped("document.body.dataset.result ?? null");
  const shippedText = await inShipped("document.querySelector('h1')?.textContent ?? null");
  check(shippedText === "hostile view", "as shipped: the view's content renders");
  check(shippedResult === null, "as shipped: the view's script never ran");
  const raw = await inScripts("document.body.dataset.result ?? null");
  const result = raw ? JSON.parse(raw) : null;
  console.log("     scripts on, what the view's script saw:", result);
  check(result !== null, "scripts on: the script ran (so the attempts were real)");
  if (result) {
    for (const key of ["parent.document", "parent global", "top.location", "set parent title", "own cookie", "localStorage", "fetch"]) {
      check(String(result[key]).startsWith("blocked"), `scripts on: ${key} is ${result[key]}`);
    }
  }
  check((await page.eval("document.cookie.includes('eggSecret=1') && localStorage.getItem('eggSecret') === '1'")) === true, "the parent's cookie and storage are as they were");
  page.close();
} finally {
  await chrome.stop();
  server.close();
}
console.log(failed ? "sandbox check FAILED" : "sandbox check passed");
process.exit(failed ? 1 : 0);
