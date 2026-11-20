// egg's data: rooms, the lines said in them, rounds of views, and what each
// view was built from. Shared by the server and the page; the schemas are
// the wire contract and the shape of what is stored.
import { z } from "zod";

export const ANGLES_PER_ROUND = 4;

const id = z.string().min(1).max(100);

/** One thing a view's thread did, read from its own event stream. */
export const builtFromSchema = z.object({
  /**
   * read: a file opened; search: a grep, glob or listing; command: a shell
   * command; wrote: a file changed; web: a fetch or search; tool: anything
   * else; ledger: a run the room thread recorded in its ledger, which the
   * view rests on.
   */
  kind: z.enum(["read", "search", "command", "wrote", "web", "tool", "ledger"]),
  /** The path, query or command, shortened for display; paths inside the folder are relative to it. */
  what: z.string().max(400),
  /** True when the thread wrote outside its own storage: the folder was meant to be read only. */
  outside: z.boolean().optional(),
  failed: z.boolean().optional(),
  /** A ledger entry egg cannot vouch for: claimed in the ledger with no run record. */
  unconfirmed: z.boolean().optional(),
  /** For a ledger entry: the run's id, so its state can be brought up to date. */
  run: z.string().max(60).optional(),
});
export type BuiltFrom = z.infer<typeof builtFromSchema>;

/**
 * Where a derived view came from: a view in some room's round. Recorded on
 * every view of a variation, cross, zoom or pinned round, and in kept JSON.
 */
export const parentRefSchema = z.object({
  roomId: id,
  roomSubject: z.string().max(4000),
  roundId: id,
  /** The round's number in its room. */
  round: z.number().int().min(1),
  viewId: id,
  angle: z.string().max(120),
  /** In a cross: which parent this was. */
  label: z.enum(["A", "B"]).optional(),
  /** How it was used: varied (more like this), crossed, zoomed from, pinned. */
  role: z.enum(["varied", "crossed", "zoomed", "pinned"]),
});
export type ParentRef = z.infer<typeof parentRefSchema>;

/**
 * line: a said line; more: variations of one view; cross: two views
 * crossed; zoom: a child room's first round; work: pages the room thread
 * put on the table.
 */
export const roundKindSchema = z.enum(["line", "more", "cross", "zoom", "work"]);
export type RoundKind = z.infer<typeof roundKindSchema>;

/** Where a line goes: look (four views), work (the room thread), or both. */
export const routeSchema = z.enum(["look", "work", "both"]);
export type Route = z.infer<typeof routeSchema>;

export const lineSchema = z.object({
  id,
  at: z.number(),
  /** said: the person's line; did: what egg did; trouble: something that went wrong, in plain words; note: a line from the room thread. */
  kind: z.enum(["said", "did", "trouble", "note"]),
  text: z.string().max(4000),
  /** How a said line came in. */
  /** key: started by a key (m, x) rather than words. */
  source: z.enum(["typed", "voice", "pasted", "key"]).optional(),
  roundId: id.optional(),
  /** For a said line: where it went. look: four views; work: the room thread; both. */
  route: routeSchema.optional(),
});
export type Line = z.infer<typeof lineSchema>;

export const viewSchema = z.object({
  id,
  roundId: id,
  /** Position in the round, 0 to 3. */
  slot: z.number().int().min(0),
  angle: z.string().max(120),
  /** A sentence on what the angle looks at, from the planning step. */
  focus: z.string().max(400),
  /** For a variation: the axis it varies along. For a cross: the way it combines the parents. */
  axis: z.string().max(120).optional(),
  /** The views it was derived from; empty or absent for a plain round. */
  parents: z.array(parentRefSchema).optional(),
  model: z.string().max(100),
  threadId: id.nullable(),
  status: z.enum(["waiting", "running", "done", "failed"]),
  /** html or text once done. */
  format: z.enum(["html", "text"]).nullable(),
  error: z.string().max(1000).nullable(),
  builtFrom: z.array(builtFromSchema),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  decision: z.enum(["kept", "dropped"]).nullable(),
  /** Where the kept file was written, when kept. */
  keptPath: z.string().nullable(),
  archived: z.boolean(),
  /** The ledger entries (ids) the view says it rests on, those that exist. */
  ledger: z.array(z.string().max(60)).max(100).optional(),
  /** For a page the room thread made: its file in .egg/views/. */
  file: z.string().max(200).optional(),
});
export type View = z.infer<typeof viewSchema>;

export const roundSchema = z.object({
  id,
  n: z.number().int().min(1),
  lineId: id,
  line: z.string().max(4000),
  at: z.number(),
  status: z.enum(["planning", "running", "done"]),
  plannerModel: z.string().max(100),
  kind: roundKindSchema.optional(),
  /** The views this round was derived from (absent for a plain line). */
  parents: z.array(parentRefSchema).optional(),
  /** Set when the planning step failed and egg used its own spread of angles. */
  planNote: z.string().max(500).nullable(),
  viewIds: z.array(id),
});
export type Round = z.infer<typeof roundSchema>;

/**
 * A run's state, owned by egg: started, running (its process is alive),
 * exited (with its status), died (its process gone and no exit recorded),
 * stopped (egg stopped it when the person stopped the room thread), or
 * claimed (a ledger line with no run record: the model's word only).
 */
export const runStateSchema = z.enum(["started", "running", "exited", "died", "stopped", "claimed"]);
export type RunState = z.infer<typeof runStateSchema>;

/** One run in the room's ledger, as egg built it from the run records and ledger lines. */
export const ledgerRecordSchema = z.object({
  id: z.string().max(60),
  at: z.string().max(40),
  for: z.string().max(300),
  command: z.string().max(1000),
  output: z.string().max(400),
  /** The exit status, only for a run egg saw exit. */
  exit: z.number().int().nullable(),
  /** Absent in ledgers kept before egg owned run states: read as claimed. */
  state: runStateSchema.optional(),
  startedMs: z.number().nullable().optional(),
  endedMs: z.number().nullable().optional(),
  pid: z.number().int().optional(),
  pgid: z.number().int().optional(),
});
export type LedgerRecord = z.infer<typeof ledgerRecordSchema>;

export const workspaceKindSchema = z.enum(["clone", "worktree", "in-place"]);

/** The room's long-lived working thread. */
export const workerSchema = z.object({
  threadId: id,
  environmentId: z.string().max(100).nullable(),
  kind: workspaceKindSchema,
  /** The workspace's path once bb has made it; empty before. */
  workspace: z.string().max(2000),
  startedAt: z.number(),
  /** It has answered its standing instructions and any saved material is back. */
  ready: z.boolean(),
  /** Work lines said before it was ready, sent once it is. */
  pending: z.array(z.object({ text: z.string().max(4000), lineId: id, alsoLooking: z.boolean() })).max(50),
  /** How many lines of notes.jsonl have become notebook lines. */
  notesSeen: z.number().int().min(0),
  /** Each page in views/ seen so far, with the version (size:mtime) put on the table. */
  viewsSeen: z.record(z.string(), z.string()),
  /** Files over the size limit already said in a note, with the size that was said. */
  skippedSeen: z.record(z.string(), z.number()),
  /** Work lines sent to it since it started. */
  sent: z.number().int().min(0),
  /** Its workspace is gone (environment destroyed or thread archived): the next work line starts a fresh one. */
  gone: z.boolean(),
  /** When material was last copied out. */
  syncedAt: z.number().nullable(),
  /** Finished runs the thread was told about (or that ended while it worked). */
  told: z.array(z.string().max(60)).max(1000).optional(),
  /** Runs whose finish is already a notebook line, with the state said. */
  noted: z.record(z.string(), z.string()).optional(),
  /** Runs egg stopped because the person stopped the thread. */
  stoppedRuns: z.array(z.string().max(60)).max(1000).optional(),
  /** The person stopped it: egg wakes it for nothing until their next line. */
  held: z.boolean().optional(),
  /** When egg last woke it about its runs. */
  wokeAt: z.number().nullable().optional(),
});
export type Worker = z.infer<typeof workerSchema>;

export const roomSchema = z.object({
  id,
  subject: z.string().max(4000),
  folder: z.string().max(2000),
  hostId: z.string().max(100),
  projectId: z.string().max(100),
  /** Set when the folder is already one of bb's environments: threads reuse it. */
  environmentId: z.string().max(100).nullable().optional(),
  /** The room's directory on disk, where kept views are written. */
  dir: z.string().max(2000),
  createdAt: z.number(),
  updatedAt: z.number(),
  lines: z.array(lineSchema),
  rounds: z.array(roundSchema),
  views: z.record(z.string(), viewSchema),
  /** A child room: made by zooming into a part of a view in another room. */
  parent: z
    .object({ roomId: id, roomSubject: z.string().max(4000), roundId: id, viewId: id, angle: z.string().max(120) })
    .nullable()
    .optional(),
  /** The view pinned as context for the next lines, if any. */
  pin: parentRefSchema.nullable().optional(),
  /** The room thread, once a line has been routed to work. */
  worker: workerSchema.nullable().optional(),
  /** Earlier room threads whose workspace went away, oldest first. */
  pastWorkers: z.array(id).max(50).optional(),
});
export type Room = z.infer<typeof roomSchema>;

export const roomSummarySchema = z.object({
  id,
  subject: z.string(),
  folder: z.string(),
  updatedAt: z.number(),
  rounds: z.number(),
  kept: z.number(),
  parentRoomId: z.string().nullable(),
});
export type RoomSummary = z.infer<typeof roomSummarySchema>;

export function summarize(room: Room): RoomSummary {
  return {
    id: room.id,
    subject: room.subject,
    folder: room.folder,
    updatedAt: room.updatedAt,
    rounds: room.rounds.length,
    kept: Object.values(room.views).filter((v) => v.decision === "kept").length,
    parentRoomId: room.parent?.roomId ?? null,
  };
}

/** The views of a round, in slot order. */
export function roundViews(room: Room, round: Round): View[] {
  return round.viewIds.map((vid) => room.views[vid]).filter((v): v is View => v !== undefined);
}

/** Every kept view in the room, oldest first. */
export function keptViews(room: Room): View[] {
  return room.rounds.flatMap((r) => roundViews(room, r)).filter((v) => v.decision === "kept");
}

/** A reference to a view, for the views derived from it. */
export function parentRef(room: Room, view: View, role: ParentRef["role"], label?: "A" | "B"): ParentRef {
  const round = room.rounds.find((r) => r.id === view.roundId);
  return {
    roomId: room.id,
    roomSubject: room.subject,
    roundId: view.roundId,
    round: round?.n ?? 1,
    viewId: view.id,
    angle: view.angle,
    ...(label ? { label } : {}),
    role,
  };
}

/**
 * Rooms in list order: most recent first, each child room right under its
 * parent, one level deeper. A room whose parent is gone is at the top level.
 */
export function roomTree(rooms: readonly RoomSummary[]): { room: RoomSummary; depth: number }[] {
  const ids = new Set(rooms.map((r) => r.id));
  const children = new Map<string, RoomSummary[]>();
  const roots: RoomSummary[] = [];
  const byRecent = [...rooms].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const r of byRecent) {
    if (r.parentRoomId && ids.has(r.parentRoomId) && r.parentRoomId !== r.id) {
      const list = children.get(r.parentRoomId) ?? [];
      list.push(r);
      children.set(r.parentRoomId, list);
    } else roots.push(r);
  }
  const out: { room: RoomSummary; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (r: RoomSummary, depth: number) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push({ room: r, depth });
    for (const c of children.get(r.id) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  // A cycle of parents (should never happen) still shows every room.
  for (const r of byRecent) walk(r, 0);
  return out;
}
