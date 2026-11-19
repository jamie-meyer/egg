// End-to-end check of the egg page against a running bb, in a separate
// headless Chrome (never your own bb window).
//
// It makes one room on the folder you give it and runs exactly one round:
// one planning thread and four view threads (five threads in all). Set
// egg's "Thread title prefix" setting to "egg test" first so they are easy
// to find, and archive them afterwards (the script prints their ids).
//
// What it checks: the new-room form defaults to the project's checkout; the
// first line starts a round; four cards appear and fill; a view opens large
// in a sandboxed frame the page cannot reach into; "built from" opens; keep
// writes the view and its record to the room's directory; drop takes a card
// off the table (and u brings it back); a paste opens the line input with
// the text; i opens it too; hold-to-talk shows its recording state and
// reports what transcription did; after a reload the room and the kept view
// are still there.
//
//   node scripts/e2e.mjs --folder <absolute folder> [--bb http://127.0.0.1:38886] [--shots <dir>]
//
// Needs Chrome; run it outside any command sandbox.
import { existsSync, readFileSync } from "node:fs";
import { firstPage, launchChrome, sleep } from "./cdp.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const bb = option("bb", "http://127.0.0.1:38886");
const folder = option("folder");
const shots = option("shots");
if (!folder) {
  console.error("usage: node scripts/e2e.mjs --folder <absolute folder> [--shots <dir>]");
  process.exit(2);
}

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
const paste = (page, text) =>
  page.eval(`(() => { const dt = new DataTransfer(); dt.setData("text/plain", ${JSON.stringify(text)}); (document.activeElement || document.body).dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
const count = (page, selector) => page.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const saidLines = (page) => count(page, "[data-egg-line='said']");

const chrome = await launchChrome(9358);
let threadIds = [];
try {
  const page = await firstPage(chrome.port);
  await page.goto(`${bb}/plugins/egg/egg`, 5000);
  await page.eval(`localStorage.removeItem("egg:last-room")`);
  await page.goto(`${bb}/plugins/egg/egg`, 5000);
  await page.waitFor("!!document.querySelector('[data-egg-root]')", { timeout: 60000, label: "the egg page" });

  // A new room. With rooms already there the form opens with n.
  if (!(await page.eval("!!document.querySelector('[data-egg-new-room]')"))) {
    await page.eval("document.querySelector('[data-egg-root]').focus()");
    await page.key("n");
  }
  await page.waitFor("document.querySelector('[data-egg-folder]')?.value", { timeout: 30000, label: "the folder default" });
  const defaultFolder = await page.eval("document.querySelector('[data-egg-folder]').value");
  check(defaultFolder.length > 0, `the folder defaults to the project's checkout (${defaultFolder})`);
  await page.eval(`(() => { const el = document.querySelector('[data-egg-folder]'); el.focus(); el.select(); })()`);
  await page.type(folder);
  await page.eval("document.querySelector('[data-egg-first-line]').focus()");
  const subject = `how is a round of views put together (e2e ${new Date().toISOString().slice(11, 19)})`;
  await page.type(subject);
  const t0 = Date.now();
  await page.key("Enter");
  await page.waitFor(`document.querySelector('[data-egg-subject]')?.textContent === ${JSON.stringify(subject)}`, { label: "the room opens" });
  check(true, "the room opens with its first line as subject");
  await shot(page, "1-planning");
  await page.waitFor("document.querySelectorAll('[data-egg-card]').length === 4", { timeout: 90000, label: "four angle cards" });
  timings.anglesMs = Date.now() - t0;
  const angles = await page.eval("[...document.querySelectorAll('[data-egg-card] .egg-angle')].map((e) => e.textContent)");
  check(new Set(angles).size === 4, `four different angles show as cards at once: ${angles.join(" · ")}`);
  await shot(page, "2-angles");
  await page.waitFor("[...document.querySelectorAll('[data-egg-card]')].every((c) => ['done','failed'].includes(c.dataset.eggStatus))", { timeout: 240000, label: "all four cards fill" });
  timings.roundMs = Date.now() - t0;
  const statuses = await page.eval("[...document.querySelectorAll('[data-egg-card]')].map((c) => c.dataset.eggStatus)");
  check(statuses.filter((s) => s === "done").length >= 2, `cards filled: ${statuses.join(", ")}`);
  await page.waitFor("document.querySelectorAll('[data-egg-card] iframe[data-egg-view-frame]').length >= 2", { label: "views render in frames" });
  await sleep(1000);
  await shot(page, "3-filled");

  // Open one large.
  await page.eval("document.querySelector('[data-egg-root]').focus()");
  const firstDone = await page.eval("[...document.querySelectorAll('[data-egg-cards] [data-egg-card]')].findIndex((c) => c.dataset.eggStatus === 'done')");
  for (let i = 0; i < firstDone; i++) await page.key("l");
  await page.key("Enter");
  await page.waitFor("!!document.querySelector('[data-egg-large] iframe')", { label: "the large view" });
  const frame = await page.eval(`(() => { const f = document.querySelector('[data-egg-large] iframe'); return { sandbox: f.getAttribute('sandbox'), opaque: f.contentDocument === null, csp: f.srcdoc.includes("default-src 'none'") }; })()`);
  check(frame.sandbox === "" && frame.opaque && frame.csp, `the view opens large in a sandboxed frame the page cannot reach into (${JSON.stringify(frame)})`);
  await page.key("b");
  await sleep(300);
  const builtFrom = await count(page, "[data-egg-large] [data-egg-built-from] li");
  check(builtFrom > 0, `"built from" opens with ${builtFrom} entries from the thread's events`);
  await shot(page, "4-large");
  await page.key("Escape");
  check(!(await page.eval("!!document.querySelector('[data-egg-large]')")), "Escape closes the large view");
  await page.key("b");

  // Keep it.
  await page.key("y");
  await page.waitFor("document.querySelectorAll('[data-egg-kept] [data-egg-card]').length === 1", { label: "the kept strip" });
  await sleep(1500);
  const roomDir = await page.eval("document.querySelector('[data-egg-room-dir]').textContent.replace(/^keeps to /, '')");
  const keptLine = await page.eval("[...document.querySelectorAll('[data-egg-line]')].map((l) => l.textContent).find((t) => t.includes('Kept'))");
  const keptPath = keptLine?.split("→ ")[1]?.trim();
  const jsonPath = keptPath?.replace(/\.(html|txt)$/, ".json");
  check(Boolean(keptPath && existsSync(keptPath) && keptPath.startsWith(roomDir)), `keep writes the view to the room's directory (${keptPath})`);
  let record = null;
  try {
    record = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch {}
  check(Boolean(record && record.room?.subject === subject && record.angle && record.model && record.keptAt && Array.isArray(record.builtFrom) && record.builtFrom.length > 0), `with a JSON record beside it (angle "${record?.angle}", model ${record?.model}, ${record?.builtFrom?.length} built-from entries)`);

  // Drop another; undo; drop again.
  const before = await count(page, "[data-egg-cards] [data-egg-card]");
  await page.key(firstDone === 0 ? "l" : "h");
  const droppedId = await page.eval("document.querySelector('[data-egg-cards] .egg-selected')?.dataset.eggCard");
  await page.key("d");
  await sleep(500);
  check((await count(page, "[data-egg-cards] [data-egg-card]")) === before - 1, "drop takes the card off the table at once");
  await page.key("u");
  await sleep(800);
  check((await count(page, "[data-egg-cards] [data-egg-card]")) === before, "u brings it back");
  await page.key("d");
  await sleep(1500);
  check((await count(page, "[data-egg-cards] [data-egg-card]")) === before - 1, "drop again");
  check((await page.eval("[...document.querySelectorAll('[data-egg-line]')].some((l) => l.textContent.includes('Dropped'))")) === true, "the drop stays in the notebook");
  await shot(page, "5-kept-dropped");

  // A paste on the page opens the line input with the text; Escape discards it.
  const said = await saidLines(page);
  await page.eval("document.querySelector('[data-egg-root]').focus()");
  await paste(page, "where do\nkept views go?");
  const input = await page.eval("(() => { const el = document.activeElement; return el?.dataset?.eggLineInput !== undefined ? { value: el.value, caret: el.selectionStart } : null; })()");
  check(input?.value === "where do kept views go?" && input.caret === input.value.length, `a paste in normal mode opens the line input with the text, cursor at the end (${JSON.stringify(input)})`);
  await shot(page, "6-paste");
  await page.key("Escape");
  check(!(await page.eval("!!document.querySelector('[data-egg-line-input]')")) && (await saidLines(page)) === said, "Escape discards it; no round starts");
  // i opens it too, and typed characters go into it (as a typing dictation app's would).
  await page.key("i");
  await page.type("typed into the input");
  check((await page.eval("document.activeElement?.value")) === "typed into the input", "i opens the input and typed text goes into it");
  await page.key("Escape");

  // Hold to talk: recording state while held, then whatever transcription did.
  await page.eval("document.querySelector('[data-egg-root]').focus()");
  const linesBefore = await count(page, "[data-egg-line]");
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " });
  await sleep(700);
  const recording = await page.eval("document.querySelector('[data-egg-root]').dataset.eggVoice");
  await sleep(1000);
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  check(recording === "recording", `holding Space shows the recording state (${recording})`);
  await page.waitFor(`document.querySelectorAll('[data-egg-line]').length > ${linesBefore} || !!document.querySelector('.egg-hint')`, { timeout: 30000, label: "transcription outcome" });
  const voiceOutcome = await page.eval("[...document.querySelectorAll('[data-egg-line]')].at(-1)?.textContent + ' | hint: ' + (document.querySelector('.egg-hint')?.textContent ?? '')");
  check(true, `on release: ${voiceOutcome}`);
  await shot(page, "7-voice");

  // Reload: the room and the kept view are still there.
  await page.goto(`${bb}/plugins/egg/egg`, 5000);
  await page.waitFor(`document.querySelector('[data-egg-subject]')?.textContent === ${JSON.stringify(subject)}`, { timeout: 60000, label: "the room after reload" });
  await page.waitFor("document.querySelectorAll('[data-egg-kept] [data-egg-card]').length === 1", { label: "the kept view after reload" });
  check(true, "after a reload the room and its kept view are still there");
  check(!(await page.eval(`!!document.querySelector('[data-egg-card="${droppedId}"]')`)), "and the dropped view is still off the table");
  await page.eval("document.querySelector('[data-egg-root]').focus()");
  await page.key("j");
  await page.key("j");
  await page.key("Enter");
  await page.waitFor("!!document.querySelector('[data-egg-large] iframe')", { label: "the kept view opens large" });
  check(true, "the kept view opens large");
  await shot(page, "8-reloaded");
  await page.key("Escape");
  check(page.errors.length === 0, `no page errors (${page.errors.join(" | ")})`);

  // The room's threads, for archiving.
  const roomId = await page.eval(`localStorage.getItem("egg:last-room")`);
  const res = await (await fetch(`${bb}/api/v1/plugins/egg/rpc/room_get`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roomId }) })).json();
  threadIds = Object.values(res.result.room.views).map((v) => v.threadId).filter(Boolean);
  page.close();
} catch (e) {
  check(false, `stopped: ${e.message}`);
} finally {
  await chrome.stop();
}
console.log(JSON.stringify({ timings, viewThreads: threadIds }, null, 2));
console.log(failed ? "e2e FAILED" : "e2e passed");
process.exit(failed ? 1 : 0);
