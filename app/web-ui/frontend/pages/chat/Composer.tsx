/** Message input: autogrowing textarea, Enter to send, optional voice recording. */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../components";

const MAX_HEIGHT = 200;
const MAX_RECORDING_MS = 5 * 60_000;
const VOICE_MIME_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];

export function voiceSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof window !== "undefined" && typeof window.MediaRecorder === "function";
}

function pickMimeType(): string | undefined {
  return VOICE_MIME_TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function Composer(props: {
  disabled?: boolean;
  disabledHint?: string;
  onSend: (text: string) => void;
  onSendVoice: (blob: Blob, caption: string) => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t || props.disabled) return;
    props.onSend(t);
    setText("");
    ref.current?.focus();
  };

  if (props.disabled) {
    return (
      <div className="chat-composer is-disabled">
        <div className="chat-composer-hint">{props.disabledHint ?? "Sending is disabled"}</div>
      </div>
    );
  }

  return (
    <form
      className="chat-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={ref}
        className="chat-input"
        rows={1}
        value={text}
        placeholder="Message…"
        title="Enter sends, Shift+Enter adds a new line"
        aria-label="Message"
        autoFocus={props.autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {voiceSupported() ? (
        <VoiceRecorder
          onRecorded={(blob) => {
            props.onSendVoice(blob, text.trim());
            setText("");
          }}
        />
      ) : (
        typeof window !== "undefined" &&
        !window.isSecureContext && (
          // Browsers only expose the microphone on HTTPS or localhost.
          <Button variant="secondary" disabled title="Voice messages need HTTPS or localhost" aria-label="Voice messages need HTTPS or localhost">
            <MicIcon />
          </Button>
        )
      )}
      <Button type="submit" variant="primary" disabled={!text.trim()}>
        Send
      </Button>
    </form>
  );
}

type RecState = { kind: "idle" } | { kind: "recording"; startedAt: number } | { kind: "uploading" } | { kind: "error"; message: string };

/** idle → recording (timer, Cancel, Send) → uploading → idle. Auto-sends at 5 minutes. */
export function VoiceRecorder(props: { onRecorded: (blob: Blob) => void }) {
  const [state, setState] = useState<RecState>({ kind: "idle" });
  const [now, setNow] = useState(Date.now());
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; send: boolean } | null>(null);
  const onRecordedRef = useRef(props.onRecorded);
  onRecordedRef.current = props.onRecorded;

  const release = () => {
    rec.current?.stream.getTracks().forEach((t) => t.stop());
    rec.current = null;
  };

  // Stop the microphone when the chat unmounts mid-recording.
  useEffect(
    () => () => {
      if (rec.current && rec.current.recorder.state !== "inactive") {
        rec.current.send = false;
        rec.current.recorder.stop();
      }
      release();
    },
    [],
  );

  const finish = (send: boolean) => {
    const r = rec.current;
    if (!r) return;
    r.send = send;
    if (send) setState({ kind: "uploading" });
    else setState({ kind: "idle" });
    if (r.recorder.state !== "inactive") r.recorder.stop();
  };

  useEffect(() => {
    if (state.kind !== "recording") return;
    const id = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - state.startedAt >= MAX_RECORDING_MS) finish(true);
    }, 250);
    return () => clearInterval(id);
  }, [state]);

  // getUserMedia can take a while (permission prompt): ignore repeat clicks,
  // and drop a stream that arrives after unmount, so the mic never stays on.
  const starting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);

  const start = async () => {
    if (starting.current || rec.current) return;
    starting.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const r = { recorder, stream, chunks: [] as Blob[], send: false };
      rec.current = r;
      recorder.ondataavailable = (e) => e.data.size > 0 && r.chunks.push(e.data);
      recorder.onstop = () => {
        const blob = new Blob(r.chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
        r.stream.getTracks().forEach((t) => t.stop());
        if (rec.current === r) rec.current = null;
        if (r.send && blob.size > 0) onRecordedRef.current(blob);
        setState({ kind: "idle" });
      };
      recorder.start(1000);
      setNow(Date.now());
      setState({ kind: "recording", startedAt: Date.now() });
    } catch (err) {
      release();
      const denied = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");
      setState({ kind: "error", message: denied ? "Microphone access denied" : "Could not start recording" });
    } finally {
      starting.current = false;
    }
  };

  if (state.kind === "recording") {
    return (
      <div className="chat-recorder" role="group" aria-label="Recording voice message">
        <span className="chat-rec-dot" />
        <span className="chat-rec-time num">{clock(now - state.startedAt)}</span>
        <Button size="sm" variant="ghost" onClick={() => finish(false)}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={() => finish(true)}>
          Send voice
        </Button>
      </div>
    );
  }
  if (state.kind === "uploading") {
    return (
      <Button variant="secondary" disabled>
        Preparing…
      </Button>
    );
  }
  return (
    <>
      {state.kind === "error" && <span className="chat-rec-error small text-error">{state.message}</span>}
      <Button variant="secondary" onClick={start} title="Record a voice message" aria-label="Record a voice message">
        <MicIcon />
      </Button>
    </>
  );
}

function MicIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4" />
    </svg>
  );
}
