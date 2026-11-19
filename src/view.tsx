// egg's page: the notebook of lines on the left, the table of views on the
// right, rooms and the legend over them. Everything is reachable from the
// keyboard; see LEGEND in keys.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBbContext, useRealtime, useRpc, useSdk, useSettings } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import { type Mode, type Selection, LEGEND, asLine, clampSelection, commandFor, holdKeyCode, isEditable, moveSelection, pasteAction } from "./keys.ts";
import { type BuiltFrom, type Line, type Room, type RoomSummary, type Round, type View, keptViews, roundViews } from "./model.ts";
import { builtFromCount } from "./provenance.ts";
import { PLAIN_THEME, VIEW_SANDBOX, type ViewTheme, viewDocument } from "./sandbox.ts";
import { type VoiceState, clipFile, createHoldToTalk, mediaRecorder } from "./voice.ts";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Content = { format: "html" | "text"; content: string };

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

function BuiltFromList({ entries }: { entries: readonly BuiltFrom[] }) {
  if (entries.length === 0) return <p className="egg-muted egg-small">Its thread read nothing and ran nothing.</p>;
  return (
    <ul className="egg-built" data-egg-built-from="">
      {entries.map((e, i) => (
        <li key={i} className={e.outside ? "egg-built-outside" : undefined}>
          <span className="egg-built-kind">{e.kind}</span>
          <code>{e.what}</code>
          {e.failed ? <span className="egg-trouble"> (failed)</span> : null}
          {e.outside ? <span className="egg-trouble"> (outside its storage)</span> : null}
        </li>
      ))}
    </ul>
  );
}

function statusText(view: View, now: number): string {
  if (view.status === "waiting") return "starting…";
  if (view.status === "running") return `reading… ${view.startedAt ? Math.round((now - view.startedAt) / 1000) : 0} s`;
  if (view.status === "failed") return `failed: ${view.error ?? "unknown"}`;
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
}) {
  const { view } = props;
  return (
    <section
      className={`egg-card${props.selected ? " egg-selected" : ""}${props.compact ? " egg-card-compact" : ""} egg-${view.status}`}
      data-egg-card={view.id}
      data-egg-status={view.status}
      data-egg-decision={view.decision ?? ""}
      onClick={props.onSelect}
      onDoubleClick={props.onOpen}
    >
      <header className="egg-card-head">
        <span className="egg-angle">{view.angle}</span>
        {view.decision === "kept" ? <span className="egg-badge">kept</span> : null}
      </header>
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
      {props.showBuilt && view.status !== "waiting" ? <BuiltFromList entries={view.builtFrom} /> : null}
    </section>
  );
}

function Notebook({ lines, children }: { lines: readonly Line[]; children: React.ReactNode }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);
  return (
    <div className="egg-notebook" data-egg-notebook="">
      <ol className="egg-lines">
        {lines.map((line) => (
          <li key={line.id} className={`egg-line egg-line-${line.kind}`} data-egg-line={line.kind}>
            <span className="egg-line-mark">{line.kind === "said" ? (line.source === "voice" ? "◉" : "›") : line.kind === "trouble" ? "!" : "·"}</span>
            <span className="egg-line-text">{line.text}</span>
          </li>
        ))}
      </ol>
      {children}
      <div ref={end} />
    </div>
  );
}

function LineInput(props: { initial: string; onSend: (text: string) => void; onLeave: () => void }) {
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
      <span className="egg-line-mark">›</span>
      <input
        ref={ref}
        className="egg-input"
        data-egg-line-input=""
        defaultValue={props.initial}
        placeholder="a line about the subject; Enter sends, Escape leaves"
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

function NewRoomForm(props: { rpc: Rpc; projectId: string | null; initialLine: string; onMade: (room: Room) => void; onCancel: () => void }) {
  const [folder, setFolder] = useState("");
  const [line, setLine] = useState(props.initialLine);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lineRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    props.rpc.call("defaults", { projectId: props.projectId }).then((d) => setFolder((f) => f || d.folder || ""), () => undefined);
    (props.initialLine ? lineRef : folderRef).current?.focus();
  }, []);
  const submit = async () => {
    const text = asLine(line);
    if (!folder.trim() || !text) return setError("Both a folder and a first line, please.");
    setBusy(true);
    try {
      const { room } = await props.rpc.call("room_create", { folder: folder.trim(), line: text, projectId: props.projectId, source: "typed" });
      props.onMade(room);
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  const keys = (e: React.KeyboardEvent<HTMLInputElement>) => {
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
        <input ref={folderRef} className="egg-input" data-egg-folder="" value={folder} onChange={(e) => setFolder(e.target.value)} onKeyDown={keys} />
      </label>
      <label>
        <span className="egg-muted egg-small">First line: what you are looking for</span>
        <input ref={lineRef} className="egg-input" data-egg-first-line="" value={line} onChange={(e) => setLine(e.target.value)} onKeyDown={keys} placeholder="where do requests get authenticated?" />
      </label>
      <p className="egg-muted egg-small">Enter makes the room and starts the first round · Tab between fields · Escape cancels</p>
      {error ? <p className="egg-trouble">{error}</p> : null}
      {busy ? <p className="egg-muted">Making the room…</p> : null}
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
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const { projectId } = useBbContext();
  const { values: settings } = useSettings();
  const rootRef = useRef<HTMLDivElement>(null);

  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [room, setRoom] = useState<Room | null>(null);
  const [roomId, setRoomId] = useState<string | null>(() => localStorage.getItem(LAST_ROOM));
  const [mode, setMode] = useState<Mode>("table");
  const [creating, setCreating] = useState<{ line: string } | null>(null);
  const [input, setInput] = useState<{ text: string; key: number; source: "typed" | "pasted" } | null>(null);
  const [roundIndex, setRoundIndex] = useState<number | null>(null);
  const [sel, setSel] = useState<Selection>({ row: 0, col: 0 });
  const [roomSel, setRoomSel] = useState(0);
  const [showBuilt, setShowBuilt] = useState(false);
  const [contents, setContents] = useState<Record<string, Content>>({});
  const [voice, setVoice] = useState<VoiceState>("idle");
  const [hint, setHint] = useState<string | null>(null);
  const [roomsDir, setRoomsDir] = useState<string>("");
  const [theme, setTheme] = useState<ViewTheme>(PLAIN_THEME);
  const undo = useRef<{ roomId: string; viewId: string; before: View["decision"] }[]>([]);

  const loadRooms = useCallback(() => {
    rpc.call("rooms_list").then((r) => setRooms(r.rooms), () => undefined);
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

  useEffect(() => {
    loadRooms();
    rpc.call("defaults", { projectId }).then((d) => setRoomsDir(d.roomsDir), () => undefined);
  }, [loadRooms, rpc, projectId]);
  useEffect(() => {
    if (roomId) {
      localStorage.setItem(LAST_ROOM, roomId);
      loadRoom(roomId);
    } else setRoom(null);
  }, [roomId, loadRoom]);
  useEffect(() => {
    if (!roomId && rooms.length === 0 && !creating) setCreating({ line: "" });
  }, [roomId, rooms.length]);
  useRealtime("room-changed", (payload) => {
    const changed = (payload as { roomId?: unknown })?.roomId;
    loadRooms();
    if (typeof changed === "string" && changed === roomId) loadRoom(changed);
  });
  useEffect(() => {
    setTheme(readTheme(rootRef.current));
    rootRef.current?.focus();
  }, []);

  // What the table shows.
  const rounds = room?.rounds ?? [];
  const shownIndex = roundIndex === null ? rounds.length - 1 : Math.min(roundIndex, rounds.length - 1);
  const round: Round | undefined = rounds[shownIndex];
  const cards = useMemo(() => (room && round ? roundViews(room, round).filter((v) => v.decision !== "dropped") : []), [room, round]);
  const dropped = useMemo(() => (room && round ? roundViews(room, round).filter((v) => v.decision === "dropped").length : 0), [room, round]);
  const kept = useMemo(() => (room ? keptViews(room) : []), [room]);
  const rowLengths = [cards.length, kept.length];
  const current = clampSelection(sel, rowLengths);
  const selected: View | undefined = current.row === 0 ? cards[current.col] : kept[current.col];
  const anyRunning = cards.some((v) => v.status === "running" || v.status === "waiting") || round?.status === "planning";
  const now = useNow(anyRunning);

  // Fetch the content of every finished view on screen.
  useEffect(() => {
    if (!room) return;
    const need = [...cards, ...kept].filter((v) => v.status === "done" && !contents[v.id]);
    for (const v of need) {
      rpc.call("view_content", { roomId: room.id, viewId: v.id }).then(
        (c) => c && setContents((all) => ({ ...all, [v.id]: c })),
        () => undefined,
      );
    }
  }, [room, cards, kept]);

  // A new round arriving takes the table to it.
  const roundCount = rounds.length;
  useEffect(() => {
    setRoundIndex(null);
    setSel({ row: 0, col: 0 });
  }, [roundCount, room?.id]);

  const flash = (text: string) => {
    setHint(text);
    setTimeout(() => setHint((h) => (h === text ? null : h)), 3000);
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
        flash(`Could not send: ${errText(e)}`);
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
      flash(errText(e));
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
  const state = { mode, creating, input, room, cards, kept, current, selected, rounds, shownIndex, rooms, roomSel, holdKey, settings };
  const live = useRef(state);
  live.current = state;
  useEffect(() => {
    const ours = () => {
      const active = document.activeElement;
      return !active || active === document.body || (rootRef.current?.contains(active) ?? false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const s = live.current;
      if (!ours() || isEditable(document.activeElement as HTMLElement | null) || s.creating || s.input) return;
      if (s.holdKey && e.code === s.holdKey && !e.ctrlKey && !e.metaKey && !e.altKey && s.mode !== "rooms" && s.mode !== "legend") {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) void talk.press();
        return;
      }
      const command = commandFor(e, s.mode);
      if (!command) return;
      e.preventDefault();
      e.stopPropagation();
      run(command);
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
        if (s.mode === "rooms") setRoomSel((i) => Math.max(0, Math.min(s.rooms.length - 1, i + command.dy)));
        else setSel(moveSelection(s.current, [s.cards.length, s.kept.length], command.dx, command.dy));
        return;
      case "first":
        setSel({ row: s.current.row, col: 0 });
        return;
      case "last":
        setSel({ row: s.current.row, col: 99 });
        return;
      case "open":
        if (s.mode === "rooms") {
          const target = s.rooms[s.roomSel];
          if (target) {
            setRoom(null);
            setRoomId(target.id);
          }
          setMode("table");
        } else if (s.selected?.status === "done") setMode("large");
        return;
      case "close":
        setMode("table");
        return;
      case "keep":
        if (s.selected?.status === "done" && s.selected.decision !== "kept") void decide(s.selected, "kept");
        return;
      case "drop":
        if (s.selected && s.current.row === 0 && s.selected.decision !== "dropped") {
          void decide(s.selected, "dropped");
          if (s.mode === "large") setMode("table");
        }
        return;
      case "undo": {
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
        else setInput({ text: "", key: Date.now(), source: "typed" });
        return;
      case "rooms":
        loadRooms();
        setRoomSel(0);
        setMode("rooms");
        return;
      case "new-room":
        setMode("table");
        setCreating({ line: "" });
        return;
      case "legend":
        setMode((m) => (m === "legend" ? "table" : "legend"));
        return;
    }
  }

  const refocus = () => setTimeout(() => rootRef.current?.focus(), 0);
  const large = mode === "large" && selected?.status === "done" ? selected : null;

  return (
    <div className="egg" ref={rootRef} tabIndex={-1} data-egg-root="" data-egg-mode={mode} data-egg-voice={voice}>
      <span className="egg-muted" hidden />
      <header className="egg-top">
        <span className="egg-mark">egg</span>
        {room ? (
          <>
            <span className="egg-subject" data-egg-subject="">{room.subject}</span>
            <span className="egg-muted egg-small" title="the folder this room reads">reads {room.folder}</span>
            <span className="egg-muted egg-small" data-egg-room-dir="" title="kept views are written here">keeps to {room.dir}</span>
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

      <div className="egg-main">
        <Notebook lines={room?.lines ?? []}>
          {input && room ? (
            <LineInput
              key={input.key}
              initial={input.text}
              onSend={(text) => {
                setInput(null);
                refocus();
                void send(text, input.source);
              }}
              onLeave={() => {
                setInput(null);
                refocus();
              }}
            />
          ) : room ? (
            <p className="egg-muted egg-small egg-prompt-hint">
              <kbd>i</kbd> or paste a line{holdKey ? <> · hold <kbd>{holdKey === "Space" ? "Space" : "`"}</kbd> to talk</> : null}
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
                {dropped ? <span className="egg-muted egg-small">{dropped} dropped</span> : null}
              </div>
              <div className="egg-cards" data-egg-cards="">
                {round.status === "planning" && cards.length === 0
                  ? [0, 1, 2, 3].map((i) => <div key={i} className="egg-card egg-card-ghost" />)
                  : cards.map((v, i) => (
                      <Card
                        key={v.id}
                        view={v}
                        selected={current.row === 0 && current.col === i}
                        content={contents[v.id]}
                        theme={theme}
                        showBuilt={showBuilt}
                        now={now}
                        onSelect={() => setSel({ row: 0, col: i })}
                        onOpen={() => {
                          setSel({ row: 0, col: i });
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
                    selected={current.row === 1 && current.col === i}
                    content={contents[v.id]}
                    theme={theme}
                    showBuilt={false}
                    now={now}
                    onSelect={() => setSel({ row: 1, col: i })}
                    onOpen={() => {
                      setSel({ row: 1, col: i });
                      setMode("large");
                    }}
                  />
                ))}
                {kept.length === 0 ? <span className="egg-muted egg-small">y keeps the selected view</span> : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {large ? (
        <div className="egg-large" data-egg-large={large.id}>
          <header className="egg-card-head">
            <span className="egg-angle">{large.angle}</span>
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
                <BuiltFromList entries={large.builtFrom} />
              </aside>
            ) : null}
          </div>
        </div>
      ) : null}

      {mode === "rooms" ? (
        <div className="egg-sheet" data-egg-rooms="">
          <h2>Rooms</h2>
          {rooms.length === 0 ? <p className="egg-muted">None yet. n makes one.</p> : null}
          <ol className="egg-room-list">
            {rooms.map((r, i) => (
              <li key={r.id} className={i === roomSel ? "egg-selected" : undefined} data-egg-room={r.id} onClick={() => { setRoomId(r.id); setMode("table"); }}>
                <span>{r.subject}</span>
                <span className="egg-muted egg-small">
                  {r.folder} · {r.rounds} round{r.rounds === 1 ? "" : "s"} · {r.kept} kept
                </span>
              </li>
            ))}
          </ol>
          <p className="egg-muted egg-small">j k move · Enter opens · n new room · Escape closes</p>
        </div>
      ) : null}
      {mode === "legend" ? <Legend /> : null}
      {creating ? (
        <NewRoomForm
          rpc={rpc}
          projectId={projectId}
          initialLine={creating.line}
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
