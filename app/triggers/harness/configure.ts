#!/usr/bin/env bun
/**
 * Write the configured harness backend's configuration for this deployment
 * (HarnessBackend.configure: hooks, permissions, plugins, skill and agent
 * locations). Run by init.sh on every container start and by the web-ui
 * after config changes.
 */
import { createHarnessBackend } from "./registry.ts";

const backend = createHarnessBackend();
for (const line of backend.configure()) console.log(`  ${line}`);
console.log(`  Harness configured: ${backend.id}`);
