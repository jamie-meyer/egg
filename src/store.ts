// Rooms in plugin storage: one record per room, plus one record per view's
// content. Every change to a room goes through `update`, which serialises
// changes to the same room so four views landing at once do not lose each
// other's writes.
import { randomUUID } from "node:crypto";
import {
  type BuiltFrom,
  type LedgerRecord,
  type Line,
  type ParentRef,
  type Room,
  type Route,
  type RoundKind,
  type Round,
  type View,
  ledgerRecordSchema,
  parentRef,
  roomSchema,
  roundViews,
} from "./model.ts";
import type { Angle } from "./rounds.ts";

export interface Kv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

const roomKey = (id: string) => `room:${id}`;
const contentKey = (viewId: string) => `content:${viewId}`;
const deletedKey = (id: string) => `deleted:${id}`;
const ledgerKey = (roomId: string) => `ledger:${roomId}`;
/** The ledger kept with a room: the newest entries, well under the store's value limit. */
export const MAX_STORED_LEDGER = 300;
const LAST_FOLDER = "meta:last-folder";
/** Deleted rooms are kept this long (for undo), then forgotten. */
const DELETED_KEEP_MS = 7 * 24 * 3600 * 1000;
/** A view's content is capped well under the store's 256 KB value limit. */
export const MAX_CONTENT = 200_000;

export interface ViewContent {
  format: "html" | "text";
  content: string;
}

export function createStore(kv: Kv) {
  const chains = new Map<string, Promise<unknown>>();

  async function get(roomId: string): Promise<Room | null> {
    const parsed = roomSchema.safeParse(await kv.get(roomKey(roomId)));
    return parsed.success ? parsed.data : null;
  }

  /** Apply `change` to the stored room, one change at a time per room. */
  function update<T>(roomId: string, change: (room: Room) => T): Promise<{ room: Room; result: T }> {
    const previous = chains.get(roomId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const room = await get(roomId);
      if (room === null) throw new Error(`No room ${roomId}`);
      const result = change(room);
      room.updatedAt = Date.now();
      await kv.set(roomKey(roomId), room);
      return { room, result };
    });
    chains.set(roomId, next.catch(() => undefined));
    return next;
  }

  return {
    get,
    update,
    async put(room: Room): Promise<void> {
      await kv.set(roomKey(room.id), room);
    },
    async list(): Promise<Room[]> {
      const keys = await kv.list("room:");
      const rooms = await Promise.all(keys.map((key) => get(key.slice("room:".length))));
      return rooms.filter((r): r is Room => r !== null).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    /** Take a room out of egg; it can be put back with `restore`. Its view contents stay. */
    async remove(roomId: string): Promise<Room | null> {
      const previous = chains.get(roomId) ?? Promise.resolve();
      const next = previous.then(async () => {
        const room = await get(roomId);
        if (room === null) return null;
        await kv.set(deletedKey(roomId), { at: Date.now(), room });
        await kv.delete(roomKey(roomId));
        return room;
      });
      chains.set(roomId, next.catch(() => undefined));
      const room = await next;
      // Forget rooms deleted long ago.
      const now = Date.now();
      for (const key of await kv.list("deleted:")) {
        const entry = await kv.get<{ at?: number }>(key);
        if (!entry || typeof entry.at !== "number" || now - entry.at > DELETED_KEEP_MS) await kv.delete(key);
      }
      return room;
    },
    async restore(roomId: string): Promise<Room | null> {
      const entry = await kv.get<{ room?: unknown }>(deletedKey(roomId));
      const parsed = roomSchema.safeParse(entry?.room);
      if (!parsed.success) return null;
      await kv.set(roomKey(roomId), parsed.data);
      await kv.delete(deletedKey(roomId));
      return parsed.data;
    },
    async lastFolder(): Promise<{ folder: string; projectId: string | null } | null> {
      const v = await kv.get<{ folder?: unknown; projectId?: unknown }>(LAST_FOLDER);
      return v && typeof v.folder === "string" ? { folder: v.folder, projectId: typeof v.projectId === "string" ? v.projectId : null } : null;
    },
    async setLastFolder(folder: string, projectId: string | null): Promise<void> {
      await kv.set(LAST_FOLDER, { folder, projectId });
    },
    async putContent(viewId: string, value: ViewContent): Promise<void> {
      await kv.set(contentKey(viewId), { format: value.format, content: value.content.slice(0, MAX_CONTENT) });
    },
    /** The room thread's ledger as last synced (its full copy is in the room's material directory). */
    async putLedger(roomId: string, entries: readonly LedgerRecord[]): Promise<void> {
      await kv.set(ledgerKey(roomId), entries.slice(-MAX_STORED_LEDGER));
    },
    async getLedger(roomId: string): Promise<LedgerRecord[]> {
      const value = await kv.get<unknown>(ledgerKey(roomId));
      const parsed = ledgerRecordSchema.array().safeParse(value);
      return parsed.success ? parsed.data : [];
    },
    async getContent(viewId: string): Promise<ViewContent | null> {
      const value = await kv.get<ViewContent>(contentKey(viewId));
      if (!value || typeof value.content !== "string") return null;
      return { format: value.format === "text" ? "text" : "html", content: value.content };
    },
  };
}
export type Store = ReturnType<typeof createStore>;

// Pure changes to a room. Each mutates the room it is given (inside `update`).

export function makeRoom(input: {
  id: string;
  subject: string;
  folder: string;
  hostId: string;
  projectId: string;
  dir: string;
  now: number;
}): Room {
  return {
    id: input.id,
    subject: input.subject,
    folder: input.folder,
    hostId: input.hostId,
    projectId: input.projectId,
    dir: input.dir,
    createdAt: input.now,
    updatedAt: input.now,
    lines: [],
    rounds: [],
    views: {},
  };
}

export function addLine(room: Room, line: Omit<Line, "id" | "at"> & { at?: number }): Line {
  const full: Line = { id: newId("ln"), at: line.at ?? Date.now(), ...line } as Line;
  room.lines.push(full);
  if (room.lines.length > 2000) room.lines.splice(0, room.lines.length - 2000);
  return full;
}

/**
 * A said line (or m, x, a zoom) starts a new round, which supersedes the one
 * before it. A plain line takes the room's pin, if any, as a parent.
 */
export function startRound(
  room: Room,
  input: {
    text: string;
    source: "typed" | "voice" | "pasted" | "key";
    plannerModel: string;
    kind?: RoundKind;
    parents?: ParentRef[];
    now?: number;
    /** Leave earlier rounds alone for now: a line's route is not known until its planning step answers. */
    deferSupersede?: boolean;
  },
): { round: Round; superseded: View[] } {
  const now = input.now ?? Date.now();
  const roundId = newId("rd");
  const kind = input.kind ?? "line";
  const parents = [...(input.parents ?? [])];
  if ((kind === "line" || kind === "zoom") && room.pin) parents.push({ ...room.pin, role: "pinned" });
  const line = addLine(room, { kind: "said", text: input.text, source: input.source, roundId, at: now });
  const pinned = parents.find((p) => p.role === "pinned");
  if (pinned) addLine(room, { kind: "did", text: `with pinned "${pinned.angle}" (round ${pinned.round}) as reference`, roundId, at: now });
  const superseded = input.deferSupersede ? [] : supersede(room);
  const round: Round = {
    id: roundId,
    n: room.rounds.length + 1,
    lineId: line.id,
    line: input.text,
    at: now,
    status: "planning",
    plannerModel: input.plannerModel,
    kind,
    ...(parents.length ? { parents } : {}),
    planNote: null,
    viewIds: [],
  };
  room.rounds.push(round);
  return { round, superseded };
}

/**
 * The planning step routed a line. Work only: its round is taken off the
 * table again (the earlier round shows as before), and the line stays in
 * the notebook, marked as sent to the room thread.
 */
export function routeLine(room: Room, roundId: string, route: Route): Line | null {
  const line = room.lines.find((l) => l.kind === "said" && l.roundId === roundId) ?? null;
  if (line) line.route = route;
  if (route === "work") {
    room.rounds = room.rounds.filter((r) => r.id !== roundId);
    for (const l of room.lines) if (l.roundId === roundId) delete l.roundId;
  }
  return line;
}

/** A line said straight to the room thread (no planning step, no round). */
export function addWorkLine(room: Room, text: string, source: "typed" | "voice" | "pasted", now = Date.now()): Line {
  return addLine(room, { kind: "said", text, source, route: "work", at: now });
}

/** A page the room thread put in .egg/views/, as it lands on the table. */
export interface ThreadPage {
  file: string;
  title: string;
  focus: string;
  format: "html" | "text";
  ledger: string[];
  builtFrom: BuiltFrom[];
  model: string;
}

/**
 * Pages from the room thread land in a round of their own kind. It is done
 * as it lands, and it supersedes nothing: views of a round still running
 * keep running.
 */
export function startWorkRound(room: Room, pages: readonly ThreadPage[], now = Date.now()): { round: Round; views: View[] } {
  const roundId = newId("rd");
  const names = pages.map((p) => `"${p.title}"`).join(", ");
  const line = addLine(room, { kind: "did", text: `The room thread put ${pages.length === 1 ? "a page" : `${pages.length} pages`} on the table: ${names}`.slice(0, 4000), roundId, at: now });
  const views = pages.map((page, slot): View => ({
    id: newId("vw"),
    roundId,
    slot,
    angle: page.title.slice(0, 120),
    focus: page.focus.slice(0, 400),
    model: page.model.slice(0, 100),
    threadId: null,
    status: "done",
    format: page.format,
    error: null,
    builtFrom: page.builtFrom,
    startedAt: now,
    finishedAt: now,
    decision: null,
    keptPath: null,
    archived: false,
    ledger: page.ledger,
    file: page.file.slice(0, 200),
  }));
  for (const view of views) room.views[view.id] = view;
  const round: Round = {
    id: roundId,
    n: room.rounds.length + 1,
    lineId: line.id,
    line: "from the room thread",
    at: now,
    status: "done",
    plannerModel: "",
    kind: "work",
    planNote: null,
    viewIds: views.map((v) => v.id),
  };
  room.rounds.push(round);
  return { round, views };
}

/** Views of earlier rounds whose threads should now be archived; marks them archived. */
export function supersede(room: Room): View[] {
  const out: View[] = [];
  for (const view of Object.values(room.views)) {
    if (!view.archived && view.threadId !== null) {
      view.archived = true;
      out.push(view);
    }
  }
  return out;
}

export function setAngles(room: Room, roundId: string, angles: readonly Angle[], model: string, planNote: string | null): View[] {
  const round = findRound(room, roundId);
  round.status = "running";
  round.planNote = planNote;
  const parents = round.parents ?? [];
  const views = angles.map((angle, slot): View => ({
    id: newId("vw"),
    roundId,
    slot,
    angle: angle.name,
    focus: angle.focus,
    ...(angle.axis ? { axis: angle.axis } : {}),
    ...(parents.length ? { parents: parents.map((p) => ({ ...p })) } : {}),
    model,
    threadId: null,
    status: "waiting",
    format: null,
    error: null,
    builtFrom: [],
    startedAt: null,
    finishedAt: null,
    decision: null,
    keptPath: null,
    archived: false,
  }));
  for (const view of views) room.views[view.id] = view;
  round.viewIds = views.map((v) => v.id);
  return views;
}

export function viewStarted(room: Room, viewId: string, threadId: string | null, error: string | null, now = Date.now()): View {
  const view = findView(room, viewId);
  view.threadId = threadId;
  view.startedAt = now;
  if (error !== null) {
    view.status = "failed";
    view.error = error;
    view.finishedAt = now;
  } else {
    view.status = "running";
  }
  settleRound(room, view.roundId);
  return view;
}

export function viewFinished(
  room: Room,
  viewId: string,
  outcome: { format: "html" | "text" | null; builtFrom: BuiltFrom[]; error: string | null },
  now = Date.now(),
): View {
  const view = findView(room, viewId);
  view.status = outcome.error === null && outcome.format !== null ? "done" : "failed";
  view.format = outcome.format;
  view.error = outcome.error;
  view.builtFrom = outcome.builtFrom;
  view.finishedAt = now;
  settleRound(room, view.roundId);
  return view;
}

function settleRound(room: Room, roundId: string) {
  const round = findRound(room, roundId);
  if (round.status === "planning") return;
  const views = roundViews(room, round);
  if (views.length > 0 && views.every((v) => v.status === "done" || v.status === "failed")) round.status = "done";
}

/** Keep, drop, or (null) undo either. Returns the decision it replaced. */
export function decide(room: Room, viewId: string, decision: "kept" | "dropped" | null): View["decision"] {
  const view = findView(room, viewId);
  const before = view.decision;
  view.decision = decision;
  return before;
}

/** Pin a view as context for the next lines, or (null) unpin. One pin at a time. */
export function setPin(room: Room, viewId: string | null): ParentRef | null {
  const before = room.pin ?? null;
  if (viewId === null) {
    room.pin = null;
    if (before) addLine(room, { kind: "did", text: `Unpinned "${before.angle}"` });
    return null;
  }
  const view = findView(room, viewId);
  const pin = parentRef(room, view, "pinned");
  room.pin = pin;
  addLine(room, { kind: "did", text: `Pinned "${view.angle}" (round ${pin.round}): the next lines get it as reference` });
  return pin;
}

export function findView(room: Room, viewId: string): View {
  const view = room.views[viewId];
  if (!view) throw new Error(`No view ${viewId} in room ${room.id}`);
  return view;
}

export function findRound(room: Room, roundId: string): Round {
  const round = room.rounds.find((r) => r.id === roundId);
  if (!round) throw new Error(`No round ${roundId} in room ${room.id}`);
  return round;
}

export function findViewRound(room: Room, view: View): Round {
  return findRound(room, view.roundId);
}
