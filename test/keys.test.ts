import assert from "node:assert/strict";
import { test } from "node:test";
import { LEGEND, commandFor, holdKeyCode, isEditable, liveMarks, moveOnTable, moveSelection, pasteAction, pickAt, selectionFor, tableRows, toggleMark } from "../src/keys.ts";

test("table keys", () => {
  assert.deepEqual(commandFor({ key: "h" }, "table"), { kind: "move", dx: -1, dy: 0 });
  assert.deepEqual(commandFor({ key: "l" }, "table"), { kind: "move", dx: 1, dy: 0 });
  assert.deepEqual(commandFor({ key: "j" }, "table"), { kind: "move", dx: 0, dy: 1 });
  assert.deepEqual(commandFor({ key: "Enter" }, "table"), { kind: "open" });
  assert.deepEqual(commandFor({ key: "y" }, "table"), { kind: "keep" });
  assert.deepEqual(commandFor({ key: "d" }, "table"), { kind: "drop" });
  assert.deepEqual(commandFor({ key: "u" }, "table"), { kind: "undo" });
  assert.deepEqual(commandFor({ key: "b" }, "table"), { kind: "built-from" });
  assert.deepEqual(commandFor({ key: "[" }, "table"), { kind: "round", by: -1 });
  assert.deepEqual(commandFor({ key: "]" }, "table"), { kind: "round", by: 1 });
  assert.deepEqual(commandFor({ key: "?" }, "table"), { kind: "legend" });
  assert.deepEqual(commandFor({ key: "i" }, "table"), { kind: "input" });
  assert.equal(commandFor({ key: "Escape" }, "table"), null, "Escape on the table is bb's");
  assert.equal(commandFor({ key: "d", metaKey: true }, "table"), null);
});

test("large and overlay keys", () => {
  assert.deepEqual(commandFor({ key: "Escape" }, "large"), { kind: "close" });
  assert.deepEqual(commandFor({ key: "l" }, "large"), { kind: "move", dx: 1, dy: 0 });
  assert.equal(commandFor({ key: "j" }, "large"), null);
  assert.deepEqual(commandFor({ key: "y" }, "large"), { kind: "keep" });
  assert.deepEqual(commandFor({ key: "j" }, "rooms"), { kind: "move", dx: 0, dy: 1 });
  assert.deepEqual(commandFor({ key: "Enter" }, "rooms"), { kind: "open" });
  assert.equal(commandFor({ key: "y" }, "rooms"), null);
  assert.deepEqual(commandFor({ key: "Escape" }, "legend"), { kind: "close" });
  assert.equal(commandFor({ key: "d" }, "legend"), null);
});

test("selection moves over the cards and the kept strip", () => {
  assert.deepEqual(moveSelection({ row: 0, col: 0 }, [4, 2], 1, 0), { row: 0, col: 1 });
  assert.deepEqual(moveSelection({ row: 0, col: 3 }, [4, 2], 1, 0), { row: 0, col: 3 });
  assert.deepEqual(moveSelection({ row: 0, col: 3 }, [4, 2], 0, 1), { row: 1, col: 1 });
  assert.deepEqual(moveSelection({ row: 1, col: 1 }, [4, 2], 0, -1), { row: 0, col: 1 });
  assert.deepEqual(moveSelection({ row: 0, col: 2 }, [3, 0], 0, 1), { row: 0, col: 2 }, "an empty strip is skipped");
  assert.deepEqual(moveSelection({ row: 0, col: 2 }, [0, 2], 0, 0), { row: 1, col: 1 }, "all cards dropped: the strip");
  assert.deepEqual(moveSelection({ row: 0, col: 2 }, [0, 0], 1, 0), { row: 0, col: 0 });
});

test("a paste in normal mode opens the line input with the text, never lost", () => {
  assert.deepEqual(pasteAction({ editableFocused: false, roomOpen: true, sendAtOnce: false, text: "  where is the\nconfig read?  " }), { kind: "open-input", text: "where is the config read?" });
});

test("with 'send a pasted line at once' the paste is sent without Enter", () => {
  assert.deepEqual(pasteAction({ editableFocused: false, roomOpen: true, sendAtOnce: true, text: "what ports?" }), { kind: "send", text: "what ports?" });
});

test("a paste in a text field is the field's own; empty pastes do nothing; no room starts one", () => {
  assert.deepEqual(pasteAction({ editableFocused: true, roomOpen: true, sendAtOnce: true, text: "x" }), { kind: "native" });
  assert.deepEqual(pasteAction({ editableFocused: false, roomOpen: true, sendAtOnce: false, text: " \n " }), { kind: "ignore" });
  assert.deepEqual(pasteAction({ editableFocused: false, roomOpen: false, sendAtOnce: true, text: "a first line" }), { kind: "new-room", text: "a first line" });
});

test("what counts as a text field", () => {
  assert.equal(isEditable({ tagName: "INPUT", type: "text" }), true);
  assert.equal(isEditable({ tagName: "INPUT" }), true);
  assert.equal(isEditable({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isEditable({ tagName: "TEXTAREA" }), true);
  assert.equal(isEditable({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isEditable({ tagName: "DIV" }), false);
  assert.equal(isEditable(null), false);
});

test("the hold-to-talk key can be turned off", () => {
  assert.equal(holdKeyCode(undefined), "Space");
  assert.equal(holdKeyCode("Space"), "Space");
  assert.equal(holdKeyCode("Backquote"), "Backquote");
  assert.equal(holdKeyCode("off"), null);
});

test("j and k follow the grid as it is laid out, then reach the kept strip", () => {
  const rows = tableRows(4, 2, 3);
  assert.deepEqual(rows, [2, 2, 3]);
  let sel = selectionFor(false, 0, rows, 2);
  sel = moveSelection(sel, rows, 0, 1);
  assert.deepEqual(pickAt(sel, rows, 2), { kept: false, index: 2 });
  sel = moveSelection(sel, rows, 1, 0);
  assert.deepEqual(pickAt(sel, rows, 2), { kept: false, index: 3 });
  sel = moveSelection(sel, rows, 0, 1);
  assert.deepEqual(pickAt(sel, rows, 2), { kept: true, index: 1 });
  assert.deepEqual(tableRows(3, 4, 0), [3, 0]);
  assert.deepEqual(tableRows(0, 2, 1), [0, 1]);
  assert.deepEqual(selectionFor(true, 0, [0, 1], 2), { row: 1, col: 0 });
});

test("h and l read the cards in order across the grid's rows", () => {
  const rows = tableRows(4, 2, 2);
  let sel = selectionFor(false, 1, rows, 2);
  sel = moveOnTable(sel, rows, 2, 1, 0);
  assert.deepEqual(pickAt(sel, rows, 2), { kept: false, index: 2 }, "l at a row's end goes on to the next row");
  sel = moveOnTable(sel, rows, 2, -1, 0);
  assert.deepEqual(pickAt(sel, rows, 2), { kept: false, index: 1 });
  sel = moveOnTable(selectionFor(false, 3, rows, 2), rows, 2, 1, 0);
  assert.deepEqual(pickAt(sel, rows, 2), { kept: false, index: 3 }, "stops at the last card");
  sel = moveOnTable(selectionFor(true, 0, rows, 2), rows, 2, 1, 0);
  assert.deepEqual(pickAt(sel, rows, 2), { kept: true, index: 1 }, "the kept strip is its own row");
  sel = moveOnTable(selectionFor(false, 0, rows, 2), rows, 2, 0, 1);
  assert.deepEqual(pickAt(sel, rows, 2), { kept: false, index: 2 }, "j goes straight down");
});

test("slice 2 keys: m v c x z - p on the table and large; D and u in the room list; compare", () => {
  for (const mode of ["table", "large"] as const) {
    assert.deepEqual(commandFor({ key: "m" }, mode), { kind: "more" });
    assert.deepEqual(commandFor({ key: "v" }, mode), { kind: "mark" });
    assert.deepEqual(commandFor({ key: "c" }, mode), { kind: "compare" });
    assert.deepEqual(commandFor({ key: "x" }, mode), { kind: "cross" });
    assert.deepEqual(commandFor({ key: "z" }, mode), { kind: "zoom" });
    assert.deepEqual(commandFor({ key: "-" }, mode), { kind: "up" });
    assert.deepEqual(commandFor({ key: "p" }, mode), { kind: "pin" });
  }
  assert.deepEqual(commandFor({ key: "D" }, "rooms"), { kind: "delete-room" });
  assert.deepEqual(commandFor({ key: "u" }, "rooms"), { kind: "undo" });
  assert.equal(commandFor({ key: "d" }, "rooms"), null, "lower-case d does not delete a room");
  assert.deepEqual(commandFor({ key: "Escape" }, "compare"), { kind: "close" });
  assert.deepEqual(commandFor({ key: "x" }, "compare"), { kind: "cross" });
  assert.deepEqual(commandFor({ key: "b" }, "compare"), { kind: "built-from" });
  assert.equal(commandFor({ key: "y" }, "compare"), null);
});

test("marks: v toggles, two at most, a third replaces the older", () => {
  assert.deepEqual(toggleMark([], "a"), ["a"]);
  assert.deepEqual(toggleMark(["a"], "b"), ["a", "b"]);
  assert.deepEqual(toggleMark(["a", "b"], "c"), ["b", "c"]);
  assert.deepEqual(toggleMark(["a", "b"], "a"), ["b"]);
  assert.deepEqual(liveMarks(["a", "b", "c"], { a: { status: "done" }, b: { status: "running" } }), ["a"]);
});

test("every key in the legend is one the page answers", () => {
  const all = LEGEND.flatMap((g) => g.keys.map(([k]) => k));
  for (const k of ["m", "v", "c", "x", "z", "-", "p", "D"]) assert.ok(all.includes(k), `${k} in the legend`);
});

test("room thread keys: w, t, S; Escape on the table only while its chat is open; y confirms a stop", async () => {
  const { commandFor, confirmStop, LEGEND } = await import("../src/keys.ts");
  assert.deepEqual(commandFor({ key: "w" }, "table"), { kind: "work-input" });
  assert.deepEqual(commandFor({ key: "t" }, "table"), { kind: "chat" });
  assert.deepEqual(commandFor({ key: "S" }, "table"), { kind: "stop" });
  assert.equal(commandFor({ key: "Escape" }, "table"), null);
  assert.deepEqual(commandFor({ key: "Escape" }, "table", { chatOpen: true }), { kind: "escape" });
  assert.deepEqual(commandFor({ key: "Escape" }, "large", { chatOpen: true }), { kind: "close" });
  assert.equal(confirmStop({ key: "y" }), "stop");
  assert.equal(confirmStop({ key: "n" }), "cancel");
  assert.equal(confirmStop({ key: "Escape" }), "cancel");
  assert.equal(confirmStop({ key: "y", metaKey: true }), "cancel");
  assert.equal(confirmStop({ key: "Shift" }), "ignore");
  const keys = LEGEND.flatMap((g) => g.keys.map(([k]) => k));
  for (const k of ["w", "t", "S", "i", "y", "d", "m", "x", "z", "p", "r", "n"]) assert.ok(keys.some((x) => x.split(" ").includes(k)), k);
});

test("A and X approve and refuse a browser that asks, and mean nothing otherwise", () => {
  assert.deepEqual(commandFor({ key: "A" }, "table", { keyRequest: true }), { kind: "approve-key" });
  assert.deepEqual(commandFor({ key: "X" }, "table", { keyRequest: true }), { kind: "refuse-key" });
  assert.deepEqual(commandFor({ key: "A" }, "large", { keyRequest: true }), { kind: "approve-key" });
  assert.equal(commandFor({ key: "A" }, "table"), null);
  assert.equal(commandFor({ key: "X" }, "table", { keyRequest: false }), null);
  // The lower-case keys keep their meaning while a browser asks.
  assert.deepEqual(commandFor({ key: "a" }, "table", { keyRequest: true }), { kind: "input" });
  assert.deepEqual(commandFor({ key: "x" }, "table", { keyRequest: true }), { kind: "cross" });
  assert.deepEqual(commandFor({ key: "A" }, "rooms", { keyRequest: true }), { kind: "approve-key" });
  assert.deepEqual(commandFor({ key: "X" }, "compare", { keyRequest: true }), { kind: "refuse-key" });
  assert.equal(commandFor({ key: "A" }, "legend", { keyRequest: true }), null);
});
