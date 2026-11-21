// Runs rounds against bb: the planning thread, four view threads, reading
// what each wrote and what it did, keeping and dropping, and archiving
// threads that are no longer on the table.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type ParentRef, type Room, type Round, type RoundKind, type View, parentRef } from "./model.ts";
import { removeKept, roomDir, slug, writeKept } from "./kept.ts";
import { builtFromCount, builtFromEvents, builtFromLedger, collectEvents, commandsRun, type EventRow, ledgerLine } from "./provenance.ts";
import { type PermissionMode, type RoomThreadSettings, createRoomThreads, readWorkerMark } from "./roomthread.ts";
import { type Angle, type Reference, type RoundSpec, fallbackFor, parseAngles, parseRoute, plannerPrompt, viewPrompt, viewThreadTitle } from "./rounds.ts";
import type { Route } from "./model.ts";
import {
  type Store,
  addLine,
  decide,
  findRound,
  findView,
  findViewRound,
  makeRoom,
  newId,
  addWorkLine,
  routeLine,
  setAngles,
  setPin,
  startRound,
  supersede,
  viewFinished,
  viewStarted,
} from "./store.ts";

export type { PermissionMode } from "./roomthread.ts";

export interface EngineSettings extends RoomThreadSettings {
  viewModel: string;
  plannerModel: string;
  /** The views' provider and permission mode. */
  providerId: string;
  permissionMode: PermissionMode;
  /** The planning step's provider and permission mode. */
  plannerProviderId: string;
  plannerPermissionMode: PermissionMode;
  roomsDir: string;
  titlePrefix: string;
}

/** Settings for tests and for any field a caller leaves out. */
export function engineSettings(partial: Partial<EngineSettings> & Pick<EngineSettings, "roomsDir">): EngineSettings {
  const providerId = partial.providerId ?? "claude-code";
  return {
    viewModel: "claude-sonnet-5-5",
    plannerModel: "claude-haiku-5-5",
    providerId,
    permissionMode: "auto",
    plannerProviderId: providerId,
    plannerPermissionMode: "auto",
    titlePrefix: "egg",
    roomThread: { providerId, model: "", permissionMode: "auto" },
    workspace: "auto",
    cloneProviderId: "cow-clone",
    materialMaxBytes: 20_000_000,
    wakeIntervalMs: 10 * 60_000,
    ...partial,
  };
}

/** What egg writes in its own metadata namespace on each thread it starts. */
export interface ThreadMark {
  roomId: string;
  roundId: string;
  viewId: string | null;
  role: "view" | "planner";
}

export function readMark(value: unknown): ThreadMark | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.roomId !== "string" || typeof v.roundId !== "string") return null;
  if (v.role !== "view" && v.role !== "planner") return null;
  return { roomId: v.roomId, roundId: v.roundId, viewId: typeof v.viewId === "string" ? v.viewId : null, role: v.role };
}

const PLANNER_TIMEOUT_MS = 90_000;

/** The notebook line once a round's angles are picked. */
export function plannedLine(kind: RoundKind, views: readonly View[], ms: number, route: Route = "look"): string {
  const took = `${Math.round(ms / 1000)} s`;
  if (route === "both") return `Both: to the room thread, and four angles in ${took}: ${views.map((v) => v.angle).join(" · ")}`;
  if (kind === "more") return `Four axes in ${took}: ${views.map((v) => `${v.axis ?? "?"} → ${v.angle}`).join(" · ")}`;
  if (kind === "cross") return `Two ways in ${took}: ${views.map((v) => `${v.axis ?? "?"} → ${v.angle}`).join(" · ")}`;
  return `Four angles in ${took}: ${views.map((v) => v.angle).join(" · ")}`;
}
/**
 * The notebook line once every view of a round has landed or failed: how
 * many landed and how long it took from the line, e.g. "4 views · 21 s".
 */
export function roundDoneLine(room: Room, round: Round, now: number): string {
  const views = round.viewIds.map((id) => room.views[id]).filter((v): v is View => v !== undefined);
  const done = views.filter((v) => v.status === "done").length;
  const count = done === views.length ? `${done} view${done === 1 ? "" : "s"}` : `${done} of ${views.length} views`;
  return `${count} · ${Math.round((now - round.at) / 1000)} s`;
}

/** Add the round's timing line if this change finished it. */
function noteIfRoundDone(room: Room, roundId: string, wasDone: boolean) {
  const round = findRound(room, roundId);
  if (wasDone || round.status !== "done") return;
  addLine(room, { kind: "did", text: roundDoneLine(room, round, Date.now()), roundId });
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);
const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

export interface EngineDeps {
  sdk: BbPluginApi["sdk"];
  store: Store;
  settings: () => Promise<EngineSettings>;
  publish: (roomId: string) => void;
  log: { info(m: string): void; warn(m: string): void };
  /** Waits between checks while bb makes a workspace; tests make it instant. */
  pause?: (ms: number) => Promise<void>;
  /** Process checks and stopping runs; tests replace them. */
  alive?: (pid: number) => boolean | null;
  kill?: (run: { pid?: number | undefined; pgid?: number | undefined }) => Promise<boolean>;
  now?: () => number;
}

export function createEngine(deps: EngineDeps) {
  const { sdk, store, publish, log } = deps;
  /** Views being finished right now, so an event and a reconcile do not both finish one. */
  const finishing = new Set<string>();
  const roomThreads = createRoomThreads({ sdk, store, settings: deps.settings, publish, log, note: (roomId, kind, text) => note(roomId, kind, text), ...(deps.pause ? { pause: deps.pause } : {}), ...(deps.alive ? { alive: deps.alive } : {}), ...(deps.kill ? { kill: deps.kill } : {}), ...(deps.now ? { now: deps.now } : {}) });

  async function archiveThread(threadId: string) {
    await sdk.threads.stop({ threadId }).catch(() => undefined);
    await sdk.threads.archive({ threadId }).catch((e) => log.warn(`archive ${threadId} failed: ${errText(e)}`));
  }

  function environmentFor(room: Room) {
    if (room.environmentId) return { type: "reuse" as const, environmentId: room.environmentId };
    return {
      type: "host" as const,
      hostId: room.hostId,
      workspace: { type: "unmanaged" as const, path: room.folder },
    };
  }

  /** Room id to the environment its folder turned out to belong to. */
  const learned = new Map<string, { environmentId: string; projectId: string }>();

  /**
   * Spawn a thread on the room's folder. A folder that is already one of
   * bb's environments (a project checkout or worktree) must be reused, not
   * opened again: learn which and remember it on the room.
   */
  async function spawnOn(room: Room, args: Omit<Parameters<typeof sdk.threads.spawn>[0], "environment" | "projectId"> & { prompt: string }) {
    const known = learned.get(room.id);
    const target = known ? { ...room, environmentId: known.environmentId, projectId: known.projectId } : room;
    try {
      return await sdk.threads.spawn({ ...args, projectId: target.projectId, environment: environmentFor(target) } as Parameters<typeof sdk.threads.spawn>[0]);
    } catch (e) {
      const match = /belongs to environment (env_[A-Za-z0-9]+)/.exec(errText(e));
      if (!match || target.environmentId) throw e;
      const environmentId = match[1]!;
      let projectId = target.projectId;
      try {
        const env = (await sdk.environments.get({ environmentId })) as { projectId?: string };
        if (env.projectId) projectId = env.projectId;
      } catch {
        // keep the room's project
      }
      learned.set(room.id, { environmentId, projectId });
      await store.update(room.id, (r) => {
        r.environmentId = environmentId;
        r.projectId = projectId;
      });
      return sdk.threads.spawn({ ...args, projectId, environment: { type: "reuse", environmentId } } as Parameters<typeof sdk.threads.spawn>[0]);
    }
  }

  async function createRoom(input: { folder: string; hostId: string; projectId: string; environmentId?: string | null; line: string; source: "typed" | "voice" | "pasted" }) {
    const settings = await deps.settings();
    const id = newId("room");
    const room = makeRoom({
      id,
      subject: input.line,
      folder: input.folder,
      hostId: input.hostId,
      projectId: input.projectId,
      dir: roomDir(settings.roomsDir, input.line, id),
      now: Date.now(),
    });
    room.environmentId = input.environmentId ?? null;
    addLine(room, { kind: "did", text: `Room made: reads ${input.folder}; kept views go to ${room.dir}` });
    await store.put(room);
    await store.setLastFolder(input.folder, input.projectId).catch(() => undefined);
    const roundId = await say(room.id, input.line, input.source);
    return { room: (await store.get(room.id))!, roundId };
  }

  /** A line from the person: start a round for it. Returns the round id at once; the round runs on. */
  async function say(roomId: string, text: string, source: "typed" | "voice" | "pasted"): Promise<string> {
    return beginRound(roomId, { text, source, kind: "line", parents: [] });
  }

  /**
   * Start a round of any kind and let it run on. The room's pin (for a line
   * or zoom round) is added to its parents by startRound.
   */
  async function beginRound(
    roomId: string,
    input: { text: string; source: "typed" | "voice" | "pasted" | "key"; kind: RoundKind; parents: ParentRef[] },
  ): Promise<string> {
    const settings = await deps.settings();
    const { room, result } = await store.update(roomId, (r) =>
      startRound(r, { ...input, plannerModel: settings.plannerModel, deferSupersede: input.kind === "line" }),
    );
    publish(roomId);
    for (const view of result.superseded) if (view.threadId) void archiveThread(view.threadId);
    void (async () => {
      const spec = await specFor(room, result.round);
      await runRound(room, result.round.id, settings, spec);
    })().catch(async (e) => {
      log.warn(`round failed: ${errText(e)}`);
      await note(roomId, "trouble", `The round stopped: ${errText(e)}`, result.round.id).catch(() => undefined);
    });
    return result.round.id;
  }

  /** A parent view as quoted reference: its room, its round's line, and its content. */
  async function reference(ref: ParentRef, here: Room): Promise<Reference | null> {
    const room = ref.roomId === here.id ? here : await store.get(ref.roomId);
    const content = await store.getContent(ref.viewId);
    if (!content) return null;
    const round = room?.rounds.find((r) => r.id === ref.roundId);
    return {
      ...(ref.label ? { label: ref.label } : {}),
      angle: ref.angle,
      line: round?.line ?? "",
      round: ref.round,
      roomSubject: room?.subject ?? ref.roomSubject,
      format: content.format,
      content: content.content,
    };
  }

  async function specFor(room: Room, round: Round): Promise<RoundSpec> {
    const parents = round.parents ?? [];
    const main = parents.filter((p) => p.role !== "pinned").sort((a, b) => (a.label ?? "").localeCompare(b.label ?? ""));
    const pin = parents.find((p) => p.role === "pinned");
    const refs = (await Promise.all(main.map((p) => reference(p, room)))).filter((r): r is Reference => r !== null);
    return {
      kind: round.kind ?? "line",
      refs,
      pinned: pin ? await reference(pin, room) : null,
      nonce: randomUUID().replace(/-/g, "").slice(0, 16),
      material: await materialFor(room),
    };
  }

  /** The room thread's workspace and ledger, once it has one views can read. */
  async function materialFor(room: Room): Promise<RoundSpec["material"]> {
    const w = room.worker;
    if (!w || w.gone || !w.ready || !w.environmentId || !w.workspace) return null;
    const ledger = await store.getLedger(room.id);
    return { workspace: w.workspace, runs: ledger.map((e) => ledgerLine(e)) };
  }

  /** A done view in a room, or a plain-words error. */
  async function doneView(roomId: string, viewId: string): Promise<{ room: Room; view: View }> {
    const room = await store.get(roomId);
    if (!room) throw new Error("That room is gone.");
    const view = room.views[viewId];
    if (!view) throw new Error("That view is not in this room.");
    if (view.status !== "done") throw new Error(`"${view.angle}" has no view yet.`);
    return { room, view };
  }

  /** m: four variations of a view, each along a different named axis. */
  async function more(roomId: string, viewId: string): Promise<string> {
    const { room, view } = await doneView(roomId, viewId);
    return beginRound(roomId, { text: `more like "${view.angle}"`, source: "key", kind: "more", parents: [parentRef(room, view, "varied")] });
  }

  /** x: two views crossed, two different ways. A is the first marked. */
  async function cross(roomId: string, aId: string, bId: string): Promise<string> {
    if (aId === bId) throw new Error("Mark two different views to cross.");
    const a = await doneView(roomId, aId);
    const b = await doneView(roomId, bId);
    return beginRound(roomId, {
      text: `cross "${a.view.angle}" × "${b.view.angle}"`,
      source: "key",
      kind: "cross",
      parents: [parentRef(a.room, a.view, "crossed", "A"), parentRef(b.room, b.view, "crossed", "B")],
    });
  }

  /**
   * z: a child room on the same folder about one part of a view. Its first
   * round starts at once, with the view as quoted reference.
   */
  async function zoom(roomId: string, viewId: string, part: string, source: "typed" | "voice" | "pasted") {
    const { room: parent, view } = await doneView(roomId, viewId);
    const id = newId("room");
    const child = makeRoom({
      id,
      subject: part,
      folder: parent.folder,
      hostId: parent.hostId,
      projectId: parent.projectId,
      dir: join(parent.dir, `${slug(part)}-${id.replace(/^room_/, "").slice(0, 6)}`),
      now: Date.now(),
    });
    child.environmentId = parent.environmentId ?? null;
    child.parent = { roomId: parent.id, roomSubject: parent.subject, roundId: view.roundId, viewId: view.id, angle: view.angle };
    addLine(child, { kind: "did", text: `Zoomed in from "${view.angle}" in "${parent.subject}"; kept views go to ${child.dir}` });
    await store.put(child);
    await note(parent.id, "did", `Zoomed into "${part}" from "${view.angle}" → a child room`, view.roundId);
    const roundId = await beginRound(child.id, { text: part, source, kind: "zoom", parents: [parentRef(parent, view, "zoomed")] });
    return { room: (await store.get(child.id))!, roundId };
  }

  /** p: pin a view as context for the next lines, or (null) unpin. */
  async function pin(roomId: string, viewId: string | null) {
    if (viewId !== null) await doneView(roomId, viewId);
    const { room } = await store.update(roomId, (r) => setPin(r, viewId));
    publish(roomId);
    return room;
  }

  /** D in the room list: take the room out of egg and archive its threads. Kept files stay on disk. */
  async function deleteRoom(roomId: string) {
    let threads: string[] = [];
    try {
      const { result } = await store.update(roomId, (r) => supersede(r));
      threads = result.map((v) => v.threadId).filter((t): t is string => t !== null);
    } catch {
      return false;
    }
    const before = await store.get(roomId);
    if (before?.worker) await roomThreads.archive(before).catch(() => undefined);
    const removed = await store.remove(roomId);
    for (const t of threads) void archiveThread(t);
    publish(roomId);
    return removed !== null;
  }

  /** u in the room list: put a deleted room back. */
  async function restoreRoom(roomId: string) {
    const room = await store.restore(roomId);
    publish(roomId);
    return room;
  }

  async function note(roomId: string, kind: "did" | "trouble", text: string, roundId?: string) {
    await store.update(roomId, (r) => addLine(r, { kind, text, ...(roundId ? { roundId } : {}) }));
    publish(roomId);
  }

  async function plan(room: Room, roundId: string, settings: EngineSettings, spec: RoundSpec): Promise<{ angles: Angle[]; note: string | null; ms: number; route: Route }> {
    const round = findRound(room, roundId);
    const fallback = fallbackFor(spec.kind);
    const started = Date.now();
    let threadId: string | null = null;
    try {
      const thread = await spawnOn(room, {
        providerId: settings.plannerProviderId,
        model: settings.plannerModel,
        permissionMode: settings.plannerPermissionMode,
        title: `${settings.titlePrefix}: planning · ${room.subject.slice(0, 40)}`,
        visibility: "hidden",
        prompt: plannerPrompt(room, round.line, spec),
        pluginMetadata: { roomId: room.id, roundId, viewId: null, role: "planner" },
      });
      threadId = thread.id;
      await sdk.threads.wait({ threadId, status: "idle", timeoutMs: PLANNER_TIMEOUT_MS });
      const output = await sdk.threads.output({ threadId });
      const text = output.output ?? "";
      const route: Route = spec.kind === "line" ? parseRoute(text) : "look";
      const angles = parseAngles(text, spec.kind);
      if (angles === null) return { angles: fallback, note: route === "work" ? null : "The planning step gave no usable angles; egg used its own spread.", ms: Date.now() - started, route };
      const added = angles.filter((a) => fallback.includes(a)).length;
      const note = added > 0 ? `The planning step gave ${angles.length - added} distinct ${spec.kind === "line" || spec.kind === "zoom" ? "angles" : spec.kind === "more" ? "axes" : "ways"}; egg added ${added} of its own.` : null;
      return { angles, note, ms: Date.now() - started, route };
    } catch (e) {
      return { angles: fallback, note: `The planning step failed (${errText(e)}); egg used its own spread.`, ms: Date.now() - started, route: "look" };
    } finally {
      if (threadId) void archiveThread(threadId);
    }
  }

  async function runRound(room: Room, roundId: string, settings: EngineSettings, spec: RoundSpec) {
    const planned = await plan(room, roundId, settings, spec);
    if (planned.route === "work" || planned.route === "both") {
      const { result: line } = await store.update(room.id, (r) => {
        const said = routeLine(r, roundId, planned.route);
        if (planned.route === "work") addLine(r, { kind: "did", text: `To the room thread (routed in ${seconds(planned.ms)})` });
        return said;
      });
      publish(room.id);
      if (line) void roomThreads.send(room.id, line.text, line.id, planned.route === "both").catch((e) => note(room.id, "trouble", `The room thread: ${errText(e)}`));
      if (planned.route === "work") return;
    }
    const { room: updated, result: views } = await store.update(room.id, (r) => {
      const superseded = spec.kind === "line" ? supersede(r).filter((v) => v.roundId !== roundId) : [];
      for (const view of superseded) if (view.threadId) void archiveThread(view.threadId);
      const vs = setAngles(r, roundId, planned.angles, settings.viewModel, planned.note);
      if (planned.note) addLine(r, { kind: "trouble", text: planned.note, roundId });
      addLine(r, { kind: "did", text: plannedLine(spec.kind, vs, planned.ms, planned.route), roundId });
      return vs;
    });
    publish(room.id);
    const line = findRound(updated, roundId).line;
    await Promise.all(views.map((view) => startView(updated, roundId, line, view, settings, spec)));
    publish(room.id);
  }

  async function startView(room: Room, roundId: string, line: string, view: View, settings: EngineSettings, spec: RoundSpec) {
    const angle = { name: view.angle, focus: view.focus, ...(view.axis ? { axis: view.axis } : {}) };
    const base = {
      providerId: settings.providerId,
      model: settings.viewModel,
      permissionMode: settings.permissionMode,
      title: viewThreadTitle(settings.titlePrefix, view.angle, room.subject),
      visibility: "hidden" as const,
      pluginMetadata: { roomId: room.id, roundId, viewId: view.id, role: "view" },
    };
    try {
      let thread: { id: string } | null = null;
      let usedMaterial = false;
      const envId = room.worker?.environmentId;
      if (spec.material && envId) {
        try {
          thread = await sdk.threads.spawn({ ...base, projectId: room.projectId, prompt: viewPrompt(room, line, angle, spec), environment: { type: "reuse", environmentId: envId } } as Parameters<typeof sdk.threads.spawn>[0]);
          usedMaterial = true;
        } catch (e) {
          log.warn(`view in the room thread's environment: ${errText(e)}`);
        }
      }
      thread ??= await spawnOn(room, { ...base, prompt: viewPrompt(room, line, angle, { ...spec, material: null }) });
      const started = thread;
      await store.update(room.id, (r) => {
        const v = viewStarted(r, view.id, started.id, null);
        if (usedMaterial) v.ledger = [];
      });
    } catch (e) {
      await store.update(room.id, (r) => {
        const wasDone = findRound(r, roundId).status === "done";
        viewStarted(r, view.id, null, `Could not start: ${errText(e)}`);
        addLine(r, { kind: "trouble", text: `"${view.angle}" could not start: ${errText(e)}`, roundId });
        noteIfRoundDone(r, roundId, wasDone);
      });
    }
  }

  async function readViewFile(threadId: string): Promise<{ format: "html" | "text"; content: string; storageRoot: string } | { error: string; storageRoot: string | null }> {
    let location: { hostId: string; storageRootPath: string };
    try {
      location = await sdk.threads.storageLocation({ threadId });
    } catch (e) {
      return { error: `no thread storage (${errText(e)})`, storageRoot: null };
    }
    const root = location.storageRootPath.replace(/\/+$/, "");
    for (const [name, format] of [["view.html", "html"], ["view.txt", "text"]] as const) {
      try {
        const file = await sdk.files.read({ path: `${root}/${name}`, hostId: location.hostId });
        const content = file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
        return { format, content, storageRoot: root };
      } catch {
        // try the next name
      }
    }
    return { error: "the thread finished without writing a view", storageRoot: root };
  }

  /** The ledger ids a view says it rests on, from view.json in its storage. */
  async function readRestsOn(threadId: string, storageRoot: string | null): Promise<string[]> {
    if (!storageRoot) return [];
    try {
      const location = await sdk.threads.storageLocation({ threadId });
      const f = await sdk.files.read({ path: `${storageRoot}/view.json`, hostId: location.hostId });
      const text = f.contentEncoding === "base64" ? Buffer.from(f.content, "base64").toString("utf8") : f.content;
      const parsed = JSON.parse(text) as { ledger?: unknown };
      return Array.isArray(parsed.ledger) ? parsed.ledger.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 60)).slice(0, 100) : [];
    } catch {
      return [];
    }
  }

  async function workerEvents(threadId: string): Promise<EventRow[]> {
    try {
      return await collectEvents((page) => sdk.threads.events.list({ threadId, limit: "100", types: ["item/completed"], ...page }) as Promise<EventRow[]>, 100);
    } catch {
      return [];
    }
  }

  /** A view's thread went idle or failed: read what it wrote and what it did. */
  async function finishView(roomId: string, viewId: string, failure: string | null) {
    if (finishing.has(viewId)) return;
    finishing.add(viewId);
    try {
      const room = await store.get(roomId);
      if (!room) return;
      const view = room.views[viewId];
      if (!view || view.threadId === null || (view.status !== "running" && view.status !== "waiting")) return;
      const threadId = view.threadId;
      const file = await readViewFile(threadId);
      let events: EventRow[] = [];
      try {
        events = await collectEvents((page) =>
          sdk.threads.events.list({ threadId, limit: "100", types: ["item/completed"], ...page }) as Promise<EventRow[]>,
        );
      } catch (e) {
        log.warn(`events for ${threadId}: ${errText(e)}`);
      }
      const usedMaterial = view.ledger !== undefined && room.worker?.workspace;
      const folder = usedMaterial ? room.worker!.workspace : room.folder;
      let builtFrom = builtFromEvents(events, { folder, storageRoot: file.storageRoot });
      let ledgerIds: string[] | undefined;
      if (usedMaterial) {
        const named = await readRestsOn(threadId, file.storageRoot);
        const ledger = await store.getLedger(roomId);
        const ran = named.length ? commandsRun(await workerEvents(room.worker!.threadId)) : [];
        const fromLedger = builtFromLedger(named, ledger, ran, { folder, storageRoot: null });
        ledgerIds = fromLedger.ids;
        builtFrom = [...fromLedger.entries, ...builtFrom.filter((b) => !(b.kind === "wrote" && /view\.json/.test(b.what)))];
      }
      const error = "error" in file ? (failure ? `${failure}; ${file.error}` : file.error) : null;
      if ("content" in file) await store.putContent(viewId, { format: file.format, content: file.content });
      await store.update(roomId, (r) => {
        const wasDone = findRound(r, view.roundId).status === "done";
        const v = viewFinished(r, viewId, { format: "content" in file ? file.format : null, builtFrom, error });
        if (ledgerIds) v.ledger = ledgerIds;
        const took = v.startedAt ? seconds((v.finishedAt ?? Date.now()) - v.startedAt) : "?";
        addLine(r, error
          ? { kind: "trouble", text: `"${v.angle}" failed after ${took}: ${error}`, roundId: v.roundId }
          : { kind: "did", text: `"${v.angle}" landed in ${took} (${builtFromCount(builtFrom)})`, roundId: v.roundId });
        noteIfRoundDone(r, v.roundId, wasDone);
      });
      publish(roomId);
      void sdk.threads.stop({ threadId }).catch(() => undefined);
    } finally {
      finishing.delete(viewId);
    }
  }

  /** Thread lifecycle events from bb: route egg's view threads to finishView. */
  async function onThreadSettled(threadId: string, failure: string | null) {
    let mark: ThreadMark | null = null;
    try {
      const raw = await sdk.threads.getPluginMetadata({ threadId } as Parameters<typeof sdk.threads.getPluginMetadata>[0]);
      if (readWorkerMark(raw)) {
        if (failure) await roomThreadFailed(readWorkerMark(raw)!.roomId, threadId, failure);
        await roomThreads.settled(threadId);
        return;
      }
      mark = readMark(raw);
    } catch {
      return;
    }
    if (!mark || mark.role !== "view" || !mark.viewId) return;
    // Only the thread egg started for that view settles it: a thread that merely carries the view's mark does not.
    const room = await store.get(mark.roomId);
    if (room?.views[mark.viewId]?.threadId !== threadId) return;
    await finishView(mark.roomId, mark.viewId, failure);
  }

  /** Catch up on views whose thread settled while egg was not listening. */
  async function reconcile(roomId: string) {
    const room = await store.get(roomId);
    if (!room) return;
    const running = Object.values(room.views).filter((v) => v.status === "running" && v.threadId);
    await Promise.all(
      running.map(async (view) => {
        try {
          const thread = (await sdk.threads.get({ threadId: view.threadId! })) as { status?: string; archivedAt?: number | null };
          if (thread.status === "idle") await finishView(roomId, view.id, null);
          else if (thread.status === "error") await finishView(roomId, view.id, "the thread failed");
        } catch (e) {
          log.warn(`reconcile ${view.threadId}: ${errText(e)}`);
        }
      }),
    );
  }

  /** Keep, drop, or undo (null). Instant: files and archiving follow. */
  async function decideView(roomId: string, viewId: string, decision: "kept" | "dropped" | null) {
    const { room, result: before } = await store.update(roomId, (r) => decide(r, viewId, decision));
    const view = findView(room, viewId);
    const round = findViewRound(room, view);
    if (decision === "kept") {
      const content = await store.getContent(viewId);
      if (!content) {
        await store.update(roomId, (r) => decide(r, viewId, before));
        throw new Error("That view has nothing to keep yet.");
      }
      const path = await writeKept(room, round, view, content);
      await store.update(roomId, (r) => {
        findView(r, viewId).keptPath = path;
        addLine(r, { kind: "did", text: `Kept "${view.angle}" → ${path}`, roundId: round.id });
      });
    } else {
      if (before === "kept") {
        await removeKept(room, round, view);
        await store.update(roomId, (r) => {
          findView(r, viewId).keptPath = null;
        });
      }
      if (decision === "dropped") {
        await store.update(roomId, (r) => {
          addLine(r, { kind: "did", text: `Dropped "${view.angle}"`, roundId: round.id });
          const v = findView(r, viewId);
          if (v.threadId && !v.archived) v.archived = true;
        });
        if (view.threadId && !view.archived) void archiveThread(view.threadId);
      } else {
        await store.update(roomId, (r) => addLine(r, { kind: "did", text: `Undid ${before === "kept" ? "keep" : "drop"} of "${view.angle}"`, roundId: round.id }));
      }
    }
    publish(roomId);
    return (await store.get(roomId))!;
  }

  /** w: a line straight to the room thread, with no planning step and no round. */
  async function work(roomId: string, text: string, source: "typed" | "voice" | "pasted") {
    const { result: line } = await store.update(roomId, (r) => addWorkLine(r, text, source));
    publish(roomId);
    void roomThreads.send(roomId, text, line.id, false).catch((e) => note(roomId, "trouble", `The room thread: ${errText(e)}`));
    return line.id;
  }

  /** The room thread's turn failed: say so once, with bb's reason. */
  async function roomThreadFailed(roomId: string, threadId: string, failure: string) {
    const room = await store.get(roomId);
    if (room?.worker?.threadId !== threadId) return;
    await note(roomId, "trouble", `The room thread's turn failed: ${failure}`);
  }

  return {
    createRoom,
    say,
    work,
    more,
    cross,
    zoom,
    pin,
    deleteRoom,
    restoreRoom,
    note,
    finishView,
    onThreadSettled,
    reconcile,
    decideView,
    roomThread: { status: roomThreads.status, stop: roomThreads.stop, sync: roomThreads.sync, tick: roomThreads.tick, settled: roomThreads.settled, wake: roomThreads.wake },
  };
}
export type Engine = ReturnType<typeof createEngine>;
