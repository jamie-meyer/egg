// Runs rounds against bb: the planning thread, four view threads, reading
// what each wrote and what it did, keeping and dropping, and archiving
// threads that are no longer on the table.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Room, View } from "./model.ts";
import { removeKept, roomDir, writeKept } from "./kept.ts";
import { builtFromCount, builtFromEvents, collectEvents, type EventRow } from "./provenance.ts";
import { FALLBACK_ANGLES, parseAngles, plannerPrompt, viewPrompt, viewThreadTitle } from "./rounds.ts";
import {
  type Store,
  addLine,
  decide,
  findRound,
  findView,
  findViewRound,
  makeRoom,
  newId,
  setAngles,
  startRound,
  viewFinished,
  viewStarted,
} from "./store.ts";

export type PermissionMode = "auto" | "accept-edits" | "full";

export interface EngineSettings {
  viewModel: string;
  plannerModel: string;
  providerId: string;
  permissionMode: PermissionMode;
  roomsDir: string;
  titlePrefix: string;
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
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);
const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

export interface EngineDeps {
  sdk: BbPluginApi["sdk"];
  store: Store;
  settings: () => Promise<EngineSettings>;
  publish: (roomId: string) => void;
  log: { info(m: string): void; warn(m: string): void };
}

export function createEngine(deps: EngineDeps) {
  const { sdk, store, publish, log } = deps;
  /** Views being finished right now, so an event and a reconcile do not both finish one. */
  const finishing = new Set<string>();

  async function archiveThread(threadId: string) {
    await sdk.threads.stop({ threadId }).catch(() => undefined);
    await sdk.threads.archive({ threadId }).catch((e) => log.warn(`archive ${threadId} failed: ${errText(e)}`));
  }

  function environmentFor(room: Room) {
    return {
      type: "host" as const,
      hostId: room.hostId,
      workspace: { type: "unmanaged" as const, path: room.folder },
    };
  }

  async function createRoom(input: { folder: string; hostId: string; projectId: string; line: string; source: "typed" | "voice" | "pasted" }) {
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
    addLine(room, { kind: "did", text: `Room made: reads ${input.folder}; kept views go to ${room.dir}` });
    await store.put(room);
    const roundId = await say(room.id, input.line, input.source);
    return { room: (await store.get(room.id))!, roundId };
  }

  /** A line from the person: start a round for it. Returns the round id at once; the round runs on. */
  async function say(roomId: string, text: string, source: "typed" | "voice" | "pasted"): Promise<string> {
    const settings = await deps.settings();
    const { room, result } = await store.update(roomId, (r) =>
      startRound(r, { text, source, plannerModel: settings.plannerModel }),
    );
    publish(roomId);
    for (const view of result.superseded) if (view.threadId) void archiveThread(view.threadId);
    void runRound(room, result.round.id, settings).catch(async (e) => {
      log.warn(`round failed: ${errText(e)}`);
      await note(roomId, "trouble", `The round stopped: ${errText(e)}`, result.round.id).catch(() => undefined);
    });
    return result.round.id;
  }

  async function note(roomId: string, kind: "did" | "trouble", text: string, roundId?: string) {
    await store.update(roomId, (r) => addLine(r, { kind, text, ...(roundId ? { roundId } : {}) }));
    publish(roomId);
  }

  async function plan(room: Room, roundId: string, settings: EngineSettings) {
    const round = findRound(room, roundId);
    const started = Date.now();
    let threadId: string | null = null;
    try {
      const thread = await sdk.threads.spawn({
        projectId: room.projectId,
        environment: environmentFor(room),
        providerId: settings.providerId,
        model: settings.plannerModel,
        permissionMode: settings.permissionMode,
        title: `${settings.titlePrefix}: planning · ${room.subject.slice(0, 40)}`,
        visibility: "hidden",
        prompt: plannerPrompt(room, round.line),
        pluginMetadata: { roomId: room.id, roundId, viewId: null, role: "planner" },
      });
      threadId = thread.id;
      await sdk.threads.wait({ threadId, status: "idle", timeoutMs: PLANNER_TIMEOUT_MS });
      const output = await sdk.threads.output({ threadId });
      const text = output.output ?? "";
      const angles = parseAngles(text);
      if (angles === null) return { angles: [...FALLBACK_ANGLES], note: "The planning step gave no usable angles; egg used its own spread.", ms: Date.now() - started };
      return { angles, note: null, ms: Date.now() - started };
    } catch (e) {
      return { angles: [...FALLBACK_ANGLES], note: `The planning step failed (${errText(e)}); egg used its own spread.`, ms: Date.now() - started };
    } finally {
      if (threadId) void archiveThread(threadId);
    }
  }

  async function runRound(room: Room, roundId: string, settings: EngineSettings) {
    const planned = await plan(room, roundId, settings);
    const { room: updated, result: views } = await store.update(room.id, (r) => {
      const vs = setAngles(r, roundId, planned.angles, settings.viewModel, planned.note);
      addLine(r, {
        kind: planned.note ? "trouble" : "did",
        text: planned.note ?? `Four angles in ${seconds(planned.ms)}: ${vs.map((v) => v.angle).join(" · ")}`,
        roundId,
      });
      return vs;
    });
    publish(room.id);
    const line = findRound(updated, roundId).line;
    await Promise.all(views.map((view) => startView(updated, roundId, line, view, settings)));
    publish(room.id);
  }

  async function startView(room: Room, roundId: string, line: string, view: View, settings: EngineSettings) {
    try {
      const thread = await sdk.threads.spawn({
        projectId: room.projectId,
        environment: environmentFor(room),
        providerId: settings.providerId,
        model: settings.viewModel,
        permissionMode: settings.permissionMode,
        title: viewThreadTitle(settings.titlePrefix, view.angle, room.subject),
        visibility: "hidden",
        prompt: viewPrompt(room, line, { name: view.angle, focus: view.focus }),
        pluginMetadata: { roomId: room.id, roundId, viewId: view.id, role: "view" },
      });
      await store.update(room.id, (r) => viewStarted(r, view.id, thread.id, null));
    } catch (e) {
      await store.update(room.id, (r) => {
        viewStarted(r, view.id, null, `Could not start: ${errText(e)}`);
        addLine(r, { kind: "trouble", text: `"${view.angle}" could not start: ${errText(e)}`, roundId });
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
      const builtFrom = builtFromEvents(events, { folder: room.folder, storageRoot: file.storageRoot });
      const error = "error" in file ? (failure ? `${failure}; ${file.error}` : file.error) : null;
      if ("content" in file) await store.putContent(viewId, { format: file.format, content: file.content });
      await store.update(roomId, (r) => {
        const v = viewFinished(r, viewId, { format: "content" in file ? file.format : null, builtFrom, error });
        const took = v.startedAt ? seconds((v.finishedAt ?? Date.now()) - v.startedAt) : "?";
        addLine(r, error
          ? { kind: "trouble", text: `"${v.angle}" failed after ${took}: ${error}`, roundId: v.roundId }
          : { kind: "did", text: `"${v.angle}" landed in ${took} (${builtFromCount(builtFrom)})`, roundId: v.roundId });
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
      mark = readMark(await sdk.threads.getPluginMetadata({ threadId }));
    } catch {
      return;
    }
    if (!mark || mark.role !== "view" || !mark.viewId) return;
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

  return { createRoom, say, note, finishView, onThreadSettled, reconcile, decideView };
}
export type Engine = ReturnType<typeof createEngine>;
