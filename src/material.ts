// Material: what the room thread makes, kept in `.egg/` at the top of its
// workspace so every thread in the room can use it, and copied out to the
// room's directory so it outlives the workspace.
//
//   .egg/ledger.jsonl   one entry per run: when, what for, the command, where the output is, exit status
//   .egg/notes.jsonl    short progress lines for the person
//   .egg/views/         pages for the table, each with a .json beside it naming it and the ledger entries it rests on
//   .egg/...            the scripts and result files the thread needs
//
// Files, not a CLI, so nothing new is exposed and any provider works. Every
// file here was written by a model that ran arbitrary code: it is parsed
// defensively, capped, and never followed through a symlink.
import { lstat, mkdir, readdir, readFile, writeFile, copyFile, utimes } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";

export const MATERIAL_DIR = ".egg";
export const LEDGER_FILE = "ledger.jsonl";
export const NOTES_FILE = "notes.jsonl";
export const VIEWS_DIR = "views";
/** At most this many ledger entries are kept with the room (the newest). */
export const MAX_LEDGER = 500;
/** At most this many files are copied out of one workspace. */
export const MAX_FILES = 5000;
/** A view file larger than this is not put on the table. */
export const MAX_VIEW_BYTES = 400_000;
/** The ledger and notes are read up to this size; the rest is ignored and said. */
export const MAX_JSONL_BYTES = 8_000_000;

const text = (max: number) => z.string().transform((s) => s.replace(/\s+/g, " ").trim().slice(0, max));

/** One run, as the room thread recorded it. Later lines with the same id replace earlier ones (a run that finished). */
export const ledgerEntrySchema = z.object({
  id: text(60).pipe(z.string().min(1)),
  at: text(40).optional().default(""),
  for: text(300).optional().default(""),
  command: text(1000).optional().default(""),
  output: text(400).optional().default(""),
  /** The exit status; null while it still runs. */
  exit: z.number().int().nullable().optional().default(null),
});
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

export const noteSchema = z.object({ at: text(40).optional().default(""), text: text(600).pipe(z.string().min(1)) });
export type Note = z.infer<typeof noteSchema>;

/** The JSON beside a page in views/. */
export const viewSidecarSchema = z.object({
  title: text(120).optional(),
  focus: text(400).optional(),
  ledger: z.array(text(60)).max(100).optional().default([]),
});
export type ViewSidecar = z.infer<typeof viewSidecarSchema>;

/**
 * A line that is not valid JSON only because of a backslash JSON does not
 * know (`\p{L}`, `\X`, `\d` written into a string as they stand), with those
 * backslashes doubled. Escapes JSON does know are left alone.
 */
export function repairEscapes(line: string): string {
  return line.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})?/g, (all, known) => (known === undefined ? "\\\\" : all));
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (e) {
    const repaired = repairEscapes(line);
    if (repaired === line) throw e;
    return JSON.parse(repaired);
  }
}

/**
 * Lines of a .jsonl file that parse as `schema`; the rest are counted, not
 * thrown. A line with a stray backslash is repaired and read. A last line
 * with no newline after it that does not parse is still being written: it is
 * not counted.
 */
export function parseJsonl<T>(content: string, schema: z.ZodType<T, unknown>): { items: T[]; bad: number } {
  const items: T[] = [];
  let bad = 0;
  const raws = content.split("\n");
  raws.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const unfinished = i === raws.length - 1;
    try {
      const parsed = schema.safeParse(parseLine(line));
      if (parsed.success) items.push(parsed.data);
      else bad++;
    } catch {
      if (!unfinished) bad++;
    }
  });
  return { items, bad };
}

/** Ledger lines to entries: one per id, a later line replacing an earlier, in order of first appearance; the newest MAX_LEDGER kept. */
export function mergeLedger(entries: readonly LedgerEntry[]): LedgerEntry[] {
  const byId = new Map<string, LedgerEntry>();
  for (const e of entries) {
    const before = byId.get(e.id);
    // A finishing line often carries only id and exit: keep what the starting line said.
    byId.set(e.id, before ? { ...before, ...Object.fromEntries(Object.entries(e).filter(([, v]) => v !== "" && v !== null)), exit: e.exit ?? before.exit } : e);
  }
  return [...byId.values()].slice(-MAX_LEDGER);
}

/** A page in views/: its name without extension, and its format. */
export function viewFileKind(name: string): { base: string; format: "html" | "text" } | null {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]{0,80})\.(html|txt)$/.exec(name);
  if (!m) return null;
  return { base: m[1]!, format: m[2] === "html" ? "html" : "text" };
}

/** A version of a file as seen: its size and when it last changed. */
export const stamp = (size: number, mtimeMs: number) => `${size}:${Math.floor(mtimeMs)}`;

export interface FileFact {
  /** Path relative to the material folder, with forward slashes. */
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * Every regular file under `root`, relative to it. Symlinks, sockets and
 * the like are left out, never followed. Stops at MAX_FILES.
 */
export async function listFiles(root: string, max = MAX_FILES): Promise<{ files: FileFact[]; truncated: boolean }> {
  const files: FileFact[] = [];
  let truncated = false;
  async function walk(dir: string) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= max) {
        truncated = true;
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const info = await lstat(full).catch(() => null);
        if (info?.isFile()) files.push({ path: relative(root, full).split(sep).join("/"), size: info.size, mtimeMs: info.mtimeMs });
      }
    }
  }
  await walk(root);
  return { files, truncated };
}

export interface CopyResult {
  copied: string[];
  /** Files over the size limit, with their sizes: not copied. */
  skipped: { path: string; size: number }[];
  truncated: boolean;
}

/**
 * Copy the material folder out: every regular file at most `maxBytes`,
 * only those that changed since the copy already there (by size and time).
 * Nothing is deleted from the copy: what the thread removed stays saved.
 */
export async function copyOut(from: string, to: string, maxBytes: number): Promise<CopyResult> {
  const { files, truncated } = await listFiles(from);
  const copied: string[] = [];
  const skipped: { path: string; size: number }[] = [];
  for (const file of files) {
    if (file.size > maxBytes) {
      skipped.push({ path: file.path, size: file.size });
      continue;
    }
    const dest = join(to, ...file.path.split("/"));
    const there = await lstat(dest).catch(() => null);
    if (there?.isSymbolicLink()) continue;
    if (there?.isFile() && there.size === file.size && Math.floor(there.mtimeMs) === Math.floor(file.mtimeMs)) continue;
    await mkdir(join(dest, ".."), { recursive: true });
    await copyFile(join(from, ...file.path.split("/")), dest);
    const at = new Date(file.mtimeMs);
    await utimes(dest, at, at).catch(() => undefined);
    copied.push(file.path);
  }
  return { copied, skipped, truncated };
}

/**
 * Put saved material back into a fresh workspace, before its first turn.
 * Only into a workspace that has no material yet: never over newer work.
 */
export async function restore(saved: string, into: string): Promise<{ restored: number; skippedBecause: string | null }> {
  const present = await lstat(into).catch(() => null);
  if (present) return { restored: 0, skippedBecause: "the workspace already has material" };
  const savedInfo = await lstat(saved).catch(() => null);
  if (!savedInfo?.isDirectory()) return { restored: 0, skippedBecause: "nothing was saved" };
  const result = await copyOut(saved, into, Number.MAX_SAFE_INTEGER);
  return { restored: result.copied.length, skippedBecause: null };
}

/** Read a small text file, or null when it is missing, not a regular file, or larger than `max`. */
export async function readSmall(path: string, max: number): Promise<{ content: string; size: number; truncated: boolean } | null> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile()) return null;
  const buf = await readFile(path).catch(() => null);
  if (!buf) return null;
  const truncated = buf.length > max;
  return { content: buf.subarray(0, max).toString("utf8"), size: info.size, truncated };
}

/**
 * Keep the material out of git without editing .gitignore: add it to the
 * repository's info/exclude. `excludePath` is from `git rev-parse --git-path
 * info/exclude`, so a worktree's goes to its common directory.
 */
export async function excludeFromGit(excludePath: string): Promise<boolean> {
  const current = (await readFile(excludePath, "utf8").catch(() => "")) ?? "";
  if (current.split("\n").some((l) => l.trim() === `/${MATERIAL_DIR}/` || l.trim() === `/${MATERIAL_DIR}`)) return false;
  await mkdir(join(excludePath, ".."), { recursive: true });
  const sep2 = current === "" || current.endsWith("\n") ? "" : "\n";
  await writeFile(excludePath, `${current}${sep2}# egg's material (see .egg/)\n/${MATERIAL_DIR}/\n`, "utf8");
  return true;
}

/** Sizes for a note: 21 MB. */
export function megabytes(bytes: number): string {
  return `${Math.round((bytes / 1_000_000) * 10) / 10} MB`;
}
