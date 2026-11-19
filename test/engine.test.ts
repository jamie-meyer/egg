import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type EngineSettings, createEngine } from "../src/engine.ts";
import { roundViews } from "../src/model.ts";
import { createStore } from "../src/store.ts";
import { memoryKv } from "./support.ts";

const settle = () => new Promise((r) => setTimeout(r, 20));

/** A stand-in for the parts of bb.sdk egg uses, recording every call. */
function fakeSdk(options: { ownedBy?: string; plannerReply?: string | null; plannerFails?: boolean; writes?: (threadId: string) => { name: string; content: string } | null } = {}) {
  const calls: { method: string; args: any }[] = [];
  const meta = new Map<string, any>();
  let n = 0;
  const record = (method: string, args: any) => calls.push({ method, args });
  const sdk: any = {
    threads: {
      spawn: async (args: any) => {
        record("spawn", args);
        if (options.ownedBy && args.environment.type === "host") throw new Error(`HTTP 409: This directory belongs to environment ${options.ownedBy}; reuse that environment instead.`);
        const id = `thr_${++n}`;
        meta.set(id, args.pluginMetadata);
        return { id };
      },
      wait: async (args: any) => {
        record("wait", args);
        if (options.plannerFails) throw new Error("timed out");
        return { matched: true };
      },
      output: async (args: any) => {
        record("output", args);
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

function setup(options: Parameters<typeof fakeSdk>[0] = {}) {
  const fake = fakeSdk(options);
  const store = createStore(memoryKv());
  const roomsDir = mkdtempSync(join(tmpdir(), "egg-test-"));
  const settings: EngineSettings = { viewModel: "claude-sonnet-5-5", plannerModel: "claude-haiku-5-5", providerId: "claude-code", permissionMode: "auto", roomsDir, titlePrefix: "egg test" };
  const published: string[] = [];
  const engine = createEngine({ sdk: fake.sdk, store, settings: async () => settings, publish: (id) => published.push(id), log: { info() {}, warn() {} } });
  return { ...fake, store, engine, roomsDir, published };
}

async function roomWithRound(env: ReturnType<typeof setup>) {
  const { room } = await env.engine.createRoom({ folder: "/repo", hostId: "host_1", projectId: "proj_1", line: "how does startup work", source: "typed" });
  await settle();
  return (await env.store.get(room.id))!;
}

test("a line plans four angles, then starts four hidden, marked view threads on the folder", async () => {
  const env = setup();
  const room = await roomWithRound(env);
  const spawns = env.calls.filter((c) => c.method === "spawn").map((c) => c.args);
  assert.equal(spawns.length, 5);
  const [planner, ...views] = spawns;
  assert.equal(planner.model, "claude-haiku-5-5");
  assert.equal(planner.pluginMetadata.role, "planner");
  for (const s of spawns) {
    assert.equal(s.visibility, "hidden");
    assert.deepEqual(s.environment, { type: "host", hostId: "host_1", workspace: { type: "unmanaged", path: "/repo" } });
    assert.equal(s.projectId, "proj_1");
    assert.match(s.title, /^egg test: /);
  }
  assert.deepEqual(views.map((v) => v.model), Array(4).fill("claude-sonnet-5-5"));
  assert.deepEqual(views.map((v) => v.pluginMetadata.role), Array(4).fill("view"));
  const round = room.rounds[0]!;
  assert.deepEqual(roundViews(room, round).map((v) => [v.angle, v.status]), [["A", "running"], ["B", "running"], ["C", "running"], ["D", "running"]]);
  // The planner thread is archived once it has answered.
  assert.ok(env.calls.some((c) => c.method === "archive" && c.args.threadId === "thr_1"));
  assert.ok(room.lines.some((l) => l.kind === "did" && /Four angles .*A · B · C · D/.test(l.text)));
});

test("a settled view thread fills its card from what it wrote and what its events show", async () => {
  const env = setup();
  const room = await roomWithRound(env);
  const view = roundViews(room, room.rounds[0]!)[0]!;
  await env.engine.onThreadSettled(view.threadId!, null);
  const after = (await env.store.get(room.id))!;
  const done = after.views[view.id]!;
  assert.equal(done.status, "done");
  assert.equal(done.format, "html");
  assert.deepEqual(done.builtFrom, [{ kind: "read", what: "src/main.ts" }, { kind: "command", what: "wc -l src/*.ts" }]);
  assert.deepEqual(await env.store.getContent(view.id), { format: "html", content: `<h1>${view.threadId}</h1>` });
  const list = env.calls.find((c) => c.method === "events.list")!.args;
  assert.deepEqual(list.types, ["item/completed"]);
  assert.ok(after.lines.some((l) => /"A" landed in .*1 file read, 1 command/.test(l.text)));
  // A second notice for the same thread changes nothing.
  await env.engine.onThreadSettled(view.threadId!, null);
  assert.equal((await env.store.get(room.id))!.lines.filter((l) => /"A" landed/.test(l.text)).length, 1);
});

test("a plain-text view is read from view.txt; a thread that wrote nothing fails in plain words", async () => {
  const env = setup({ writes: (id) => (id === "thr_2" ? { name: "view.txt", content: "just text" } : null) });
  const room = await roomWithRound(env);
  const [a, b] = roundViews(room, room.rounds[0]!);
  await env.engine.onThreadSettled(a!.threadId!, null);
  await env.engine.onThreadSettled(b!.threadId!, "the provider crashed");
  const after = (await env.store.get(room.id))!;
  assert.equal(after.views[a!.id]!.format, "text");
  assert.equal(after.views[b!.id]!.status, "failed");
  assert.match(after.views[b!.id]!.error!, /the provider crashed; the thread finished without writing a view/);
  assert.ok(after.lines.some((l) => l.kind === "trouble" && /"B" failed/.test(l.text)));
});

test("when planning fails, egg still runs a round on its own spread of angles", async () => {
  const env = setup({ plannerFails: true });
  const room = await roomWithRound(env);
  const views = roundViews(room, room.rounds[0]!);
  assert.deepEqual(views.map((v) => v.angle), ["The map", "One concrete path", "By the numbers", "Oddities"]);
  assert.match(room.rounds[0]!.planNote!, /planning step failed \(timed out\)/);
  assert.ok(room.lines.some((l) => l.kind === "trouble" && /planning step failed/.test(l.text)));
});

test("keep writes the view and its record into the room's directory; undo takes them away", async () => {
  const env = setup();
  const room = await roomWithRound(env);
  const view = roundViews(room, room.rounds[0]!)[1]!;
  await env.engine.onThreadSettled(view.threadId!, null);
  const kept = await env.engine.decideView(room.id, view.id, "kept");
  const path = kept.views[view.id]!.keptPath!;
  assert.ok(path.startsWith(room.dir));
  assert.equal(readFileSync(path, "utf8"), `<h1>${view.threadId}</h1>`);
  const record = JSON.parse(readFileSync(path.replace(/\.html$/, ".json"), "utf8"));
  assert.equal(record.room.id, room.id);
  assert.equal(record.line, "how does startup work");
  assert.equal(record.angle, "B");
  assert.equal(record.model, "claude-sonnet-5-5");
  assert.ok(Date.parse(record.keptAt) > 0);
  assert.deepEqual(record.builtFrom, [{ kind: "read", what: "src/main.ts" }, { kind: "command", what: "wc -l src/*.ts" }]);
  assert.deepEqual(readdirSync(room.dir).sort(), ["round-1-2-b.html", "round-1-2-b.json"]);
  const undone = await env.engine.decideView(room.id, view.id, null);
  assert.equal(undone.views[view.id]!.decision, null);
  assert.equal(undone.views[view.id]!.keptPath, null);
  assert.ok(!existsSync(path));
});

test("keeping a view with nothing in it yet is refused and leaves no decision", async () => {
  const env = setup();
  const room = await roomWithRound(env);
  const view = roundViews(room, room.rounds[0]!)[0]!;
  await assert.rejects(env.engine.decideView(room.id, view.id, "kept"), /nothing to keep/);
  assert.equal((await env.store.get(room.id))!.views[view.id]!.decision, null);
});

test("drop takes a view off the table and archives its thread, but keeps it in history", async () => {
  const env = setup();
  const room = await roomWithRound(env);
  const view = roundViews(room, room.rounds[0]!)[2]!;
  const after = await env.engine.decideView(room.id, view.id, "dropped");
  assert.equal(after.views[view.id]!.decision, "dropped");
  assert.equal(after.views[view.id]!.archived, true);
  await settle();
  assert.ok(env.calls.some((c) => c.method === "archive" && c.args.threadId === view.threadId));
  assert.ok(after.lines.some((l) => l.text === 'Dropped "C"'));
});

test("the next line archives the threads of the round it supersedes", async () => {
  const env = setup();
  const room = await roomWithRound(env);
  const first = roundViews(room, room.rounds[0]!).map((v) => v.threadId);
  await env.engine.say(room.id, "and shutdown?", "voice");
  await settle();
  const archived = env.calls.filter((c) => c.method === "archive").map((c) => c.args.threadId);
  for (const t of first) assert.ok(archived.includes(t), `${t} archived`);
  const after = (await env.store.get(room.id))!;
  assert.equal(after.rounds.length, 2);
  assert.equal(after.rounds[1]!.line, "and shutdown?");
});

test("reconcile finishes views whose thread went idle while egg was not listening", async () => {
  const env = setup();
  const room = await roomWithRound(env);
  await env.engine.reconcile(room.id);
  const after = (await env.store.get(room.id))!;
  assert.ok(roundViews(after, after.rounds[0]!).every((v) => v.status === "done"));
  assert.equal(after.rounds[0]!.status, "done");
});

test("threads that are not egg's views are ignored", async () => {
  const env = setup();
  await roomWithRound(env);
  const before = env.calls.length;
  await env.engine.onThreadSettled("thr_someone_else", null);
  await env.engine.onThreadSettled("thr_1", null); // the planner
  assert.equal(env.calls.length, before);
});

test("a folder that is already a bb environment is reused, and the room remembers it", async () => {
  const env = setup({ ownedBy: "env_abc123" });
  const room = await roomWithRound(env);
  const spawns = env.calls.filter((c) => c.method === "spawn").map((c) => c.args);
  assert.equal(spawns[0].environment.type, "host");
  assert.deepEqual(spawns[1].environment, { type: "reuse", environmentId: "env_abc123" });
  assert.equal(spawns[1].projectId, "proj_owner");
  assert.equal(spawns.filter((s) => s.environment.type === "host").length, 1, "only the first spawn had to learn");
  assert.equal(roundViews(room, room.rounds[0]!).filter((v) => v.status === "running").length, 4);
  assert.equal(room.environmentId, "env_abc123");
  assert.equal(room.projectId, "proj_owner");
});

test("a room made on a known environment reuses it from the first thread", async () => {
  const env = setup();
  await env.engine.createRoom({ folder: "/repo", hostId: "host_1", projectId: "proj_9", environmentId: "env_known", line: "x", source: "typed" });
  await settle();
  const spawns = env.calls.filter((c) => c.method === "spawn").map((c) => c.args);
  assert.equal(spawns.length, 5);
  for (const s of spawns) assert.deepEqual(s.environment, { type: "reuse", environmentId: "env_known" });
  for (const s of spawns) assert.equal(s.projectId, "proj_9");
});
