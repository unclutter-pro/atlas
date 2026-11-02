import { beforeEach, describe, expect, test } from "bun:test";
import type { Conversation, ConversationEvent, ConversationRequest } from "../../lib/harness.ts";
import type { ConversationBackend } from "./classifier.ts";
import { closingRefsInText, defaultSlug, extractEvent, mentions, parseEnvelope, repoAllowed, type Envelope } from "./events.ts";
import { Ledger } from "./ledger.ts";
import { routeEvent, type GitHubApi, type InboxEntry, type RouterDeps } from "./router.ts";

const ME = "my-bot";
const REPO = "acme/webapp";
let deliveryCounter = 0;

function envelope(type: string, body: Record<string, unknown>, delivery = `d-${++deliveryCounter}`): Envelope {
  return {
    headers: { "x-github-event": type, "x-github-delivery": delivery },
    body: { repository: { full_name: REPO, html_url: `https://github.com/${REPO}`, owner: { login: "acme" } }, sender: { login: "alice" }, ...body },
  };
}

const user = (login: string) => ({ login });
const issue = (extra: Record<string, unknown> = {}) => ({ number: 42, title: "Login button broken", body: "It does nothing.", state: "open", user: user("alice"), assignees: [], ...extra });
const pr = (extra: Record<string, unknown> = {}) => ({ number: 43, title: "Fix login button", body: "", state: "open", user: user("alice"), assignees: [], requested_reviewers: [], head: { sha: "abc1234" }, ...extra });

/** A backend whose single turn answers `answer`, throws it, or never finishes. */
function fakeBackend(answer: string | Error | "hang") {
  const requests: ConversationRequest[] = [];
  const backend: ConversationBackend = {
    openConversation(request) {
      requests.push(request);
      let stopped = false;
      async function* events(): AsyncGenerator<ConversationEvent> {
        if (answer instanceof Error) throw answer;
        if (answer === "hang") {
          while (!stopped) await Bun.sleep(5);
          return;
        }
        yield {
          type: "turn.finished",
          result: { outcome: "completed", text: answer, error: null, session: null, turns: 1, durationMs: 1, usage: {} as any },
        };
      }
      const iterator = events();
      return {
        [Symbol.asyncIterator]: () => iterator,
        push: () => { throw new Error("single turn"); },
        interrupt: async () => {},
        stop: () => { stopped = true; },
      } as Conversation;
    },
  };
  return { backend, requests };
}

interface Harness {
  deps: RouterDeps;
  ledger: Ledger;
  logs: string[];
  dispatched: { payload: any; slug: string }[];
  inbox: InboxEntry[];
  reactions: string[];
  requests: ConversationRequest[];
}

function harness(options: { answer?: string | Error | "hang"; github?: Partial<GitHubApi>; repos?: string[] } = {}): Harness {
  const ledger = new Ledger(":memory:");
  const { backend, requests } = fakeBackend(options.answer ?? new Error("classifier must not be called"));
  const h: Harness = { ledger, logs: [], dispatched: [], inbox: [], reactions: [], requests, deps: undefined as any };
  h.deps = {
    config: { login: ME, repos: options.repos ?? [], routerModel: "haiku", routerTimeoutMs: 200 },
    ledger,
    backend,
    github: {
      closingIssues: async () => [],
      prHeadSha: async () => null,
      addReaction: async (id) => { h.reactions.push(id); },
      ...options.github,
    },
    dispatch: (payload, slug) => { h.dispatched.push({ payload: JSON.parse(payload), slug }); },
    inbox: (entry) => h.inbox.push(entry),
    log: (message) => h.logs.push(message),
  };
  return h;
}

let h: Harness;
beforeEach(() => { h = harness(); });

describe("events", () => {
  test("parseEnvelope accepts the listener shape and string bodies", () => {
    const parsed = parseEnvelope(JSON.stringify({ body: JSON.stringify({ action: "opened" }), headers: { "X-GitHub-Event": "issues" }, query: {} }));
    expect(parsed?.body.action).toBe("opened");
    expect(parsed?.headers["x-github-event"]).toBe("issues");
    expect(parseEnvelope('{"action":"opened"}')).toBeNull();
    expect(parseEnvelope("not json")).toBeNull();
  });

  test("mentions match the whole login only", () => {
    expect(mentions("cc @My-Bot please", ME)).toBe(true);
    expect(mentions("@my-bot2 and @my-bot-x", ME)).toBe(false);
    expect(mentions("mail me at x@my-bot", ME)).toBe(false);
  });

  test("repo allowlist supports owner wildcards", () => {
    expect(repoAllowed("Acme/WebApp", [])).toBe(true);
    expect(repoAllowed("acme/webapp", ["acme/*"])).toBe(true);
    expect(repoAllowed("acme/webapp", ["acme/api"])).toBe(false);
  });

  test("closing keywords resolve local, cross-repo and URL refs", () => {
    expect(closingRefsInText("Fixes #12, closes acme/api#3 and resolves https://github.com/acme/web/issues/9. Mentions #4.", REPO))
      .toEqual(["acme/webapp#12", "acme/api#3", "acme/web#9"]);
  });

  test("default slug and ref spelling", () => {
    const ev = extractEvent(envelope("issues", { action: "opened", issue: issue() }));
    expect(ev.ref).toBe("acme/webapp#42");
    expect(defaultSlug(ev)).toBe("webapp-issue-42-login-button-broken");
  });
});

describe("skip rules", () => {
  test("non-actionable events, ping and missing headers are skipped", async () => {
    expect((await routeEvent(envelope("push", { ref: "refs/heads/main" }), h.deps)).path).toBe("skip:event-type");
    expect((await routeEvent(envelope("ping", {}), h.deps)).path).toBe("skip:ping");
    expect((await routeEvent({ headers: {}, body: {} }, h.deps)).path).toBe("skip:no-event-header");
    expect(h.dispatched).toHaveLength(0);
  });

  test("events where the login is not involved are skipped", async () => {
    const result = await routeEvent(envelope("issues", { action: "opened", issue: issue() }), h.deps);
    expect(result.path).toBe("skip:not-involved");
    expect(h.ledger.lookup("acme/webapp#42")).toBeNull();
  });

  test("own actions are skipped, even on tracked refs", async () => {
    h.ledger.bind("acme/webapp#42", "login-bug", "Login");
    const result = await routeEvent(envelope("issue_comment", { action: "created", issue: issue(), comment: { body: "done", node_id: "C1" }, sender: user("My-Bot") }), h.deps);
    expect(result.path).toBe("skip:self");
    expect(h.dispatched).toHaveLength(0);
  });

  test("repositories outside the allowlist are skipped", async () => {
    h = harness({ repos: ["other/*"] });
    const result = await routeEvent(envelope("issues", { action: "opened", issue: issue({ body: "@my-bot help" }) }), h.deps);
    expect(result.path).toBe("skip:repo-not-allowed");
  });

  test("noise actions are skipped on tracked refs", async () => {
    h.ledger.bind("acme/webapp#42", "login-bug", "Login");
    expect((await routeEvent(envelope("issue_comment", { action: "deleted", issue: issue(), comment: { body: "x" } }), h.deps)).path).toBe("skip:noise-deleted");
  });

  test("a delivery is processed once", async () => {
    h.ledger.bind("acme/webapp#42", "login-bug", "Login");
    const event = envelope("issue_comment", { action: "created", issue: issue(), comment: { body: "any news?" } }, "same-id");
    expect((await routeEvent(event, h.deps)).path).toBe("hot");
    expect((await routeEvent(event, h.deps)).path).toBe("skip:duplicate");
    expect(h.dispatched).toHaveLength(1);
  });

  test("a failed delivery releases its claim so a redelivery can retry", async () => {
    h.ledger.bind("acme/webapp#42", "login-bug", "Login");
    const event = envelope("issue_comment", { action: "created", issue: issue(), comment: { body: "x" } }, "retry-id");
    h.deps.dispatch = () => { throw new Error("spawn failed"); };
    await expect(routeEvent(event, h.deps)).rejects.toThrow("spawn failed");
    h.deps.dispatch = (payload, slug) => { h.dispatched.push({ payload: JSON.parse(payload), slug }); };
    expect((await routeEvent(event, h.deps)).path).toBe("hot");
  });
});

describe("hot and cold path", () => {
  test("a tracked ref goes to its topic without a model call", async () => {
    h.ledger.bind("acme/webapp#42", "login-bug", "Login");
    const result = await routeEvent(envelope("issue_comment", { action: "created", issue: issue(), comment: { body: "any news?", node_id: "C1" } }), h.deps);
    expect(result).toMatchObject({ path: "hot", slug: "login-bug", intent: "engage" });
    expect(h.requests).toHaveLength(0);
    expect(h.dispatched[0]!.slug).toBe("login-bug");
    expect(h.dispatched[0]!.payload._router).toEqual({ slug: "login-bug", ref: "acme/webapp#42", event_type: "issue_comment", action: "created", path: "hot", intent: "engage" });
    expect(h.dispatched[0]!.payload.body.repository).toEqual({ full_name: REPO, html_url: `https://github.com/${REPO}` });
    expect(h.reactions).toEqual(["C1"]);
    expect(h.inbox[0]).toMatchObject({ sender: "alice", sessionKey: "login-bug" });
  });

  test("a mention on an unseen ref asks the classifier and joins a same-repo topic", async () => {
    h = harness({ answer: 'Sure: {"slug":"login-bug","title":"Login","is_new":false,"notes":"auth"}' });
    h.ledger.bind("acme/webapp#40", "login-bug", "Login");
    h.ledger.bind("other/repo#1", "other-topic", "Other");
    const result = await routeEvent(envelope("issues", { action: "opened", issue: issue({ body: "@my-bot can you look?" }) }), h.deps);
    expect(result).toMatchObject({ path: "cold", slug: "login-bug" });
    expect(h.ledger.lookup("acme/webapp#42")).toBe("login-bug");
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ model: "haiku", turns: "single", ephemeral: true });
    expect(h.requests[0]!.prompt).toContain('"slug":"login-bug"');
    expect(h.requests[0]!.prompt).not.toContain("other-topic");
  });

  test("the classifier can open a new topic", async () => {
    h = harness({ answer: '{"slug":"Dark Mode","title":"Dark mode","is_new":true,"notes":"ui"}' });
    const result = await routeEvent(envelope("issues", { action: "opened", issue: issue({ title: "Dark mode", body: "@my-bot" }) }), h.deps);
    expect(result.slug).toBe("dark-mode");
    expect(h.ledger.topics()[0]).toMatchObject({ slug: "dark-mode", title: "Dark mode", notes: "ui" });
  });

  for (const [name, answer, reason] of [
    ["invalid JSON", "{slug: nope}", "invalid JSON"],
    ["no JSON", "I am not sure", "no JSON object"],
    ["a join of an unknown topic", '{"slug":"ghost","title":"x","is_new":false}', "unknown topic"],
    ["a backend error", new Error("authentication_failed: token expired"), "token expired"],
    ["a timeout", "hang", "timed out"],
  ] as const) {
    test(`${name} falls back to the default slug and logs why`, async () => {
      h = harness({ answer });
      const result = await routeEvent(envelope("issues", { action: "opened", issue: issue({ body: "@my-bot" }) }), h.deps);
      expect(result).toMatchObject({ path: "cold", slug: "webapp-issue-42-login-button-broken" });
      expect(h.logs.some((l) => l.startsWith("ERROR cold:") && l.includes(reason))).toBe(true);
      expect(h.requests).toHaveLength(1);
    });
  }

  test("a new slug that collides with another repository's topic is rejected", async () => {
    h = harness({ answer: '{"slug":"other-topic","title":"x","is_new":true}' });
    h.ledger.bind("other/repo#1", "other-topic", "Other");
    const result = await routeEvent(envelope("issues", { action: "opened", issue: issue({ body: "@my-bot" }) }), h.deps);
    expect(result.slug).toBe("webapp-issue-42-login-button-broken");
  });

  test("a PR that closes a tracked issue joins its topic without a model call", async () => {
    h.ledger.bind("acme/webapp#42", "login-bug", "Login");
    const result = await routeEvent(envelope("pull_request", {
      action: "review_requested", pull_request: pr({ body: "Fixes #42" }), requested_reviewer: user(ME),
    }), h.deps);
    expect(result).toMatchObject({ path: "cold", slug: "login-bug", intent: "review" });
    expect(h.ledger.topics()[0]!.refs).toEqual(["acme/webapp#42", "acme/webapp#43"]);
    expect(h.requests).toHaveLength(0);
  });

  test("closingIssuesReferences joins too, and its failure is only logged", async () => {
    h = harness({ github: { closingIssues: async () => ["acme/webapp#42"] } });
    h.ledger.bind("acme/webapp#42", "login-bug", "Login");
    const result = await routeEvent(envelope("pull_request", { action: "opened", pull_request: pr({ body: "@my-bot ptal" }) }), h.deps);
    expect(result.slug).toBe("login-bug");

    h = harness({ answer: '{"slug":"fix-login","title":"Fix","is_new":true}', github: { closingIssues: async () => { throw new Error("gh: 502"); } } });
    const fallback = await routeEvent(envelope("pull_request", { action: "opened", pull_request: pr({ body: "@my-bot ptal" }) }), h.deps);
    expect(fallback.slug).toBe("fix-login");
    expect(h.logs.some((l) => l.includes("gh: 502"))).toBe(true);
  });
});

describe("intents", () => {
  test("review only when the review is requested from the login", async () => {
    h.ledger.bind("acme/webapp#43", "fix-login", "Fix");
    await routeEvent(envelope("pull_request", { action: "review_requested", pull_request: pr(), requested_reviewer: user(ME) }), h.deps);
    await routeEvent(envelope("pull_request", { action: "review_requested", pull_request: pr(), requested_reviewer: user("carol") }), h.deps);
    expect(h.dispatched.map((d) => d.payload._router.intent)).toEqual(["review", "engage"]);
  });

  test("implement only for an open issue the login really is assigned to", async () => {
    const assigned = (extra: Record<string, unknown>, assignee = ME) =>
      routeEvent(envelope("issues", { action: "assigned", assignee: user(assignee), issue: issue(extra) }), h.deps);
    h.ledger.bind("acme/webapp#42", "login-bug", "Login");
    expect((await assigned({ assignees: [user(ME)] })).intent).toBe("implement");
    expect((await assigned({ assignees: [user(ME)], state: "closed" })).intent).toBe("engage");
    expect((await assigned({ assignees: [user("carol")] }, "carol")).intent).toBe("engage");
    expect((await assigned({ assignees: [] })).intent).toBe("engage");
  });

  test("an issue assigned to the login is a cold-path task", async () => {
    h = harness({ answer: '{"slug":"login-bug","title":"Login","is_new":true}' });
    const result = await routeEvent(envelope("issues", { action: "assigned", assignee: user(ME), issue: issue({ assignees: [user(ME)] }) }), h.deps);
    expect(result).toMatchObject({ path: "cold", slug: "login-bug", intent: "implement" });
  });

  test("a PR assigned to the login is registered without a session", async () => {
    const result = await routeEvent(envelope("pull_request", { action: "assigned", assignee: user(ME), pull_request: pr({ assignees: [user(ME)] }) }), h.deps);
    expect(result).toMatchObject({ path: "register", slug: "webapp-pr-43-fix-login-button" });
    expect(h.dispatched).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
    const again = await routeEvent(envelope("pull_request", { action: "assigned", assignee: user(ME), pull_request: pr({ assignees: [user(ME)] }) }), h.deps);
    expect(again.path).toBe("skip:pr-assigned-tracked");
  });

  test("unassigning the login drops the ref; unassigning others does not", async () => {
    h.ledger.bind("acme/webapp#42", "login-bug", "Login");
    expect((await routeEvent(envelope("issues", { action: "unassigned", assignee: user("carol"), issue: issue() }), h.deps)).path).toBe("skip:unassigned-other");
    expect(h.ledger.lookup("acme/webapp#42")).toBe("login-bug");
    expect((await routeEvent(envelope("issues", { action: "unassigned", assignee: user(ME), issue: issue() }), h.deps)).path).toBe("unassigned");
    expect(h.ledger.lookup("acme/webapp#42")).toBeNull();
    expect(h.dispatched).toHaveLength(0);
  });

  test("unassigning itself drops the ref too", async () => {
    h.ledger.bind("acme/webapp#43", "fix-login", "Fix");
    const result = await routeEvent(envelope("pull_request", { action: "unassigned", assignee: user(ME), pull_request: pr(), sender: user(ME) }), h.deps);
    expect(result.path).toBe("unassigned");
    expect(h.ledger.hasTopic("fix-login")).toBe(false);
  });
});

describe("closing", () => {
  test("a closed tracked ref notifies its session once, then leaves the ledger", async () => {
    h.ledger.bind("acme/webapp#42", "login-bug", "Login");
    h.ledger.bind("acme/webapp#43", "login-bug", "Login");
    const closed = () => routeEvent(envelope("issues", { action: "closed", issue: issue({ state: "closed" }) }), h.deps);
    expect((await closed()).path).toBe("closing");
    expect(h.dispatched[0]!.payload._router).toMatchObject({ path: "closing", slug: "login-bug" });
    expect(h.ledger.lookup("acme/webapp#42")).toBeNull();
    expect(h.ledger.hasTopic("login-bug")).toBe(true);
    expect((await closed()).path).toBe("closed-untracked");
    expect(h.dispatched).toHaveLength(1);

    await routeEvent(envelope("pull_request", { action: "closed", pull_request: pr({ state: "closed", merged: true }) }), h.deps);
    expect(h.dispatched).toHaveLength(2);
    expect(h.ledger.hasTopic("login-bug")).toBe(false);
  });

  test("closing it yourself drops the ref without waking the session", async () => {
    h.ledger.bind("acme/webapp#42", "login-bug", "Login");
    const result = await routeEvent(envelope("issues", { action: "closed", issue: issue({ state: "closed" }), sender: user(ME) }), h.deps);
    expect(result.path).toBe("closing");
    expect(h.dispatched).toHaveLength(0);
    expect(h.ledger.hasTopic("login-bug")).toBe(false);
  });
});

describe("CI", () => {
  const run = (conclusion: string, headSha = "abc1234", action = "completed") => envelope("workflow_run", {
    action,
    workflow_run: { name: "test", status: "completed", conclusion, head_sha: headSha, html_url: "https://github.com/acme/webapp/actions/runs/1", pull_requests: [{ number: 43, head: { sha: headSha } }] },
  });

  test("a failed run on the tracked PR's current head is dispatched", async () => {
    h = harness({ github: { prHeadSha: async () => "abc1234" } });
    h.ledger.bind("acme/webapp#43", "fix-login", "Fix");
    const result = await routeEvent(run("failure"), h.deps);
    expect(result).toMatchObject({ path: "hot-ci", slug: "fix-login" });
    expect(h.dispatched[0]!.payload._router).toMatchObject({ path: "hot-ci", intent: "engage", ci: { name: "test", conclusion: "failure", head_sha: "abc1234" } });
  });

  test("a run on a superseded commit is skipped", async () => {
    h = harness({ github: { prHeadSha: async () => "def5678" } });
    h.ledger.bind("acme/webapp#43", "fix-login", "Fix");
    expect((await routeEvent(run("failure"), h.deps)).path).toBe("skip:ci-untracked-or-superseded");
    expect(h.logs.some((l) => l.includes("superseded"))).toBe(true);
  });

  test("green, in-progress and untracked runs never dispatch or create topics", async () => {
    h.ledger.bind("acme/webapp#43", "fix-login", "Fix");
    expect((await routeEvent(run("success"), h.deps)).path).toBe("skip:ci-success");
    expect((await routeEvent(run("", "abc1234", "in_progress"), h.deps)).path).toBe("skip:ci-in_progress");
    h.ledger.unlink("acme/webapp#43");
    expect((await routeEvent(run("failure"), h.deps)).path).toBe("skip:ci-untracked-or-superseded");
    expect(h.ledger.topics()).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
  });

  test("check_run takes its PRs from the check suite", async () => {
    h = harness({ github: { prHeadSha: async () => "abc1234" } });
    h.ledger.bind("acme/webapp#43", "fix-login", "Fix");
    const result = await routeEvent(envelope("check_run", {
      action: "completed",
      check_run: { name: "lint", status: "completed", conclusion: "failure", head_sha: "abc1234", pull_requests: [], check_suite: { pull_requests: [{ number: 43, head: { sha: "abc1234" } }] } },
    }), h.deps);
    expect(result).toMatchObject({ path: "hot-ci", slug: "fix-login" });
    expect(h.dispatched[0]!.payload._router.ci.name).toBe("lint");
  });

  test("the payload's PR head is used when the live lookup fails", async () => {
    h = harness({ github: { prHeadSha: async () => { throw new Error("gh offline"); } } });
    h.ledger.bind("acme/webapp#43", "fix-login", "Fix");
    expect((await routeEvent(run("timed_out"), h.deps)).path).toBe("hot-ci");
  });
});

describe("payload", () => {
  test("an oversized body is replaced by a summary that keeps _router", async () => {
    h.ledger.bind("acme/webapp#42", "login-bug", "Login");
    await routeEvent(envelope("issue_comment", { action: "created", issue: issue({ body: "x".repeat(150_000) }), comment: { body: "see above" } }), h.deps);
    const payload = h.dispatched[0]!.payload;
    expect(JSON.stringify(payload).length).toBeLessThan(100_000);
    expect(payload._router).toMatchObject({ slug: "login-bug", path: "hot" });
    expect(payload.body).toBeUndefined();
    expect(payload.summary).toMatchObject({ repo: REPO, number: 42, text: "see above" });
  });
});

describe("ledger", () => {
  test("first binding wins; unlink drops the emptied topic", () => {
    const ledger = new Ledger(":memory:");
    expect(ledger.bind("acme/webapp#1", "a", "A")).toBe("a");
    expect(ledger.bind("acme/webapp#1", "b", "B")).toBe("a");
    expect(ledger.hasTopic("b")).toBe(false);
    expect(ledger.topics({ repo: "Acme/WebApp" }).map((t) => t.slug)).toEqual(["a"]);
    expect(ledger.unlink("acme/webapp#1")).toEqual({ slug: "a", topicDropped: true });
  });
});
