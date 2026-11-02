/**
 * Pure GitHub webhook parsing: refs, involvement, intents, CI details.
 * No I/O here; router.ts decides what to do with the results.
 */

/** Issue and PR activity that can start or continue a topic. */
export const ACTIONABLE_EVENTS = new Set([
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
]);

/** CI events. They only ever attach to a PR that is already tracked. */
export const CI_EVENTS = new Set(["check_run", "check_suite", "workflow_run"]);

/** Conclusions worth waking a PR session for. Success and neutral are noise. */
export const CI_FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

/** Actions that never need an agent, whoever is involved. */
export const NOISE_ACTIONS = new Set([
  "deleted", "locked", "unlocked", "pinned", "unpinned", "milestoned", "demilestoned", "transferred",
]);

export type Intent = "review" | "implement" | "engage";
export type RefKind = "issue" | "pr";

/** The webhook envelope as the SSE listener and the direct route deliver it. */
export interface Envelope {
  body: any;
  headers: Record<string, string>;
}

export interface GitHubEvent {
  type: string;
  delivery: string;
  action: string;
  /** "owner/repo" as GitHub spells it. */
  repo: string;
  number: number | null;
  /** Ledger key: lower-case "owner/repo#n". */
  ref: string | null;
  kind: RefKind;
  title: string;
  /** Body of the comment, review, issue or PR that caused the event. */
  text: string;
  /** Lower-case login of the issue/PR author. */
  author: string;
  /** Lower-case login of whoever caused the event. */
  sender: string;
  /** The issue or PR object (whichever the event carries). */
  item: any;
  body: any;
}

const lower = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : "");
const login = (user: any) => lower(user?.login);

/** Lower-case "owner/repo#n", the one spelling the ledger uses. */
export function formatRef(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

/**
 * Accepts the listener envelope `{body, headers, query, ...}` (body may be a
 * JSON string) and returns null for anything else.
 */
export function parseEnvelope(raw: string): Envelope | null {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || !data.headers || typeof data.headers !== "object") return null;
  let body = data.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!body || typeof body !== "object") return null;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(data.headers)) {
    if (typeof value === "string") headers[key.toLowerCase()] = value;
  }
  return { body, headers };
}

export function extractEvent(envelope: Envelope): GitHubEvent {
  const { body, headers } = envelope;
  const type = headers["x-github-event"] ?? "";
  const repo: string = body.repository?.full_name ?? "";
  const pr = body.pull_request ?? null;
  const issue = body.issue ?? null;
  const item = pr ?? issue ?? {};
  const number: number | null = typeof item.number === "number" ? item.number : null;
  // A comment on a PR arrives as issue_comment with issue.pull_request set.
  const kind: RefKind = pr || issue?.pull_request ? "pr" : "issue";

  let text = "";
  if (type === "issue_comment" || type === "pull_request_review_comment") text = body.comment?.body ?? "";
  else if (type === "pull_request_review") text = body.review?.body ?? "";
  else text = item.body ?? "";

  return {
    type,
    delivery: headers["x-github-delivery"] ?? "",
    action: typeof body.action === "string" ? body.action : "",
    repo,
    number,
    ref: repo && number !== null ? formatRef(repo, number) : null,
    kind,
    title: item.title ?? "",
    text: text ?? "",
    author: login(item.user),
    sender: login(body.sender),
    item,
    body,
  };
}

/** Allowlist entries are "owner/repo" or "owner/*"; an empty list allows all. */
export function repoAllowed(repo: string, allowlist: string[]): boolean {
  if (!allowlist.length) return true;
  const name = repo.toLowerCase();
  const owner = name.split("/")[0];
  return allowlist.some((entry) => {
    const pattern = entry.trim().toLowerCase();
    return pattern === name || pattern === `${owner}/*`;
  });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "@my-bot" as a whole login: "@my-bot2" or "@my-bot-x" do not count. */
export function mentions(text: string, me: string): boolean {
  return new RegExp(`(^|[^\\w/])@${escapeRegExp(me)}(?![\\w-])`, "i").test(text);
}

export type Involvement = "mention" | "review_requested" | "assigned" | "assignee" | "author";

/**
 * Why `me` is involved in an event on an untracked ref, or null. Explicit asks
 * (mention, review request) come before passive signals (assignee, author).
 */
export function involvement(ev: GitHubEvent, me: string): Involvement | null {
  if (mentions(`${ev.title}\n${ev.text}`, me)) return "mention";
  if (ev.action === "review_requested" && login(ev.body.requested_reviewer) === me) return "review_requested";
  if ((ev.body.pull_request?.requested_reviewers ?? []).some((user: any) => login(user) === me)) return "review_requested";
  if (ev.action === "assigned" && login(ev.body.assignee) === me) return "assigned";
  if ((ev.item.assignees ?? []).some((user: any) => login(user) === me)) return "assignee";
  if (ev.author === me) return "author";
  return null;
}

/**
 * What the worker is asked to do. Runs on the hot path too, where involvement
 * was never checked, so each directive verifies that it names `me`.
 */
export function intentFor(ev: GitHubEvent, me: string): Intent {
  if (ev.action === "review_requested") {
    return login(ev.body.requested_reviewer) === me ? "review" : "engage";
  }
  if (ev.type === "issues" && ev.action === "assigned") {
    const assignedToMe = login(ev.body.assignee) === me;
    const isAssignee = (ev.item.assignees ?? []).some((user: any) => login(user) === me);
    return assignedToMe && isAssignee && ev.item.state === "open" ? "implement" : "engage";
  }
  return "engage";
}

/** Node ID of the comment or review that caused the event, for the reaction. */
export function reactionTarget(ev: GitHubEvent): string | null {
  if (ev.type === "issue_comment" || ev.type === "pull_request_review_comment") return ev.body.comment?.node_id ?? null;
  if (ev.type === "pull_request_review") return ev.body.review?.node_id ?? null;
  return null;
}

/** Lower-case kebab-case, at most `max` characters. */
export function slugify(text: string, max = 60): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, max).replace(/-+$/g, "") || "topic";
}

/** `<repo>-<issue|pr>-<n>-<title-slug>`, the slug when nothing better is known. */
export function defaultSlug(ev: Pick<GitHubEvent, "repo" | "kind" | "number" | "title">): string {
  const repo = ev.repo.split("/").pop() ?? "repo";
  return slugify(`${repo}-${ev.kind}-${ev.number}-${ev.title}`);
}

export interface CiRun {
  name: string;
  status: string;
  conclusion: string;
  headSha: string;
  url: string;
  /** Associated PRs: ledger ref plus the head sha the payload reports for it. */
  pulls: { ref: string; number: number; headSha: string }[];
}

export function extractCi(ev: GitHubEvent): CiRun {
  const node = ev.body[ev.type] ?? {};
  let pulls: any[] = node.pull_requests ?? [];
  if (!pulls.length && ev.type === "check_run") pulls = node.check_suite?.pull_requests ?? [];
  return {
    name: node.name ?? node.display_title ?? node.app?.name ?? ev.type,
    status: lower(node.status),
    conclusion: lower(node.conclusion),
    headSha: node.head_sha ?? "",
    url: node.html_url ?? node.details_url ?? "",
    pulls: ev.repo
      ? pulls.filter((p) => typeof p?.number === "number").map((p) => ({
        ref: formatRef(ev.repo, p.number),
        number: p.number,
        headSha: p.head?.sha ?? "",
      }))
      : [],
  };
}

/** `#n`, `owner/repo#n` or a full issue/PR URL; groups: repo, n | n | repo, n. */
const REF_FORM = String.raw`(?:([\w.-]+\/[\w.-]+)#(\d+)|#(\d+)|https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+))(?!\w)`;
/** GitHub's closing keywords. */
const CLOSING_KEYWORDS = String.raw`close[sd]?|fix(?:e[sd])?|resolve[sd]?`;
/** Explicit, non-closing references. A bare `#n` is not one of them. */
const LOOSE_KEYWORDS = String.raw`refs?|references?|part\s+of|relate[sd]\s+to|related\s+to|follow[\s-]?ups?\s+(?:to|of|on)|see(?:\s+also)?`;
const keywordRe = (keywords: string) => new RegExp(String.raw`\b(?:${keywords})\b:?\s+${REF_FORM}`, "gi");
const CLOSING_RE = keywordRe(CLOSING_KEYWORDS);
const LOOSE_RE = keywordRe(LOOSE_KEYWORDS);

function refsMatching(re: RegExp, text: string, repo: string): string[] {
  const refs = new Set<string>();
  for (const match of text.matchAll(re)) {
    const [, otherRepo, otherNumber, localNumber, urlRepo, urlNumber] = match;
    if (otherRepo && otherNumber) refs.add(formatRef(otherRepo, Number(otherNumber)));
    else if (localNumber) refs.add(formatRef(repo, Number(localNumber)));
    else if (urlRepo && urlNumber) refs.add(formatRef(urlRepo, Number(urlNumber)));
  }
  return [...refs];
}

/** Refs named with a closing keyword (closes/fixes/resolves #n), in text order. */
export function closingRefsInText(text: string, repo: string): string[] {
  return refsMatching(CLOSING_RE, text, repo);
}

/** Refs named with a non-closing keyword (refs, part of, related to, follow-up to, see #n). */
export function looseRefsInText(text: string, repo: string): string[] {
  return refsMatching(LOOSE_RE, text, repo);
}

/** Title and description of the issue or PR, whichever event carries it. */
export function itemText(ev: GitHubEvent): string {
  return `${ev.item.title ?? ""}\n${ev.item.body ?? ""}`;
}
