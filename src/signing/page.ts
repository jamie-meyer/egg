// The page's signing key: made once in this browser, kept in its IndexedDB
// with the private half not extractable, enrolled with egg's backend, and
// used to sign every call the page makes for the person.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { Action, ActionArgs, ActionResult } from "./actions.ts";
import type { rpcContract } from "./backend.ts";
import { KEYS_CHANGED, TOO_MANY_WAITING, type KeyRequest, type KeysState, type PageStatus, type PublicKey, type SigningRefusalCode, fingerprintText, formatFingerprint, notEnrolledShort, notEnrolledText, refusalInWords, signedText, signingRefusalIn } from "./envelope.ts";

/** A call that was not carried out for a reason of signing: this page's key, or the call's signature. */
export class SigningRefusal extends Error {
  /** Null when this page never sent it: its key is not enrolled. */
  readonly code: SigningRefusalCode | null;
  /** Where this page stood when it could not sign. */
  readonly status: PageStatus;
  constructor(code: SigningRefusalCode | null, message: string, status: PageStatus = "enrolled") {
    super(message);
    this.code = code;
    this.status = status;
  }
  /** For the notebook: what was not done, and why, in the person's words. */
  inWords(what: string): string {
    return this.code === null ? `${what}: ${notEnrolledShort(this.status)}` : refusalInWords(this.code, what);
  }
}

export type Call = <A extends Action>(action: A, args: ActionArgs[A]) => Promise<ActionResult[A]>;

export interface Signer {
  status: PageStatus;
  /** This page's key, as shown. */
  fingerprint: string | null;
  /** Why this page can do nothing; empty when it can. */
  why: string;
  /** Browsers that ask to be enrolled, oldest first: for an enrolled page to approve or refuse. */
  requests: KeyRequest[];
  /** Make one of the person's calls, signed. Waits for the key to be read; rejects with a SigningRefusal when this page's key is not enrolled. */
  call: Call;
}

interface Held {
  privateKey: CryptoKey;
  publicKey: PublicKey;
  fingerprint: string;
}

const STORE = "keys";

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("the browser's storage could not be opened"));
  });
}
const stored = <T,>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    const request = run(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("the browser's storage failed"));
  });

const hex = (bytes: ArrayBuffer | Uint8Array): string => [...new Uint8Array(bytes as ArrayBuffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const base64url = (bytes: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The name of the browser database that holds the key for one installed copy of egg. */
export const keyDatabase = (plugin: string): string => `${plugin}-signing`;

/**
 * This browser's key for this installed egg: the one it has, or a new one.
 * The private half cannot be exported, by this page or any other code. Every
 * plugin's page shares bb's address, so each installed copy of egg keeps a
 * key of its own, in a database named after it.
 */
async function loadKey(plugin: string): Promise<Held> {
  if (typeof indexedDB === "undefined" || !globalThis.crypto?.subtle) throw new Error("no key store");
  const db = await openDb(keyDatabase(plugin));
  let pair = await stored<{ privateKey: CryptoKey; publicKey: PublicKey } | undefined>(db, "readonly", (store) => store.get("page"));
  if (!pair) {
    const made = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", made.publicKey);
    pair = { privateKey: made.privateKey, publicKey: { kty: "EC", crv: "P-256", x: jwk.x ?? "", y: jwk.y ?? "" } };
    await stored(db, "readwrite", (store) => store.put(pair, "page"));
    // Another tab may have made one in the same moment: whichever is stored is the browser's key.
    pair = (await stored<typeof pair>(db, "readonly", (store) => store.get("page"))) ?? pair;
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprintText(pair.publicKey)));
  return { ...pair, fingerprint: formatFingerprint(hex(digest)) };
}

/** What this page calls itself when it asks to be enrolled: its browser and system, in a few words. */
function pageLabel(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const browser = /Electron/.test(ua) ? "bb's desktop app" : /HeadlessChrome/.test(ua) ? "headless Chrome" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "a browser";
  const system = /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return system ? `${browser} on ${system}` : browser;
}

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

interface Live {
  held: Held | null;
  status: PageStatus;
  /** This browser's key could not even be put on the list of those waiting: it asks again. */
  crowded: boolean;
  plugin: string;
  resetPath: string;
}

export function useSigner(): Signer {
  const rpc = useRpc<typeof rpcContract>();
  const [held, setHeld] = useState<Held | null>(null);
  const [status, setStatus] = useState<PageStatus>("loading");
  const [keys, setKeys] = useState<KeysState | null>(null);
  /** The backend's clock minus this page's. */
  const offset = useRef(0);
  // What a call reads at the moment it is made, set as soon as it is known and not a render later.
  const live = useRef<Live>({ held: null, status: "loading", crowded: false, plugin: "", resetPath: "" });
  const [crowded, setCrowded] = useState(false);
  /** Resolved once this page knows whether it is enrolled: calls made before then wait for it. */
  const settled = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  if (settled.current === null) {
    let resolve = () => {};
    const promise = new Promise<void>((done) => (resolve = done));
    settled.current = { promise, resolve };
  }

  const settle = useCallback((next: PageStatus) => {
    live.current.status = next;
    setStatus(next);
    if (next !== "loading") settled.current?.resolve();
  }, []);

  /** Read who is enrolled; read or make this browser's key; and when it is not enrolled, ask to be. */
  const refresh = useCallback(async () => {
    const state = await rpc.call("keys_state");
    offset.current = state.now - Date.now();
    live.current.plugin = state.plugin;
    live.current.resetPath = state.resetPath;
    setKeys(state);
    let mine = live.current.held;
    if (mine === null) {
      try {
        mine = await loadKey(state.plugin);
      } catch {
        return settle("unavailable");
      }
      live.current.held = mine;
      setHeld(mine);
    }
    const fingerprint = mine.fingerprint;
    const full = (is: boolean) => {
      live.current.crowded = is;
      setCrowded(is);
    };
    if (state.keys.some((entry) => entry.fingerprint === fingerprint)) return full(false), settle("enrolled");
    let outcome: "enrolled-first" | "enrolled" | "pending" | "refused";
    try {
      outcome = (await rpc.call("key_enrol", { key: mine.publicKey, label: pageLabel() })).outcome;
    } catch (cause) {
      if (!errorText(cause).includes(TOO_MANY_WAITING)) throw cause;
      // The list of keys waiting is full: say so, and keep asking.
      full(true);
      return settle("pending");
    }
    full(false);
    settle(outcome === "pending" ? "pending" : outcome === "refused" ? "refused" : "enrolled");
  }, [rpc, settle]);
  const refreshing = useRef<Promise<void> | null>(null);
  const reload = useCallback(() => {
    // One at a time: two at once could both ask to be enrolled.
    refreshing.current = (refreshing.current ?? Promise.resolve()).then(refresh, refresh).catch(() => undefined);
    return refreshing.current;
  }, [refresh]);
  useEffect(() => {
    void reload();
    // bb may not be answering yet when the page opens: keep asking until this page knows where it stands.
    const again = setInterval(() => {
      if (live.current.status === "loading" || live.current.crowded) void reload();
    }, 3000);
    return () => clearInterval(again);
  }, [reload]);
  useRealtime(KEYS_CHANGED, () => void reload());

  const call = useCallback<Call>(
    async (action, args) => {
      await settled.current?.promise;
      const send = async () => {
        const { held: mine, status: now, plugin, resetPath } = live.current;
        if (mine === null || now !== "enrolled") throw new SigningRefusal(null, notEnrolledText(now, mine?.fingerprint ?? null, resetPath), now);
        const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
        const signed = { action, args, at: Date.now() + offset.current, nonce };
        const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, mine.privateKey, new TextEncoder().encode(signedText(plugin, signed)));
        try {
          return (await rpc.call("signed", { ...signed, key: mine.fingerprint, sig: base64url(sig) })).result as ActionResult[typeof action];
        } catch (cause) {
          const code = signingRefusalIn(errorText(cause));
          throw code === null ? cause : new SigningRefusal(code, errorText(cause));
        }
      };
      try {
        return await send();
      } catch (cause) {
        // egg restarted, this page's clock drifted, or enrolment was reset: read where this page stands and sign once more.
        if (!(cause instanceof SigningRefusal) || (cause.code !== "stale" && cause.code !== "unknown_key")) throw cause;
        await reload();
        return send();
      }
    },
    [rpc, reload],
  );

  const why = notEnrolledText(status, held?.fingerprint ?? null, keys?.resetPath ?? "", crowded);
  const requests = useMemo(() => (status === "enrolled" ? (keys?.requests ?? []).filter((entry) => entry.status === "pending") : []), [status, keys]);
  return useMemo(() => ({ status, fingerprint: held?.fingerprint ?? null, why, requests, call }), [status, held, why, requests, call]);
}
