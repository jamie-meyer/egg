// The room thread against bb: starting it in a copy of the room's folder,
// sending it work lines, watching it, and syncing what it makes (notes,
// pages, the ledger) into the room, with a copy of its material kept in the
// room's directory so it outlives the workspace.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  LEDGER_FILE,
  MATERIAL_DIR,
  MAX_JSONL_BYTES,
  MAX_VIEW_BYTES,
  NOTES_FILE,
  VIEWS_DIR,
  copyOut,
  excludeFromGit,
  ledgerEntrySchema,
  listFiles,
  megabytes,
  mergeLedger,
  noteSchema,
  parseJsonl,
  readSmall,
  restore,
  stamp,
  viewFileKind,
  viewSidecarSchema,
} from "./material.ts";
import type { LedgerRecord, Room, Worker } from "./model.ts";
import { type EventRow, builtFromThreadPage, collectEvents, commandsRun } from "./provenance.ts";
import { type WorkerStatus, deriveWorker, toActivity } from "./status.ts";
import { type Store, type ThreadPage, addLine, startWorkRound } from "./store.ts";
import { standingInstructions, workMessage } from "./worker.ts";
import { type Candidate, type WorkspaceFacts, type WorkspaceKind, type WorkspaceSetting, noWorkspaceLine, workspaceCandidates, workspaceWords } from "./workspace.ts";

export type PermissionMode = "auto" | "accept-edits" | "full";

/** Provider, model and permission mode for one role. An empty model means the provider's default. */
export interface RoleSettings {
  providerId: string;
  model: string;
  permissionMode: PermissionMode;
}

export interface RoomThreadSettings {
  roomThread: RoleSettings;
  workspace: WorkspaceSetting;
  cloneProviderId: string;
  /** Files in .egg/ larger than this are not copied out. */
  materialMaxBytes: number;
  titlePrefix: string;
}

/** What egg writes in its metadata namespace on the room thread. */
export interface WorkerMark {
  roomId: string;
  role: "room-thread";
}
export function readWorkerMark(value: unknown): WorkerMark | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return v.role === "room-thread" && typeof v.roomId === "string" ? { roomId: v.roomId, role: "room-thread" } : null;
}

/** Where the room's material is kept on disk. */
export const materialDir = (room: Room) => join(room.dir, "material");

/** How long a page must have been still before it is put on the table (it may be half written). */
export const SETTLED_FILE_MS = 2000;
/** How long egg waits for bb to make the workspace. */
const PROVISION_TIMEOUT_MS = 5 * 60_000;
/** At most this many notes become notebook lines in one sync; the rest are counted. */
const NOTES_PER_SYNC = 30;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = promisify(execFile);

export interface RoomThreadDeps {
  sdk: BbPluginApi["sdk"];
  store: Store;
  settings: () => Promise<RoomThreadSettings>;
  publish: (roomId: string) => void;
  log: { info(m: string): void; warn(m: string): void };
  note: (roomId: string, kind: "did" | "trouble", text: string) => Promise<void>;
  /** Waits between checks while bb makes a workspace; tests make it instant. */
  pause?: (ms: number) => Promise<void>;
}

export interface SendResult {
  /** sent: delivered now; queued: bb queued it behind a running turn; pending: the thread is still starting; failed. */
  delivery: "sent" | "queued" | "pending" | "failed";
}

export function createRoomThreads(deps: RoomThreadDeps) {
  const { sdk, store, publish, log, note } = deps;
  const pause = deps.pause ?? sleep;
  const syncing = new Set<string>();
  const starting = new Set<string>();

  async function workspaceFacts(room: Room, s: RoomThreadSettings): Promise<WorkspaceFacts> {
    const git = await lstat(join(room.folder, ".git")).catch(() => null);
    let cloneListed = false;
    try {
      const providers = (await sdk.environments.listProviders()) as { id: string }[];
      cloneListed = providers.some((p) => p.id === s.cloneProviderId);
    } catch {
      cloneListed = false;
    }
    let projectCheckout = false;
    if (room.environmentId) {
      try {
        const env = (await sdk.environments.get({ environmentId: room.environmentId })) as { path?: string | null; isWorktree?: boolean };
        projectCheckout = env.path === room.folder && env.isWorktree !== true;
      } catch {
        projectCheckout = false;
      }
    }
    if (!projectCheckout) {
      try {
        const project = (await sdk.projects.get({ projectId: room.projectId })) as { sources?: { path?: string }[] };
        projectCheckout = (project.sources ?? []).some((src) => src.path === room.folder);
      } catch {
        projectCheckout = false;
      }
    }
    return { cloneProviderId: s.cloneProviderId, cloneListed, isGitRepo: git !== null, gitIsFile: git?.isFile() ?? false, projectCheckout };
  }

  function environmentFor(room: Room, kind: WorkspaceKind, s: RoomThreadSettings) {
    if (kind === "clone")
      return { type: "provider" as const, environmentProviderId: s.cloneProviderId, inputs: { source: room.folder, bring: [] }, machine: { type: "existing" as const, hostId: room.hostId } };
    if (kind === "worktree") return { type: "host" as const, hostId: room.hostId, workspace: { type: "managed-worktree" as const, baseBranch: { kind: "default" as const } } };
    if (room.environmentId) return { type: "reuse" as const, environmentId: room.environmentId };
    return { type: "host" as const, hostId: room.hostId, workspace: { type: "unmanaged" as const, path: room.folder } };
  }

  /** Why a thread failed, from its newest system error. */
  async function failureOf(threadId: string): Promise<string> {
    try {
      const rows = (await sdk.threads.events.list({ threadId, order: "desc", limit: "5", types: ["system/error", "system/thread-provisioning"] })) as { data?: Record<string, unknown> }[];
      for (const row of rows) {
        const d = row.data ?? {};
        const text = [d.message, d.error, (d.error as Record<string, unknown> | undefined)?.message, d.detail].find((v): v is string => typeof v === "string" && v.trim() !== "");
        if (text) return text.replace(/\s+/g, " ").slice(0, 300);
      }
    } catch {
      // fall through
    }
    return "bb could not make the workspace";
  }

  /**
   * Wait until bb has made the thread's workspace: its environment is set
   * and has a path, or the thread failed.
   */
  async function provisioned(threadId: string): Promise<{ environmentId: string; path: string } | { error: string }> {
    const until = Date.now() + PROVISION_TIMEOUT_MS;
    while (Date.now() < until) {
      let thread: { status?: string; environmentId?: string | null } | null = null;
      try {
        thread = (await sdk.threads.get({ threadId })) as { status?: string; environmentId?: string | null };
      } catch (e) {
        return { error: errText(e) };
      }
      if (thread.status === "error") return { error: await failureOf(threadId) };
      if (thread.environmentId) {
        try {
          const env = (await sdk.environments.get({ environmentId: thread.environmentId })) as { path?: string | null; status?: string };
          if (env.path) return { environmentId: thread.environmentId, path: env.path };
          if (env.status === "error" || env.status === "failed") return { error: await failureOf(threadId) };
        } catch {
          // not readable yet
        }
      }
      await pause(1500);
    }
    return { error: "bb took more than five minutes to make the workspace" };
  }

  /**
   * Start a room thread for the room: try each way the setting allows, in
   * order, and say in the notebook why any was not available. Never falls
   * back to the folder itself unless the setting is in-place.
   */
  async function start(roomId: string, first: { text: string; lineId: string; alsoLooking: boolean }): Promise<Worker | null> {
    const s = await deps.settings();
    const room = await store.get(roomId);
    if (!room) return null;
    const facts = await workspaceFacts(room, s);
    const candidates: Candidate[] = workspaceCandidates(s.workspace, facts);
    const tried: { kind: WorkspaceKind; why: string }[] = [];
    const hasSaved = (await lstat(materialDir(room)).catch(() => null))?.isDirectory() ?? false;
    for (const candidate of candidates) {
      if (!candidate.ok) {
        tried.push({ kind: candidate.kind, why: candidate.why });
        continue;
      }
      const kind = candidate.kind;
      await note(roomId, "did", `Starting the room thread in ${workspaceWords(kind)} ${room.folder}${kind === "in-place" ? " (the Workspace setting is in-place)" : ""}…`);
      let threadId: string;
      try {
        const thread = await sdk.threads.spawn({
          projectId: room.projectId,
          providerId: s.roomThread.providerId,
          ...(s.roomThread.model ? { model: s.roomThread.model } : {}),
          permissionMode: s.roomThread.permissionMode,
          title: `${s.titlePrefix}: room thread · ${room.subject.replace(/\s+/g, " ").slice(0, 60)}`.slice(0, 120),
          visibility: "visible",
          prompt: standingInstructions({ subject: room.subject, folder: room.folder, workspace: "your current working directory", kind, restored: hasSaved }),
          pluginMetadata: { roomId, role: "room-thread" },
          environment: environmentFor(room, kind, s),
        } as Parameters<typeof sdk.threads.spawn>[0]);
        threadId = thread.id;
      } catch (e) {
        tried.push({ kind, why: errText(e) });
        await note(roomId, "trouble", `The room thread could not start in ${workspaceWords(kind)} the folder: ${errText(e)}`);
        continue;
      }
      const worker: Worker = {
        threadId,
        environmentId: null,
        kind,
        workspace: "",
        startedAt: Date.now(),
        ready: false,
        pending: [{ text: first.text, lineId: first.lineId, alsoLooking: first.alsoLooking }],
        notesSeen: 0,
        viewsSeen: {},
        skippedSeen: {},
        sent: 0,
        gone: false,
        syncedAt: null,
      };
      await store.update(roomId, (r) => {
        if (r.worker && r.worker.threadId !== threadId) r.pastWorkers = [...(r.pastWorkers ?? []), r.worker.threadId].slice(-50);
        // Lines said while it was starting go with it.
        const before = r.worker && !r.worker.ready ? r.worker.pending : [];
        worker.pending = [...before.filter((p) => p.lineId !== first.lineId), ...worker.pending].slice(-50);
        r.worker = worker;
      });
      publish(roomId);
      const made = await provisioned(threadId);
      if ("error" in made) {
        tried.push({ kind, why: made.error });
        await note(roomId, "trouble", `${kind === "clone" ? "A copy-on-write clone" : kind === "worktree" ? "A git worktree" : "The folder"} is not available: ${made.error}`);
        await sdk.threads.archive({ threadId }).catch(() => undefined);
        await store.update(roomId, (r) => {
          if (r.worker?.threadId === threadId) r.worker = { ...r.worker, gone: true };
        });
        continue;
      }
      await store.update(roomId, (r) => {
        if (r.worker?.threadId !== threadId) return;
        r.worker.environmentId = made.environmentId;
        r.worker.workspace = made.path;
        addLine(r, { kind: "did", text: `The room thread works in ${made.path}` });
      });
      publish(roomId);
      // Its first turn (the standing instructions) may already be over.
      void settled(threadId);
      return (await store.get(roomId))?.worker ?? null;
    }
    await note(roomId, "trouble", noWorkspaceLine(s.workspace, tried));
    await store.update(roomId, (r) => {
      if (r.worker && !r.worker.ready) r.worker = { ...r.worker, gone: true, pending: [] };
    });
    publish(roomId);
    return null;
  }

  /** Is the worker's thread alive and its workspace still there? */
  async function alive(worker: Worker): Promise<boolean> {
    if (worker.gone) return false;
    try {
      const thread = (await sdk.threads.get({ threadId: worker.threadId })) as { archivedAt?: number | null; deletedAt?: number | null };
      if (thread.archivedAt || thread.deletedAt) return false;
    } catch {
      return false;
    }
    if (worker.workspace && !(await lstat(worker.workspace).catch(() => null))) return false;
    return true;
  }

  async function markGone(roomId: string, threadId: string, why: string) {
    let changed = false;
    await store.update(roomId, (r) => {
      if (r.worker?.threadId === threadId && !r.worker.gone) {
        r.worker = { ...r.worker, gone: true };
        addLine(r, { kind: "trouble", text: `The room thread's workspace is gone (${why}). Its material is saved in ${materialDir(r)}; the next work line starts a fresh room thread with it.` });
        changed = true;
      }
    });
    if (changed) publish(roomId);
  }

  /** A work line: to the room thread now, or once it is ready, or to a fresh one. */
  async function send(roomId: string, text: string, lineId: string, alsoLooking: boolean): Promise<SendResult> {
    const room = await store.get(roomId);
    if (!room) return { delivery: "failed" };
    const worker = room.worker ?? null;
    if (worker && !worker.gone && !worker.ready) {
      await store.update(roomId, (r) => {
        if (r.worker && !r.worker.ready) r.worker.pending = [...r.worker.pending, { text, lineId, alsoLooking }].slice(-50);
        addLine(r, { kind: "did", text: "→ to the room thread: it is still starting; this goes to it as soon as it is ready" });
      });
      publish(roomId);
      return { delivery: "pending" };
    }
    if (worker && !worker.gone && (await alive(worker))) return deliver(roomId, worker, { text, lineId, alsoLooking });
    if (worker && !worker.gone) await markGone(roomId, worker.threadId, "its thread or workspace is no longer there");
    if (starting.has(roomId)) {
      await store.update(roomId, (r) => {
        if (r.worker && !r.worker.ready) r.worker.pending = [...r.worker.pending, { text, lineId, alsoLooking }].slice(-50);
      });
      return { delivery: "pending" };
    }
    starting.add(roomId);
    try {
      const made = await start(roomId, { text, lineId, alsoLooking });
      return { delivery: made ? "pending" : "failed" };
    } finally {
      starting.delete(roomId);
    }
  }

  async function deliver(roomId: string, worker: Worker, line: { text: string; lineId: string; alsoLooking: boolean }): Promise<SendResult> {
    let busy = false;
    try {
      const thread = (await sdk.threads.get({ threadId: worker.threadId })) as { status?: string };
      busy = ["active", "starting", "stopping", "pending"].includes(thread.status ?? "");
    } catch {
      busy = false;
    }
    try {
      const res = (await sdk.threads.send({
        threadId: worker.threadId,
        mode: "steer-if-active",
        input: [{ type: "text", text: workMessage(line.text, { firstSince: worker.sent === 0, alsoLooking: line.alsoLooking }) }],
      } as Parameters<typeof sdk.threads.send>[0])) as { delivery?: string };
      const queued = res.delivery === "queued";
      await store.update(roomId, (r) => {
        if (r.worker?.threadId === worker.threadId) r.worker.sent += 1;
        addLine(r, {
          kind: "did",
          text: queued ? "→ queued for the room thread, behind its running turn (it shows in its chat)" : busy ? "→ sent to the room thread while it works: added to its running turn" : "→ sent to the room thread",
        });
      });
      publish(roomId);
      return { delivery: queued ? "queued" : "sent" };
    } catch (e) {
      await note(roomId, "trouble", `Could not send that to the room thread: ${errText(e)}`);
      return { delivery: "failed" };
    }
  }

  /**
   * The room thread finished a turn (or bb says it is idle). The first time,
   * make its workspace ready: keep .egg/ out of git, put saved material back,
   * then send the lines that waited. Every time, sync.
   */
  async function settled(threadId: string) {
    let mark: WorkerMark | null = null;
    try {
      mark = readWorkerMark(await sdk.threads.getPluginMetadata({ threadId } as Parameters<typeof sdk.threads.getPluginMetadata>[0]));
    } catch {
      return;
    }
    if (!mark) return;
    const room = await store.get(mark.roomId);
    const worker = room?.worker;
    if (!room || !worker || worker.threadId !== threadId) return;
    if (!worker.ready && worker.workspace) {
      let status = "";
      try {
        status = ((await sdk.threads.get({ threadId })) as { status?: string }).status ?? "";
      } catch {
        return;
      }
      if (status !== "idle") return;
      await prepare(room, worker);
    }
    await sync(mark.roomId);
  }

  async function prepare(room: Room, worker: Worker) {
    const ws = worker.workspace;
    const lines: string[] = [];
    try {
      const { stdout } = await run("git", ["-C", ws, "rev-parse", "--git-path", "info/exclude"], { timeout: 10_000 });
      const path = stdout.trim();
      if (path) {
        const full = isAbsolute(path) ? path : resolve(ws, path);
        if (await excludeFromGit(full)) lines.push(`${MATERIAL_DIR}/ is kept out of git with ${full}`);
      }
    } catch {
      // not a git repository: nothing to exclude from
    }
    try {
      const back = await restore(materialDir(room), join(ws, MATERIAL_DIR));
      if (back.restored > 0) lines.push(`Put ${back.restored} saved file${back.restored === 1 ? "" : "s"} of material back into its workspace from ${materialDir(room)}`);
    } catch (e) {
      lines.push(`Could not put the saved material back: ${errText(e)}`);
    }
    const { result: pending } = await store.update(room.id, (r) => {
      if (r.worker?.threadId !== worker.threadId || r.worker.ready) return [];
      for (const text of lines) addLine(r, { kind: "did", text });
      r.worker.ready = true;
      const waiting = r.worker.pending;
      r.worker.pending = [];
      return waiting;
    });
    publish(room.id);
    // Send what waited, in order.
    for (const line of pending) {
      const current = (await store.get(room.id))?.worker;
      if (!current || current.threadId !== worker.threadId) break;
      await deliver(room.id, current, line);
    }
  }

  /**
   * Bring the room up to date with the room thread's material: new notes
   * become notebook lines, new pages become cards in a round of their own,
   * the ledger is kept with the room, and .egg/ is copied out to the room's
   * directory (files over the size limit skipped and said).
   */
  async function sync(roomId: string): Promise<void> {
    if (syncing.has(roomId)) return;
    syncing.add(roomId);
    try {
      const s = await deps.settings();
      const room = await store.get(roomId);
      const worker = room?.worker;
      if (!room || !worker || worker.gone || !worker.workspace) return;
      const root = join(worker.workspace, MATERIAL_DIR);
      if (!(await lstat(worker.workspace).catch(() => null))) {
        await markGone(roomId, worker.threadId, "its workspace folder was removed");
        return;
      }
      const rootInfo = await lstat(root).catch(() => null);
      if (!rootInfo?.isDirectory()) return;

      // Notes.
      const notesFile = await readSmall(join(root, NOTES_FILE), MAX_JSONL_BYTES);
      const notes = notesFile ? parseJsonl(notesFile.content, noteSchema).items : [];
      const seen = notes.length < worker.notesSeen ? 0 : worker.notesSeen;
      const fresh = notes.slice(seen);

      // The ledger.
      const ledgerFile = await readSmall(join(root, LEDGER_FILE), MAX_JSONL_BYTES);
      const ledger: LedgerRecord[] = ledgerFile ? mergeLedger(parseJsonl(ledgerFile.content, ledgerEntrySchema).items) : [];
      if (ledgerFile) await store.putLedger(roomId, ledger);

      // Pages.
      const now = Date.now();
      const { files } = await listFiles(join(root, VIEWS_DIR), 500);
      const pages: (ThreadPage & { stamp: string; content: string })[] = [];
      const tooBig: string[] = [];
      let workerRan: string[] | null = null;
      for (const file of files) {
        if (file.path.includes("/")) continue;
        const kind = viewFileKind(file.path);
        if (!kind) continue;
        const version = stamp(file.size, file.mtimeMs);
        if (worker.viewsSeen[file.path] === version || now - file.mtimeMs < SETTLED_FILE_MS) continue;
        if (file.size > MAX_VIEW_BYTES) {
          tooBig.push(file.path);
          continue;
        }
        const body = await readSmall(join(root, VIEWS_DIR, file.path), MAX_VIEW_BYTES);
        if (!body) continue;
        let sidecar: { title?: string; focus?: string; ledger: string[] } = { ledger: [] };
        const side = await readSmall(join(root, VIEWS_DIR, `${kind.base}.json`), 20_000);
        if (side) {
          try {
            const parsed = viewSidecarSchema.safeParse(JSON.parse(side.content));
            if (parsed.success) sidecar = parsed.data;
          } catch {
            // a page with a broken sidecar still lands, named by its file
          }
        }
        if (workerRan === null) workerRan = await ranBy(worker.threadId);
        const built = builtFromThreadPage(sidecar.ledger, ledger, workerRan, { folder: worker.workspace, storageRoot: null });
        pages.push({
          file: file.path,
          title: sidecar.title || kind.base.replace(/[-_.]+/g, " ").slice(0, 60),
          focus: sidecar.focus ?? "",
          format: kind.format,
          ledger: built.ids,
          builtFrom: built.entries,
          model: "room thread",
          stamp: version,
          content: body.content,
        });
      }

      // Copy out.
      let copy: Awaited<ReturnType<typeof copyOut>> | null = null;
      try {
        copy = await copyOut(root, materialDir(room), s.materialMaxBytes);
      } catch (e) {
        log.warn(`copy out for ${roomId}: ${errText(e)}`);
      }

      const viewIds: { id: string; content: string; format: "html" | "text" }[] = [];
      await store.update(roomId, (r) => {
        const w = r.worker;
        if (!w || w.threadId !== worker.threadId) return;
        const shown = fresh.slice(-NOTES_PER_SYNC);
        if (fresh.length > shown.length) addLine(r, { kind: "note", text: `(${fresh.length - shown.length} earlier notes from the room thread are in ${MATERIAL_DIR}/${NOTES_FILE})` });
        for (const n of shown) addLine(r, { kind: "note", text: n.text });
        w.notesSeen = notes.length;
        if (pages.length) {
          const { views } = startWorkRound(r, pages, now);
          views.forEach((v, i) => viewIds.push({ id: v.id, content: pages[i]!.content, format: pages[i]!.format }));
          for (const p of pages) w.viewsSeen[p.file] = p.stamp;
        }
        for (const name of tooBig) {
          if (w.viewsSeen[name] === "too-big") continue;
          w.viewsSeen[name] = "too-big";
          addLine(r, { kind: "trouble", text: `The room thread's page ${MATERIAL_DIR}/${VIEWS_DIR}/${name} is over ${megabytes(MAX_VIEW_BYTES)}: not put on the table` });
        }
        for (const skip of copy?.skipped ?? []) {
          if (w.skippedSeen[skip.path] === skip.size) continue;
          w.skippedSeen[skip.path] = skip.size;
          addLine(r, { kind: "note", text: `Not saved to the room's directory: ${MATERIAL_DIR}/${skip.path} (${megabytes(skip.size)}, over the ${megabytes(s.materialMaxBytes)} limit)` });
        }
        if (copy?.truncated && !w.skippedSeen["(too many files)"]) {
          w.skippedSeen["(too many files)"] = 1;
          addLine(r, { kind: "trouble", text: `${MATERIAL_DIR}/ has more files than egg copies out; only the first ones are saved` });
        }
        if (copy) w.syncedAt = now;
      });
      for (const v of viewIds) await store.putContent(v.id, { format: v.format, content: v.content });
      if (fresh.length || pages.length || tooBig.length || copy?.skipped.length) publish(roomId);
    } catch (e) {
      log.warn(`sync ${roomId}: ${errText(e)}`);
    } finally {
      syncing.delete(roomId);
    }
  }

  /** The commands the room thread's own events show it ran. */
  async function ranBy(threadId: string): Promise<string[]> {
    try {
      const events = await collectEvents(
        (page) => sdk.threads.events.list({ threadId, limit: "100", types: ["item/completed"], ...page }) as Promise<EventRow[]>,
        100,
      );
      return commandsRun(events);
    } catch (e) {
      log.warn(`events for ${threadId}: ${errText(e)}`);
      return [];
    }
  }

  /** The status line's facts, read from bb now. */
  async function status(roomId: string): Promise<(WorkerStatus & { threadId: string; workspace: string; kind: WorkspaceKind; ready: boolean; ledger: number }) | null> {
    const room = await store.get(roomId);
    const worker = room?.worker;
    if (!room || !worker) return null;
    const now = Date.now();
    type Facts = { status?: string; hasPendingInteraction?: boolean; archivedAt?: number | null; deletedAt?: number | null };
    let thread: Facts | null = null;
    try {
      thread = (await sdk.threads.get({ threadId: worker.threadId })) as unknown as Facts;
    } catch {
      thread = null;
    }
    const facts = thread && !thread.deletedAt && !worker.gone ? { status: thread.status ?? "idle", hasPendingInteraction: thread.hasPendingInteraction === true, archivedAt: thread.archivedAt ?? null } : null;
    const read = async <T>(f: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await f();
      } catch {
        return fallback;
      }
    };
    const threadId = worker.threadId;
    const [turns, items, interactions, context] = facts
      ? await Promise.all([
          read(() => sdk.threads.events.list({ threadId, order: "desc", limit: "5", types: ["turn/started", "turn/completed"] }) as Promise<unknown[]>, []),
          read(() => sdk.threads.events.list({ threadId, order: "desc", limit: "1", types: ["item/started", "item/completed"] }) as Promise<unknown[]>, []),
          facts.hasPendingInteraction ? read(async () => toList(await sdk.threads.interactions.list({ threadId })), [] as unknown[]) : Promise.resolve([] as unknown[]),
          read(() => sdk.threads.context({ threadId }) as Promise<{ usage?: { usedTokens?: number } | null }>, null),
        ])
      : [[], [], [], null];
    const usedTokens = typeof context?.usage?.usedTokens === "number" ? context.usage.usedTokens : null;
    const derived = deriveWorker(facts, toActivity({ turns, items, interactions, usedTokens }), now, worker.startedAt);
    const ledger = (await store.getLedger(roomId)).length;
    return { ...derived, threadId, workspace: worker.workspace, kind: worker.kind, ready: worker.ready, ledger };
  }

  /** Stop the room thread's turn. It stays the room thread; the next line starts a new turn. */
  async function stop(roomId: string): Promise<boolean> {
    const room = await store.get(roomId);
    const worker = room?.worker;
    if (!room || !worker || worker.gone) return false;
    await sdk.threads.stop({ threadId: worker.threadId });
    await note(roomId, "did", "Stopped the room thread's turn. Its material stays; the next work line starts a new turn.");
    void sync(roomId);
    return true;
  }

  /** The room is deleted: a last sync, then archive the room thread (bb removes its clone after). */
  async function archive(room: Room) {
    const worker = room.worker;
    if (!worker) return;
    await sync(room.id).catch(() => undefined);
    await sdk.threads.stop({ threadId: worker.threadId }).catch(() => undefined);
    await sdk.threads.archive({ threadId: worker.threadId }).catch((e) => log.warn(`archive ${worker.threadId}: ${errText(e)}`));
  }

  /**
   * The slow timer: sync every room whose room thread is at work, and
   * notice a ready turn that ended while egg was not listening.
   */
  async function tick() {
    for (const room of await store.list()) {
      const worker = room.worker;
      if (!worker || worker.gone || !worker.workspace) continue;
      let busy = false;
      try {
        const thread = (await sdk.threads.get({ threadId: worker.threadId })) as { status?: string; archivedAt?: number | null };
        if (thread.archivedAt) {
          await markGone(room.id, worker.threadId, "its thread was archived");
          continue;
        }
        busy = ["active", "starting", "stopping", "pending"].includes(thread.status ?? "");
        if (!worker.ready && thread.status === "idle") {
          await settled(worker.threadId);
          continue;
        }
      } catch {
        continue;
      }
      if (busy || (worker.syncedAt ?? 0) < Date.now() - 10 * 60_000) await sync(room.id);
    }
  }

  return { send, start, sync, settled, status, stop, archive, tick, workspaceFacts };
}
export type RoomThreads = ReturnType<typeof createRoomThreads>;

function toList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    for (const key of ["interactions", "items", "pending"]) if (Array.isArray(v[key])) return v[key] as unknown[];
  }
  return [];
}
