#!/usr/bin/env bun
/**
 * Routes one GitHub webhook envelope read from stdin. The ingress trigger's
 * filter.sh runs `bun /atlas/app/triggers/github/route.ts`.
 *
 * Always exits non-zero so the ingress trigger never starts a session of its
 * own: 1 handled or skipped, 2 not configured, 3 error.
 */
import { resolveConfig } from "../../lib/config.ts";
import { parseEnvelope } from "./events.ts";
import { createClassifierBackend } from "./classifier.ts";
import { Ledger } from "./ledger.ts";
import { routeEvent } from "./router.ts";
import { createLogger, dispatchWorker, ghApi, writeInbox } from "./runtime.ts";

/** A model name, or the value of models.<key> when it names one. */
function resolveRouterModel(config: ReturnType<typeof resolveConfig>): string {
  const wanted = config.github.router_model || "haiku";
  return config.models[wanted] || wanted;
}

async function main(): Promise<number> {
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
  let ledger: Ledger;
  try {
    ledger = new Ledger();
  } catch (err) {
    log(`ERROR ledger: cannot open: ${(err as Error).message}`);
    return 3;
  }
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

if (import.meta.main) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err);
    process.exit(3);
  });
}
