import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error a plain script module, no types
import { copyProblem } from "../scripts/check-copy.mjs";

function copy(name: string, identity: { rooms?: string; prefix?: string; key?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "egg-copy-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `bb-plugin-${name}`, bb: { name } }));
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "src", "identity.ts"),
    [`export const DEFAULT_ROOMS_DIR = ${JSON.stringify(identity.rooms ?? "~/egg-check-rooms")};`, `export const DEFAULT_TITLE_PREFIX = ${JSON.stringify(identity.prefix ?? "egg test")};`, `export const DEFAULT_OPEN_KEY = ${JSON.stringify(identity.key ?? "9")};`].join("\n"),
  );
  return dir;
}

test("a copy that says plugin id egg is refused, and so is one with the wrong id or egg's identity", () => {
  assert.equal(copyProblem(copy("egg-check"), "egg-check"), null);
  assert.match(copyProblem(copy("egg"), "egg-check"), /says plugin id "egg": installing it would replace the egg a person uses/);
  assert.match(copyProblem(copy("egg-other"), "egg-check"), /not "egg-check"/);
  assert.match(copyProblem(copy("egg"), "egg"), /must be a copy's id/);
  assert.match(copyProblem(copy("egg-check", { rooms: "~/egg" }), "egg-check"), /rooms folder/);
  assert.match(copyProblem(copy("egg-check", { prefix: "egg" }), "egg-check"), /title prefix/);
  assert.match(copyProblem(copy("egg-check", { key: "e" }), "egg-check"), /shortcut/);
  assert.match(copyProblem(mkdtempSync(join(tmpdir(), "egg-empty-")), "egg-check"), /does not exist/);
});

test("install-check-copy refuses a folder that says plugin id egg, before running anything", () => {
  const script = join(import.meta.dirname, "..", "scripts", "install-check-copy.mjs");
  let status: number | null = null;
  let stderr = "";
  try {
    execFileSync(process.execPath, [script, "--dir", copy("egg"), "--id", "egg-check"], { encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    status = (e as { status: number }).status;
    stderr = String((e as { stderr: string }).stderr);
  }
  assert.equal(status, 3);
  assert.match(stderr, /Refusing to install .*says plugin id "egg"/);
  const ok = execFileSync(process.execPath, [script, "--dir", copy("egg-check"), "--id", "egg-check", "--dry-run"], { encoding: "utf8" });
  assert.match(ok, /would install .* as egg-check/);
});
