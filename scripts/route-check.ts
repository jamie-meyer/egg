// Ask the real planning model how it routes the lines in test/route-cases.ts.
//
// The planning prompt routes one line per call; one thread per line is too
// many for a check, so the lines go in a single call with the same routing
// rule, and the one line seen misrouted also goes through the real planning
// prompt. Two threads in all, archived at the end.
//
//   node scripts/route-check.ts --project <project id> --environment <environment id> [--model claude-haiku-5-5] [--prefix "egg test"]
import { execFileSync } from "node:child_process";
import { ROUTE_RULE, parseRoute, plannerPrompt } from "../src/rounds.ts";
import { makeRoom } from "../src/store.ts";
import { ROUTE_CASES } from "../test/route-cases.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const project = option("project");
const environment = option("environment");
const model = option("model", "claude-haiku-5-5")!;
const prefix = option("prefix", "egg test")!;
if (!project || !environment) {
  console.error("usage: node scripts/route-check.ts --project <project id> --environment <environment id> [--model <model>]");
  process.exit(2);
}

const bb = (...a: string[]) => execFileSync("bb", a, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
function ask(title: string, prompt: string): string {
  const spawned = JSON.parse(bb("thread", "spawn", "--project", project!, "--environment", environment!, "--provider", "claude-code", "--model", model, "--permission-mode", "auto", "--visibility", "hidden", "--title", `${prefix}: ${title}`, "--prompt", prompt, "--json")) as { id: string };
  try {
    bb("thread", "wait", spawned.id, "--status", "idle", "--timeout", "180000");
    return bb("thread", "output", spawned.id);
  } finally {
    try {
      bb("thread", "archive", spawned.id);
    } catch (e) {
      console.error(`could not archive ${spawned.id}: ${e instanceof Error ? e.message : e}`);
    }
    console.log(`thread ${spawned.id} (${title})`);
  }
}

const subject = "how can we verify all string operations with unicode? verify everything, not one of each";
const batch = [
  "You pick routes for egg, an ideation tool. Do not use any tools and do not read files: answer from this message alone, fast.",
  `The room is about: ${JSON.stringify(subject)}. It has a working thread that has already built the project and run several checks.`,
  "Below are separate lines the person might say next, each on its own. For each, pick its route by this rule:",
  ROUTE_RULE.replace(/^Also pick the route for the line\. /, ""),
  "",
  ...ROUTE_CASES.map((c, i) => `${i + 1}. ${JSON.stringify(c.line)}`),
  "",
  `Reply with JSON only, no prose, no code fence: an array of ${ROUTE_CASES.length} strings, each "look", "work" or "both", in the order of the lines.`,
].join("\n");

const t0 = Date.now();
const reply = ask("route check (batch)", batch);
const start = reply.indexOf("[");
const end = reply.lastIndexOf("]");
const routes = JSON.parse(reply.slice(start, end + 1)) as string[];
let right = 0;
console.log(`\nbatch on ${model}, ${Math.round((Date.now() - t0) / 1000)} s:`);
ROUTE_CASES.forEach((c, i) => {
  const got = routes[i] ?? "(none)";
  const ok = got === c.route;
  if (ok) right++;
  console.log(`${ok ? "ok  " : "MISS"} ${c.route.padEnd(4)} → ${got.padEnd(4)}  ${c.line}`);
});
console.log(`${right} of ${ROUTE_CASES.length} as expected`);

// The misrouted line, through the real planning prompt.
const room = makeRoom({ id: "room_check", subject, folder: "/folder", hostId: "h", projectId: "p", dir: "/d", now: Date.now() });
const line = ROUTE_CASES[0]!.line;
const real = ask("route check (planner prompt)", plannerPrompt(room, line));
console.log(`\nreal planning prompt: ${JSON.stringify(line)} → ${parseRoute(real)} (expected ${ROUTE_CASES[0]!.route})`);
console.log(real.slice(0, 600));
