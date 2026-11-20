import assert from "node:assert/strict";
import { test } from "node:test";
import { noWorkspaceLine, workspaceCandidates, workspaceSetting } from "../src/workspace.ts";

const all = { cloneProviderId: "cow-clone", cloneListed: true, isGitRepo: true, gitIsFile: false, projectCheckout: true };

test("auto tries a clone, then a worktree, and never in place", () => {
  assert.deepEqual(workspaceCandidates("auto", all).map((c) => [c.kind, c.ok]), [["clone", true], ["worktree", true]]);
  const none = workspaceCandidates("auto", { ...all, cloneListed: false, isGitRepo: false });
  assert.deepEqual(none.map((c) => [c.kind, c.ok]), [["clone", false], ["worktree", false]]);
});

test("each way says why it is not available", () => {
  const [clone] = workspaceCandidates("clone", { ...all, gitIsFile: true });
  assert.equal(clone!.ok, false);
  assert.match((clone as { why: string }).why, /\.git is a file/);
  const [unlisted] = workspaceCandidates("clone", { ...all, cloneListed: false, cloneProviderId: "my-clone" });
  assert.match((unlisted as { why: string }).why, /no environment provider "my-clone"/);
  const [wt] = workspaceCandidates("worktree", { ...all, projectCheckout: false });
  assert.match((wt as { why: string }).why, /not a bb project's checkout/);
  assert.deepEqual(workspaceCandidates("in-place", all), [{ kind: "in-place", ok: true }]);
});

test("unknown settings read as auto; the stop line names the way out", () => {
  assert.equal(workspaceSetting("bogus"), "auto");
  assert.equal(workspaceSetting("in-place"), "in-place");
  const line = noWorkspaceLine("auto", [{ kind: "clone", why: "x" }, { kind: "worktree", why: "y" }]);
  assert.match(line, /^No room thread: clone: x; worktree: y\. Work mode needs/);
  assert.match(line, /in-place/);
  assert.match(noWorkspaceLine("clone", [{ kind: "clone", why: "x" }]), /The Workspace setting is clone/);
});
