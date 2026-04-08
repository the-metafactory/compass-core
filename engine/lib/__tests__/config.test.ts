/**
 * Tests for engine/lib/config.ts — the compass.config.yaml loader.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findConfigPath, loadConfig } from "../config.ts";

let tmp: string;
const origCwd = process.cwd();
const origEnv = process.env.COMPASS_CONFIG;

beforeEach(() => {
  // realpathSync because macOS returns /var/folders/... but resolves to /private/var/folders/...
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "compass-config-test-")));
  delete process.env.COMPASS_CONFIG;
});

afterEach(() => {
  process.chdir(origCwd);
  if (origEnv === undefined) delete process.env.COMPASS_CONFIG;
  else process.env.COMPASS_CONFIG = origEnv;
  rmSync(tmp, { recursive: true, force: true });
});

describe("findConfigPath", () => {
  test("returns null when no config exists anywhere", () => {
    process.chdir(tmp);
    expect(findConfigPath()).toBeNull();
  });

  test("finds compass.config.yaml in cwd", () => {
    const p = join(tmp, "compass.config.yaml");
    writeFileSync(p, "schema: compass-config/v1\n");
    process.chdir(tmp);
    expect(findConfigPath()).toBe(p);
  });

  test("explicit configPath wins over cwd", () => {
    const cwdConfig = join(tmp, "compass.config.yaml");
    writeFileSync(cwdConfig, "schema: cwd\n");
    const explicit = join(tmp, "other.yaml");
    writeFileSync(explicit, "schema: explicit\n");
    process.chdir(tmp);
    expect(findConfigPath({ configPath: explicit })).toBe(explicit);
  });

  test("COMPASS_CONFIG env var has highest precedence", () => {
    const cwdConfig = join(tmp, "compass.config.yaml");
    writeFileSync(cwdConfig, "schema: cwd\n");
    const envPath = join(tmp, "from-env.yaml");
    writeFileSync(envPath, "schema: env\n");
    process.env.COMPASS_CONFIG = envPath;
    process.chdir(tmp);
    expect(findConfigPath({ configPath: cwdConfig })).toBe(envPath);
  });

  test("walks up from `near` to find config in ancestor dir", () => {
    const nested = join(tmp, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    const ancestorConfig = join(tmp, "a", "compass.config.yaml");
    writeFileSync(ancestorConfig, "schema: ancestor\n");
    const target = join(nested, "CLAUDE.md");
    writeFileSync(target, "# CLAUDE.md\n");
    // Use a separate cwd that has no config
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "elsewhere-")));
    try {
      process.chdir(elsewhere);
      expect(findConfigPath({ near: target })).toBe(ancestorConfig);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("loadConfig", () => {
  test("returns null when no config file is found", () => {
    process.chdir(tmp);
    expect(loadConfig()).toBeNull();
  });

  test("parses a valid config and returns the structured object", () => {
    const yaml = `
schema: compass-config/v1
org:
  name: acme-corp
  display_name: Acme
validators:
  claude_md:
    enabled: true
    required_sections:
      - Architecture
      - Critical Rules
labels:
  required:
    types:
      - bug
      - feature
    priorities:
      - now
      - next
`;
    writeFileSync(join(tmp, "compass.config.yaml"), yaml);
    process.chdir(tmp);
    const cfg = loadConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.org?.name).toBe("acme-corp");
    expect(cfg!.org?.display_name).toBe("Acme");
    expect(cfg!.validators?.claude_md?.enabled).toBe(true);
    expect(cfg!.validators?.claude_md?.required_sections).toEqual([
      "Architecture",
      "Critical Rules",
    ]);
    expect(cfg!.labels?.required?.types).toEqual(["bug", "feature"]);
    expect(cfg!.labels?.required?.priorities).toEqual(["now", "next"]);
  });

  test("throws on a YAML file that is not an object", () => {
    writeFileSync(join(tmp, "compass.config.yaml"), "- just\n- a\n- list\n");
    process.chdir(tmp);
    // YAML lists do parse to an object (array), so this should NOT throw — instead test scalar
    rmSync(join(tmp, "compass.config.yaml"));
    writeFileSync(join(tmp, "compass.config.yaml"), "scalar string\n");
    expect(() => loadConfig()).toThrow();
  });

  test("preserves the extensions block as opaque", () => {
    const yaml = `
schema: compass-config/v1
extensions:
  new_repo:
    script: scripts/extra.sh
    steps:
      - "Apply SAML"
  registry:
    repo: my-org/registry
    file: REGISTRY.yaml
`;
    writeFileSync(join(tmp, "compass.config.yaml"), yaml);
    process.chdir(tmp);
    const cfg = loadConfig();
    expect(cfg?.extensions).toBeDefined();
    const ext = cfg!.extensions as Record<string, any>;
    expect(ext.new_repo?.script).toBe("scripts/extra.sh");
    expect(ext.new_repo?.steps).toEqual(["Apply SAML"]);
    expect(ext.registry?.repo).toBe("my-org/registry");
  });
});
