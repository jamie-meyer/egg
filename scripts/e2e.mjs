// End-to-end check of the egg page against a running bb, in a separate
// headless Chrome (never your own bb window).
//
// It makes one room on the folder you give it and walks through a working
// session: a round; more like this (m); marking two views and comparing
// them (v, c); crossing them (x); zooming into a part (z), which makes a
// child room with its own first round; keeping a view there; pinning a view
// (p) and saying a line with it pinned; going back up (-); the indented room
// list; and deleting the test rooms (D, with u to undo once).
//
// Threads: five rounds, which is 4 + 4 + 2 + 4 + 4 view threads and five
// planning threads, 23 in all. Set the plugin's "Thread title prefix"
// setting to "egg test" first so they are easy to find, and its rooms
// directory to a scratch folder. Deleting the rooms archives their view
// threads; the planning threads are archived as each answers. The script
// prints every view thread id so you can check.
//
//   node scripts/e2e.mjs --folder <absolute folder> [--plugin egg] [--bb http://127.0.0.1:38886] [--shots <dir>]
//
// --plugin is the plugin id egg is installed under (for a test copy
// installed beside the real one, for example). Needs Chrome; run it outside
// any command sandbox.
import { existsSync, readFileSync } from "node:fs";
import { firstPage, launchChrome, sleep } from "./cdp.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const bb = option("bb", "http://127.0.0.1:38886");
const plugin = option("plugin", "egg");
const folder = option("folder");
const shots = option("shots");
if (!folder) {
  console.error("usage: node scripts/e2e.mjs --folder <absolute folder> [--plugin <id>] [--shots <dir>]");
  process.exit(2);
}
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
const lines = (page) => page.eval("[...document.querySelectorAll('[data-egg-line]')].map((l) => l.textContent)");

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
const roomIds = [];
async function collectThreads(roomId) {
  try {
    const { room } = await rpc("room_get", { roomId });
    for (const v of Object.values(room?.views ?? {})) if (v.threadId) viewThreads.add(v.threadId);
  } catch (e) {
    console.log(`(could not list threads of ${roomId}: ${e.message})`);
  }
}

const chrome = await launchChrome(9358);
try {
  const page = await firstPage(chrome.port);
  await page.goto(pageUrl, 5000);
  await page.eval(`localStorage.removeItem("egg:last-room")`);
  await page.goto(pageUrl, 5000);
  await page.waitFor("!!document.querySelector('[data-egg-root]')", { timeout: 60000, label: "the egg page" });

  // ---- A new room: the folder default and the list of checkouts.
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
  let t0 = Date.now();
  await page.key("Enter");
  await page.waitFor(`document.querySelector('[data-egg-subject]')?.textContent === ${JSON.stringify(subject)}`, { label: "the room opens" });
  const parentRoomId = await page.eval(`localStorage.getItem("egg:last-room")`);
  roomIds.push(parentRoomId);
  check(true, "the room opens with its first line as subject");

  // ---- Round 1.
  timings.round = await waitRound(page, 1, 4, t0, "round 1");
  await shot(page, "1-round");
  const first = await selectFirstDone(page);
  await page.key("Enter");
  await page.waitFor("!!document.querySelector('[data-egg-large] iframe')", { label: "the large view" });
  const frame = await page.eval(`(() => { const f = document.querySelector('[data-egg-large] iframe'); return { sandbox: f.getAttribute('sandbox'), opaque: f.contentDocument === null }; })()`);
  check(frame.sandbox === "" && frame.opaque, "a view opens large in a sandboxed frame the page cannot reach into");
  await page.key("Escape");
  await page.key("y");
  await page.waitFor("document.querySelectorAll('[data-egg-kept] [data-egg-card]').length === 1", { label: "kept in round 1" });

  // ---- m: more like this.
  await focusRoot(page);
  const firstAngle = await page.eval(`document.querySelector('[data-egg-card="${first}"] .egg-angle').textContent`);
  t0 = Date.now();
  await page.key("m");
  timings.more = await waitRound(page, 2, 4, t0, "m");
  const axes = await page.eval(`${cardsOnTable}.map((c) => c.dataset.eggAxis)`);
  check(axes.every(Boolean) && new Set(axes.map((a) => a.toLowerCase())).size === 4, `m: four cards on four different named axes: ${axes.join(" · ")}`);
  const angles2 = await page.eval(`${cardsOnTable}.map((c) => c.querySelector('.egg-angle').textContent)`);
  check(true, `m: the variations are ${angles2.join(" · ")}`);
  check((await lines(page)).some((l) => l.includes(`more like "${firstAngle}"`)), `m: the notebook says more like "${firstAngle}"`);
  const lineage2 = await page.eval(`${cardsOnTable}[0].querySelector('[data-egg-lineage]')?.textContent ?? ''`);
  check(lineage2.startsWith("axis: ") && lineage2.includes(firstAngle), `m: each card shows its axis and parent (${lineage2})`);
  check(!(await lines(page)).some((l) => /egg added \d of its own/.test(l)), "m: the planner gave four distinct axes itself");
  await focusRoot(page);
  await page.key("b");
  await sleep(300);
  const parentsShown = await page.eval(`${cardsOnTable}[0].querySelector('[data-egg-parents] li')?.textContent ?? ''`);
  check(parentsShown.includes("varied from") && parentsShown.includes(firstAngle) && parentsShown.includes("round 1"), `m: "built from" names the parent above the files (${parentsShown})`);
  await page.key("b");
  await shot(page, "2-more");

  // ---- v, v, c: mark two and compare.
  await focusRoot(page);
  await page.key("0");
  const markA = await selectedId(page);
  await page.key("v");
  await page.key("l");
  const markB = await selectedId(page);
  await page.key("v");
  const marks = await page.eval(`[...document.querySelectorAll('[data-egg-mark]')].filter((c) => c.dataset.eggMark).map((c) => [c.dataset.eggCard, c.dataset.eggMark])`);
  check(JSON.stringify(marks) === JSON.stringify([[markA, "A"], [markB, "B"]]), `v marks two views, A then B (${JSON.stringify(marks)})`);
  await page.key("c");
  await page.waitFor("document.querySelectorAll('[data-egg-compare] [data-egg-compare-side] iframe').length === 2", { label: "compare" });
  const sides = await page.eval("[...document.querySelectorAll('[data-egg-compare-side]')].map((s) => s.dataset.eggCompareSide)");
  check(JSON.stringify(sides) === JSON.stringify([markA, markB]), "c opens the two marked views side by side");
  await shot(page, "3-compare");
  await page.key("Escape");
  check(!(await page.eval("!!document.querySelector('[data-egg-compare]')")), "Escape closes the comparison");

  // ---- x: cross them.
  const angleA = await page.eval(`document.querySelector('[data-egg-card="${markA}"] .egg-angle').textContent`);
  const angleB = await page.eval(`document.querySelector('[data-egg-card="${markB}"] .egg-angle').textContent`);
  await focusRoot(page);
  t0 = Date.now();
  await page.key("x");
  timings.cross = await waitRound(page, 3, 2, t0, "x");
  check((await lines(page)).some((l) => l.includes(`cross "${angleA}" × "${angleB}"`)), `x: the notebook says cross "${angleA}" × "${angleB}"`);
  const lineage3 = await page.eval(`${cardsOnTable}.map((c) => c.querySelector('[data-egg-lineage]')?.textContent ?? '')`);
  check(lineage3.every((l) => l.includes(`A: ${angleA}`) && l.includes(`B: ${angleB}`)), `x: each card names both parents (${lineage3.join(" | ")})`);
  const ways = await page.eval(`${cardsOnTable}.map((c) => c.dataset.eggAxis)`);
  check(ways.every(Boolean) && new Set(ways).size === 2, `x: two different ways (${ways.join(" · ")})`);
  const crossIds = await page.eval(`${cardsOnTable}.filter((c) => c.dataset.eggStatus === 'done').map((c) => c.dataset.eggCard)`);
  for (const id of crossIds) {
    const content = await rpc("view_content", { roomId: parentRoomId, viewId: id });
    const labels = ["[A]", "[B]", "[A+B]"].filter((l) => content?.content.includes(l));
    check(labels.length >= 2, `x: crossed view ${id} labels its parts (${labels.join(" ")})`);
  }
  await shot(page, "4-cross");

  // ---- z: zoom into a part of a crossed view.
  const zoomFrom = await selectFirstDone(page);
  await page.key("z");
  const zoomInput = await page.eval("document.activeElement?.dataset?.eggLineInput !== undefined ? document.activeElement.placeholder : null");
  check(Boolean(zoomInput?.startsWith("zoom into")), `z opens the line input asking "zoom into…" (${zoomInput?.slice(0, 40)})`);
  const part = "how the planning step's reply is parsed";
  await page.type(part);
  t0 = Date.now();
  await page.key("Enter");
  await page.waitFor(`document.querySelector('[data-egg-subject]')?.textContent === ${JSON.stringify(part)}`, { label: "the child room" });
  const childRoomId = await page.eval(`localStorage.getItem("egg:last-room")`);
  roomIds.push(childRoomId);
  check(childRoomId !== parentRoomId, "z makes a child room about the part, and opens it");
  check(await page.eval(`document.querySelector('[data-egg-parent-room]')?.dataset.eggParentRoom === ${JSON.stringify(parentRoomId)}`), "the child room shows its parent");
  timings.zoom = await waitRound(page, 1, 4, t0, "z");
  await focusRoot(page);
  await page.key("b");
  await sleep(300);
  const zoomParents = await page.eval(`${cardsOnTable}[0].querySelector('[data-egg-parents] li')?.textContent ?? ''`);
  check(zoomParents.includes("zoomed from") && zoomParents.includes("round 3 of"), `z: the child's views name the view they were zoomed from (${zoomParents})`);
  await page.key("b");

  // ---- Keep in the child room.
  await selectFirstDone(page);
  await page.key("y");
  await page.waitFor("document.querySelectorAll('[data-egg-kept] [data-egg-card]').length === 1", { label: "kept in the child room" });
  await sleep(1500);
  const childDir = await page.eval("document.querySelector('[data-egg-room-dir]').textContent.replace(/^keeps to /, '')");
  const keptPath = (await lines(page)).find((t) => t.includes("Kept"))?.split("→ ")[1]?.trim();
  let record = null;
  try {
    record = JSON.parse(readFileSync(keptPath.replace(/\.(html|txt)$/, ".json"), "utf8"));
  } catch {}
  check(Boolean(keptPath && existsSync(keptPath) && keptPath.startsWith(childDir)), `keep in the child room writes to its own directory (${keptPath})`);
  check(record?.room?.parent?.roomId === parentRoomId && record?.room?.parent?.viewId === zoomFrom && record?.parents?.[0]?.viewId === zoomFrom, `and its JSON names the parent room and view (${JSON.stringify(record?.room?.parent)})`);

  // ---- p, then a line.
  await focusRoot(page);
  await page.key("0");
  const pinned = await selectedId(page);
  await page.key("p");
  await page.waitFor(`document.querySelector('[data-egg-pin]')?.dataset.eggPin === ${JSON.stringify(pinned)}`, { label: "the pin" });
  check(true, "p pins the view and the top bar shows it");
  await page.key("i");
  await page.type("where does a failed planning step leave the round");
  t0 = Date.now();
  await page.key("Enter");
  await page.waitFor(`document.querySelector('.egg-round-head')?.textContent.startsWith('round 2 of')`, { label: "the pinned round" });
  check((await lines(page)).some((l) => /with pinned ".*" \(round 1\) as reference/.test(l)), "the notebook shows the line went in with the pin");
  timings.pinned = await waitRound(page, 2, 4, t0, "p then a line");
  const childRoom = (await rpc("room_get", { roomId: childRoomId })).room;
  const r2 = childRoom.rounds[1];
  check(r2.parents?.some((p) => p.viewId === pinned && p.role === "pinned"), "the round records the pinned view as a parent");
  await shot(page, "5-child");

  // ---- -: back up, at the view it was zoomed from.
  await collectThreads(childRoomId);
  await focusRoot(page);
  await page.key("-");
  await page.waitFor(`document.querySelector('[data-egg-subject]')?.textContent === ${JSON.stringify(subject)}`, { label: "the parent room" });
  await sleep(800);
  check((await selectedId(page)) === zoomFrom && (await roundHead(page)).startsWith("round 3 of"), "- goes up to the parent room, on the view it was zoomed from");

  // ---- The room list, and deleting the test rooms.
  await collectThreads(parentRoomId);
  await page.key("r");
  await page.waitFor("!!document.querySelector('[data-egg-rooms]')", { label: "the room list" });
  const order = await page.eval("[...document.querySelectorAll('[data-egg-room]')].map((li) => [li.dataset.eggRoom, li.dataset.eggDepth])");
  const pi = order.findIndex(([id]) => id === parentRoomId);
  check(pi >= 0 && order[pi + 1]?.[0] === childRoomId && order[pi + 1]?.[1] === "1", "the room list shows the child indented under its parent");
  await shot(page, "6-rooms");
  // The selection starts on the open room (the parent); j to the child.
  await page.key("j");
  await page.key("D");
  await sleep(300);
  check(!(await page.eval(`!!document.querySelector('[data-egg-room="${childRoomId}"]')`)), "D deletes the child room at once");
  await page.key("u");
  await page.waitFor(`!!document.querySelector('[data-egg-room="${childRoomId}"]')`, { label: "undo delete" });
  check(true, "u puts it back");
  await sleep(500);
  // Delete the parent first: its child must stay, at the top level.
  const at = await page.eval(`[...document.querySelectorAll('[data-egg-room]')].findIndex((li) => li.dataset.eggRoom === ${JSON.stringify(parentRoomId)})`);
  const sel = await page.eval("[...document.querySelectorAll('[data-egg-room]')].findIndex((li) => li.classList.contains('egg-selected'))");
  for (let k = 0; k < Math.abs(at - sel); k++) await page.key(at > sel ? "j" : "k");
  await page.key("D");
  await page.waitFor(`!document.querySelector('[data-egg-room="${parentRoomId}"]') && document.querySelector('[data-egg-room="${childRoomId}"]')?.dataset.eggDepth === "0"`, { label: "parent deleted, child at top level" });
  check(true, "deleting the parent leaves the child, at the top level");
  const ci = await page.eval(`[...document.querySelectorAll('[data-egg-room]')].findIndex((li) => li.dataset.eggRoom === ${JSON.stringify(childRoomId)})`);
  const sel2 = await page.eval("[...document.querySelectorAll('[data-egg-room]')].findIndex((li) => li.classList.contains('egg-selected'))");
  for (let k = 0; k < Math.abs(ci - sel2); k++) await page.key(ci > sel2 ? "j" : "k");
  await page.key("D");
  await sleep(1500);
  await page.key("Escape");
  const left = (await rpc("rooms_list", null)).rooms.map((r) => r.id);
  check(!left.includes(parentRoomId) && !left.includes(childRoomId), "both test rooms are deleted");
  check(existsSync(keptPath), "their kept files stay on disk");
  check(page.errors.length === 0, `no page errors (${page.errors.join(" | ")})`);
  page.close();
} catch (e) {
  check(false, `stopped: ${e.message}`);
  for (const id of roomIds) await collectThreads(id);
} finally {
  await chrome.stop();
  // Whatever happened, the test rooms go (their view threads are archived with them).
  for (const id of roomIds) {
    try {
      const listed = (await rpc("rooms_list", null)).rooms.some((r) => r.id === id);
      if (listed) {
        await collectThreads(id);
        await rpc("room_delete", { roomId: id });
        console.log(`(deleted test room ${id} after the run)`);
      }
    } catch (e) {
      console.log(`(could not delete test room ${id}: ${e.message})`);
    }
  }
}
const secs = (t) => (t ? { planned: `${(t.planned / 1000).toFixed(1)} s`, total: `${(t.total / 1000).toFixed(1)} s` } : null);
console.log(JSON.stringify({ timings: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, secs(v)])), rooms: roomIds, viewThreads: [...viewThreads] }, null, 2));
console.log(failed ? "e2e FAILED" : "e2e passed");
process.exit(failed ? 1 : 0);
