// What makes a folder a safe copy for checks: its package.json names a
// plugin id that is not egg (the installed one) and is the id expected, and
// its identity file was rewritten to that copy's rooms folder, title prefix
// and shortcut. Shared by copy-for-checks.mjs (before it moves a copy into
// place) and install-check-copy.mjs (before it installs one).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The installed plugin's id: a copy must never take it. */
export const INSTALLED_ID = "egg";

/**
 * Why `dir` is not a safe copy for `expectedId`, or null when it is.
 * `expect` may also name the rooms folder and prefix the copy must have.
 */
export function copyProblem(dir, expectedId, expect = {}) {
  if (!expectedId || expectedId === INSTALLED_ID) return `the expected id must be a copy's id, not ${JSON.stringify(expectedId)}`;
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return `${pkgPath} does not exist`;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (e) {
    return `${pkgPath} is not JSON (${e.message})`;
  }
  const id = pkg?.bb?.name;
  if (id === INSTALLED_ID) return `${pkgPath} says plugin id "${INSTALLED_ID}": installing it would replace the egg a person uses`;
  if (id !== expectedId) return `${pkgPath} says plugin id ${JSON.stringify(id)}, not ${JSON.stringify(expectedId)}`;
  if (pkg.name !== `bb-plugin-${expectedId}`) return `${pkgPath} has package name ${JSON.stringify(pkg.name)}, not "bb-plugin-${expectedId}"`;
  const identityPath = join(dir, "src", "identity.ts");
  if (!existsSync(identityPath)) return `${identityPath} does not exist`;
  const identity = readFileSync(identityPath, "utf8");
  const value = (name) => new RegExp(`export const ${name} = (".*");`).exec(identity)?.[1];
  const rooms = value("DEFAULT_ROOMS_DIR");
  const prefix = value("DEFAULT_TITLE_PREFIX");
  const key = value("DEFAULT_OPEN_KEY");
  if (rooms === '"~/egg"') return `${identityPath} has the installed egg's rooms folder ${rooms}`;
  if (expect.rooms && rooms !== JSON.stringify(expect.rooms)) return `${identityPath} has rooms folder ${rooms}, not ${JSON.stringify(expect.rooms)}`;
  if (prefix === '"egg"') return `${identityPath} has the installed egg's title prefix ${prefix}`;
  if (expect.prefix && prefix !== JSON.stringify(expect.prefix)) return `${identityPath} has title prefix ${prefix}, not ${JSON.stringify(expect.prefix)}`;
  if (key === '"e"') return `${identityPath} has the installed egg's shortcut key ${key}`;
  return null;
}
