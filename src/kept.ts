// Kept views are plain files: the view itself (.html or .txt) and a small
// JSON file beside it saying where it came from.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Room, Round, View } from "./model.ts";
import type { ViewContent } from "./store.ts";

export const DEFAULT_ROOMS_DIR = "~/egg";

export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

export function slug(text: string, max = 40): string {
  const s = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return s || "room";
}

/** A room's directory: readable name first, the id after so two rooms never share one. */
export function roomDir(roomsDir: string, subject: string, roomId: string): string {
  return join(expandHome(roomsDir), `${slug(subject)}-${roomId.replace(/^room_/, "").slice(0, 6)}`);
}

export function keptBaseName(round: Round, view: View): string {
  return `round-${round.n}-${view.slot + 1}-${slug(view.angle, 30)}`;
}

export interface KeptRecord {
  room: {
    id: string;
    subject: string;
    folder: string;
    /** For a child room: the room and view it was zoomed from. */
    parent: { roomId: string; subject: string; roundId: string; viewId: string; angle: string } | null;
  };
  line: string;
  round: number;
  /** line, more (a variation), cross or zoom. */
  kind: string;
  angle: string;
  /** A variation's axis or a cross's way of combining. */
  axis: string | null;
  focus: string;
  /** The views it was derived from: room, round, view, and how each was used. */
  parents: { roomId: string; roomSubject: string; round: number; roundId: string; viewId: string; angle: string; label: "A" | "B" | null; role: string }[];
  model: string;
  keptAt: string;
  builtAt: string | null;
  file: string;
  builtFrom: View["builtFrom"];
}

export function keptRecord(room: Room, round: Round, view: View, file: string, now: number): KeptRecord {
  return {
    room: {
      id: room.id,
      subject: room.subject,
      folder: room.folder,
      parent: room.parent
        ? { roomId: room.parent.roomId, subject: room.parent.roomSubject, roundId: room.parent.roundId, viewId: room.parent.viewId, angle: room.parent.angle }
        : null,
    },
    line: round.line,
    round: round.n,
    kind: round.kind ?? "line",
    angle: view.angle,
    axis: view.axis ?? null,
    focus: view.focus,
    parents: (view.parents ?? []).map((p) => ({
      roomId: p.roomId,
      roomSubject: p.roomSubject,
      round: p.round,
      roundId: p.roundId,
      viewId: p.viewId,
      angle: p.angle,
      label: p.label ?? null,
      role: p.role,
    })),
    model: view.model,
    keptAt: new Date(now).toISOString(),
    builtAt: view.finishedAt === null ? null : new Date(view.finishedAt).toISOString(),
    file,
    builtFrom: view.builtFrom,
  };
}

/** Write a kept view and its record into the room's directory; returns the view file's path. */
export async function writeKept(room: Room, round: Round, view: View, content: ViewContent, now = Date.now()): Promise<string> {
  await mkdir(room.dir, { recursive: true });
  const base = keptBaseName(round, view);
  const file = `${base}.${content.format === "html" ? "html" : "txt"}`;
  const path = join(room.dir, file);
  await writeFile(path, content.content, "utf8");
  await writeFile(join(room.dir, `${base}.json`), `${JSON.stringify(keptRecord(room, round, view, file, now), null, 2)}\n`, "utf8");
  return path;
}

/** Undo a keep: take the two files away again. */
export async function removeKept(room: Room, round: Round, view: View): Promise<void> {
  const base = keptBaseName(round, view);
  await Promise.all(
    [`${base}.html`, `${base}.txt`, `${base}.json`].map((name) => rm(join(room.dir, name), { force: true })),
  );
}
