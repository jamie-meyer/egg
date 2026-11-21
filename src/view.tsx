// egg's page: the notebook of lines on the left, the table of views on the
// right, rooms and the legend over them. Everything is reachable from the
// keyboard; see LEGEND in keys.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ThreadChat, useBbContext, useRealtime, useSdk, useSettings } from "@get-bb/plugin-sdk/app";
import { type Mode, type Selection, LEGEND, asLine, clampSelection, commandFor, confirmStop, holdKeyCode, isEditable, liveMarks, moveOnTable, pasteAction, pickAt, selectionFor, tableRows, toggleMark } from "./keys.ts";
import { type BuiltFrom, type Line, type ParentRef, type Room, type RoomSummary, type Round, type View, keptViews, roomTree, roundViews } from "./model.ts";
import { builtFromCount } from "./provenance.ts";
import { PLAIN_THEME, VIEW_SANDBOX, type ViewTheme, viewDocument } from "./sandbox.ts";
import { type Call, SigningRefusal, useSigner } from "./signing/page.ts";
import { type WorkerStatus, duration, statusLine } from "./status.ts";
import { type VoiceState, clipFile, createHoldToTalk, mediaRecorder } from "./voice.ts";

/** Every call the page makes for the person goes through its signer: see src/signing/page.ts. */
type Rpc = { call: Call };
type Content = { format: "html" | "text"; content: string };
type WorkerInfo = WorkerStatus & { threadId: string; workspace: string; kind: "clone" | "worktree" | "in-place"; ready: boolean; ledger: number; runsOpen: number; longestOpenMs: number | null; claimed: number };

/** "2 runs open · longest 14 min", or nothing when none is. */
function runsText(info: WorkerInfo): string {
  if (!info.runsOpen) return "";
  return `${info.runsOpen} run${info.runsOpen === 1 ? "" : "s"} open${info.longestOpenMs !== null ? ` · longest ${duration(info.longestOpenMs)}` : ""}`;
}
/** bb's chat focuses its composer when it mounts; for this long, focus is handed back to the page. */
const CHAT_SETTLE_MS = 2500;

const LAST_ROOM = "egg:last-room";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function readTheme(el: HTMLElement | null): ViewTheme {
  if (!el) return PLAIN_THEME;
  const style = getComputedStyle(el);
  const muted = el.querySelector<HTMLElement>(".egg-muted");
  const bg = style.backgroundColor;
  const rgb = bg.match(/\d+(\.\d+)?/g)?.map(Number) ?? [255, 255, 255];
  const luminance = (0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!) / 255;
  return {
    background: bg,
    foreground: style.color,
    muted: muted ? getComputedStyle(muted).color : PLAIN_THEME.muted,
    border: style.borderColor || PLAIN_THEME.border,
    font: style.fontFamily,
    mono: getComputedStyle(el).getPropertyValue("--font-mono").trim() || PLAIN_THEME.mono,
    scheme: luminance < 0.5 ? "dark" : "light",
  };
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function ViewFrame({ content, theme, title, large }: { content: Content | undefined; theme: ViewTheme; title: string; large?: boolean }) {
  const doc = useMemo(() => (content ? viewDocument(content.format, content.content, theme) : null), [content, theme]);
  if (!doc) return <div className="egg-frame egg-frame-empty">…</div>;
  return (
    <iframe
      className={large ? "egg-frame egg-frame-large" : "egg-frame"}
      title={title}
      sandbox={VIEW_SANDBOX}
      srcDoc={doc}
      tabIndex={-1}
      referrerPolicy="no-referrer"
      data-egg-view-frame=""
    />
  );
}

const ROLE_WORD: Record<ParentRef["role"], string> = { varied: "varied from", crossed: "crossed from", zoomed: "zoomed from", pinned: "pinned" };

/** Where a parent view lives, in words: its round, and its room when that is another room. */
export function parentText(p: ParentRef, roomId: string | null): string {
  const where = p.roomId === roomId ? `round ${p.round}` : `round ${p.round} of "${p.roomSubject.slice(0, 60)}"`;
  return `${p.label ? `${p.label}: ` : ""}"${p.angle}", ${where}`;
}

function ParentsList({ parents, roomId }: { parents: readonly ParentRef[]; roomId: string | null }) {
  if (parents.length === 0) return null;
  return (
    <ul className="egg-built egg-parents" data-egg-parents="">
      {parents.map((p, i) => (
        <li key={i} data-egg-parent={p.viewId}>
          <span className="egg-built-kind">{ROLE_WORD[p.role]}</span>
          <code title={`room ${p.roomId} · round ${p.roundId} · view ${p.viewId}`}>{parentText(p, roomId)}</code>
        </li>
      ))}
    </ul>
  );
}

function BuiltFromList({ entries, parents = [], roomId = null }: { entries: readonly BuiltFrom[]; parents?: readonly ParentRef[]; roomId?: string | null }) {
  const from = <ParentsList parents={parents} roomId={roomId} />;
  if (entries.length === 0)
    return (
      <>
        {from}
        <p className="egg-muted egg-small">Its thread read nothing and ran nothing.</p>
      </>
    );
  return (
    <>
    {from}
    <ul className="egg-built" data-egg-built-from="">
      {entries.map((e, i) => (
        <li key={i} className={e.outside ? "egg-built-outside" : undefined}>
          <span className="egg-built-kind">{e.kind}</span>
          <code title={e.what}>{e.what}</code>
          {e.failed ? <span className="egg-trouble"> (failed)</span> : null}
          {e.unconfirmed ? <span className="egg-trouble"> (claimed: egg has no record of this run)</span> : null}
          {e.outside ? <span className="egg-trouble"> (outside its storage)</span> : null}
        </li>
      ))}
    </ul>
    </>
  );
}

/** The card's line naming its parents: the axis of a variation, A × B of a cross. */
function lineage(view: View): string | null {
  const rests = view.ledger && view.ledger.length ? `rests on ${view.ledger.join(", ")}` : null;
  if (view.file) return ["made by the room thread", rests].filter(Boolean).join(" · ");
  const own = lineageOf(view);
  return own && rests ? `${own} · ${rests}` : (own ?? rests);
}

function lineageOf(view: View): string | null {
  const parents = view.parents ?? [];
  const crossed = parents.filter((p) => p.role === "crossed");
  if (crossed.length === 2) return `${crossed.map((p) => `${p.label}: ${p.angle}`).join(" × ")}${view.axis ? ` · ${view.axis}` : ""}`;
  const varied = parents.find((p) => p.role === "varied");
  if (varied) return `axis: ${view.axis ?? "?"} · from "${varied.angle}"`;
  const zoomed = parents.find((p) => p.role === "zoomed");
  if (zoomed) return `zoomed from "${zoomed.angle}"`;
  const pinned = parents.find((p) => p.role === "pinned");
  if (pinned) return `with pinned "${pinned.angle}"`;
  return null;
}

function statusText(view: View, now: number): string {
  if (view.status === "waiting") return "starting…";
  if (view.status === "running") return `reading… ${view.startedAt ? Math.round((now - view.startedAt) / 1000) : 0} s`;
  if (view.status === "failed") return `failed: ${view.error ?? "unknown"}`;
  if (view.file) return `the room thread's .egg/views/${view.file} · ${builtFromCount(view.builtFrom)}`;
  const took = view.startedAt && view.finishedAt ? `${Math.round((view.finishedAt - view.startedAt) / 1000)} s · ` : "";
  return `${took}${builtFromCount(view.builtFrom)}`;
}

function Card(props: {
  view: View;
  selected: boolean;
  content: Content | undefined;
  theme: ViewTheme;
  showBuilt: boolean;
  now: number;
  onSelect: () => void;
  onOpen: () => void;
  compact?: boolean;
  mark?: "A" | "B" | null;
  pinned?: boolean;
  roomId: string | null;
}) {
  const { view } = props;
  const from = lineage(view);
  return (
    <section
      className={`egg-card${props.selected ? " egg-selected" : ""}${props.compact ? " egg-card-compact" : ""} egg-${view.status}`}
      data-egg-card={view.id}
      data-egg-status={view.status}
      data-egg-decision={view.decision ?? ""}
      data-egg-mark={props.mark ?? ""}
      data-egg-pinned={props.pinned ? "1" : ""}
      data-egg-axis={view.axis ?? ""}
      onClick={props.onSelect}
      onDoubleClick={props.onOpen}
    >
      <header className="egg-card-head">
        <span className="egg-angle">{view.angle}</span>
        <span className="egg-spacer" />
        {props.mark ? <span className="egg-badge egg-badge-mark" title="marked (v)">{props.mark}</span> : null}
        {props.pinned ? <span className="egg-badge egg-badge-pin" title="pinned (p)">pinned</span> : null}
        {view.decision === "kept" ? <span className="egg-badge">kept</span> : null}
      </header>
      {from ? <p className="egg-lineage egg-small" data-egg-lineage="" title={from}>{from}</p> : null}
      {props.compact ? null : <p className="egg-focus egg-muted">{view.focus}</p>}
      <div className="egg-card-body">
        {view.status === "done" ? (
          <ViewFrame content={props.content} theme={props.theme} title={view.angle} />
        ) : (
          <div className="egg-frame egg-frame-empty">{view.status === "failed" ? "no view" : "…"}</div>
        )}
      </div>
      <footer className="egg-card-foot egg-muted egg-small">
        <span>{statusText(view, props.now)}</span>
      </footer>
      {props.showBuilt && view.status !== "waiting" ? <BuiltFromList entries={view.builtFrom} parents={view.parents} roomId={props.roomId} /> : null}
    </section>
  );
}

function Notebook({ lines, unsent, children }: { lines: readonly Line[]; unsent: readonly string[]; children: React.ReactNode }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [lines.length, unsent.length]);
  return (
    <div className="egg-notebook" data-egg-notebook="">
      <ol className="egg-lines">
        {lines.map((line) => (
          <li key={line.id} className={`egg-line egg-line-${line.kind}`} data-egg-line={line.kind}>
            <span className="egg-line-mark">{line.kind === "said" ? (line.source === "voice" ? "◉" : line.route === "work" ? "⚒" : "›") : line.kind === "trouble" ? "!" : line.kind === "note" ? "◆" : "·"}</span>
            <span className="egg-line-text" data-egg-route={line.route ?? undefined}>{line.text}</span>
          </li>
        ))}
        {/* What this page could not do for a reason of signing. The page's own lines: they are not stored. */}
        {unsent.map((text, i) => (
          <li key={`unsent-${i}`} className="egg-line egg-line-trouble" data-egg-line="trouble" data-egg-unsent="">
            <span className="egg-line-mark">!</span>
            <span className="egg-line-text">{text}</span>
          </li>
        ))}
      </ol>
      {children}
      <div ref={end} />
    </div>
  );
}

function LineInput(props: { initial: string; placeholder?: string; mark?: string; onSend: (text: string) => void; onLeave: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);
  return (
    <div className="egg-input-row">
      <span className="egg-line-mark">{props.mark ?? "›"}</span>
      <input
        ref={ref}
        className="egg-input"
        data-egg-line-input=""
        defaultValue={props.initial}
        placeholder={props.placeholder ?? "a line about the subject; Enter sends, Escape leaves"}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const text = asLine(e.currentTarget.value);
            if (text) props.onSend(text);
            else props.onLeave();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            props.onLeave();
          }
        }}
      />
    </div>
  );
}

function NewRoomForm(props: { rpc: Rpc; projectId: string | null; initialLine: string; onMade: (room: Room) => void; onCancel: () => void; onFailed: (what: string, e: unknown) => void }) {
  const notMade = "The room was not made";
  const [folder, setFolder] = useState("");
  const [project, setProject] = useState<string | null>(props.projectId);
  const [line, setLine] = useState(props.initialLine);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkouts, setCheckouts] = useState<{ projectId: string; name: string; path: string }[]>([]);
  const [pick, setPick] = useState(-1);
  const lineRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    props.rpc.call("defaults", { projectId: props.projectId }).then(
      (d) => {
        setFolder((f) => f || d.folder || "");
        setProject((p) => p ?? d.projectId);
        setCheckouts(d.checkouts);
      },
      () => undefined,
    );
    (props.initialLine ? lineRef : folderRef).current?.focus();
  }, []);
  const submit = async () => {
    const text = asLine(line);
    if (!folder.trim() || !text) return setError("Both a folder and a first line, please.");
    setBusy(true);
    try {
      const { room } = await props.rpc.call("room_create", { folder: folder.trim(), line: text, projectId: project, source: "typed" });
      props.onMade(room);
    } catch (e) {
      // Said here, and in the notebook when it is a refusal for a reason of signing: the form goes, the line stays.
      setError(e instanceof SigningRefusal ? e.inWords(notMade) : errText(e));
      if (e instanceof SigningRefusal) props.onFailed(notMade, e);
      setBusy(false);
    }
  };
  const choose = (i: number) => {
    const c = checkouts[i];
    if (!c) return;
    setPick(i);
    setFolder(c.path);
    setProject(c.projectId);
  };
  const keys = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Up and Down (or Ctrl-n, Ctrl-p) walk the list of checkouts from either field.
    const down = e.key === "ArrowDown" || (e.ctrlKey && e.key === "n");
    const up = e.key === "ArrowUp" || (e.ctrlKey && e.key === "p");
    if ((down || up) && checkouts.length > 0) {
      e.preventDefault();
      const next = pick < 0 ? (down ? 0 : checkouts.length - 1) : (pick + (down ? 1 : -1) + checkouts.length) % checkouts.length;
      choose(next);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onCancel();
    }
  };
  return (
    <div className="egg-sheet" data-egg-new-room="">
      <h2>A new room</h2>
      <label>
        <span className="egg-muted egg-small">Folder to read (read only)</span>
        <input ref={folderRef} className="egg-input" data-egg-folder="" value={folder} onChange={(e) => { setFolder(e.target.value); setPick(-1); }} onKeyDown={keys} />
      </label>
      {checkouts.length > 0 ? (
        <ol className="egg-checkouts" data-egg-checkouts="">
          {checkouts.map((c, i) => (
            <li key={c.path} className={i === pick ? "egg-selected" : undefined} data-egg-checkout={c.path} onClick={() => choose(i)}>
              <span>{c.name}</span>
              <span className="egg-muted egg-small egg-path">{c.path}</span>
            </li>
          ))}
        </ol>
      ) : null}
      <label>
        <span className="egg-muted egg-small">First line: what you are looking for</span>
        <input ref={lineRef} className="egg-input" data-egg-first-line="" value={line} onChange={(e) => setLine(e.target.value)} onKeyDown={keys} placeholder="where do requests get authenticated?" />
      </label>
      <p className="egg-muted egg-small">Enter makes the room and starts the first round · Up and Down pick a project's checkout · Tab between fields · Escape cancels</p>
      {error ? <p className="egg-trouble">{error}</p> : null}
      {busy ? <p className="egg-muted">Making the room…</p> : null}
    </div>
  );
}

/** The room thread's status line: always there once the room has one. */
function WorkerBar({ info, now, chatOpen, confirming }: { info: WorkerInfo; now: number; chatOpen: boolean; confirming: boolean }) {
  const where = info.kind === "in-place" ? "in the folder itself" : info.workspace ? `in a ${info.kind === "clone" ? "clone" : "worktree"}: ${info.workspace}` : `making its ${info.kind}…`;
  return (
    <div className={`egg-worker egg-worker-${info.state.replace(/\s+/g, "-")}`} data-egg-worker="" data-egg-worker-state={info.state} title={info.workspace}>
      <span className="egg-worker-name">room thread</span>
      <span className="egg-worker-status" data-egg-worker-line="">{statusLine(info, now)}</span>
      {info.runsOpen ? (
        <span className="egg-worker-runs" data-egg-runs-open={info.runsOpen}>
          {runsText(info)}
        </span>
      ) : null}
      <span className="egg-muted egg-small egg-path">
        {info.ledger} run{info.ledger === 1 ? "" : "s"} in its ledger{info.claimed ? ` (${info.claimed} claimed, with no run record)` : ""} · {where}
      </span>
      <span className="egg-spacer" />
      {confirming ? (
        <span className="egg-trouble egg-small" data-egg-confirm-stop="">stop its turn? <kbd>y</kbd> stops, any other key leaves it running</span>
      ) : (
        <span className="egg-muted egg-small">
          {info.state === "waiting on you" && !chatOpen ? <b className="egg-trouble">answer in its chat: </b> : null}
          <kbd>t</kbd> {chatOpen ? "close chat" : "chat"} · <kbd>w</kbd> work · <kbd>S</kbd> stop
        </span>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="egg-sheet egg-legend" data-egg-legend="">
      <h2>Keys</h2>
      {LEGEND.map((group) => (
        <section key={group.title}>
          <h3>{group.title}</h3>
          <dl>
            {group.keys.map(([k, does]) => (
              <div key={k} className="egg-legend-row">
                <dt>
                  <kbd>{k}</kbd>
                </dt>
                <dd>{does}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <p className="egg-muted egg-small">
        Dictation apps that type characters instead of pasting: press <kbd>i</kbd> first. ? or Escape closes this.
      </p>
    </div>
  );
}

export function EggPage() {
  const signer = useSigner();
  const rpc = useMemo<Rpc>(() => ({ call: signer.call }), [signer.call]);
  const enrolled = signer.status === "enrolled";
  const keyRequest = signer.requests[0] ?? null;
  const sdk = useSdk();
  const { projectId } = useBbContext();
  const { values: settings } = useSettings();
  const rootRef = useRef<HTMLDivElement>(null);

  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [room, setRoom] = useState<Room | null>(null);
  const [roomId, setRoomId] = useState<string | null>(() => localStorage.getItem(LAST_ROOM));
  const [mode, setMode] = useState<Mode>("table");
  const [creating, setCreating] = useState<{ line: string } | null>(null);
  const [input, setInput] = useState<{ text: string; key: number; source: "typed" | "pasted"; zoom?: { viewId: string; angle: string }; work?: boolean } | null>(null);
  const [worker, setWorker] = useState<WorkerInfo | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [confirming, setConfirming] = useState(false);
  /** After A: the key waiting for y before it is approved. */
  const [approving, setApproving] = useState<string | null>(null);
  const chatMayFocus = useRef(false);
  const [marks, setMarks] = useState<string[]>([]);
  /** After going up (-): the view to land on once the parent room is open. */
  const land = useRef<string | null>(null);
  /** Rooms deleted while the list is open, newest last, for u. */
  const deletedRooms = useRef<string[]>([]);
  const [roundIndex, setRoundIndex] = useState<number | null>(null);
  const [sel, setSel] = useState<Selection>({ row: 0, col: 0 });
  const [roomSel, setRoomSel] = useState(0);
  const [showBuilt, setShowBuilt] = useState(false);
  const [contents, setContents] = useState<Record<string, Content>>({});
  const [voice, setVoice] = useState<VoiceState>("idle");
  const [hint, setHint] = useState<string | null>(null);
  /** What was not done for a reason of signing, said in the notebook. */
  const [unsent, setUnsent] = useState<string[]>([]);
  const [roomsDir, setRoomsDir] = useState<string>("");
  const [theme, setTheme] = useState<ViewTheme>(PLAIN_THEME);
  const [cols, setCols] = useState(2);
  const observer = useRef<ResizeObserver | null>(null);
  // How many cards fit on a row, so j and k move the way the grid looks.
  const cardsRef = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const measure = () => {
      const n = getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length;
      if (n > 0) setCols(n);
    };
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
  }, []);
  const undo = useRef<{ roomId: string; viewId: string; before: View["decision"] }[]>([]);

  const loadRooms = useCallback(() => {
    rpc.call("rooms_list", null).then((r) => setRooms(r.rooms), () => undefined);
  }, [rpc]);
  const loadRoom = useCallback(
    (id: string) => {
      rpc.call("room_get", { roomId: id }).then(
        (r) => {
          if (r.room) setRoom((cur) => (cur && cur.id !== id ? cur : r.room));
          else if (id === localStorage.getItem(LAST_ROOM)) {
            localStorage.removeItem(LAST_ROOM);
            setRoomId(null);
          }
        },
        () => undefined,
      );
    },
    [rpc],
  );

  // Everything is read again when this browser becomes enrolled: until then it is shown nothing.
  useEffect(() => {
    loadRooms();
    rpc.call("defaults", { projectId }).then((d) => setRoomsDir(d.roomsDir), () => undefined);
    if (enrolled) setUnsent([]);
  }, [loadRooms, rpc, projectId, enrolled]);
  useEffect(() => {
    if (roomId) {
      localStorage.setItem(LAST_ROOM, roomId);
      loadRoom(roomId);
    } else setRoom(null);
  }, [roomId, loadRoom, enrolled]);
  useEffect(() => {
    if (enrolled && !roomId && rooms.length === 0 && !creating) setCreating({ line: "" });
  }, [roomId, rooms.length, enrolled]);
  // A browser that is not enrolled, or no longer is, shows nothing: what it had read goes off the page.
  const shut = signer.status === "pending" || signer.status === "refused" || signer.status === "unavailable";
  useEffect(() => {
    if (!shut) return;
    setRoom(null);
    setRooms([]);
    setContents({});
    setWorker(null);
    setChatOpen(false);
    setMode("table");
  }, [shut]);
  useRealtime("room-changed", (payload) => {
    const changed = (payload as { roomId?: unknown })?.roomId;
    loadRooms();
    if (typeof changed === "string" && changed === roomId) loadRoom(changed);
  });
  useEffect(() => {
    setTheme(readTheme(rootRef.current));
    rootRef.current?.focus();
  }, []);

  // The room thread's status line, read from bb every few seconds while the room has one.
  const workerThread = room?.worker?.threadId ?? null;
  useEffect(() => {
    if (!room?.id || !workerThread) {
      setWorker(null);
      setChatOpen(false);
      return;
    }
    let live = true;
    const read = () =>
      rpc.call("worker_status", { roomId: room.id }).then(
        (w) => live && setWorker(w),
        () => undefined,
      );
    read();
    const t = setInterval(read, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [room?.id, workerThread, room?.updatedAt, rpc]);

  const focusPage = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && rootRef.current?.contains(active)) active.blur();
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  // Opening the chat must not move the keyboard: bb's chat focuses its
  // composer when it mounts, so focus is handed back until i asks for it.
  useEffect(() => {
    chatMayFocus.current = false;
    if (!chatOpen) return;
    const pane = rootRef.current?.querySelector<HTMLElement>("[data-egg-chat]");
    if (!pane) return;
    const guard = () => {
      if (!chatMayFocus.current) focusPage();
    };
    pane.addEventListener("focusin", guard);
    const t = setTimeout(() => pane.removeEventListener("focusin", guard), CHAT_SETTLE_MS);
    return () => {
      clearTimeout(t);
      pane.removeEventListener("focusin", guard);
    };
  }, [chatOpen, workerThread, focusPage]);
  const typeInChat = useCallback(() => {
    chatMayFocus.current = true;
    setFocusRequest((n) => n + 1);
  }, []);

  // What the table shows.
  const rounds = room?.rounds ?? [];
  const shownIndex = roundIndex === null ? rounds.length - 1 : Math.min(roundIndex, rounds.length - 1);
  const round: Round | undefined = rounds[shownIndex];
  const cards = useMemo(() => (room && round ? roundViews(room, round).filter((v) => v.decision !== "dropped") : []), [room, round]);
  const dropped = useMemo(() => (room && round ? roundViews(room, round).filter((v) => v.decision === "dropped").length : 0), [room, round]);
  const kept = useMemo(() => (room ? keptViews(room) : []), [room]);
  const rowLengths = tableRows(cards.length, cols, kept.length);
  const current = clampSelection(sel, rowLengths);
  const at = pickAt(current, rowLengths, cols);
  const selected: View | undefined = at.kept ? kept[at.index] : cards[at.index];
  const isSelected = (keptCard: boolean, i: number) => at.kept === keptCard && at.index === i;
  const select = (keptCard: boolean, i: number) => setSel(selectionFor(keptCard, i, rowLengths, cols));
  const anyRunning = cards.some((v) => v.status === "running" || v.status === "waiting") || round?.status === "planning";
  const now = useNow(anyRunning);

  // Fetch the content of every finished view on screen.
  useEffect(() => {
    if (!room) return;
    const marked = marks.map((m) => room.views[m]).filter((v): v is View => v !== undefined);
    const need = [...cards, ...kept, ...marked].filter((v) => v.status === "done" && !contents[v.id]);
    for (const v of need) {
      rpc.call("view_content", { roomId: room.id, viewId: v.id }).then(
        (c) => c && setContents((all) => ({ ...all, [v.id]: c })),
        () => undefined,
      );
    }
  }, [room, cards, kept, marks]);

  // A new round arriving takes the table to it.
  const roundCount = rounds.length;
  useEffect(() => {
    setRoundIndex(null);
    setSel({ row: 0, col: 0 });
  }, [roundCount, room?.id]);
  useEffect(() => setMarks([]), [room?.id]);
  // Landing after going up: show the round the view is in and select it.
  useEffect(() => {
    const target = land.current;
    if (!room || !target) return;
    land.current = null;
    const view = room.views[target];
    if (!view) return;
    const keptAt = keptViews(room).findIndex((v) => v.id === target);
    const ri = room.rounds.findIndex((r) => r.id === view.roundId);
    const r = room.rounds[ri];
    const onTable = r ? roundViews(room, r).filter((v) => v.decision !== "dropped") : [];
    const idx = onTable.findIndex((v) => v.id === target);
    if (ri >= 0 && idx >= 0) {
      setRoundIndex(ri);
      setSel(selectionFor(false, idx, tableRows(onTable.length, cols, keptViews(room).length), cols));
    } else if (keptAt >= 0) {
      setSel(selectionFor(true, keptAt, tableRows(cards.length, cols, keptViews(room).length), cols));
    }
  }, [room?.id]);

  const flash = (text: string) => {
    setHint(text);
    setTimeout(() => setHint((h) => (h === text ? null : h)), 3000);
  };
  /**
   * Something the person asked for failed. A refusal for a reason of signing
   * is said in the notebook, in full, and stays there; anything else is a
   * hint at the top, as before.
   */
  const failed = (what: string, e: unknown, otherwise?: string) => {
    if (e instanceof SigningRefusal) {
      const text = e.inWords(what);
      setUnsent((all) => (all.at(-1) === text ? all : [...all.slice(-19), text]));
    } else flash(otherwise ?? errText(e));
  };

  const send = useCallback(
    async (text: string, source: "typed" | "voice" | "pasted") => {
      if (!room) {
        setCreating({ line: text });
        return;
      }
      try {
        await rpc.call("say", { roomId: room.id, text, source });
      } catch (e) {
        failed(`Not sent ("${text.slice(0, 80)}")`, e, `Could not send: ${errText(e)}`);
      }
    },
    [room, rpc],
  );

  const decide = async (view: View, decision: "kept" | "dropped" | null, record = true) => {
    if (!room) return;
    if (record) undo.current.push({ roomId: room.id, viewId: view.id, before: view.decision });
    // Instant on screen; the server writes files and archives after.
    setRoom((r) => (r ? { ...r, views: { ...r.views, [view.id]: { ...view, decision } } } : r));
    try {
      const res = await rpc.call("decide", { roomId: room.id, viewId: view.id, decision });
      setRoom(res.room);
    } catch (e) {
      failed(decision === "kept" ? "Not kept" : decision === "dropped" ? "Not dropped" : "Not undone", e);
      loadRoom(room.id);
    }
  };

  // Hold to talk.
  const holdKey = holdKeyCode(settings?.holdToTalkKey as string | undefined);
  const sendRef = useRef(send);
  sendRef.current = send;
  const roomRef = useRef(room);
  roomRef.current = room;
  const talk = useMemo(
    () =>
      createHoldToTalk({
        recorder: mediaRecorder(),
        transcribe: async (clip) => (await sdk.system.transcribeVoice({ file: clipFile(clip) })).text,
        onLine: (text) => void sendRef.current(text, "voice"),
        onTrouble: (text) => {
          const r = roomRef.current;
          if (r) rpc.call("note", { roomId: r.id, text }).catch(() => flash(text));
          else flash(text);
        },
        onHint: flash,
        onState: setVoice,
      }),
    [sdk, rpc],
  );

  // Keys and paste. Only when focus is on this page (or nowhere), never in a text field.
  const tree = useMemo(() => roomTree(rooms), [rooms]);
  const state = { mode, creating, input, room, cards, kept, current, selected, rowLengths, at, cols, rounds, shownIndex, rooms, roomSel, holdKey, settings, marks, tree, chatOpen, confirming, worker, keyRequest, approving };
  const failedRef = useRef(failed);
  failedRef.current = failed;
  const live = useRef(state);
  live.current = state;
  useEffect(() => {
    const ours = () => {
      const active = document.activeElement;
      return !active || active === document.body || (rootRef.current?.contains(active) ?? false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const s = live.current;
      // Escape in the room thread's chat gives the keyboard back to the page.
      const inChat = (document.activeElement as HTMLElement | null)?.closest?.("[data-egg-chat]");
      if (inChat && e.key === "Escape" && ours()) {
        e.preventDefault();
        e.stopPropagation();
        chatMayFocus.current = false;
        rootRef.current?.focus({ preventScroll: true });
        return;
      }
      if (!ours() || isEditable(document.activeElement as HTMLElement | null) || s.creating || s.input) return;
      if (s.approving) {
        // Approving a key lets that browser do everything here as the person: it takes y, as stopping does.
        const answer = confirmStop(e);
        if (answer === "ignore") return;
        e.preventDefault();
        e.stopPropagation();
        const fingerprint = s.approving;
        setApproving(null);
        if (answer === "stop") {
          rpc.call("key_approve", { fingerprint }).then(
            () => flash(`Approved ${fingerprint}: that browser can now use egg as you.`),
            (err) => failedRef.current("That browser was not approved", err),
          );
        } else flash(`Not approved: ${fingerprint} still waits.`);
        return;
      }
      if (s.confirming) {
        const answer = confirmStop(e);
        if (answer === "ignore") return;
        e.preventDefault();
        e.stopPropagation();
        setConfirming(false);
        if (answer === "stop" && s.room) {
          rpc.call("worker_stop", { roomId: s.room.id }).then(
            (r) => flash(r.stopped ? "Stopped the room thread's turn." : "There was nothing to stop."),
            (err) => failedRef.current("The room thread was not stopped", err, `Could not stop: ${errText(err)}`),
          );
        } else flash("Left the room thread running.");
        return;
      }
      if (s.holdKey && e.code === s.holdKey && !e.ctrlKey && !e.metaKey && !e.altKey && s.mode !== "rooms" && s.mode !== "legend") {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) void talk.press();
        return;
      }
      const command = commandFor(e, s.mode, { chatOpen: s.chatOpen, keyRequest: s.keyRequest !== null });
      if (!command) return;
      e.preventDefault();
      e.stopPropagation();
      runRef.current(command);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const s = live.current;
      if (s.holdKey && e.code === s.holdKey && (talk.state === "recording" || talk.state === "starting")) {
        e.preventDefault();
        void talk.release();
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      const s = live.current;
      if (!ours()) return;
      const action = pasteAction({
        editableFocused: isEditable(document.activeElement as HTMLElement | null) || s.creating !== null,
        roomOpen: s.room !== null,
        sendAtOnce: s.settings?.sendPastedAtOnce === true,
        text: e.clipboardData?.getData("text/plain") ?? "",
      });
      if (action.kind === "native") return;
      e.preventDefault();
      if (action.kind === "open-input") {
        setMode((m) => (m === "large" ? m : "table"));
        setInput({ text: action.text, key: Date.now(), source: "pasted" });
      } else if (action.kind === "send") void sendRef.current(action.text, "pasted");
      else if (action.kind === "new-room") setCreating({ line: action.text });
    };
    const onBlur = () => talk.abort();
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    document.addEventListener("paste", onPaste, { capture: true });
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      document.removeEventListener("paste", onPaste, { capture: true });
      window.removeEventListener("blur", onBlur);
      talk.abort();
    };
  }, [talk]);

  function run(command: ReturnType<typeof commandFor> & object) {
    const s = live.current;
    switch (command.kind) {
      case "move":
        if (s.mode === "rooms") setRoomSel((i) => Math.max(0, Math.min(s.tree.length - 1, i + command.dy)));
        else setSel(moveOnTable(s.current, s.rowLengths, s.cols, command.dx, command.dy));
        return;
      case "first":
        setSel(s.at.kept ? { row: s.current.row, col: 0 } : selectionFor(false, 0, s.rowLengths, s.cols));
        return;
      case "last":
        setSel(s.at.kept ? { row: s.current.row, col: 99 } : selectionFor(false, Math.max(0, s.cards.length - 1), s.rowLengths, s.cols));
        return;
      case "open":
        if (s.mode === "rooms") {
          const target = s.tree[s.roomSel]?.room;
          if (target) {
            setRoom(null);
            setRoomId(target.id);
          }
          setMode("table");
        } else if (s.selected?.status === "done") setMode("large");
        return;
      case "close":
        if (s.mode === "rooms") deletedRooms.current = [];
        setMode("table");
        return;
      case "keep":
        if (s.selected?.status === "done" && s.selected.decision !== "kept") void decide(s.selected, "kept");
        return;
      case "drop":
        if (s.selected && !s.at.kept && s.selected.decision !== "dropped") {
          void decide(s.selected, "dropped");
          if (s.mode === "large") setMode("table");
        }
        return;
      case "undo": {
        if (s.mode === "rooms") {
          const id = deletedRooms.current.pop();
          if (!id) return flash("Nothing to undo.");
          rpc.call("room_restore", { roomId: id }).then(
            (r) => {
              if (!r.restored) flash("That room could not be put back.");
              loadRooms();
            },
            (e) => failed("The room was not put back", e),
          );
          return;
        }
        const last = undo.current.pop();
        const r = s.room;
        if (!last || !r || last.roomId !== r.id || !r.views[last.viewId]) return flash("Nothing to undo.");
        void decide(r.views[last.viewId]!, last.before, false);
        return;
      }
      case "built-from":
        setShowBuilt((b) => !b);
        return;
      case "round":
        setRoundIndex(Math.max(0, Math.min(s.rounds.length - 1, s.shownIndex + command.by)));
        setSel({ row: 0, col: 0 });
        return;
      case "latest-round":
        setRoundIndex(null);
        return;
      case "input":
        if (!s.room) setCreating({ line: "" });
        else if (s.chatOpen) typeInChat();
        else setInput({ text: "", key: Date.now(), source: "typed" });
        return;
      case "work-input":
        if (!s.room) setCreating({ line: "" });
        else {
          setMode("table");
          setInput({ text: "", key: Date.now(), source: "typed", work: true });
        }
        return;
      case "chat":
        if (!s.room?.worker) return flash("This room has no room thread yet: w sends a line to one.");
        setChatOpen((o) => !o);
        if (s.chatOpen) focusPage();
        return;
      case "escape":
        if (s.chatOpen) {
          setChatOpen(false);
          focusPage();
        }
        return;
      case "stop":
        if (!s.room?.worker || !s.worker) return flash("This room has no room thread.");
        if (s.worker.state !== "running" && s.worker.state !== "waiting on you" && s.worker.state !== "starting") return flash(`The room thread is ${s.worker.state}: nothing to stop.`);
        setConfirming(true);
        return;
      case "rooms": {
        loadRooms();
        deletedRooms.current = [];
        const here = s.tree.findIndex((t) => t.room.id === s.room?.id);
        setRoomSel(Math.max(0, here));
        setMode("rooms");
        return;
      }
      case "delete-room": {
        const target = s.tree[s.roomSel]?.room;
        if (!target) return;
        deletedRooms.current.push(target.id);
        // Instant: off the list now; the server archives the threads.
        setRooms((all) => all.filter((r) => r.id !== target.id));
        setRoomSel((i) => Math.max(0, Math.min(i, s.tree.length - 2)));
        if (s.room?.id === target.id) {
          setRoom(null);
          setRoomId(null);
          localStorage.removeItem(LAST_ROOM);
        }
        rpc.call("room_delete", { roomId: target.id }).then(
          () => loadRooms(),
          (e) => {
            failed(`"${target.subject.slice(0, 40)}" was not deleted`, e);
            loadRooms();
          },
        );
        flash(`Deleted "${target.subject.slice(0, 40)}": u undoes`);
        return;
      }
      case "more": {
        const v = s.selected;
        if (!s.room || !v) return;
        if (v.status !== "done") return flash("That view is not ready yet.");
        setMode("table");
        rpc.call("more", { roomId: s.room.id, viewId: v.id }).catch((e) => failed("No variations were started", e));
        return;
      }
      case "mark": {
        const v = s.selected;
        if (!v) return;
        if (v.status !== "done") return flash("Only a finished view can be marked.");
        setMarks((m) => toggleMark(m, v.id));
        return;
      }
      case "compare": {
        const live = s.room ? liveMarks(s.marks, s.room.views) : [];
        if (live.length < 2) return flash("Mark two views with v first.");
        setMode("compare");
        return;
      }
      case "cross": {
        const live = s.room ? liveMarks(s.marks, s.room.views) : [];
        if (!s.room || live.length < 2) return flash("Mark two views with v first.");
        setMode("table");
        setMarks([]);
        rpc.call("cross", { roomId: s.room.id, a: live[0]!, b: live[1]! }).catch((e) => failed("The cross was not started", e));
        return;
      }
      case "zoom": {
        const v = s.selected;
        if (!s.room || !v) return;
        if (v.status !== "done") return flash("That view is not ready yet.");
        setMode("table");
        setInput({ text: "", key: Date.now(), source: "typed", zoom: { viewId: v.id, angle: v.angle } });
        return;
      }
      case "up": {
        const parent = s.room?.parent;
        if (!parent) return flash("This room has no parent room.");
        land.current = parent.viewId;
        setMode("table");
        setRoom(null);
        setRoomId(parent.roomId);
        return;
      }
      case "pin": {
        const v = s.selected;
        if (!s.room || !v) return;
        const unpin = s.room.pin?.viewId === v.id;
        if (!unpin && v.status !== "done") return flash("Only a finished view can be pinned.");
        rpc.call("pin", { roomId: s.room.id, viewId: unpin ? null : v.id }).then(
          (r) => setRoom((cur) => (cur && cur.id === r.room.id ? r.room : cur)),
          (e) => failed(unpin ? "Not unpinned" : "Not pinned", e),
        );
        return;
      }
      case "approve-key":
        // Not yet: the next key decides (y approves).
        if (s.keyRequest) setApproving(s.keyRequest.fingerprint);
        return;
      case "refuse-key": {
        const asking = s.keyRequest;
        if (!asking) return;
        rpc.call("key_refuse", { fingerprint: asking.fingerprint }).then(
          () => flash(`Refused ${asking.fingerprint}.`),
          (e) => failed("That browser was not refused", e),
        );
        return;
      }
      case "new-room":
        setMode("table");
        setCreating({ line: "" });
        return;
      case "legend":
        setMode((m) => (m === "legend" ? "table" : "legend"));
        return;
    }
  }

  // The key listener is registered once; it always calls this render's run.
  const runRef = useRef(run);
  runRef.current = run;

  const refocus = () => setTimeout(() => rootRef.current?.focus(), 0);
  const large = mode === "large" && selected?.status === "done" ? selected : null;
  const shownMarks = room ? liveMarks(marks, room.views) : [];
  const markOf = (viewId: string): "A" | "B" | null => {
    const i = shownMarks.indexOf(viewId);
    return i === 0 ? "A" : i === 1 ? "B" : null;
  };
  const compared = mode === "compare" && room && shownMarks.length === 2 ? shownMarks.map((m) => room.views[m]!) : null;
  const roundOf = (v: View) => room?.rounds.find((r) => r.id === v.roundId);

  return (
    <div className="egg" ref={rootRef} tabIndex={-1} data-egg-root="" data-egg-mode={mode} data-egg-voice={voice}>
      <span className="egg-muted" hidden />
      <header className="egg-top">
        <span className="egg-mark">egg</span>
        {room ? (
          <>
            <span className="egg-subject" data-egg-subject="">{room.subject}</span>
            <span className="egg-muted egg-small egg-path" title={room.folder}>reads {room.folder}</span>
            <span className="egg-muted egg-small egg-path" data-egg-room-dir="" title={room.dir}>keeps to {room.dir}</span>
            {room.parent ? (
              <span className="egg-muted egg-small egg-path" data-egg-parent-room={room.parent.roomId} title={room.parent.roomSubject}>
                <kbd>-</kbd> up to "{room.parent.roomSubject}"
              </span>
            ) : null}
            {room.pin ? (
              <span className="egg-small egg-pin" data-egg-pin={room.pin.viewId}>
                pinned: "{room.pin.angle}" (round {room.pin.round})
              </span>
            ) : null}
          </>
        ) : (
          <span className="egg-muted egg-small">rooms in {roomsDir}</span>
        )}
        <span className="egg-spacer" />
        {voice !== "idle" ? (
          <span className={`egg-voice egg-voice-${voice}`} data-egg-voice-state={voice}>
            {voice === "recording" ? "● recording: release to send" : voice === "starting" ? "opening the microphone…" : "transcribing…"}
          </span>
        ) : null}
        {hint ? <span className="egg-hint">{hint}</span> : null}
        <span className="egg-muted egg-small">
          <kbd>?</kbd> keys
        </span>
      </header>

      {signer.status !== "enrolled" && signer.status !== "loading" ? (
        <p className="egg-signing egg-trouble" data-egg-signing={signer.status} data-egg-own-key={signer.fingerprint ?? ""}>
          {signer.why}
        </p>
      ) : null}
      {approving ? (
        <p className="egg-signing egg-trouble" data-egg-confirm-approve={approving}>
          Approve key <b>{approving}</b>? Whatever holds it can then do everything in egg as you. <kbd>y</kbd> approves, any other key leaves it waiting.
        </p>
      ) : keyRequest ? (
        <p className="egg-signing" data-egg-key-request={keyRequest.fingerprint}>
          Another browser asks to use egg as you: key <b>{keyRequest.fingerprint}</b> ({keyRequest.label}, by its own word). Only if you have just opened egg in another browser and it shows this same key: <kbd>A</kbd>, then <kbd>y</kbd>, approves it. Otherwise <kbd>X</kbd> refuses it.
          {signer.requests.length > 1 ? ` ${signer.requests.length - 1} more after it.` : ""}
        </p>
      ) : null}
      {room && worker ? <WorkerBar info={worker} now={Date.now()} chatOpen={chatOpen} confirming={confirming} /> : null}
      <div className={chatOpen && worker ? "egg-main egg-with-chat" : "egg-main"}>
        <Notebook lines={room?.lines ?? []} unsent={unsent}>
          {input && room ? (
            <LineInput
              key={input.key}
              initial={input.text}
              {...(input.zoom ? { placeholder: `zoom into… which part of "${input.zoom.angle}"? Enter makes a child room, Escape leaves`, mark: "⌕" } : {})}
              {...(input.work ? { placeholder: "straight to the room thread: what should it do? Enter sends, Escape leaves", mark: "⚒" } : {})}
              onSend={(text) => {
                setInput(null);
                refocus();
                if (input.zoom) {
                  const from = input.zoom;
                  rpc.call("zoom", { roomId: room.id, viewId: from.viewId, part: text, source: input.source }).then(
                    (r) => {
                      setRoom(r.room);
                      setRoomId(r.room.id);
                      loadRooms();
                    },
                    (e) => failed(`No child room was made ("${text.slice(0, 80)}")`, e, `Could not zoom: ${errText(e)}`),
                  );
                } else if (input.work) {
                  rpc.call("work", { roomId: room.id, text, source: input.source }).catch((e) => failed(`Not sent to the room thread ("${text.slice(0, 80)}")`, e, `Could not send: ${errText(e)}`));
                } else void send(text, input.source);
              }}
              onLeave={() => {
                setInput(null);
                refocus();
              }}
            />
          ) : room ? (
            <p className="egg-muted egg-small egg-prompt-hint">
              <kbd>i</kbd> or paste a line{holdKey ? <> · hold <kbd>{holdKey === "Space" ? "Space" : "`"}</kbd> to talk</> : null} · <kbd>w</kbd> straight to the room thread
            </p>
          ) : null}
        </Notebook>

        <div className="egg-table" data-egg-table="">
          {room && round ? (
            <>
              <div className="egg-round-head">
                <span className="egg-small egg-muted">
                  round {round.n} of {rounds.length}
                </span>
                <span className="egg-round-line">{round.line}</span>
                {round.status === "planning" ? <span className="egg-muted egg-small">picking four angles…</span> : null}
                {round.kind === "work" ? <span className="egg-muted egg-small" data-egg-work-round="">pages from the room thread</span> : null}
                {dropped ? <span className="egg-muted egg-small">{dropped} dropped</span> : null}
              </div>
              <div className="egg-cards" data-egg-cards="" ref={cardsRef}>
                {round.status === "planning" && cards.length === 0
                  ? [0, 1, 2, 3].map((i) => <div key={i} className="egg-card egg-card-ghost" />)
                  : cards.map((v, i) => (
                      <Card
                        key={v.id}
                        view={v}
                        selected={isSelected(false, i)}
                        content={contents[v.id]}
                        theme={theme}
                        showBuilt={showBuilt}
                        now={now}
                        mark={markOf(v.id)}
                        pinned={room.pin?.viewId === v.id}
                        roomId={room.id}
                        onSelect={() => select(false, i)}
                        onOpen={() => {
                          select(false, i);
                          setMode("large");
                        }}
                      />
                    ))}
              </div>
            </>
          ) : room ? (
            <p className="egg-muted">No rounds yet.</p>
          ) : (
            <p className="egg-muted">
              No room open. <kbd>n</kbd> makes one, <kbd>r</kbd> lists them.
            </p>
          )}
          {room ? (
            <div className="egg-kept" data-egg-kept="">
              <div className="egg-small egg-muted">
                kept ({kept.length}) · {room.dir}
              </div>
              <div className="egg-kept-row">
                {kept.map((v, i) => (
                  <Card
                    key={v.id}
                    compact
                    view={v}
                    selected={isSelected(true, i)}
                    content={contents[v.id]}
                    theme={theme}
                    showBuilt={false}
                    now={now}
                    mark={markOf(v.id)}
                    pinned={room.pin?.viewId === v.id}
                    roomId={room.id}
                    onSelect={() => select(true, i)}
                    onOpen={() => {
                      select(true, i);
                      setMode("large");
                    }}
                  />
                ))}
                {kept.length === 0 ? <span className="egg-muted egg-small">y keeps the selected view</span> : null}
              </div>
            </div>
          ) : null}
        </div>

        {chatOpen && worker ? (
          <aside className="egg-chat-pane" data-egg-chat-pane={worker.threadId}>
            <div className="egg-chat-head egg-small egg-muted">
              <span>the room thread's chat</span>
              <span className="egg-spacer" />
              <span>
                <kbd>i</kbd> type here · <kbd>Esc</kbd> {"back / close"}
              </span>
            </div>
            <div className="egg-chat" data-egg-chat="" tabIndex={-1}>
              <ThreadChat key={worker.threadId} threadId={worker.threadId} variant="compact" layout="contained" focusRequest={focusRequest} />
            </div>
          </aside>
        ) : null}

        {large ? (
          <div className="egg-large" data-egg-large={large.id}>
            <header className="egg-card-head">
              <span className="egg-angle">{large.angle}</span>
              {lineage(large) ? <span className="egg-lineage egg-small">{lineage(large)}</span> : null}
              <span className="egg-muted egg-small">{large.focus}</span>
              <span className="egg-spacer" />
              <span className="egg-muted egg-small">
                {large.model} · <kbd>y</kbd> keep <kbd>d</kbd> drop <kbd>b</kbd> built from <kbd>Esc</kbd> close
              </span>
            </header>
            <div className="egg-large-body">
              <ViewFrame content={contents[large.id]} theme={theme} title={large.angle} large />
              {showBuilt ? (
                <aside className="egg-large-built">
                  <h3>Built from</h3>
                  <BuiltFromList entries={large.builtFrom} parents={large.parents} roomId={room?.id ?? null} />
                </aside>
              ) : null}
            </div>
          </div>
        ) : null}

        {compared ? (
          <div className="egg-large egg-compare" data-egg-compare="">
            <header className="egg-card-head">
              <span className="egg-angle">Compare</span>
              <span className="egg-spacer" />
              <span className="egg-muted egg-small">
                <kbd>x</kbd> cross them <kbd>b</kbd> built from <kbd>Esc</kbd> close
              </span>
            </header>
            <div className="egg-compare-body">
              {compared.map((v, i) => (
                <section key={v.id} className="egg-compare-side" data-egg-compare-side={v.id}>
                  <header className="egg-card-head">
                    <span className="egg-badge egg-badge-mark">{i === 0 ? "A" : "B"}</span>
                    <span className="egg-angle">{v.angle}</span>
                    <span className="egg-muted egg-small">round {roundOf(v)?.n ?? "?"} · {roundOf(v)?.line}</span>
                  </header>
                  {lineage(v) ? <p className="egg-lineage egg-small">{lineage(v)}</p> : null}
                  <ViewFrame content={contents[v.id]} theme={theme} title={v.angle} large />
                  {showBuilt ? (
                    <div className="egg-compare-built">
                      <BuiltFromList entries={v.builtFrom} parents={v.parents} roomId={room?.id ?? null} />
                    </div>
                  ) : null}
                </section>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {mode === "rooms" ? (
        <div className="egg-sheet" data-egg-rooms="">
          <h2>Rooms</h2>
          {rooms.length === 0 ? <p className="egg-muted">None yet. n makes one.</p> : null}
          <ol className="egg-room-list">
            {tree.map(({ room: r, depth }, i) => (
              <li
                key={r.id}
                className={i === roomSel ? "egg-selected" : undefined}
                data-egg-room={r.id}
                data-egg-depth={depth}
                style={{ paddingLeft: 8 + depth * 22 }}
                onClick={() => { setRoomId(r.id); setMode("table"); }}
              >
                <span>{depth > 0 ? <span className="egg-muted">↳ </span> : null}{r.subject}</span>
                <span className="egg-muted egg-small">
                  {r.folder} · {r.rounds} round{r.rounds === 1 ? "" : "s"} · {r.kept} kept
                </span>
              </li>
            ))}
          </ol>
          <p className="egg-muted egg-small">j k move · Enter opens · D deletes (kept files stay) · u undoes · n new room · Escape closes</p>
        </div>
      ) : null}
      {mode === "legend" ? <Legend /> : null}
      {creating ? (
        <NewRoomForm
          rpc={rpc}
          projectId={projectId}
          initialLine={creating.line}
          onFailed={failed}
          onMade={(made) => {
            setCreating(null);
            setRoom(made);
            setRoomId(made.id);
            loadRooms();
            refocus();
          }}
          onCancel={() => {
            setCreating(null);
            refocus();
          }}
        />
      ) : null}
    </div>
  );
}
