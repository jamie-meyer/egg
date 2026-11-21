// The probe: what a process that can reach bb, a sandboxed agent thread
// included, can get egg to do without the person's key. It tries every
// signed action
//
//   - by its old method name, the way egg 0.2.0 took it;
//   - through `signed` with no signature;
//   - with a made-up signature that names an enrolled key;
//   - signed by a key of its own, under its own name and under an enrolled one;
//   - with a valid signature whose nonce was already used;
//   - with a valid signature that is too old;
//   - with a valid signature and changed arguments;
//
// and reports that each was refused. Run against a copy for checks only
// (scripts/copy-for-checks.mjs), never the installed egg.
//
// It has two sides. The attacker (this file run as a script) holds no
// enrolled key. The valid signatures it replays and tampers with come from a
// harness that does hold one: the `probe` section of scripts/e2e.mjs, which
// also reads everything before and after and reports that nothing changed.
//
//   node scripts/probe.mjs --plugin egg-check                 what needs no captured signature
//   node scripts/probe.mjs --plugin egg-check --dir <dir>     all of it: waits for the harness's
//                                                             material in <dir> (e2e --probe-dir <dir>)
//   ... --sandboxed    also try what only bb's command sandbox stops: creating the
//                      reset file, opening bb's database for writing, and changing a
//                      setting with `bb plugin config`. Pass it only when this runs
//                      inside an agent's sandbox: outside one, the first resets the
//                      copy's enrolment.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { ACTION_NAMES, READS } from "../src/signing/actions.ts";
import { canonical } from "../src/signing/canonical.ts";
import { SIGNATURE_WINDOW_MS, SIGNING_REFUSALS } from "../src/signing/envelope.ts";
import { makeKey, rawRpc, sleep } from "./signer.mjs";

const INSTALLED_ID = "egg";
/** Material older than this is not used: the attempts must land well inside the signature window. */
const MATERIAL_FRESH_MS = 45_000;

/**
 * Real arguments for every action, aimed at a room that exists: what an
 * agent would send to make egg act. `fixture` is { roomId, viewId, viewId2,
 * folder, keyFingerprint }.
 */
export function realArgs(fixture) {
  const { roomId, viewId, viewId2, folder, keyFingerprint } = fixture;
  return {
    room_create: { folder, line: "probe: a room an agent tried to make", projectId: null, source: "typed" },
    say: { roomId, text: "probe: a line an agent tried to say as the person", source: "typed" },
    work: { roomId, text: "probe: work an agent tried to give the room thread", source: "typed" },
    worker_stop: { roomId },
    more: { roomId, viewId },
    cross: { roomId, a: viewId, b: viewId2 },
    zoom: { roomId, viewId, part: "probe: a part an agent tried to zoom into", source: "typed" },
    pin: { roomId, viewId },
    decide: { roomId, viewId, decision: "dropped" },
    room_delete: { roomId },
    room_restore: { roomId },
    note: { roomId, text: "probe: a line an agent tried to write in the notebook" },
    key_approve: { fingerprint: keyFingerprint },
    key_refuse: { fingerprint: keyFingerprint },
    key_remove: { fingerprint: keyFingerprint },
    defaults: { projectId: null },
    rooms_list: null,
    room_get: { roomId },
    view_content: { roomId, viewId },
    ledger: { roomId },
    worker_status: { roomId },
  };
}

/**
 * Arguments that do nothing if carried out: a room, view, folder and key
 * that do not exist. The harness signs these, fresh and unused, for the
 * attacker to change: a valid signature for one thing, pointed at another.
 */
export function harmlessArgs() {
  const none = "probe-no-such-room";
  return realArgs({ roomId: none, viewId: "probe-no-such-view", viewId2: "probe-no-such-view-2", folder: "/probe-no-such-folder", keyFingerprint: "0000-0000-0000-0000" });
}

/** The order attempts go in: what starts no thread first, so that a call wrongly accepted is found before it can cost anything. */
const ORDER = [...READS, "note", "pin", "decide", "key_refuse", "key_remove", "key_approve", "room_restore", "worker_stop", "room_delete", "work", "say", "more", "cross", "zoom", "room_create"];
const ordered = () => {
  const missing = ACTION_NAMES.filter((a) => !ORDER.includes(a));
  if (missing.length || ORDER.length !== ACTION_NAMES.length) throw new Error(`the probe's list of actions is not egg's: ${missing.join(", ")}`);
  return ORDER;
};

/**
 * The harness's side, with an enrolled signer: valid signatures for the
 * attacker to misuse. Call it right before the attack; they go stale.
 */
export async function prepare(signer, fixture) {
  const real = realArgs(fixture);
  const harmless = harmlessArgs();
  // One nonce, used up by a call that changes nothing.
  const used = await signer.sign("rooms_list", null);
  const usedResult = await rawRpc(signer.bb, signer.plugin, "signed", used);
  if (!usedResult.ok) throw new Error(`the harness's own signed call was refused: ${usedResult.error}`);
  const material = { id: webcrypto.randomUUID(), issuedAt: Date.now(), plugin: signer.plugin, fixture, enrolledKey: signer.fingerprint, replay: used, usedNonce: {}, stale: {}, fresh: {} };
  // Signed by the enrolled key, fresh and unused, but for another installed copy: no use here.
  material.otherCopy = await signer.sign("rooms_list", null, { plugin: `${signer.plugin}-other` });
  for (const action of ACTION_NAMES) {
    material.usedNonce[action] = await signer.sign(action, real[action], { nonce: used.nonce });
    material.stale[action] = await signer.sign(action, real[action], { at: signer.now() - SIGNATURE_WINDOW_MS - 60_000 });
    material.fresh[action] = await signer.sign(action, harmless[action]);
  }
  return material;
}

/** Everything of egg's that the attempts could have changed, as one text to compare. */
export async function snapshot(signer, roomsDirOf = null) {
  const rooms = (await signer.call("rooms_list", null)).rooms.map((r) => r.id).sort();
  const full = {};
  const ledgers = {};
  const files = {};
  for (const id of rooms) {
    full[id] = (await signer.call("room_get", { roomId: id })).room;
    ledgers[id] = (await signer.call("ledger", { roomId: id })).entries;
    if (roomsDirOf && full[id]?.dir) files[id] = roomsDirOf(full[id].dir);
  }
  const keys = (await signer.state()).keys.map((k) => `${k.fingerprint} ${k.how}`).sort();
  return { rooms, text: canonical({ rooms, full, ledgers, files, keys }), keys };
}

const short = (text) => String(text ?? "").replace(/\s+/g, " ").slice(0, 140);

/**
 * The attacker's side. `material` is the harness's, or null for the attempts
 * that need none. Returns every attempt with what was expected and what
 * happened; stops at the first call egg accepts.
 */
export async function attack({ bb, plugin, material = null, sandboxed = false, log = console.log }) {
  if (plugin === INSTALLED_ID) throw new Error("the probe runs against a copy for checks, not the installed egg");
  const attempts = [];
  let accepted = null;
  const record = (what, expected, got, ok) => {
    attempts.push({ what, expected, got: short(got), ok });
    log(`${ok ? "expected" : "WRONG   "} ${what}: ${short(got)}`);
  };
  /** One call that must be refused, with a refusal that says `sentence`. */
  const refused = async (what, method, input, sentence) => {
    if (accepted) return;
    const r = await rawRpc(bb, plugin, method, input);
    if (r.ok) accepted = what;
    record(what, sentence, r.ok ? `ACCEPTED: ${JSON.stringify(r.result).slice(0, 100)}` : r.error, !r.ok && r.error.includes(sentence));
  };

  const state = await rawRpc(bb, plugin, "keys_state", null);
  if (!state.ok) throw new Error(`keys_state: ${state.error}`);
  const enrolled = state.result.keys.map((k) => k.fingerprint);
  if (enrolled.length === 0) throw new Error("no key is enrolled with this copy: open its page first, or the first key to ask would be the attacker's");
  const victim = material?.enrolledKey ?? enrolled[0];
  const offset = state.result.now - Date.now();
  const now = () => Date.now() + offset;
  const fixture = material?.fixture ?? { roomId: "probe-any-room", viewId: "probe-any-view", viewId2: "probe-any-view-2", folder: "/tmp", keyFingerprint: "0000-0000-0000-0000" };
  const mine = await makeKey();
  const real = realArgs({ ...fixture, keyFingerprint: mine.fingerprint });
  const nonce = () => webcrypto.randomUUID().replace(/-/g, "");

  // The attacker's own key asks to be enrolled: it becomes a request, and can sign nothing that is accepted.
  const asked = await rawRpc(bb, plugin, "key_enrol", { key: mine.publicKey, label: "probe: an agent's key, asking as if it were a browser" });
  const outcome = asked.ok ? asked.result.outcome : asked.error;
  record("key_enrol with a key of its own: becomes a request, not a key", "pending: a request the person sees, or refused when 8 already wait", outcome, outcome === "pending" || /already wait/.test(String(outcome)));

  for (const action of ordered()) {
    const args = real[action];
    await refused(`${action}: by its old method name, unsigned`, action, args, "has no rpc method");
    await refused(`${action}: through signed, arguments only`, "signed", args, SIGNING_REFUSALS.unsigned);
    await refused(`${action}: through signed, no signature`, "signed", { action, args, at: now(), nonce: nonce() }, SIGNING_REFUSALS.unsigned);
    await refused(`${action}: a made-up signature naming the enrolled key`, "signed", { action, args, at: now(), nonce: nonce(), key: victim, sig: Buffer.from(webcrypto.getRandomValues(new Uint8Array(64))).toString("base64url") }, SIGNING_REFUSALS.bad_signature);
    await refused(`${action}: signed by its own key, not enrolled`, "signed", await mine.envelope(plugin, action, args, now()), SIGNING_REFUSALS.unknown_key);
    await refused(`${action}: signed by its own key, naming the enrolled key`, "signed", { ...(await mine.envelope(plugin, action, args, now())), key: victim }, SIGNING_REFUSALS.bad_signature);
    if (!material) continue;
    await refused(`${action}: a valid signature whose nonce was already used`, "signed", material.usedNonce[action], SIGNING_REFUSALS.replayed);
    await refused(`${action}: a valid signature that is too old`, "signed", material.stale[action], SIGNING_REFUSALS.stale);
    // A valid, fresh, unused signature for arguments that do nothing, pointed at the real thing.
    // Where the real arguments are the very ones that were signed (an action that takes none, or only defaults), one more is added.
    const signedArgs = material.fresh[action].args ?? null;
    const changedArgs = canonical(args ?? null) === canonical(signedArgs) ? { ...(args ?? {}), probe: "changed" } : args;
    await refused(`${action}: a valid signature, arguments changed`, "signed", { ...material.fresh[action], args: changedArgs }, SIGNING_REFUSALS.bad_signature);
    const other = action === "room_delete" ? "say" : "room_delete";
    await refused(`${action}: a valid signature, moved to another action (${other})`, "signed", { ...material.fresh[action], action: other }, SIGNING_REFUSALS.bad_signature);
    await refused(`${action}: a valid signature, its time moved`, "signed", { ...material.fresh[action], at: material.fresh[action].at + 1 }, SIGNING_REFUSALS.bad_signature);
  }
  if (material) {
    await refused("a whole signed call the harness already made, sent again", "signed", material.replay, SIGNING_REFUSALS.replayed);
    await refused("a valid signature by the enrolled key, made out to another copy of egg", "signed", material.otherCopy, SIGNING_REFUSALS.bad_signature);
  }

  // The other route to the same methods: bb's CLI.
  if (!accepted) {
    const cli = (method, input) => {
      const dir = process.env.TMPDIR ?? "/tmp";
      const file = join(dir, `egg-probe-${process.pid}-${Date.now()}.json`);
      writeFileSync(file, JSON.stringify(input));
      try {
        return { ok: true, out: execFileSync("bb", ["plugin", "rpc", "call", plugin, method, "--input-file", file, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
      } catch (e) {
        return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message };
      } finally {
        rmSync(file, { force: true });
      }
    };
    const viaCli = (what, method, input, sentence) => {
      if (accepted) return;
      const r = cli(method, input);
      const wasRefused = !r.ok || /"ok":\s*false|"error"/.test(r.out);
      if (!wasRefused) accepted = what;
      record(what, sentence, wasRefused ? r.out : `ACCEPTED: ${r.out}`, wasRefused && r.out.includes(sentence));
    };
    for (const action of ["say", "work", "room_delete", "room_create", "worker_stop", "room_get"]) {
      viaCli(`${action}: bb plugin rpc call, by its old method name`, action, real[action], "has no rpc method");
      viaCli(`${action}: bb plugin rpc call signed, no signature`, "signed", { action, args: real[action], at: now(), nonce: nonce() }, SIGNING_REFUSALS.unsigned);
      viaCli(`${action}: bb plugin rpc call signed, a made-up signature`, "signed", { action, args: real[action], at: now(), nonce: nonce(), key: victim, sig: Buffer.alloc(64, 9).toString("base64url") }, SIGNING_REFUSALS.bad_signature);
    }
  }

  const outside = [];
  if (sandboxed) {
    // What only bb's command sandbox stops. Each is reported as found, not as a pass or a failure of egg's.
    const resetPath = state.result.resetPath;
    try {
      mkdirSync(dirname(resetPath), { recursive: true });
      writeFileSync(resetPath, "");
      outside.push({ what: `create the reset file ${resetPath}`, result: "CREATED: this position can reset enrolment and be the next key enrolled", blocked: false });
    } catch (e) {
      outside.push({ what: `create the reset file ${resetPath}`, result: `blocked: ${e.code ?? e.message}`, blocked: true });
    }
    const db = join(dirname(dirname(dirname(resetPath))), "bb.db");
    try {
      closeSync(openSync(db, "r+"));
      outside.push({ what: `open bb's database (${db}), where egg's storage is, for writing`, result: "OPENED for writing (nothing was written)", blocked: false });
    } catch (e) {
      outside.push({ what: `open bb's database (${db}), where egg's storage is, for writing`, result: `blocked: ${e.code ?? e.message}`, blocked: true });
    }
    try {
      closeSync(openSync(db, "r"));
      outside.push({ what: "open bb's database for reading", result: "readable: egg's stored rooms, lines and pages can be read from the file, whatever egg signs", blocked: false });
    } catch (e) {
      outside.push({ what: "open bb's database for reading", result: `blocked: ${e.code ?? e.message}`, blocked: true });
    }
    // A setting that changes little, set and put back: is `bb plugin config` reachable from here?
    const config = (...args) => {
      try {
        return { ok: true, out: execFileSync("bb", ["plugin", "config", plugin, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
      } catch (e) {
        return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message };
      }
    };
    const set = config("set", "wakeMinutes", "11");
    const after = config("--json");
    const took = set.ok && /"wakeMinutes":\s*11\b/.test(after.out);
    const back = config("unset", "wakeMinutes");
    outside.push({ what: `change a setting: bb plugin config ${plugin} set wakeMinutes 11`, result: took ? `CHANGED (and put back: ${back.ok ? "unset" : `unset failed: ${short(back.out)}`})` : `not changed: ${short(set.out)}`, blocked: !took });
    for (const o of outside) log(`${o.blocked ? "blocked " : "OPEN    "} ${o.what}: ${o.result}`);
  }

  const wrong = attempts.filter((a) => !a.ok);
  return { plugin, materialId: material?.id ?? null, withMaterial: material !== null, sandboxed, attackerKey: mine.fingerprint, attempts, outside, accepted, refusedAll: accepted === null && wrong.length === 0, wrong };
}

// ---- As a script: the attacker's side.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const bb = option("bb", "http://127.0.0.1:38886");
  const plugin = option("plugin", "egg-check");
  const dir = option("dir");
  const sandboxed = args.includes("--sandboxed");
  if (plugin === INSTALLED_ID) {
    console.error("The probe runs against a copy for checks (scripts/copy-for-checks.mjs), not the installed egg.");
    process.exit(2);
  }
  let material = null;
  if (dir) {
    const file = join(dir, "material.json");
    console.log(`waiting for the harness's material at ${file} (start scripts/e2e.mjs with --only probe --probe-dir ${dir}) ...`);
    const until = Date.now() + 15 * 60_000;
    for (;;) {
      if (existsSync(file)) {
        try {
          const m = JSON.parse(readFileSync(file, "utf8"));
          if (Date.now() - m.issuedAt < MATERIAL_FRESH_MS && !existsSync(join(dir, `attack-${m.id}.json`))) {
            material = m;
            break;
          }
        } catch {
          // being written: read it again
        }
      }
      if (Date.now() > until) {
        console.error("no fresh material came");
        process.exit(2);
      }
      await sleep(500);
    }
    // Tell the harness this material is in use, so it waits for the report instead of issuing more.
    writeFileSync(join(dir, `taken-${material.id}`), "");
    if (material.plugin !== plugin) {
      console.error(`the material is for ${material.plugin}, not ${plugin}`);
      process.exit(2);
    }
  }
  const report = await attack({ bb, plugin, material, sandboxed });
  if (dir) writeFileSync(join(dir, `attack-${material.id}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ attempts: report.attempts.length, wrong: report.wrong.length, accepted: report.accepted, withMaterial: report.withMaterial, sandboxed, outside: report.outside }, null, 2));
  console.log(report.refusedAll ? `probe: all ${report.attempts.length} attempts were refused as expected` : "probe FAILED: see WRONG above");
  process.exit(report.refusedAll ? 0 : 1);
}
