/**
 * Production dependencies of the router: gh lookups, worker dispatch through
 * trigger.sh, the Atlas inbox and the router log.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { openDb } from "../../lib/db.ts";
import { formatRef } from "./events.ts";
import type { GitHubApi, InboxEntry } from "./router.ts";

export const TRIGGER_SH = "/atlas/app/triggers/trigger.sh";
export const DEFAULT_LOG_PATH = "/atlas/logs/github-router.log";
const GH_TIMEOUT_MS = 15_000;

/**
 * Appends to the router log and stderr. The trigger runner discards a
 * filter's output, so the log file is where routing decisions are visible.
 */
export function createLogger(path = process.env.ATLAS_GITHUB_ROUTER_LOG || DEFAULT_LOG_PATH): (message: string) => void {
  let fileOk = true;
  return (message) => {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    process.stderr.write(line);
    if (!fileOk) return;
    try {
      appendFileSync(path, line);
    } catch (err) {
      fileOk = false;
      process.stderr.write(`[github-router] cannot write ${path}: ${(err as Error).message}\n`);
    }
  };
}

async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn([Bun.which("gh") ?? "gh", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), GH_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    if (code !== 0) throw new Error(`gh ${args[0]} ${args[1] ?? ""} exited ${code}: ${stderr.trim().slice(0, 300)}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

const CLOSING_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:20){nodes{number repository{nameWithOwner}}}}}}`;
const REACTION_MUTATION = `mutation($id:ID!){addReaction(input:{subjectId:$id,content:EYES}){reaction{content}}}`;

export const ghApi: GitHubApi = {
  async closingIssues(repo, number) {
    const [owner, name] = repo.split("/");
    const out = await gh(["api", "graphql", "-f", `query=${CLOSING_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`]);
    const nodes = JSON.parse(out)?.data?.repository?.pullRequest?.closingIssuesReferences?.nodes ?? [];
    return nodes
      .filter((n: any) => typeof n?.number === "number" && n.repository?.nameWithOwner)
      .map((n: any) => formatRef(n.repository.nameWithOwner, n.number));
  },
  async prHeadSha(repo, number) {
    const out = (await gh(["api", `repos/${repo}/pulls/${number}`, "--jq", ".head.sha"])).trim();
    return out || null;
  },
  async addReaction(nodeId) {
    await gh(["api", "graphql", "-f", `query=${REACTION_MUTATION}`, "-f", `id=${nodeId}`]);
  },
};

/** Starts the worker session for `slug` and returns without waiting for it. */
export function dispatchWorker(workerTrigger: string, payload: string, slug: string): void {
  const child = spawn("bash", [TRIGGER_SH, workerTrigger, payload, slug], { detached: true, stdio: "ignore" });
  child.unref();
}

/** One inbox row per dispatched event (Activity shows it under channel github). */
export function writeInbox(entry: InboxEntry): void {
  const db = openDb();
  try {
    db.prepare("INSERT INTO messages (channel, sender, content, session_key) VALUES ('github', ?, ?, ?)")
      .run(entry.sender, entry.content, entry.sessionKey);
  } finally {
    db.close();
  }
}
