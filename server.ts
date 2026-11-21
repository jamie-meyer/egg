// egg's backend: rooms in plugin storage, rounds of view threads, and the
// kept views written as plain files. The page talks to it over RPC and
// hears about changes on the "room-changed" realtime channel.
//
// bb serves a plugin's RPC to any local process, so nothing here is a method
// of its own: everything below is reached only through `signed`, with a
// signature from a browser enrolled with egg. See src/signing/ and
// docs/security.md.
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { type EngineSettings, type PermissionMode, createEngine } from "./src/engine.ts";
import { DEFAULT_ROOMS_DIR, DEFAULT_TITLE_PREFIX } from "./src/identity.ts";
import { expandHome } from "./src/kept.ts";
import { summarize } from "./src/model.ts";
import { registerSigning } from "./src/signing/backend.ts";
import { workspaceSetting } from "./src/workspace.ts";
import { createStore } from "./src/store.ts";

export const ROOM_CHANGED = "room-changed";
/** How often the room thread's material is synced while it works. */
const SYNC_EVERY_MS = 20_000;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    viewModel: {
      type: "string",
      label: "Model for views",
      description: "The model each of the four view threads runs on.",
      default: "claude-sonnet-5-5",
    },
    plannerModel: {
      type: "string",
      label: "Model for the planning step",
      description: "The model that picks four angles for each line. The fastest that works.",
      default: "claude-haiku-5-5",
    },
    providerId: {
      type: "string",
      label: "Agent provider for views",
      description: "The bb provider the view threads run on (and the planning step and room thread, unless set below).",
      default: "claude-code",
    },
    permissionMode: {
      type: "select",
      label: "Permission mode for view threads",
      description: "auto keeps bb's workspace sandbox; full bypasses it. Views are told to read only either way.",
      options: ["auto", "accept-edits", "full"],
      default: "auto",
    },
    plannerProviderId: {
      type: "string",
      label: "Agent provider for the planning step",
      description: "Empty: the same as for views.",
      default: "",
    },
    plannerPermissionMode: {
      type: "select",
      label: "Permission mode for the planning step",
      description: "The planning step is told to use no tools.",
      options: ["auto", "accept-edits", "full"],
      default: "auto",
    },
    roomThreadModel: {
      type: "string",
      label: "Model for the room thread",
      description: "The room thread builds and runs things for as long as it takes. Empty: the provider's default. Set it to the best model available to you.",
      default: "",
    },
    roomThreadProviderId: {
      type: "string",
      label: "Agent provider for the room thread",
      description: "Empty: the same as for views.",
      default: "",
    },
    roomThreadPermissionMode: {
      type: "select",
      label: "Permission mode for the room thread",
      description: "auto keeps bb's workspace sandbox (the room thread may write in its own workspace); full bypasses it.",
      options: ["auto", "accept-edits", "full"],
      default: "auto",
    },
    workspace: {
      type: "select",
      label: "Where the room thread works",
      description: "auto: a copy-on-write clone if available, else a git worktree, else it says so and stops. in-place: the folder itself.",
      options: ["auto", "clone", "worktree", "in-place"],
      experimental_optionLabels: { auto: "auto (clone, then worktree)", clone: "copy-on-write clone", worktree: "git worktree", "in-place": "the folder itself (in place)" },
      default: "auto",
    },
    cloneProviderId: {
      type: "string",
      label: "Copy-on-write environment provider",
      description: "The bb environment provider that makes clones, offered by another plugin when it is installed.",
      default: "cow-clone",
    },
    wakeMinutes: {
      type: "number",
      label: "Wake the room thread about open runs every (minutes)",
      description: "While the room thread has runs open and is idle, egg sends it a short message this often so it can read its logs and carry on; a run that finishes wakes it at once. Never after you stop it, until your next line.",
      default: 10,
    },
    materialMaxMb: {
      type: "number",
      label: "Largest material file copied out (MB)",
      description: "Each sync copies the room thread's .egg/ folder to the room's directory; files larger than this are skipped and said in a note.",
      default: 20,
    },
    roomsDir: {
      type: "string",
      label: "Rooms directory",
      description: "Each room gets a directory here; kept views are written into it as plain files.",
      default: DEFAULT_ROOMS_DIR,
    },
    holdToTalkKey: {
      type: "select",
      label: "Hold-to-talk key",
      description: "Hold this key (when no input is focused) to record a line; release to transcribe. Off turns voice recording off.",
      options: ["Space", "Backquote", "off"],
      experimental_optionLabels: { Space: "Space", Backquote: "` (backquote)", off: "Off" },
      default: "Space",
    },
    sendPastedAtOnce: {
      type: "boolean",
      label: "Send a pasted line at once",
      description: "A paste on the page (from a dictation app, say) is sent as a line without waiting for Enter.",
      default: false,
    },
    threadTitlePrefix: {
      type: "string",
      label: "Thread title prefix",
      description: "egg's hidden threads are titled '<prefix>: <angle> · <subject>'.",
      default: DEFAULT_TITLE_PREFIX,
    },
  });

  async function engineSettings(): Promise<EngineSettings> {
    const s = await settings.get();
    const mode = (value: string) => (["auto", "accept-edits", "full"].includes(value) ? value : "auto") as PermissionMode;
    const providerId = s.providerId.trim() || "claude-code";
    const mb = Number(s.materialMaxMb);
    return {
      viewModel: s.viewModel.trim() || "claude-sonnet-5-5",
      plannerModel: s.plannerModel.trim() || "claude-haiku-5-5",
      providerId,
      permissionMode: mode(s.permissionMode),
      plannerProviderId: s.plannerProviderId.trim() || providerId,
      plannerPermissionMode: mode(s.plannerPermissionMode),
      roomThread: { providerId: s.roomThreadProviderId.trim() || providerId, model: s.roomThreadModel.trim(), permissionMode: mode(s.roomThreadPermissionMode) },
      workspace: workspaceSetting(s.workspace),
      cloneProviderId: s.cloneProviderId.trim() || "cow-clone",
      materialMaxBytes: Math.round((Number.isFinite(mb) && mb > 0 ? mb : 20) * 1_000_000),
      wakeIntervalMs: Math.round((Number.isFinite(Number(s.wakeMinutes)) && Number(s.wakeMinutes) >= 1 ? Number(s.wakeMinutes) : 10) * 60_000),
      roomsDir: s.roomsDir.trim() || DEFAULT_ROOMS_DIR,
      titlePrefix: s.threadTitlePrefix.trim() || DEFAULT_TITLE_PREFIX,
    };
  }

  const store = createStore(bb.storage.kv);
  const engine = createEngine({
    sdk: bb.sdk,
    store,
    settings: engineSettings,
    publish: (roomId) => bb.realtime.publish(ROOM_CHANGED, { roomId }),
    log: bb.log,
  });

  async function primaryHostId(): Promise<string | null> {
    try {
      return (await bb.sdk.system.config()).primaryHostId ?? null;
    } catch {
      return null;
    }
  }

  async function projectCheckout(projectId: string | null) {
    if (!projectId) return null;
    try {
      const project = (await bb.sdk.projects.get({ projectId })) as { sources?: { path?: string; hostId?: string; isDefault?: boolean }[] };
      const sources = project.sources ?? [];
      const source = sources.find((s) => s.isDefault) ?? sources[0];
      return source?.path && source.hostId ? { folder: source.path, hostId: source.hostId, projectId } : null;
    } catch {
      return null;
    }
  }

  /** Any project will do for a folder outside every project: threads need one. */
  async function fallbackProjectId(): Promise<string | null> {
    try {
      const projects = (await bb.sdk.projects.list()) as { id: string }[];
      return projects[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  /** A plugin page has no current project: use the one the person worked in last. */
  async function recentProjectId(): Promise<string | null> {
    try {
      const threads = (await bb.sdk.threads.list({ limit: 50 })) as { projectId: string; updatedAt: number }[];
      const latest = [...threads].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      return latest?.projectId ?? (await fallbackProjectId());
    } catch {
      return fallbackProjectId();
    }
  }

  /**
   * Which bb project and environment a folder belongs to: an environment
   * whose workspace is the folder (a checkout or worktree), else a project
   * whose checkout contains it. Threads must run in that project.
   */
  async function owner(folder: string, hostId: string | null): Promise<{ projectId: string; environmentId: string | null } | null> {
    try {
      const envs = (await bb.sdk.environments.list({ path: folder, ...(hostId ? { hostId } : {}) })) as {
        id: string;
        projectId: string;
        path: string | null;
        lifecycle?: { phase?: string };
      }[];
      const env = envs.find((e) => e.path === folder && (e.lifecycle?.phase ?? "active") === "active");
      if (env) return { projectId: env.projectId, environmentId: env.id };
    } catch {
      // fall through to projects
    }
    try {
      const projects = (await bb.sdk.projects.list()) as { id: string; sources?: { path?: string }[] }[];
      const inside = (root: string) => folder === root || folder.startsWith(root.endsWith("/") ? root : `${root}/`);
      const match = projects
        .flatMap((p) => (p.sources ?? []).map((src) => ({ id: p.id, path: src.path ?? "" })))
        .filter((src) => src.path && inside(src.path))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (match) return { projectId: match.id, environmentId: null };
    } catch {
      // no match
    }
    return null;
  }

  /** Every bb project's checkouts (its local sources), default ones first. */
  async function checkouts(): Promise<{ projectId: string; name: string; path: string }[]> {
    try {
      const projects = (await bb.sdk.projects.list()) as { id: string; name?: string; sources?: { path?: string; isDefault?: boolean }[] }[];
      const out = projects.flatMap((p) =>
        [...(p.sources ?? [])]
          .sort((a, b) => Number(b.isDefault ?? false) - Number(a.isDefault ?? false))
          .filter((src) => typeof src.path === "string" && src.path.length > 0)
          .map((src) => ({ projectId: p.id, name: p.name ?? p.id, path: src.path! })),
      );
      const seen = new Set<string>();
      return out.filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true))).slice(0, 100);
    } catch {
      return [];
    }
  }

  // What egg does for the person. Each runs only for a verified signature: see registerSigning.
  registerSigning(bb, {
    defaults: async ({ projectId: given }) => {
      const last = await store.lastFolder();
      const projectId = given ?? last?.projectId ?? (await recentProjectId());
      const checkout = await projectCheckout(projectId);
      const s = await engineSettings();
      return {
        folder: last?.folder ?? checkout?.folder ?? null,
        hostId: checkout?.hostId ?? (await primaryHostId()),
        projectId: last ? (last.projectId ?? projectId) : (checkout?.projectId ?? projectId),
        roomsDir: expandHome(s.roomsDir),
        checkouts: await checkouts(),
      };
    },
    rooms_list: async () => ({ rooms: (await store.list()).map(summarize) }),
    room_create: async ({ folder, line, projectId: given, source: from }) => {
      const projectId = given ?? (await recentProjectId());
      const path = expandHome(folder);
      if (!isAbsolute(path)) throw new Error("The folder must be an absolute path.");
      const info = await stat(path).catch(() => null);
      if (!info?.isDirectory()) throw new Error(`There is no folder at ${path}.`);
      const checkout = await projectCheckout(projectId);
      const hostId = checkout?.hostId ?? (await primaryHostId());
      const owned = await owner(path, hostId);
      const project = owned?.projectId ?? projectId ?? (await fallbackProjectId());
      if (!hostId) throw new Error("bb has no machine to run views on.");
      if (!project) throw new Error("bb has no project to run views in.");
      const { room } = await engine.createRoom({ folder: path, hostId, projectId: project, environmentId: owned?.environmentId ?? null, line, source: from });
      return { room };
    },
    room_get: async ({ roomId }) => {
      const room = await store.get(roomId);
      if (room && Object.values(room.views).some((v) => v.status === "running")) void engine.reconcile(roomId);
      return { room };
    },
    say: async ({ roomId, text, source: from }) => ({ roundId: await engine.say(roomId, text, from) }),
    work: async ({ roomId, text, source: from }) => ({ lineId: await engine.work(roomId, text, from) }),
    worker_status: async ({ roomId }) => engine.roomThread.status(roomId),
    worker_stop: async ({ roomId }) => ({ stopped: await engine.roomThread.stop(roomId) }),
    ledger: async ({ roomId }) => ({ entries: await store.getLedger(roomId) }),
    more: async ({ roomId, viewId }) => ({ roundId: await engine.more(roomId, viewId) }),
    cross: async ({ roomId, a, b }) => ({ roundId: await engine.cross(roomId, a, b) }),
    zoom: async ({ roomId, viewId, part, source: from }) => ({ room: (await engine.zoom(roomId, viewId, part, from)).room }),
    pin: async ({ roomId, viewId }) => ({ room: await engine.pin(roomId, viewId) }),
    room_delete: async ({ roomId }) => ({ deleted: await engine.deleteRoom(roomId) }),
    room_restore: async ({ roomId }) => ({ restored: (await engine.restoreRoom(roomId)) !== null }),
    note: async ({ roomId, text }) => {
      await engine.note(roomId, "trouble", text);
      return null;
    },
    view_content: async ({ roomId, viewId }) => {
      const room = await store.get(roomId);
      if (!room?.views[viewId]) return null;
      return store.getContent(viewId);
    },
    decide: async ({ roomId, viewId, decision }) => ({ room: await engine.decideView(roomId, viewId, decision) }),
  });

  const ours = (thread: { originPluginId?: string | null }) =>
    thread.originPluginId === undefined || thread.originPluginId === null || thread.originPluginId === bb.pluginId;
  bb.events.on("thread.idle", ({ thread }) => {
    if (ours(thread as { originPluginId?: string | null })) void engine.onThreadSettled(thread.id, null);
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    if (ours(thread as { originPluginId?: string | null })) void engine.onThreadSettled(thread.id, error ?? "the thread failed");
  });

  // The slow timer: while a room thread works, its notes, pages and ledger
  // are synced into the room and its material copied out.
  bb.background.service("room-thread-sync", {
    async start(signal) {
      while (!signal.aborted) {
        await engine.roomThread.tick().catch((e) => bb.log.warn(`room thread sync: ${e instanceof Error ? e.message : String(e)}`));
        await new Promise<void>((done) => {
          const t = setTimeout(done, SYNC_EVERY_MS);
          signal.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
        });
      }
    },
  });
}
