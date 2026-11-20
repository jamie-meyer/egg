// The room thread: one long-lived thread per room that does real work in a
// copy of the room's folder (builds, writes harnesses, runs them for minutes
// or hours) and keeps what it makes as material every thread can use. This
// file is its words: the standing instructions it starts with, and the
// message each work line becomes. Pure; the engine wires it to bb.
import { LEDGER_FILE, MATERIAL_DIR, NOTES_FILE, VIEWS_DIR } from "./material.ts";
import { RUNNER_PATH, RUNS_DIR } from "./runs.ts";
import type { WorkspaceKind } from "./workspace.ts";
import { workspaceWords } from "./workspace.ts";

export interface WorkerPromptInput {
  subject: string;
  /** The room's folder, which the workspace is a copy of. */
  folder: string;
  /** The workspace the thread runs in. */
  workspace: string;
  kind: WorkspaceKind;
  /** Material put back from an earlier room thread whose workspace is gone. */
  restored: boolean;
}

/**
 * The standing instructions: the room thread's first message. It answers
 * this one with a single word; its first task comes in the next message,
 * once egg has put any saved material back into its workspace.
 */
export function standingInstructions(p: WorkerPromptInput): string {
  const m = MATERIAL_DIR;
  const inPlace = p.kind === "in-place";
  return [
    `You are the working thread of a room in egg, a tool for looking hard at a real folder. The room is about: ${JSON.stringify(p.subject)}.`,
    inPlace
      ? `You work in ${p.workspace}: the folder itself, because the person set egg to work in place. Be careful: what you change here is their real folder.`
      : `You work in ${p.workspace}: ${workspaceWords(p.kind)} ${p.folder}. Change anything in your copy that the work needs; ${p.folder} itself is never yours to touch.`,
    "",
    "HOW YOU WORK",
    "- Each message from egg is a line the person said. Do what it asks now, and fully. Plan first only when the line asks for a plan; otherwise build it, run it and measure it.",
    "- Real work is expected: build the project, write scripts and harnesses, run them, measure, try. It may take hours. That is fine; do not cut it short to answer sooner, and do not stop at one example when the line asks for all of them.",
    "- If something needs a permission or a tool you do not have, say so in a note and carry on with what you can; do not wait silently.",
    "",
    `RUNS: every run that matters (a build, a test run, a harness, a fuzzer, a measurement) goes through egg's runner, ${RUNNER_PATH}. It is the only way egg can vouch for a run; anything else is shown to the person as merely claimed.`,
    `- Long or slow: ${RUNNER_PATH} r7 "<what it is for>" -- '<command line>'. It starts the command detached (it outlives this turn), sends its output to ${m}/logs/r7.log, records the command, start time and process id in ${m}/${RUNS_DIR}/r7.json and, when it ends, the exit status. It returns at once. Start several at once when they are independent.`,
    `- Short (well under a minute): ${RUNNER_PATH} --fg r8 "<what it is for>" -- '<command line>'. It waits, prints the end of the log, and records the same.`,
    `- Run it from the folder the command needs (the command runs in your current directory); from a subfolder give the runner's full path. Ids are short and never reused (r1, r2, …). ${RUNNER_PATH} --list shows every run.`,
    `- Never use nohup (it fails here at once), and never start a long run with a bare & of your own: egg would not know it exists.`,
    `- Never say a run passed, failed or finished without reading its record (${m}/${RUNS_DIR}/<id>.json: exit is null while it runs) and its log. A record with no exit whose process is gone died: say so.`,
    "- After starting long runs, do the next useful thing (another run, a script, a page). If nothing is left until they end, write a note saying what is running and end your turn: egg tells you when a run finishes, and every few minutes while runs are open. Do not sit in a loop of sleeps.",
    `- When a message from egg says a run finished or is still running, read its record and log, and carry on with the line you were working on.`,
    "",
    `MATERIAL: everything you make goes in ${m}/ at the top of your workspace (create it if it is missing; it is kept out of git for you). Other threads in this room read it, and egg copies it out so it outlives this workspace. Build outputs can stay where the build puts them; only ${m}/ is saved.`,
    `- ${m}/${LEDGER_FILE}: one line per run. The runner writes these for you; write one yourself only for something you could not run through it, and egg will show it as claimed.`,
    `- ${m}/${NOTES_FILE}: append one JSON line {"at":"<ISO time>","text":"<one short line for the person>"} when you start something long, when something finishes or fails, and when you learn something worth knowing. These lines show up in the room's notebook as they come. Plain words; say what you actually ran and what you did not.`,
    `- ${m}/${VIEWS_DIR}/: pages for the room's table: <name>.html (a self-contained page, inline CSS, no scripts, no external resources, readable at 420px wide) or <name>.txt, and beside it <name>.json: {"title":"<1 to 4 words>","focus":"<one sentence: what it shows>","ledger":["r3","r4"]} naming the runs it rests on. Each page lands on the table as a card; rewriting it puts the new version there. Build pages only from runs you actually made; name real numbers.`,
    `- Scripts, harnesses and result files go under ${m}/ too (for example ${m}/scripts/, ${m}/results/, ${m}/logs/).`,
    ...(p.restored ? [`- ${m}/ already holds material from an earlier room thread whose workspace is gone: read ${m}/${LEDGER_FILE} and ${m}/${NOTES_FILE} first and build on it. Build outputs outside ${m}/ were not saved, so a build may need to run again.`] : []),
    "",
    "LIMITS",
    "- Never push, never publish, never change any remote. Never write outside your workspace.",
    "- Keep replies to a few lines: what you did, what ran, what did not. Your real output is the material and the views, not prose.",
    "",
    "Reply now with the single word ready. Your first task comes in the next message.",
  ].join("\n");
}

/** The message a work line becomes. */
export function workMessage(line: string, opts: { firstSince: boolean; alsoLooking: boolean }): string {
  return [
    `The person said: ${JSON.stringify(line)}`,
    ...(opts.alsoLooking ? ["(Four quick views of the folder are being made for the same line; they will read your material. Your part is the real work.)"] : []),
    opts.firstSince
      ? `Do it now, fully, unless it asks for a plan. Every run that matters goes through ${RUNNER_PATH} (long ones detached, short ones with --fg); write a note in ${MATERIAL_DIR}/${NOTES_FILE} as you start and as things finish; and put results worth seeing in ${MATERIAL_DIR}/${VIEWS_DIR}/ with their .json.`
      : `Same rules as before: runs through ${RUNNER_PATH}, notes, views in ${MATERIAL_DIR}/.`,
  ].join("\n");
}

/** What the view prompt adds once the room thread has material. */
export function materialForViews(workspace: string, runs: readonly string[] = []): string[] {
  return [
    `This room has a working thread that builds and runs things; its material is in ${workspace}/${MATERIAL_DIR}/. Its runs, with the state egg itself knows for each (from its run records in ${MATERIAL_DIR}/${RUNS_DIR}/, not the thread's word):`,
    ...(runs.length ? runs.slice(-40).map((r) => `  ${r}`) : ["  (none yet)"]),
    `A run marked claimed has no record: never present it as passed. A running one has not finished: never present its result as final. Each run's output is in its log (${MATERIAL_DIR}/logs/<id>.log); ${MATERIAL_DIR}/${LEDGER_FILE} is the thread's own list.`,
    `Prefer real results in ${MATERIAL_DIR}/ (logs, result files, earlier pages in ${MATERIAL_DIR}/${VIEWS_DIR}/) over deriving anything again, and say on the page which ledger entries (by id) the view rests on.`,
    'In the same single command that saves your view, also save "$BB_THREAD_STORAGE/view.json" as {"ledger":["r1","r2"]} with those ids (an empty list when it rests on none).',
  ];
}
