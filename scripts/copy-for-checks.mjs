// A copy of this checkout that installs beside the real egg, for checks.
//
// It is the same code under another plugin id (egg-check by default), with
// its own rooms directory and thread title prefix, so no check ever reads or
// writes the rooms, settings or threads of the egg a person is using.
//
//   node scripts/copy-for-checks.mjs --out <empty or absent directory> [--id egg-check] [--rooms <dir>] [--prefix "egg test"] [--replace]
//   node scripts/install-check-copy.mjs --dir <out> --id egg-check
//   ...checks, e.g. node scripts/e2e.mjs --plugin egg-check ...
//   bb plugin uninstall egg-check
//
// The copy takes what git tracks plus the working tree's changes, and the
// installed node_modules (cloned, not linked). Run `npm install --include=dev`
// in the checkout first. It is built in a folder beside the target and moved
// into place only once its id, rooms folder, prefix and shortcut check out;
// any failure exits non-zero and leaves no half-made target. The last line
// printed is the id it wrote. Install it only with install-check-copy.mjs,
// which refuses a folder that says plugin id egg.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyProblem } from "./check-copy.mjs";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const id = option("id", "egg-check");
const out = option("out");
const rooms = option("rooms", `~/${id}-rooms`);
const prefix = option("prefix", "egg test");

if (!out) {
  console.error("usage: node scripts/copy-for-checks.mjs --out <directory> [--id egg-check] [--rooms <dir>] [--prefix \"egg test\"]");
  process.exit(2);
}
if (id === "egg") {
  console.error("The copy must not take the id egg: that is the installed plugin.");
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) {
  console.error(`Not a plugin id: ${id}`);
  process.exit(2);
}
const target = resolve(out.startsWith("~/") ? join(homedir(), out.slice(2)) : out);
if (target === here || target.startsWith(`${here}/`)) {
  console.error("The copy goes outside this checkout.");
  process.exit(2);
}
if (existsSync(target) && readdirSync(target).length > 0 && !args.includes("--replace")) {
  console.error(`${target} is not empty; pass --replace to overwrite it.`);
  process.exit(2);
}
if (existsSync(target) && !existsSync(join(target, "package.json")) && readdirSync(target).length > 0) {
  console.error(`${target} is not an earlier copy (no package.json); not replacing it.`);
  process.exit(2);
}
if (!existsSync(join(here, "node_modules"))) {
  console.error("Run npm install --include=dev in the checkout first.");
  process.exit(2);
}

// Build the copy in a fresh folder beside the target, rewrite and verify its
// identity there, and only then move it into place: no folder that says
// plugin id egg is ever left where an install could pick it up.
const staging = `${target}.partial-${process.pid}`;
const fail = (message) => {
  rmSync(staging, { recursive: true, force: true });
  console.error(`copy-for-checks failed: ${message}`);
  console.error(`Nothing was left at ${target}${existsSync(target) ? " other than what was there before" : ""}.`);
  process.exit(1);
};
process.on("uncaughtException", (e) => fail(e instanceof Error ? e.message : String(e)));

if (existsSync(staging)) fail(`${staging} already exists`);
mkdirSync(staging, { recursive: true });

// What git tracks, plus new files not ignored: the working tree as it is.
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: here, encoding: "utf8" })
  .split("\0")
  .filter((f) => f && existsSync(join(here, f)));
for (const file of files) {
  mkdirSync(dirname(join(staging, file)), { recursive: true });
  cpSync(join(here, file), join(staging, file));
}
cpSync(join(here, "node_modules"), join(staging, "node_modules"), { recursive: true, verbatimSymlinks: true });

// The plugin id and how it is shown.
const pkgPath = join(staging, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.name = `bb-plugin-${id}`;
pkg.bb.name = id;
pkg.bb.description = `egg, a copy for checks (${id}). Not the egg you use.`;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

// Its own rooms and thread titles.
const identityPath = join(staging, "src", "identity.ts");
const identity = readFileSync(identityPath, "utf8")
  .replace(/export const DEFAULT_ROOMS_DIR = ".*";/, `export const DEFAULT_ROOMS_DIR = ${JSON.stringify(rooms)};`)
  .replace(/export const DEFAULT_TITLE_PREFIX = ".*";/, `export const DEFAULT_TITLE_PREFIX = ${JSON.stringify(prefix)};`)
  // Another default shortcut than the installed egg's, or bb binds neither.
  .replace(/export const DEFAULT_OPEN_KEY = ".*";/, 'export const DEFAULT_OPEN_KEY = "9";');
writeFileSync(identityPath, identity);

const problem = copyProblem(staging, id, { rooms, prefix });
if (problem) fail(`the copy did not come out right: ${problem}`);

// Into place. --replace removes the old target first, completely.
if (existsSync(target)) {
  if (readdirSync(target).length > 0 && !args.includes("--replace")) fail(`${target} is not empty; pass --replace to overwrite it.`);
  rmSync(target, { recursive: true, force: true });
}
mkdirSync(dirname(target), { recursive: true });
renameSync(staging, target);
const placed = copyProblem(target, id, { rooms, prefix });
if (placed) {
  rmSync(target, { recursive: true, force: true });
  fail(`after the move: ${placed}`);
}

console.log(`A copy for checks is at ${target}`);
console.log(`  rooms in ${rooms} · thread titles start "${prefix}"`);
console.log(`Install it with:   node scripts/install-check-copy.mjs --dir ${target} --id ${id}`);
console.log(`Remove it with:    bb plugin uninstall ${id}`);
console.log(`plugin id ${id}`);
