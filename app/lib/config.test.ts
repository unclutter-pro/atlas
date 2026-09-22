/**
 * Tests for config.ts resolution layering.
 * Uses Bun's built-in test runner.
 *
 * Run with: cd app/lib && bun test
 */

import { test, describe, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { resolveConfig, getConfigSource } from "./config.ts";

describe("resolveConfig models", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "atlas-config-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("keeps custom models.<key> entries from config.yml", () => {
    writeFileSync(join(tmpDir, "config.yml"), `
models:
  trigger: opus
  sonnet: claude-sonnet-4-6
  haiku: claude-haiku-4-5
`);
    const models = resolveConfig(tmpDir).models;
    expect(models.sonnet).toBe("claude-sonnet-4-6");
    expect(models.haiku).toBe("claude-haiku-4-5");
    expect(getConfigSource("models.sonnet")).toBe("file");
  });

  test("env-mapped model keys keep their own precedence", () => {
    writeFileSync(join(tmpDir, "config.yml"), `
models:
  cron: claude-sonnet-4-6
  custom: claude-haiku-4-5
`);
    process.env.ATLAS_MODEL_CRON = "claude-opus-4-8";
    try {
      const models = resolveConfig(tmpDir).models;
      expect(models.cron).toBe("claude-opus-4-8");
      expect(models.custom).toBe("claude-haiku-4-5");
    } finally {
      delete process.env.ATLAS_MODEL_CRON;
    }
  });

  test("runtime config overrides a custom key set in config.yml", () => {
    writeFileSync(join(tmpDir, "config.yml"), `
models:
  fast: claude-haiku-4-5
`);
    writeFileSync(
      join(tmpDir, ".atlas-runtime-config.json"),
      JSON.stringify({ models: { fast: "claude-sonnet-4-6" } }),
    );
    expect(resolveConfig(tmpDir).models.fast).toBe("claude-sonnet-4-6");
    expect(getConfigSource("models.fast")).toBe("runtime");
  });

  test("ignores non-string custom model values", () => {
    writeFileSync(join(tmpDir, "config.yml"), `
models:
  bogus:
    nested: value
`);
    expect(resolveConfig(tmpDir).models.bogus).toBeUndefined();
  });

  test("falls back to defaults when config.yml is absent", () => {
    const models = resolveConfig(tmpDir).models;
    expect(models.trigger).toBe("opus");
    expect(models.cron).toBe("sonnet");
  });
});
