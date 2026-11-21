// The keys: what each means in each mode, how the selection moves over the
// table, and what a paste does. Pure, so it is tested without a page.

export type Mode = "table" | "large" | "compare" | "rooms" | "legend";

export type Command =
  | { kind: "move"; dx: -1 | 0 | 1; dy: -1 | 0 | 1 }
  | { kind: "first" }
  | { kind: "last" }
  | { kind: "open" }
  | { kind: "close" }
  | { kind: "keep" }
  | { kind: "drop" }
  | { kind: "undo" }
  | { kind: "built-from" }
  | { kind: "round"; by: -1 | 1 }
  | { kind: "latest-round" }
  | { kind: "input" }
  | { kind: "rooms" }
  | { kind: "new-room" }
  | { kind: "legend" }
  | { kind: "more" }
  | { kind: "mark" }
  | { kind: "compare" }
  | { kind: "cross" }
  | { kind: "zoom" }
  | { kind: "up" }
  | { kind: "pin" }
  | { kind: "delete-room" }
  /** w: the line input, straight to the room thread. */
  | { kind: "work-input" }
  /** t: open or close the room thread's chat beside the table. */
  | { kind: "chat" }
  /** S: stop the room thread's turn (y confirms). */
  | { kind: "stop" }
  /** Escape on the table: closes the chat pane when it is open. */
  | { kind: "escape" }
  /** A, X while another browser asks to be enrolled: approve it, refuse it. */
  | { kind: "approve-key" }
  | { kind: "refuse-key" };

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** What a key press asks for in a mode, or null when the page leaves it alone. */
export function commandFor(event: KeyLike, mode: Mode, context: { chatOpen?: boolean; keyRequest?: boolean } = {}): Command | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const k = event.key;
  if (mode === "legend") return k === "Escape" || k === "?" || k === "q" ? { kind: "close" } : null;
  // While another browser asks to be enrolled, A and X answer it, whatever is on screen.
  if (context.keyRequest && (k === "A" || k === "X")) return { kind: k === "A" ? "approve-key" : "refuse-key" };
  if (mode === "rooms") {
    switch (k) {
      case "j":
      case "ArrowDown":
        return { kind: "move", dx: 0, dy: 1 };
      case "k":
      case "ArrowUp":
        return { kind: "move", dx: 0, dy: -1 };
      case "Enter":
        return { kind: "open" };
      case "Escape":
      case "q":
        return { kind: "close" };
      case "n":
        return { kind: "new-room" };
      case "D":
        return { kind: "delete-room" };
      case "u":
        return { kind: "undo" };
      case "?":
        return { kind: "legend" };
      default:
        return null;
    }
  }
  if (mode === "compare") {
    if (k === "Escape" || k === "q" || k === "c") return { kind: "close" };
    if (k === "b") return { kind: "built-from" };
    if (k === "x") return { kind: "cross" };
    if (k === "?") return { kind: "legend" };
    return null;
  }
  switch (k) {
    case "h":
    case "ArrowLeft":
      return { kind: "move", dx: -1, dy: 0 };
    case "l":
    case "ArrowRight":
      return { kind: "move", dx: 1, dy: 0 };
    case "j":
    case "ArrowDown":
      return mode === "table" ? { kind: "move", dx: 0, dy: 1 } : null;
    case "k":
    case "ArrowUp":
      return mode === "table" ? { kind: "move", dx: 0, dy: -1 } : null;
    case "0":
      return { kind: "first" };
    case "$":
      return { kind: "last" };
    case "Enter":
      return mode === "table" ? { kind: "open" } : null;
    case "Escape":
      // On the table Escape is bb's, except to close the room thread's chat.
      return mode === "large" ? { kind: "close" } : mode === "table" && context.chatOpen ? { kind: "escape" } : null;
    case "y":
      return { kind: "keep" };
    case "d":
      return { kind: "drop" };
    case "u":
      return { kind: "undo" };
    case "b":
      return { kind: "built-from" };
    case "[":
      return { kind: "round", by: -1 };
    case "]":
      return { kind: "round", by: 1 };
    case "G":
      return { kind: "latest-round" };
    case "i":
    case "a":
      return { kind: "input" };
    case "r":
      return { kind: "rooms" };
    case "n":
      return { kind: "new-room" };
    case "?":
      return { kind: "legend" };
    case "m":
      return { kind: "more" };
    case "v":
      return { kind: "mark" };
    case "c":
      return { kind: "compare" };
    case "x":
      return { kind: "cross" };
    case "z":
      return { kind: "zoom" };
    case "-":
      return { kind: "up" };
    case "p":
      return { kind: "pin" };
    case "w":
      return { kind: "work-input" };
    case "t":
      return { kind: "chat" };
    case "S":
      return { kind: "stop" };
    default:
      return null;
  }
}

/**
 * After S, the next key decides: y stops the room thread's turn, any other
 * key (Escape included) leaves it running. The same rule confirms A, which
 * approves a browser that asks to be enrolled: "stop" there means yes.
 */
export function confirmStop(event: KeyLike): "stop" | "cancel" | "ignore" {
  if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)) return "ignore";
  return event.key === "y" && !event.ctrlKey && !event.metaKey && !event.altKey ? "stop" : "cancel";
}

/**
 * v on a view: mark it, or unmark it if marked. At most two marks; a third
 * replaces the older. The first of the two is A in a cross, the second B.
 */
export function toggleMark(marks: readonly string[], viewId: string): string[] {
  if (marks.includes(viewId)) return marks.filter((m) => m !== viewId);
  return [...marks, viewId].slice(-2);
}

/** Marks still pointing at views that exist and have a view to show. */
export function liveMarks(marks: readonly string[], views: Record<string, { status: string }>): string[] {
  return marks.filter((m) => views[m]?.status === "done");
}

/** True when the focused element takes text, so page keys must stay out of its way. */
export function isEditable(el: { tagName?: string; isContentEditable?: boolean; type?: string } | null): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file"].includes((el.type ?? "text").toLowerCase());
}

export interface Selection {
  row: number;
  col: number;
}

/**
 * Move over rows of differing lengths (the round's cards, then the kept
 * strip). Empty rows are skipped; the column is clamped to the row.
 */
export function moveSelection(sel: Selection, rows: readonly number[], dx: number, dy: number): Selection {
  const filled = rows.map((n, i) => (n > 0 ? i : -1)).filter((i) => i >= 0);
  if (filled.length === 0) return { row: 0, col: 0 };
  let row = filled.includes(sel.row) ? sel.row : filled[0]!;
  if (dy !== 0) {
    const at = filled.indexOf(row);
    row = filled[Math.max(0, Math.min(filled.length - 1, at + dy))]!;
  }
  const len = rows[row]!;
  const col = Math.max(0, Math.min(len - 1, (row === sel.row ? sel.col : Math.min(sel.col, len - 1)) + dx));
  return { row, col };
}

/**
 * The table as rows of what is on screen: the round's cards wrapped at
 * `cols` per row, then the kept strip as the last row.
 */
export function tableRows(cards: number, cols: number, kept: number): number[] {
  const per = Math.max(1, cols);
  const rows: number[] = [];
  for (let i = 0; i < cards; i += per) rows.push(Math.min(per, cards - i));
  if (rows.length === 0) rows.push(0);
  rows.push(kept);
  return rows;
}

/** Which card a selection points at: one of the round's, or one in the kept strip. */
export function pickAt(sel: Selection, rows: readonly number[], cols: number): { kept: boolean; index: number } {
  if (sel.row === rows.length - 1) return { kept: true, index: sel.col };
  return { kept: false, index: sel.row * Math.max(1, cols) + sel.col };
}

/** The selection for a round's card or a kept card. */
export function selectionFor(kept: boolean, index: number, rows: readonly number[], cols: number): Selection {
  if (kept) return { row: rows.length - 1, col: index };
  const per = Math.max(1, cols);
  return { row: Math.floor(index / per), col: index % per };
}

/**
 * h and l move through the round's cards in reading order, across the
 * rows of the grid; j and k move straight up and down. The kept strip is
 * one row of its own.
 */
export function moveOnTable(sel: Selection, rows: readonly number[], cols: number, dx: number, dy: number): Selection {
  if (dy !== 0 || dx === 0) return moveSelection(sel, rows, 0, dy);
  const at = pickAt(clampSelection(sel, rows), rows, cols);
  if (at.kept) return moveSelection(sel, rows, dx, 0);
  const cards = rows.slice(0, -1).reduce((a, b) => a + b, 0);
  if (cards === 0) return clampSelection(sel, rows);
  return selectionFor(false, Math.max(0, Math.min(cards - 1, at.index + dx)), rows, cols);
}

export function clampSelection(sel: Selection, rows: readonly number[]): Selection {
  return moveSelection(sel, rows, 0, 0);
}

/** A pasted or dictated line: one line, whitespace folded. */
export function asLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export type PasteAction =
  | { kind: "native" }
  | { kind: "ignore" }
  | { kind: "open-input"; text: string }
  | { kind: "send"; text: string }
  | { kind: "new-room"; text: string };

/**
 * A paste on the page. In a text field it is the field's own. Otherwise it
 * must not be lost: it opens the line input with the text in it, or sends
 * it at once when the setting says so. With no room open it starts a new
 * room with the text as its first line.
 */
export function pasteAction(input: { editableFocused: boolean; roomOpen: boolean; sendAtOnce: boolean; text: string }): PasteAction {
  if (input.editableFocused) return { kind: "native" };
  const text = asLine(input.text);
  if (!text) return { kind: "ignore" };
  if (!input.roomOpen) return { kind: "new-room", text };
  return input.sendAtOnce ? { kind: "send", text } : { kind: "open-input", text };
}

/** The hold-to-talk key setting as a KeyboardEvent.code, or null when off. */
export function holdKeyCode(setting: string | undefined): string | null {
  if (setting === "off") return null;
  if (setting === "Backquote") return "Backquote";
  return "Space";
}

/** The legend, grouped as the person works. */
export const LEGEND: readonly { title: string; keys: readonly [string, string][] }[] = [
  {
    title: "Saying a line",
    keys: [
      ["i", "open the line input (a also); Enter sends, Escape leaves"],
      ["paste", "anywhere on the page opens the line input with the text in it"],
      ["hold Space", "record while held, transcribe on release (clips under 1 s are ignored; key or off in settings)"],
      ["w", "a line straight to the room thread: it does the work, no planning step"],
    ],
  },
  {
    title: "The room thread",
    keys: [
      ["t", "open or close its chat beside the table (bb's questions and permission requests are answered there)"],
      ["i", "with the chat open: type in the chat"],
      ["Esc", "close the chat"],
      ["S", "stop its turn; y confirms, any other key leaves it running"],
    ],
  },
  {
    title: "The table",
    keys: [
      ["h l", "previous, next card (arrows too); 0 and $ first and last"],
      ["j k", "down and up the grid of cards, and to the kept strip"],
      ["Enter", "open the selected view large; Escape closes it"],
      ["y", "keep: writes it to the room's directory"],
      ["d", "drop: off the table, still in the notebook"],
      ["u", "undo the last keep or drop"],
      ["b", "show or hide what the view was built from"],
      ["[ ]", "previous, next round; G the latest"],
    ],
  },
  {
    title: "Going further (table or kept strip)",
    keys: [
      ["m", "more like this: four variations along different named axes"],
      ["v", "mark or unmark the view (two at most; a third replaces the older)"],
      ["c", "compare the two marked views large, side by side; Escape closes"],
      ["x", "cross the two marked views: two views, each part labelled A, B or both"],
      ["z", "zoom into a part of the view: name it, and a child room starts"],
      ["-", "up to the parent room, at the view it was zoomed from"],
      ["p", "pin or unpin the view: the next lines get it as reference"],
    ],
  },
  {
    title: "Rooms",
    keys: [
      ["r", "the list of rooms, child rooms under their parents (j k, Enter)"],
      ["D", "in the list: delete the room (kept files stay); u undoes"],
      ["n", "a new room: a folder and a first line"],
      ["?", "this legend"],
    ],
  },
  {
    title: "Another browser (only while one asks)",
    keys: [
      ["A", "approve the browser that asks to use egg as you, once it shows the same key; y confirms, any other key leaves it waiting"],
      ["X", "refuse it"],
    ],
  },
];
