// A copy of this checkout that installs beside the real egg, for checks.
//
// It is the same code under another plugin id (egg-check by default), with
// its own rooms directory and thread title prefix, so no check ever reads or
// writes the rooms, settings or threads of the egg a person is using.
//
//   node scripts/copy-for-checks.mjs --out <empty or absent directory> [--id egg-check] [--rooms <dir>] [--prefix "egg test"]
//   bb plugin install <out> --yes
//   ...checks, e.g. node scripts/e2e.mjs --plugin egg-check ...
//   bb plugin uninstall egg-check
//
// The copy takes what git tracks plus the working tree's changes, and the
// installed node_modules (cloned, not linked). Run `npm install --include=dev`
// in the checkout first.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
if (!existsSync(join(here, "node_modules"))) {
  console.error("Run npm install --include=dev in the checkout first.");
  process.exit(2);
}

// What git tracks, plus new files not ignored: the working tree as it is.
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: here, encoding: "utf8" })
  .split("\0")
  .filter((f) => f && existsSync(join(here, f)));
mkdirSync(target, { recursive: true });
for (const file of files) {
  mkdirSync(dirname(join(target, file)), { recursive: true });
  cpSync(join(here, file), join(target, file));
}
cpSync(join(here, "node_modules"), join(target, "node_modules"), { recursive: true, verbatimSymlinks: true });

// The plugin id and how it is shown.
const pkgPath = join(target, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.name = `bb-plugin-${id}`;
pkg.bb.name = id;
pkg.bb.description = `egg, a copy for checks (${id}). Not the egg you use.`;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

// Its own rooms and thread titles.
const identityPath = join(target, "src", "identity.ts");
const identity = readFileSync(identityPath, "utf8")
  .replace(/export const DEFAULT_ROOMS_DIR = ".*";/, `export const DEFAULT_ROOMS_DIR = ${JSON.stringify(rooms)};`)
  .replace(/export const DEFAULT_TITLE_PREFIX = ".*";/, `export const DEFAULT_TITLE_PREFIX = ${JSON.stringify(prefix)};`)
  // Another default shortcut than the installed egg's, or bb binds neither.
  .replace(/export const DEFAULT_OPEN_KEY = ".*";/, 'export const DEFAULT_OPEN_KEY = "9";');
if (!identity.includes(JSON.stringify(rooms)) || !identity.includes(JSON.stringify(prefix)) || !identity.includes('DEFAULT_OPEN_KEY = "9"')) {
  console.error("Could not rewrite src/identity.ts in the copy.");
  process.exit(1);
}
writeFileSync(identityPath, identity);

console.log(`A copy for checks is at ${target}`);
console.log(`  plugin id ${id} · rooms in ${rooms} · thread titles start "${prefix}"`);
console.log(`Install it with:   bb plugin install ${target} --yes`);
console.log(`Remove it with:    bb plugin uninstall ${id}`);
