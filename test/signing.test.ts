// Signed calls: the canonical form, the envelope, the time and nonce rules,
// enrolment and its reset, and that nothing of an action runs before its
// signature is good. Signatures are made as a browser makes them (WebCrypto,
// ECDSA P-256 over SHA-256, r then s) and verified by the backend's own code.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { ACTIONS, ACTION_NAMES, READS } from "../src/signing/actions.ts";
import { type Dispatch, resetPathIn, runSigned, sha256Hex, verifyP256 } from "../src/signing/backend.ts";
import { canonical } from "../src/signing/canonical.ts";
import { type PublicKey, SIGNATURE_WINDOW_MS, SIGNING_REFUSALS, TOO_MANY_WAITING, fingerprintText, formatFingerprint, notEnrolledShort, notEnrolledText, refusalInWords, resetCommand, signedText, signingRefusalIn } from "../src/signing/envelope.ts";
import { MAX_REQUESTS, Refusal, createKeys } from "../src/signing/keys.ts";
import { memoryKv } from "./support.ts";

const PLUGIN = "egg";

async function browserKey() {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const publicKey: PublicKey = { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! };
  const fingerprint = formatFingerprint(sha256Hex(fingerprintText(publicKey)));
  let n = 0;
  const sign = async (action: string, args: unknown, at: number, options: { nonce?: string; plugin?: string } = {}) => {
    const nonce = options.nonce ?? `nonce-${fingerprint}-${String(++n).padStart(6, "0")}`;
    const sig = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(signedText(options.plugin ?? PLUGIN, { action, args, at, nonce })));
    return { action, args, at, nonce, key: fingerprint, sig: Buffer.from(sig).toString("base64url") };
  };
  return { publicKey, fingerprint, sign };
}

function world(startAt = 1_000_000) {
  const kv = memoryKv();
  const clock = { now: startAt };
  const reset = { present: false, removable: true };
  const log: string[] = [];
  let changes = 0;
  const make = () =>
    createKeys({
      kv,
      plugin: PLUGIN,
      now: () => clock.now,
      hash: sha256Hex,
      verify: verifyP256,
      resetPath: "/data/plugins/egg/reset-enrollment",
      takeResetFile: async () => {
        if (!reset.present || !reset.removable) return false;
        reset.present = false;
        return true;
      },
      changed: () => void changes++,
      log: (text) => void log.push(text),
    });
  return { kv, clock, reset, log, keys: make(), restart: make, changes: () => changes };
}

/** A dispatch that records what ran. */
function recorder() {
  const ran: { action: string; args: unknown; by: string }[] = [];
  const dispatch = Object.fromEntries(
    ACTION_NAMES.map((action) => [
      action,
      async (args: unknown, by: string) => {
        ran.push({ action, args, by });
        return null;
      },
    ]),
  ) as unknown as Dispatch;
  return { ran, dispatch };
}

const refused = async (run: Promise<unknown>, code: string) => {
  await assert.rejects(run, (e: unknown) => {
    assert.ok(e instanceof Refusal, `a Refusal, not ${String(e)}`);
    assert.equal(e.code, code);
    return true;
  });
};

test("canonical: keys sorted at every depth, no spaces, undefined left out", () => {
  assert.equal(canonical({ b: 1, a: { d: [1, { z: null, y: "x" }], c: undefined } }), '{"a":{"d":[1,{"y":"x","z":null}]},"b":1}');
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
  assert.equal(canonical(undefined), "null");
  assert.equal(canonical("a\"b"), '"a\\"b"');
});

test("the signed text covers the plugin, the action, every argument, the time and the nonce", () => {
  const base = { action: "say", args: { roomId: "r1", text: "hello", source: "typed" }, at: 5, nonce: "n".repeat(16) };
  const text = signedText("egg", base);
  assert.equal(text, '{"action":"say","args":{"roomId":"r1","source":"typed","text":"hello"},"at":5,"for":"egg","nonce":"nnnnnnnnnnnnnnnn"}');
  assert.notEqual(signedText("egg-check", base), text);
  assert.notEqual(signedText("egg", { ...base, action: "work" }), text);
  assert.notEqual(signedText("egg", { ...base, args: { ...base.args, text: "hello!" } }), text);
  assert.notEqual(signedText("egg", { ...base, args: { ...base.args, source: "voice" } }), text);
  assert.notEqual(signedText("egg", { ...base, at: 6 }), text);
  assert.notEqual(signedText("egg", { ...base, nonce: "m".repeat(16) }), text);
  // No arguments and null arguments are the same call.
  assert.equal(signedText("egg", { action: "rooms_list", args: undefined, at: 1, nonce: "n" }), signedText("egg", { action: "rooms_list", args: null, at: 1, nonce: "n" }));
});

test("a fingerprint is 16 hex digits of the key's hash, in fours", async () => {
  const a = await browserKey();
  const b = await browserKey();
  assert.match(a.fingerprint, /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test("enrolment: the first key to ask is enrolled; any other waits for an enrolled one", async () => {
  const w = world();
  const first = await browserKey();
  const second = await browserKey();
  assert.deepEqual(await w.keys.enrol(first.publicKey, "Chrome on macOS"), { outcome: "enrolled-first", fingerprint: first.fingerprint });
  assert.deepEqual(await w.keys.enrol(first.publicKey, "Chrome on macOS"), { outcome: "enrolled", fingerprint: first.fingerprint });
  assert.equal((await w.keys.enrol(second.publicKey, "Safari\non  macOS")).outcome, "pending");
  assert.equal((await w.keys.enrol(second.publicKey, "x")).outcome, "pending");
  const state = await w.keys.state();
  assert.deepEqual(state.keys.map((k) => [k.fingerprint, k.how, k.approvedBy]), [[first.fingerprint, "first", null]]);
  assert.deepEqual(state.requests.map((r) => [r.fingerprint, r.status, r.label]), [[second.fingerprint, "pending", "Safari on macOS"]]);
  assert.equal(state.plugin, PLUGIN);
  // A pending key signs nothing that is accepted.
  await refused(w.keys.verify(await second.sign("rooms_list", null, w.clock.now)), "unknown_key");
});

test("enrolment: two keys asking at once on an empty egg, only one is first", async () => {
  const w = world();
  const [a, b] = [await browserKey(), await browserKey()];
  const outcomes = (await Promise.all([w.keys.enrol(a.publicKey, "a"), w.keys.enrol(b.publicKey, "b")])).map((r) => r.outcome).sort();
  assert.deepEqual(outcomes, ["enrolled-first", "pending"]);
});

test("enrolment: not a P-256 public key is refused; a private key is never taken", async () => {
  const w = world();
  await refused(w.keys.enrol({ kty: "EC", crv: "P-256", x: "short", y: "short" }, "x"), "bad_key");
  const good = (await browserKey()).publicKey;
  await refused(w.keys.enrol({ ...good, d: "A".repeat(43) }, "x"), "bad_key");
  await refused(w.keys.enrol(null, "x"), "bad_key");
  assert.equal((await w.keys.state()).keys.length, 0);
});

test("approve, refuse and remove are for an enrolled key to do, and say who did", async () => {
  const w = world();
  const { ran, dispatch } = recorder();
  const first = await browserKey();
  const second = await browserKey();
  const third = await browserKey();
  await w.keys.enrol(first.publicKey, "first");
  await w.keys.enrol(second.publicKey, "second");
  await w.keys.enrol(third.publicKey, "third");
  // The asking key cannot approve itself: its signature is by a key that is not enrolled.
  await refused(runSigned(w.keys, dispatch, await second.sign("key_approve", { fingerprint: second.fingerprint }, w.clock.now)), "unknown_key");
  assert.equal(ran.length, 0);

  const approved = await w.keys.approve(second.fingerprint, first.fingerprint);
  assert.deepEqual([approved.how, approved.approvedBy], ["approved", first.fingerprint]);
  await w.keys.verify(await second.sign("rooms_list", null, w.clock.now));
  await refused(w.keys.approve(second.fingerprint, first.fingerprint), "request_not_found");

  await w.keys.refuse(third.fingerprint, first.fingerprint);
  assert.equal((await w.keys.enrol(third.publicKey, "third")).outcome, "refused");
  await refused(w.keys.verify(await third.sign("rooms_list", null, w.clock.now)), "unknown_key");
  // Forgetting the refusal lets it ask again.
  await w.keys.remove(third.fingerprint, first.fingerprint);
  assert.equal((await w.keys.enrol(third.publicKey, "third")).outcome, "pending");

  await w.keys.remove(second.fingerprint, first.fingerprint);
  await refused(w.keys.verify(await second.sign("rooms_list", null, w.clock.now)), "unknown_key");
  await refused(w.keys.remove("0000-0000-0000-0000", first.fingerprint), "key_not_found");
  assert.ok(w.log.some((l) => l.includes(`approved by ${first.fingerprint}`)));
});

test("requests are bounded: pending ones are never pushed out, a refused one gives way", async () => {
  const w = world();
  const first = await browserKey();
  await w.keys.enrol(first.publicKey, "first");
  const asking: Awaited<ReturnType<typeof browserKey>>[] = [];
  for (let i = 0; i < MAX_REQUESTS; i++) {
    const k = await browserKey();
    asking.push(k);
    w.clock.now += 1;
    assert.equal((await w.keys.enrol(k.publicKey, `k${i}`)).outcome, "pending");
  }
  const late = await browserKey();
  await refused(w.keys.enrol(late.publicKey, "late"), "too_many_requests");
  await assert.rejects(w.keys.enrol(late.publicKey, "late"), (e: unknown) => e instanceof Refusal && e.message.includes(TOO_MANY_WAITING));
  await w.keys.refuse(asking[3]!.fingerprint, first.fingerprint);
  assert.equal((await w.keys.enrol(late.publicKey, "late")).outcome, "pending");
  const state = await w.keys.state();
  assert.equal(state.requests.length, MAX_REQUESTS);
  assert.ok(!state.requests.some((r) => r.fingerprint === asking[3]!.fingerprint));
  assert.equal(state.keys.length, 1);
});

test("verify: a good signature by an enrolled key passes, and names the key", async () => {
  const w = world();
  const key = await browserKey();
  await w.keys.enrol(key.publicKey, "page");
  const { by, envelope } = await w.keys.verify(await key.sign("say", { roomId: "r", text: "hi", source: "typed" }, w.clock.now));
  assert.equal(by, key.fingerprint);
  assert.equal(envelope.action, "say");
});

test("verify: no signature, an empty one, or not an envelope at all is 'unsigned'", async () => {
  const w = world();
  const key = await browserKey();
  await w.keys.enrol(key.publicKey, "page");
  const good = await key.sign("rooms_list", null, w.clock.now);
  for (const raw of [null, undefined, "say", 7, [], {}, { roomId: "r", text: "hi", source: "typed" }, { action: "say", args: {} }, { ...good, sig: "" }, { ...good, key: "" }, { ...good, sig: undefined }, { ...good, nonce: "short" }, { ...good, nonce: undefined }, { ...good, at: "now" }]) {
    await refused(w.keys.verify(raw), "unsigned");
  }
});

test("verify: a made-up signature, another key's signature, or a signature for another copy of egg is refused", async () => {
  const w = world();
  const key = await browserKey();
  const other = await browserKey();
  await w.keys.enrol(key.publicKey, "page");
  const good = await key.sign("room_delete", { roomId: "r1" }, w.clock.now);
  await refused(w.keys.verify({ ...good, sig: Buffer.alloc(64, 7).toString("base64url") }), "bad_signature");
  await refused(w.keys.verify({ ...good, sig: "not base64 at all !!" }), "bad_signature");
  await refused(w.keys.verify({ ...good, sig: Buffer.alloc(10, 7).toString("base64url") }), "bad_signature");
  // Signed by a key that is not enrolled, naming the enrolled one.
  const forged = await other.sign("room_delete", { roomId: "r1" }, w.clock.now);
  await refused(w.keys.verify({ ...forged, key: key.fingerprint }), "bad_signature");
  // Signed by a key that is not enrolled, under its own name.
  await refused(w.keys.verify(forged), "unknown_key");
  // Signed by the enrolled key, but for another installed copy.
  await refused(w.keys.verify(await key.sign("room_delete", { roomId: "r1" }, w.clock.now, { plugin: "egg-check" })), "bad_signature");
  // None of those used the good call's nonce up.
  await w.keys.verify(good);
});

test("verify: anything changed after signing is refused", async () => {
  const w = world();
  const key = await browserKey();
  await w.keys.enrol(key.publicKey, "page");
  const sign = () => key.sign("say", { roomId: "r1", text: "look at the parser", source: "typed" }, w.clock.now);
  const changes: ((e: Awaited<ReturnType<typeof sign>>) => unknown)[] = [
    (e) => ({ ...e, args: { ...(e.args as object), text: "delete everything" } }),
    (e) => ({ ...e, args: { ...(e.args as object), roomId: "r2" } }),
    (e) => ({ ...e, args: { ...(e.args as object), source: "voice" } }),
    (e) => ({ ...e, args: { ...(e.args as object), extra: 1 } }),
    (e) => ({ ...e, args: null }),
    (e) => ({ ...e, action: "work" }),
    (e) => ({ ...e, at: e.at + 1 }),
    (e) => ({ ...e, nonce: `${e.nonce}x` }),
  ];
  for (const change of changes) await refused(w.keys.verify(change(await sign())), "bad_signature");
});

test("time: a call signed more than two minutes either side of the backend's clock is stale", async () => {
  const w = world();
  const key = await browserKey();
  await w.keys.enrol(key.publicKey, "page");
  w.clock.now += 10 * 60_000;
  const now = w.clock.now;
  await w.keys.verify(await key.sign("rooms_list", null, now - SIGNATURE_WINDOW_MS));
  await w.keys.verify(await key.sign("rooms_list", null, now + SIGNATURE_WINDOW_MS));
  await refused(w.keys.verify(await key.sign("rooms_list", null, now - SIGNATURE_WINDOW_MS - 1)), "stale");
  await refused(w.keys.verify(await key.sign("rooms_list", null, now + SIGNATURE_WINDOW_MS + 1)), "stale");
  await refused(w.keys.verify(await key.sign("rooms_list", null, Number.NaN)), "unsigned");
  // A call that was good becomes stale by waiting.
  const held = await key.sign("room_delete", { roomId: "r" }, now);
  w.clock.now += SIGNATURE_WINDOW_MS + 1;
  await refused(w.keys.verify(held), "stale");
});

test("time: a call signed before the backend last started is stale, even inside the window", async () => {
  const w = world();
  const key = await browserKey();
  await w.keys.enrol(key.publicKey, "page");
  const before = await key.sign("room_delete", { roomId: "r" }, w.clock.now);
  const used = await key.sign("say", { roomId: "r", text: "x", source: "typed" }, w.clock.now);
  await w.keys.verify(used);
  // The backend restarts ten seconds later: it has forgotten every nonce.
  w.clock.now += 10_000;
  const restarted = w.restart();
  await refused(restarted.verify(before), "stale");
  await refused(restarted.verify(used), "stale");
  await restarted.verify(await key.sign("room_delete", { roomId: "r" }, w.clock.now));
});

test("nonce: a signed call is good once; the same nonce under a new signature is refused too", async () => {
  const w = world();
  const key = await browserKey();
  await w.keys.enrol(key.publicKey, "page");
  const call = await key.sign("say", { roomId: "r", text: "once", source: "typed" }, w.clock.now);
  await w.keys.verify(call);
  await refused(w.keys.verify(call), "replayed");
  await refused(w.keys.verify(await key.sign("room_delete", { roomId: "r" }, w.clock.now, { nonce: call.nonce })), "replayed");
  // Two copies of one call at the same moment: one passes.
  const twin = await key.sign("work", { roomId: "r", text: "twice", source: "typed" }, w.clock.now);
  const both = await Promise.allSettled([w.keys.verify(twin), w.keys.verify(twin)]);
  assert.deepEqual(both.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
});

test("nonce: remembered for as long as its call could still pass the time rule", async () => {
  const w = world();
  const key = await browserKey();
  await w.keys.enrol(key.publicKey, "page");
  // Signed with a time at the far edge of the window, used, and tried again until the window has passed.
  const call = await key.sign("say", { roomId: "r", text: "edge", source: "typed" }, w.clock.now + SIGNATURE_WINDOW_MS);
  await w.keys.verify(call);
  for (let i = 0; i < 8; i++) {
    w.clock.now += SIGNATURE_WINDOW_MS / 2;
    // Other calls come and go, each clearing out old nonces.
    await w.keys.verify(await key.sign("rooms_list", null, w.clock.now));
    await assert.rejects(w.keys.verify(call), (e: unknown) => e instanceof Refusal && (e.code === "replayed" || e.code === "stale"));
  }
});

test("reset: the reset file clears every key and request, and the next page to ask is first", async () => {
  const w = world();
  const first = await browserKey();
  const second = await browserKey();
  await w.keys.enrol(first.publicKey, "first");
  await w.keys.enrol(second.publicKey, "second");
  assert.equal(await w.keys.resetIfAsked(), false);
  w.reset.present = true;
  assert.equal(await w.keys.resetIfAsked(), true);
  assert.equal(w.reset.present, false);
  assert.deepEqual(await w.keys.state().then((s) => [s.keys.length, s.requests.length]), [0, 0]);
  await refused(w.keys.verify(await first.sign("rooms_list", null, w.clock.now)), "unknown_key");
  assert.equal((await w.keys.enrol(second.publicKey, "second")).outcome, "enrolled-first");
  assert.equal((await w.keys.enrol(first.publicKey, "first")).outcome, "pending");
  assert.ok(w.log.some((l) => l.includes("enrolment reset")));
});

test("reset: noticed by whatever asks about keys next; a file that cannot be removed resets nothing", async () => {
  const w = world();
  const first = await browserKey();
  await w.keys.enrol(first.publicKey, "first");
  w.reset.present = true;
  w.reset.removable = false;
  await w.keys.verify(await first.sign("rooms_list", null, w.clock.now));
  assert.equal((await w.keys.state()).keys.length, 1);
  w.reset.removable = true;
  // A signed call arriving after the file appeared is refused: the reset comes first.
  await refused(w.keys.verify(await first.sign("room_delete", { roomId: "r" }, w.clock.now)), "unknown_key");
  assert.equal((await w.keys.state()).keys.length, 0);
});

test("reset path: under bb's data directory, named for the installed plugin", () => {
  assert.equal(resetPathIn("/data", "egg"), "/data/plugins/egg/reset-enrollment");
  assert.equal(resetPathIn("/data", "egg-check"), "/data/plugins/egg-check/reset-enrollment");
  assert.equal(resetCommand("/data/plugins/egg/reset-enrollment"), "mkdir -p /data/plugins/egg && touch /data/plugins/egg/reset-enrollment");
  assert.equal(resetCommand("/my data/plugins/egg/reset-enrollment"), "mkdir -p '/my data/plugins/egg' && touch '/my data/plugins/egg/reset-enrollment'");
});

test("last used: written at most once a minute, however often the page reads", async () => {
  const w = world();
  const key = await browserKey();
  await w.keys.enrol(key.publicKey, "page");
  let writes = 0;
  const set = w.kv.set.bind(w.kv);
  w.kv.set = async (k, v) => {
    writes++;
    return set(k, v);
  };
  for (let i = 0; i < 20; i++) {
    w.clock.now += 3000;
    await w.keys.verify(await key.sign("worker_status", { roomId: "r" }, w.clock.now));
  }
  assert.ok(writes >= 1 && writes <= 2, `${writes} writes`);
  assert.ok((await w.keys.state()).keys[0]!.lastUsedAt !== null);
});

test("runSigned: every action is reached with a good signature, with its arguments and the key that signed", async () => {
  const w = world();
  const key = await browserKey();
  await w.keys.enrol(key.publicKey, "page");
  const { ran, dispatch } = recorder();
  const fp = "0123-4567-89ab-cdef";
  const samples: Record<(typeof ACTION_NAMES)[number], unknown> = {
    room_create: { folder: "/repo", line: "what is here", projectId: null, source: "typed" },
    say: { roomId: "r", text: "a line", source: "voice" },
    work: { roomId: "r", text: "build it", source: "pasted" },
    worker_stop: { roomId: "r" },
    more: { roomId: "r", viewId: "v" },
    cross: { roomId: "r", a: "v1", b: "v2" },
    zoom: { roomId: "r", viewId: "v", part: "the header", source: "typed" },
    pin: { roomId: "r", viewId: null },
    decide: { roomId: "r", viewId: "v", decision: "kept" },
    room_delete: { roomId: "r" },
    room_restore: { roomId: "r" },
    note: { roomId: "r", text: "the microphone did not open" },
    key_approve: { fingerprint: fp },
    key_refuse: { fingerprint: fp },
    key_remove: { fingerprint: fp },
    defaults: { projectId: null },
    rooms_list: null,
    room_get: { roomId: "r" },
    view_content: { roomId: "r", viewId: "v" },
    ledger: { roomId: "r" },
    worker_status: { roomId: "r" },
  };
  assert.deepEqual(Object.keys(samples).sort(), [...ACTION_NAMES].sort());
  for (const action of ACTION_NAMES) await runSigned(w.keys, dispatch, await key.sign(action, samples[action], w.clock.now));
  assert.deepEqual(ran.map((r) => r.action), ACTION_NAMES);
  assert.ok(ran.every((r) => r.by === key.fingerprint));
  assert.deepEqual(ran.find((r) => r.action === "say")!.args, samples.say);
  for (const read of READS) assert.ok(read in ACTIONS);
});

test("runSigned: nothing runs for a call that is unsigned, forged, replayed, stale or changed", async () => {
  const w = world();
  const key = await browserKey();
  const stranger = await browserKey();
  await w.keys.enrol(key.publicKey, "page");
  const { ran, dispatch } = recorder();
  const args = { roomId: "r", text: "run the deploy script", source: "typed" };
  for (const action of ACTION_NAMES) {
    // The old, unsigned form: just the arguments.
    await refused(runSigned(w.keys, dispatch, args), "unsigned");
    await refused(runSigned(w.keys, dispatch, { action, args }), "unsigned");
    await refused(runSigned(w.keys, dispatch, { action, args, at: w.clock.now, nonce: "n".repeat(32), key: key.fingerprint, sig: Buffer.alloc(64, 1).toString("base64url") }), "bad_signature");
    await refused(runSigned(w.keys, dispatch, await stranger.sign(action, args, w.clock.now)), "unknown_key");
    await refused(runSigned(w.keys, dispatch, await key.sign(action, args, w.clock.now - SIGNATURE_WINDOW_MS - 1)), "stale");
    const good = await key.sign(action, args, w.clock.now);
    await refused(runSigned(w.keys, dispatch, { ...good, args: { ...args, roomId: "another" } }), "bad_signature");
  }
  assert.equal(ran.length, 0);
  const once = await key.sign("say", args, w.clock.now);
  await runSigned(w.keys, dispatch, once);
  await refused(runSigned(w.keys, dispatch, once), "replayed");
  assert.equal(ran.length, 1);
});

test("runSigned: a well-signed call for no such action, or with arguments in the wrong form, runs nothing", async () => {
  const w = world();
  const key = await browserKey();
  await w.keys.enrol(key.publicKey, "page");
  const { ran, dispatch } = recorder();
  await refused(runSigned(w.keys, dispatch, await key.sign("drop_everything", {}, w.clock.now)), "bad_action");
  await refused(runSigned(w.keys, dispatch, await key.sign("constructor", {}, w.clock.now)), "bad_action");
  await refused(runSigned(w.keys, dispatch, await key.sign("__proto__", {}, w.clock.now)), "bad_action");
  await refused(runSigned(w.keys, dispatch, await key.sign("say", { roomId: "r", text: "", source: "typed" }, w.clock.now)), "bad_arguments");
  await refused(runSigned(w.keys, dispatch, await key.sign("say", { roomId: "r", text: "x", source: "an agent" }, w.clock.now)), "bad_arguments");
  await refused(runSigned(w.keys, dispatch, await key.sign("key_approve", { fingerprint: "nope" }, w.clock.now)), "bad_arguments");
  assert.equal(ran.length, 0);
});

test("the page tells a signing refusal from any other failure, and says each in plain words", () => {
  for (const code of Object.keys(SIGNING_REFUSALS) as (keyof typeof SIGNING_REFUSALS)[]) {
    assert.equal(signingRefusalIn(`Plugin RPC failed: ${SIGNING_REFUSALS[code]} (abcd)`), code);
    const words = refusalInWords(code, "Not sent");
    assert.ok(words.startsWith("Not sent: "));
    assert.ok(!/nonce|envelope|canonical|ECDSA/i.test(words), words);
  }
  assert.equal(signingRefusalIn("No room r_123"), null);
  assert.equal(notEnrolledText("enrolled", "a", "/p"), "");
  const pending = notEnrolledText("pending", "1111-2222-3333-4444", "/data/plugins/egg/reset-enrollment");
  assert.ok(pending.includes("1111-2222-3333-4444") && pending.includes("A, then y, approves it") && pending.includes("touch /data/plugins/egg/reset-enrollment"));
  assert.ok(notEnrolledText("refused", "1111-2222-3333-4444", "/x/y").includes("was refused"));
  assert.ok(notEnrolledText("unavailable", null, "").includes("cannot keep a signing key"));
  assert.ok(notEnrolledText("pending", "1111-2222-3333-4444", "/x/y", true).includes("refuse those you do not know (X)"));
  for (const status of ["pending", "refused", "unavailable"] as const) assert.ok(notEnrolledShort(status).includes("The line at the top of this page says what to do."));
});
