import assert from "node:assert/strict";
import { test } from "node:test";
import { type RoomSummary, roomTree } from "../src/model.ts";

const r = (id: string, updatedAt: number, parentRoomId: string | null = null): RoomSummary => ({ id, subject: id, folder: "/f", updatedAt, rounds: 1, kept: 0, parentRoomId });

test("the room list puts children indented under their parents; orphans at the top level", () => {
  const tree = roomTree([r("a", 1), r("b", 5), r("a1", 9, "a"), r("a1x", 3, "a1"), r("a2", 2, "a"), r("lost", 4, "gone")]);
  assert.deepEqual(tree.map((t) => `${"  ".repeat(t.depth)}${t.room.id}`), ["b", "lost", "a", "  a1", "    a1x", "  a2"]);
});

test("a cycle of parents still lists every room once", () => {
  const tree = roomTree([r("a", 1, "b"), r("b", 2, "a")]);
  assert.deepEqual(tree.map((t) => t.room.id).sort(), ["a", "b"]);
});
