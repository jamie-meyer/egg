// A round: the planning step that picks four different angles for a line,
// and the prompt each view thread gets. Pure functions; the server wires
// them to threads.
import { ANGLES_PER_ROUND, type Room, roundViews } from "./model.ts";

export interface Angle {
  name: string;
  focus: string;
}

/**
 * Used when the planning step fails: deliberately spread out, and general
 * enough for any folder.
 */
export const FALLBACK_ANGLES: readonly Angle[] = [
  { name: "The map", focus: "Where the parts of this live and how they connect, as a small diagram or outline." },
  { name: "One concrete path", focus: "Follow one real example through the files, step by step." },
  { name: "By the numbers", focus: "Counts, sizes, ages and other measurable facts about it." },
  { name: "Oddities", focus: "What looks surprising, inconsistent, unfinished or risky." },
];

/** What the room has seen so far, for the planner. */
export function roomHistory(room: Room, maxLines = 12): string {
  const said = room.lines.filter((l) => l.kind === "said").slice(-maxLines);
  const lines = said.map((l) => `- ${l.text}`);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const round of room.rounds) {
    for (const view of roundViews(room, round)) {
      if (view.decision === "kept") kept.push(`"${view.angle}" (for: ${round.line})`);
      if (view.decision === "dropped") dropped.push(`"${view.angle}" (for: ${round.line})`);
    }
  }
  return [
    `Earlier lines, oldest first:\n${lines.length ? lines.join("\n") : "- (none)"}`,
    `Views the person kept: ${kept.length ? kept.slice(-12).join("; ") : "none yet"}`,
    `Views the person dropped: ${dropped.length ? dropped.slice(-12).join("; ") : "none yet"}`,
  ].join("\n");
}

export function plannerPrompt(room: Room, line: string): string {
  return [
    "You pick angles for egg, an ideation tool. Do not use any tools and do not read files: answer from this message alone, fast.",
    `The room is about: ${JSON.stringify(room.subject)}`,
    `The folder it reads: ${room.folder}`,
    roomHistory(room),
    `The person just said: ${JSON.stringify(line)}`,
    "",
    `Pick ${ANGLES_PER_ROUND} DIFFERENT angles from which a small one-page view of the real folder would show the person something about what they just said.`,
    "Spread them out: different kinds of looking (for example a map, a single concrete trace, numbers, a timeline, a comparison, what is odd), not four takes on one idea.",
    "Lean towards angles like the kept ones and away from the dropped ones.",
    "Each name is 1 to 4 plain words. Each focus is one short sentence saying what the view shows.",
    `Reply with JSON only, no prose, no code fence: [{"name":"...","focus":"..."}, ...] with exactly ${ANGLES_PER_ROUND} items.`,
  ].join("\n");
}

function clean(text: unknown, max: number): string {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/**
 * The planner's reply to exactly four angles. Takes the first JSON array in
 * the text; tops up from the fallback list when there are fewer than four or
 * names repeat. Returns null when there is nothing usable at all.
 */
export function parseAngles(reply: string | null | undefined): Angle[] | null {
  if (!reply) return null;
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const angles: Angle[] = [];
  const names = new Set<string>();
  for (const entry of parsed) {
    const name = clean(typeof entry === "string" ? entry : (entry as { name?: unknown })?.name, 60);
    const focus = clean((entry as { focus?: unknown })?.focus, 300);
    if (!name || names.has(name.toLowerCase())) continue;
    names.add(name.toLowerCase());
    angles.push({ name, focus });
    if (angles.length === ANGLES_PER_ROUND) break;
  }
  if (angles.length === 0) return null;
  for (const fallback of FALLBACK_ANGLES) {
    if (angles.length === ANGLES_PER_ROUND) break;
    if (!names.has(fallback.name.toLowerCase())) angles.push(fallback);
  }
  return angles;
}

export function viewPrompt(room: Room, line: string, angle: Angle): string {
  return [
    "You are making one small 'view' for egg, a tool for looking at a real folder from several angles side by side. Speed matters more than completeness.",
    `The room is about: ${JSON.stringify(room.subject)}`,
    `The person just said: ${JSON.stringify(line)}`,
    `Your angle: ${angle.name}. ${angle.focus}`,
    `The folder to look at: ${room.folder}. It is READ ONLY: never create, change or delete anything in it. Read only the few files you need.`,
    "Make ONE view of the real thing from your angle, built only from what you actually read or ran. Name real files and real numbers; never invent.",
    "Either a self-contained HTML page of about 40 to 60 lines (inline CSS, no scripts: they will not run; no external resources, no images from the network, readable at 420px wide, plain and quiet),",
    "or plain text when that suits the angle better.",
    'Save it as "$BB_THREAD_STORAGE/view.html" or "$BB_THREAD_STORAGE/view.txt" (expand the variable in a shell). Write nothing else anywhere.',
    "Then reply with the single word: done.",
  ].join("\n");
}

/** A thread title that is recognisable in bb's thread lists. */
export function viewThreadTitle(prefix: string, angle: string, subject: string): string {
  const short = subject.replace(/\s+/g, " ").trim().slice(0, 40);
  return `${prefix}: ${angle} · ${short}`.slice(0, 120);
}
