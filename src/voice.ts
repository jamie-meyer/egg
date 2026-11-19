// Hold to talk: record while the key is held, transcribe the whole clip on
// release. Never acts on a pause, only on release. Clips under a second are
// ignored. The recorder and the transcription are passed in, so the rules
// are tested without a microphone.

export const MIN_CLIP_MS = 1000;

export interface Recorder {
  /** Start recording; rejects when the microphone cannot be opened. */
  start(): Promise<void>;
  /** Stop and hand back the whole clip. */
  stop(): Promise<Blob>;
  /** Stop and throw the clip away. */
  cancel(): void;
}

export type VoiceState = "idle" | "starting" | "recording" | "transcribing";

export interface HoldToTalkOptions {
  recorder: Recorder;
  transcribe: (clip: Blob) => Promise<string>;
  /** The transcript, to be treated exactly as a typed line. */
  onLine: (text: string) => void;
  /** Something went wrong, in plain words; becomes a line in the notebook. */
  onTrouble: (text: string) => void;
  /** A short-lived hint, such as a clip being too short. */
  onHint?: (text: string) => void;
  onState: (state: VoiceState) => void;
  now?: () => number;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createHoldToTalk(options: HoldToTalkOptions) {
  const now = options.now ?? Date.now;
  let state: VoiceState = "idle";
  let startedAt = 0;
  let released = false;
  let starting: Promise<void> | null = null;

  const set = (next: VoiceState) => {
    state = next;
    options.onState(next);
  };

  async function press() {
    if (state !== "idle") return;
    released = false;
    startedAt = now();
    set("starting");
    starting = options.recorder.start().then(
      () => {
        if (state === "starting") set("recording");
      },
      (e) => {
        set("idle");
        options.onTrouble(`Could not record: ${errText(e)}`);
        throw e;
      },
    );
    await starting.catch(() => undefined);
    // Released while the microphone was still opening: finish now.
    if (released && (state as VoiceState) === "recording") await finish();
  }

  async function finish() {
    const held = now() - startedAt;
    if (held < MIN_CLIP_MS) {
      options.recorder.cancel();
      set("idle");
      options.onHint?.("Too short to send: hold the key while you speak.");
      return;
    }
    set("transcribing");
    let clip: Blob;
    try {
      clip = await options.recorder.stop();
    } catch (e) {
      set("idle");
      options.onTrouble(`Recording failed: ${errText(e)}`);
      return;
    }
    try {
      const text = (await options.transcribe(clip)).replace(/\s+/g, " ").trim();
      set("idle");
      if (text) options.onLine(text);
      else options.onHint?.("Nothing was heard in that clip.");
    } catch (e) {
      set("idle");
      options.onTrouble(`Transcription failed: ${errText(e)}`);
    }
  }

  async function release() {
    released = true;
    if (state === "recording") await finish();
  }

  /** Lost focus or the page went away mid-recording: throw the clip away. */
  function abort() {
    if (state === "recording" || state === "starting") {
      options.recorder.cancel();
      set("idle");
    }
  }

  return { press, release, abort, get state() { return state; } };
}

/** A MediaRecorder-backed recorder for the page (audio/webm;codecs=opus where supported). */
export function mediaRecorder(): Recorder {
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  const release = () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    recorder = null;
  };
  return {
    async start() {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.start();
    },
    stop() {
      return new Promise<Blob>((resolve, reject) => {
        const r = recorder;
        if (!r) return reject(new Error("not recording"));
        r.onstop = () => {
          const type = r.mimeType || "audio/webm";
          release();
          resolve(new Blob(chunks, { type }));
        };
        r.onerror = () => {
          release();
          reject(new Error("the recorder failed"));
        };
        r.stop();
      });
    },
    cancel() {
      try {
        recorder?.stop();
      } catch {
        // already stopped
      }
      release();
      chunks = [];
    },
  };
}

/** The clip as a File for bb's transcription. */
export function clipFile(clip: Blob): File {
  const ext = clip.type.includes("webm") ? "webm" : clip.type.includes("ogg") ? "ogg" : clip.type.includes("wav") ? "wav" : "webm";
  return new File([clip], `egg-line.${ext}`, { type: clip.type || "audio/webm" });
}
