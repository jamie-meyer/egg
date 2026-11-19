// "Built from": what a view's thread actually did, taken from the thread's
// own event stream (completed items), never from what the model says it did.
import type { BuiltFrom } from "./model.ts";

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
  const parts: string[] = [];
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
