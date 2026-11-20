import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LedgerRecord } from "../src/model.ts";
import { ledgerEntry, ledgerLine, refreshLedgerEntries } from "../src/provenance.ts";
import {
  type ReadRecord,
  type RunFacts,
  STALE_MS,
  buildLedger,
  carryOver,
  installRunner,
  killRun,
  notebookLine,
  openSummary,
  pidAlive,
  readRecords,
  runRecordSchema,
  runState,
  wakeRule,
} from "../src/runs.ts";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const rec = (over: Record<string, unknown>, mtimeMs = NOW - 5000): ReadRecord => ({
  record: runRecordSchema.parse({ id: "r1", for: "build", command: "make -j8", log: ".egg/logs/r1.log", pid: 100, pgid: 99, detached: true, startedMs: NOW - 14 * 60_000, exit: null, ...over }),
  mtimeMs,
});
const facts = (over: Partial<RunFacts> = {}): RunFacts => ({ alive: () => true, now: NOW, stopped: new Set(), ...over });

test("a run's state: running while its process is alive and its record fresh; exited; died; stopped; started", () => {
  assert.equal(runState(rec({}), facts()), "running");
  assert.equal(runState(rec({ exit: 2, endedMs: NOW - 1000 }), facts()), "exited");
  assert.equal(runState(rec({}), facts({ alive: () => false })), "died", "process gone, no exit recorded");
  assert.equal(runState(rec({}, NOW - STALE_MS - 1000), facts()), "died", "a detached run's record untouched for ten minutes: its pid was reused");
  assert.equal(runState(rec({ detached: false }, NOW - STALE_MS - 1000), facts()), "running", "a foreground run is not touched while it runs");
  assert.equal(runState(rec({}), facts({ alive: () => null })), "running", "cannot tell: trust the fresh record");
  assert.equal(runState(rec({}), facts({ stopped: new Set(["r1"]) })), "stopped");
  assert.equal(runState(rec({ exit: 143 }), facts({ stopped: new Set(["r1"]) })), "stopped", "egg's stop wins over the exit it caused");
  assert.equal(runState(rec({ pid: null }, NOW - 1000), facts()), "started");
  assert.equal(runState(rec({ pid: null }, NOW - 60_000), facts()), "died");
});

test("the ledger is built from records; a line with no record is claimed, never running or passed", () => {
  const records = [rec({ id: "r2", startedMs: NOW - 60_000, exit: 0, endedMs: NOW - 30_000, for: "" }), rec({ id: "r1" })];
  const lines = [
    { id: "r1", at: "", for: "build", command: "make -j8", output: "", exit: 0 },
    { id: "r2", at: "", for: "unit tests", command: "make test", output: "", exit: 1 },
    { id: "r3", at: "", for: "fuzz 1 h", command: "./fuzz", output: ".egg/logs/r3.log", exit: 0 },
    { id: "r4", at: "", for: "still going", command: "./slow", output: "", exit: null },
  ];
  const ledger = buildLedger(records, lines, facts());
  assert.deepEqual(ledger.map((e) => [e.id, e.state, e.exit]), [["r1", "running", null], ["r2", "exited", 0], ["r3", "claimed", null], ["r4", "claimed", null]]);
  assert.equal(ledger[0]!.exit, null, "the line said exit 0, but the record says it still runs");
  assert.equal(ledger[1]!.for, "unit tests", "what it was for comes from the line when the record has none");
  assert.equal(ledgerLine(ledger[0]!, NOW), "r1 · build · $ make -j8 · running 14 min · → .egg/logs/r1.log");
  assert.equal(ledgerLine(ledger[1]!, NOW), "r2 · unit tests · $ make -j8 · exit 0 after 30 s · → .egg/logs/r1.log");
  for (const claimed of [ledger[2]!, ledger[3]!]) {
    const line = ledgerLine(claimed, NOW);
    assert.match(line, /claimed: no run record/);
    assert.doesNotMatch(line, /running|exit \d/);
    const entry = ledgerEntry(claimed, true, NOW);
    assert.equal(entry.unconfirmed, true);
    assert.equal(entry.failed, undefined);
  }
  assert.deepEqual(openSummary(ledger, NOW), { open: 1, longestMs: 14 * 60_000 });
});

test("died and stopped keep the time egg first saw them; a died run with a late exit becomes exited", () => {
  const first = carryOver(buildLedger([rec({})], [], facts({ alive: () => false })), [], NOW);
  assert.equal(first[0]!.state, "died");
  assert.equal(first[0]!.endedMs, NOW);
  const later = carryOver(buildLedger([rec({})], [], facts({ alive: () => false, now: NOW + 60_000 })), first, NOW + 60_000);
  assert.equal(later[0]!.endedMs, NOW, "still the time it was first seen dead");
  const exited = carryOver(buildLedger([rec({ exit: 0, endedMs: NOW + 1000 })], [], facts()), later, NOW + 2000);
  assert.equal(exited[0]!.state, "exited");
});

test("a run that died or failed is a notebook line; a clean finish is said plainly", () => {
  const base: LedgerRecord = { id: "r5", at: "", for: "asan build", command: "make", output: ".egg/logs/r5.log", exit: null, state: "died", startedMs: NOW - 60_000, endedMs: NOW };
  assert.deepEqual(notebookLine(base, NOW), { kind: "trouble", text: "Run r5 died (asan build): its process is gone and no exit was recorded · log .egg/logs/r5.log" });
  assert.deepEqual(notebookLine({ ...base, state: "exited", exit: 127 }, NOW), { kind: "trouble", text: "Run r5 failed (asan build): exit 127 after 1 min · log .egg/logs/r5.log" });
  assert.equal(notebookLine({ ...base, state: "exited", exit: 0 }, NOW)!.kind, "did");
  assert.equal(notebookLine({ ...base, state: "running" }, NOW), null);
  assert.equal(notebookLine({ ...base, state: "claimed" }, NOW), null);
});

test("built from is brought up to each cited run's state", () => {
  const running: LedgerRecord = { id: "r1", at: "", for: "fuzz", command: "./fuzz", output: "", exit: null, state: "running", startedMs: NOW - 60_000, endedMs: null };
  const built = [ledgerEntry(running, true, NOW), { kind: "read" as const, what: "src/a.c" }];
  assert.match(built[0]!.what, /running 1 min/);
  assert.equal(refreshLedgerEntries(built, [running], NOW), null, "nothing changed");
  const next = refreshLedgerEntries(built, [{ ...running, state: "exited", exit: 1, endedMs: NOW + 60_000 }], NOW + 60_000)!;
  assert.match(next[0]!.what, /exit 1 after 2 min/);
  assert.equal(next[0]!.failed, true);
  assert.deepEqual(next[1], built[1]);
});

const L = (id: string, state: LedgerRecord["state"], endedMs: number | null = null, exit: number | null = null): LedgerRecord => ({ id, at: "", for: id, command: "x", output: "", exit, state, startedMs: NOW - 20 * 60_000, endedMs });
const wakeAt = (over: Partial<Parameters<typeof wakeRule>[0]>) =>
  wakeRule({ ledger: [], told: new Set(), idle: true, held: false, turnEndedAt: NOW - 5 * 60_000, wokeAt: null, now: NOW, intervalMs: 10 * 60_000, ...over });

test("the wake rule: a run that finished after the turn ended wakes it at once, with what is still running", () => {
  const w = wakeAt({ ledger: [L("r14", "exited", NOW - 60_000, 0), L("r15", "running")] });
  assert.match(w.message!, /^egg: r14 finished, exit 0; r15 still running \(20 min\)\./);
  assert.match(w.message!, /Read each run's record/);
  assert.deepEqual(w.told, ["r14"]);
  const died = wakeAt({ ledger: [L("r16", "died", NOW - 1000)] });
  assert.match(died.message!, /r16 died \(no exit recorded\)/);
});

test("the wake rule: a run that finished during the turn is counted as told, with no message", () => {
  const w = wakeAt({ ledger: [L("r14", "exited", NOW - 10 * 60_000, 0)] });
  assert.equal(w.message, null);
  assert.deepEqual(w.told, ["r14"]);
  assert.equal(wakeAt({ ledger: [L("r14", "exited", NOW - 60_000, 0)], told: new Set(["r14"]) }).message, null, "told once");
});

test("the wake rule: open runs wake it at the slow interval, counted from the turn's end or the last wake", () => {
  const open = [L("r15", "running")];
  assert.equal(wakeAt({ ledger: open }).message, null, "five minutes since the turn ended");
  assert.match(wakeAt({ ledger: open, turnEndedAt: NOW - 11 * 60_000 }).message!, /^egg: r15 still running/);
  assert.equal(wakeAt({ ledger: open, turnEndedAt: NOW - 11 * 60_000, wokeAt: NOW - 2 * 60_000 }).message, null);
  assert.equal(wakeAt({ ledger: [L("r9", "stopped", NOW - 1000)], turnEndedAt: NOW - 60 * 60_000 }).message, null, "a stopped run never wakes it");
  assert.equal(wakeAt({ ledger: [L("r9", "claimed")], turnEndedAt: NOW - 60 * 60_000 }).message, null, "nor a claimed one");
});

test("the wake rule: never while it works, never while the person has it stopped", () => {
  const ledger = [L("r14", "exited", NOW - 60_000, 0), L("r15", "running")];
  assert.deepEqual(wakeAt({ ledger, idle: false }), { message: null, told: [] });
  assert.deepEqual(wakeAt({ ledger, held: true, turnEndedAt: NOW - 60 * 60_000 }), { message: null, told: [] });
});

// The real runner, outside any thread.
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (ok(v) || Date.now() > end) return v;
    await sleepMs(50);
  }
}
async function workspace() {
  const ws = mkdtempSync(join(tmpdir(), "egg-runner-"));
  const m = join(ws, ".egg");
  assert.equal(await installRunner(m), true);
  assert.equal(await installRunner(m), false, "already there: not written again");
  return { ws, m, run: (...args: string[]) => execFileSync(join(m, "bin", "run"), args, { cwd: ws, encoding: "utf8" }) };
}
const read = async (m: string, id: string) => (await readRecords(m)).find((r) => r.record.id === id) ?? null;
const stateOf = async (m: string, id: string, stopped: string[] = []) => {
  const r = await read(m, id);
  return r ? runState(r, { alive: pidAlive, now: Date.now(), stopped: new Set(stopped) }) : null;
};

test("the runner: a detached run returns at once, runs on, and records its exit and end", async () => {
  const { m, run } = await workspace();
  assert.ok((statSync(join(m, "bin", "run")).mode & 0o111) !== 0, "executable");
  const t0 = Date.now();
  const out = run("r1", "a short sleep", "--", "echo start; sleep 1; echo end; exit 3");
  assert.ok(Date.now() - t0 < 1500, `returns at once (${Date.now() - t0} ms)`);
  assert.match(out, /^r1 started \(pid \d+\) · log \.egg\/logs\/r1\.log/);
  const r = (await read(m, "r1"))!;
  assert.equal(r.record.command, "echo start; sleep 1; echo end; exit 3");
  assert.ok(r.record.pid && r.record.pgid && r.record.startedMs);
  assert.equal(r.record.exit, null);
  assert.equal(await stateOf(m, "r1"), "running");
  assert.equal(await until(() => stateOf(m, "r1"), (s) => s === "exited"), "exited");
  const done = (await read(m, "r1"))!.record;
  assert.equal(done.exit, 3);
  assert.ok(done.endedMs! >= done.startedMs!);
  assert.equal(readFileSync(join(m, "logs", "r1.log"), "utf8"), "start\nend\n");
  const ledger = readFileSync(join(m, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(ledger.map((l) => [l.id, l.exit]), [["r1", null], ["r1", 3]]);
});

test("the runner: the foreground form waits, prints the log's end, and records the same; ids are never reused", async () => {
  const { m, run } = await workspace();
  const out = run("--fg", "r2", "quick count", "--", "printf", "%s\\n", "a b", "c'd");
  assert.match(out, /a b\nc'd\n\[r2 exit 0 · log \.egg\/logs\/r2\.log/);
  const r = (await read(m, "r2"))!.record;
  assert.equal(r.exit, 0);
  assert.equal(r.detached, false);
  assert.equal(r.command, "printf '%s\\n' 'a b' 'c'\\''d'");
  assert.throws(() => run("r2", "again", "--", "true"), /already used/);
  let failed: { status: number | null } | null = null;
  try {
    run("--fg", "r3", "no such command", "--", "egg-no-such-command");
  } catch (e) {
    failed = e as { status: number };
  }
  assert.equal(failed?.status, 127);
  assert.equal((await read(m, "r3"))!.record.exit, 127);
  assert.throws(() => run("../x", "bad id", "--", "true"), /the id must be/);
});

test("the runner: a run whose process is killed outright died; one egg stops is stopped", async () => {
  const { m, run } = await workspace();
  run("r4", "will be killed", "--", "sleep 30");
  const r4 = (await read(m, "r4"))!.record;
  process.kill(-r4.pgid!, "SIGKILL");
  assert.equal(await until(() => stateOf(m, "r4"), (s) => s === "died"), "died");
  run("r5", "will be stopped", "--", "sleep 30");
  const r5 = (await read(m, "r5"))!.record;
  assert.equal(await stateOf(m, "r5"), "running");
  assert.equal(await killRun({ pid: r5.pid!, pgid: r5.pgid! }, 200), true);
  assert.equal(await until(() => pidAlive(r5.pid!), (a) => a === false), false, "its process is gone");
  assert.equal(await stateOf(m, "r5", ["r5"]), "stopped");
  assert.equal(await killRun({ pid: r5.pid!, pgid: r5.pgid! }, 10), false, "nothing left to signal");
});

test("records are read defensively: a file not named for its id, or not JSON, is skipped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "egg-recs-"));
  mkdirSync(join(dir, "runs"));
  writeFileSync(join(dir, "runs", "r1.json"), JSON.stringify({ id: "r1", pid: 5 }));
  writeFileSync(join(dir, "runs", "r2.json"), JSON.stringify({ id: "r9", pid: 5 }));
  writeFileSync(join(dir, "runs", "r3.json"), "{half");
  writeFileSync(join(dir, "runs", "r4.json.tmp.1"), "{}");
  assert.deepEqual((await readRecords(dir)).map((r) => r.record.id), ["r1"]);
  assert.deepEqual(await readRecords(join(dir, "missing")), []);
  assert.equal(existsSync(join(dir, "bin")), false);
});
