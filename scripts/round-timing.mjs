// Where a round's time goes. Runs plain rounds through egg's RPC against a
// running bb (no browser) and breaks each view thread down from its own
// events: start-up, time to first output, time in reading steps, time
// writing the page, output tokens, read steps, and how long egg took to
// show the view after its thread finished.
//
//   node scripts/round-timing.mjs --folder <absolute folder> [--rounds 2] [--plugin egg] [--room <id>] [--keep-room]
//   node scripts/round-timing.mjs --threads <id,id,...>      # only break down existing view threads
//
// Each round is five threads (a planning thread and four views). The room
// is deleted at the end (which archives its view threads) unless
// --keep-room is given. Set the plugin's thread title prefix to something
// recognisable first. Needs the `bb` CLI on PATH.
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const bb = option("bb", "http://127.0.0.1:38886");
const plugin = option("plugin", "egg");
const folder = option("folder");
const rounds = Number(option("rounds", "2"));
const threadsOnly = option("threads");
const LINES = [
  "how does a line become four views",
  "where does a view's time go between its thread starting and its card filling",
  "what does the planning step get to work from",
  "how is what a view was built from worked out",
];

const rpc = async (method, input) => {
  const res = await fetch(`${bb}/api/v1/plugins/${plugin}/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(`${method}: ${JSON.stringify(body).slice(0, 300)}`);
  return body.result;
};

function events(threadId) {
  const out = execFileSync("bb", ["thread", "log", threadId, "--all", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

const WRITES_VIEW = /BB_THREAD_STORAGE[^\n]*view\.(html|txt)|view\.(html|txt)[^\n]*BB_THREAD_STORAGE|\/view\.(html|txt)/;
const isStep = (it) => ["commandExecution", "fileRead", "search", "toolCall", "fileChange"].includes(it?.type);
const writesView = (it) => {
  if (it.type === "fileChange") return true;
  const text = JSON.stringify(it.command ?? it.arguments ?? it.path ?? "");
  return it.type === "commandExecution" || it.type === "toolCall" ? WRITES_VIEW.test(text) && /(cat\s*>|tee |>\s*"?\$|Write|printf)/.test(text) : false;
};

/** One view thread's events to a timing row (ms). */
export function breakdown(evs) {
  const at = (e) => Number(e.createdAt);
  const first = evs[0];
  const turnStarted = evs.find((e) => e.type === "turn/started");
  const turnDone = [...evs].reverse().find((e) => e.type === "turn/completed");
  const firstOut = evs.find((e) => e.type === "item/started" && e.data?.item?.type !== "userMessage");
  const steps = new Map();
  for (const e of evs) {
    const it = e.data?.item;
    if (!isStep(it)) continue;
    const s = steps.get(it.id) ?? { item: it };
    if (e.type === "item/started") s.start = at(e);
    if (e.type === "item/completed") (s.end = at(e)), (s.item = it);
    steps.set(it.id, s);
  }
  const all = [...steps.values()].filter((s) => s.end);
  const write = all.filter((s) => writesView(s.item)).at(-1) ?? null;
  const reads = all.filter((s) => s !== write && (write === null || s.end <= (write.start ?? write.end)));
  const lastReadEnd = reads.length ? Math.max(...reads.map((s) => s.end)) : at(turnStarted ?? first);
  const tokens = [...evs].reverse().find((e) => e.type === "thread/tokenUsage/updated")?.data?.tokenUsage?.total ?? {};
  const t0 = at(turnStarted ?? first);
  return {
    startup: t0 - at(first),
    firstOutput: firstOut ? at(firstOut) - t0 : null,
    reading: lastReadEnd - t0,
    inTools: reads.reduce((n, s) => n + (s.end - (s.start ?? s.end)), 0),
    writing: write ? write.end - lastReadEnd : null,
    afterWrite: write && turnDone ? at(turnDone) - write.end : null,
    total: turnDone ? at(turnDone) - at(first) : null,
    outputTokens: tokens.outputTokens ?? null,
    readSteps: reads.length,
    turnDoneAt: turnDone ? at(turnDone) : null,
    spawnedAt: at(first),
  };
}

const s = (ms) => (ms === null || ms === undefined ? "–" : `${(ms / 1000).toFixed(1)}`);
const HEAD = "view                              spawn→turn  1st out  reading  in tools  writing  after  thread  shown+  out tok  reads";
function row(name, b, shownLag) {
  return [
    name.slice(0, 32).padEnd(32),
    s(b.startup).padStart(10),
    s(b.firstOutput).padStart(8),
    s(b.reading).padStart(8),
    s(b.inTools).padStart(9),
    s(b.writing).padStart(8),
    s(b.afterWrite).padStart(6),
    s(b.total).padStart(7),
    s(shownLag).padStart(7),
    String(b.outputTokens ?? "–").padStart(8),
    String(b.readSteps).padStart(6),
  ].join("  ");
}

if (threadsOnly) {
  console.log(HEAD);
  for (const id of threadsOnly.split(",")) console.log(row(id, breakdown(events(id)), null));
  process.exit(0);
}
if (!folder && !option("room")) {
  console.error("usage: node scripts/round-timing.mjs --folder <absolute folder> [--rounds 2] [--plugin <id>] [--room <id>] [--keep-room]");
  process.exit(2);
}

let roomId = option("room");
const summary = [];
try {
  for (let n = 0; n < rounds; n++) {
    const line = LINES[n % LINES.length];
    const t0 = Date.now();
    let roundId;
    if (!roomId) {
      const { room } = await rpc("room_create", { folder, line, projectId: null, source: "typed" });
      roomId = room.id;
      roundId = room.rounds.at(-1).id;
    } else {
      roundId = (await rpc("say", { roomId, text: line, source: "typed" })).roundId;
    }
    let room;
    let planned = null;
    for (;;) {
      await sleep(250);
      room = (await rpc("room_get", { roomId })).room;
      const round = room.rounds.find((r) => r.id === roundId);
      if (planned === null && round.status !== "planning") planned = Date.now() - t0;
      if (round.status === "done") break;
      if (Date.now() - t0 > 300_000) throw new Error("round did not finish in 5 minutes");
    }
    const total = Date.now() - t0;
    const round = room.rounds.find((r) => r.id === roundId);
    const views = round.viewIds.map((id) => room.views[id]);
    console.log(`\nround ${round.n}: "${line}" — planned in ${s(planned)} s, all four shown in ${s(total)} s`);
    console.log(HEAD);
    const rows = [];
    for (const v of views) {
      if (!v.threadId) {
        console.log(`${v.angle}: no thread (${v.error})`);
        continue;
      }
      const b = breakdown(events(v.threadId));
      const shownLag = b.turnDoneAt && v.finishedAt ? v.finishedAt - b.turnDoneAt : null;
      rows.push({ angle: v.angle, threadId: v.threadId, status: v.status, shownAt: v.finishedAt - t0, shownLag, ...b });
      console.log(row(v.angle, b, shownLag));
    }
    const shown = rows.map((r) => r.shownAt).sort((a, b) => a - b);
    console.log(`cards shown at ${shown.map(s).join(", ")} s after the line (spread ${s(shown.at(-1) - shown[0])} s)`);
    summary.push({ round: round.n, line, planned, total, views: rows });
  }
} finally {
  if (roomId && !flag("keep-room")) {
    await rpc("room_delete", { roomId }).catch((e) => console.log(`(could not delete room ${roomId}: ${e.message})`));
    console.log(`\n(deleted room ${roomId}; its view threads are archived with it)`);
  }
}
console.log(JSON.stringify({ room: roomId, rounds: summary }, null, 2));
