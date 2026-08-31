/**
 * Tests for engine/install.ts.
 *
 * Spawns the installer as a subprocess so we exercise the real CLI surface
 * (argv parsing, exit codes, stderr reasons, filesystem effects).
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  existsSync,
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

/** Mirrors the EXIT table in engine/install.ts. Asserted by value, not just
 *  "nonzero", so a reason can never silently change code. */
const EXIT = {
  OK: 0,
  USAGE: 2,
  TARGET_NOT_A_DIRECTORY: 3,
  CONFIG_NOT_FOUND: 4,
  CONFIG_INVALID: 5,
  UNRESOLVED_PLACEHOLDERS: 6,
  REFUSED_EXISTING_FILES: 7,
  MARKERS_MALFORMED: 8,
} as const;

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
validators:
  claude_md:
    enabled: true
    required_sections:
      - Critical Rules
      - Standard Operating Procedures
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
    expect(r.exitCode).toBe(EXIT.USAGE);
    expect(r.stderr).toContain("USAGE");
  });

  test("exits nonzero when the target directory does not exist", () => {
    const r = run([join(tmp, "nope")]);
    expect(r.exitCode).toBe(EXIT.TARGET_NOT_A_DIRECTORY);
    expect(r.stderr).toContain("TARGET_NOT_A_DIRECTORY");
  });

  test("exits nonzero when the target is a file, not a directory", () => {
    const f = join(tmp, "afile");
    writeFileSync(f, "x");
    const r = run([f]);
    expect(r.exitCode).toBe(EXIT.TARGET_NOT_A_DIRECTORY);
    expect(r.stderr).toContain("TARGET_NOT_A_DIRECTORY");
  });
});

describe("install.ts — config discovery", () => {
  test("refuses to install with defaults when the target has no config", () => {
    const dir = target(null);
    const r = run([dir]);
    expect(r.exitCode).toBe(EXIT.CONFIG_NOT_FOUND);
    expect(r.stderr).toContain("CONFIG_NOT_FOUND");
    expect(r.stderr).toContain("compass.config.example.yaml");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("reports a schema-invalid config without writing anything", () => {
    const dir = target("schema: compass-config/v1\norg:\n  name: 42\n");
    const r = run([dir]);
    expect(r.exitCode).toBe(EXIT.CONFIG_INVALID);
    expect(r.stderr).toContain("CONFIG_INVALID");
    expect(readdirSync(dir)).toEqual(["compass.config.yaml"]);
  });

  test("a config with no schema header is CONFIG_INVALID, and writes nothing", () => {
    // The header is the only key rejected at LOAD (exit 5) rather than at
    // render (exit 6): nothing interpolates it, so the render-time gate below
    // can never see it.
    const dir = target("org:\n  name: acme-corp\n");
    const r = run([dir]);
    expect(r.exitCode).toBe(EXIT.CONFIG_INVALID);
    expect(r.stderr).toContain("schema: compass-config/v1");
    expect(readdirSync(dir)).toEqual(["compass.config.yaml"]);
  });

  test("fails naming the key when a required placeholder key is unset", () => {
    const dir = target("schema: compass-config/v1\nfeatures:\n  id_prefix: F-\n");
    const r = run([dir]);
    expect(r.exitCode).toBe(EXIT.UNRESOLVED_PLACEHOLDERS);
    expect(r.stderr).toContain("UNRESOLVED_PLACEHOLDERS");
    expect(r.stderr).toContain("org.name");
    expect(readdirSync(dir)).toEqual(["compass.config.yaml"]);
  });
});

describe("install.ts — fresh install", () => {
  test("exits 0 and writes rendered SOPs plus a CLAUDE.md block", () => {
    const dir = target();
    const r = run([dir]);
    expect(r.exitCode).toBe(EXIT.OK);

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

  /**
   * Corpus guard: sweep every rendered SOP for a surviving key-path
   * placeholder. Run once per config shape — the FULL config resolves almost
   * everything, so it is the MINIMAL run (optional keys unset, drop-mode
   * active) where a subsumption bug actually manifests. Running only the FULL
   * shape is what let F-A1 hide.
   */
  const assertNoLivePlaceholders = (dir: string) => {
    for (const f of readdirSync(join(dir, "sops"))) {
      const text = readFileSync(join(dir, "sops", f), "utf8");
      // The only {{config:...}} tokens allowed to survive are meta-references
      // to the grammar itself (`{{config:*}}`), never a real key path.
      const survivors = [...text.matchAll(/\{\{config:([^}]*)\}\}/g)].map((m) => m[1]);
      for (const s of survivors) {
        expect(s).not.toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
      }
    }
  };

  test("no rendered SOP sends the model back to compass.config.yaml (full config)", () => {
    const dir = target();
    expect(run([dir]).exitCode).toBe(EXIT.OK);
    assertNoLivePlaceholders(dir);
  });

  test("no rendered SOP sends the model back to compass.config.yaml (optional keys unset)", () => {
    const dir = target(NO_CHANNELS_CONFIG);
    expect(run([dir]).exitCode).toBe(EXIT.OK);
    assertNoLivePlaceholders(dir);
  });

  test("the block supplies both required sections, rules before the SOP table", () => {
    const dir = target();
    run([dir]);
    const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("## Critical Rules");
    expect(claude).toContain("## Standard Operating Procedures");
    // Order matters: the rules govern how the SOPs below are followed.
    expect(claude.indexOf("## Critical Rules")).toBeLessThan(
      claude.indexOf("## Standard Operating Procedures"),
    );
  });

  test("ships the four generic rules from the CLAUDE.md template", () => {
    const dir = target();
    run([dir]);
    const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("NEVER describe code you haven't read");
    expect(claude).toContain("NEVER fabricate file names");
    expect(claude).toContain("Fix ALL errors");
    expect(claude).toContain("gh pr list");
  });

  test("an installed CLAUDE.md passes compass-core's own claude-md-check", () => {
    const dir = target();
    expect(run([dir]).exitCode).toBe(EXIT.OK);

    // The real validator, as a subprocess, against the real installed file.
    // The installer and the validator must agree on what "governed" looks
    // like; if they drift, this fails.
    const validator = join(REPO, "engine", "validators", "claude-md-check.ts");
    const proc = Bun.spawnSync(["bun", validator, join(dir, "CLAUDE.md")], {
      env: { ...process.env, COMPASS_CONFIG: "" },
      cwd: dir,
    });
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(stderr).toBe("");
    expect(proc.exitCode).toBe(0);
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

describe("install.ts — dry run", () => {
  test("reports what it would write and touches nothing", () => {
    const dir = target();
    const r = run([dir, "--dry-run"]);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.stdout).toContain("would write");
    expect(r.stdout).toContain("sops/dev-pipeline.md");
    // The only thing in the target is still the config we put there.
    expect(readdirSync(dir)).toEqual(["compass.config.yaml"]);
  });

  test("does not modify an existing CLAUDE.md", () => {
    const dir = target();
    const original = "# Existing\n\nUntouched.\n";
    writeFileSync(join(dir, "CLAUDE.md"), original);
    expect(run([dir, "--dry-run"]).exitCode).toBe(EXIT.OK);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(original);
  });

  test("leaves the tree byte-identical", () => {
    const dir = target();
    expect(run([dir]).exitCode).toBe(EXIT.OK);
    const before = hashTree(dir);
    expect(run([dir, "--dry-run"]).exitCode).toBe(EXIT.OK);
    expect(hashTree(dir)).toBe(before);
  });
});

describe("install.ts — idempotency", () => {
  test("installing twice with unchanged config is byte-identical", () => {
    const dir = target();
    expect(run([dir]).exitCode).toBe(EXIT.OK);
    const first = hashTree(dir);
    expect(run([dir]).exitCode).toBe(EXIT.OK);
    expect(hashTree(dir)).toBe(first);
  });

  test("installing twice with --with-ci is byte-identical", () => {
    const dir = target();
    expect(run([dir, "--with-ci"]).exitCode).toBe(EXIT.OK);
    const first = hashTree(dir);
    expect(run([dir, "--with-ci"]).exitCode).toBe(EXIT.OK);
    expect(hashTree(dir)).toBe(first);
  });

  test("a --with-ci target re-installed with --with-ci reports nothing to write", () => {
    const dir = target();
    run([dir, "--with-ci"]);
    const r = run([dir, "--with-ci"]);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.stdout).toContain("wrote: 0 file(s)");
  });

  test("the copied scanner is idempotent — counted as current, not rewritten", () => {
    const dir = target();
    const first = run([dir, "--with-ci"]);
    expect(first.stdout).toContain(join(".githooks", "leak-check.ts"));
    const second = run([dir, "--with-ci"]);
    expect(second.exitCode).toBe(EXIT.OK);
    // Named in the first run's written list, absent from the second's.
    expect(second.stdout).not.toContain(`+ ${join(".githooks", "leak-check.ts")}`);
    expect(second.stdout).toContain("wrote: 0 file(s)");
    expect(second.stdout).toMatch(/already current: \d+ file\(s\)/);
  });

  test("re-install replaces only the marked block, preserving user bytes", () => {
    const dir = target();
    const above = "# My Project\n\nMy own rules that must survive.\n\n";
    const below = "\n## My own section\n\nAlso survives.\n";
    writeFileSync(join(dir, "CLAUDE.md"), `${above}${BEGIN}\nSTALE\n${END}${below}`);

    expect(run([dir]).exitCode).toBe(EXIT.OK);
    const once = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(once.startsWith(above)).toBe(true);
    expect(once.endsWith(below)).toBe(true);
    expect(once).not.toContain("STALE");
    expect(once).toContain("sops/dev-pipeline.md");

    expect(run([dir]).exitCode).toBe(EXIT.OK);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(once);
  });

  test("appending to a marker-less CLAUDE.md preserves it and is idempotent", () => {
    const dir = target();
    const original = "# Existing\n\nDo not touch these bytes.\n";
    writeFileSync(join(dir, "CLAUDE.md"), original);

    expect(run([dir]).exitCode).toBe(EXIT.OK);
    const once = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(once.startsWith(original)).toBe(true);
    expect(once).toContain(BEGIN);

    expect(run([dir]).exitCode).toBe(EXIT.OK);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(once);
  });
});

describe("install.ts — --with-ci", () => {
  const HOOK = join(".githooks", "pre-commit");
  const SCANNER = join(".githooks", "leak-check.ts");
  const WORKFLOW = join(".github", "workflows", "compass-governance.yml");

  test("installs the hook and the workflow", () => {
    const dir = target();
    const r = run([dir, "--with-ci"]);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(existsSync(join(dir, HOOK))).toBe(true);
    expect(existsSync(join(dir, WORKFLOW))).toBe(true);
  });

  test("installs the scanner the hook runs, beside the hook", () => {
    // The whole defect: the hook shipped, the thing it executes did not.
    const dir = target();
    expect(run([dir, "--with-ci"]).exitCode).toBe(EXIT.OK);
    expect(existsSync(join(dir, SCANNER))).toBe(true);
  });

  test("the installed scanner is byte-identical to the engine's", () => {
    const dir = target();
    run([dir, "--with-ci"]);
    expect(readFileSync(join(dir, SCANNER), "utf8")).toBe(
      readFileSync(join(REPO, "engine", "validators", "leak-check.ts"), "utf8"),
    );
  });

  test("the hook resolves the installed scanner, not an engine path the target lacks", () => {
    const dir = target();
    run([dir, "--with-ci"]);
    const hook = readFileSync(join(dir, HOOK), "utf8");
    expect(hook).toContain('scanner_installed="$repo_root/.githooks/leak-check.ts"');
    // The engine path must survive as the SECOND arm — compass-core itself and
    // any repo vendoring the engine still resolve through it.
    expect(hook).toContain('scanner_engine="$repo_root/engine/validators/leak-check.ts"');
  });

  test("the copied scanner imports node builtins only — nothing ties it to the engine tree", () => {
    // This is the property that makes copying it legitimate. A package import
    // or a relative import added upstream would make the installed copy fail to
    // start in a target that has no node_modules and no engine/, and it would
    // fail at commit time, in someone else's repo. Catch it here instead.
    const src = readFileSync(join(REPO, "engine", "validators", "leak-check.ts"), "utf8");
    const imports = [...src.matchAll(/^\s*import\s[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec).toMatch(/^node:/);
  });

  test("installs neither without the flag", () => {
    const dir = target();
    expect(run([dir]).exitCode).toBe(EXIT.OK);
    expect(existsSync(join(dir, ".githooks"))).toBe(false);
    expect(existsSync(join(dir, ".github"))).toBe(false);
  });

  test("the hook is executable — a non-executable hook is one git ignores", () => {
    const dir = target();
    run([dir, "--with-ci"]);
    expect(statSync(join(dir, HOOK)).mode & 0o111).not.toBe(0);
  });

  test("re-install repairs a hook that lost its execute bit", () => {
    const dir = target();
    run([dir, "--with-ci"]);
    chmodSync(join(dir, HOOK), 0o644);
    expect(run([dir, "--with-ci"]).exitCode).toBe(EXIT.OK);
    expect(statSync(join(dir, HOOK)).mode & 0o111).not.toBe(0);
  });

  test("the workflow carries a rendered 40-hex compass-core pin", () => {
    const dir = target();
    run([dir, "--with-ci"]);
    const wf = readFileSync(join(dir, WORKFLOW), "utf8");
    expect(wf).toMatch(/ref: [0-9a-f]{40}\b/);
  });

  test("no unrendered placeholder token survives into the workflow", () => {
    const dir = target();
    run([dir, "--with-ci"]);
    const wf = readFileSync(join(dir, WORKFLOW), "utf8");
    // `${{ ... }}` is GitHub Actions expression syntax and must survive; a bare
    // `{{ ... }}` is one of ours that failed to render.
    for (const m of wf.matchAll(/(.?)\{\{([^}]*)\}\}/g)) {
      expect(m[1]).toBe("$");
    }
  });

  test("the workflow runs the validators from the engine checkout, not the target", () => {
    const dir = target();
    run([dir, "--with-ci"]);
    const wf = readFileSync(join(dir, WORKFLOW), "utf8");
    expect(wf).toContain("repository: the-metafactory/compass-core");
    expect(wf).toContain("path: .compass-engine");
    // The consuming repo has no engine/, so a bare `bun engine/...` run line
    // would be a gate that cannot start.
    expect(wf).not.toMatch(/run: bun engine\/validators/);
    expect(wf).toContain("bun .compass-engine/engine/validators/claude-md-check.ts");
  });

  test("CI defaults to --require-patterns when a denylist is available", () => {
    const dir = target();
    run([dir, "--with-ci"]);
    const wf = readFileSync(join(dir, WORKFLOW), "utf8");
    expect(wf).toContain('REQUIRE="--require-patterns"');
  });

  test("uses the renamed CONFIDENTIALITY_DENYLIST_FILE for the scanner path", () => {
    const dir = target();
    run([dir, "--with-ci"]);
    const wf = readFileSync(join(dir, WORKFLOW), "utf8");
    expect(wf).toContain('export CONFIDENTIALITY_DENYLIST_FILE=');
  });

  test("prints the hook arming instruction rather than burying it", () => {
    const dir = target();
    const r = run([dir, "--with-ci"]);
    expect(r.stdout).toContain("git config core.hooksPath .githooks");
  });

  test("the CLAUDE.md block is byte-identical with and without --with-ci", () => {
    // Config-determinism: block content is a function of the config alone. If a
    // flag could change it, a later re-install without that flag would silently
    // rewrite the block.
    const a = target();
    run([a]);
    const b = target();
    run([b, "--with-ci"]);
    expect(readFileSync(join(b, "CLAUDE.md"), "utf8")).toBe(
      readFileSync(join(a, "CLAUDE.md"), "utf8"),
    );
  });

  test("refuses a differing existing hook unless --force", () => {
    const dir = target();
    mkdirSync(join(dir, ".githooks"), { recursive: true });
    writeFileSync(join(dir, HOOK), "#!/bin/sh\n# mine\n");

    const r = run([dir, "--with-ci"]);
    expect(r.exitCode).toBe(EXIT.REFUSED_EXISTING_FILES);
    expect(r.stderr).toContain("pre-commit");
    expect(readFileSync(join(dir, HOOK), "utf8")).toBe("#!/bin/sh\n# mine\n");

    expect(run([dir, "--with-ci", "--force"]).exitCode).toBe(EXIT.OK);
    expect(readFileSync(join(dir, HOOK), "utf8")).not.toBe("#!/bin/sh\n# mine\n");
  });

  test("--dry-run writes no CI files", () => {
    const dir = target();
    expect(run([dir, "--with-ci", "--dry-run"]).exitCode).toBe(EXIT.OK);
    expect(existsSync(join(dir, ".githooks"))).toBe(false);
    expect(existsSync(join(dir, ".github"))).toBe(false);
  });
});

describe("install.ts — non-clobber", () => {
  test("refuses a differing existing SOP, leaves it untouched, and reports it", () => {
    const dir = target();
    mkdirSync(join(dir, "sops"), { recursive: true });
    writeFileSync(join(dir, "sops", "dev-pipeline.md"), "MINE\n");

    const r = run([dir]);
    expect(r.exitCode).toBe(EXIT.REFUSED_EXISTING_FILES);
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
    expect(run([dir]).exitCode).toBe(EXIT.OK);
    const r = run([dir]);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.stderr).not.toContain("REFUSED");
  });

  test("--force overwrites a differing existing SOP", () => {
    const dir = target();
    mkdirSync(join(dir, "sops"), { recursive: true });
    writeFileSync(join(dir, "sops", "dev-pipeline.md"), "MINE\n");

    const r = run([dir, "--force"]);
    expect(r.exitCode).toBe(EXIT.OK);
    const out = readFileSync(join(dir, "sops", "dev-pipeline.md"), "utf8");
    expect(out).not.toBe("MINE\n");
    expect(out).toContain("trunk");
  });

  test("refuses a differing existing scanner unless --force", () => {
    // The copied scanner is a written file like any other: an operator who has
    // edited their own .githooks/leak-check.ts does not get it silently
    // replaced, security-relevant or not.
    const dir = target();
    const scanner = join(dir, ".githooks", "leak-check.ts");
    mkdirSync(join(dir, ".githooks"), { recursive: true });
    writeFileSync(scanner, "// mine\n");

    const r = run([dir, "--with-ci"]);
    expect(r.exitCode).toBe(EXIT.REFUSED_EXISTING_FILES);
    expect(r.stderr).toContain("leak-check.ts");
    expect(readFileSync(scanner, "utf8")).toBe("// mine\n");

    expect(run([dir, "--with-ci", "--force"]).exitCode).toBe(EXIT.OK);
    expect(readFileSync(scanner, "utf8")).not.toBe("// mine\n");
  });
});

/**
 * The regression that motivated the scanner copy, asserted end to end.
 *
 * Before the fix the installed hook resolved `<target>/engine/validators/
 * leak-check.ts` — a path no installed target has, because the installer never
 * copied engine/. It therefore took its fail-open "SKIPPED, commit allowed" arm
 * on every commit, in every governed repo, and exited 0 while scanning nothing.
 *
 * These tests run the real hook against a real staged blob. They fail if the
 * scanner stops being copied, if the hook stops resolving the copy, or if the
 * fail-open arm ever becomes reachable again in a --with-ci install.
 */
describe("install.ts — the installed hook actually gates", () => {
  /** A syntactically valid, well-known-fake AWS key id. Matches `aws-access-key-id`. */
  const FAKE_AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";

  function git(dir: string, ...args: string[]): void {
    const r = Bun.spawnSync(["git", ...args], { cwd: dir });
    if (r.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(r.stderr)}`);
    }
  }

  /** A --with-ci install inside a real git repo, with `staged` staged. */
  function governedRepo(staged: string): string {
    const dir = target();
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "test@example.invalid");
    git(dir, "config", "user.name", "compass test");
    expect(run([dir, "--with-ci"]).exitCode).toBe(EXIT.OK);
    writeFileSync(join(dir, "staged.txt"), staged);
    git(dir, "add", "staged.txt");
    return dir;
  }

  function runHook(dir: string): RunResult {
    const proc = Bun.spawnSync(["sh", join(".githooks", "pre-commit")], { cwd: dir });
    return {
      exitCode: proc.exitCode ?? -1,
      stdout: new TextDecoder().decode(proc.stdout),
      stderr: new TextDecoder().decode(proc.stderr),
    };
  }

  test("blocks a staged credential — exit 1, naming the rule that fired", () => {
    const r = runHook(governedRepo(`aws_key = ${FAKE_AWS_KEY}\n`));
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("aws-access-key-id");
    expect(r.stdout + r.stderr).toContain("staged.txt");
  });

  test("the scanner-absent fail-open arm is unreachable in a --with-ci install", () => {
    const r = runHook(governedRepo(`aws_key = ${FAKE_AWS_KEY}\n`));
    expect(r.stderr).not.toContain("SKIPPED");
    expect(r.stderr).not.toContain("commit allowed");
  });

  test("never echoes the matched credential — a hook's output is public", () => {
    const r = runHook(governedRepo(`aws_key = ${FAKE_AWS_KEY}\n`));
    expect(r.stdout + r.stderr).not.toContain(FAKE_AWS_KEY);
  });

  test("git commit itself is refused, not merely the hook run by hand", () => {
    const dir = governedRepo(`aws_key = ${FAKE_AWS_KEY}\n`);
    git(dir, "config", "core.hooksPath", ".githooks");
    const commit = Bun.spawnSync(["git", "commit", "-m", "leak"], { cwd: dir });
    expect(commit.exitCode).not.toBe(0);
    // And nothing landed.
    const log = Bun.spawnSync(["git", "log", "--oneline"], { cwd: dir });
    expect(new TextDecoder().decode(log.stdout).trim()).toBe("");
  });

  test("a clean staged file still commits — the gate blocks findings, not work", () => {
    const dir = governedRepo("nothing to see here\n");
    git(dir, "config", "core.hooksPath", ".githooks");
    expect(runHook(dir).exitCode).toBe(0);
    const commit = Bun.spawnSync(["git", "commit", "-m", "clean"], { cwd: dir });
    expect(commit.exitCode).toBe(0);
  });

  test("the install's own files do not trip the gate", () => {
    // The scanner is now a file in every governed repo, and that repo's gate
    // scans it — a page of credential regexes reading its own source. It comes
    // out clean today (the patterns need 16 trailing characters the source
    // never supplies). A future rule written less carefully would block the
    // first commit after install, in someone else's repo, for no reason they
    // could act on.
    const dir = target();
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "test@example.invalid");
    git(dir, "config", "user.name", "compass test");
    expect(run([dir, "--with-ci"]).exitCode).toBe(EXIT.OK);
    git(dir, "add", "-A");
    expect(runHook(dir).exitCode).toBe(0);
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
    expect(r.exitCode).toBe(EXIT.OK);
    const out = readFileSync(join(dir, "sops", "autonomous-work.md"), "utf8");
    expect(out).not.toContain("{{config:channels.team}}");
    expect(out).not.toContain("#eng-internal");
    expect(out).not.toMatch(/\(\s*``?\s*if configured\s*\)/);
    expect(out).toContain("the team channel");
  });
});
