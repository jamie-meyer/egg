// egg's backend: rooms in plugin storage, rounds of view threads, and the
// kept views written as plain files. The page talks to it over RPC and
// hears about changes on the "room-changed" realtime channel.
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { type EngineSettings, type PermissionMode, createEngine } from "./src/engine.ts";
import { DEFAULT_ROOMS_DIR, expandHome } from "./src/kept.ts";
import { roomSchema, roomSummarySchema, summarize } from "./src/model.ts";
import { createStore } from "./src/store.ts";

const id = z.string().min(1).max(100);
const lineText = z.string().trim().min(1).max(4000);
const source = z.enum(["typed", "voice", "pasted"]);

export const rpcContract = defineRpcContract({
  /** Where a new room reads by default: the current project's checkout. */
  defaults: {
    input: z.object({ projectId: z.string().max(100).nullable() }),
    output: z.object({
      folder: z.string().nullable(),
      hostId: z.string().nullable(),
      projectId: z.string().nullable(),
      roomsDir: z.string(),
    }),
  },
  rooms_list: { input: z.null(), output: z.object({ rooms: z.array(roomSummarySchema) }) },
  room_create: {
    input: z.object({ folder: z.string().trim().min(1).max(2000), line: lineText, projectId: z.string().max(100).nullable(), source }),
    output: z.object({ room: roomSchema }),
  },
  room_get: { input: z.object({ roomId: id }), output: z.object({ room: roomSchema.nullable() }) },
  /** A line from the person: starts a round. */
  say: { input: z.object({ roomId: id, text: lineText, source }), output: z.object({ roundId: z.string() }) },
  /** Something the page needs on the notebook, such as a failed transcription. */
  note: { input: z.object({ roomId: id, text: lineText }), output: z.null() },
  view_content: {
    input: z.object({ roomId: id, viewId: id }),
    output: z.object({ format: z.enum(["html", "text"]), content: z.string() }).nullable(),
  },
  /** Keep, drop, or with null undo either. */
  decide: {
    input: z.object({ roomId: id, viewId: id, decision: z.enum(["kept", "dropped"]).nullable() }),
    output: z.object({ room: roomSchema }),
  },
});

export const ROOM_CHANGED = "room-changed";

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
      label: "Agent provider",
      description: "The bb provider the planning and view threads run on.",
      default: "claude-code",
    },
    permissionMode: {
      type: "select",
      label: "Permission mode for view threads",
      description: "auto keeps bb's workspace sandbox; full bypasses it. Views are told to read only either way.",
      options: ["auto", "accept-edits", "full"],
      default: "auto",
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
      default: "egg",
    },
  });

  async function engineSettings(): Promise<EngineSettings> {
    const s = await settings.get();
    return {
      viewModel: s.viewModel.trim() || "claude-sonnet-5-5",
      plannerModel: s.plannerModel.trim() || "claude-haiku-5-5",
      providerId: s.providerId.trim() || "claude-code",
      permissionMode: (["auto", "accept-edits", "full"].includes(s.permissionMode) ? s.permissionMode : "auto") as PermissionMode,
      roomsDir: s.roomsDir.trim() || DEFAULT_ROOMS_DIR,
      titlePrefix: s.threadTitlePrefix.trim() || "egg",
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

  bb.rpc.register(rpcContract, {
    defaults: async ({ projectId }) => {
      const checkout = await projectCheckout(projectId);
      const s = await engineSettings();
      return {
        folder: checkout?.folder ?? null,
        hostId: checkout?.hostId ?? (await primaryHostId()),
        projectId: checkout?.projectId ?? projectId,
        roomsDir: expandHome(s.roomsDir),
      };
    },
    rooms_list: async () => ({ rooms: (await store.list()).map(summarize) }),
    room_create: async ({ folder, line, projectId, source: from }) => {
      const path = expandHome(folder);
      if (!isAbsolute(path)) throw new Error("The folder must be an absolute path.");
      const info = await stat(path).catch(() => null);
      if (!info?.isDirectory()) throw new Error(`There is no folder at ${path}.`);
      const checkout = await projectCheckout(projectId);
      const hostId = checkout?.hostId ?? (await primaryHostId());
      const project = projectId ?? (await fallbackProjectId());
      if (!hostId) throw new Error("bb has no machine to run views on.");
      if (!project) throw new Error("bb has no project to run views in.");
      const { room } = await engine.createRoom({ folder: path, hostId, projectId: project, line, source: from });
      return { room };
    },
    room_get: async ({ roomId }) => {
      const room = await store.get(roomId);
      if (room && Object.values(room.views).some((v) => v.status === "running")) void engine.reconcile(roomId);
      return { room };
    },
    say: async ({ roomId, text, source: from }) => ({ roundId: await engine.say(roomId, text, from) }),
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
}
