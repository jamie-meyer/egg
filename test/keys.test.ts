import assert from "node:assert/strict";
import { test } from "node:test";
import { commandFor, holdKeyCode, isEditable, moveSelection, pasteAction, pickAt, selectionFor, tableRows } from "../src/keys.ts";

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
