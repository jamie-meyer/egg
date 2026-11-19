import assert from "node:assert/strict";
import { test } from "node:test";
import { expandHome, roomDir, slug } from "../src/kept.ts";

test("room directories are readable and unique", () => {
  assert.equal(slug("Where do requests get authenticated?"), "where-do-requests-get-authenticated");
  assert.equal(slug("!!!"), "room");
  assert.equal(roomDir("/rooms", "What's in the image?", "room_abc123def"), "/rooms/what-s-in-the-image-abc123");
  assert.equal(expandHome("~/egg", "/home/me"), "/home/me/egg");
  assert.equal(expandHome("/abs", "/home/me"), "/abs");
});
