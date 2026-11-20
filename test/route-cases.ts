// Lines and the route each should get. Used by the unit tests, and by
// scripts/route-check.ts to ask the real planning model once.
import type { Route } from "../src/model.ts";

export const ROUTE_CASES: readonly { line: string; route: Route }[] = [
  // Seen misrouted to work in a real session: it asks to see what exists.
  { line: "show me what it found and checked", route: "look" },
  { line: "list the failures so far", route: "look" },
  { line: "summarise what the fuzzer has turned up", route: "look" },
  { line: "explain why r3 failed", route: "look" },
  { line: "what has been verified so far, and what hasn't?", route: "look" },
  { line: "compare the warnings from the two builds", route: "look" },
  { line: "where does the encoding conversion for strings live?", route: "look" },
  { line: "build it with address sanitizer and run the string tests", route: "work" },
  { line: "verify every string method against unicode edge cases", route: "work" },
  { line: "measure how long the full test suite takes", route: "work" },
  { line: "try compiling it with clang instead", route: "work" },
  { line: "fix the crash it found and rerun the repro", route: "work" },
  { line: "reproduce the second bug with a smaller input", route: "work" },
  { line: "rerun the failing specs, and meanwhile map where upcase is implemented", route: "both" },
];
