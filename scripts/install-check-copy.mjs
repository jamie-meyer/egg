// Install a copy made by copy-for-checks.mjs, and nothing else: it reads the
// copy's package.json and refuses unless its plugin id is the one expected
// and not egg (the installed plugin), then runs `bb plugin install`.
//
//   node scripts/install-check-copy.mjs --dir <copy> --id egg-check
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { copyProblem } from "./check-copy.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = option("dir");
const id = option("id");
if (!dir || !id) {
  console.error("usage: node scripts/install-check-copy.mjs --dir <copy> --id <copy's plugin id>");
  process.exit(2);
}
const problem = copyProblem(resolve(dir), id);
if (problem) {
  console.error(`Refusing to install ${resolve(dir)}: ${problem}`);
  process.exit(3);
}
if (args.includes("--dry-run")) {
  console.log(`would install ${resolve(dir)} as ${id}`);
  process.exit(0);
}
execFileSync("bb", ["plugin", "install", resolve(dir), "--yes"], { stdio: "inherit" });
console.log(`installed ${resolve(dir)} as plugin id ${id}`);
