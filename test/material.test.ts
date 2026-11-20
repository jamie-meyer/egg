import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copyOut, excludeFromGit, ledgerEntrySchema, listFiles, mergeLedger, noteSchema, parseJsonl, restore, viewFileKind } from "../src/material.ts";
import { builtFromLedger, ledgerLine, ranCommand } from "../src/provenance.ts";

test("ledger lines: bad lines counted, a finishing line keeps what the starting line said", () => {
  const { items, bad } = parseJsonl(
    [JSON.stringify({ id: "r1", for: "build", command: "make  -j8", output: ".egg/logs/build.log", exit: null }), "{oops", JSON.stringify({ for: "no id" }), JSON.stringify({ id: "r1", exit: 2 })].join("\n"),
    ledgerEntrySchema,
  );
  assert.equal(bad, 2);
  const merged = mergeLedger(items);
  assert.deepEqual(merged, [{ id: "r1", at: "", for: "build", command: "make -j8", output: ".egg/logs/build.log", exit: 2 }]);
  assert.equal(ledgerLine(merged[0]!), "r1 · build · $ make -j8 · exit 2 · → .egg/logs/build.log");
});

test("notes need text; long text is capped", () => {
  const { items, bad } = parseJsonl(`${JSON.stringify({ text: "x".repeat(2000) })}\n${JSON.stringify({ at: "now" })}\n`, noteSchema);
  assert.equal(bad, 1);
  assert.equal(items[0]!.text.length, 600);
});

test("only plain page names are pages", () => {
  assert.deepEqual(viewFileKind("slowest.html"), { base: "slowest", format: "html" });
  assert.deepEqual(viewFileKind("a-b_c.txt"), { base: "a-b_c", format: "text" });
  for (const bad of ["../x.html", ".hidden.html", "x.json", "x.htm", "x y.html"]) assert.equal(viewFileKind(bad), null, bad);
});

test("copy out: regular files only, symlinks never followed, unchanged files not copied again, big files skipped", async () => {
  const from = mkdtempSync(join(tmpdir(), "egg-m-"));
  const to = join(mkdtempSync(join(tmpdir(), "egg-out-")), "material");
  const secret = mkdtempSync(join(tmpdir(), "egg-secret-"));
  writeFileSync(join(secret, "key"), "secret");
  mkdirSync(join(from, "logs"));
  writeFileSync(join(from, "logs", "a.log"), "hello");
  writeFileSync(join(from, "big.bin"), Buffer.alloc(2000));
  symlinkSync(join(secret, "key"), join(from, "link"));
  symlinkSync(secret, join(from, "dirlink"));
  const first = await copyOut(from, to, 1000);
  assert.deepEqual(first.copied, ["logs/a.log"]);
  assert.deepEqual(first.skipped, [{ path: "big.bin", size: 2000 }]);
  assert.equal(existsSync(join(to, "link")), false);
  assert.equal(existsSync(join(to, "dirlink")), false);
  assert.deepEqual((await copyOut(from, to, 1000)).copied, [], "nothing changed");
  writeFileSync(join(from, "logs", "a.log"), "hello again");
  assert.deepEqual((await copyOut(from, to, 1000)).copied, ["logs/a.log"]);
  assert.equal(readFileSync(join(to, "logs", "a.log"), "utf8"), "hello again");
  assert.deepEqual((await listFiles(from)).files.map((f) => f.path), ["big.bin", "logs/a.log"]);
});

test("restore puts saved material into a workspace that has none, never over material already there", async () => {
  const saved = mkdtempSync(join(tmpdir(), "egg-saved-"));
  writeFileSync(join(saved, "ledger.jsonl"), "{}\n");
  const ws = mkdtempSync(join(tmpdir(), "egg-ws-"));
  assert.deepEqual(await restore(saved, join(ws, ".egg")), { restored: 1, skippedBecause: null });
  assert.equal(readFileSync(join(ws, ".egg", "ledger.jsonl"), "utf8"), "{}\n");
  assert.equal((await restore(saved, join(ws, ".egg"))).skippedBecause, "the workspace already has material");
  assert.equal((await restore(join(saved, "nothing"), join(ws, "other"))).skippedBecause, "nothing was saved");
});

test("info/exclude gets /.egg/ once, keeping what was there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "egg-git-"));
  const path = join(dir, "info", "exclude");
  assert.equal(await excludeFromGit(path), true);
  assert.equal(await excludeFromGit(path), false);
  writeFileSync(path, "*.o");
  assert.equal(await excludeFromGit(path), true);
  assert.equal(readFileSync(path, "utf8"), "*.o\n# egg's material (see .egg/)\n/.egg/\n");
});

test("a ledger entry is confirmed only by the room thread's own commands", () => {
  assert.equal(ranCommand("npm test", ["cd /ws && npm test 2>&1 | tee log"]), true);
  assert.equal(ranCommand("npm test", ["npm run build"]), false);
  assert.equal(ranCommand("", ["anything"]), false);
  const { entries, ids } = builtFromLedger(["r2", "r1", "r1", "zz"], [
    { id: "r1", for: "tests", command: "npm test", output: "", exit: 0 },
    { id: "r2", for: "claimed", command: "make check", output: "", exit: null },
  ], ["npm test"], { folder: "/ws", storageRoot: null });
  assert.deepEqual(ids, ["r2", "r1"]);
  assert.deepEqual(entries.map((e) => [e.kind, e.what.split(" · ")[0], e.unconfirmed ?? false]), [["ledger", "r2", true], ["ledger", "r1", false], ["command", "npm test", false]]);
});
