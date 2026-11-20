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
//   rooms    the indented room list; delete the test rooms (D, u once)       0
//   work     a room whose first line asks for work: the room thread runs     ~9
//            it in a clone; notes, a page citing the ledger, a look line
//            whose views cite it, the status line, stop, the chat pane,
//            material on disk, and the folder untouched. Long: up to 40 min.
//
// All of it is 23 threads. To check one change with a handful, run a subset
// with --only, and reuse a room that already has a finished round with
// --room (from the room list, or kept from a run of scripts/round-timing.mjs
// --keep-room); "new" is then skipped. Sections run in the order above. A
// section that needs something an earlier one makes (up needs zoom, rooms
// needs new) is skipped with a note when that is missing. Rooms this run
// makes are deleted at the end; a room given with --room is left alone.
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
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { firstPage, launchChrome, sleep } from "./cdp.mjs";

const SECTIONS = ["new", "large", "keep", "timing", "more", "compare", "cross", "zoom", "pin", "up", "rooms", "work"];

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
const only = option("only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const unknown = (only ?? []).filter((s) => !SECTIONS.includes(s));
if (unknown.length || (!folder && !reuse)) {
  if (unknown.length) console.error(`unknown section(s): ${unknown.join(", ")}; sections are ${SECTIONS.join(", ")}`);
  console.error("usage: node scripts/e2e.mjs (--folder <absolute folder> | --room <room id>) [--only <section,...>] [--plugin <id>] [--shots <dir>]");
  process.exit(2);
}
const wanted = new Set((only ?? SECTIONS).filter((s) => !(reuse && s === "new")));
const pageUrl = `${bb}/plugins/${plugin}/egg`;
const rpc = async (method, input) => {
  const res = await fetch(`${bb}/api/v1/plugins/${plugin}/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(`${method}: ${JSON.stringify(body).slice(0, 300)}`);
  return body.result;
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
const roomIds = [];
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
const ctx = { parentRoomId: reuse ?? null, subject: null, childRoomId: null, zoomFrom: null, zoomRound: 0, keptPath: null, markA: null, markB: null };

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

const steps = {
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
    const marks = await page.eval(`[...document.querySelectorAll('[data-egg-mark]')].filter((c) => c.dataset.eggMark).map((c) => [c.dataset.eggCard, c.dataset.eggMark])`);
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
    await page.type("now run the whole test suite twenty more times in the background, one after another, recording each run in the ledger");
    await page.key("Enter");
    await waitWatching(page, "document.querySelector('[data-egg-worker]')?.dataset.eggWorkerState === 'running'", 5 * 60_000, "running again");
    await sleep(20000);
    await focusRoot(page);
    await page.key("S");
    await page.waitFor("!!document.querySelector('[data-egg-confirm-stop]')", { label: "the stop confirm" });
    check(true, "S asks to confirm the stop");
    await page.key("y");
    await waitWatching(page, "document.querySelector('[data-egg-worker]')?.dataset.eggWorkerState !== 'running' && [...document.querySelectorAll('[data-egg-line] .egg-line-text')].some((l) => /Stopped the room thread's turn/.test(l.textContent))", 3 * 60_000, "stopped");
    check(["idle", "failed"].includes(await workerState(page)) && (await lines(page)).some((l) => /Stopped the room thread's turn/.test(l)), `y stops its turn (now ${await workerState(page)})`);
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
  const page = await firstPage(chrome.port);
  await page.goto(pageUrl, 5000);
  if (reuse) await page.eval(`localStorage.setItem("egg:last-room", ${JSON.stringify(reuse)})`);
  else await page.eval(`localStorage.removeItem("egg:last-room")`);
  await page.goto(pageUrl, 5000);
  await page.waitFor("!!document.querySelector('[data-egg-root]')", { timeout: 60000, label: "the egg page" });
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
  // Whatever happened, the rooms this run made go (their view threads are archived with them).
  for (const id of roomIds) {
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
console.log(JSON.stringify({ sections: SECTIONS.filter((s) => wanted.has(s)), timings: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, secs(v)])), rooms: roomIds, reused: reuse ?? null, viewThreads: [...viewThreads] }, null, 2));
console.log(failed ? "e2e FAILED" : "e2e passed");
process.exit(failed ? 1 : 0);
