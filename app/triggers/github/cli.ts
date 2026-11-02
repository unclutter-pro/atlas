#!/usr/bin/env bun
/**
 * github — GitHub channel CLI (wrapper: app/bin/github).
 *
 *   github route                  Route one webhook event read from stdin (the
 *                                 ingress trigger's filter.sh). Always exits
 *                                 non-zero so the ingress trigger never starts
 *                                 a session of its own: 1 handled or skipped,
 *                                 2 not configured, 3 error.
 *   github topics [--json]        List ledger topics and their refs.
 *   github link <owner/repo#n> [slug]
 *                                 Bind a ref to a topic (default: this session's
 *                                 topic, $ATLAS_TRIGGER_SESSION_KEY).
 *   github unlink <owner/repo#n>  Remove a ref; drops its topic when empty.
 */
import { resolveConfig } from "../../lib/config.ts";
import { parseEnvelope, parseRef, slugify } from "./events.ts";
import { createClassifierBackend } from "./classifier.ts";
import { Ledger } from "./ledger.ts";
import { routeEvent } from "./router.ts";
import { createLogger, dispatchWorker, ghApi, writeInbox } from "./runtime.ts";

const USAGE = `Usage:
  github route                       Route a webhook event from stdin (ingress filter)
  github topics [--json]             List topics and their refs
  github link <owner/repo#n> [slug]  Bind a ref to a topic (default: $ATLAS_TRIGGER_SESSION_KEY)
  github unlink <owner/repo#n>       Remove a ref from the ledger`;

function die(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

function openLedger(log?: (message: string) => void): Ledger {
  try {
    return new Ledger();
  } catch (err) {
    const message = `ERROR ledger: cannot open: ${(err as Error).message}`;
    log?.(message);
    die(message, 3);
  }
}

/** A model name, or the value of models.<key> when it names one. */
function resolveRouterModel(config: ReturnType<typeof resolveConfig>): string {
  const wanted = config.github.router_model || "haiku";
  return config.models[wanted] || wanted;
}

async function route(): Promise<number> {
  const log = createLogger();
  const config = resolveConfig();
  const login = config.github.login.trim().toLowerCase();
  if (!login) {
    log("skip: github.login is not configured");
    return 2;
  }
  const envelope = parseEnvelope(await Bun.stdin.text());
  if (!envelope) {
    log("skip: stdin is not a webhook envelope ({body, headers})");
    return 1;
  }
  const ledger = openLedger(log);
  try {
    await routeEvent(envelope, {
      config: {
        login,
        repos: config.github.repos ?? [],
        routerModel: resolveRouterModel(config),
        routerTimeoutMs: Math.max(5, config.github.router_timeout_seconds || 60) * 1000,
      },
      ledger,
      github: ghApi,
      backend: createClassifierBackend(),
      dispatch: (payload, slug) => dispatchWorker(config.github.worker_trigger || "github-worker", payload, slug),
      inbox: writeInbox,
      log,
    });
    return 1;
  } catch (err) {
    log(`ERROR route: ${(err as Error).stack ?? err}`);
    return 3;
  } finally {
    ledger.close();
  }
}

function topics(json: boolean): number {
  const ledger = openLedger();
  try {
    const list = ledger.topics();
    if (json) console.log(JSON.stringify(list, null, 2));
    else if (!list.length) console.log("No topics.");
    else for (const t of list) {
      console.log(`${t.slug}  ${t.title}${t.notes ? `  — ${t.notes}` : ""}`);
      for (const ref of t.refs) console.log(`    ${ref}`);
    }
    return 0;
  } finally {
    ledger.close();
  }
}

function link(refArg: string | undefined, slugArg: string | undefined): number {
  const parsed = refArg ? parseRef(refArg) : null;
  if (!parsed) die(`link: expected <owner/repo#n>, got '${refArg ?? ""}'\n\n${USAGE}`);
  const raw = slugArg ?? process.env.ATLAS_TRIGGER_SESSION_KEY ?? "";
  if (!raw || raw === "_default") die("link: no slug given and no topic session ($ATLAS_TRIGGER_SESSION_KEY) to default to");
  const slug = slugify(raw);
  const ledger = openLedger();
  try {
    const { previous } = ledger.link(parsed.ref, slug);
    console.log(previous && previous !== slug ? `${parsed.ref}: moved from '${previous}' to '${slug}'` : `${parsed.ref} → '${slug}'`);
    return 0;
  } finally {
    ledger.close();
  }
}

function unlink(refArg: string | undefined): number {
  const parsed = refArg ? parseRef(refArg) : null;
  if (!parsed) die(`unlink: expected <owner/repo#n>, got '${refArg ?? ""}'\n\n${USAGE}`);
  const ledger = openLedger();
  try {
    const { slug, topicDropped } = ledger.unlink(parsed.ref);
    console.log(slug ? `${parsed.ref} removed from '${slug}'${topicDropped ? " (topic now empty, dropped)" : ""}` : `${parsed.ref} was not tracked`);
    return 0;
  } finally {
    ledger.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case "route": return route();
    case "topics": return topics(args.includes("--json"));
    case "link": return link(args[0], args[1]);
    case "unlink": return unlink(args[0]);
    case undefined: case "help": case "--help": case "-h":
      console.log(USAGE);
      return command ? 0 : 1;
    default:
      die(`Unknown command '${command}'\n\n${USAGE}`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(err);
    process.exit(3);
  });
}
