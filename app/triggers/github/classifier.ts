/**
 * Cold-path topic classifier: one ephemeral, tool-less model turn through the
 * Atlas harness. The harness prepares auth and environment exactly as for
 * trigger sessions, so the classifier has the same credentials they do.
 */
import { tmpdir } from "node:os";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Conversation, ConversationRequest } from "../../lib/harness.ts";
import { ClaudeCodeBackend } from "../harness/claude/backend.ts";
import type { QueryFactory } from "../harness/claude/conversation.ts";
import { slugify, type GitHubEvent } from "./events.ts";
import type { Topic } from "./ledger.ts";

export interface Classification {
  slug: string;
  title: string;
  is_new: boolean;
  notes: string | null;
}

/** The slice of HarnessBackend the classifier needs (tests inject a fake). */
export interface ConversationBackend {
  openConversation(request: ConversationRequest): Conversation;
}

const SYSTEM_PROMPT = `You route GitHub issues and pull requests to work topics. You have no tools. \
Answer with exactly one compact JSON object and nothing else.`;

const EXCERPT_CHARS = 1500;

export function buildClassifierPrompt(ev: GitHubEvent, topics: Topic[], fallbackSlug: string): string {
  const ledger = topics.length
    ? topics.map((t) => JSON.stringify({ slug: t.slug, title: t.title, notes: t.notes ?? "", refs: t.refs })).join("\n")
    : "(none)";
  const excerpt = ev.text.length > EXCERPT_CHARS ? `${ev.text.slice(0, EXCERPT_CHARS)}…` : ev.text;
  return `A GitHub event needs a topic. A topic groups related work in ${ev.repo}, for example an issue and the PR that fixes it, and each topic has its own long-running agent session.

Existing topics in this repository (one JSON object per line):
${ledger}

Event:
${JSON.stringify({ ref: `${ev.repo}#${ev.number}`, kind: ev.kind, type: ev.type, action: ev.action, title: ev.title, author: ev.author, text: excerpt }, null, 2)}

Reuse an existing topic only when this is clearly the same piece of work. When uncertain, create a new topic: a wrong merge puts unrelated work into one session, while a split only costs some context.

For a new topic choose a short kebab-case slug, e.g. "${fallbackSlug}". "notes" is one line that helps match later events (area, linked issues).

Reply with only: {"slug":"…","title":"…","is_new":true|false,"notes":"…"}`;
}

/**
 * Parses the model's answer. Throws with the reason when it is unusable, so the
 * caller can log it. Joining requires the slug to be one of `offered`; a new
 * topic must not collide with any existing slug (`exists`).
 */
export function parseClassification(
  text: string | null,
  offered: Set<string>,
  exists: (slug: string) => boolean,
): Classification {
  if (!text) throw new Error("empty answer");
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) throw new Error(`no JSON object in answer: ${text.slice(0, 200)}`);
  let data: any;
  try {
    data = JSON.parse(match[0]);
  } catch (err) {
    throw new Error(`invalid JSON (${(err as Error).message}): ${match[0].slice(0, 200)}`);
  }
  if (typeof data?.slug !== "string" || !data.slug.trim()) throw new Error(`answer has no slug: ${match[0].slice(0, 200)}`);
  const slug = slugify(data.slug);
  const title = typeof data.title === "string" && data.title.trim() ? data.title.trim().slice(0, 200) : slug;
  const notes = typeof data.notes === "string" && data.notes.trim() ? data.notes.trim().slice(0, 500) : null;
  if (offered.has(slug)) return { slug, title, is_new: false, notes };
  if (data.is_new === false) throw new Error(`answer joins unknown topic "${slug}"`);
  if (exists(slug)) throw new Error(`new topic "${slug}" collides with an existing topic of another repository`);
  return { slug, title, is_new: true, notes };
}

/** One single-turn conversation with a hard timeout; returns the answer text. */
export async function askOnce(backend: ConversationBackend, request: ConversationRequest, timeoutMs: number): Promise<string> {
  const conversation = backend.openConversation(request);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      conversation.stop();
      reject(new Error(`classifier timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  const answer = (async () => {
    for await (const event of conversation) {
      if (event.type !== "turn.finished") continue;
      const result = event.result;
      if (result.outcome !== "completed" || result.error) {
        throw new Error(`classifier turn failed (${result.error?.code ?? result.outcome}): ${result.error?.message ?? result.text ?? ""}`);
      }
      return result.text ?? "";
    }
    throw new Error("classifier conversation ended without a result");
  })();
  // The loser of the race must not surface as an unhandled rejection.
  answer.catch(() => {});
  timeout.catch(() => {});
  try {
    return await Promise.race([answer, timeout]);
  } finally {
    clearTimeout(timer);
    conversation.stop();
  }
}

export interface ClassifyOptions {
  backend: ConversationBackend;
  model: string;
  timeoutMs: number;
  /** Same-repository topics the event may join. */
  topics: Topic[];
  fallbackSlug: string;
  exists: (slug: string) => boolean;
}

export async function classify(ev: GitHubEvent, options: ClassifyOptions): Promise<Classification> {
  const text = await askOnce(options.backend, {
    cwd: tmpdir(),
    model: options.model,
    systemPrompt: SYSTEM_PROMPT,
    prompt: buildClassifierPrompt(ev, options.topics, options.fallbackSlug),
    mcpServers: {},
    turns: "single",
    ephemeral: true,
  }, options.timeoutMs);
  return parseClassification(text, new Set(options.topics.map((t) => t.slug)), options.exists);
}

/**
 * The Claude backend with every tool, MCP server and settings file switched
 * off for this call: the classifier answers from the prompt alone.
 */
export function createClassifierBackend(factory: QueryFactory = query): ConversationBackend {
  const toolless = ((request: Parameters<QueryFactory>[0]): Query => factory({
    ...request,
    options: { ...request.options, tools: [], maxTurns: 1, settingSources: [], strictMcpConfig: true },
  })) as QueryFactory;
  return new ClaudeCodeBackend({ query: toolless });
}
