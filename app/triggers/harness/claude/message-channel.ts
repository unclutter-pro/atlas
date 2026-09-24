import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
const IDLE_TIMEOUT_MS = parseInt(process.env.TRIGGER_IDLE_TIMEOUT ?? "300000", 10);

/**
 * Options for pushing a user message into the channel.
 *
 * - `shouldQuery: false` — SDK v0.2.110+: append the message to the transcript
 *   without triggering a new assistant turn. The message merges into the
 *   current turn's next LLM call. Use for mid-turn steering (the agent
 *   reacts to new info without restarting work).
 * - `priority` — present in SDK type but undocumented. We set `'now'` as a
 *   hint for mid-turn steering.
 */
export type PushOptions = {
  shouldQuery?: boolean;
  priority?: "now" | "next" | "later";
};

/**
 * Create an async message channel backed by a simple queue + promise resolver pattern.
 * Returns an AsyncGenerator that yields SDKUserMessages and a push function for injection.
 * The generator will return (end) after idleTimeoutMs of inactivity.
 */
export function createMessageChannel(
  sessionId: string,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
) {
  type Waiter = { resolve: (msg: SDKUserMessage) => void };
  const waiters: Waiter[] = [];
  const pending: SDKUserMessage[] = [];
  let closed = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleReject: (() => void) | null = null;

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      closed = true;
      // Wake any waiting consumer so it can exit
      if (idleReject) idleReject();
    }, idleTimeoutMs);
  }

  function buildUserMessage(
    text: string,
    opts?: PushOptions,
  ): SDKUserMessage {
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
    // shouldQuery: false → append context without triggering a new assistant
    // turn (SDK v0.2.110+). Used for mid-turn steering: the message merges
    // into the current turn's next LLM call, so the agent reacts to the new
    // info without restarting work.
    if (opts?.shouldQuery !== undefined) {
      (msg as unknown as { shouldQuery: boolean }).shouldQuery = opts.shouldQuery;
    }
    // priority: 'now' | 'next' | 'later' — present in SDK type but undocumented.
    // Setting 'now' for mid-turn steering as a hint; SDK may or may not honor.
    if (opts?.priority !== undefined) {
      (msg as unknown as { priority: PushOptions["priority"] }).priority = opts.priority;
    }
    return msg;
  }

  async function* generator(): AsyncGenerator<SDKUserMessage> {
    resetIdleTimer();
    while (!closed) {
      if (pending.length > 0) {
        resetIdleTimer();
        yield pending.shift()!;
      } else {
        try {
          const msg = await new Promise<SDKUserMessage>((resolve, reject) => {
            idleReject = reject;
            waiters.push({ resolve });
          });
          resetIdleTimer();
          yield msg;
        } catch {
          // Idle timeout triggered — exit generator
          break;
        }
      }
    }
    if (idleTimer) clearTimeout(idleTimer);
  }

  function push(text: string, opts?: PushOptions) {
    const msg = buildUserMessage(text, opts);
    if (waiters.length > 0) {
      const waiter = waiters.shift()!;
      idleReject = null;
      waiter.resolve(msg);
    } else {
      pending.push(msg);
    }
  }

  function close() {
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (idleReject) idleReject();
  }

  return { generator: generator(), push, close, buildUserMessage };
}
