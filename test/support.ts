// Test helpers: an in-memory stand-in for plugin KV storage, and a fake bb SDK.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EngineSettings, createEngine } from "../src/engine.ts";
import { type Kv, createStore } from "../src/store.ts";

export function memoryKv(): Kv & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string) {
      const v = data.get(key);
      return v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as T);
    },
    async set(key, value) {
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
    async delete(key) {
      data.delete(key);
    },
    async list(prefix = "") {
      return [...data.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

export const settle = () => new Promise((r) => setTimeout(r, 20));

/** A stand-in for the parts of bb.sdk egg uses, recording every call. */
export function fakeSdk(options: { ownedBy?: string; plannerReply?: string | null; plannerFails?: boolean; plannerReplyFor?: (prompt: string) => string; writes?: (threadId: string) => { name: string; content: string } | null } = {}) {
  const calls: { method: string; args: any }[] = [];
  const meta = new Map<string, any>();
  const prompts = new Map<string, string>();
  let n = 0;
  const record = (method: string, args: any) => calls.push({ method, args });
  const sdk: any = {
    threads: {
      spawn: async (args: any) => {
        record("spawn", args);
        if (options.ownedBy && args.environment.type === "host") throw new Error(`HTTP 409: This directory belongs to environment ${options.ownedBy}; reuse that environment instead.`);
        const id = `thr_${++n}`;
        meta.set(id, args.pluginMetadata);
        prompts.set(id, args.prompt);
        return { id };
      },
      wait: async (args: any) => {
        record("wait", args);
        if (options.plannerFails) throw new Error("timed out");
        return { matched: true };
      },
      output: async (args: any) => {
        record("output", args);
        if (options.plannerReplyFor) return { output: options.plannerReplyFor(prompts.get(args.threadId) ?? "") };
        return { output: options.plannerReply === undefined ? '[{"name":"A","focus":"a"},{"name":"B","focus":"b"},{"name":"C","focus":"c"},{"name":"D","focus":"d"}]' : options.plannerReply };
      },
      getPluginMetadata: async ({ threadId }: any) => meta.get(threadId) ?? {},
      storageLocation: async ({ threadId }: any) => ({ hostId: "host_1", storageRootPath: `/storage/${threadId}` }),
      events: {
        list: async (args: any) => {
          record("events.list", args);
          return [
            { seq: 1, type: "item/completed", data: { item: { type: "toolCall", tool: "Read", status: "completed", arguments: { file_path: "/repo/src/main.ts" } } } },
            { seq: 2, type: "item/completed", data: { item: { type: "commandExecution", status: "completed", command: "wc -l src/*.ts" } } },
          ];
        },
      },
      get: async ({ threadId }: any) => ({ id: threadId, status: "idle" }),
      stop: async (args: any) => record("stop", args),
      archive: async (args: any) => record("archive", args),
    },
    environments: { get: async ({ environmentId }: any) => ({ id: environmentId, projectId: "proj_owner" }) },
    files: {
      read: async (args: any) => {
        record("files.read", args);
        const threadId = args.path.split("/")[2];
        const w = options.writes ? options.writes(threadId) : { name: "view.html", content: `<h1>${threadId}</h1>` };
        if (!w || !args.path.endsWith(w.name)) throw new Error("ENOENT");
        return { content: w.content, contentEncoding: "utf8" };
      },
    },
  };
  return { sdk, calls, meta };
}

export function setup(options: Parameters<typeof fakeSdk>[0] = {}) {
  const fake = fakeSdk(options);
  const store = createStore(memoryKv());
  const roomsDir = mkdtempSync(join(tmpdir(), "egg-test-"));
  const settings: EngineSettings = { viewModel: "claude-sonnet-5-5", plannerModel: "claude-haiku-5-5", providerId: "claude-code", permissionMode: "auto", roomsDir, titlePrefix: "egg test" };
  const published: string[] = [];
  const engine = createEngine({ sdk: fake.sdk, store, settings: async () => settings, publish: (id) => published.push(id), log: { info() {}, warn() {} } });
  return { ...fake, store, engine, roomsDir, published };
}

