import assert from "node:assert/strict";
import { test } from "node:test";
import { type WorkerActivity, deriveWorker, describeItem, statusLine, toActivity, toAsk } from "../src/status.ts";

const MIN = 60_000;
const now = 10_000 * MIN;
const quiet: WorkerActivity = { turn: null, step: null, lastEventAt: null, ask: null, tokens: null };
const facts = (status: string, extra: Partial<{ hasPendingInteraction: boolean; archivedAt: number | null }> = {}) => ({ status, hasPendingInteraction: false, archivedAt: null, ...extra });

test("running: since its turn started, with its latest step and tokens", () => {
  const s = deriveWorker(facts("active"), { ...quiet, turn: { phase: "started", at: now - 12 * MIN, failed: false }, step: { text: "$ make -j8", at: now - 10_000 }, lastEventAt: now - 10_000, tokens: 340_000 }, now);
  assert.equal(s.state, "running");
  assert.equal(s.quietMs, null);
  assert.equal(statusLine(s, now), "running 12 min · $ make -j8 · 340k tokens");
});

test("a long silence in a running turn is quiet, never stuck", () => {
  const s = deriveWorker(facts("active"), { ...quiet, turn: { phase: "started", at: now - 90 * MIN, failed: false }, step: { text: "$ make check", at: now - 40 * MIN }, lastEventAt: now - 40 * MIN }, now);
  assert.equal(s.state, "running");
  assert.equal(statusLine(s, now), "running 1 h 30 min · $ make check · quiet for 40 min");
});

test("waiting on you: a pending permission or question wins over running", () => {
  const ask = toAsk([
    { status: "resolved", createdAt: 1, payload: { kind: "approval", title: "old" } },
    { status: "pending", createdAt: now - 3 * MIN, payload: { kind: "approval", title: "Run make install?" } },
  ]);
  const s = deriveWorker(facts("active", { hasPendingInteraction: true }), { ...quiet, ask, turn: { phase: "started", at: now - 20 * MIN, failed: false } }, now);
  assert.equal(s.state, "waiting on you");
  assert.equal(statusLine(s, now), "waiting on you 3 min · asks permission: Run make install?");
  assert.equal(deriveWorker(facts("active", { hasPendingInteraction: true }), quiet, now).step, "waiting for your answer in its chat");
});

test("failed, idle, gone, starting", () => {
  assert.equal(deriveWorker(facts("error"), { ...quiet, turn: { phase: "completed", at: now - MIN, failed: true } }, now).state, "failed");
  const idle = deriveWorker(facts("idle"), { ...quiet, turn: { phase: "completed", at: now - 5 * MIN, failed: false } }, now);
  assert.equal(idle.state, "idle");
  assert.equal(statusLine(idle, now), "idle 5 min");
  assert.equal(deriveWorker(null, quiet, now).state, "gone");
  assert.equal(deriveWorker(facts("idle", { archivedAt: now - MIN }), quiet, now).state, "gone");
  assert.equal(deriveWorker(facts("starting"), quiet, now, now - 20_000).state, "starting");
  // bb says idle, but the newest turn event read is a start, seconds ago: still running.
  assert.equal(deriveWorker(facts("idle"), { ...quiet, turn: { phase: "started", at: now - 5000, failed: false }, lastEventAt: now - 5000 }, now).state, "running");
});

test("activity from raw events: newest turn boundary, latest step, tokens", () => {
  const a = toActivity({
    turns: [{ type: "turn/completed", createdAt: 50, data: { status: "failed" } }, { type: "turn/started", createdAt: 10, data: {} }],
    items: [{ type: "item/started", createdAt: 60, data: { item: { type: "commandExecution", command: "ruby test/runner.rb\n--verbose" } } }],
    interactions: [],
    usedTokens: 900,
  });
  assert.deepEqual(a.turn, { phase: "completed", at: 50, failed: true });
  assert.deepEqual(a.step, { text: "$ ruby test/runner.rb", at: 60 });
  assert.equal(a.lastEventAt, 60);
  assert.equal(a.tokens, 900);
  assert.equal(describeItem({ type: "toolCall", tool: "Read" }), "using Read");
  assert.equal(describeItem({ type: "reasoning" }), "thinking");
});
