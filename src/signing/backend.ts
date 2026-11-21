// Signed calls, wired to bb: the one RPC method through which everything egg
// does for the person is reached, and the two unsigned methods a page needs
// to get enrolled.
//
// bb serves a plugin's RPC to any local caller. That is why none of the
// person's actions is an RPC method of its own: each is an entry in ACTIONS,
// carried out only after `keys.verify` has checked the call's signature
// against an enrolled key.

import { type BbPluginApi, defineRpcContract, experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ACTIONS, type Action, type ActionArgs, type ActionResult } from "./actions.ts";
import { KEYS_CHANGED, type PublicKey, keysStateSchema } from "./envelope.ts";
import { type Keys, Refusal, createKeys } from "./keys.ts";

/** The whole of egg's interface: three methods, and only `signed` does anything for the person. */
export const rpcContract = defineRpcContract({
  /** The enrolled keys, the browsers that ask to be, the backend's clock, and where the reset file goes. Anyone may read it. */
  keys_state: { input: z.null(), output: keysStateSchema },
  /** A page presents its key. With none enrolled it is enrolled; otherwise it waits for an enrolled page. */
  key_enrol: {
    input: z.object({ key: z.unknown(), label: z.string().max(400) }),
    output: z.object({ outcome: z.enum(["enrolled-first", "enrolled", "pending", "refused"]), fingerprint: z.string() }),
  },
  /**
   * One of the person's actions, signed. The only way to any of them. The
   * input is checked by `keys.verify`, not here, so that a call with no
   * signature is told what it lacks instead of which field is missing.
   */
  signed: { input: z.unknown(), output: z.object({ result: z.unknown() }) },
});

const REFUSAL_CODES: Record<string, "conflict" | "forbidden" | "invalid" | "not_found"> = {
  unsigned: "forbidden",
  unknown_key: "forbidden",
  stale: "forbidden",
  replayed: "forbidden",
  bad_signature: "forbidden",
  request_not_found: "not_found",
  key_not_found: "not_found",
  too_many_keys: "conflict",
  too_many_requests: "conflict",
  last_key: "conflict",
};

async function refusing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof Refusal) throw new experimental_PluginRpcRefusal({ code: REFUSAL_CODES[cause.code] ?? "invalid", message: cause.message });
    throw cause;
  }
}

/** Whether `sig` is `key`'s signature of `text`, as a browser's WebCrypto makes one. */
export function verifyP256(key: PublicKey, text: string, sig: string): boolean {
  const signature = Buffer.from(sig, "base64url");
  if (signature.length !== 64) return false;
  return verifySignature("sha256", Buffer.from(text, "utf8"), { key: createPublicKey({ key, format: "jwk" }), dsaEncoding: "ieee-p1363" }, signature);
}

export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Carry out a verified action. `by` is the fingerprint of the key that signed it. */
export type Dispatch = { [A in Action]: (args: ActionArgs[A], by: string) => Promise<ActionResult[A]> };
/** The actions about keys are carried out here; the rest are egg's own. */
export type RoomDispatch = Omit<Dispatch, "key_approve" | "key_refuse" | "key_remove">;

/** Check a signed call and carry it out; refuse anything else. Nothing of the action is looked at before the signature is good. */
export async function runSigned(keys: Keys, dispatch: Dispatch, raw: unknown): Promise<unknown> {
  const { by, envelope } = await keys.verify(raw);
  if (!Object.hasOwn(ACTIONS, envelope.action)) throw new Refusal("bad_action", `there is no action ${envelope.action}`);
  const action = envelope.action as Action;
  const args = ACTIONS[action].input.safeParse(envelope.args);
  if (!args.success) throw new Refusal("bad_arguments", `the arguments of ${action} are not in the required form: ${args.error.issues[0]?.path.join(".") ?? ""} ${args.error.issues[0]?.message ?? ""}`.trim());
  return (dispatch[action] as (input: unknown, by: string) => Promise<unknown>)(args.data, by);
}

/** Where the reset file is looked for: under bb's data directory, outside every thread's storage. */
export const resetPathIn = (dataDir: string, plugin: string): string => join(dataDir, "plugins", plugin, "reset-enrollment");

export function registerSigning(bb: BbPluginApi, rooms: RoomDispatch): Keys {
  const changed = () => bb.realtime.publish(KEYS_CHANGED, {});
  const resetPath = resetPathIn(bb.server.experimental_dataDir, bb.pluginId);
  const keys = createKeys({
    kv: bb.storage.kv,
    plugin: bb.pluginId,
    now: Date.now,
    hash: sha256Hex,
    verify: verifyP256,
    resetPath,
    takeResetFile: async () => {
      try {
        const text = (await readFile(resetPath, "utf8")).slice(0, 200);
        await rm(resetPath);
        return text;
      } catch {
        // Not there, or not removable: either way enrolment stands. A file that cannot be removed would otherwise reset it for ever.
        return null;
      }
    },
    changed,
    log: (text) => bb.log.info(`signing: ${text}`),
  });

  const dispatch: Dispatch = {
    ...rooms,
    key_approve: (args, by) => keys.approve(args.fingerprint, by),
    key_refuse: async (args, by) => {
      await keys.refuse(args.fingerprint, by);
      return null;
    },
    key_remove: async (args, by) => {
      await keys.remove(args.fingerprint, by);
      return null;
    },
  };

  bb.rpc.register(rpcContract, {
    keys_state: () => keys.state(),
    key_enrol: ({ key, label }) => refusing(() => keys.enrol(key, label)),
    signed: async (envelope) => ({ result: (await refusing(() => runSigned(keys, dispatch, envelope))) ?? null }),
  });

  // The reset file is looked for when anything asks about keys, and every so often besides.
  const watch = setInterval(() => void keys.resetIfAsked().catch(() => undefined), 5000);
  bb.onDispose(() => clearInterval(watch));
  return keys;
}
