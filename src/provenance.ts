// "Built from": what a view's thread actually did, taken from the thread's
// own event stream (completed items), never from what the model says it did.
import type { BuiltFrom, RunState } from "./model.ts";

/** The part of a thread event row this module reads. */
export interface EventRow {
  seq: number | string;
  type: string;
  data?: unknown;
}

export interface ProvenanceContext {
  /** The folder the room reads; paths inside it are shown relative to it. */
  folder: string;
  /** The thread's storage root; writes there are the view itself. */
  storageRoot: string | null;
}

const MAX_WHAT = 300;
const MAX_ENTRIES = 200;

function shorten(text: string, max = MAX_WHAT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A command as run in the folder: a leading `cd <folder>` dropped, the folder's path shown as `.`. */
export function commandInFolder(command: string, folder: string): string {
  const f = folder.replace(/\/+$/, "");
  const esc = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return command
    .replace(new RegExp(`^\\s*cd\\s+["']?${esc}/?["']?\\s*(&&|;)\\s*`), "")
    .split(`${f}/`).join("")
    .split(f).join(".");
}

export function relativeTo(folder: string, path: string): string {
  const base = folder.endsWith("/") ? folder : `${folder}/`;
  if (path === folder) return ".";
  return path.startsWith(base) ? path.slice(base.length) : path;
}

function insideStorage(ctx: ProvenanceContext, path: string): boolean {
  if (path.includes("$BB_THREAD_STORAGE") || path.includes("${BB_THREAD_STORAGE}")) return true;
  if (ctx.storageRoot === null) return false;
  const root = ctx.storageRoot.endsWith("/") ? ctx.storageRoot : `${ctx.storageRoot}/`;
  return path === ctx.storageRoot || path.startsWith(root);
}

const READ_TOOLS = new Set(["Read", "NotebookRead", "read_file", "view"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "LS", "grep", "glob", "list_dir"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "write_file", "edit_file"]);
/** Tool calls that are bookkeeping, not evidence. */
const IGNORED_TOOLS = new Set(["TodoWrite", "Skill", "ToolSearch"]);

/** One completed item to zero or more "built from" entries. */
export function entriesForItem(item: unknown, ctx: ProvenanceContext): BuiltFrom[] {
  const it = record(item);
  if (it === null) return [];
  const failed = it.status === "failed" ? { failed: true } : {};
  const rel = (p: string) => relativeTo(ctx.folder, p);
  switch (it.type) {
    case "fileRead": {
      const path = str(it.path);
      return path ? [{ kind: "read", what: shorten(rel(path)), ...failed }] : [];
    }
    case "search": {
      const query = str(it.query) ?? "";
      const path = str(it.path);
      return [{ kind: "search", what: shorten(path ? `${query} in ${rel(path)}` : query), ...failed }];
    }
    case "commandExecution": {
      const command = str(it.command);
      if (!command) return [];
      // The command that writes the view into thread storage is the view, not evidence.
      if (/BB_THREAD_STORAGE/.test(command) && /view\.(html|txt)/.test(command) && /(>|\btee\b|<<|\bsed -i|\bperl -pi|\bmv\b|\bcp\b)/.test(command)) {
        return [{ kind: "wrote", what: "the view (thread storage)", ...failed }];
      }
      return [{ kind: "command", what: shorten(commandInFolder(command, ctx.folder)), ...failed }];
    }
    case "fileChange": {
      const changes = Array.isArray(it.changes) ? it.changes : [];
      return changes.flatMap((change): BuiltFrom[] => {
        const path = str(record(change)?.path);
        if (!path) return [];
        if (insideStorage(ctx, path)) return [{ kind: "wrote", what: "the view (thread storage)", ...failed }];
        return [{ kind: "wrote", what: shorten(rel(path)), outside: true, ...failed }];
      });
    }
    case "webSearch": {
      const queries = Array.isArray(it.queries) ? it.queries.filter((q): q is string => typeof q === "string") : [];
      return [{ kind: "web", what: shorten(`search: ${queries.join("; ")}`), ...failed }];
    }
    case "webFetch": {
      const url = str(it.url);
      return url ? [{ kind: "web", what: shorten(url), ...failed }] : [];
    }
    case "toolCall": {
      const tool = str(it.tool) ?? "tool";
      if (IGNORED_TOOLS.has(tool)) return [];
      const args = record(it.arguments) ?? {};
      const path = str(args.file_path) ?? str(args.path) ?? str(args.notebook_path);
      if (READ_TOOLS.has(tool) && path) return [{ kind: "read", what: shorten(rel(path)), ...failed }];
      if (SEARCH_TOOLS.has(tool)) {
        const pattern = str(args.pattern) ?? str(args.query) ?? "";
        return [{ kind: "search", what: shorten(path ? `${pattern} in ${rel(path)}` : pattern || tool), ...failed }];
      }
      if (WRITE_TOOLS.has(tool) && path) {
        if (insideStorage(ctx, path)) return [{ kind: "wrote", what: "the view (thread storage)", ...failed }];
        return [{ kind: "wrote", what: shorten(rel(path)), outside: true, ...failed }];
      }
      return [{ kind: "tool", what: shorten(path ? `${tool} ${rel(path)}` : tool), ...failed }];
    }
    default:
      return [];
  }
}

/** All "built from" entries for a thread's events, in order, without repeats. */
export function builtFromEvents(events: readonly EventRow[], ctx: ProvenanceContext): BuiltFrom[] {
  const out: BuiltFrom[] = [];
  const seen = new Set<string>();
  const sorted = [...events].sort((a, b) => Number(a.seq) - Number(b.seq));
  for (const event of sorted) {
    if (event.type !== "item/completed") continue;
    const item = record(event.data)?.item;
    for (const entry of entriesForItem(item, ctx)) {
      const key = `${entry.kind}\u0000${entry.what}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
      if (out.length >= MAX_ENTRIES) return out;
    }
  }
  return out;
}

/** A short count for a card, e.g. "6 files read, 2 commands". */
export function builtFromCount(entries: readonly BuiltFrom[]): string {
  const reads = entries.filter((e) => e.kind === "read").length;
  const searches = entries.filter((e) => e.kind === "search").length;
  const commands = entries.filter((e) => e.kind === "command").length;
  const ledger = entries.filter((e) => e.kind === "ledger").length;
  const parts: string[] = [];
  if (ledger) parts.push(`${ledger} ledger entr${ledger === 1 ? "y" : "ies"}`);
  if (reads) parts.push(`${reads} file${reads === 1 ? "" : "s"} read`);
  if (searches) parts.push(`${searches} search${searches === 1 ? "" : "es"}`);
  if (commands) parts.push(`${commands} command${commands === 1 ? "" : "s"}`);
  if (entries.some((e) => e.outside)) parts.push("wrote outside its storage");
  return parts.length ? parts.join(", ") : "nothing read";
}

/**
 * Page through a thread's events (the SDK returns at most 100 per call),
 * keeping only completed items.
 */
export async function collectEvents(
  list: (args: { afterSeq?: string }) => Promise<readonly EventRow[]>,
  maxPages = 50,
): Promise<EventRow[]> {
  const rows: EventRow[] = [];
  let afterSeq: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const batch = await list(afterSeq === undefined ? {} : { afterSeq });
    rows.push(...batch);
    if (batch.length < 100) break;
    afterSeq = String(batch[batch.length - 1]!.seq);
  }
  return rows;
}

/** The part of a ledger entry "built from" shows. */
export interface LedgerRef {
  id: string;
  for: string;
  command: string;
  output: string;
  exit: number | null;
  /** egg's state for the run; absent in a ledger kept before egg owned run states. */
  state?: RunState | undefined;
  startedMs?: number | null | undefined;
  endedMs?: number | null | undefined;
}

/** A run's state in a few words: "running 14 min", "exit 0 after 3 min", "died", "claimed". */
export function stateWords(e: Pick<LedgerRef, "state" | "exit" | "startedMs" | "endedMs">, now: number): string {
  const took = (from: number | null | undefined, to: number | null | undefined) => (from && to ? ` after ${dur(to - from)}` : "");
  switch (e.state) {
    case "running":
      return `running ${e.startedMs ? dur(now - e.startedMs) : ""}`.trim();
    case "started":
      return "started";
    case "exited":
      return `exit ${e.exit}${took(e.startedMs, e.endedMs)}`;
    case "died":
      return "died: its process is gone and no exit was recorded";
    case "stopped":
      return "stopped by egg";
    case "claimed":
      return "claimed: no run record, so egg cannot vouch for it";
    default:
      return e.exit === null ? "no exit recorded" : `exit ${e.exit}`;
  }
}

export function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** A ledger entry in one line: "r3 · unit tests ×5 · $ npm test · exit 0 after 2 min · → .egg/logs/r3.log". */
export function ledgerLine(e: LedgerRef, now = Date.now()): string {
  const status = e.state ? stateWords({ ...e, state: e.state }, now) : e.exit === null ? "running" : `exit ${e.exit}`;
  const parts = [e.id, e.for || null, e.command ? `$ ${e.command}` : null, status, e.output ? `→ ${e.output}` : null].filter(Boolean);
  return shorten(parts.join(" · "), 400);
}

/** A ledger entry as a "built from" entry, with its state's flags. */
export function ledgerEntry(e: LedgerRef, ranIt: boolean, now = Date.now()): BuiltFrom {
  const failed = e.state ? e.state === "died" || (e.state === "exited" && e.exit !== 0) : e.exit !== null && e.exit !== 0;
  const unconfirmed = e.state ? e.state === "claimed" : !ranIt;
  return { kind: "ledger", what: ledgerLine(e, now), run: e.id, ...(unconfirmed ? { unconfirmed: true } : {}), ...(failed ? { failed: true } : {}) };
}

/** Bring the ledger entries of a "built from" list up to the runs' state now. */
export function refreshLedgerEntries(entries: readonly BuiltFrom[], ledger: readonly LedgerRef[], now = Date.now()): BuiltFrom[] | null {
  const byId = new Map(ledger.map((e) => [e.id, e]));
  let changed = false;
  const out = entries.map((b) => {
    if (b.kind !== "ledger" || !b.run) return b;
    const e = byId.get(b.run);
    if (!e) return b;
    const next = ledgerEntry(e, !b.unconfirmed, now);
    if (next.what === b.what && next.failed === b.failed && next.unconfirmed === b.unconfirmed) return b;
    changed = true;
    return next;
  });
  return changed ? out : null;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** The shell commands a thread's events show it ran. */
export function commandsRun(events: readonly EventRow[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    if (event.type !== "item/completed") continue;
    const item = record(record(event.data)?.item);
    if (item?.type !== "commandExecution") continue;
    const command = str(item.command);
    if (command) out.push(squash(command));
  }
  return out;
}

/**
 * Whether a ledger entry's command shows in what the thread ran: the same
 * command, or one that contains it (a wrapper such as `nohup … &` or a
 * `cd x && …`). A ledger line alone is the model's word, not evidence.
 */
export function ranCommand(ledgerCommand: string, ran: readonly string[]): boolean {
  const want = squash(ledgerCommand);
  if (want.length < 2) return false;
  return ran.some((c) => c === want || c.includes(want) || (want.length > 40 && c.includes(want.slice(0, 40))));
}

/**
 * "Built from" for a view that rests on the room thread's ledger: each
 * entry named that exists, with egg's state for it (a claimed entry, one
 * with no run record, is marked unconfirmed), then the commands the room
 * thread's own events show for the entries. Names not in the ledger are dropped.
 */
export function builtFromLedger(names: readonly string[], ledger: readonly LedgerRef[], workerRan: readonly string[], ctx: ProvenanceContext): { entries: BuiltFrom[]; ids: string[] } {
  const byId = new Map(ledger.map((e) => [e.id, e]));
  const entries: BuiltFrom[] = [];
  const ids: string[] = [];
  const confirmed: string[] = [];
  for (const name of names) {
    const e = byId.get(name);
    if (!e || ids.includes(e.id)) continue;
    ids.push(e.id);
    const ran = ranCommand(e.command, workerRan);
    entries.push(ledgerEntry(e, ran));
    if (ran && e.state !== "claimed") confirmed.push(squash(e.command));
  }
  const seen = new Set<string>();
  for (const command of workerRan) {
    if (!confirmed.some((want) => command === want || command.includes(want) || (want.length > 40 && command.includes(want.slice(0, 40))))) continue;
    const what = shorten(commandInFolder(command, ctx.folder));
    if (seen.has(what)) continue;
    seen.add(what);
    entries.push({ kind: "command", what });
    if (entries.length >= MAX_ENTRIES) break;
  }
  return { entries, ids };
}

/**
 * "Built from" for a page the room thread made itself: the ledger entries
 * it names, checked against its events; when it names none, the commands
 * its events show it ran (the newest), so the list never rests on its word alone.
 */
export function builtFromThreadPage(names: readonly string[], ledger: readonly LedgerRef[], workerRan: readonly string[], ctx: ProvenanceContext): { entries: BuiltFrom[]; ids: string[] } {
  const named = builtFromLedger(names, ledger, workerRan, ctx);
  if (named.ids.length > 0) return named;
  const seen = new Set<string>();
  const entries: BuiltFrom[] = [];
  for (const command of [...workerRan].reverse()) {
    const what = shorten(commandInFolder(command, ctx.folder));
    if (seen.has(what)) continue;
    seen.add(what);
    entries.push({ kind: "command", what });
    if (entries.length >= 40) break;
  }
  return { entries: entries.reverse(), ids: [] };
}
