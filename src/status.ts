// The room thread's status line: what state it is in, since when, its latest
// step, and tokens used. Derived from bb's own data: the thread's status, a
// pending interaction, its turn boundaries and its latest item.
//
// Adapted for one thread from cow's src/state.ts, src/activity.ts and
// src/text.ts (https://github.com/jamie-meyer/cow, MIT licence). Unlike cow,
// a running turn with no event for a long time stays "running, quiet for N
// min", never "stuck": long builds and test runs are normal here.

export type WorkerState = "starting" | "running" | "waiting on you" | "failed" | "idle" | "gone";

/** The fields of the bb thread this reads. */
export interface WorkerThreadFacts {
  status: string;
  hasPendingInteraction: boolean;
  archivedAt: number | null;
}

/** What the event log and interactions add. */
export interface WorkerActivity {
  /** The newest turn boundary. */
  turn: { phase: "started" | "completed"; at: number; failed: boolean } | null;
  /** The latest item started or completed, as short text, and when. */
  step: { text: string; at: number } | null;
  /** When the newest event of any kind arrived. */
  lastEventAt: number | null;
  /** The oldest pending question or permission request. */
  ask: { kind: "question" | "permission"; text: string; at: number } | null;
  /** Tokens in its context, when bb reports them. */
  tokens: number | null;
}

export interface WorkerStatus {
  state: WorkerState;
  /** When it entered the state, epoch ms. */
  since: number;
  /** Its latest step or what it waits on, in a few words. */
  step: string;
  /** For a running turn: how long since its last event, when that is long. */
  quietMs: number | null;
  tokens: number | null;
}

/** A running turn with no event for this long says how long it has been quiet. */
export const QUIET_MS = 2 * 60_000;
/** A thread bb calls idle whose newest turn event is a start is still settling for this long. */
export const SETTLING_MS = 60_000;

const BUSY = new Set(["active", "starting", "stopping", "pending"]);

export function deriveWorker(thread: WorkerThreadFacts | null, activity: WorkerActivity, now: number, createdAt = now): WorkerStatus {
  const tokens = activity.tokens;
  const step = activity.step?.text ?? "";
  if (thread === null || thread.archivedAt !== null) return { state: "gone", since: thread?.archivedAt ?? now, step: "", quietMs: null, tokens };
  if (activity.ask || thread.hasPendingInteraction) {
    const ask = activity.ask;
    const text = ask ? `${ask.kind === "permission" ? "asks permission" : "asks"}: ${ask.text}` : "waiting for your answer in its chat";
    return { state: "waiting on you", since: ask?.at ?? activity.lastEventAt ?? now, step: text, quietMs: null, tokens };
  }
  if (thread.status === "error" || (activity.turn?.phase === "completed" && activity.turn.failed && !BUSY.has(thread.status))) {
    return { state: "failed", since: activity.turn?.at ?? activity.lastEventAt ?? now, step, quietMs: null, tokens };
  }
  const settling = !BUSY.has(thread.status) && activity.turn?.phase === "started" && now - Math.max(activity.lastEventAt ?? 0, activity.turn.at) <= SETTLING_MS;
  if (BUSY.has(thread.status) || settling) {
    if (thread.status === "starting" && activity.turn === null) return { state: "starting", since: createdAt, step: step || "making its workspace", quietMs: null, tokens };
    const since = activity.turn?.phase === "started" ? activity.turn.at : (activity.lastEventAt ?? now);
    const last = Math.max(activity.lastEventAt ?? 0, activity.step?.at ?? 0, since);
    const quiet = now - last;
    return { state: "running", since, step, quietMs: quiet >= QUIET_MS ? quiet : null, tokens };
  }
  return { state: "idle", since: activity.turn?.at ?? activity.lastEventAt ?? createdAt, step, quietMs: null, tokens };
}

/** A compact duration: 40 s, 12 min, 3 h 5 min. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

export function tokensText(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k tokens`;
  return `${tokens} tokens`;
}

/** The status line: "running 12 min · $ make -j8 · quiet for 6 min · 340k tokens". */
export function statusLine(s: WorkerStatus, now: number): string {
  const parts = [`${s.state} ${duration(now - s.since)}`];
  if (s.step) parts.push(s.step);
  if (s.quietMs !== null) parts.push(`quiet for ${duration(s.quietMs)}`);
  if (s.tokens !== null) parts.push(tokensText(s.tokens));
  return parts.join(" · ");
}

const MAX_LINE = 120;

/** The first meaningful line of some markdown, as plain text. */
export function firstLine(text: string | null | undefined, max = MAX_LINE): string {
  if (!text) return "";
  for (const raw of text.split("\n")) {
    const line = raw
      .replace(/^\s*(#{1,6}|[-*+>]|\d+[.)])\s+/, "")
      .replace(/[*`]{1,3}/g, "")
      .replace(/(?<![\p{L}\p{N}])_{1,3}|_{1,3}(?![\p{L}\p{N}])/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line && !/^[-=|:\s]+$/.test(line)) return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }
  return "";
}

/** One item from the event log, as far as the status line reads it. */
export interface EventItem {
  type?: unknown;
  command?: unknown;
  tool?: unknown;
  server?: unknown;
  text?: unknown;
}

/** The latest step in a few words; empty when unknown. */
export function describeItem(item: EventItem | null | undefined): string {
  if (!item || typeof item.type !== "string") return "";
  switch (item.type) {
    case "commandExecution":
      return typeof item.command === "string" ? `$ ${firstLine(item.command, 80)}` : "running a command";
    case "toolCall": {
      const tool = typeof item.tool === "string" ? item.tool : "a tool";
      return typeof item.server === "string" ? `${item.server}: ${tool}` : `using ${tool}`;
    }
    case "fileChange":
      return "editing files";
    case "agentMessage":
      return typeof item.text === "string" ? firstLine(item.text, 80) : "";
    case "reasoning":
      return "thinking";
    default:
      return "";
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

interface RawEvent {
  type: string;
  createdAt: number;
  data: Record<string, unknown>;
}
function toEvent(raw: unknown): RawEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const createdAt = num(r.createdAt);
  if (createdAt === null || typeof r.type !== "string") return null;
  return { type: r.type, createdAt, data: (typeof r.data === "object" && r.data !== null ? r.data : {}) as Record<string, unknown> };
}

/** The oldest pending question or permission request among a thread's interactions. */
export function toAsk(interactions: readonly unknown[]): WorkerActivity["ask"] {
  let oldest: WorkerActivity["ask"] = null;
  for (const raw of interactions) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (r.status !== "pending") continue;
    const at = num(r.createdAt) ?? 0;
    if (oldest && oldest.at <= at) continue;
    const payload = (typeof r.payload === "object" && r.payload !== null ? r.payload : {}) as Record<string, unknown>;
    const question = Array.isArray(payload.questions) ? (payload.questions[0] as Record<string, unknown> | undefined) : undefined;
    const candidates = [question?.prompt, payload.title, payload.command, r.title];
    const said = candidates.find((c): c is string => typeof c === "string" && c.trim() !== "");
    oldest = { kind: payload.kind === "approval" ? "permission" : "question", text: firstLine(said) || "it is waiting for your input", at };
  }
  return oldest;
}

/**
 * The activity from raw SDK reads: the latest turn events (newest first),
 * the latest item event (newest first), the interactions and the context.
 */
export function toActivity(input: { turns: readonly unknown[]; items: readonly unknown[]; interactions: readonly unknown[]; usedTokens: number | null; lastEventAt?: number | null }): WorkerActivity {
  const turns = input.turns.map(toEvent).filter((e): e is RawEvent => e !== null && (e.type === "turn/started" || e.type === "turn/completed"));
  const turn = turns[0] ?? null;
  const item = input.items.map(toEvent).find((e) => e !== null) ?? null;
  const itemData = item?.data.item as EventItem | undefined;
  const text = describeItem(itemData);
  const lastEventAt = Math.max(turn?.createdAt ?? 0, item?.createdAt ?? 0, input.lastEventAt ?? 0) || null;
  return {
    turn: turn ? { phase: turn.type === "turn/started" ? "started" : "completed", at: turn.createdAt, failed: turn.type === "turn/completed" && turn.data.status === "failed" } : null,
    step: item && text ? { text, at: item.createdAt } : null,
    lastEventAt,
    ask: toAsk(input.interactions),
    tokens: input.usedTokens,
  };
}
