// Runs egg can vouch for. The room thread starts every run that matters
// through egg's runner (.egg/bin/run, put there by egg), which records the
// command, start time and process id in .egg/runs/<id>.json and, when the
// command ends, its exit status and end time. egg's server reads those
// records and owns each run's state; the ledger the page and the views see
// is built from them. A ledger line with no record is only the model's word:
// it is shown as claimed, never as running or passed.
//
// What survives under bb's command sandbox on macOS (checked with the
// claude-code provider): a run started with a plain `&`, `disown`, a double
// fork, or a new session (perl or python) outlives both the tool call and
// the end of the turn. `nohup` fails at once ("can't detach from console").
// So a run can outlive its turn, and egg brings the thread back to it: the
// wake rule below.
import { chmod, lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { LedgerRecord, RunState } from "./model.ts";
import { type LedgerEntry, MATERIAL_DIR, readSmall } from "./material.ts";
import { dur, stateWords } from "./provenance.ts";

export const RUNS_DIR = "runs";
export const LOGS_DIR = "logs";
export const RUNNER = "bin/run";
/** The runner, as the room thread calls it from the top of its workspace. */
export const RUNNER_PATH = `${MATERIAL_DIR}/${RUNNER}`;
/** A detached run's record is touched this often while it runs. */
export const BEAT_MS = 15_000;
/** A record untouched for this long while its process id is alive means the id was reused: the run died. */
export const STALE_MS = 10 * 60_000;
/** At most this many records are read in one sync. */
const MAX_RECORDS = 500;

const text = (max: number) => z.string().transform((s) => s.replace(/\s+/g, " ").trim().slice(0, max));
const int = z.number().int();

/** .egg/runs/<id>.json, as the runner writes it. */
export const runRecordSchema = z.object({
  id: text(60).pipe(z.string().min(1)),
  for: text(300).optional().default(""),
  command: text(1000).optional().default(""),
  log: text(400).optional().default(""),
  /** The supervising process: alive while the run is. */
  pid: int.positive().nullable().optional().default(null),
  /** A detached run's process group (its own session), which egg signals to stop it. */
  pgid: int.positive().nullable().optional().default(null),
  detached: z.boolean().optional().default(true),
  startedAt: text(40).optional().default(""),
  startedMs: z.number().nullable().optional().default(null),
  exit: int.nullable().optional().default(null),
  signal: int.nullable().optional().default(null),
  endedMs: z.number().nullable().optional().default(null),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

/** A record as read: what it says and when it was last touched (the runner's heartbeat). */
export interface ReadRecord {
  record: RunRecord;
  mtimeMs: number;
}

/** What egg knows about a run besides its record. */
export interface RunFacts {
  /** Whether the record's process is alive: true, false, or null when it cannot tell. */
  alive: (pid: number) => boolean | null;
  now: number;
  /** Runs egg stopped (the person stopped the room thread). */
  stopped: ReadonlySet<string>;
}

/**
 * A run's state from its record and what egg can see now:
 * stopped (egg stopped it), exited (an exit status is recorded), running
 * (its process is alive and its record is fresh), started (no process
 * named yet, just written), died (no exit recorded and its process gone).
 */
export function runState(read: ReadRecord, facts: RunFacts): Exclude<RunState, "claimed"> {
  const r = read.record;
  if (facts.stopped.has(r.id)) return "stopped";
  if (r.exit !== null) return "exited";
  if (r.pid === null) return facts.now - read.mtimeMs < 30_000 ? "started" : "died";
  const alive = facts.alive(r.pid);
  if (alive === false) return "died";
  // A foreground run is not touched while it runs; a detached one is, every 15 s.
  if (r.detached && facts.now - read.mtimeMs > STALE_MS) return "died";
  return "running";
}

/** Whether a process is alive: signal 0 asks without sending anything. */
export function pidAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return null;
  }
}

const iso = (ms: number | null) => (ms === null ? "" : new Date(ms).toISOString());

/**
 * The ledger the page and views see: one entry per run record, its state
 * egg's own; then each ledger line with no record, as claimed. A claimed
 * entry keeps what it says but never its exit status: nothing shows it as
 * running or passed.
 */
export function buildLedger(records: readonly ReadRecord[], lines: readonly LedgerEntry[], facts: RunFacts): LedgerRecord[] {
  const out: LedgerRecord[] = [];
  const seen = new Set<string>();
  const byLine = new Map(lines.map((l) => [l.id, l]));
  const sorted = [...records].sort((a, b) => (a.record.startedMs ?? a.mtimeMs) - (b.record.startedMs ?? b.mtimeMs));
  for (const read of sorted) {
    const r = read.record;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const state = runState(read, facts);
    out.push({
      id: r.id,
      at: r.startedAt || iso(r.startedMs),
      for: r.for || byLine.get(r.id)?.for || "",
      command: r.command,
      output: r.log,
      exit: state === "exited" ? r.exit : null,
      state,
      startedMs: r.startedMs ?? read.mtimeMs,
      endedMs: state === "exited" ? (r.endedMs ?? read.mtimeMs) : null,
      ...(r.pid !== null ? { pid: r.pid } : {}),
      ...(r.pgid !== null ? { pgid: r.pgid } : {}),
    });
  }
  for (const line of lines) {
    if (seen.has(line.id)) continue;
    seen.add(line.id);
    out.push({ id: line.id, at: line.at, for: line.for, command: line.command, output: line.output, exit: null, state: "claimed", startedMs: null, endedMs: null });
  }
  return out;
}

/** Carry over what egg decided earlier: a run it saw die stays died unless an exit later shows up, and when. */
export function carryOver(next: readonly LedgerRecord[], before: readonly LedgerRecord[], now: number): LedgerRecord[] {
  const prev = new Map(before.map((e) => [e.id, e]));
  return next.map((e) => {
    const p = prev.get(e.id);
    if (e.state === "died") return { ...e, endedMs: p?.state === "died" && p.endedMs ? p.endedMs : now };
    if (e.state === "stopped") return { ...e, endedMs: p?.state === "stopped" && p.endedMs ? p.endedMs : now };
    return e;
  });
}

export const isOpen = (e: LedgerRecord) => e.state === "running" || e.state === "started";
export const isFinished = (e: LedgerRecord) => e.state === "exited" || e.state === "died";

/** For the status line: how many runs are open, and how long the oldest has run. */
export function openSummary(ledger: readonly LedgerRecord[], now: number): { open: number; longestMs: number | null } {
  const open = ledger.filter(isOpen);
  const starts = open.map((e) => e.startedMs).filter((t): t is number => typeof t === "number");
  return { open: open.length, longestMs: starts.length ? now - Math.min(...starts) : null };
}

/** A finished run that is news for the notebook: failed or died, and, for a detached run, a clean finish. */
export function notebookLine(e: LedgerRecord, now: number): { kind: "trouble" | "did"; text: string } | null {
  const what = e.for || e.command || "a run";
  const log = e.output ? ` · log ${e.output}` : "";
  if (e.state === "died") return { kind: "trouble", text: `Run ${e.id} died (${what}): its process is gone and no exit was recorded${log}` };
  if (e.state === "exited" && e.exit !== 0) return { kind: "trouble", text: `Run ${e.id} failed (${what}): ${stateWords(e, now)}${log}` };
  if (e.state === "exited") return { kind: "did", text: `Run ${e.id} finished (${what}): ${stateWords(e, now)}` };
  return null;
}

export interface WakeInput {
  ledger: readonly LedgerRecord[];
  /** Ids of finished runs the thread has been told about, or that ended while it was at work. */
  told: ReadonlySet<string>;
  /** The thread is idle (not in a turn, not waiting on the person). */
  idle: boolean;
  /** The person stopped it: nothing wakes it until their next line. */
  held: boolean;
  /** When its last turn ended. */
  turnEndedAt: number | null;
  /** When egg last woke it. */
  wokeAt: number | null;
  now: number;
  intervalMs: number;
}

export interface Wake {
  /** The message to send, or null when it is not time. */
  message: string | null;
  /** Finished runs to count as told from now on (in the message, or ended while it worked). */
  told: string[];
}

/**
 * The wake rule. While the thread is idle and not held: a run that finished
 * after its last turn ended wakes it at once ("r14 finished, exit 0; r15
 * still running"); otherwise open runs wake it every `intervalMs` so it can
 * read its logs and carry on. A run that finished while it was at work is
 * counted as told without a message: it was there to read it.
 */
export function wakeRule(w: WakeInput): Wake {
  const untold = w.ledger.filter((e) => isFinished(e) && !w.told.has(e.id));
  if (w.held || !w.idle) return { message: null, told: [] };
  const since = w.turnEndedAt ?? 0;
  const fresh = untold.filter((e) => (e.endedMs ?? w.now) > since);
  const quiet = untold.filter((e) => (e.endedMs ?? w.now) <= since).map((e) => e.id);
  const open = w.ledger.filter(isOpen);
  if (fresh.length) return { message: wakeMessage(fresh, open, w.now), told: [...quiet, ...fresh.map((e) => e.id)] };
  const last = Math.max(since, w.wokeAt ?? 0);
  if (open.length && w.now - last >= w.intervalMs) return { message: wakeMessage([], open, w.now), told: quiet };
  return { message: null, told: quiet };
}

/** The words of a wake: what finished, what is still running, and what to do. */
export function wakeMessage(finished: readonly LedgerRecord[], open: readonly LedgerRecord[], now: number): string {
  const parts = [
    ...finished.map((e) => `${e.id} ${e.state === "died" ? "died (no exit recorded)" : `finished, exit ${e.exit}`}`),
    ...open.map((e) => `${e.id} still running${e.startedMs ? ` (${dur(now - e.startedMs)})` : ""}`),
  ];
  return [
    `egg: ${parts.join("; ")}.`,
    `This is egg, not the person. Read each run's record (${MATERIAL_DIR}/${RUNS_DIR}/<id>.json) and its log, then carry on with the work you were doing: update your page in ${MATERIAL_DIR}/views/ and write a note. If runs are still open and there is nothing to do until they end, say so in one line and end your turn; egg will tell you when they finish.`,
  ].join("\n");
}

/** Every run record in .egg/runs/, parsed defensively; never followed through a symlink. */
export async function readRecords(materialRoot: string): Promise<ReadRecord[]> {
  const dir = join(materialRoot, RUNS_DIR);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}\.json$/.test(n)).sort().slice(0, MAX_RECORDS);
  } catch {
    return [];
  }
  const out: ReadRecord[] = [];
  for (const name of names) {
    const file = await readSmall(join(dir, name), 20_000);
    const info = await lstat(join(dir, name)).catch(() => null);
    if (!file || !info) continue;
    try {
      const parsed = runRecordSchema.safeParse(JSON.parse(file.content));
      if (parsed.success && `${parsed.data.id}.json` === name) out.push({ record: parsed.data, mtimeMs: info.mtimeMs });
    } catch {
      // half written or not a record: skipped
    }
  }
  return out;
}

const RUNNER_SOURCE = new URL("./runner.pl", import.meta.url);

/** Put the runner into the material folder (again), executable. Returns whether it was written. */
export async function installRunner(materialRoot: string): Promise<boolean> {
  const source = await readFile(RUNNER_SOURCE, "utf8");
  const target = join(materialRoot, RUNNER);
  const there = await lstat(target).catch(() => null);
  if (there?.isFile() && (await readFile(target, "utf8").catch(() => "")) === source && (there.mode & 0o111) !== 0) return false;
  await mkdir(join(materialRoot, "bin"), { recursive: true });
  for (const d of [RUNS_DIR, LOGS_DIR]) await mkdir(join(materialRoot, d), { recursive: true });
  const tmp = `${target}.egg-${process.pid}`;
  await writeFile(tmp, source, { mode: 0o755 });
  await chmod(tmp, 0o755);
  await rename(tmp, target);
  return true;
}

/**
 * Stop a run: its process group (a detached run's own session) or its
 * process, TERM then KILL after a grace period. Returns whether anything
 * was signalled.
 */
export async function killRun(e: Pick<LedgerRecord, "pid" | "pgid">, graceMs = 3000, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<boolean> {
  const target = e.pgid ? -e.pgid : e.pid ? e.pid : null;
  if (target === null) return false;
  const send = (sig: NodeJS.Signals) => {
    try {
      process.kill(target, sig);
      return true;
    } catch {
      return false;
    }
  };
  if (!send("SIGTERM")) return false;
  await wait(graceMs);
  send("SIGKILL");
  return true;
}
