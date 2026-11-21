// THE LIST of what egg does for the person, and so only for a signed call:
// each action's name, the arguments it takes and what it gives back. Pure;
// the page signs against it and the backend checks against it.
//
// None of these is a method of egg's interface. There is one method,
// `signed`, and no unsigned way to any of them.

import { z } from "zod";
import { ledgerRecordSchema, roomSchema, roomSummarySchema, workspaceKindSchema } from "../model.ts";
import { enrolledKeySchema, fingerprintSchema } from "./envelope.ts";

const id = z.string().min(1).max(100);
const lineText = z.string().trim().min(1).max(4000);
const source = z.enum(["typed", "voice", "pasted"]);

export const ACTIONS = {
  // ---- What changes something, starts threads, or speaks as the person.

  /** A new room on a folder, and its first line: starts a round of threads on that folder. */
  room_create: {
    input: z.object({ folder: z.string().trim().min(1).max(2000), line: lineText, projectId: z.string().max(100).nullable(), source }),
    output: z.object({ room: roomSchema }),
  },
  /** A line from the person: starts a round (the planning step routes it to views, the room thread, or both). */
  say: { input: z.object({ roomId: id, text: lineText, source }), output: z.object({ roundId: z.string() }) },
  /** w: a line straight to the room thread, with no planning step. */
  work: { input: z.object({ roomId: id, text: lineText, source }), output: z.object({ lineId: z.string() }) },
  /** S then y: stop the room thread's turn and the runs it has open. */
  worker_stop: { input: z.object({ roomId: id }), output: z.object({ stopped: z.boolean() }) },
  /** m: four variations of a view along different axes. */
  more: { input: z.object({ roomId: id, viewId: id }), output: z.object({ roundId: z.string() }) },
  /** x: cross two views (A first). */
  cross: { input: z.object({ roomId: id, a: id, b: id }), output: z.object({ roundId: z.string() }) },
  /** z: a child room about one part of a view; its first round starts at once. */
  zoom: { input: z.object({ roomId: id, viewId: id, part: lineText, source }), output: z.object({ room: roomSchema }) },
  /** p: pin a view as context for the next lines, or with null unpin. */
  pin: { input: z.object({ roomId: id, viewId: id.nullable() }), output: z.object({ room: roomSchema }) },
  /** Keep (writes a file in the room's directory), drop, or with null undo either (removes the kept file). */
  decide: {
    input: z.object({ roomId: id, viewId: id, decision: z.enum(["kept", "dropped"]).nullable() }),
    output: z.object({ room: roomSchema }),
  },
  /** D in the room list: take a room out of egg and archive its threads (kept files stay on disk). */
  room_delete: { input: z.object({ roomId: id }), output: z.object({ deleted: z.boolean() }) },
  /** u in the room list: put a deleted room back. */
  room_restore: { input: z.object({ roomId: id }), output: z.object({ restored: z.boolean() }) },
  /** Something the page puts on the notebook as trouble, such as a failed transcription. It is the person's notebook. */
  note: { input: z.object({ roomId: id, text: lineText }), output: z.null() },
  /** Approve or refuse a browser that asks to be enrolled; remove an enrolled key or forget a refusal. */
  key_approve: { input: z.object({ fingerprint: fingerprintSchema }), output: enrolledKeySchema },
  key_refuse: { input: z.object({ fingerprint: fingerprintSchema }), output: z.null() },
  key_remove: { input: z.object({ fingerprint: fingerprintSchema }), output: z.null() },

  // ---- What only reads. Signed too: these hold the person's lines and every page.

  /** Where a new room reads by default, the rooms directory, and every bb project's checkouts to pick from. */
  defaults: {
    input: z.object({ projectId: z.string().max(100).nullable() }),
    output: z.object({
      folder: z.string().nullable(),
      hostId: z.string().nullable(),
      projectId: z.string().nullable(),
      roomsDir: z.string(),
      checkouts: z.array(z.object({ projectId: z.string(), name: z.string(), path: z.string() })),
    }),
  },
  rooms_list: { input: z.null(), output: z.object({ rooms: z.array(roomSummarySchema) }) },
  /** A whole room: every line, round and view record. */
  room_get: { input: z.object({ roomId: id }), output: z.object({ room: roomSchema.nullable() }) },
  /** One view's page. */
  view_content: {
    input: z.object({ roomId: id, viewId: id }),
    output: z.object({ format: z.enum(["html", "text"]), content: z.string() }).nullable(),
  },
  /** The room's runs as egg last synced them: each with the state egg owns. */
  ledger: { input: z.object({ roomId: id }), output: z.object({ entries: z.array(ledgerRecordSchema) }) },
  /** The room thread's status line, read from bb now; null when the room has none. */
  worker_status: {
    input: z.object({ roomId: id }),
    output: z
      .object({
        threadId: z.string(),
        state: z.enum(["starting", "running", "waiting on you", "failed", "idle", "gone"]),
        since: z.number(),
        step: z.string(),
        quietMs: z.number().nullable(),
        tokens: z.number().nullable(),
        workspace: z.string(),
        kind: workspaceKindSchema,
        ready: z.boolean(),
        ledger: z.number(),
        /** Runs whose process egg sees alive, and how long the oldest has run. */
        runsOpen: z.number(),
        longestOpenMs: z.number().nullable(),
        /** Ledger lines with no run record. */
        claimed: z.number(),
      })
      .nullable(),
  },
} as const satisfies Record<string, { input: z.ZodType; output: z.ZodType }>;

export type Action = keyof typeof ACTIONS;
export const ACTION_NAMES = Object.keys(ACTIONS) as Action[];
/** The actions that change nothing: they are signed because of what they show. */
export const READS: readonly Action[] = ["defaults", "rooms_list", "room_get", "view_content", "ledger", "worker_status"];

export type ActionArgs = { [A in Action]: z.infer<(typeof ACTIONS)[A]["input"]> };
export type ActionResult = { [A in Action]: z.infer<(typeof ACTIONS)[A]["output"]> };
