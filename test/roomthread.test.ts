import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type EngineSettings, createEngine, engineSettings } from "../src/engine.ts";
import { roundViews } from "../src/model.ts";
import { createStore } from "../src/store.ts";
import { memoryKv, settle } from "./support.ts";

const ANGLES = '[{"name":"A","focus":"a"},{"name":"B","focus":"b"},{"name":"C","focus":"c"},{"name":"D","focus":"d"}]';
const old = (path: string) => {
  const t = new Date(Date.now() - 60_000);
  utimesSync(path, t, t);
};

/**
 * A fake bb that knows enough about the room thread: environments made by
 * a provider (or failing), thread status, sending, events and context.
 */
function world(options: {
  route?: "look" | "work" | "both";
  providers?: string[];
  /** Which kinds of workspace fail when bb tries to make them. */
  failing?: ("clone" | "worktree" | "in-place")[];
  projectSources?: string[];
  gitDir?: boolean;
  workerCommands?: string[];
  viewWrites?: Record<string, string>;
  /** Process ids egg should see alive. */
  alivePids?: Set<number>;
  turnEndedAt?: number;
} = {}) {
  const folder = mkdtempSync(join(tmpdir(), "egg-folder-"));
  if (options.gitDir) mkdirSync(join(folder, ".git"));
  const roomsDir = mkdtempSync(join(tmpdir(), "egg-rooms-"));
  const workspaces: string[] = [];
  const calls: { method: string; args: any }[] = [];
  const threads = new Map<string, { meta: any; prompt: string; status: string; environmentId: string | null; env?: any; kind?: string }>();
  const envs = new Map<string, { path: string }>();
  let n = 0;
  const record = (method: string, args: any) => calls.push({ method, args });
  const kindOf = (env: any) => (env.type === "provider" ? "clone" : env.type === "host" && env.workspace?.type === "managed-worktree" ? "worktree" : env.type === "reuse" ? "reuse" : "in-place");
  const sdk: any = {
    threads: {
      spawn: async (args: any) => {
        record("spawn", args);
        const id = `thr_${++n}`;
        const kind = kindOf(args.environment);
        let environmentId: string | null = null;
        let status = "active";
        if (args.pluginMetadata?.role === "room-thread") {
          if ((options.failing ?? []).includes(kind as never)) status = "error";
          else {
            const path = kind === "in-place" ? folder : mkdtempSync(join(tmpdir(), `egg-ws-${kind}-`));
            if (kind !== "in-place") workspaces.push(path);
            environmentId = `env_${id}`;
            envs.set(environmentId, { path });
            // Its first turn (the standing instructions) runs until the test lets it end.
            status = "active";
          }
        } else if (args.environment.type === "reuse") environmentId = args.environment.environmentId;
        threads.set(id, { meta: args.pluginMetadata, prompt: args.prompt, status, environmentId, env: args.environment, kind });
        return { id };
      },
      wait: async () => ({ matched: true }),
      output: async ({ threadId }: any) => {
        const t = threads.get(threadId)!;
        if (t.meta?.role === "planner") return { output: `{"route":"${options.route ?? "look"}","angles":${ANGLES}}` };
        return { output: "done" };
      },
      get: async ({ threadId }: any) => {
        const t = threads.get(threadId);
        if (!t) throw new Error("no such thread");
        return { id: threadId, status: t.status, environmentId: t.environmentId, archivedAt: null, hasPendingInteraction: false };
      },
      getPluginMetadata: async ({ threadId }: any) => threads.get(threadId)?.meta ?? {},
      storageLocation: async ({ threadId }: any) => ({ hostId: "host_1", storageRootPath: `/storage/${threadId}` }),
      send: async (args: any) => {
        record("send", args);
        return { ok: true, delivery: "sent" };
      },
      stop: async (args: any) => record("stop", args),
      archive: async (args: any) => record("archive", args),
      context: async () => ({ usage: { usedTokens: 12345 } }),
      interactions: { list: async () => [] },
      events: {
        list: async (args: any) => {
          record("events.list", args);
          const t = threads.get(args.threadId);
          if (args.types?.includes("system/error")) return [{ data: { message: "Clones need macOS and APFS" } }];
          if (t?.meta?.role === "room-thread") {
            if (args.types?.includes("turn/started") || args.types?.includes("turn/completed")) return [{ type: "turn/completed", createdAt: options.turnEndedAt ?? Date.now() - 1000, data: { status: "completed" } }];
            if (args.order === "desc") return [];
            return (options.workerCommands ?? []).map((command, i) => ({ seq: i + 1, type: "item/completed", data: { item: { type: "commandExecution", command, status: "completed" } } }));
          }
          return [{ seq: 1, type: "item/completed", data: { item: { type: "commandExecution", command: "cat .egg/ledger.jsonl", status: "completed" } } }];
        },
      },
    },
    environments: {
      get: async ({ environmentId }: any) => {
        const e = envs.get(environmentId);
        return e ? { id: environmentId, path: e.path, status: "ready" } : { id: environmentId, projectId: "proj_1" };
      },
      listProviders: async () => (options.providers ?? ["cow-clone", "git-worktree"]).map((id) => ({ id })),
    },
    projects: { get: async () => ({ sources: (options.projectSources ?? []).map((path) => ({ path })) }) },
    files: {
      read: async (args: any) => {
        const name = args.path.split("/").pop();
        const content = options.viewWrites?.[name];
        if (content === undefined) throw new Error("ENOENT");
        return { content, contentEncoding: "utf8" };
      },
    },
  };
  const store = createStore(memoryKv());
  const settings: EngineSettings = engineSettings({ roomsDir, titlePrefix: "egg test", roomThread: { providerId: "claude-code", model: "claude-opus-5-5", permissionMode: "auto" } });
  const alivePids = options.alivePids ?? new Set<number>();
  const killed: { pid?: number | undefined; pgid?: number | undefined }[] = [];
  const engine = createEngine({
    sdk,
    store,
    settings: async () => settings,
    publish: () => undefined,
    log: { info() {}, warn() {} },
    pause: async () => undefined,
    alive: (pid) => alivePids.has(pid),
    kill: async (run) => {
      killed.push(run);
      if (run.pid) alivePids.delete(run.pid);
      return true;
    },
  });
  const spawns = (role: string) => calls.filter((c) => c.method === "spawn" && c.args.pluginMetadata?.role === role).map((c) => c.args);
  return { sdk, store, engine, settings, folder, roomsDir, workspaces, calls, threads, spawns, alivePids, killed };
}

async function room(w: ReturnType<typeof world>, line = "look at it") {
  const { room } = await w.engine.createRoom({ folder: w.folder, hostId: "host_1", projectId: "proj_1", line, source: "typed" });
  await settle();
  await settle();
  return room.id;
}

/** Let a room thread that just started finish its first turn and get ready. */
async function ready(w: ReturnType<typeof world>, roomId: string) {
  const r = (await w.store.get(roomId))!;
  w.threads.get(r.worker!.threadId)!.status = "idle";
  await w.engine.roomThread.settled(r.worker!.threadId);
  await settle();
  return (await w.store.get(roomId))!;
}

test("a line the planning step routes to work goes to the room thread: no views, no round, said in the notebook", async () => {
  const w = world({ route: "work" });
  const id = await room(w, "run the tests five times and show the slowest");
  const r = (await w.store.get(id))!;
  assert.equal(w.spawns("view").length, 0);
  assert.equal(r.rounds.length, 0);
  const said = r.lines.find((l) => l.kind === "said")!;
  assert.equal(said.route, "work");
  assert.ok(r.lines.some((l) => /^To the room thread/.test(l.text)));
  assert.equal(w.spawns("room-thread").length, 1);
  // The routing came from the one planning call, with nothing extra.
  assert.equal(w.spawns("planner").length, 1);
  assert.match(w.spawns("planner")[0].prompt, /"route"/);
});

test("both: four views and the room thread; look: four views only", async () => {
  const both = world({ route: "both" });
  const id = await room(both);
  assert.equal(both.spawns("view").length, 4);
  assert.equal(both.spawns("room-thread").length, 1);
  assert.ok((await both.store.get(id))!.lines.some((l) => /^Both: to the room thread, and four angles/.test(l.text)));
  const look = world({ route: "look" });
  await room(look);
  assert.equal(look.spawns("view").length, 4);
  assert.equal(look.spawns("room-thread").length, 0);
});

test("a work line leaves the round on the table alone; a look line after it supersedes as before", async () => {
  const w = world({ route: "look" });
  const id = await room(w);
  const first = (await w.store.get(id))!;
  const viewThreads = roundViews(first, first.rounds[0]!).map((v) => v.threadId);
  await w.engine.work(id, "build it", "typed");
  await settle();
  assert.ok(!w.calls.some((c) => c.method === "archive" && viewThreads.includes(c.args.threadId)), "a work line archives no view");
  assert.equal((await w.store.get(id))!.rounds.length, 1);
});

test("the room thread starts in a clone of the folder, with its standing instructions and the provider's default model unless set", async () => {
  const w = world({ route: "work" });
  w.settings.roomThread.model = "";
  const id = await room(w, "verify all string operations");
  const spawn = w.spawns("room-thread")[0];
  assert.deepEqual(spawn.environment, { type: "provider", environmentProviderId: "cow-clone", inputs: { source: w.folder, bring: [] }, machine: { type: "existing", hostId: "host_1" } });
  assert.equal("model" in spawn, false, "no model: the provider's default");
  assert.equal(spawn.visibility, "visible");
  assert.match(spawn.title, /^egg test: room thread · /);
  for (const words of [/Do what it asks now, and fully/, /Plan first only when the line asks for a plan/, /\.egg\/bin\/run r7 "/, /--fg/, /Never use nohup/, /without reading its record/, /egg tells you when a run finishes/, /status\.html/, /as soon as you have ONE real result/, /\.egg\/ledger\.jsonl/, /\.egg\/notes\.jsonl/, /\.egg\/views\//, /Never push/, /Never write outside your workspace/, /few lines/, /what you actually ran and what you did not/])
    assert.match(spawn.prompt, words);
  const r = (await w.store.get(id))!;
  assert.equal(r.worker!.kind, "clone");
  assert.equal(r.worker!.ready, false);
  assert.equal(r.worker!.pending.length, 1, "the line waits until the thread is ready");
});

test("once its first turn ends, the line that waited is sent; a line while it works is sent as a follow-up", async () => {
  const w = world({ route: "work" });
  const id = await room(w, "verify everything");
  const r = await ready(w, id);
  assert.equal(r.worker!.ready, true);
  const sends = w.calls.filter((c) => c.method === "send");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].args.mode, "steer-if-active");
  assert.match(sends[0].args.input[0].text, /The person said: "verify everything"/);
  assert.ok(r.lines.some((l) => l.text === "→ sent to the room thread"));
  // Busy now: the next work line is added to its running turn, and the notebook says so.
  w.threads.get(r.worker!.threadId)!.status = "active";
  await w.engine.work(id, "also time it", "typed");
  await settle();
  const after = (await w.store.get(id))!;
  assert.equal(w.calls.filter((c) => c.method === "send").length, 2);
  assert.ok(after.lines.some((l) => /sent to the room thread while it works/.test(l.text)));
  assert.equal(after.lines.filter((l) => l.kind === "said" && l.route === "work").length, 2);
});

test("auto: a clone that fails at spawn is said, and a worktree is tried next", async () => {
  const w = world({ route: "work", failing: ["clone"], gitDir: true });
  w.calls.length = 0;
  const id = await (async () => {
    const f = w.folder;
    (w.sdk.projects.get as any) = async () => ({ sources: [{ path: f }] });
    return room(w);
  })();
  const kinds = w.spawns("room-thread").map((s) => s.environment.type === "provider" ? "clone" : s.environment.workspace.type);
  assert.deepEqual(kinds, ["clone", "managed-worktree"]);
  const r = (await w.store.get(id))!;
  assert.equal(r.worker!.kind, "worktree");
  assert.ok(r.lines.some((l) => l.kind === "trouble" && /copy-on-write clone is not available: Clones need macOS and APFS/.test(l.text)));
});

test("auto with neither a clone nor a worktree stops with a plain line and never works in place", async () => {
  const w = world({ route: "work", providers: ["git-worktree"] });
  const id = await room(w);
  assert.equal(w.spawns("room-thread").length, 0);
  const r = (await w.store.get(id))!;
  const line = r.lines.find((l) => /^No room thread/.test(l.text))!;
  assert.match(line.text, /clone: bb has no environment provider "cow-clone"/);
  assert.match(line.text, /worktree: the folder is not the top of a git repository/);
  assert.match(line.text, /in-place/);
});

test("in-place, when set, works in the folder itself", async () => {
  const w = world({ route: "work" });
  w.settings.workspace = "in-place";
  const id = await room(w);
  const spawn = w.spawns("room-thread")[0];
  assert.deepEqual(spawn.environment, { type: "host", hostId: "host_1", workspace: { type: "unmanaged", path: w.folder } });
  assert.match(spawn.prompt, /the folder itself/);
  assert.equal((await w.store.get(id))!.worker!.workspace, w.folder);
});

function writeMaterial(ws: string) {
  const m = join(ws, ".egg");
  mkdirSync(join(m, "views"), { recursive: true });
  writeFileSync(join(m, "ledger.jsonl"), [
    JSON.stringify({ id: "r1", at: "2026-11-19T10:00:00Z", for: "unit tests run 1", command: "npm test", output: ".egg/logs/r1.log", exit: null }),
    "not json",
    JSON.stringify({ id: "r1", exit: 0 }),
    JSON.stringify({ id: "r2", for: "made up", command: "never ran this", output: ".egg/logs/r2.log", exit: 1 }),
  ].join("\n"));
  // r1 went through egg's runner: it has a record. r2 is only a ledger line.
  mkdirSync(join(m, "runs"), { recursive: true });
  writeFileSync(join(m, "runs", "r1.json"), JSON.stringify({ id: "r1", for: "unit tests run 1", command: "npm test", log: ".egg/logs/r1.log", pid: 4242, pgid: 4241, detached: true, startedAt: "2026-11-19T10:00:00.000Z", startedMs: Date.parse("2026-11-19T10:00:00Z"), exit: 0, signal: null, endedMs: Date.parse("2026-11-19T10:02:00Z") }));
  writeFileSync(join(m, "notes.jsonl"), `${JSON.stringify({ at: "x", text: "Started the five test runs" })}\n${JSON.stringify({ text: "Run 1 done: 96 tests, 0.6 s" })}\n`);
  writeFileSync(join(m, "views", "slowest.html"), "<h1>slowest tests</h1>");
  writeFileSync(join(m, "views", "slowest.json"), JSON.stringify({ title: "Slowest tests", focus: "The ten slowest tests over five runs", ledger: ["r1", "r2", "r9"] }));
  for (const f of ["views/slowest.html", "views/slowest.json"]) old(join(m, f));
  return m;
}

test("sync: notes become notebook lines, pages become cards in a work round, the ledger is kept with the room", async () => {
  const w = world({ route: "work", workerCommands: ["cd x && npm test 2>&1 | tee .egg/logs/r1.log", "ls"] });
  const id = await room(w);
  const r0 = await ready(w, id);
  writeMaterial(r0.worker!.workspace);
  await w.engine.roomThread.sync(id);
  const r = (await w.store.get(id))!;
  assert.deepEqual(r.lines.filter((l) => l.kind === "note").map((l) => l.text), ["Started the five test runs", "Run 1 done: 96 tests, 0.6 s"]);
  const round = r.rounds.at(-1)!;
  assert.equal(round.kind, "work");
  const [view] = roundViews(r, round);
  assert.equal(view!.angle, "Slowest tests");
  assert.equal(view!.status, "done");
  assert.equal(view!.file, "slowest.html");
  assert.deepEqual(view!.ledger, ["r1", "r2"], "an id not in the ledger is dropped");
  // r1 has a run record; r2 is only its word: claimed, and never shown as failed or passed.
  assert.equal(view!.builtFrom[0]!.kind, "ledger");
  assert.match(view!.builtFrom[0]!.what, /^r1 · unit tests run 1 · \$ npm test · exit 0 after 2 min/);
  assert.equal(view!.builtFrom[0]!.unconfirmed, undefined);
  assert.equal(view!.builtFrom[0]!.run, "r1");
  assert.equal(view!.builtFrom[1]!.unconfirmed, true);
  assert.equal(view!.builtFrom[1]!.failed, undefined);
  assert.match(view!.builtFrom[1]!.what, /claimed: no run record/);
  assert.doesNotMatch(view!.builtFrom[1]!.what, /exit 1/);
  assert.ok(view!.builtFrom.some((b) => b.kind === "command" && /npm test/.test(b.what)));
  assert.deepEqual(await w.store.getContent(view!.id), { format: "html", content: "<h1>slowest tests</h1>" });
  const ledger = await w.store.getLedger(id);
  assert.deepEqual(ledger.map((e) => [e.id, e.state, e.exit, e.command]), [["r1", "exited", 0, "npm test"], ["r2", "claimed", null, "never ran this"]]);
  // A second sync adds nothing.
  await w.engine.roomThread.sync(id);
  const again = (await w.store.get(id))!;
  assert.equal(again.lines.filter((l) => l.kind === "note").length, 2);
  assert.equal(again.rounds.length, r.rounds.length);
});

test("a page rewritten is a new card; a page still being written waits for the next sync", async () => {
  const w = world({ route: "work" });
  const id = await room(w);
  const ws = (await ready(w, id)).worker!.workspace;
  const m = writeMaterial(ws);
  writeFileSync(join(m, "views", "fresh.txt"), "half");
  await w.engine.roomThread.sync(id);
  let r = (await w.store.get(id))!;
  assert.deepEqual(roundViews(r, r.rounds.at(-1)!).map((v) => v.file), ["slowest.html"]);
  old(join(m, "views", "fresh.txt"));
  writeFileSync(join(m, "views", "slowest.html"), "<h1>slowest tests, again</h1>");
  old(join(m, "views", "slowest.html"));
  utimesSync(join(m, "views", "slowest.html"), new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
  await w.engine.roomThread.sync(id);
  r = (await w.store.get(id))!;
  assert.deepEqual(roundViews(r, r.rounds.at(-1)!).map((v) => v.file).sort(), ["fresh.txt", "slowest.html"]);
});

test("material is copied out to the room's directory, skipping files over the limit with a note", async () => {
  const w = world({ route: "work" });
  w.settings.materialMaxBytes = 1000;
  const id = await room(w);
  const ws = (await ready(w, id)).worker!.workspace;
  const m = writeMaterial(ws);
  mkdirSync(join(m, "results"));
  writeFileSync(join(m, "results", "big.bin"), Buffer.alloc(5000, 1));
  writeFileSync(join(m, "results", "small.csv"), "a,b\n1,2\n");
  await w.engine.roomThread.sync(id);
  const r = (await w.store.get(id))!;
  const out = join(r.dir, "material");
  assert.equal(readFileSync(join(out, "results", "small.csv"), "utf8"), "a,b\n1,2\n");
  assert.ok(existsSync(join(out, "ledger.jsonl")));
  assert.ok(existsSync(join(out, "views", "slowest.html")));
  assert.equal(existsSync(join(out, "results", "big.bin")), false);
  const notes = r.lines.filter((l) => /Not saved to the room's directory: \.egg\/results\/big\.bin/.test(l.text));
  assert.equal(notes.length, 1);
  await w.engine.roomThread.sync(id);
  assert.equal((await w.store.get(id))!.lines.filter((l) => /big\.bin/.test(l.text)).length, 1, "said once");
});

test("when the workspace is gone, the next work line starts a fresh room thread and puts the material back before its first task", async () => {
  const w = world({ route: "work" });
  const id = await room(w, "verify everything");
  const first = await ready(w, id);
  writeMaterial(first.worker!.workspace);
  await w.engine.roomThread.sync(id);
  // bb removed the clone.
  const { rmSync } = await import("node:fs");
  rmSync(first.worker!.workspace, { recursive: true, force: true });
  await w.engine.work(id, "carry on", "typed");
  await settle();
  const mid = (await w.store.get(id))!;
  assert.notEqual(mid.worker!.threadId, first.worker!.threadId);
  assert.deepEqual(mid.pastWorkers, [first.worker!.threadId]);
  assert.match(w.spawns("room-thread")[1].prompt, /already holds material from an earlier room thread/);
  assert.ok(mid.lines.some((l) => /workspace is gone/.test(l.text)));
  const sendsBefore = w.calls.filter((c) => c.method === "send").length;
  const after = await ready(w, id);
  const ws2 = after.worker!.workspace;
  assert.equal(readFileSync(join(ws2, ".egg", "ledger.jsonl"), "utf8").includes('"r2"'), true, "material is back");
  assert.ok(after.lines.some((l) => /Put \d+ saved files? of material back/.test(l.text)));
  const sends = w.calls.filter((c) => c.method === "send").slice(sendsBefore);
  assert.equal(sends.length, 1);
  assert.match(sends[0].args.input[0].text, /carry on/);
});

test("once there is material, views run in the room thread's environment, read the ledger first, and cite it", async () => {
  const w = world({ route: "work", workerCommands: ["npm test"], viewWrites: { "view.html": "<p>v</p>", "view.json": '{"ledger":["r1","nope"]}' } });
  const id = await room(w);
  const r0 = await ready(w, id);
  writeMaterial(r0.worker!.workspace);
  await w.engine.roomThread.sync(id);
  // A look line now.
  (w as any).sdk.threads.output = async ({ threadId }: any) =>
    w.threads.get(threadId)!.meta?.role === "planner" ? { output: `{"route":"look","angles":${ANGLES}}` } : { output: "done" };
  const before = w.spawns("view").length;
  await w.engine.say(id, "which tests vary most", "typed");
  await settle();
  await settle();
  const views = w.spawns("view").slice(before);
  assert.equal(views.length, 4);
  for (const v of views) {
    assert.deepEqual(v.environment, { type: "reuse", environmentId: r0.worker!.environmentId });
    assert.match(v.prompt, /the state egg itself knows for each/);
    assert.match(v.prompt, /r1 · unit tests run 1 · \$ npm test · exit 0/);
    assert.match(v.prompt, /r2 · made up · \$ never ran this · claimed/);
    assert.match(v.prompt, /Prefer real results in \.egg\//);
    assert.match(v.prompt, /view\.json/);
    assert.ok(v.prompt.includes(r0.worker!.workspace));
  }
  const planner = w.spawns("planner").at(-1);
  assert.match(planner.prompt, /its ledger has 2 runs/);
  const r = (await w.store.get(id))!;
  const view = roundViews(r, r.rounds.at(-1)!)[0]!;
  await w.engine.onThreadSettled(view.threadId!, null);
  const done = (await w.store.get(id))!.views[view.id]!;
  assert.equal(done.status, "done");
  assert.deepEqual(done.ledger, ["r1"]);
  assert.equal(done.builtFrom[0]!.kind, "ledger", "ledger entries come above its own commands");
  assert.match(done.builtFrom[0]!.what, /^r1 /);
  assert.ok(done.builtFrom.some((b) => b.kind === "command" && b.what === "cat .egg/ledger.jsonl"));
});

test("stop stops the room thread's turn and says so; deleting the room archives it", async () => {
  const w = world({ route: "work" });
  const id = await room(w);
  const r = await ready(w, id);
  assert.equal(await w.engine.roomThread.stop(id), true);
  assert.ok(w.calls.some((c) => c.method === "stop" && c.args.threadId === r.worker!.threadId));
  assert.ok((await w.store.get(id))!.lines.some((l) => /Stopped the room thread's turn/.test(l.text)));
  await w.engine.deleteRoom(id);
  assert.ok(w.calls.some((c) => c.method === "archive" && c.args.threadId === r.worker!.threadId));
});

test("the status line is read from bb: state, latest step, tokens", async () => {
  const w = world({ route: "work" });
  const id = await room(w);
  await ready(w, id);
  const s = (await w.engine.roomThread.status(id))!;
  assert.equal(s.state, "idle");
  assert.equal(s.tokens, 12345);
  assert.equal(s.ready, true);
  assert.equal(s.ledger, 0);
});

test(".egg/ is kept out of git with info/exclude, not .gitignore", async () => {
  const w = world({ route: "work" });
  w.settings.workspace = "in-place";
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-q", w.folder]);
  const id = await room(w);
  await ready(w, id);
  const exclude = readFileSync(join(w.folder, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /^\/\.egg\/$/m);
  assert.equal(existsSync(join(w.folder, ".gitignore")), false);
});

/** A run record as egg's runner writes it. */
function writeRun(ws: string, id: string, over: Record<string, unknown> = {}) {
  const dir = join(ws, ".egg", "runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, for: `run ${id}`, command: `make ${id}`, log: `.egg/logs/${id}.log`, pid: 5000, pgid: 4999, detached: true, startedMs: Date.now() - 14 * 60_000, exit: null, ...over }));
}
const wakes = (w: ReturnType<typeof world>) => w.calls.filter((c) => c.method === "send" && /^egg: /.test(c.args.input[0].text));

test("egg's runner is put in the workspace when it is ready, and the standing instructions name it", async () => {
  const w = world({ route: "work" });
  const id = await room(w);
  const r = await ready(w, id);
  const runner = join(r.worker!.workspace, ".egg", "bin", "run");
  assert.ok(existsSync(runner));
  assert.match(readFileSync(runner, "utf8"), /egg's runner/);
  assert.ok(r.lines.some((l) => /egg's runner is in \.egg\/bin\/run/.test(l.text)));
});

test("sync owns run states: open runs on the status line, a run that dies or fails is a notebook line at once", async () => {
  const w = world({ route: "work", alivePids: new Set([5000, 5001]) });
  const id = await room(w);
  const ws = (await ready(w, id)).worker!.workspace;
  writeRun(ws, "r1");
  writeRun(ws, "r2", { pid: 5001, pgid: 5001, startedMs: Date.now() - 3 * 60_000 });
  writeRun(ws, "r3", { pid: 5002, exit: 2, endedMs: Date.now() - 1000, startedMs: Date.now() - 5000 });
  await w.engine.roomThread.sync(id);
  let s = (await w.engine.roomThread.status(id))!;
  assert.equal(s.runsOpen, 2);
  assert.ok(s.longestOpenMs! >= 14 * 60_000 && s.longestOpenMs! < 15 * 60_000);
  let r = (await w.store.get(id))!;
  assert.ok(r.lines.some((l) => l.kind === "trouble" && /^Run r3 failed \(run r3\): exit 2 after 4 s/.test(l.text)));
  // r2's process goes away with no exit recorded: died, said once.
  w.alivePids.delete(5001);
  await w.engine.roomThread.sync(id);
  await w.engine.roomThread.sync(id);
  r = (await w.store.get(id))!;
  assert.equal(r.lines.filter((l) => /^Run r2 died/.test(l.text)).length, 1);
  assert.deepEqual((await w.store.getLedger(id)).map((e) => [e.id, e.state]), [["r1", "running"], ["r2", "died"], ["r3", "exited"]]);
  s = (await w.engine.roomThread.status(id))!;
  assert.equal(s.runsOpen, 1);
});

test("an idle room thread is woken when a run finishes, and at the slow interval while runs are open", async () => {
  const w = world({ route: "work", alivePids: new Set([5000]), turnEndedAt: Date.now() - 60_000 });
  const id = await room(w);
  const r0 = await ready(w, id);
  const ws = r0.worker!.workspace;
  writeRun(ws, "r1");
  await w.engine.roomThread.tick();
  assert.equal(wakes(w).length, 0, "open, but its turn ended a minute ago");
  writeRun(ws, "r2", { pid: 5003, exit: 0, startedMs: Date.now() - 30_000, endedMs: Date.now() - 1000 });
  await w.engine.roomThread.tick();
  assert.equal(wakes(w).length, 1);
  assert.match(wakes(w)[0]!.args.input[0].text, /^egg: r2 finished, exit 0; r1 still running \(14 min\)\./);
  assert.ok((await w.store.get(id))!.lines.some((l) => /^Woke the room thread: r2 finished, exit 0; r1 still running/.test(l.text)));
  await w.engine.roomThread.tick();
  assert.equal(wakes(w).length, 1, "told once");
  // Not while it works.
  w.threads.get(r0.worker!.threadId)!.status = "active";
  writeRun(ws, "r3", { pid: 5004, exit: 1, startedMs: Date.now() - 30_000, endedMs: Date.now() - 500 });
  await w.engine.roomThread.tick();
  assert.equal(wakes(w).length, 1);
  // The slow interval: with a short setting and a long-past wake.
  w.threads.get(r0.worker!.threadId)!.status = "idle";
  w.settings.wakeIntervalMs = 1;
  await w.engine.roomThread.tick();
  assert.equal(wakes(w).length, 2);
  assert.match(wakes(w)[1]!.args.input[0].text, /r3 finished, exit 1; r1 still running/);
});

test("stop kills every open run by its process group, marks it stopped, and nothing wakes the thread until the person's next line", async () => {
  const w = world({ route: "work", alivePids: new Set([5000, 5001]), turnEndedAt: Date.now() - 60 * 60_000 });
  w.settings.wakeIntervalMs = 1;
  const id = await room(w);
  const r0 = await ready(w, id);
  const ws = r0.worker!.workspace;
  writeRun(ws, "r1");
  writeRun(ws, "r2", { pid: 5001, pgid: 5001 });
  writeRun(ws, "r0", { pid: 4000, exit: 0, endedMs: Date.now() - 2 * 60 * 60_000 });
  await w.engine.roomThread.sync(id);
  assert.equal(await w.engine.roomThread.stop(id), true);
  assert.deepEqual(w.killed.map((k) => k.pgid).sort(), [4999, 5001]);
  const r = (await w.store.get(id))!;
  assert.equal(r.worker!.held, true);
  assert.ok(r.lines.some((l) => /^Stopped the room thread's turn and its open runs r1, r2\./.test(l.text)));
  await w.engine.roomThread.sync(id);
  assert.deepEqual((await w.store.getLedger(id)).map((e) => `${e.id} ${e.state}`).sort(), ["r0 exited", "r1 stopped", "r2 stopped"]);
  assert.equal(r.lines.filter((l) => /^Run r[12] (died|failed)/.test(l.text)).length, 0, "a stopped run is not said to have died");
  // Idle, a run finishing, a long interval past: still nothing.
  writeRun(ws, "r9", { pid: 5009, exit: 0, startedMs: Date.now() - 1000, endedMs: Date.now() });
  await w.engine.roomThread.tick();
  await w.engine.roomThread.tick();
  assert.equal(wakes(w).length, 0);
  // The person's next line lifts it.
  await w.engine.work(id, "carry on", "typed");
  await settle();
  assert.equal((await w.store.get(id))!.worker!.held, false);
  await w.engine.roomThread.tick();
  assert.equal(wakes(w).length, 1);
  assert.match(wakes(w)[0]!.args.input[0].text, /r9 finished, exit 0/);
});

test("deleting the room stops its open runs too", async () => {
  const w = world({ route: "work", alivePids: new Set([5000]) });
  const id = await room(w);
  writeRun((await ready(w, id)).worker!.workspace, "r1");
  await w.engine.roomThread.sync(id);
  await w.engine.deleteRoom(id);
  assert.deepEqual(w.killed.map((k) => k.pgid), [4999]);
});
