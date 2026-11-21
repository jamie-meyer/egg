// End-to-end check of the egg page against a running bb, in a separate
// headless Chrome (never your own bb window).
//
// The whole pass makes one room on the folder you give it and walks through
// a working session, one named section after another:
//
//   new      the new-room form (folder default, checkouts), a room, round 1   5 threads
//   large    a view opens large in a sandboxed frame covering the table      0
//   keep     y keeps the selected view                                       0
//   timing   the round's notebook line says how many views and how long      0
//   more     more like this (m): four variations on named axes               5
//   compare  mark two views and compare them side by side (v, v, c)          0
//   cross    cross the two marked views (x)                                  3
//   zoom     zoom into a part (z): a child room and its first round; keep    5
//   pin      pin a view (p) and say a line with it pinned                    5
//   up       back up to the parent room (-), at the view zoomed from         0
//   signing  another key asks: X refuses it. The page's own key removed:     0
//            the page goes blank and says what to do, a new room is not
//            made and the notebook says why; approved again, it is back.
//            A reset file naming the page's key lets only that key in.
//            A page whose clock is ten minutes off still works.
//   probe    scripts/probe.mjs: every signed action tried unsigned, forged,  0
//            replayed, stale and with changed arguments; each refused, and
//            nothing changed
//   workstop a room whose first line is work; stop its room thread (S, y)    2
//   rooms    the indented room list; delete the test rooms (D, u once)       0
//   work     a room whose first line asks for work: the room thread runs     ~9
//            it in a clone; notes, a page citing the ledger, runs through
//            egg's runner (one that outlives its turn by 6 min and wakes the
//            thread when it ends, one that fails at once), a look line whose
//            views cite the ledger, the status line, stop (its open runs
//            killed, no wake after), the chat pane, material on disk, and
//            the folder untouched. Long: up to 50 min.
//
// All but work is 25 threads; enrol, signing and probe start none. To check one change with a handful, run a subset
// with --only, and reuse a room that already has a finished round with
// --room (from the room list, or kept from a run of scripts/round-timing.mjs
// --keep-room); "new" is then skipped. Sections run in the order above. A
// section that needs something an earlier one makes (up needs zoom, rooms
// needs new) is skipped with a note when that is missing. Rooms this run
// makes are deleted at the end; a room given with --room is left alone.
// --keep-rooms leaves this run's rooms for a later run to reuse, and
// --adopt-room makes the --room one this run's own (rooms may then delete it).
//
// Set the plugin's "Thread title prefix" setting to "egg test" first so the
// threads are easy to find, and its rooms directory to a scratch folder.
// Deleting a room archives its view threads; planning threads are archived
// as each answers. The script prints every view thread id so you can check.
//
//   node scripts/e2e.mjs --folder <absolute folder> [--plugin egg-check] [--bb http://127.0.0.1:38886] [--shots <dir>]
//   node scripts/e2e.mjs --room <room id> --only large,compare,timing [--plugin egg-check]
//
// --plugin is the plugin id egg is installed under (for a test copy
// installed beside the real one, for example). Needs Chrome; run it outside
// any command sandbox.
//
// Signing. egg acts only on calls signed by an enrolled key
// (docs/security.md), so every pass starts with a step of its own, "enrol":
// the copy's enrolment is reset with the reset file, the test browser opens
// the page and is enrolled silently as the first to ask, and this script's
// own key (scripts/signer.mjs) asks next and is approved by pressing A, then y,
// on the page. From then on the page signs with its key and the script's
// direct calls are signed with the script's. Against the installed egg (the
// long flag below) nothing is reset: approve the script's key on your page.
//
// --probe-dir <dir>: the probe section hands its material to an attacker
// run elsewhere (node scripts/probe.mjs --dir <dir> --sandboxed, from inside
// an agent's sandbox) and waits for its report, instead of running the
// attempts itself.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { firstPage, launchChrome, sleep } from "./cdp.mjs";
import { attack, prepare, snapshot } from "./probe.mjs";
import { enrolledSigner, makeSigner, rawRpc, resetEnrolment } from "./signer.mjs";

const SECTIONS = ["new", "large", "keep", "timing", "more", "compare", "cross", "zoom", "pin", "up", "signing", "probe", "workstop", "rooms", "work"];

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const bb = option("bb", "http://127.0.0.1:38886");
const plugin = option("plugin", "egg-check");
// The installed egg is the one a person uses: its rooms, threads and settings
// are theirs. Checks run against a copy (scripts/copy-for-checks.mjs).
const TOUCH_INSTALLED = "--i-know-this-runs-against-the-installed-egg-and-its-rooms";
if (plugin === "egg" && !args.includes(TOUCH_INSTALLED)) {
  console.error(`Refusing to run against the plugin id egg, the installed egg. Make a copy with scripts/copy-for-checks.mjs and pass --plugin egg-check, or pass ${TOUCH_INSTALLED}.`);
  process.exit(2);
}
const folder = option("folder");
const shots = option("shots");
const reuse = option("room");
const probeDir = option("probe-dir");
/** Leave the rooms this run makes, for a later run with --room. */
const keepRooms = args.includes("--keep-rooms");
/** Treat the room given with --room as this run's own: rooms may delete it, and it goes at the end. */
const adoptRoom = args.includes("--adopt-room");
const only = option("only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const unknown = (only ?? []).filter((s) => !SECTIONS.includes(s));
if (unknown.length || (!folder && !reuse)) {
  if (unknown.length) console.error(`unknown section(s): ${unknown.join(", ")}; sections are ${SECTIONS.join(", ")}`);
  console.error("usage: node scripts/e2e.mjs (--folder <absolute folder> | --room <room id>) [--only <section,...>] [--plugin <id>] [--shots <dir>]");
  process.exit(2);
}
const wanted = new Set((only ?? SECTIONS).filter((s) => !(reuse && s === "new")));
const pageUrl = `${bb}/plugins/${plugin}/egg`;
/** This script's own key, enrolled in the "enrol" step: its direct calls are signed with it. */
let signer = null;
const rpc = async (method, input) => {
  if (!signer) throw new Error(`${method}: the script's key is not enrolled yet`);
  return signer.call(method, input);
};

const results = [];
const timings = {};
let failed = false;
const check = (ok, what) => {
  results.push(`${ok ? "ok  " : "FAIL"} ${what}`);
  console.log(results.at(-1));
  if (!ok) failed = true;
  return ok;
};
const shot = async (page, name) => shots && page.shot(`${shots}/${name}.png`);
const count = (page, selector) => page.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const focusRoot = (page) => page.eval("document.querySelector('[data-egg-root]').focus()");
const cardsOnTable = "[...document.querySelectorAll('[data-egg-cards] [data-egg-card]')]";
const allSettled = `${cardsOnTable}.length > 0 && ${cardsOnTable}.every((c) => ['done','failed'].includes(c.dataset.eggStatus))`;
const selectedId = (page) => page.eval("document.querySelector('[data-egg-cards] .egg-selected, [data-egg-kept] .egg-selected')?.dataset.eggCard ?? null");
const roundHead = (page) => page.eval("document.querySelector('.egg-round-head')?.textContent ?? ''");
const roundNumber = async (page) => Number(/^round (\d+) of/.exec(await roundHead(page))?.[1] ?? 0);
const lines = (page) => page.eval("[...document.querySelectorAll('[data-egg-line]')].map((l) => l.textContent)");
const subjectIs = (text) => `document.querySelector('[data-egg-subject]')?.textContent === ${JSON.stringify(text)}`;
/** Does the overlay cover the whole area below the top bar, with nothing of the page showing above it? */
const covers = (selector) => `(() => {
  const o = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
  const top = document.querySelector('.egg-top').getBoundingClientRect();
  const main = document.querySelector('.egg-main').getBoundingClientRect();
  return { top: o.top, bar: top.bottom, ok: Math.abs(o.top - top.bottom) < 1 && Math.abs(o.bottom - main.bottom) < 1 && Math.abs(o.left - main.left) < 1 && Math.abs(o.right - main.right) < 1 };
})()`;

/** Select the first finished card on the table (from the first card). */
async function selectFirstDone(page) {
  await focusRoot(page);
  await page.key("0");
  const i = await page.eval(`${cardsOnTable}.findIndex((c) => c.dataset.eggStatus === 'done')`);
  for (let k = 0; k < i; k++) await page.key("l");
  return i >= 0 ? page.eval(`${cardsOnTable}[${i}].dataset.eggCard`) : null;
}

/** Wait for round n to show its cards, then for them all to settle. Returns ms from `t0`. */
async function waitRound(page, n, cards, t0, label) {
  await page.waitFor(`document.querySelector('.egg-round-head')?.textContent.startsWith('round ${n} of')`, { timeout: 30000, label: `${label}: round ${n}` });
  await page.waitFor(`${cardsOnTable}.length === ${cards}`, { timeout: 120000, label: `${label}: ${cards} cards` });
  const planned = Date.now() - t0;
  await page.waitFor(allSettled, { timeout: 300000, label: `${label}: cards fill` });
  const statuses = await page.eval(`${cardsOnTable}.map((c) => c.dataset.eggStatus)`);
  check(statuses.filter((s) => s === "done").length >= Math.min(2, cards), `${label}: cards filled (${statuses.join(", ")})`);
  await sleep(800);
  return { planned, total: Date.now() - t0 };
}

const viewThreads = new Set();
/** Rooms this run made; they are deleted at the end. A reused room is not. */
const roomIds = reuse && adoptRoom ? [reuse] : [];
async function collectThreads(roomId) {
  try {
    const { room } = await rpc("room_get", { roomId });
    for (const v of Object.values(room?.views ?? {})) if (v.threadId) viewThreads.add(v.threadId);
    for (const t of [room?.worker?.threadId, ...(room?.pastWorkers ?? [])]) if (t) viewThreads.add(t);
  } catch (e) {
    console.log(`(could not list threads of ${roomId}: ${e.message})`);
  }
}

/** What sections hand on to later ones. */
const ctx = { pageKey: null, parentRoomId: reuse ?? null, subject: null, childRoomId: null, zoomFrom: null, zoomRound: 0, keptPath: null, markA: null, markB: null };

/** Mark the first two finished cards A and B, unless two are marked already. */
async function markTwo(page) {
  const marked = await page.eval(`[...document.querySelectorAll('[data-egg-mark]')].filter((c) => c.dataset.eggMark).map((c) => c.dataset.eggCard)`);
  if (marked.length === 2 && ctx.markA && ctx.markB) return;
  for (const id of marked) {
    // Clear stale marks from an earlier run on a reused room.
    await focusRoot(page);
    const i = await page.eval(`${cardsOnTable}.findIndex((c) => c.dataset.eggCard === ${JSON.stringify(id)})`);
    if (i < 0) continue;
    await page.key("0");
    for (let k = 0; k < i; k++) await page.key("l");
    await page.key("v");
  }
  await focusRoot(page);
  await page.key("0");
  ctx.markA = await selectedId(page);
  await page.key("v");
  await page.key("l");
  ctx.markB = await selectedId(page);
  await page.key("v");
}

const workerState = (page) => page.eval("document.querySelector('[data-egg-worker]')?.dataset.eggWorkerState ?? null");
const workerLine = (page) => page.eval("document.querySelector('[data-egg-worker-line]')?.textContent ?? ''");
const gitState = (dir) => {
  try {
    return execFileSync("git", ["-C", dir, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
  } catch (e) {
    return `(not git: ${e.message})`;
  }
};
/** Every state the status line showed, in order, with when. */
const seenStates = [];
async function watchState(page) {
  const state = await workerState(page);
  if (state && seenStates.at(-1)?.state !== state) {
    seenStates.push({ state, at: new Date().toISOString(), line: await workerLine(page) });
    console.log(`   status line: ${seenStates.at(-1).line}`);
  }
  return state;
}
async function waitWatching(page, expr, timeout, label) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    await watchState(page);
    if (await page.eval(expr)) return true;
    await sleep(3000);
  }
  throw new Error(`timed out: ${label}`);
}

const ledgerOf = async (roomId) => (await rpc("ledger", { roomId })).entries;
const procAlive = (pid) => {
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM" ? true : e.code === "ESRCH" ? false : null;
  }
};
async function waitFor(read, ok, timeout, every = 5000) {
  const until = Date.now() + timeout;
  let value = await read();
  while (!ok(value) && Date.now() < until) {
    await sleep(every);
    value = await read();
  }
  return value;
}
/**
 * Does egg's ledger tell the truth now? For each entry: running only while
 * its process is alive and its record has no exit; exited with the
 * record's status. Allows one sync (20 s) of lag, so call it twice apart.
 */
function truthNow(entries, workspace) {
  const wrong = [];
  for (const e of entries) {
    if (e.state === "claimed" || e.state === "stopped") continue;
    let record = null;
    try {
      record = JSON.parse(readFileSync(join(workspace, ".egg", "runs", `${e.id}.json`), "utf8"));
    } catch {
      wrong.push(`${e.id}: egg says ${e.state} but there is no record`);
      continue;
    }
    const alive = procAlive(record.pid);
    if (e.state === "running" && (record.exit !== null || alive === false)) wrong.push(`${e.id}: egg says running; record exit ${record.exit}, process alive ${alive}`);
    if (e.state === "exited" && e.exit !== record.exit) wrong.push(`${e.id}: egg says exit ${e.exit}; record ${record.exit}`);
    if (e.state === "died" && (record.exit !== null || alive === true)) wrong.push(`${e.id}: egg says died; record exit ${record.exit}, process alive ${alive}`);
  }
  return wrong;
}

/** Runs through egg's runner: one outlives the turn that started it by six minutes and wakes the thread; one fails at once. */
async function runsOutliveTheTurn(page, roomId) {
  const before = new Set((await ledgerOf(roomId)).map((e) => e.id));
  await focusRoot(page);
  await page.key("w");
  await page.type("through egg's runner, start two detached runs and then end your turn at once, without waiting for either: one that sleeps 400 seconds and then writes .egg/results/long-done.txt, and one that runs `exit 3`. Note both, and add them to your status page.");
  const asked = Date.now();
  await page.key("Enter");
  await waitWatching(page, "document.querySelector('[data-egg-worker]')?.dataset.eggWorkerState === 'running'", 5 * 60_000, "the run turn starts");
  await waitWatching(page, "document.querySelector('[data-egg-worker]')?.dataset.eggWorkerState === 'idle'", 10 * 60_000, "the run turn ends");
  const turnEnded = Date.now();
  const room = (await rpc("room_get", { roomId })).room;
  const ws = room.worker.workspace;
  // One sync at most after the turn ends.
  const fresh = await waitFor(async () => (await ledgerOf(roomId)).filter((e) => !before.has(e.id)), (f) => f.some((e) => e.state === "running") && f.some((e) => e.state === "exited"), 45_000);
  const long = fresh.find((e) => e.state === "running");
  const short = fresh.find((e) => e.state === "exited");
  check(!!long && procAlive(long.pid) === true, `a detached run is running after its turn ended, its process alive (${long ? `${long.id} pid ${long.pid}` : fresh.map((e) => `${e.id} ${e.state}`).join(", ")})`);
  check(!!short && short.exit === 3, `the run that fails at once is shown as failed within one sync (${short ? `${short.id} exit ${short.exit}, ${Math.round((Date.now() - turnEnded) / 1000)} s after the turn ended` : "none"})`);
  check(short ? (await lines(page)).some((l) => l.includes(`Run ${short.id} failed`)) : false, "its failure is a notebook line");
  check(await page.eval("!!document.querySelector('[data-egg-runs-open]')") && /run(s)? open/.test(await page.eval("document.querySelector('[data-egg-runs-open]')?.textContent ?? ''")), `the status line says runs are open (${await page.eval("document.querySelector('[data-egg-runs-open]')?.textContent ?? ''")})`);
  await shot(page, "w2b-runs-open");
  if (!long) return;
  // Watch it to the end: egg's ledger must say the truth at every look.
  const wrongs = [];
  let looks = 0;
  for (;;) {
    const entries = await ledgerOf(roomId);
    const now = entries.find((e) => e.id === long.id);
    const wrong = truthNow(entries, ws);
    if (wrong.length) {
      await sleep(25_000);
      const again = truthNow(await ledgerOf(roomId), ws);
      if (again.length) wrongs.push(...again.map((w) => `${new Date().toISOString()} ${w}`));
    }
    looks++;
    if (now?.state !== "running" || Date.now() - asked > 12 * 60_000) break;
    await watchState(page);
    await sleep(15_000);
  }
  const ended = (await ledgerOf(roomId)).find((e) => e.id === long.id);
  check(ended?.state === "exited" && ended.exit === 0 && ended.endedMs - ended.startedMs >= 6 * 60_000, `the long run ran to its end: ${ended?.state} exit ${ended?.exit} after ${ended ? Math.round((ended.endedMs - ended.startedMs) / 1000) : "?"} s, ${Math.round((ended?.endedMs - turnEnded) / 1000)} s after its turn ended`);
  check(existsSync(join(ws, ".egg", "results", "long-done.txt")), "and wrote its file");
  check(wrongs.length === 0, `egg's ledger matched the records and processes at each of ${looks} looks${wrongs.length ? `: ${wrongs.join("; ")}` : ""}`);
  await waitWatching(page, `[...document.querySelectorAll('[data-egg-line] .egg-line-text')].some((l) => l.textContent.startsWith('Woke the room thread: ${long.id} finished, exit 0'))`, 90_000, "egg wakes the thread");
  check(true, `egg wakes the idle thread when ${long.id} finishes`);
  // A woken turn can be short: it came back if a turn ran after the wake (running now, or idle since after it).
  const wokeAt = (await rpc("room_get", { roomId })).room.lines.filter((l) => l.text.startsWith(`Woke the room thread: ${long.id}`)).at(-1).at;
  const back = await waitFor(() => rpc("worker_status", { roomId }), (w) => w?.state === "running" || (w?.state === "idle" && w.since > wokeAt), 90_000, 2000);
  check(back?.state === "running" || back?.since > wokeAt, `the thread comes back to it (${back?.state}, ${Math.round(((back?.since ?? 0) - wokeAt) / 1000)} s after the wake)`);
  await waitWatching(page, "document.querySelector('[data-egg-worker]')?.dataset.eggWorkerState === 'idle'", 10 * 60_000, "and settles");
}

const signingLine = (page) => page.eval("(() => { const el = document.querySelector('[data-egg-signing]'); return el ? { status: el.dataset.eggSigning, key: el.dataset.eggOwnKey, text: el.textContent } : null; })()");
const keyRequest = (page) => page.eval("(() => { const el = document.querySelector('[data-egg-key-request]'); return el ? { key: el.dataset.eggKeyRequest, text: el.textContent } : null; })()");
const unsentLines = (page) => page.eval("[...document.querySelectorAll('[data-egg-unsent]')].map((l) => l.textContent)");
const closeNewRoomForm = async (page) => {
  if (!(await page.eval("!!document.querySelector('[data-egg-new-room]')"))) return;
  await page.eval("document.querySelector('[data-egg-folder]').focus()");
  await page.key("Escape");
  await page.waitFor("!document.querySelector('[data-egg-new-room]')", { label: "the new-room form closes" });
};

/**
 * Always first: the test browser and this script get enrolled. On a copy for
 * checks enrolment is reset before the page opens, so the page's key is the
 * first to ask; the script's key asks second and A on the page approves it.
 */
async function enrol(page) {
  const fresh = plugin !== "egg";
  const state = await waitFor(() => rawRpc(bb, plugin, "keys_state", null).then((r) => r.result), (st) => fresh ? st?.keys.length > 0 : true, 20_000, 250);
  if (fresh) {
    const first = state.keys[0];
    ctx.pageKey = first?.fingerprint ?? null;
    check(state.keys.length === 1 && first.how === "first" && first.approvedBy === null, `opening the page enrols the test browser's key, the first to ask (${first?.fingerprint}, "${first?.label}")`);
    check((await signingLine(page)) === null && (await keyRequest(page)) === null, "and the page says nothing about it: the first enrolment is silent");
    check(state.resetPath.endsWith(`/plugins/${plugin}/reset-enrollment`), `the reset file is this copy's own (${state.resetPath})`);
  }
  signer = await enrolledSigner({
    bb,
    plugin,
    approve: async (fingerprint) => {
      if (!fresh) return console.log(`The script's key ${fingerprint} waits: open egg's page in a browser where it works and press A, then y.`);
      await page.waitFor(`document.querySelector('[data-egg-key-request]')?.dataset.eggKeyRequest === ${JSON.stringify(fingerprint)}`, { label: "the page shows the script's key asking" });
      const line = await keyRequest(page);
      check(line.text.includes(fingerprint) && /approves it/.test(line.text) && /refuses it/.test(line.text), `a second key asking shows as a plain line on the enrolled page: "${line.text.slice(0, 150)}…"`);
      // Before A: the key that asks can do nothing, not even read.
      const early = await rawRpc(bb, plugin, "signed", await (await makeSigner({ bb, plugin })).sign("rooms_list", null));
      check(!early.ok && /not enrolled/.test(early.error), `a key that is not enrolled is refused everything, reading included (${early.error})`);
      await closeNewRoomForm(page);
      await focusRoot(page);
      // A alone approves nothing: it asks, and any key but y leaves the request waiting.
      await page.key("A");
      await page.waitFor(`document.querySelector('[data-egg-confirm-approve]')?.dataset.eggConfirmApprove === ${JSON.stringify(fingerprint)}`, { label: "the page asks before approving" });
      await page.key("n");
      await sleep(600);
      const still = (await rawRpc(bb, plugin, "keys_state", null)).result;
      check(!still.keys.some((k) => k.fingerprint === fingerprint) && still.requests.some((r) => r.fingerprint === fingerprint && r.status === "pending") && !(await page.eval("!!document.querySelector('[data-egg-new-room]')")), "A then any key but y approves nothing, and that key does nothing else");
      await page.key("A");
      await page.waitFor("!!document.querySelector('[data-egg-confirm-approve]')", { label: "the page asks again" });
      await page.key("y");
    },
  });
  const mine = (await signer.state()).keys.find((k) => k.fingerprint === signer.fingerprint);
  check(!!mine && mine.how === (fresh ? "approved" : mine.how), `the script's key ${signer.fingerprint} is enrolled (${mine?.how}${mine?.approvedBy ? ` by ${mine.approvedBy}` : ""})`);
  if (fresh) {
    check(mine?.approvedBy === ctx.pageKey, "A then y on the page approved it, signed with the page's key");
    await page.waitFor("!document.querySelector('[data-egg-key-request]')", { label: "the request line goes" });
  }
  // A test browser that came second (the installed egg, with the long flag): the script, once approved, approves it.
  const waiting = await signingLine(page);
  if (waiting?.status === "pending" && waiting.key) {
    ctx.pageKey = waiting.key;
    await rpc("key_approve", { fingerprint: waiting.key });
    await page.waitFor("!document.querySelector('[data-egg-signing]')", { label: "the test browser is approved" });
  }
  check((await rpc("rooms_list", null)).rooms !== undefined, "the script's signed calls are accepted");
}

/** Every file under a room's directory, with its size: kept views and material. */
function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    let names = [];
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(d, name);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else out.push(`${full.slice(dir.length)} ${info.size}`);
    }
  };
  walk(dir);
  return out;
}

const steps = {
  // ---- Signing as the person sees it: refusing a key, a page that is not enrolled, and one whose clock is off.
  async signing(page) {
    if (!ctx.pageKey) return console.log("(skipped signing: it removes and re-approves the test browser's key, so it needs to know it)");
    await closeNewRoomForm(page);
    // X refuses a key that asks.
    const third = await makeSigner({ bb, plugin, label: "egg test: a third key" });
    check((await third.enrol()) === "pending", "a third key asks to be enrolled");
    await page.waitFor(`document.querySelector('[data-egg-key-request]')?.dataset.eggKeyRequest === ${JSON.stringify(third.fingerprint)}`, { label: "the page shows the third key asking" });
    await focusRoot(page);
    await page.key("X");
    await page.waitFor("!document.querySelector('[data-egg-key-request]')", { label: "the request line goes after X" });
    const refusedKey = (await signer.state()).requests.find((r) => r.fingerprint === third.fingerprint);
    check(refusedKey?.status === "refused" && !(await third.enrolled()), "X on the page refuses it: it is not enrolled, and its request is marked refused");
    await rpc("key_remove", { fingerprint: third.fingerprint });

    // The page's own key is removed (as from another enrolled browser): it becomes a browser that is not enrolled.
    const hadRoom = await page.eval("!!document.querySelector('[data-egg-subject]')");
    const roomsBefore = (await rpc("rooms_list", null)).rooms.length;
    // First with as many keys already waiting as egg keeps: this browser cannot even get on the list, and says so.
    const fillers = [];
    for (let i = 0; i < 8; i++) {
      const filler = await makeSigner({ bb, plugin, label: `egg test: filler ${i + 1}` });
      if ((await filler.enrol()) === "pending") fillers.push(filler.fingerprint);
    }
    await rpc("key_remove", { fingerprint: ctx.pageKey });
    await page.waitFor("document.querySelector('[data-egg-signing]')?.dataset.eggSigning === 'pending'", { label: "the page says it is not enrolled" });
    const crowdedLine = await signingLine(page);
    check(fillers.length === 8 && /Other keys wait to be approved ahead of it/.test(crowdedLine.text) && /refuse those you do not know \(X\)/.test(crowdedLine.text), `with 8 keys waiting already, a browser that cannot get on the list says so: "${crowdedLine.text.slice(0, 230)}…"`);
    for (const fingerprint of fillers) await rpc("key_remove", { fingerprint });
    // It keeps asking, and gets on the list once there is room.
    await page.waitFor("!/Other keys wait/.test(document.querySelector('[data-egg-signing]')?.textContent ?? 'Other keys wait')", { timeout: 20000, label: "the page asks again" });
    check((await signer.state()).requests.some((r) => r.fingerprint === ctx.pageKey && r.status === "pending"), "once there is room it asks again by itself, and is on the list");
    const line = await signingLine(page);
    const resetPath = (await signer.state()).resetPath;
    check(line.key === ctx.pageKey, `the browser keeps its key (${line.key}) and asks with it again`);
    check(line.text.includes(ctx.pageKey) && /not enrolled with egg/.test(line.text) && /A, then y, approves it/.test(line.text) && line.text.includes(`echo ${ctx.pageKey} > ${resetPath}`), `a browser that is not enrolled shows one plain line saying what to do: "${line.text}"`);
    await page.waitFor("!document.querySelector('[data-egg-subject]') && document.querySelectorAll('[data-egg-card]').length === 0", { label: "the page goes blank" });
    check((await count(page, "[data-egg-line]:not([data-egg-unsent])")) === 0, "and shows nothing: no room, no lines, no views");
    await shot(page, "s1-not-enrolled");
    // What it tries is not done, and the notebook says so.
    await focusRoot(page);
    await page.key("n");
    await page.waitFor("!!document.querySelector('[data-egg-new-room]')", { label: "the new-room form" });
    await page.eval(`(() => { const el = document.querySelector('[data-egg-folder]'); el.focus(); el.select(); })()`);
    await page.type(folder ?? "/tmp");
    await page.eval("document.querySelector('[data-egg-first-line]').focus()");
    await page.type("a room from a browser that is not enrolled");
    await page.key("Enter");
    await page.waitFor("document.querySelectorAll('[data-egg-unsent]').length > 0", { label: "the notebook says it was not made" });
    const said = (await unsentLines(page)).at(-1);
    check(/^!?\s*The room was not made: this browser is not enrolled with egg\. The line at the top/.test(said), `a call the page could not sign is said in the notebook, in plain words: "${said}"`);
    check(/The room was not made/.test(await page.eval("document.querySelector('[data-egg-new-room] .egg-trouble')?.textContent ?? ''")), "and on the form");
    await closeNewRoomForm(page);
    check((await rpc("rooms_list", null)).rooms.length === roomsBefore, "no room was made");
    await shot(page, "s2-not-made");
    // Approved again, by a call signed with another enrolled key: everything is back.
    await rpc("key_approve", { fingerprint: ctx.pageKey });
    await page.waitFor("!document.querySelector('[data-egg-signing]')", { label: "the line goes once approved" });
    if (hadRoom) await page.waitFor(`!!document.querySelector('[data-egg-subject]') && ${cardsOnTable}.length > 0`, { timeout: 30000, label: "the room is back" });
    check((await unsentLines(page)).length === 0, `approved again, the page works as before${hadRoom ? ": its room is back" : ""}, and the notebook's line about it is gone`);

    // The reset the page prints names its key: only that key gets in, though something else asks first and keeps asking.
    if (plugin !== "egg") {
      const agent = await makeSigner({ bb, plugin, label: "egg test: something that asks faster than a page" });
      let asking = true;
      const outcomes = new Set();
      const hammer = (async () => {
        while (asking) {
          outcomes.add(await agent.enrol().catch((e) => e.message));
          await sleep(5);
        }
      })();
      await sleep(200);
      writeFileSync(resetPath, `${ctx.pageKey}\n`);
      const after = await waitFor(() => signer.state(), (st) => st.keys.length === 1 && st.keys[0].fingerprint === ctx.pageKey, 30_000, 250);
      await sleep(1000);
      asking = false;
      await hammer;
      check(after.keys.length === 1 && after.keys[0].fingerprint === ctx.pageKey && after.keys[0].how === "first", `a reset file that names the page's key clears every key and enrols only that one (${after.keys.map((k) => k.fingerprint).join(", ")})`);
      check([...outcomes].join(",") === "pending" && !(await agent.enrolled()), `a key that asked throughout, before the page could, only waits (its answers: ${[...outcomes].join(", ")})`);
      await page.waitFor("!document.querySelector('[data-egg-signing]')", { timeout: 15000, label: "the page is enrolled again by itself" });
      // The script's own key went with the reset: it asks again, and the page approves it.
      signer = await enrolledSigner({
        bb,
        plugin,
        approve: async (fingerprint) => {
          // The agent's request is older, so it is asked about first: X refuses it.
          await page.waitFor(`document.querySelector('[data-egg-key-request]')?.dataset.eggKeyRequest === ${JSON.stringify(agent.fingerprint)}`, { label: "the agent's request shows first" });
          // With no room yet, the page opened its new-room form on being enrolled: keys go to the form until it is closed.
          await closeNewRoomForm(page);
          await focusRoot(page);
          await page.key("X");
          await page.waitFor(`document.querySelector('[data-egg-key-request]')?.dataset.eggKeyRequest === ${JSON.stringify(fingerprint)}`, { label: "then the script's" });
          await page.key("A");
          await page.waitFor("!!document.querySelector('[data-egg-confirm-approve]')", { label: "the page asks before approving" });
          await page.key("y");
        },
      });
      check(await signer.enrolled(), "the page, enrolled again, refuses that key (X) and approves the script's new one (A, y)");
      await rpc("key_remove", { fingerprint: agent.fingerprint });
    }

    // A page whose clock is wrong still signs by egg's clock: p pins and unpins.
    if (hadRoom && (await selectFirstDone(page))) {
      await page.eval("(() => { const real = Date.now.bind(Date); window.__eggRealNow = real; Date.now = () => real() - 10 * 60_000; })()");
      await focusRoot(page);
      await page.key("p");
      const pinned = await page.waitFor("!!document.querySelector('[data-egg-pin]')", { timeout: 15000, label: "pinned with the clock off" }).then(() => true, () => false);
      check(pinned, "with the page's clock ten minutes off, p still pins: the page reads egg's clock and signs again");
      await page.key("p");
      await page.waitFor("!document.querySelector('[data-egg-pin]')", { timeout: 15000, label: "unpinned" }).catch(() => undefined);
      await page.eval("Date.now = window.__eggRealNow");
      check((await unsentLines(page)).length === 0, "and nothing is said in the notebook for it");
    } else console.log("(skipped the clock check: it pins a finished view, so it needs a room with one)");
  },

  // ---- The probe: every signed action, tried without the person's key.
  async probe() {
    if (plugin === "egg") return console.log("(skipped probe: it runs against a copy for checks only)");
    if (!ctx.parentRoomId) return console.log("(skipped probe: it aims at a room, so it needs new or --room)");
    const room = (await waitFor(() => rpc("room_get", { roomId: ctx.parentRoomId }), (r) => Object.values(r.room?.views ?? {}).every((v) => v.status === "done" || v.status === "failed"), 120_000)).room;
    const done = Object.values(room.views).filter((v) => v.status === "done").map((v) => v.id);
    if (done.length < 2) return check(false, "the probe needs a room with two finished views");
    const fixture = { roomId: room.id, viewId: done[0], viewId2: done[1], folder: room.folder, keyFingerprint: "0000-0000-0000-0000" };
    const before = await snapshot(signer, filesUnder);
    let report = null;
    if (probeDir) {
      mkdirSync(probeDir, { recursive: true });
      console.log(`   waiting for an attacker elsewhere: node scripts/probe.mjs --plugin ${plugin} --dir ${probeDir} --sandboxed`);
      for (let round = 0; round < 20 && !report; round++) {
        const material = await prepare(signer, fixture);
        writeFileSync(join(probeDir, "material.json"), JSON.stringify(material));
        const file = join(probeDir, `attack-${material.id}.json`);
        // An attacker that took this material is given time to finish with it.
        for (let i = 0; i < 180 && !report; i++) {
          if (existsSync(file)) report = JSON.parse(readFileSync(file, "utf8"));
          else if (i >= 30 && !existsSync(join(probeDir, `taken-${material.id}`))) break;
          else await sleep(1000);
        }
      }
      if (!report) return check(false, `no attacker reported in ${probeDir}`);
    } else {
      report = await attack({ bb, plugin, material: await prepare(signer, fixture), log: () => undefined });
    }
    // The attacker's own key is a request and nothing more; it is taken off again.
    const asked = (await signer.state()).requests.find((r) => r.fingerprint === report.attackerKey);
    check(asked?.status === "pending" && !(await signer.state()).keys.some((k) => k.fingerprint === report.attackerKey), `the attacker's own key ${report.attackerKey} became a request the person sees, and was not enrolled`);
    if (asked) await rpc("key_remove", { fingerprint: report.attackerKey });
    const kinds = {};
    for (const a of report.attempts) {
      const kind = /^[a-z_]+: /.test(a.what) ? a.what.slice(a.what.indexOf(": ") + 2).replace(/ \(.*\)$/, "") : a.what;
      kinds[kind] ??= { tried: 0, refused: 0, said: a.got };
      kinds[kind].tried++;
      if (a.ok) kinds[kind].refused++;
    }
    for (const [kind, k] of Object.entries(kinds)) check(k.refused === k.tried, `probe, ${kind}: ${k.refused} of ${k.tried} as expected ("${k.said.slice(0, 90)}")`);
    for (const w of report.wrong) check(false, `probe: ${w.what} → ${w.got} (expected: ${w.expected})`);
    check(report.accepted === null, `egg accepted none of the ${report.attempts.length} attempts${report.accepted ? ` (ACCEPTED: ${report.accepted})` : ""}${report.sandboxed ? ", made from inside an agent's sandbox" : ""}`);
    for (const o of report.outside ?? []) console.log(`   outside egg, ${o.blocked ? "blocked" : "OPEN"}: ${o.what}: ${o.result}`);
    const after = await snapshot(signer, filesUnder);
    check(after.text === before.text, `nothing changed: the ${before.rooms.length} room(s) with every line, round, view and pin, the ledgers, the files in the rooms' directories and the enrolled keys are as before (${before.text.length} characters compared)`);
    ctx.probe = { attempts: report.attempts.length, sandboxed: report.sandboxed, outside: report.outside };
  },

  // ---- A new room: the folder default and the list of checkouts, then round 1.
  async new(page) {
    if (!(await page.eval("!!document.querySelector('[data-egg-new-room]')"))) {
      await focusRoot(page);
      await page.key("n");
    }
    await page.waitFor("document.querySelector('[data-egg-folder]')?.value", { timeout: 30000, label: "the folder default" });
    const defaultFolder = await page.eval("document.querySelector('[data-egg-folder]').value");
    check(defaultFolder.length > 0, `the folder has a default (${defaultFolder})`);
    const checkouts = await count(page, "[data-egg-checkouts] [data-egg-checkout]");
    check(checkouts > 0, `bb's project checkouts are listed below the field (${checkouts})`);
    await page.eval("document.querySelector('[data-egg-folder]').focus()");
    await page.key("ArrowDown", { code: "ArrowDown" });
    const picked = await page.eval("({ value: document.querySelector('[data-egg-folder]').value, first: document.querySelector('[data-egg-checkout]').dataset.eggCheckout })");
    check(picked.value === picked.first, `Down picks the first checkout into the field (${picked.value})`);
    await page.eval(`(() => { const el = document.querySelector('[data-egg-folder]'); el.focus(); el.select(); })()`);
    await page.type(folder);
    await page.eval("document.querySelector('[data-egg-first-line]').focus()");
    const subject = `how is a round of views put together (e2e ${new Date().toISOString().slice(11, 19)})`;
    await page.type(subject);
    const t0 = Date.now();
    await page.key("Enter");
    await page.waitFor(subjectIs(subject), { label: "the room opens" });
    ctx.parentRoomId = await page.eval(`localStorage.getItem("egg:last-room")`);
    roomIds.push(ctx.parentRoomId);
    check(true, "the room opens with its first line as subject");
    timings.round = await waitRound(page, 1, 4, t0, "round 1");
    await shot(page, "1-round");
  },

  // ---- A view large, in a sandboxed frame, covering everything below the top bar.
  async large(page) {
    await selectFirstDone(page);
    await page.key("Enter");
    await page.waitFor("!!document.querySelector('[data-egg-large] iframe')", { label: "the large view" });
    const frame = await page.eval(`(() => { const f = document.querySelector('[data-egg-large] iframe'); return { sandbox: f.getAttribute('sandbox'), opaque: f.contentDocument === null }; })()`);
    check(frame.sandbox === "" && frame.opaque, "a view opens large in a sandboxed frame the page cannot reach into");
    const cover = await page.eval(covers("[data-egg-large]"));
    check(cover.ok, `the large view starts right below the top bar and covers the table and notebook (top ${cover.top}, bar ends ${cover.bar})`);
    await shot(page, "1-large");
    await page.key("Escape");
  },

  async keep(page) {
    await focusRoot(page);
    const before = await count(page, "[data-egg-kept] [data-egg-card]");
    if (!(await selectedId(page))) await selectFirstDone(page);
    await page.key("y");
    await page.waitFor(`document.querySelectorAll('[data-egg-kept] [data-egg-card]').length === ${before + 1}`, { label: "kept" });
    check(true, "y keeps the view");
  },

  // ---- The round's timing line.
  async timing(page) {
    const n = await roundNumber(page);
    const timed = (await lines(page)).filter((l) => /\d+ (of \d+ )?views? · \d+ s$/.test(l));
    check(timed.length >= 1, `a finished round's notebook line says how many views and how long (${timed.join(" | ")}; round ${n} on the table)`);
  },

  // ---- m: more like this.
  async more(page) {
    const first = await selectFirstDone(page);
    const firstAngle = await page.eval(`document.querySelector('[data-egg-card="${first}"] .egg-angle').textContent`);
    const n = (await roundNumber(page)) + 1;
    await focusRoot(page);
    const t0 = Date.now();
    await page.key("m");
    timings.more = await waitRound(page, n, 4, t0, "m");
    const axes = await page.eval(`${cardsOnTable}.map((c) => c.dataset.eggAxis)`);
    check(axes.every(Boolean) && new Set(axes.map((a) => a.toLowerCase())).size === 4, `m: four cards on four different named axes: ${axes.join(" · ")}`);
    const angles = await page.eval(`${cardsOnTable}.map((c) => c.querySelector('.egg-angle').textContent)`);
    check(true, `m: the variations are ${angles.join(" · ")}`);
    check((await lines(page)).some((l) => l.includes(`more like "${firstAngle}"`)), `m: the notebook says more like "${firstAngle}"`);
    const lineage = await page.eval(`${cardsOnTable}[0].querySelector('[data-egg-lineage]')?.textContent ?? ''`);
    check(lineage.startsWith("axis: ") && lineage.includes(firstAngle), `m: each card shows its axis and parent (${lineage})`);
    check(!(await lines(page)).some((l) => /egg added \d of its own/.test(l)), "m: the planner gave four distinct axes itself");
    await focusRoot(page);
    await page.key("b");
    await sleep(300);
    const parentsShown = await page.eval(`${cardsOnTable}[0].querySelector('[data-egg-parents] li')?.textContent ?? ''`);
    check(parentsShown.includes("varied from") && parentsShown.includes(firstAngle) && parentsShown.includes(`round ${n - 1}`), `m: "built from" names the parent above the files (${parentsShown})`);
    await page.key("b");
    await shot(page, "2-more");
  },

  // ---- v, v, c: mark two and compare.
  async compare(page) {
    ctx.markA = ctx.markB = null;
    await markTwo(page);
    // On the table only: a kept view marked there shows its mark in the kept strip too.
    const marks = await page.eval(`[...document.querySelectorAll('[data-egg-cards] [data-egg-mark]')].filter((c) => c.dataset.eggMark).map((c) => [c.dataset.eggCard, c.dataset.eggMark])`);
    check(JSON.stringify(marks) === JSON.stringify([[ctx.markA, "A"], [ctx.markB, "B"]]), `v marks two views, A then B (${JSON.stringify(marks)})`);
    await page.key("c");
    await page.waitFor("document.querySelectorAll('[data-egg-compare] [data-egg-compare-side] iframe').length === 2", { label: "compare" });
    const sides = await page.eval("[...document.querySelectorAll('[data-egg-compare-side]')].map((s) => s.dataset.eggCompareSide)");
    check(JSON.stringify(sides) === JSON.stringify([ctx.markA, ctx.markB]), "c opens the two marked views side by side");
    const cover = await page.eval(covers("[data-egg-compare]"));
    check(cover.ok, `the comparison starts right below the top bar and covers the table and notebook (top ${cover.top}, bar ends ${cover.bar})`);
    await shot(page, "3-compare");
    await page.key("Escape");
    check(!(await page.eval("!!document.querySelector('[data-egg-compare]')")), "Escape closes the comparison");
  },

  // ---- x: cross them.
  async cross(page) {
    await markTwo(page);
    const angleA = await page.eval(`document.querySelector('[data-egg-card="${ctx.markA}"] .egg-angle').textContent`);
    const angleB = await page.eval(`document.querySelector('[data-egg-card="${ctx.markB}"] .egg-angle').textContent`);
    const n = (await roundNumber(page)) + 1;
    await focusRoot(page);
    const t0 = Date.now();
    await page.key("x");
    timings.cross = await waitRound(page, n, 2, t0, "x");
    check((await lines(page)).some((l) => l.includes(`cross "${angleA}" × "${angleB}"`)), `x: the notebook says cross "${angleA}" × "${angleB}"`);
    const lineage = await page.eval(`${cardsOnTable}.map((c) => c.querySelector('[data-egg-lineage]')?.textContent ?? '')`);
    check(lineage.every((l) => l.includes(`A: ${angleA}`) && l.includes(`B: ${angleB}`)), `x: each card names both parents (${lineage.join(" | ")})`);
    const ways = await page.eval(`${cardsOnTable}.map((c) => c.dataset.eggAxis)`);
    check(ways.every(Boolean) && new Set(ways).size === 2, `x: two different ways (${ways.join(" · ")})`);
    const crossIds = await page.eval(`${cardsOnTable}.filter((c) => c.dataset.eggStatus === 'done').map((c) => c.dataset.eggCard)`);
    for (const id of crossIds) {
      const content = await rpc("view_content", { roomId: ctx.parentRoomId, viewId: id });
      const labels = ["[A]", "[B]", "[A+B]"].filter((l) => content?.content.includes(l));
      check(labels.length >= 2, `x: crossed view ${id} labels its parts (${labels.join(" ")})`);
    }
    ctx.markA = ctx.markB = null;
    await shot(page, "4-cross");
  },

  // ---- z: zoom into a part of a view, then keep in the child room.
  async zoom(page) {
    const n = await roundNumber(page);
    ctx.subject = await page.eval("document.querySelector('[data-egg-subject]').textContent");
    ctx.zoomFrom = await selectFirstDone(page);
    ctx.zoomRound = n;
    await page.key("z");
    const zoomInput = await page.eval("document.activeElement?.dataset?.eggLineInput !== undefined ? document.activeElement.placeholder : null");
    check(Boolean(zoomInput?.startsWith("zoom into")), `z opens the line input asking "zoom into…" (${zoomInput?.slice(0, 40)})`);
    const part = "how the planning step's reply is parsed";
    await page.type(part);
    const t0 = Date.now();
    await page.key("Enter");
    await page.waitFor(subjectIs(part), { label: "the child room" });
    ctx.childRoomId = await page.eval(`localStorage.getItem("egg:last-room")`);
    roomIds.push(ctx.childRoomId);
    check(ctx.childRoomId !== ctx.parentRoomId, "z makes a child room about the part, and opens it");
    check(await page.eval(`document.querySelector('[data-egg-parent-room]')?.dataset.eggParentRoom === ${JSON.stringify(ctx.parentRoomId)}`), "the child room shows its parent");
    timings.zoom = await waitRound(page, 1, 4, t0, "z");
    await focusRoot(page);
    await page.key("b");
    await sleep(300);
    const zoomParents = await page.eval(`${cardsOnTable}[0].querySelector('[data-egg-parents] li')?.textContent ?? ''`);
    check(zoomParents.includes("zoomed from") && zoomParents.includes(`round ${n} of`), `z: the child's views name the view they were zoomed from (${zoomParents})`);
    await page.key("b");

    await selectFirstDone(page);
    await page.key("y");
    await page.waitFor("document.querySelectorAll('[data-egg-kept] [data-egg-card]').length === 1", { label: "kept in the child room" });
    await sleep(1500);
    const childDir = await page.eval("document.querySelector('[data-egg-room-dir]').textContent.replace(/^keeps to /, '')");
    ctx.keptPath = (await lines(page)).find((t) => t.includes("Kept"))?.split("→ ")[1]?.trim() ?? null;
    let record = null;
    try {
      record = JSON.parse(readFileSync(ctx.keptPath.replace(/\.(html|txt)$/, ".json"), "utf8"));
    } catch {}
    check(Boolean(ctx.keptPath && existsSync(ctx.keptPath) && ctx.keptPath.startsWith(childDir)), `keep in the child room writes to its own directory (${ctx.keptPath})`);
    check(record?.room?.parent?.roomId === ctx.parentRoomId && record?.room?.parent?.viewId === ctx.zoomFrom && record?.parents?.[0]?.viewId === ctx.zoomFrom, `and its JSON names the parent room and view (${JSON.stringify(record?.room?.parent)})`);
  },

  // ---- p, then a line.
  async pin(page) {
    const roomId = await page.eval(`localStorage.getItem("egg:last-room")`);
    const n = (await roundNumber(page)) + 1;
    await focusRoot(page);
    await page.key("0");
    const pinned = await selectedId(page);
    const pinnedRound = n - 1;
    await page.key("p");
    await page.waitFor(`document.querySelector('[data-egg-pin]')?.dataset.eggPin === ${JSON.stringify(pinned)}`, { label: "the pin" });
    check(true, "p pins the view and the top bar shows it");
    await page.key("i");
    await page.type("where does a failed planning step leave the round");
    const t0 = Date.now();
    await page.key("Enter");
    await page.waitFor(`document.querySelector('.egg-round-head')?.textContent.startsWith('round ${n} of')`, { label: "the pinned round" });
    check((await lines(page)).some((l) => new RegExp(`with pinned ".*" \\(round ${pinnedRound}\\) as reference`).test(l)), "the notebook shows the line went in with the pin");
    timings.pinned = await waitRound(page, n, 4, t0, "p then a line");
    const room = (await rpc("room_get", { roomId })).room;
    check(room.rounds.at(-1).parents?.some((p) => p.viewId === pinned && p.role === "pinned"), "the round records the pinned view as a parent");
    await shot(page, "5-child");
  },

  // ---- -: back up, at the view it was zoomed from.
  async up(page) {
    if (!ctx.childRoomId) return console.log("(skipped up: it needs zoom in the same run)");
    await collectThreads(ctx.childRoomId);
    await focusRoot(page);
    await page.key("-");
    await page.waitFor(subjectIs(ctx.subject), { label: "the parent room" });
    await sleep(800);
    check((await selectedId(page)) === ctx.zoomFrom && (await roundNumber(page)) === ctx.zoomRound, "- goes up to the parent room, on the view it was zoomed from");
  },

  // ---- The room thread: a line that asks for work, end to end.
  async work(page) {
    const workLine = "run the unit tests five times and show me which tests are slowest and how much they vary";
    const gitBefore = gitState(folder);
    check(!existsSync(join(folder, ".egg")), `the folder has no .egg/ before (${folder})`);
    await focusRoot(page);
    await page.key("n");
    await page.waitFor("!!document.querySelector('[data-egg-folder]')", { label: "the new-room form" });
    await page.eval(`(() => { const el = document.querySelector('[data-egg-folder]'); el.focus(); el.select(); })()`);
    await page.type(folder);
    await page.eval("document.querySelector('[data-egg-first-line]').focus()");
    await page.type(workLine);
    await page.key("Enter");
    await page.waitFor(subjectIs(workLine), { label: "the work room opens" });
    const roomId = await page.eval(`localStorage.getItem("egg:last-room")`);
    roomIds.push(roomId);
    ctx.workRoomId = roomId;
    await page.waitFor("[...document.querySelectorAll('[data-egg-line] .egg-line-text')].some((l) => /^To the room thread/.test(l.textContent))", { timeout: 60000, label: "routed to the room thread" });
    check(true, "the planning step routes the line to the room thread, and the notebook says so");
    await page.waitFor("!!document.querySelector('[data-egg-worker]')", { timeout: 60000, label: "the status line" });
    check(true, "the room thread's status line is on the page");
    await waitWatching(page, "document.querySelector('[data-egg-worker]')?.dataset.eggWorkerState === 'running'", 5 * 60_000, "the room thread running");
    const room1 = (await rpc("room_get", { roomId })).room;
    check(room1.worker?.kind === "clone" && room1.worker.workspace.includes("/clones/"), `it works in a clone (${room1.worker?.workspace})`);
    check((await count(page, "[data-egg-cards] [data-egg-card]")) === 0, "no four views for a work line");
    await shot(page, "w1-running");
    // A note, then a page of its own, then idle.
    await waitWatching(page, "document.querySelectorAll('[data-egg-line=note]').length > 0", 20 * 60_000, "a note from the room thread");
    check(true, `a note from the room thread lands in the notebook (${(await page.eval("document.querySelector('[data-egg-line=note]').textContent"))})`);
    await waitWatching(page, "!!document.querySelector('[data-egg-work-round]') && document.querySelectorAll('[data-egg-cards] [data-egg-card]').length > 0", 30 * 60_000, "a page from the room thread");
    await page.key("b");
    await sleep(500);
    const pageView = (await rpc("room_get", { roomId })).room;
    const workRound = pageView.rounds.filter((r) => r.kind === "work").at(-1);
    const made = workRound.viewIds.map((id) => pageView.views[id]);
    const ledgerBuilt = made.flatMap((v) => v.builtFrom.filter((b) => b.kind === "ledger"));
    check(ledgerBuilt.length > 0, `a page the room thread made lands, and its "built from" names ledger entries (${ledgerBuilt.map((b) => b.what.split(" · ")[0]).join(", ")}${ledgerBuilt.some((b) => b.unconfirmed) ? "; some not confirmed by its events" : ""})`);
    check(await page.eval("[...document.querySelectorAll('[data-egg-built-from] .egg-built-kind')].some((k) => k.textContent === 'ledger')"), "the page shows ledger entries in built from");
    await shot(page, "w2-page");
    await page.key("b");
    await waitWatching(page, "document.querySelector('[data-egg-worker]')?.dataset.eggWorkerState === 'idle'", 30 * 60_000, "the room thread idle");
    check(seenStates.some((s) => s.state === "running") && seenStates.at(-1).state === "idle", `the status line showed running, then idle (${seenStates.map((s) => s.state).join(" → ")})`);
    await runsOutliveTheTurn(page, roomId);
    // A look line: its views run in the room thread's environment and cite the ledger.
    await focusRoot(page);
    await page.key("i");
    await page.type("draw a map of where the slowest of those tests live in the source, and what they exercise");
    const n = (await rpc("room_get", { roomId })).room.rounds.length + 1;
    const t0 = Date.now();
    await page.key("Enter");
    await waitRound(page, n, 4, t0, "look round");
    const look = (await rpc("room_get", { roomId })).room;
    const lookViews = look.rounds.at(-1).viewIds.map((id) => look.views[id]);
    const citing = lookViews.filter((v) => (v.ledger ?? []).length > 0 && v.builtFrom[0]?.kind === "ledger");
    check(lookViews.every((v) => v.ledger !== undefined), "the look line's views ran in the room thread's environment");
    check(citing.length >= 1, `views of a following look line cite the ledger above their own commands (${citing.length} of ${lookViews.length}: ${citing.map((v) => v.ledger.join("+")).join(", ")})`);
    await shot(page, "w3-look");
    // Stop: give it something long, then S, y.
    await focusRoot(page);
    await page.key("w");
    await page.type("now run the whole test suite twenty more times, one after another, as a single detached run through egg's runner, and keep an eye on it");
    await page.key("Enter");
    await waitWatching(page, "document.querySelector('[data-egg-worker]')?.dataset.eggWorkerState === 'running'", 5 * 60_000, "running again");
    const openBefore = await waitFor(async () => (await ledgerOf(roomId)).filter((e) => e.state === "running"), (o) => o.length > 0, 4 * 60_000);
    check(openBefore.length > 0, `before the stop, egg's ledger has open runs (${openBefore.map((e) => `${e.id} pid ${e.pid}`).join(", ")})`);
    await focusRoot(page);
    await page.key("S");
    await page.waitFor("!!document.querySelector('[data-egg-confirm-stop]')", { label: "the stop confirm" });
    check(true, "S asks to confirm the stop");
    await page.key("y");
    await waitWatching(page, "document.querySelector('[data-egg-worker]')?.dataset.eggWorkerState !== 'running' && [...document.querySelectorAll('[data-egg-line] .egg-line-text')].some((l) => /Stopped the room thread's turn/.test(l.textContent))", 3 * 60_000, "stopped");
    check(["idle", "failed"].includes(await workerState(page)) && (await lines(page)).some((l) => /Stopped the room thread's turn/.test(l)), `y stops its turn (now ${await workerState(page)})`);
    const stoppedAt = Date.now();
    await sleep(25_000);
    const afterStop = await ledgerOf(roomId);
    for (const e of openBefore) {
      const now = afterStop.find((x) => x.id === e.id);
      check(now?.state === "stopped" && procAlive(e.pid) === false, `${e.id} is marked stopped and its process is gone (${now?.state}, alive ${procAlive(e.pid)})`);
    }
    check((await lines(page)).some((l) => new RegExp(`its open runs? ${openBefore.map((e) => e.id).join(", ")}`).test(l)), "the stop line names the runs it stopped");
    await sleep(Math.max(0, 90_000 - (Date.now() - stoppedAt)));
    const wokeAfter = (await rpc("room_get", { roomId })).room.lines.filter((l) => /^Woke the room thread/.test(l.text) && l.at > stoppedAt);
    check(wokeAfter.length === 0 && (await workerState(page)) !== "running", `nothing wakes it for 90 s after the stop (${wokeAfter.length} wakes, now ${await workerState(page)})`);
    // The chat pane: opens beside the table without taking the keyboard; i types in it; Escape gives it back, then closes it.
    await focusRoot(page);
    await page.key("t");
    await page.waitFor("!!document.querySelector('[data-egg-chat-pane]')", { label: "the chat pane" });
    await sleep(3500);
    const keptFocus = await page.eval("document.activeElement === document.querySelector('[data-egg-root]') || !document.querySelector('[data-egg-chat]').contains(document.activeElement)");
    check(keptFocus, "t opens the room thread's chat in a pane, and the page keeps the keyboard");
    await shot(page, "w4-chat");
    await page.key("i");
    await sleep(1500);
    check(await page.eval("document.querySelector('[data-egg-chat]').contains(document.activeElement)"), "i with the chat open puts the keyboard in the chat");
    await page.key("Escape");
    await sleep(300);
    await page.key("Escape");
    await page.waitFor("!document.querySelector('[data-egg-chat-pane]')", { label: "the pane closes" });
    check(true, "Escape gives the keyboard back, then closes the pane");
    // Material on disk; the original folder untouched.
    const final = (await rpc("room_get", { roomId })).room;
    const material = join(final.dir, "material");
    check(existsSync(join(material, "ledger.jsonl")) && existsSync(join(material, "notes.jsonl")), `material is on disk in the room's directory (${material})`);
    check(!existsSync(join(folder, ".egg")), "the original folder has no .egg/");
    check(gitState(folder) === gitBefore, "the original folder has no changes (git status as before)");
    ctx.workMaterial = material;
    console.log(JSON.stringify({ seenStates, workspace: final.worker?.workspace, roomThread: final.worker?.threadId, material }, null, 2));
  },

  // ---- A room whose first line is work, and stopping its room thread: the planning step, the room thread, S and y, all through the signed path.
  async workstop(page) {
    if (!folder) return console.log("(skipped workstop: it makes a room, so it needs --folder: a git checkout, not a linked worktree)");
    const text = "measure how long `sleep 45` takes to run";
    await closeNewRoomForm(page);
    await focusRoot(page);
    await page.key("n");
    await page.waitFor("!!document.querySelector('[data-egg-folder]')", { label: "the new-room form" });
    await page.eval(`(() => { const el = document.querySelector('[data-egg-folder]'); el.focus(); el.select(); })()`);
    await page.type(folder);
    await page.eval("document.querySelector('[data-egg-first-line]').focus()");
    await page.type(text);
    await page.key("Enter");
    await page.waitFor(subjectIs(text), { label: "the room opens" });
    const roomId = await page.eval(`localStorage.getItem("egg:last-room")`);
    roomIds.push(roomId);
    const noteStarting = (start) => `([...document.querySelectorAll('[data-egg-line] .egg-line-text')].find((l) => l.textContent.startsWith(${JSON.stringify(start)}))?.textContent ?? null)`;
    await page.waitFor(`${noteStarting("To the room thread")} || ${noteStarting("No room thread")} || document.querySelectorAll('[data-egg-cards] [data-egg-card]').length > 0`, { timeout: 90000, label: "the line is routed" });
    check(!!(await page.eval(noteStarting("To the room thread"))), `the planning step routes the line to the room thread (${(await lines(page)).at(-1)?.slice(0, 160)})`);
    await page.waitFor(`!!document.querySelector('[data-egg-worker]') || ${noteStarting("No room thread")}`, { timeout: 180000, label: "the status line" });
    const none = await page.eval(noteStarting("No room thread"));
    if (none) return check(false, `no room thread could start on ${folder}: ${none}`);
    const room = (await rpc("room_get", { roomId })).room;
    check(!!room.worker?.threadId, `a room thread started for it (${room.worker?.threadId}, in a ${room.worker?.kind})`);
    await waitWatching(page, "document.querySelector('[data-egg-worker]')?.dataset.eggWorkerState === 'running'", 5 * 60_000, "the room thread running");
    await focusRoot(page);
    await page.key("S");
    await page.waitFor("!!document.querySelector('[data-egg-confirm-stop]')", { label: "the stop confirmation" });
    await page.key("y");
    await page.waitFor(noteStarting("Stopped the room thread's turn"), { timeout: 90000, label: "the stop in the notebook" });
    check(true, `S then y stops its turn, and the notebook says so ("${(await page.eval(noteStarting("Stopped the room thread's turn"))).slice(0, 80)}…")`);
    check((await rpc("room_get", { roomId })).room.worker?.held === true, "egg holds it until the next work line");
    check((await unsentLines(page)).length === 0, "nothing was refused on the way");
    await collectThreads(roomId);
  },

  // ---- The room list, and deleting the test rooms.
  async rooms(page) {
    if (!ctx.childRoomId || !roomIds.includes(ctx.parentRoomId)) return console.log("(skipped rooms: it deletes rooms this run made, so it needs new and zoom)");
    const { parentRoomId, childRoomId } = ctx;
    await collectThreads(parentRoomId);
    await focusRoot(page);
    await page.key("r");
    await page.waitFor("!!document.querySelector('[data-egg-rooms]')", { label: "the room list" });
    const order = await page.eval("[...document.querySelectorAll('[data-egg-room]')].map((li) => [li.dataset.eggRoom, li.dataset.eggDepth])");
    const pi = order.findIndex(([id]) => id === parentRoomId);
    check(pi >= 0 && order[pi + 1]?.[0] === childRoomId && order[pi + 1]?.[1] === "1", "the room list shows the child indented under its parent");
    await shot(page, "6-rooms");
    const moveTo = async (id) => {
      const at = await page.eval(`[...document.querySelectorAll('[data-egg-room]')].findIndex((li) => li.dataset.eggRoom === ${JSON.stringify(id)})`);
      const sel = await page.eval("[...document.querySelectorAll('[data-egg-room]')].findIndex((li) => li.classList.contains('egg-selected'))");
      for (let k = 0; k < Math.abs(at - sel); k++) await page.key(at > sel ? "j" : "k");
    };
    await moveTo(childRoomId);
    await page.key("D");
    await sleep(300);
    check(!(await page.eval(`!!document.querySelector('[data-egg-room="${childRoomId}"]')`)), "D deletes the child room at once");
    await page.key("u");
    await page.waitFor(`!!document.querySelector('[data-egg-room="${childRoomId}"]')`, { label: "undo delete" });
    check(true, "u puts it back");
    await sleep(500);
    // Delete the parent first: its child must stay, at the top level.
    await moveTo(parentRoomId);
    await page.key("D");
    await page.waitFor(`!document.querySelector('[data-egg-room="${parentRoomId}"]') && document.querySelector('[data-egg-room="${childRoomId}"]')?.dataset.eggDepth === "0"`, { label: "parent deleted, child at top level" });
    check(true, "deleting the parent leaves the child, at the top level");
    await moveTo(childRoomId);
    await page.key("D");
    await sleep(1500);
    await page.key("Escape");
    const left = (await rpc("rooms_list", null)).rooms.map((r) => r.id);
    check(!left.includes(parentRoomId) && !left.includes(childRoomId), "both test rooms are deleted");
    if (ctx.keptPath) check(existsSync(ctx.keptPath), "their kept files stay on disk");
  },
};

const chrome = await launchChrome(9358);
try {
  // A copy for checks starts with no key enrolled, so the test browser is the first to ask.
  if (plugin !== "egg") {
    const was = await resetEnrolment({ bb, plugin });
    console.log(`(enrolment of ${plugin} reset with ${was.resetPath}: ${was.cleared} key(s) cleared)`);
  }
  const page = await firstPage(chrome.port);
  await page.goto(pageUrl, 5000);
  if (reuse) await page.eval(`localStorage.setItem("egg:last-room", ${JSON.stringify(reuse)})`);
  else await page.eval(`localStorage.removeItem("egg:last-room")`);
  await page.goto(pageUrl, 5000);
  await page.waitFor("!!document.querySelector('[data-egg-root]')", { timeout: 60000, label: "the egg page" });
  console.log("-- enrol");
  await enrol(page);
  if (reuse) {
    await page.waitFor(`!!document.querySelector('[data-egg-subject]') && ${allSettled}`, { timeout: 60000, label: "the reused room with a finished round" });
    check(true, `reusing room ${reuse}`);
  }
  for (const name of SECTIONS) {
    if (!wanted.has(name)) continue;
    console.log(`-- ${name}`);
    await steps[name](page);
  }
  check(page.errors.length === 0, `no page errors (${page.errors.join(" | ")})`);
  page.close();
} catch (e) {
  check(false, `stopped: ${e.message}`);
} finally {
  await chrome.stop();
  // Whatever happened, the rooms this run made go (their view threads are archived with them), unless they are kept.
  if (keepRooms) console.log(`(kept for a later run: ${roomIds.map((id) => `--room ${id}`).join(", ") || "no room"})`);
  for (const id of keepRooms ? [] : roomIds) {
    await collectThreads(id);
    try {
      const listed = (await rpc("rooms_list", null)).rooms.some((r) => r.id === id);
      if (listed) {
        await rpc("room_delete", { roomId: id });
        console.log(`(deleted test room ${id} after the run)`);
      }
    } catch (e) {
      console.log(`(could not delete test room ${id}: ${e.message})`);
    }
  }
  if (reuse) await collectThreads(reuse);
}
const secs = (t) => (t ? { planned: `${(t.planned / 1000).toFixed(1)} s`, total: `${(t.total / 1000).toFixed(1)} s` } : null);
console.log(JSON.stringify({ sections: ["enrol", ...SECTIONS.filter((s) => wanted.has(s))], probe: ctx.probe ?? null, timings: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, secs(v)])), rooms: roomIds, reused: reuse ?? null, viewThreads: [...viewThreads] }, null, 2));
console.log(failed ? "e2e FAILED" : "e2e passed");
process.exit(failed ? 1 : 0);
