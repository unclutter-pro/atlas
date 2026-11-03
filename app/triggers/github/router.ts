/**
 * GitHub event router. Per delivery it decides, without a model call where
 * possible, which topic session (if any) gets the event:
 *
 *   skip  duplicate, noise, own action, green CI, not involved, comment/review
 *         edits, inline comments of a review (the review event covers them)
 *   link  own PR opened/edited/reopened, untracked, references a tracked ref → bound, no dispatch
 *   hot   ref already in the ledger → its topic
 *   cold  involved + unseen ref → keyword-reference join, else classifier, else default slug
 *
 * Side effects go through RouterDeps so the decision logic is testable.
 */
import {
  ACTIONABLE_EVENTS, CI_EVENTS, CI_FAILURE_CONCLUSIONS, NOISE_ACTIONS,
  closingRefsInText, defaultSlug, extractCi, extractEvent, intentFor, involvement, itemText, looseRefsInText, mentions,
  reactionTarget, repoAllowed,
  type Envelope, type GitHubEvent, type Intent,
} from "./events.ts";
import { classify, type ConversationBackend } from "./classifier.ts";
import type { Ledger } from "./ledger.ts";
import { authorOf, markIfUntrusted } from "./trust.ts";

export interface RouterConfig {
  /** Lower-case GitHub login Atlas acts as. */
  login: string;
  repos: string[];
  routerModel: string;
  routerTimeoutMs: number;
}

/** GitHub lookups. All best effort: implementations may throw, callers log. */
export interface GitHubApi {
  /** Issue refs (ledger spelling) the PR closes, from closingIssuesReferences. */
  closingIssues(repo: string, number: number): Promise<string[]>;
  /** Current head sha of a PR. */
  prHeadSha(repo: string, number: number): Promise<string | null>;
  /** Inline comments of a submitted review (first 100). */
  reviewComments(repo: string, number: number, reviewId: number): Promise<{ body: string; inReplyTo: boolean }[]>;
  /** Adds an 👀 reaction to a comment or review node. */
  addReaction(nodeId: string): Promise<void>;
}

export interface InboxEntry {
  sender: string;
  content: string;
  sessionKey: string;
}

export interface RouterDeps {
  config: RouterConfig;
  ledger: Ledger;
  github: GitHubApi;
  backend: ConversationBackend;
  /** Fires the worker trigger for `slug`; resolves once the runner has taken the event, throws otherwise. */
  dispatch(payload: string, slug: string): void | Promise<void>;
  /** Surfaces a dispatched event in the Atlas inbox. Optional. */
  inbox?(entry: InboxEntry): void;
  log(message: string): void;
}

export type RoutePath =
  | "hot" | "cold" | "hot-ci" | "closing" | "register" | "autolink" | "unassigned" | "closed-untracked"
  | `skip:${string}`;

export interface RouterInfo {
  slug: string;
  ref: string;
  event_type: string;
  action: string;
  path: "hot" | "cold" | "hot-ci" | "closing";
  intent: Intent;
  ci?: { name: string; conclusion: string; head_sha: string; url: string };
  /** Present only when the payload carries at least one <untrusted-content> field. */
  trust?: { untrusted_authors: string[] };
}

export interface RouteResult {
  path: RoutePath;
  ref?: string | null;
  slug?: string | null;
  intent?: Intent;
  /** Worker payloads handed to dispatch(), in order. */
  dispatched: { slug: string; payload: string }[];
}

/** Comment and review edits are not new asks; issue and PR edits still route. */
const EDIT_SKIPPED_EVENTS = new Set(["issue_comment", "pull_request_review_comment", "pull_request_review"]);

/** Own PR actions that may bind an untracked PR to the topic it references. */
const AUTOLINK_ACTIONS = new Set(["opened", "edited", "reopened"]);

/** Argument size limit is 128 KiB per argv string on Linux; stay well below. */
const MAX_PAYLOAD_CHARS = 100_000;

/**
 * Marks `obj[field]` (for each `field`) as untrusted when `obj`'s own
 * author_association says so, and records the login in `untrusted`. Returns
 * `obj` unchanged when nothing needed marking.
 */
function markObject(obj: any, fields: string[], me: string, untrusted: Set<string>): any {
  if (!obj) return obj;
  const { login, association } = authorOf(obj);
  let changed = false;
  const next = { ...obj };
  for (const field of fields) {
    if (typeof obj[field] !== "string" || !obj[field]) continue;
    const marked = markIfUntrusted(obj[field], login, association, me);
    if (marked !== obj[field]) {
      next[field] = marked;
      changed = true;
      untrusted.add(login || "unknown");
    }
  }
  return changed ? next : obj;
}

/**
 * Webhook body without the bulky org/repo/installation objects. Title/body of
 * the issue or PR, and the body of the comment or review, are wrapped as
 * `<untrusted-content>` when their own author is not trusted (see trust.ts);
 * each is judged by its own author, not by whoever triggered the event.
 */
function compactBody(body: any, me: string): { body: any; untrustedAuthors: string[] } {
  const { repository, organization, installation, enterprise, sender, ...rest } = body;
  const next: any = {
    ...rest,
    ...(repository ? { repository: { full_name: repository.full_name, html_url: repository.html_url, default_branch: repository.default_branch, private: repository.private } } : {}),
    ...(sender ? { sender: { login: sender.login, type: sender.type } } : {}),
  };
  const untrusted = new Set<string>();
  if (next.issue) next.issue = markObject(next.issue, ["title", "body"], me, untrusted);
  if (next.pull_request) next.pull_request = markObject(next.pull_request, ["title", "body"], me, untrusted);
  if (next.comment) next.comment = markObject(next.comment, ["body"], me, untrusted);
  if (next.review) next.review = markObject(next.review, ["body"], me, untrusted);
  return { body: next, untrustedAuthors: [...untrusted].sort() };
}

export function buildPayload(ev: GitHubEvent, router: RouterInfo, me: string): string {
  const { body, untrustedAuthors } = compactBody(ev.body, me);
  const withTrust = untrustedAuthors.length ? { ...router, trust: { untrusted_authors: untrustedAuthors } } : router;
  const payload = JSON.stringify({ _router: withTrust, event: ev.type, delivery: ev.delivery, body });
  if (payload.length <= MAX_PAYLOAD_CHARS) return payload;
  return JSON.stringify({
    _router: withTrust, event: ev.type, delivery: ev.delivery,
    truncated: "The webhook body was too large to pass on; read the current state with gh.",
    summary: {
      repo: ev.repo, number: ev.number, sender: ev.sender,
      title: markIfUntrusted(ev.title, ev.author, ev.titleAssociation, me),
      text: markIfUntrusted(ev.text.slice(0, 4000), ev.textAuthor, ev.textAssociation, me),
    },
  });
}

function inboxContent(ev: GitHubEvent, router: RouterInfo, me: string): string {
  const title = markIfUntrusted(ev.title, ev.author, ev.titleAssociation, me);
  const head = `${ev.repo}#${ev.number ?? "?"} ${ev.type}${ev.action ? `/${ev.action}` : ""} (${router.intent}): ${title}`;
  const text = ev.text.trim();
  if (!text || router.path === "hot-ci") return head;
  return `${head}\n\n${markIfUntrusted(text.slice(0, 1000), ev.textAuthor, ev.textAssociation, me)}`;
}

async function deliver(deps: RouterDeps, ev: GitHubEvent, router: RouterInfo, result: RouteResult): Promise<void> {
  const payload = buildPayload(ev, router, deps.config.login);
  await deps.dispatch(payload, router.slug);
  result.dispatched.push({ slug: router.slug, payload });
  if (deps.inbox) {
    try {
      deps.inbox({ sender: ev.sender || "github", content: inboxContent(ev, router, deps.config.login), sessionKey: router.slug });
    } catch (err) {
      deps.log(`inbox: could not record ${router.ref}: ${(err as Error).message}`);
    }
  }
}

/**
 * Deterministic join for an untracked ref: the topic of a tracked issue or PR
 * this item names with a keyword. Closing keywords and (for PRs)
 * closingIssuesReferences come first, then loose references such as
 * "Refs #n" or "Part of #n". A bare "#n" is left to the classifier.
 */
async function referenceJoin(deps: RouterDeps, ev: GitHubEvent): Promise<{ slug: string; via: string } | null> {
  if (ev.number === null) return null;
  const text = itemText(ev);
  const pick = (refs: string[], via: string) => {
    for (const ref of refs) {
      if (ref === ev.ref) continue;
      const slug = deps.ledger.lookup(ref);
      if (slug) {
        deps.log(`join: ${ev.ref} references tracked ${ref} (${via}) → '${slug}'`);
        return { slug, via };
      }
    }
    return null;
  };
  const closing = pick(closingRefsInText(text, ev.repo), "closing-ref");
  if (closing) return closing;
  if (ev.kind === "pr") {
    try {
      const linked = pick(await deps.github.closingIssues(ev.repo, ev.number), "closing-ref");
      if (linked) return linked;
    } catch (err) {
      deps.log(`join: closingIssuesReferences lookup failed for ${ev.ref}: ${(err as Error).message}`);
    }
  }
  return pick(looseRefsInText(text, ev.repo), "loose-ref");
}

async function resolveColdSlug(deps: RouterDeps, ev: GitHubEvent): Promise<{ slug: string; title: string; notes: string | null; via: string }> {
  const fallback = defaultSlug(ev);
  const joined = await referenceJoin(deps, ev);
  if (joined) return { slug: joined.slug, title: ev.title, notes: null, via: joined.via };
  try {
    const topics = deps.ledger.topics({ repo: ev.repo, limit: 60 });
    const answer = await classify(ev, {
      backend: deps.backend,
      model: deps.config.routerModel,
      timeoutMs: deps.config.routerTimeoutMs,
      topics,
      fallbackSlug: fallback,
      exists: (slug) => deps.ledger.hasTopic(slug),
      me: deps.config.login,
    });
    return { slug: answer.slug, title: answer.title, notes: answer.notes, via: answer.is_new ? "classifier:new" : "classifier:join" };
  } catch (err) {
    deps.log(`ERROR cold: classifier failed for ${ev.ref}, using default slug '${fallback}': ${(err as Error).message}`);
    return { slug: fallback, title: ev.title, notes: null, via: "default" };
  }
}

async function routeCi(deps: RouterDeps, ev: GitHubEvent, result: RouteResult): Promise<RouteResult> {
  const run = extractCi(ev);
  if (ev.action !== "completed") return { ...result, path: `skip:ci-${ev.action || "pending"}` };
  if (!CI_FAILURE_CONCLUSIONS.has(run.conclusion)) return { ...result, path: `skip:ci-${run.conclusion || "no-conclusion"}` };
  if (!run.pulls.length) return { ...result, path: "skip:ci-no-pr" };
  for (const pull of run.pulls) {
    const slug = deps.ledger.lookup(pull.ref);
    if (!slug) {
      deps.log(`skip: CI '${run.name}' failed on untracked ${pull.ref}`);
      continue;
    }
    let head: string | null = null;
    try {
      head = await deps.github.prHeadSha(ev.repo, pull.number);
    } catch (err) {
      deps.log(`hot-ci: head sha lookup failed for ${pull.ref}, using the payload's: ${(err as Error).message}`);
    }
    head ||= pull.headSha;
    if (run.headSha && head && head !== run.headSha) {
      deps.log(`skip: CI '${run.name}' on ${pull.ref} ran on ${run.headSha.slice(0, 7)}, PR head is ${head.slice(0, 7)} (superseded)`);
      continue;
    }
    const router: RouterInfo = {
      slug, ref: pull.ref, event_type: ev.type, action: ev.action, path: "hot-ci", intent: "engage",
      ci: { name: run.name, conclusion: run.conclusion, head_sha: run.headSha, url: run.url },
    };
    // The CI title is generated here, not foreign text; attribute it to the
    // bot itself so it is never wrapped as untrusted content.
    await deliver(deps, { ...ev, number: pull.number, ref: pull.ref, title: `CI ${run.name}: ${run.conclusion}`, author: deps.config.login }, router, result);
    deps.ledger.touch(slug);
    deps.log(`hot-ci: ${pull.ref} '${run.name}' ${run.conclusion} → '${slug}'`);
  }
  const first = result.dispatched[0];
  return first
    ? { ...result, path: "hot-ci", slug: first.slug, ref: run.pulls.map((p) => p.ref).join(",") }
    : { ...result, path: "skip:ci-untracked-or-superseded" };
}

/** A "Comment" review without a summary: a single inline comment or a reply wrapper. */
function isBareCommentReview(ev: GitHubEvent): boolean {
  return (ev.body.review?.state ?? "").toLowerCase() === "commented" && !(ev.body.review?.body ?? "").trim();
}

/** Lazily fetches a review's inline comments once; null when unavailable. */
function reviewCommentsOnce(deps: RouterDeps, ev: GitHubEvent) {
  let cached: Promise<{ body: string; inReplyTo: boolean }[] | null> | null = null;
  return () => {
    const reviewId = ev.body.review?.id;
    if (ev.type !== "pull_request_review" || typeof reviewId !== "number" || ev.number === null) return Promise.resolve(null);
    cached ??= deps.github.reviewComments(ev.repo, ev.number, reviewId).catch((err) => {
      deps.log(`review comments lookup failed for ${ev.ref} review ${reviewId}: ${(err as Error).message}`);
      return null;
    });
    return cached;
  };
}

async function routeItem(deps: RouterDeps, ev: GitHubEvent, result: RouteResult): Promise<RouteResult> {
  const me = deps.config.login;
  const ref = ev.ref!;
  result.ref = ref;

  if (NOISE_ACTIONS.has(ev.action)) return { ...result, path: `skip:noise-${ev.action}` };
  if (ev.action === "edited" && EDIT_SKIPPED_EVENTS.has(ev.type)) return { ...result, path: "skip:edited" };
  // One wake per review: the pull_request_review event covers its inline
  // comments. Thread replies keep their own review-comment event; GitHub also
  // wraps each reply in a body-less review, which is skipped further down.
  if (ev.type === "pull_request_review_comment" && ev.action === "created" && !ev.body.comment?.in_reply_to_id) {
    return { ...result, path: "skip:review-comment" };
  }

  // Closed: the session hears it once, then the ref leaves the ledger.
  if ((ev.type === "issues" || ev.type === "pull_request") && ev.action === "closed") {
    const slug = deps.ledger.lookup(ref);
    if (!slug) return { ...result, path: "closed-untracked" };
    if (ev.sender !== me) {
      await deliver(deps, ev, { slug, ref, event_type: ev.type, action: ev.action, path: "closing", intent: "engage" }, result);
    }
    const { topicDropped } = deps.ledger.unlink(ref);
    deps.log(`closing: ${ref} → '${slug}'${ev.sender === me ? " (closed by me, not notified)" : " notified"}, ref dropped${topicDropped ? ", topic dropped" : ""}`);
    return { ...result, path: "closing", slug };
  }

  // Unassigned, also by itself: the login is no longer responsible.
  if ((ev.type === "issues" || ev.type === "pull_request") && ev.action === "unassigned") {
    if ((ev.body.assignee?.login ?? "").toLowerCase() !== me) return { ...result, path: "skip:unassigned-other" };
    const { slug, topicDropped } = deps.ledger.unlink(ref);
    deps.log(`unassigned: ${ref} dropped${slug ? ` from '${slug}'` : " (was not tracked)"}${topicDropped ? ", topic dropped" : ""}`);
    return { ...result, path: "unassigned", slug };
  }

  if (ev.sender === me) {
    // A PR the worker opened: bind it to the topic it references, silently.
    if (ev.type === "pull_request" && AUTOLINK_ACTIONS.has(ev.action) && !deps.ledger.lookup(ref)) {
      const joined = await referenceJoin(deps, ev);
      if (joined) {
        const slug = deps.ledger.bind(ref, joined.slug, ev.title);
        deps.log(`autolink: own PR ${ref} → '${slug}' (via=${joined.via}), no session woken`);
        return { ...result, path: "autolink", slug };
      }
    }
    return { ...result, path: "skip:self" };
  }

  const comments = reviewCommentsOnce(deps, ev);
  if (ev.type === "pull_request_review" && ev.action === "submitted" && isBareCommentReview(ev)) {
    // Lookup failed or mixed comments: deliver; a possible double beats a loss.
    const list = await comments();
    if (list?.length && list.every((c) => c.inReplyTo)) return { ...result, path: "skip:review-replies" };
  }

  // PR assignment means "responsible", not "start working": register only.
  const prAssignedToMe = ev.type === "pull_request" && ev.action === "assigned" && (ev.body.assignee?.login ?? "").toLowerCase() === me;

  let slug = deps.ledger.lookup(ref);
  let path: "hot" | "cold";
  if (slug) {
    if (prAssignedToMe) return { ...result, path: "skip:pr-assigned-tracked", slug };
    path = "hot";
    deps.ledger.touch(slug);
  } else {
    let reason = involvement(ev, me);
    if (!reason && ev.type === "pull_request_review" && (await comments())?.some((c) => mentions(c.body, me))) reason = "mention";
    if (!reason) return { ...result, path: "skip:not-involved" };
    if (ev.type === "pull_request" && (reason === "assigned" || reason === "assignee")) {
      const target = (await referenceJoin(deps, ev))?.slug ?? defaultSlug(ev);
      slug = deps.ledger.bind(ref, target, ev.title, "PR assigned; idle until someone asks for something");
      deps.log(`register: ${ref} → '${slug}' (PR assigned, no session started)`);
      return { ...result, path: "register", slug };
    }
    const resolved = await resolveColdSlug(deps, ev);
    slug = deps.ledger.bind(ref, resolved.slug, resolved.title, resolved.notes);
    if (slug !== resolved.slug) deps.log(`cold: ${ref} resolved to '${resolved.slug}' but a concurrent delivery bound '${slug}' first; adopting it`);
    deps.log(`cold: ${ref} → '${slug}' (reason=${reason}, via=${resolved.via})`);
    path = "cold";
  }

  const intent = intentFor(ev, me);
  await deliver(deps, ev, { slug, ref, event_type: ev.type, action: ev.action, path, intent }, result);
  deps.log(`${path}/${intent}: ${ref} ${ev.type}/${ev.action} → '${slug}'`);

  const node = reactionTarget(ev);
  if (node) {
    try {
      await deps.github.addReaction(node);
    } catch (err) {
      deps.log(`reaction failed on ${ref}: ${(err as Error).message}`);
    }
  }
  return { ...result, path, slug, intent };
}

export async function routeEvent(envelope: Envelope, deps: RouterDeps): Promise<RouteResult> {
  const ev = extractEvent(envelope);
  const base: RouteResult = { path: "skip:unknown", dispatched: [] };
  const done = (result: RouteResult) => {
    if (result.path.startsWith("skip:")) deps.log(`${result.path}: ${ev.ref ?? ev.repo} ${ev.type}/${ev.action} (delivery ${ev.delivery || "-"})`);
    return result;
  };

  if (!ev.type) return done({ ...base, path: "skip:no-event-header" });
  if (ev.type === "ping") return done({ ...base, path: "skip:ping" });
  if (!ACTIONABLE_EVENTS.has(ev.type) && !CI_EVENTS.has(ev.type)) return done({ ...base, path: "skip:event-type" });
  if (!repoAllowed(ev.repo, deps.config.repos)) return done({ ...base, path: "skip:repo-not-allowed" });
  if (!CI_EVENTS.has(ev.type) && !ev.ref) return done({ ...base, path: "skip:no-ref" });

  if (!deps.ledger.claim(ev.delivery, ev.type, ev.action)) return done({ ...base, path: "skip:duplicate" });
  let result: RouteResult;
  try {
    result = CI_EVENTS.has(ev.type) ? await routeCi(deps, ev, base) : await routeItem(deps, ev, base);
  } catch (err) {
    deps.ledger.release(ev.delivery);
    throw err;
  }
  deps.ledger.record(ev.delivery, {
    ref: result.ref ?? ev.ref, slug: result.slug ?? null, type: ev.type, action: ev.action,
    path: result.intent ? `${result.path}:${result.intent}` : result.path,
  });
  return done(result);
}

