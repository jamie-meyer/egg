import assert from "node:assert/strict";
import { test } from "node:test";
import { FALLBACK_ANGLES, parseAngles, plannerPrompt, viewPrompt, viewThreadTitle } from "../src/rounds.ts";
import { decide, makeRoom, setAngles, startRound } from "../src/store.ts";

test("parseAngles takes four distinct angles from the reply, fenced or not", () => {
  const reply = '```json\n[{"name":"Call graph","focus":"who calls whom"},{"name":"One request","focus":"trace it"},{"name":"Sizes","focus":"numbers"},{"name":"Odd bits","focus":"surprises"},{"name":"Extra","focus":"x"}]\n```';
  const angles = parseAngles(reply)!;
  assert.deepEqual(angles.map((a) => a.name), ["Call graph", "One request", "Sizes", "Odd bits"]);
  assert.equal(angles[0]!.focus, "who calls whom");
});

test("parseAngles tops up repeats and short lists from the fallback spread", () => {
  const angles = parseAngles('[{"name":"Map"},{"name":"map"},"Timeline"]')!;
  assert.equal(angles.length, 4);
  assert.deepEqual(angles.slice(0, 2).map((a) => a.name), ["Map", "Timeline"]);
  assert.deepEqual(angles.slice(2), FALLBACK_ANGLES.slice(0, 2));
});

test("parseAngles gives null for nothing usable", () => {
  assert.equal(parseAngles(null), null);
  assert.equal(parseAngles("I could not decide."), null);
  assert.equal(parseAngles("[not json]"), null);
  assert.equal(parseAngles("[]"), null);
});

test("the planner sees the subject, earlier lines, and what was kept and dropped", () => {
  const room = makeRoom({ id: "room_1", subject: "how auth works", folder: "/repo", hostId: "h", projectId: "p", dir: "/d", now: 1 });
  const { round } = startRound(room, { text: "how auth works", source: "typed", plannerModel: "m" });
  const views = setAngles(room, round.id, FALLBACK_ANGLES, "m", null);
  decide(room, views[0]!.id, "kept");
  decide(room, views[3]!.id, "dropped");
  const prompt = plannerPrompt(room, "and sessions?");
  assert.match(prompt, /how auth works/);
  assert.match(prompt, /and sessions\?/);
  assert.match(prompt, /kept: "The map"/);
  assert.match(prompt, /dropped: "Oddities"/);
  assert.match(prompt, /Do not use any tools/);
});

test("a view prompt is read only and writes to thread storage", () => {
  const room = makeRoom({ id: "room_1", subject: "s", folder: "/repo", hostId: "h", projectId: "p", dir: "/d", now: 1 });
  const prompt = viewPrompt(room, "line", FALLBACK_ANGLES[1]!);
  assert.match(prompt, /READ ONLY/);
  assert.match(prompt, /\$BB_THREAD_STORAGE\/view\.html/);
  assert.match(prompt, /One concrete path/);
  assert.equal(viewThreadTitle("egg", "The map", "where are requests authenticated"), "egg: The map · where are requests authenticated");
});
