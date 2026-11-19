import assert from "node:assert/strict";
import { test } from "node:test";
import { roundViews } from "../src/model.ts";
import { FALLBACK_ANGLES } from "../src/rounds.ts";
import { createStore, decide, makeRoom, setAngles, startRound, viewFinished, viewStarted } from "../src/store.ts";
import { memoryKv } from "./support.ts";

test("four views landing at once do not lose each other's writes", async () => {
  const store = createStore(memoryKv());
  const room = makeRoom({ id: "room_1", subject: "s", folder: "/r", hostId: "h", projectId: "p", dir: "/d", now: 1 });
  const { round } = startRound(room, { text: "s", source: "typed", plannerModel: "m" });
  const views = setAngles(room, round.id, FALLBACK_ANGLES, "m", null);
  await store.put(room);
  await Promise.all(views.map((v, i) => store.update("room_1", (r) => viewStarted(r, v.id, `thr_${i}`, null))));
  await Promise.all(views.map((v) => store.update("room_1", (r) => viewFinished(r, v.id, { format: "html", builtFrom: [], error: null }))));
  const saved = (await store.get("room_1"))!;
  assert.deepEqual(roundViews(saved, saved.rounds[0]!).map((v) => [v.threadId, v.status]), [["thr_0", "done"], ["thr_1", "done"], ["thr_2", "done"], ["thr_3", "done"]]);
  assert.equal(saved.rounds[0]!.status, "done");
});

test("a new round supersedes the views of earlier rounds, kept ones too", () => {
  const room = makeRoom({ id: "room_1", subject: "s", folder: "/r", hostId: "h", projectId: "p", dir: "/d", now: 1 });
  const first = startRound(room, { text: "one", source: "typed", plannerModel: "m" });
  const views = setAngles(room, first.round.id, FALLBACK_ANGLES, "m", null);
  views.forEach((v, i) => viewStarted(room, v.id, `thr_${i}`, null));
  decide(room, views[0]!.id, "kept");
  const second = startRound(room, { text: "two", source: "voice", plannerModel: "m" });
  assert.deepEqual(second.superseded.map((v) => v.threadId), ["thr_0", "thr_1", "thr_2", "thr_3"]);
  assert.equal(second.round.n, 2);
  assert.equal(room.lines.filter((l) => l.kind === "said").map((l) => l.source).join(","), "typed,voice");
  assert.equal(room.views[views[0]!.id]!.decision, "kept");
  assert.equal(startRound(room, { text: "three", source: "typed", plannerModel: "m" }).superseded.length, 0);
});

test("a round is done once every view is done or failed", () => {
  const room = makeRoom({ id: "room_1", subject: "s", folder: "/r", hostId: "h", projectId: "p", dir: "/d", now: 1 });
  const { round } = startRound(room, { text: "s", source: "typed", plannerModel: "m" });
  const views = setAngles(room, round.id, FALLBACK_ANGLES, "m", null);
  viewStarted(room, views[0]!.id, null, "could not start");
  for (const v of views.slice(1)) viewStarted(room, v.id, "t", null);
  assert.equal(room.rounds[0]!.status, "running");
  for (const v of views.slice(1)) viewFinished(room, v.id, { format: null, builtFrom: [], error: "no view" });
  assert.equal(room.rounds[0]!.status, "done");
  assert.ok(views.every((v) => room.views[v.id]!.status === "failed"));
});

test("content is stored apart from the room and capped", async () => {
  const store = createStore(memoryKv());
  await store.putContent("vw_1", { format: "text", content: "x".repeat(300_000) });
  const got = (await store.getContent("vw_1"))!;
  assert.equal(got.format, "text");
  assert.equal(got.content.length, 200_000);
  assert.equal(await store.getContent("vw_none"), null);
});
