/**
 * Tests for engine/validators/leak-check.ts.
 *
 * Spawns the scanner as a subprocess so we exercise the real CLI surface
 * (argv parsing, env handling, exit codes, staged-file resolution).
 *
 * NOTE: no credential-shaped literal appears in this file. Every fixture is
 * assembled at run time from fragments, so the test suite itself never becomes
 * a file the scanner would (correctly) flag.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const SCANNER = resolve(import.meta.dir, "..", "leak-check.ts");

// Fixtures assembled from fragments — see the note above.
const FAKE = {
  ghToken: "ghp_" + "Z9zQ".repeat(9), // 36 chars after the prefix
  ghFineGrained: "github_pat_" + "1A".repeat(12),
  awsKeyId: "AKIA" + "QQ7NDEXAMPLE1234",
  slackToken: "xox" + "b-" + "111111111111-" + "AbCdEfGhIjKlMnOpQr",
  anthropicKey: "sk-" + "ant-" + "api03-" + "QqWwEeRrTtYyUuIiOoPp",
  privateKeyHeader: "-----BEGIN " + "RSA PRIVATE KEY-----",
  credential: "Tr0ub4dor-and-three",
};

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "leak-check-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** stdout + stderr — what a human or a CI log would actually see. */
  output: string;
}

function run(args: string[], env: Record<string, string> = {}, cwd = tmp): RunResult {
  const proc = Bun.spawnSync(["bun", SCANNER, ...args], {
    // Blank the env var by default so a developer's own denylist never leaks
    // into the test run.
    env: { ...process.env, CONFIDENTIALITY_DENYLIST_FILE: "", ...env },
    cwd,
  });
  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr);
  return { exitCode: proc.exitCode ?? -1, stdout, stderr, output: stdout + stderr };
}

function write(name: string, content: string): string {
  const p = join(tmp, name);
  writeFileSync(p, content);
  return p;
}

function git(args: string[], cwd = tmp) {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  if ((proc.exitCode ?? 1) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(proc.stderr)}`);
  }
}

describe("leak-check.ts — CLI contract", () => {
  test("no paths and no --staged is a usage error (exit 2)", () => {
    const r = run([]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Usage:");
  });

  test("unknown flag is a usage error (exit 2)", () => {
    const f = write("a.txt", "hello\n");
    const r = run(["--nonsense", f]);
    expect(r.exitCode).toBe(2);
  });

  test("a clean file exits 0", () => {
    const f = write("clean.md", "# Title\n\nJust prose about governance.\n");
    const r = run([f]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("clean");
  });

  test("a missing path is a usage error (exit 2)", () => {
    const r = run([join(tmp, "does-not-exist.txt")]);
    expect(r.exitCode).toBe(2);
  });
});

describe("leak-check.ts — built-in rules", () => {
  const cases: [string, string, string][] = [
    ["private key header", FAKE.privateKeyHeader, "private-key-header"],
    ["anthropic api key", `key = "${FAKE.anthropicKey}"`, "anthropic-api-key"],
    ["github classic token", `TOKEN ${FAKE.ghToken}`, "github-token"],
    ["github fine-grained token", `TOKEN ${FAKE.ghFineGrained}`, "github-token"],
    ["aws access key id", `id: ${FAKE.awsKeyId}`, "aws-access-key-id"],
    ["slack token", `hook ${FAKE.slackToken}`, "slack-token"],
    ["credential assignment", `password: ${FAKE.credential}`, "credential-assignment"],
  ];

  for (const [label, content, rule] of cases) {
    test(`flags ${label} and names the rule`, () => {
      const f = write("fixture.txt", `line one\n${content}\nline three\n`);
      const r = run([f]);
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain(rule);
      expect(r.output).toContain("fixture.txt:2");
    });
  }

  test("reports every finding across multiple files and counts them", () => {
    const a = write("a.txt", `x\n${FAKE.awsKeyId}\n`);
    const b = write("b.txt", `${FAKE.privateKeyHeader}\n`);
    const r = run([a, b]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("a.txt:2");
    expect(r.output).toContain("b.txt:1");
    expect(r.output).toContain("2 finding");
  });

  test("placeholders and CI expressions are not credentials", () => {
    const f = write("workflow.yml", [
      "password: ${{ secrets.THING }}",
      "token: $GITHUB_TOKEN",
      "api_key: <your-key-here>",
      "secret: changeme",
      'password: ""',
      "password: REDACTED",
      "# token: xxxxxxxxxxxx",
    ].join("\n") + "\n");
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("scans directories recursively", () => {
    mkdirSync(join(tmp, "nested", "deep"), { recursive: true });
    writeFileSync(join(tmp, "nested", "deep", "leak.txt"), `${FAKE.awsKeyId}\n`);
    const r = run([join(tmp, "nested")]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("leak.txt:1");
  });

  test("skips binary files, and says how many it skipped", () => {
    const p = join(tmp, "blob.bin");
    writeFileSync(p, Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
    const r = run([p]);
    expect(r.exitCode).toBe(0);
    // A silent skip is a hiding place — the count has to be visible.
    expect(r.stdout).toContain("1 binary/oversize file(s) NOT scanned");
  });

  test("does not follow symlinks met while walking, and counts them", () => {
    // Target lives OUTSIDE the walked tree, so anything reported can only have
    // come from following the link.
    const outside = join(tmp, "outside.txt");
    writeFileSync(outside, `${FAKE.awsKeyId}\n`);
    const walked = join(tmp, "walked");
    mkdirSync(walked, { recursive: true });
    writeFileSync(join(walked, "real.txt"), "nothing here\n");
    symlinkSync(outside, join(walked, "link.txt"));

    const r = run([walked]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("1 symlink(s) NOT followed");
  });

  test("a symlink named directly on the command line IS scanned", () => {
    const outside = join(tmp, "outside.txt");
    writeFileSync(outside, `${FAKE.awsKeyId}\n`);
    const link = join(tmp, "direct-link.txt");
    symlinkSync(outside, link);

    const r = run([link]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("aws-access-key-id");
  });

  test("a placeholder-ish prefix does not swallow a real credential", () => {
    // `my-api-key` is a stand-in; `mysecretvalue123` is a password that merely
    // starts with the same two letters. Only the first should be suppressed.
    // Written as a join so this source line itself ends at the closing quote —
    // an inline "\n" would leave the escape inside the value and self-flag.
    const stand = write("stand-in.yml", ["api_key: my-api-key-here", ""].join("\n"));
    expect(run([stand]).exitCode).toBe(0);

    const real = write("real.yml", `password: my${FAKE.credential}\n`);
    const r = run([real]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("credential-assignment");
  });
});

describe("leak-check.ts — never echoes matched content", () => {
  test("a built-in match's content is absent from all output", () => {
    const f = write("secret.txt", `token = "${FAKE.ghToken}"\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    // The rule name and location are reported...
    expect(r.output).toContain("github-token");
    expect(r.output).toContain("secret.txt:1");
    // ...but no fragment of the matched string ever is.
    expect(r.output).not.toContain(FAKE.ghToken);
    expect(r.output).not.toContain("Z9zQ");
  });

  test("an operator-pattern match echoes neither the term nor the pattern", () => {
    const patterns = write("denylist.txt", "# operator patterns\nMoonlightCascade\n");
    const f = write("doc.md", "The MoonlightCascade programme is confidential.\n");
    const r = run([f, "--patterns", patterns]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("doc.md:1");
    expect(r.output).not.toContain("MoonlightCascade");
  });
});

describe("leak-check.ts — operator patterns", () => {
  test("--patterns file adds rules, reported by index only", () => {
    const patterns = write("denylist.txt", "# a comment\n\nAcmeVoltaic\nZephyrLedger\n");
    const f = write("doc.md", "hello\nZephyrLedger appears here\n");
    const r = run([f, "--patterns", patterns]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("denylist[2]");
    expect(r.output).toContain("doc.md:2");
  });

  test("CONFIDENTIALITY_DENYLIST_FILE env var is honoured", () => {
    const patterns = write("denylist.txt", "AcmeVoltaic\n");
    const f = write("doc.md", "AcmeVoltaic\n");
    const r = run([f], { CONFIDENTIALITY_DENYLIST_FILE: patterns });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("denylist[1]");
  });

  test("--patterns takes precedence over the env var", () => {
    const envPatterns = write("env-denylist.txt", "NeverMatchesAnything\n");
    const flagPatterns = write("flag-denylist.txt", "AcmeVoltaic\n");
    const f = write("doc.md", "AcmeVoltaic\n");
    const r = run([f, "--patterns", flagPatterns], { CONFIDENTIALITY_DENYLIST_FILE: envPatterns });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("denylist[1]");
  });

  test("operator patterns match case-insensitively", () => {
    const patterns = write("denylist.txt", "AcmeVoltaic\n");
    const f = write("doc.md", "acmevoltaic\n");
    const r = run([f, "--patterns", patterns]);
    expect(r.exitCode).toBe(1);
  });

  test("comments and blank lines are not patterns", () => {
    const patterns = write("denylist.txt", "# AcmeVoltaic is the term\n\n   \nZephyrLedger\n");
    const f = write("doc.md", "nothing sensitive here\n");
    const r = run([f, "--patterns", patterns]);
    expect(r.exitCode).toBe(0);
    // Index numbering follows pattern order, not raw file line order.
    expect(r.stdout).toContain("1 operator pattern");
  });

  test("a missing patterns file warns once and falls back to built-ins", () => {
    const f = write("clean.md", "nothing here\n");
    const r = run([f], { CONFIDENTIALITY_DENYLIST_FILE: join(tmp, "absent.txt") });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("built-in");
    expect(r.stderr.match(/built-in rules only/g)?.length).toBe(1);
  });

  test("a missing patterns file still fails on a built-in finding", () => {
    const f = write("leak.txt", `${FAKE.awsKeyId}\n`);
    const r = run([f], { CONFIDENTIALITY_DENYLIST_FILE: join(tmp, "absent.txt") });
    expect(r.exitCode).toBe(1);
  });

  test("--require-patterns turns a missing patterns file into a usage error", () => {
    const f = write("clean.md", "nothing here\n");
    const r = run([f, "--require-patterns"], { CONFIDENTIALITY_DENYLIST_FILE: join(tmp, "absent.txt") });
    expect(r.exitCode).toBe(2);
  });

  test("an invalid regex fails closed (exit 2) without echoing the pattern", () => {
    const patterns = write("denylist.txt", "AcmeVoltaic\n[unclosed(\n");
    const f = write("doc.md", "nothing here\n");
    const r = run([f, "--patterns", patterns]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("line 2");
    expect(r.output).not.toContain("[unclosed(");
  });
});

describe("leak-check.ts — --staged", () => {
  function initRepo() {
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@example.invalid"]);
    git(["config", "user.name", "t"]);
  }

  test("scans the staged blob, not the working-tree copy", () => {
    initRepo();
    write("tracked.txt", `${FAKE.awsKeyId}\n`);
    git(["add", "tracked.txt"]);
    // Worktree is scrubbed after staging — the staged blob still has the leak.
    write("tracked.txt", "totally clean now\n");
    const r = run(["--staged"]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("tracked.txt:1");
  });

  test("exits 0 when nothing is staged", () => {
    initRepo();
    const r = run(["--staged"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("clean");
  });

  test("ignores unstaged working-tree changes", () => {
    initRepo();
    write("a.txt", "clean\n");
    git(["add", "a.txt"]);
    git(["commit", "-q", "-m", "init"]);
    write("b.txt", `${FAKE.awsKeyId}\n`); // never staged
    const r = run(["--staged"]);
    expect(r.exitCode).toBe(0);
  });

  test("--staged outside a git repo is a usage error (exit 2)", () => {
    const r = run(["--staged"]);
    expect(r.exitCode).toBe(2);
  });
});
