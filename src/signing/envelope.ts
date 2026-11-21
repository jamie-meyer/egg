// What a signed call is, for the page that signs and the backend that
// verifies. Pure.
//
// bb serves a plugin's methods to any local process and does not say who is
// calling. A line in a room is a message from the person to a thread that
// builds and runs things, so egg does not take a caller's word for it: the
// page holds a signing key that never leaves the browser and signs each
// call, and the backend acts only on a signature from a key it enrolled.

import { z } from "zod";
import { canonical } from "./canonical.ts";

/** The realtime channel that says enrolment changed. */
export const KEYS_CHANGED = "keys-changed";

/** A signature is good for this long either side of the backend's clock. */
export const SIGNATURE_WINDOW_MS = 2 * 60_000;

/** The public half of a page's key, as the browser exports it. */
export const publicKeySchema = z.strictObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type PublicKey = z.infer<typeof publicKeySchema>;

export const envelopeSchema = z.object({
  action: z.string().max(60),
  /** The action's arguments, exactly as they were signed. */
  args: z.unknown(),
  /** When it was signed, by the backend's clock as the page knows it. */
  at: z.number(),
  /** Used once. */
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  /** The fingerprint of the key that signed it. */
  key: z.string().max(40),
  /** The signature, base64url: ECDSA P-256 over SHA-256, r then s. */
  sig: z.string().max(200),
});
export type Envelope = z.infer<typeof envelopeSchema>;

/**
 * The exact text that is signed: which installed plugin it is for, the
 * action, its arguments, when, and the nonce. The plugin id is part of it so
 * that a call signed for one installed copy of egg (a copy for checks, say)
 * is no use against another that trusts the same browser.
 */
export function signedText(plugin: string, call: Pick<Envelope, "action" | "args" | "at" | "nonce">): string {
  return canonical({ action: call.action, args: call.args ?? null, at: call.at, for: plugin, nonce: call.nonce });
}

/** What a key's fingerprint is the hash of. */
export function fingerprintText(key: PublicKey): string {
  return canonical({ crv: key.crv, kty: key.kty, x: key.x, y: key.y });
}

/** A fingerprint as shown: the first 16 hex digits of the hash, in fours. */
export function formatFingerprint(sha256Hex: string): string {
  return (sha256Hex.slice(0, 16).match(/.{4}/g) ?? []).join("-");
}
export const fingerprintSchema = z.string().regex(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);

export const enrolledKeySchema = z.object({
  fingerprint: z.string(),
  key: publicKeySchema,
  /** What the page said it was: its browser, in a few words. It is the page's own word. */
  label: z.string(),
  enrolledAt: z.number(),
  /** `first`: nothing was enrolled, and this was the first page to open. `approved`: an enrolled page approved it. */
  how: z.enum(["first", "approved"]),
  /** The key that approved it; null for the first. */
  approvedBy: z.string().nullable(),
  /** To the minute: when it last signed a call that was accepted. */
  lastUsedAt: z.number().nullable(),
});
export type EnrolledKey = z.infer<typeof enrolledKeySchema>;

export const keyRequestSchema = z.object({
  fingerprint: z.string(),
  key: publicKeySchema,
  label: z.string(),
  requestedAt: z.number(),
  status: z.enum(["pending", "refused"]),
});
export type KeyRequest = z.infer<typeof keyRequestSchema>;

export const keysStateSchema = z.object({
  /** The installed plugin's id: what a signature is made out to. */
  plugin: z.string(),
  keys: z.array(enrolledKeySchema),
  requests: z.array(keyRequestSchema),
  /** The backend's clock, so that a page whose own clock is off still signs a time the backend accepts. */
  now: z.number(),
  /** After a reset that named a key: the only key that may be enrolled next. Null otherwise. */
  next: z.string().nullable(),
  /** The file whose presence resets enrolment. */
  resetPath: z.string(),
});
export type KeysState = z.infer<typeof keysStateSchema>;

/** What a page that asks to be enrolled is told. */
export type EnrolOutcome = "enrolled-first" | "enrolled" | "pending" | "refused";

/** Why the backend refuses a call for a reason of signing. */
export type SigningRefusalCode = "unsigned" | "unknown_key" | "stale" | "replayed" | "bad_signature";

/**
 * What the backend says for each, word for word. The page recognises a
 * refusal by these sentences, so they are written once, here.
 */
export const SIGNING_REFUSALS: Record<SigningRefusalCode, string> = {
  unsigned: "egg acts only on calls signed by a browser enrolled with it: this call carries no usable signature",
  unknown_key: "the key that signed this call is not enrolled with egg",
  stale: "this call was signed too long ago, or before egg last started",
  replayed: "this signed call was already used once",
  bad_signature: "the signature does not match the call: it was not signed by that key, or the call was changed after it was signed",
};

/** What a browser is told when it asks to be enrolled and the list of those waiting is full. The page recognises it by these words. */
export const TOO_MANY_WAITING = "browsers already wait to be enrolled with egg";

/** Which signing refusal an error message is, if it is one. */
export function signingRefusalIn(message: string): SigningRefusalCode | null {
  for (const code of Object.keys(SIGNING_REFUSALS) as SigningRefusalCode[]) if (message.includes(SIGNING_REFUSALS[code])) return code;
  return null;
}

/**
 * The command that resets enrolment, for the person's own terminal. With a
 * key, the file names it, and only that key is enrolled afterwards: without
 * one, whatever asked first after the reset would be, and an agent can ask
 * faster than a page.
 */
export function resetCommand(resetPath: string, fingerprint: string | null = null): string {
  if (!resetPath) return "";
  const dir = resetPath.replace(/\/[^/]*$/, "");
  const quote = (path: string) => (/^[A-Za-z0-9_./~-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`);
  return fingerprint ? `mkdir -p ${quote(dir)} && echo ${fingerprint} > ${quote(resetPath)}` : `mkdir -p ${quote(dir)} && touch ${quote(resetPath)}`;
}

export type PageStatus = "loading" | "enrolled" | "pending" | "refused" | "unavailable";

/**
 * Why a page can do nothing here, and what the person does about it. Empty
 * when it can. `crowded`: so many keys wait already that this one could not
 * even be put on the list.
 */
export function notEnrolledText(status: PageStatus, fingerprint: string | null, resetPath: string, crowded = false): string {
  if (status === "enrolled") return "";
  if (status === "loading") return "This browser's key for egg is still being read: try again in a moment.";
  if (status === "unavailable") return "This browser cannot keep a signing key for egg (no IndexedDB or WebCrypto here), so egg shows nothing and does nothing in it. Open egg in bb's own window, or another browser.";
  const reset = resetCommand(resetPath, fingerprint);
  const none = reset ? ` If egg works in no browser of yours, run this in your own terminal, then reload (it clears every key and lets only this one in): ${reset}` : "";
  const key = fingerprint ?? "(unknown)";
  if (status === "refused") return `This browser's key ${key} was refused from a browser enrolled with egg, so egg shows nothing and does nothing here.${none}`;
  if (crowded) return `This browser is not enrolled with egg, so egg shows nothing and does nothing here. Its key is ${key}. Other keys wait to be approved ahead of it, as many as egg keeps: open egg in a browser where it already works and refuse those you do not know (X). This key then shows there, and A, then y, approves it.${none}`;
  return `This browser is not enrolled with egg, so egg shows nothing and does nothing here. Its key is ${key}. Open egg in a browser where it already works: it shows this key there, and A, then y, approves it.${none}`;
}

/** The same in a few words, for the notebook: the line at the top of the page says the rest. */
export function notEnrolledShort(status: PageStatus): string {
  if (status === "unavailable") return "this browser cannot keep a signing key for egg. The line at the top of this page says what to do.";
  if (status === "refused") return "this browser's key was refused. The line at the top of this page says what to do.";
  return "this browser is not enrolled with egg. The line at the top of this page says what to do.";
}

/** What the page says in the notebook when a call was refused for a reason of signing. */
export function refusalInWords(code: SigningRefusalCode, what: string): string {
  const said = {
    unsigned: "egg did not get this browser's signature with it.",
    unknown_key: "this browser is no longer enrolled with egg. Reload the page; if it then says it is not enrolled, it tells you what to do.",
    stale: "egg restarted, or this computer's clock moved, between signing and sending. Do it again.",
    replayed: "egg had already received that exact signed call once. Do it again.",
    bad_signature: "its signature did not match what egg received. Do it again; if this keeps happening, reload the page.",
  }[code];
  return `${what}: ${said}`;
}
