/**
 * Tests for engine/validators/claude-md-check.ts.
 *
 * Spawns the validator as a subprocess so we exercise the real CLI surface
 * (argv parsing, exit codes, config-loader integration).
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const VALIDATOR = resolve(import.meta.dir, "..", "claude-md-check.ts");

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "claude-md-check-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string> = {}): RunResult {
  const proc = Bun.spawnSync(["bun", VALIDATOR, ...args], {
    env: { ...process.env, ...env, COMPASS_CONFIG: env.COMPASS_CONFIG ?? "" },
    cwd: tmp,
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

describe("claude-md-check.ts — default sections", () => {
  test("passes when CLAUDE.md has both default sections", () => {
    const claude = join(tmp, "CLAUDE.md");
    writeFileSync(
      claude,
      "# Test\n\n## Critical Rules\n- foo\n\n## Standard Operating Procedures\n- bar\n",
    );
    const r = run([claude]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("source: default");
  });

  test("fails when CLAUDE.md is missing a default section", () => {
    const claude = join(tmp, "CLAUDE.md");
    writeFileSync(claude, "# Test\n\n## Critical Rules\n- foo\n");
    const r = run([claude]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Standard Operating Procedures");
  });
});

describe("claude-md-check.ts — config-driven sections", () => {
  test("uses validators.claude_md.required_sections from compass.config.yaml", () => {
    const claude = join(tmp, "CLAUDE.md");
    writeFileSync(claude, "# Test\n\n## Architecture\n- foo\n\n## Naming\n- bar\n");
    const cfg = join(tmp, "compass.config.yaml");
    writeFileSync(
      cfg,
      "schema: compass-config/v1\nvalidators:\n  claude_md:\n    enabled: true\n    required_sections:\n      - Architecture\n      - Naming\n",
    );
    const r = run([claude, "--config", cfg]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("source: compass.config.yaml");
  });

  test("config-driven check fails when section missing from CLAUDE.md", () => {
    const claude = join(tmp, "CLAUDE.md");
    writeFileSync(claude, "# Test\n\n## Critical Rules\n- foo\n");
    const cfg = join(tmp, "compass.config.yaml");
    writeFileSync(
      cfg,
      "schema: compass-config/v1\nvalidators:\n  claude_md:\n    required_sections:\n      - Critical Rules\n      - Architecture\n",
    );
    const r = run([claude, "--config", cfg]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Architecture");
    expect(r.stderr).toContain("source: compass.config.yaml");
  });

  test("validators.claude_md.enabled=false skips with exit 0", () => {
    const claude = join(tmp, "CLAUDE.md");
    writeFileSync(claude, "# Empty\n");
    const cfg = join(tmp, "compass.config.yaml");
    writeFileSync(cfg, "schema: compass-config/v1\nvalidators:\n  claude_md:\n    enabled: false\n");
    const r = run([claude, "--config", cfg]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("skipping");
  });

  test("section heading match is case-insensitive", () => {
    const claude = join(tmp, "CLAUDE.md");
    writeFileSync(claude, "# Test\n\n## critical rules\n- foo\n\n## standard operating procedures\n- bar\n");
    const r = run([claude]);
    expect(r.exitCode).toBe(0);
  });
});
