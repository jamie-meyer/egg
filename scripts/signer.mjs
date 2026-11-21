// A signing key for egg's check scripts, held in the script's own memory.
//
// egg acts only on calls signed by an enrolled key (docs/security.md). A
// script that calls egg's backend directly therefore needs a key of its own,
// enrolled like a second browser: the first key to ask on an egg with none
// is enrolled, any other is approved from an enrolled page (A, then y) or by a call
// signed with an enrolled key. Against a copy for checks a script may also
// reset enrolment first; it never does that to the installed egg.
import { createHash, webcrypto } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fingerprintText, formatFingerprint, signedText } from "../src/signing/envelope.ts";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INSTALLED_ID = "egg";

/** One call of a method of egg's interface, as any local process can make it. Never throws for a refusal. */
export async function rawRpc(bb, plugin, method, input) {
  const res = await fetch(`${bb}/api/v1/plugins/${plugin}/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input ?? null) });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const ok = res.ok && body !== null && !body.error && body.ok !== false;
  return { ok, status: res.status, result: ok ? body.result : undefined, error: ok ? null : (body?.error?.message ?? JSON.stringify(body).slice(0, 300)), code: ok ? null : (body?.error?.code ?? null) };
}

/** A key pair as a browser would make it, and what signs with it. */
export async function makeKey() {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const publicKey = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  const fingerprint = formatFingerprint(createHash("sha256").update(fingerprintText(publicKey)).digest("hex"));
  /** The envelope for one call: signed for `plugin`, at `at`, with `nonce`. */
  const envelope = async (plugin, action, args, at, nonce = webcrypto.randomUUID().replace(/-/g, "")) => {
    const sig = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(signedText(plugin, { action, args, at, nonce })));
    return { action, args, at, nonce, key: fingerprint, sig: Buffer.from(sig).toString("base64url") };
  };
  return { publicKey, fingerprint, envelope };
}

/**
 * A signer for one installed copy of egg: a fresh key, the backend's clock,
 * and `call(action, args)` for a signed call. Not enrolled until `enrol()`
 * says so.
 */
export async function makeSigner({ bb, plugin, label = "egg's check script (node)" }) {
  const key = await makeKey();
  let offset = 0;
  const state = async () => {
    const r = await rawRpc(bb, plugin, "keys_state", null);
    if (!r.ok) throw new Error(`keys_state: ${r.error}`);
    offset = r.result.now - Date.now();
    return r.result;
  };
  await state();
  const now = () => Date.now() + offset;
  /** The envelope for a call. Options, for checks: another time, a chosen nonce, another plugin id to make it out to. */
  const sign = (action, args, options = {}) => key.envelope(options.plugin ?? plugin, action, args, options.at ?? now(), options.nonce);
  return {
    bb,
    plugin,
    fingerprint: key.fingerprint,
    state,
    now,
    sign,
    /** Present the key: "enrolled-first", "enrolled", "pending" or "refused". */
    async enrol() {
      const r = await rawRpc(bb, plugin, "key_enrol", { key: key.publicKey, label });
      if (!r.ok) throw new Error(`key_enrol: ${r.error}`);
      return r.result.outcome;
    },
    async enrolled() {
      return (await state()).keys.some((k) => k.fingerprint === key.fingerprint);
    },
    /** A signed call; throws with egg's own words when it is refused or fails. */
    async call(action, args) {
      const r = await rawRpc(bb, plugin, "signed", await sign(action, args ?? null));
      if (!r.ok) throw new Error(`${action}: ${r.error}`);
      return r.result.result;
    },
  };
}

/**
 * Clear every enrolled key of a copy for checks, with the reset file, as a
 * person would from their own terminal. Refuses the installed egg. Needs to
 * run outside any command sandbox: the file is under bb's data directory.
 */
export async function resetEnrolment({ bb, plugin }) {
  if (plugin === INSTALLED_ID) throw new Error("not resetting the enrolment of the installed egg: that is for its person to do");
  const before = await rawRpc(bb, plugin, "keys_state", null);
  if (!before.ok) throw new Error(`keys_state: ${before.error}`);
  const { resetPath } = before.result;
  if (!resetPath.includes(`/plugins/${plugin}/`)) throw new Error(`the reset path ${resetPath} is not this copy's`);
  if (before.result.keys.length === 0 && before.result.requests.length === 0) return { resetPath, cleared: 0 };
  mkdirSync(dirname(resetPath), { recursive: true });
  writeFileSync(resetPath, "");
  for (let i = 0; i < 40; i++) {
    const s = await rawRpc(bb, plugin, "keys_state", null);
    if (s.ok && s.result.keys.length === 0 && s.result.requests.length === 0) return { resetPath, cleared: before.result.keys.length };
    await sleep(250);
  }
  throw new Error(`enrolment was not reset: ${resetPath} was written but the keys are still there`);
}

/**
 * A signer that is enrolled, or an error saying what to do. With `reset`
 * (a copy for checks only) enrolment is cleared first and this key is the
 * first. Otherwise, when another key is enrolled already, `approve` is
 * called with this key's fingerprint (a check presses A on its page), or
 * the person is asked to approve it on egg's page.
 */
export async function enrolledSigner({ bb, plugin, reset = false, approve = null, waitMs = 180_000 }) {
  if (reset) await resetEnrolment({ bb, plugin });
  const signer = await makeSigner({ bb, plugin });
  const outcome = await signer.enrol();
  if (outcome === "refused") throw new Error(`the script's key ${signer.fingerprint} was refused`);
  if (outcome === "pending") {
    if (approve) await approve(signer.fingerprint);
    else console.log(`The script's key ${signer.fingerprint} waits to be approved: open egg's page in a browser where it works and press A, then y.`);
    const until = Date.now() + waitMs;
    while (!(await signer.enrolled())) {
      if (Date.now() > until) throw new Error(`the script's key ${signer.fingerprint} was not approved in ${Math.round(waitMs / 1000)} s`);
      await sleep(500);
    }
  }
  return signer;
}
