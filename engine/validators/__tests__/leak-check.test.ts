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
  // issue #31 review on #35 (F1) — dedicated shape-rule fixtures, all built
  // from fragments so no provider-shaped literal is contiguous in source.
  jwtHeader: "eyJ" + "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  jwtPayload: "eyJ" + "zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ",
  jwtSig: "MEQCIG" + "oodSigForTestingOnly1234567890",
  sendgridKey: "SG" + "." + "aBcDeFgHiJkLmNoPqRsT12" + "." + "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ABCDefgh",
  discordToken: "MTEx" + "MjIzMzQ0NTU2Njc3ODg5" + "." + "GaBcDe" + "." + "AbCdEfGhIjKlMnOpQrStUvWxYzAb1234",
  googleOAuth: "ya29" + "." + "a0AbCdEfGhIjKlMnOpQrStUvWxYz1234567890",
  // A base64-ish blob with a dot inserted — the exact adversarial shape from
  // the review (two long uppercase-heavy runs, each over the 40-char
  // identifier-length cap, joined by "."), not a real base64 encoding.
  base64WithDot: "QUJD".repeat(11) + "." + "TU5P".repeat(11),
  // "Word2024.Word" — a dotted password with no camelCase/underscore
  // structure, the row credential-assignment's old carve-out let through.
  dottedPassword: "Fake" + "2024" + "." + "Example",
  // A call-shaped value whose argument is NOT a plausible identifier
  // (hyphens aren't in the identifier charset at all).
  callShapedSecret: "fake(" + "9f8e7d6c-5b4a-3210-9d3e-9d3e9d3e9d3e" + ")",
  // A JS template-literal-shaped value: backtick-quoted, 24+ chars inside.
  templateLiteral: "Qx7f".repeat(6),
  // issue #37 — a 40-character synthetic value for the env-style key tests.
  envValue: "Az9k".repeat(10),
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
    // real secret that merely happens to contain a dot. Built from fragments
    // (review on #35, F5) — resolution (a), per this file's own header note,
    // rather than a leak-check:allow marker on a fixture that could just as
    // well not need one.
    const key = "secret";
    const value = "not" + ".actually" + ".code!!!garbage";
    const f = write("dotty.ts", `${key}: ${value}\n`);
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

// ---------------------------------------------------------------------------
// PR #35 review (compass-core#31) — F1: the member-expression carve-out let
// dotted/call-shaped real-secret shapes through, and provider-token shapes
// with no key-name (`token:`/`secret:`) at all had no rule of their own.
//
// Each "[watched]" test here was confirmed to PASS EVERY RULE (a real
// weakening) on this branch's pre-review head (b1cfbea) and is BLOCKED
// after. See the PR body for the reviewer's before/after table.
// ---------------------------------------------------------------------------

describe("leak-check.ts — F1: dedicated provider-token shape rules (fire regardless of key name)", () => {
  test("[watched] a JWT, unquoted, in YAML — no key at all needed to fire", () => {
    const jwt = `${FAKE.jwtHeader}.${FAKE.jwtPayload}.${FAKE.jwtSig}`;
    const f = write("jwt.yml", `token: ${jwt}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("jwt.yml:1: jwt");
  });

  test("[watched] a JWT, unquoted, in .env", () => {
    const jwt = `${FAKE.jwtHeader}.${FAKE.jwtPayload}.${FAKE.jwtSig}`;
    const f = write("jwt.env", `AUTH_TOKEN=${jwt}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("jwt.env:1: jwt");
  });

  test("a quoted JWT still blocks too (never depended on the carve-out)", () => {
    const jwt = `${FAKE.jwtHeader}.${FAKE.jwtPayload}.${FAKE.jwtSig}`;
    const f = write("jwt-quoted.yml", `token: "${jwt}"\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("jwt-quoted.yml:1: jwt");
  });

  test("[watched] a SendGrid-shaped key, unquoted, fires regardless of key name", () => {
    const f = write("sendgrid.ts", `api_key: ${FAKE.sendgridKey}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("sendgrid.ts:1: sendgrid-api-key");
  });

  test("[watched] a Discord-bot-token-shaped value, unquoted", () => {
    const f = write("discord.ts", `token: ${FAKE.discordToken}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("discord.ts:1: discord-bot-token");
  });

  test("[watched] a Google-OAuth-shaped (ya29.) value, unquoted", () => {
    const f = write("google.ts", `token: ${FAKE.googleOAuth}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("google.ts:1: google-oauth-token");
  });

  test("none of the dedicated shape rules can be marked away (leak-check-allow-unsupported)", () => {
    const jwt = `${FAKE.jwtHeader}.${FAKE.jwtPayload}.${FAKE.jwtSig}`;
    const f = write(
      "jwt-marked.ts",
      `token: ${jwt} // leak-check:allow jwt — this is fine, trust me\n`,
    );
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("jwt-marked.ts:1: jwt");
    expect(r.output.toLowerCase()).toContain("not exemptable");
  });
});

describe("leak-check.ts — F1: credential-assignment's carve-out is narrowed (file type + shape + plausibility)", () => {
  test("[watched] a base64-with-dots blob (segments over the 40-char identifier cap) still blocks", () => {
    const f = write("b64dots.ts", `secret: ${FAKE.base64WithDot}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("b64dots.ts:1: credential-assignment");
  });

  test("[watched] a dotted password with no camelCase/underscore structure still blocks, in .ts", () => {
    const f = write("fakepw.ts", `password: ${FAKE.dottedPassword}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("fakepw.ts:1: credential-assignment");
  });

  test("[watched] the same dotted password still blocks in .yml (never a code file)", () => {
    const f = write("fakepw.yml", `password: ${FAKE.dottedPassword}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("fakepw.yml:1: credential-assignment");
  });

  test("[watched] a call-shaped value whose argument isn't a plausible identifier still blocks", () => {
    const f = write("fakecall.ts", `password: ${FAKE.callShapedSecret}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("fakecall.ts:1: credential-assignment");
  });

  test("a plain identifier value in .yml (no dot, no call) still blocks — never a code file", () => {
    const bare = "Qx7f".repeat(10); // 40 chars, clean charset, no dot/call
    const f = write("bare.yml", `token: ${bare}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("bare.yml:1: credential-assignment");
  });

  test("a member-expression value in .json still blocks — never a code file (no inline-code exception there)", () => {
    // Unquoted key:value, same shape credential-assignment matches anywhere
    // — a quoted JSON key (`"token":`) doesn't match the rule's keyword
    // pattern at all (the closing quote sits between the keyword and the
    // separator), so this uses the shape the rule actually looks for.
    const f = write("member.json", "token" + ": " + "zeroReports.token" + "\n");
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("member.json:1: credential-assignment");
  });

  // The three original false positives this issue exists to fix — must
  // still pass in .ts after the narrowing.
  test("[watched] token: ZERO_REPORTS().token still passes in .ts", () => {
    const f = write("zero-reports.ts", "const cfg = {\n  token: ZERO_REPORTS().token,\n};\n");
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("[watched] token: zeroReports.token still passes in .ts", () => {
    const f = write("member.ts", "const cfg = {\n  token: zeroReports.token,\n};\n");
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("[watched] token: computeTally(x) still passes in .ts", () => {
    const f = write("call.ts", "const cfg = {\n  token: computeTally(x),\n};\n");
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("[watched] a member expression inside markdown inline code still passes", () => {
    const f = write(
      "doc.md",
      "- leak-check `credential-assignment` on `token: someObject.token` — (b) detector corrected\n",
    );
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("the SAME member expression, NOT inside inline code, blocks in markdown", () => {
    // Confirms the markdown exception is really "inside a closed inline-code
    // span", not "markdown gets the carve-out too".
    const f = write("doc2.md", "leak-check credential-assignment on token: someObject.token plain text\n");
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("doc2.md:1: credential-assignment");
  });
});

// ---------------------------------------------------------------------------
// PR #35 review — F2: the backtick fix from the #33 round was itself unsafe —
// it hid a backtick-quoted template literal entirely, and truncated a value
// with an INTERIOR backtick down to whatever came before it.
// ---------------------------------------------------------------------------

describe("leak-check.ts — F2: backtick-quoted values, and interior vs. closing backticks", () => {
  test("[watched] token: `<24+ chars>` (a JS template literal) still blocks", () => {
    const f = write("tpl.ts", `token: \`${FAKE.templateLiteral}\`\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("tpl.ts:1: credential-assignment");
    // Never code-exempt, even though the .ts carve-out would otherwise apply.
  });

  test("[watched] a value with an interior backtick (not closing anything) still blocks", () => {
    const content = "token" + ": abc" + "`" + FAKE.templateLiteral + "\n";
    const f = write("tpl-interior.ts", content);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("tpl-interior.ts:1: credential-assignment");
  });

  test("a backtick-quoted placeholder is still recognised as a placeholder (not flagged)", () => {
    const f = write("tpl-placeholder.ts", "token: `changeme`\n");
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PR #35 review — F3: an honoured exemption echoed its reason unscrubbed,
// which made the marker itself a disclosure channel. Fix: scan the reason
// with every rule before honouring; withhold it (never print it) if it
// contains a finding; scrub ids/emails from a reason that IS printed.
// ---------------------------------------------------------------------------

describe("leak-check.ts — F3: a reason that itself contains a finding is never honoured or printed", () => {
  test("[watched] reviewer case 1 — reason contains a secret-shaped fragment: withheld, still blocks", () => {
    const bare = "Qx7f".repeat(10);
    const f = write(
      "f3-case1.ts",
      `token: ${bare} // leak-check:allow credential-assignment — contains ${FAKE.awsKeyId} accidentally\n`,
    );
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("f3-case1.ts:1: credential-assignment");
    expect(r.output).toContain("reason withheld: contains a finding");
    expect(r.output).not.toContain(FAKE.awsKeyId);
    expect(r.output).not.toContain(bare);
  });

  test("[watched] reviewer case 2 — marker BEFORE the credential (it ends up inside the reason): not suppressed", () => {
    const bare = "Qx7f".repeat(10);
    const f = write("f3-case2.ts", `// leak-check:allow credential-assignment — note token: ${bare}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("f3-case2.ts:1: credential-assignment");
    expect(r.output).toContain("reason withheld: contains a finding");
    expect(r.output).not.toContain(bare);
  });

  test("[watched] reviewer case 3 — an operator-denylisted term in the reason: withheld, term never printed", () => {
    const patterns = write("denylist.txt", "AcmeVoltaic\n");
    const bare = "Qx7f".repeat(10);
    const f = write(
      "f3-case3.ts",
      `secret: ${bare} // leak-check:allow credential-assignment — mentions AcmeVoltaic internally\n`,
    );
    const r = run([f, "--patterns", patterns]);
    expect(r.exitCode).toBe(1);
    // Still blocks on the denylist hit regardless (unrelated rule, untouched
    // by a marker naming credential-assignment)...
    expect(r.output).toContain("f3-case3.ts:1: denylist[1]");
    // ...and the credential-assignment exemption is ALSO refused, so the
    // term never reaches the [EXEMPT] line either.
    expect(r.output).toContain("f3-case3.ts:1: credential-assignment");
    expect(r.output).toContain("reason withheld: contains a finding");
    expect(r.output).not.toContain("AcmeVoltaic");
  });

  test("a reason with no finding in it is honoured and printed normally (regression guard)", () => {
    const f = write(
      "f3-clean.ts",
      `secret: my${FAKE.credential} // leak-check:allow credential-assignment — synthetic fixture value, used only in this test\n`,
    );
    const r = run([f]);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("1 exemption(s) honoured");
    expect(r.output).toContain("synthetic fixture value");
  });
});

// ---------------------------------------------------------------------------
// PR #35 review — F6: a marker with trailing text but no `—`/`--` separator
// suppressed nothing and warned nothing, leaving the author no hint why.
// ---------------------------------------------------------------------------

describe("leak-check.ts — F6: a marker with no separator warns", () => {
  test("[watched] leak-check:allow <rule> <reason, no dash> blocks AND warns", () => {
    const f = write(
      "no-sep.ts",
      `secret: my${FAKE.credential} // leak-check:allow credential-assignment this explains nothing\n`,
    );
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("no-sep.ts:1: credential-assignment");
    expect(r.output.toLowerCase()).toContain("separator");
  });
});

// ---------------------------------------------------------------------------
// Issue #37 — `credential-assignment`'s key alternation was anchored with a
// plain `\b`, which never fires between two word characters, and `_` IS a
// word character. `FOO_TOKEN=`, `foo_secret=` etc. produced 0 findings on
// main. Fix: match the key name as the LAST SEGMENT of an identifier —
// preceded by a non-alnum separator (including `_`, previously excluded) or
// a genuine camelCase transition — not only as a fully standalone word.
//
// "[watched]" tests here were confirmed to give 0 findings against
// origin/main and are expected to block after the fix.
// ---------------------------------------------------------------------------

describe("leak-check.ts — issue #37: SCREAMING_SNAKE env-style credential keys", () => {
  // Every combination below is 0 findings on origin/main (the `_` before the
  // key word defeats `\b`) and must block after the fix.
  const keys = ["DISCORD_TOKEN", "GITLAB_TOKEN", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY"];
  const shapes: [string, string, (key: string, value: string) => string][] = [
    [".env", "dotenv", (key, value) => `${key}=${value}\n`],
    [".yml", "yaml", (key, value) => `${key}: ${value}\n`],
    [".sh", "shell script (export)", (key, value) => `export ${key}=${value}\n`],
  ];

  for (const key of keys) {
    for (const [ext, label, render] of shapes) {
      test(`[watched] ${key}= (40-char synthetic value) in a ${label} file is flagged`, () => {
        const f = write(`fixture${ext}`, render(key, FAKE.envValue));
        const r = run([f]);
        expect(r.exitCode).toBe(1);
        expect(r.output).toContain("credential-assignment");
        expect(r.output).not.toContain(FAKE.envValue);
      });
    }
  }
});

describe("leak-check.ts — issue #37: last-segment matching, other identifier shapes", () => {
  test("[watched] a kebab-case key (foo-api-key) is flagged", () => {
    const f = write("kebab.yml", `foo-api-key: ${FAKE.envValue}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("credential-assignment");
  });

  test("[watched] a camelCase key (fooSecret) is flagged", () => {
    const f = write("camel.ts", `fooSecret = ${FAKE.envValue}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("credential-assignment");
  });

  test("[watched] a PascalCase-suffixed key (FooPassword) is flagged", () => {
    const f = write("pascal.yml", `FooPassword: ${FAKE.envValue}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("credential-assignment");
  });

  // Regression guards: the widened leading boundary must not create new
  // false positives on ordinary identifiers where the credential word is a
  // PREFIX, not the last segment, of a longer name — the trailing boundary
  // (unchanged by this issue) already excludes these, and stays excluded.
  test("tokenizer = <value> is not flagged (credential word is a prefix, not the last segment)", () => {
    const f = write("tokenizer.ts", `const tokenizer = ${FAKE.envValue};\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("secretaryName = <value> is not flagged", () => {
    const f = write("secretary.ts", `const secretaryName = ${FAKE.envValue};\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("keyboard = <value> is not flagged (\"key\" alone is not a credential word)", () => {
    const f = write("keyboard.ts", `const keyboard = ${FAKE.envValue};\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  // DECISION (see the file header): a type annotation's declared name is
  // never specially cased — it is excluded by the same last-segment rule as
  // any other identifier. "password" is a prefix of "passwordField", not its
  // last segment, so the pattern never matches at all.
  test('passwordField: string (a type annotation) is not flagged', () => {
    const f = write("type-annotation.ts", "interface Cfg {\n  passwordField: string;\n}\n");
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("a lowercase run with no separator and no case transition (mytoken) is not flagged", () => {
    const f = write("mytoken.ts", `const mytoken = ${FAKE.envValue};\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #37 — zero-width characters (U+200B–U+200D, U+FEFF) slipped past the
// denylist (and every built-in rule): spliced into the middle of a
// denylisted term, they break the literal substring match while leaving the
// text visually unchanged. Fix: strip them from scanned content before any
// rule or the denylist runs.
// ---------------------------------------------------------------------------

describe("leak-check.ts — issue #37: zero-width characters are stripped before matching", () => {
  test("[watched] a denylisted term split by a zero-width character is still caught", () => {
    // Uses the test harness's own operator-pattern mechanism (--patterns),
    // same as the existing operator-pattern tests above — not a built-in
    // rule. The zero-width character is assembled at runtime, never typed
    // literally next to the term it splits.
    const patterns = write("denylist.txt", "SilverBirchLedger\n");
    const zeroWidthSpace = "​";
    const content = "Silver" + "Birch" + zeroWidthSpace + "Ledger" + " appears in this document\n";
    const f = write("doc.md", content);
    const r = run([f, "--patterns", patterns]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("denylist[1]");
    expect(r.output).toContain("doc.md:1");
  });

  test("[watched] a built-in credential shape split by a zero-width character is still caught", () => {
    const zeroWidthJoiner = "‍";
    const content = "DISCORD" + "_" + "TO" + zeroWidthJoiner + "KEN" + "=" + FAKE.envValue + "\n";
    const f = write("zw.env", content);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("credential-assignment");
  });

  test("a zero-width character elsewhere on a clean line does not create a false positive", () => {
    const zeroWidthNonJoiner = "‌";
    const content = "Just" + zeroWidthNonJoiner + " prose about governance, nothing sensitive here.\n";
    const f = write("clean-zw.md", content);
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #37 — the last-segment widening reaches a dotted/nested property key
// it never used to (`doc.x.api_token = "…"`, `{ cloudflare_api_token: "…" }`)
// — a shape a test fixture commonly uses to assert that a field NAME alone
// trips a different check, paired with a hand-written English disclaimer as
// the "value", not a credential. Found by this issue's own factory-scan
// probe (metafactory-factory-website): 0 findings on origin/main, 2 new
// ones on the widened rule, both this shape. Fix: widen the PLACEHOLDER
// prefix-word list (your/my/sample/fake/example/dummy/replace) to also
// recognise not/should/never as a placeholder-prefix stand-in.
// ---------------------------------------------------------------------------

describe("leak-check.ts — issue #37: English-disclaimer placeholders on a dotted/nested key", () => {
  test("a dotted property assignment with a 'not-a-real-…' placeholder is not flagged", () => {
    const f = write(
      "fixture.mjs",
      'doc.environment.hosting.api_token = "not-a-real-value-for-this-test";\n',
    );
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("an object-literal key with a 'should-never-…' placeholder is not flagged", () => {
    const f = write(
      "fixture.mjs",
      '({ cloudflare_api_token: "should-never-appear-in-output" });\n',
    );
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("'not'/'should'/'never' only suppress as a hyphenated PREFIX — a real value merely containing one of those words still blocks", () => {
    // Guards against the widened PLACEHOLDER list being loose enough to
    // swallow a real secret that happens to start with one of these words
    // with no separator — same shape as the existing `mysecretvalue123`
    // guard for your/my/sample/fake/example/dummy/replace.
    const bare = "notreallyasecretvalue1234567890";
    const f = write("real.env", `API_KEY=${bare}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("credential-assignment");
  });
});
