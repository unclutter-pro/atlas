#!/usr/bin/env bun
/**
 * Write the configured harness backend's configuration for this deployment
 * (HarnessBackend.configure: hooks, permissions, plugins, skill and agent
 * locations) plus Atlas' own failure-handling env file.
 * Run by init.sh on every container start and by the web-ui after config changes.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig } from "../../lib/config.ts";
import { createHarnessBackend } from "./registry.ts";

const home = process.env.HOME ?? "/home/agent";
const config = resolveConfig(home);

writeFileSync(join(home, ".failure-env"), [
  `ATLAS_BACKOFF_INITIAL=${config.failure_handling.backoff_initial_seconds}`,
  `ATLAS_BACKOFF_MAX=${config.failure_handling.backoff_max_seconds}`,
  `ATLAS_NOTIFY_THRESHOLD_MINUTES=${config.failure_handling.notification_threshold_minutes}`,
  `ATLAS_NOTIFY_COMMAND=${JSON.stringify(config.failure_handling.notification_command)}`,
  "",
].join("\n"));

const backend = createHarnessBackend();
for (const line of backend.configure()) console.log(`  ${line}`);
console.log(`  Harness configured: ${backend.id}`);
