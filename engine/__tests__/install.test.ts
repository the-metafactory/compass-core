/**
 * Tests for engine/install.ts.
 *
 * Spawns the installer as a subprocess so we exercise the real CLI surface
 * (argv parsing, exit codes, stderr reasons, filesystem effects).
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const REPO = resolve(import.meta.dir, "..", "..");
const INSTALLER = join(REPO, "engine", "install.ts");

const BEGIN = "<!-- compass-core:begin -->";
const END = "<!-- compass-core:end -->";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "compass-install-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): RunResult {
  const proc = Bun.spawnSync(["bun", INSTALLER, ...args], {
    // COMPASS_CONFIG is cleared: the installer must read the TARGET's config,
    // never one leaked in from the ambient environment.
    env: { ...process.env, COMPASS_CONFIG: "" },
    cwd: tmp,
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

const FULL_CONFIG = `schema: compass-config/v1
org:
  name: acme-corp
  display_name: Acme
  default_license: MIT
  default_branch: trunk
features:
  id_prefix: F-
  branch_pattern: "feat/{id}-{slug}"
  worktree_pattern: "../{repo}-{slug}"
  commit_prefix: feat
labels:
  source: standards/labels.yaml
  required:
    types: [bug, feature]
    priorities: [now, next]
channels:
  team: "#eng-internal"
  public: "#community"
versioning:
  manifest: arc-manifest.yaml
  release_title_format: "{repo} v{version}"
`;

/** Same as FULL_CONFIG with the whole optional `channels` block omitted. */
const NO_CHANNELS_CONFIG = FULL_CONFIG.replace(
  /channels:\n(?:  .*\n)+/,
  "",
);

function target(configText: string | null = FULL_CONFIG): string {
  const dir = join(tmp, "project");
  mkdirSync(dir, { recursive: true });
  if (configText !== null) {
    writeFileSync(join(dir, "compass.config.yaml"), configText);
  }
  return dir;
}

/** Stable digest of every file under `dir`, keyed by relative path. */
function hashTree(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string, prefix: string) => {
    for (const entry of readdirSync(d).sort()) {
      const p = join(d, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(p).isDirectory()) walk(p, rel);
      else {
        h.update(rel);
        h.update("\0");
        h.update(readFileSync(p));
        h.update("\0");
      }
    }
  };
  walk(dir, "");
  return h.digest("hex");
}

describe("install.ts — argument and target validation", () => {
  test("exits nonzero with USAGE when no target directory is given", () => {
    const r = run([]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("USAGE");
  });

  test("exits nonzero when the target directory does not exist", () => {
    const r = run([join(tmp, "nope")]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("TARGET_NOT_A_DIRECTORY");
  });

  test("exits nonzero when the target is a file, not a directory", () => {
    const f = join(tmp, "afile");
    writeFileSync(f, "x");
    const r = run([f]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("TARGET_NOT_A_DIRECTORY");
  });
});

describe("install.ts — config discovery", () => {
  test("refuses to install with defaults when the target has no config", () => {
    const dir = target(null);
    const r = run([dir]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("CONFIG_NOT_FOUND");
    expect(r.stderr).toContain("compass.config.example.yaml");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("reports a schema-invalid config without writing anything", () => {
    const dir = target("schema: compass-config/v1\norg:\n  name: 42\n");
    const r = run([dir]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("CONFIG_INVALID");
    expect(readdirSync(dir)).toEqual(["compass.config.yaml"]);
  });

  test("fails naming the key when a required placeholder key is unset", () => {
    const dir = target("schema: compass-config/v1\nfeatures:\n  id_prefix: F-\n");
    const r = run([dir]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("UNRESOLVED_PLACEHOLDERS");
    expect(r.stderr).toContain("org.name");
    expect(readdirSync(dir)).toEqual(["compass.config.yaml"]);
  });
});

describe("install.ts — fresh install", () => {
  test("exits 0 and writes rendered SOPs plus a CLAUDE.md block", () => {
    const dir = target();
    const r = run([dir]);
    expect(r.exitCode).toBe(0);

    const sops = readdirSync(join(dir, "sops"));
    expect(sops.length).toBeGreaterThan(0);
    expect(sops).toContain("dev-pipeline.md");

    const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain(BEGIN);
    expect(claude).toContain(END);
    expect(claude).toContain("sops/dev-pipeline.md");
  });

  test("a rendered SOP carries the real value where the source had a placeholder", () => {
    const dir = target();
    run([dir]);

    const src = readFileSync(join(REPO, "sops", "dev-pipeline.md"), "utf8");
    expect(src).toContain("{{config:org.default_branch}}");

    const out = readFileSync(join(dir, "sops", "dev-pipeline.md"), "utf8");
    expect(out).toContain("trunk");
    expect(out).not.toContain("{{config:org.default_branch}}");
  });

  test("no rendered SOP sends the model back to compass.config.yaml for a value", () => {
    const dir = target();
    run([dir]);
    for (const f of readdirSync(join(dir, "sops"))) {
      const text = readFileSync(join(dir, "sops", f), "utf8");
      // The only {{config:...}} tokens allowed to survive are meta-references
      // to the grammar itself (`{{config:*}}`), never a real key path.
      const survivors = [...text.matchAll(/\{\{config:([^}]*)\}\}/g)].map((m) => m[1]);
      for (const s of survivors) {
        expect(s).not.toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
      }
    }
  });

  test("the block supplies the Standard Operating Procedures section, not Critical Rules", () => {
    const dir = target();
    run([dir]);
    const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("## Standard Operating Procedures");
    // Deliberate scope line for this cut (compass-core#17 criteria 1-4): the
    // installed block is the SOP activation table only. It does NOT supply
    // "## Critical Rules", which templates/CLAUDE.md.template does and which
    // the default validators.claude_md.required_sections asks for — so a repo
    // installed with the example config does not yet satisfy claude-md-check
    // on its own. Pinned here so the gap is visible rather than a surprise;
    // widening the block is a governance-content decision, not a code fix.
    expect(claude).not.toContain("## Critical Rules");
  });

  test("creates a CLAUDE.md containing only the block when none exists", () => {
    const dir = target();
    run([dir]);
    const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(claude.startsWith(BEGIN)).toBe(true);
    expect(claude.trimEnd().endsWith(END)).toBe(true);
  });

  test("writes nothing outside the target directory", () => {
    const before = hashTree(join(REPO, "sops"));
    const dir = target();
    run([dir]);
    expect(hashTree(join(REPO, "sops"))).toBe(before);
    // The source SOPs still carry their placeholders — rendering is per-target.
    expect(readFileSync(join(REPO, "sops", "dev-pipeline.md"), "utf8")).toContain(
      "{{config:",
    );
  });
});

describe("install.ts — idempotency", () => {
  test("installing twice with unchanged config is byte-identical", () => {
    const dir = target();
    expect(run([dir]).exitCode).toBe(0);
    const first = hashTree(dir);
    expect(run([dir]).exitCode).toBe(0);
    expect(hashTree(dir)).toBe(first);
  });

  test("re-install replaces only the marked block, preserving user bytes", () => {
    const dir = target();
    const above = "# My Project\n\nMy own rules that must survive.\n\n";
    const below = "\n## My own section\n\nAlso survives.\n";
    writeFileSync(join(dir, "CLAUDE.md"), `${above}${BEGIN}\nSTALE\n${END}${below}`);

    expect(run([dir]).exitCode).toBe(0);
    const once = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(once.startsWith(above)).toBe(true);
    expect(once.endsWith(below)).toBe(true);
    expect(once).not.toContain("STALE");
    expect(once).toContain("sops/dev-pipeline.md");

    expect(run([dir]).exitCode).toBe(0);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(once);
  });

  test("appending to a marker-less CLAUDE.md preserves it and is idempotent", () => {
    const dir = target();
    const original = "# Existing\n\nDo not touch these bytes.\n";
    writeFileSync(join(dir, "CLAUDE.md"), original);

    expect(run([dir]).exitCode).toBe(0);
    const once = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(once.startsWith(original)).toBe(true);
    expect(once).toContain(BEGIN);

    expect(run([dir]).exitCode).toBe(0);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(once);
  });
});

describe("install.ts — non-clobber", () => {
  test("refuses a differing existing SOP, leaves it untouched, and reports it", () => {
    const dir = target();
    mkdirSync(join(dir, "sops"), { recursive: true });
    writeFileSync(join(dir, "sops", "dev-pipeline.md"), "MINE\n");

    const r = run([dir]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("REFUSED_EXISTING_FILES");
    expect(r.stderr).toContain("dev-pipeline.md");
    expect(readFileSync(join(dir, "sops", "dev-pipeline.md"), "utf8")).toBe("MINE\n");
  });

  test("a refusal still installs the files it can, and deletes nothing", () => {
    const dir = target();
    mkdirSync(join(dir, "sops"), { recursive: true });
    writeFileSync(join(dir, "sops", "dev-pipeline.md"), "MINE\n");

    run([dir]);
    expect(readdirSync(join(dir, "sops")).length).toBeGreaterThan(1);
    expect(readFileSync(join(dir, "sops", "dev-pipeline.md"), "utf8")).toBe("MINE\n");
  });

  test("a byte-identical existing file is a no-op, not a refusal", () => {
    const dir = target();
    expect(run([dir]).exitCode).toBe(0);
    const r = run([dir]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain("REFUSED");
  });

  test("--force overwrites a differing existing SOP", () => {
    const dir = target();
    mkdirSync(join(dir, "sops"), { recursive: true });
    writeFileSync(join(dir, "sops", "dev-pipeline.md"), "MINE\n");

    const r = run([dir, "--force"]);
    expect(r.exitCode).toBe(0);
    const out = readFileSync(join(dir, "sops", "dev-pipeline.md"), "utf8");
    expect(out).not.toBe("MINE\n");
    expect(out).toContain("trunk");
  });
});

describe("install.ts — optional placeholder rendering", () => {
  test("team channel SET renders the configured channel into the SOP", () => {
    const dir = target();
    run([dir]);
    const out = readFileSync(join(dir, "sops", "autonomous-work.md"), "utf8");
    expect(out).toContain("#eng-internal");
    expect(out).not.toContain("{{config:channels.team}}");
  });

  test("a resolved channel reads as a statement, not a hedge", () => {
    const dir = target();
    run([dir]);
    const out = readFileSync(join(dir, "sops", "autonomous-work.md"), "utf8");
    expect(out).toContain("to the team channel (`#eng-internal`)");
    // "if configured" is model-time hedging: once rendered, it IS configured.
    expect(out).not.toContain("if configured");
  });

  test("team channel UNSET still renders — no placeholder, no empty parenthetical", () => {
    const dir = target(NO_CHANNELS_CONFIG);
    const r = run([dir]);
    expect(r.exitCode).toBe(0);
    const out = readFileSync(join(dir, "sops", "autonomous-work.md"), "utf8");
    expect(out).not.toContain("{{config:channels.team}}");
    expect(out).not.toContain("#eng-internal");
    expect(out).not.toMatch(/\(\s*``?\s*if configured\s*\)/);
    expect(out).toContain("the team channel");
  });
});
