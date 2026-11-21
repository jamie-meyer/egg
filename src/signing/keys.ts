// The keys egg trusts, on the backend: which browsers' keys are enrolled,
// how a call's signature is verified, and how enrolment is reset.
//
// Trust on first use: with no key enrolled, the first page to ask is
// enrolled. After that a key is enrolled only by a signed call from a key
// that already is. Nothing here trusts a caller: bb does not say who calls.

import type { Kv } from "../store.ts";
import {
  type EnrolOutcome,
  type EnrolledKey,
  type Envelope,
  type KeyRequest,
  type KeysState,
  type PublicKey,
  SIGNATURE_WINDOW_MS,
  SIGNING_REFUSALS,
  TOO_MANY_WAITING,
  enrolledKeySchema,
  envelopeSchema,
  fingerprintText,
  formatFingerprint,
  keyRequestSchema,
  publicKeySchema,
  signedText,
} from "./envelope.ts";

const KEY = "key:";
const REQUEST = "keyreq:";
/** Requests kept at once, pending and refused together: anyone can ask, so asking is bounded. */
export const MAX_REQUESTS = 8;
export const MAX_KEYS = 12;
const MAX_LABEL = 80;
/** A key's "last used" is written at most this often: the page reads every few seconds. */
const USED_EVERY_MS = 60_000;

/** A refusal the caller can act on: what is wrong, in words. */
export class Refusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Run jobs with the same key one after another. */
export function serial(): <T>(key: string, job: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, job: () => Promise<T>): Promise<T> => {
    const run = (tails.get(key) ?? Promise.resolve()).then(job, job);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

export interface KeyDeps {
  kv: Kv;
  /** The installed plugin's id: a signature is good only when made out to it. */
  plugin: string;
  now(): number;
  /** SHA-256 of a text, as hex. */
  hash(text: string): string;
  /** Whether `sig` (base64url) is `key`'s signature of `text`. */
  verify(key: PublicKey, text: string, sig: string): boolean;
  /** Where the reset file is looked for. */
  resetPath: string;
  /** Take the reset file away if it is there. True only when it was there and is now gone. */
  takeResetFile(): Promise<boolean>;
  /** Enrolment changed: tell the pages. */
  changed(): void;
  /** One line for bb's log about a change of enrolment. */
  log(text: string): void;
}

export interface Keys {
  state(): Promise<KeysState>;
  /** A page presents its key. The first one ever is enrolled; any other becomes a request for an enrolled page to approve. */
  enrol(key: unknown, label: unknown): Promise<{ outcome: EnrolOutcome; fingerprint: string }>;
  /** Check a signed call. Returns the fingerprint of the enrolled key that signed it, or refuses, saying why. */
  verify(envelope: unknown): Promise<{ by: string; envelope: Envelope }>;
  // Signed actions: `by` is the key that signed the call.
  approve(fingerprint: string, by: string): Promise<EnrolledKey>;
  refuse(fingerprint: string, by: string): Promise<void>;
  /** Remove an enrolled key, or forget a request so that page can ask again. */
  remove(fingerprint: string, by: string): Promise<void>;
  /** Clear every key if the reset file is there. Returns whether it did. */
  resetIfAsked(): Promise<boolean>;
}

export function createKeys(deps: KeyDeps): Keys {
  const { kv } = deps;
  const locked = serial();
  /** When this backend started: a call signed before then is refused, since the nonces it had seen are forgotten. */
  const startedAt = deps.now();
  const seen = new Map<string, number>();

  const fingerprintOf = (key: PublicKey): string => formatFingerprint(deps.hash(fingerprintText(key)));
  const readAll = async <T>(prefix: string, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): Promise<T[]> => {
    const found = await Promise.all((await kv.list(prefix)).map(async (key) => schema.safeParse(await kv.get(key))));
    return found.flatMap((entry) => (entry.success ? [entry.data] : []));
  };
  const keys = async (): Promise<EnrolledKey[]> => (await readAll(KEY, enrolledKeySchema)).sort((a, b) => a.enrolledAt - b.enrolledAt || a.fingerprint.localeCompare(b.fingerprint));
  const requests = async (): Promise<KeyRequest[]> => (await readAll(REQUEST, keyRequestSchema)).sort((a, b) => a.requestedAt - b.requestedAt || a.fingerprint.localeCompare(b.fingerprint));

  const resetIfAsked: Keys["resetIfAsked"] = () =>
    locked("keys", async () => {
      if (!(await deps.takeResetFile().catch(() => false))) return false;
      const all = await kv.list(KEY);
      for (const key of [...all, ...(await kv.list(REQUEST))]) await kv.delete(key);
      seen.clear();
      deps.log(`enrolment reset by the reset file: ${all.length} key${all.length === 1 ? "" : "s"} removed`);
      deps.changed();
      return true;
    });

  const refuse = (code: string, message: string): never => {
    throw new Refusal(code, message);
  };

  return {
    resetIfAsked,

    async state() {
      await resetIfAsked();
      return { plugin: deps.plugin, keys: await keys(), requests: await requests(), now: deps.now(), resetPath: deps.resetPath };
    },

    async enrol(rawKey, rawLabel) {
      await resetIfAsked();
      const parsed = publicKeySchema.safeParse(rawKey);
      if (!parsed.success) throw new Refusal("bad_key", "that is not a P-256 public key");
      const key = parsed.data;
      const label = (typeof rawLabel === "string" ? rawLabel : "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL) || "a page";
      const fingerprint = fingerprintOf(key);
      return locked("keys", async () => {
        const enrolled = await keys();
        if (enrolled.some((entry) => entry.fingerprint === fingerprint)) return { outcome: "enrolled" as const, fingerprint };
        if (enrolled.length === 0) {
          const first: EnrolledKey = { fingerprint, key, label, enrolledAt: deps.now(), how: "first", approvedBy: null, lastUsedAt: null };
          await kv.set(KEY + fingerprint, first);
          await kv.delete(REQUEST + fingerprint);
          deps.log(`key ${fingerprint} (${label}) enrolled: the first to ask`);
          deps.changed();
          return { outcome: "enrolled-first" as const, fingerprint };
        }
        const waiting = await requests();
        const mine = waiting.find((entry) => entry.fingerprint === fingerprint);
        if (mine) return { outcome: mine.status, fingerprint };
        if (waiting.length >= MAX_REQUESTS) {
          // A refusal the person already made gives way to a new request; one still waiting for them never does.
          const oldestRefused = waiting.find((entry) => entry.status === "refused");
          if (!oldestRefused) throw new Refusal("too_many_requests", `${waiting.length} ${TOO_MANY_WAITING}: approve or refuse those first, from a browser that is enrolled`);
          await kv.delete(REQUEST + oldestRefused.fingerprint);
        }
        await kv.set(REQUEST + fingerprint, { fingerprint, key, label, requestedAt: deps.now(), status: "pending" } satisfies KeyRequest);
        deps.log(`key ${fingerprint} (${label}) asks to be enrolled`);
        deps.changed();
        return { outcome: "pending" as const, fingerprint };
      });
    },

    async verify(raw) {
      await resetIfAsked();
      const parsed = envelopeSchema.safeParse(raw);
      if (!parsed.success || parsed.data.sig === "" || parsed.data.key === "") return refuse("unsigned", SIGNING_REFUSALS.unsigned);
      const envelope = parsed.data;
      const enrolled = enrolledKeySchema.safeParse(await kv.get(KEY + envelope.key));
      if (!enrolled.success || enrolled.data.fingerprint !== envelope.key) return refuse("unknown_key", `${SIGNING_REFUSALS.unknown_key} (${envelope.key})`);
      const now = deps.now();
      if (!Number.isFinite(envelope.at) || Math.abs(now - envelope.at) > SIGNATURE_WINDOW_MS || envelope.at < startedAt) {
        return refuse("stale", `${SIGNING_REFUSALS.stale}: sign it again`);
      }
      // The signature is checked before the nonce is remembered, so that an unsigned call cannot use one up.
      let good = false;
      try {
        good = deps.verify(enrolled.data.key, signedText(deps.plugin, envelope), envelope.sig);
      } catch {
        good = false;
      }
      if (!good) return refuse("bad_signature", SIGNING_REFUSALS.bad_signature);
      // From here to the nonce being remembered nothing waits, so two copies of one call cannot both pass.
      for (const [nonce, at] of seen) if (now - at > 2 * SIGNATURE_WINDOW_MS) seen.delete(nonce);
      if (seen.has(envelope.nonce)) return refuse("replayed", SIGNING_REFUSALS.replayed);
      seen.set(envelope.nonce, now);
      if (enrolled.data.lastUsedAt === null || now - enrolled.data.lastUsedAt > USED_EVERY_MS) {
        await locked("keys", async () => {
          const current = enrolledKeySchema.safeParse(await kv.get(KEY + envelope.key));
          // Removed, or reset, while this call was being checked: it is no longer a key to act for.
          if (!current.success) return refuse("unknown_key", `${SIGNING_REFUSALS.unknown_key} (${envelope.key})`);
          await kv.set(KEY + envelope.key, { ...current.data, lastUsedAt: now });
        });
      }
      return { by: envelope.key, envelope };
    },

    approve: (fingerprint, by) =>
      locked("keys", async () => {
        const request = keyRequestSchema.safeParse(await kv.get(REQUEST + fingerprint));
        if (!request.success) throw new Refusal("request_not_found", `no browser with the key ${fingerprint} is asking to be enrolled`);
        if ((await keys()).length >= MAX_KEYS) throw new Refusal("too_many_keys", `${MAX_KEYS} keys are enrolled already: remove one first`);
        const made: EnrolledKey = { fingerprint, key: request.data.key, label: request.data.label, enrolledAt: deps.now(), how: "approved", approvedBy: by, lastUsedAt: null };
        await kv.set(KEY + fingerprint, made);
        await kv.delete(REQUEST + fingerprint);
        deps.log(`key ${fingerprint} (${made.label}) enrolled: approved by ${by}`);
        deps.changed();
        return made;
      }),

    refuse: (fingerprint, by) =>
      locked("keys", async () => {
        const request = keyRequestSchema.safeParse(await kv.get(REQUEST + fingerprint));
        if (!request.success) throw new Refusal("request_not_found", `no browser with the key ${fingerprint} is asking to be enrolled`);
        await kv.set(REQUEST + fingerprint, { ...request.data, status: "refused" } satisfies KeyRequest);
        deps.log(`key ${fingerprint} refused by ${by}`);
        deps.changed();
      }),

    remove: (fingerprint, by) =>
      locked("keys", async () => {
        const enrolled = (await kv.get(KEY + fingerprint)) !== undefined;
        const requested = (await kv.get(REQUEST + fingerprint)) !== undefined;
        if (!enrolled && !requested) throw new Refusal("key_not_found", `there is no key ${fingerprint}`);
        await kv.delete(KEY + fingerprint);
        await kv.delete(REQUEST + fingerprint);
        deps.log(`key ${fingerprint} removed by ${by}`);
        deps.changed();
      }),
  };
}
