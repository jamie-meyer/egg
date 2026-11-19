import assert from "node:assert/strict";
import { test } from "node:test";
import { type Recorder, createHoldToTalk } from "../src/voice.ts";

function harness(transcribe: (clip: Blob) => Promise<string>, startDelay = 0) {
  let t = 0;
  const events: string[] = [];
  const recorder: Recorder = {
    start: () => new Promise((r) => setTimeout(r, startDelay)),
    stop: async () => new Blob(["audio"], { type: "audio/webm" }),
    cancel: () => events.push("cancel"),
  };
  const talk = createHoldToTalk({
    recorder,
    transcribe,
    onLine: (text) => events.push(`line:${text}`),
    onTrouble: (text) => events.push(`trouble:${text}`),
    onHint: (text) => events.push(`hint:${text}`),
    onState: (s) => events.push(`state:${s}`),
    now: () => t,
  });
  return { talk, events, advance: (ms: number) => (t += ms) };
}

test("hold, speak, release: the transcript becomes a line", async () => {
  const h = harness(async () => "  where is the   router?  ");
  await h.talk.press();
  h.advance(2500);
  await h.talk.release();
  assert.deepEqual(h.events, ["state:starting", "state:recording", "state:transcribing", "state:idle", "line:where is the router?"]);
});

test("clips under a second are ignored", async () => {
  const h = harness(async () => "should not be sent");
  await h.talk.press();
  h.advance(600);
  await h.talk.release();
  assert.ok(h.events.includes("cancel"));
  assert.ok(!h.events.some((e) => e.startsWith("line:")));
});

test("a failed transcription is reported in plain words and leaves voice ready", async () => {
  const h = harness(async () => {
    throw new Error("HTTP 401: the voice service refused the request");
  });
  await h.talk.press();
  h.advance(1500);
  await h.talk.release();
  assert.ok(h.events.includes("trouble:Transcription failed: HTTP 401: the voice service refused the request"));
  assert.equal(h.talk.state, "idle");
});

test("nothing happens on a pause, only on release; a release during start-up still sends", async () => {
  const h = harness(async () => "late release", 30);
  const pressing = h.talk.press();
  h.advance(1200);
  await h.talk.release();
  assert.ok(!h.events.some((e) => e.startsWith("line:")));
  await pressing;
  assert.ok(h.events.includes("line:late release"));
});

test("a microphone that cannot open says so", async () => {
  const h = harness(async () => "x");
  const talk = createHoldToTalk({
    recorder: { start: async () => { throw new Error("Permission denied"); }, stop: async () => new Blob(), cancel() {} },
    transcribe: async () => "x",
    onLine: () => h.events.push("line"),
    onTrouble: (t) => h.events.push(`trouble:${t}`),
    onState: () => undefined,
  });
  await talk.press();
  assert.deepEqual(h.events, ["trouble:Could not record: Permission denied"]);
  assert.equal(talk.state, "idle");
});
