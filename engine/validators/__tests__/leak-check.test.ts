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

// ---------------------------------------------------------------------------
// Issue #31 — credential-assignment flags code expressions, and there was no
// sanctioned way to mark a false positive.
//
// Test names carry the "[watched]" tag for the cases that were observed RED
// against origin/main before the fix (captured in the PR body) and are
// expected GREEN after it. The un-tagged tests in this section are regression
// guards: behaviour that was already correct and must stay that way.
// ---------------------------------------------------------------------------

describe("leak-check.ts — issue #31: code-expression values are not credentials", () => {
  test("[watched] token: ZERO_REPORTS().token — a call-expression value is not flagged", () => {
    const f = write("zero-reports.ts", "const cfg = {\n  token: ZERO_REPORTS().token,\n};\n");
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("[watched] token: zeroReports.token — a member-expression value is not flagged", () => {
    const f = write("member.ts", "const cfg = {\n  token: zeroReports.token,\n};\n");
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("[watched] token: computeTally(x) — a call-expression value is not flagged", () => {
    const f = write("call.ts", "const cfg = {\n  token: computeTally(x),\n};\n");
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("an object-literal value is not flagged", () => {
    const f = write("obj.ts", "const cfg = {\n  secret: {kind: 'ref', id: x},\n};\n");
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("an array-literal value is not flagged", () => {
    const f = write("arr.ts", "const cfg = {\n  token: [a, b, c],\n};\n");
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("a spread value is not flagged", () => {
    const f = write("spread.ts", "const cfg = {\n  secret: {...base},\n};\n");
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("a chained member/call expression is not flagged", () => {
    const f = write("chain.ts", "const cfg = {\n  token: a.b.getToken().value,\n};\n");
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("a quoted ghp_-shaped literal in a token: field is still flagged (not a code expression)", () => {
    // Fragments, not a literal secret — see the file header note.
    const ghpLike = "gh" + "p_" + "Q9zQ".repeat(9);
    const f = write("quoted.ts", `token: "${ghpLike}"\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/quoted\.ts:1: (credential-assignment|github-token)/);
  });

  test("a bare 40-char token value is still flagged", () => {
    const bareToken = "Qx7f".repeat(10); // 40 chars, no dots/parens/brackets
    const f = write("bare-token.ts", `token: ${bareToken}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("bare-token.ts:1: credential-assignment");
  });

  test("a dotted value that is NOT a clean identifier chain (trailing garbage) is still flagged", () => {
    // Guards against the code-expression carve-out being so loose it eats a
    // real secret that merely happens to contain a dot.
    const f = write("dotty.ts", "secret: not.actually.code!!!garbage\n"); // leak-check:allow credential-assignment — synthetic fixture proving the rule still fires on a dotted value that is NOT a clean code-expression chain; not a real secret
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("dotty.ts:1: credential-assignment");
  });

  // PR #33 review (compass-core#31): a member-expression value written as
  // markdown inline code — `token: someObject.token` with no space before the
  // closing backtick — captured the backtick as part of the unquoted value.
  // That trailing backtick broke the end-anchored code-expression match, so
  // the false positive this issue exists to fix reappeared inside this very
  // file's own header prose. Exact line from the review comment, verbatim.
  test("[watched] a member expression inside markdown inline code is not flagged (backtick is not part of the value)", () => {
    const f = write(
      "doc.md",
      "- leak-check `credential-assignment` on `token: someObject.token` — (b) detector corrected\n",
    );
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("a backtick-terminated unquoted value does not swallow the backtick into the captured value", () => {
    // Same shape, minimal: nothing after the code span on the line.
    const f = write("inline.md", "see `token: computeTally(x)` for details\n");
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("a real credential immediately followed by a backtick is still flagged", () => {
    // The backtick stop-character must not create a NEW way to hide a real
    // secret — only the code-expression shape is exempted, not "anything
    // followed by a backtick".
    const f = write("inline2.md", `\`token: my${FAKE.credential}\` — not code\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("inline2.md:1: credential-assignment");
  });
});

describe("leak-check.ts — issue #31: leak-check:allow exemption marker", () => {
  test("[watched] a marker with a reason suppresses the finding, and the honoured count prints", () => {
    const f = write(
      "allowed.ts",
      `secret: my${FAKE.credential} // leak-check:allow credential-assignment — synthetic fixture value, used only in this test\n`,
    );
    const r = run([f]);
    expect(r.exitCode).toBe(0);
    // The raw finding line must be gone...
    expect(r.output).not.toMatch(/allowed\.ts:1: credential-assignment\s*$/m);
    // ...but the exemption itself is visible, never silent.
    expect(r.output).toContain("1 exemption(s) honoured");
    // Never echo the matched credential value itself.
    expect(r.output).not.toContain(FAKE.credential);
  });

  test("[watched] a bare marker with no reason still blocks and warns", () => {
    const f = write("bare-marker.ts", `secret: my${FAKE.credential} // leak-check:allow credential-assignment\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("bare-marker.ts:1: credential-assignment");
    expect(r.output.toLowerCase()).toContain("without a reason");
    expect(r.output).not.toContain("exemption(s) honoured"); // no honoured exemption
  });

  test("a punctuation-only reason does not count as a reason", () => {
    const f = write(
      "punct-reason.ts",
      `secret: my${FAKE.credential} // leak-check:allow credential-assignment — ---\n`,
    );
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("punct-reason.ts:1: credential-assignment");
  });

  test("[watched] a non-exemptable rule (private-key-header) still blocks even with a marker and reason", () => {
    const f = write(
      "key.ts",
      `${FAKE.privateKeyHeader} // leak-check:allow private-key-header — this is fine, trust me\n`,
    );
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("key.ts:1: private-key-header");
    expect(r.output.toLowerCase()).toContain("not exemptable");
  });

  test("a marker naming a rule that did not fire on the line is a no-op", () => {
    const f = write("noop.ts", "line one\nline two\nline three\n// leak-check:allow credential-assignment — n/a\n");
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("the marker for one rule does not suppress a different rule's finding sharing its line", () => {
    const f = write(
      "shared-line.ts",
      `secret: my${FAKE.credential} id: ${FAKE.awsKeyId} // leak-check:allow credential-assignment — synthetic value only, not a real secret\n`,
    );
    const r = run([f]);
    // aws-access-key-id was not named by the marker, so it must still block.
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("shared-line.ts:1: aws-access-key-id");
    expect(r.output).not.toMatch(/shared-line\.ts:1: credential-assignment\s*$/m);
    expect(r.output).toContain("1 exemption(s) honoured");
  });

  test("multiple honoured exemptions are all counted", () => {
    const f = write(
      "multi.ts",
      [
        `secret: my${FAKE.credential} // leak-check:allow credential-assignment — synthetic value, test only`,
        `password: your${FAKE.credential} // leak-check:allow credential-assignment — synthetic value, test only`,
        "",
      ].join("\n"),
    );
    const r = run([f]);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("2 exemption(s) honoured");
  });

  test("any comment syntax carries the marker (# and <!-- -->, not just //)", () => {
    const f = write(
      "hash.py",
      `secret = "${"my" + FAKE.credential}"  # leak-check:allow credential-assignment — synthetic value, test only\n`,
    );
    const r = run([f]);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("1 exemption(s) honoured");
  });
});
