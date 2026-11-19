import assert from "node:assert/strict";
import { test } from "node:test";
import { builtFromCount, builtFromEvents, collectEvents, type EventRow } from "../src/provenance.ts";

const ctx = { folder: "/work/repo", storageRoot: "/data/thread-storage/thr_1" };
let seq = 0;
const done = (item: Record<string, unknown>): EventRow => ({ seq: ++seq, type: "item/completed", data: { item: { status: "completed", ...item } } });

test("built from comes from completed items, relative to the folder, in order, without repeats", () => {
  const events: EventRow[] = [
    { seq: 0, type: "item/started", data: { item: { type: "commandExecution", command: "ls" } } },
    done({ type: "commandExecution", command: "ls src" }),
    done({ type: "toolCall", tool: "Read", arguments: { file_path: "/work/repo/src/a.ts" } }),
    done({ type: "toolCall", tool: "Read", arguments: { file_path: "/work/repo/src/a.ts" } }),
    done({ type: "fileRead", path: "/work/repo/README.md" }),
    done({ type: "toolCall", tool: "Grep", arguments: { pattern: "auth", path: "/work/repo/src" } }),
    done({ type: "search", query: "*.ts", path: "/work/repo" }),
    done({ type: "toolCall", tool: "Skill", arguments: { skill: "x" } }),
    done({ type: "agentMessage", text: "I read every file in the repository" }),
    done({ type: "commandExecution", command: 'cat > "$BB_THREAD_STORAGE/view.html" <<\'EOF\'\n<html>…</html>\nEOF' }),
  ];
  assert.deepEqual(builtFromEvents(events, ctx), [
    { kind: "command", what: "ls src" },
    { kind: "read", what: "src/a.ts" },
    { kind: "read", what: "README.md" },
    { kind: "search", what: "auth in src" },
    { kind: "search", what: "*.ts in ." },
    { kind: "wrote", what: "the view (thread storage)" },
  ]);
});

test("what the model says it did is never evidence; writes outside storage are flagged", () => {
  const events: EventRow[] = [
    done({ type: "agentMessage", text: "Read src/secret.ts and ran tests" }),
    done({ type: "fileChange", changes: [{ path: "/work/repo/src/a.ts", kind: "update" }, { path: "/data/thread-storage/thr_1/view.html", kind: "add" }] }),
    done({ type: "toolCall", tool: "Write", arguments: { file_path: "/data/thread-storage/thr_1/view.txt" } }),
    done({ type: "commandExecution", command: "rm -rf build", status: "failed" }),
  ];
  const entries = builtFromEvents(events, ctx);
  assert.deepEqual(entries, [
    { kind: "wrote", what: "src/a.ts", outside: true },
    { kind: "wrote", what: "the view (thread storage)" },
    { kind: "command", what: "rm -rf build", failed: true },
  ]);
  assert.equal(builtFromCount(entries), "1 command, wrote outside its storage");
});

test("long commands are shortened to one line", () => {
  const [entry] = builtFromEvents([done({ type: "commandExecution", command: `grep -rn x\n${"y".repeat(1000)}` })], ctx);
  assert.ok(entry!.what.length <= 300);
  assert.ok(!entry!.what.includes("\n"));
});

test("collectEvents pages 100 at a time from the last seq", async () => {
  const all = Array.from({ length: 230 }, (_, i) => ({ seq: i + 1, type: "item/completed" }));
  const calls: (string | undefined)[] = [];
  const rows = await collectEvents(async ({ afterSeq }) => {
    calls.push(afterSeq);
    const from = afterSeq === undefined ? 0 : Number(afterSeq);
    return all.filter((e) => e.seq > from).slice(0, 100);
  });
  assert.equal(rows.length, 230);
  assert.deepEqual(calls, [undefined, "100", "200"]);
});

test("counts read naturally", () => {
  assert.equal(builtFromCount([]), "nothing read");
  assert.equal(builtFromCount([{ kind: "read", what: "a" }, { kind: "read", what: "b" }, { kind: "search", what: "q" }]), "2 files read, 1 search");
});
