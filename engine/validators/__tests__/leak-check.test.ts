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
  // #42 review, F1 — a 36-character base64url-ish synthetic value (letters +
  // digits, no hyphen/underscore of its own) for the `not-`/`should-`/`never-`
  // prefix guard tests.
  base64ish36: "Qx7f".repeat(9),
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

// ---------------------------------------------------------------------------
// PR #42 review, F1 — the first cut's `(?:not|should|never)[-_][a-z0-9_-]*`
// prefix shared the same single-separator shape as your/my/sample/etc., and
// that character class is (almost) the whole base64url alphabet: ANY value
// starting `not-`/`not_`/`should-`/`never-` was swallowed regardless of what
// followed, including a real secret or a human password that merely starts
// with one of those words. Fix: require at least two MORE hyphen-separated,
// letter-only words after the lead word — the shape of the two factory
// fixtures this was widened for, not the shape of a real secret.
//
// "[watched]" tests were confirmed to PASS EVERY RULE (0 findings) on this
// branch's pre-review head (`ec9baa2`) and are BLOCKED after the fix.
// ---------------------------------------------------------------------------

describe("leak-check.ts — #42 review F1: not/should/never only suppress a hyphenated ENGLISH PHRASE", () => {
  const b64 = FAKE.base64ish36; // 36 chars, letters + digits, no separator of its own

  // Titles below describe the shape without spelling "<keyword><separator>"
  // as literal adjacent text — that phrase is what credential-assignment
  // looks for, and this test file's own source is itself scanned. See the
  // file's opening note: no credential-shaped literal appears in this file.
  test("[watched] a 'token' key with a not-prefixed 36-char base64url-ish value (.yml) still blocks", () => {
    const f = write("f1-1.yml", `token: not-${b64}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("credential-assignment");
  });

  test("[watched] a 'token' key with a quoted not_-prefixed 36-char value (.ts) still blocks", () => {
    const f = write("f1-2.ts", `token: "not_${b64}"\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("credential-assignment");
  });

  test("[watched] a 'token' key with a should-prefixed 36-char value (.yml) still blocks", () => {
    const f = write("f1-3.yml", `token: should-${b64}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("credential-assignment");
  });

  test("[watched] a 'token' key with an uppercase NOT-prefixed 36-char value (.yml) still blocks", () => {
    const f = write("f1-4.yml", `token: NOT-${b64.toUpperCase()}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("credential-assignment");
  });

  test("[watched] an env-style TOKEN key with a never-prefixed 36-char value still blocks", () => {
    const f = write("f1-5.env", `API_TOKEN=never-${b64}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("credential-assignment");
  });

  test("[watched] a human password of the shape not_my_password_2024 still blocks", () => {
    // Built from fragments, and the key/separator/value are separate string
    // literals — never contiguous "password" + ":" as raw source text.
    const f = write("f1-6.ts", "password" + ": " + "not_my_password_2024" + "\n");
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("credential-assignment");
  });

  test("[watched] a human password of the shape never-guess-me-99 still blocks", () => {
    const f = write("f1-7.ts", "password" + ": " + "never-guess-me-99" + "\n");
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("credential-assignment");
  });

  test("never<36-char value>, no separator, still blocks (regression guard — was already correct)", () => {
    const f = write("f1-8.ts", `token: never${b64}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("credential-assignment");
  });

  // Controls: the two factory-fixture shapes this widening exists for must
  // still pass, both before and after the F1 tightening. Built from
  // fragments, key/separator/value as separate concatenated literals — same
  // convention as the fixtures above, and required by this test file's own
  // header rule (no credential-shaped literal in source): a *pinned older*
  // engine without this PR's PLACEHOLDER widening has no reason to treat
  // "not-a-real-token" as a placeholder, so the literal phrase, written
  // contiguously, is exactly the shape credential-assignment matches.
  test('control: "not-a-real-token" is still not flagged', () => {
    const f = write("f1-control-1.ts", "password" + ": " + '"not-a-real-token"' + "\n");
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test('control: "should-never-be-here" is still not flagged', () => {
    const f = write("f1-control-2.ts", "password" + ": " + '"should-never-be-here"' + "\n");
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PR #42 review, F2 — `firstAcceptedMatch` resumed each retry at the END of
// a rejected candidate match. Before the boundary rule moved into the regex
// itself, a rejected candidate (`token` inside `mytoken`, matched only
// because the old `/i`-folded lookbehind let the engine consider it) had its
// own greedy unquoted-value capture run to the next whitespace — swallowing
// a REAL key embedded in that "value" with no space before it. Fix: the
// boundary rule now lives in the regex (case-explicit key alternation, no
// `/i` flag), so the engine never produces that candidate at all — nothing
// is ever swallowed, and the retry loop stays linear.
//
// "[watched]" tests were confirmed to PASS EVERY RULE (0 findings) on this
// branch's pre-review head (`ec9baa2`) and are BLOCKED after the fix.
// ---------------------------------------------------------------------------

describe("leak-check.ts — #42 review F2: a rejected candidate must not swallow the next real key", () => {
  test("[watched] ?mytoken=abc&auth_token=<40> — the real key after an unmatched 'mytoken' still blocks", () => {
    const f = write("f2-1.txt", `GET /path?mytoken=abc&auth_token=${FAKE.envValue}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("credential-assignment");
  });

  test("[watched] GITTOKEN=a&AUTH_TOKEN=<40> — the real key after a no-separator 'GITTOKEN' still blocks", () => {
    const f = write("f2-2.env", `GITTOKEN=a&AUTH_TOKEN=${FAKE.envValue}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("credential-assignment");
  });

  test("[watched] atoken=token=<40> — the real key after a lowercase-attached 'atoken' still blocks", () => {
    const f = write("f2-3.txt", `atoken=token=${FAKE.envValue}\n`);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("credential-assignment");
  });

  test("a 140 KB line of repeated 'atoken=' finishes in well under 2s (no pathological backtracking)", () => {
    const line = "atoken=".repeat(20000); // ~140 KB
    const f = write("f2-timing-140k.txt", line + "\n");
    const start = Date.now();
    const r = run([f]);
    const elapsedMs = Date.now() - start;
    expect(r.exitCode).toBe(0); // no real key anywhere on the line — clean
    expect(elapsedMs).toBeLessThan(2000);
  });

  test("a 700 KB line of repeated 'atoken=' finishes in under 2s", () => {
    const line = "atoken=".repeat(100000); // ~700 KB
    const f = write("f2-timing-700k.txt", line + "\n");
    const start = Date.now();
    const r = run([f]);
    const elapsedMs = Date.now() - start;
    expect(r.exitCode).toBe(0);
    expect(elapsedMs).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// PR #42 review — U+2060 WORD JOINER and U+00AD SOFT HYPHEN split a
// denylisted term or a credential key just as invisibly as the four
// characters #37 already covered (U+200B–D, U+FEFF), and both still passed
// every rule before this fix.
// ---------------------------------------------------------------------------

describe("leak-check.ts — #42 review: U+2060 and U+00AD are also stripped", () => {
  test("[watched] a denylisted term split by U+2060 WORD JOINER is caught", () => {
    const patterns = write("denylist-wj.txt", "CobaltMeridian\n");
    const wordJoiner = "⁠";
    const content = "Cobalt" + wordJoiner + "Meridian" + " appears in this document\n";
    const f = write("wj.md", content);
    const r = run([f, "--patterns", patterns]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("denylist[1]");
  });

  test("[watched] a denylisted term split by U+00AD SOFT HYPHEN is caught", () => {
    const patterns = write("denylist-sh.txt", "AmberFathom\n");
    const softHyphen = "­";
    const content = "Amber" + softHyphen + "Fathom" + " appears in this document\n";
    const f = write("sh.md", content);
    const r = run([f, "--patterns", patterns]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("denylist[1]");
  });

  test("[watched] a built-in credential shape split by U+2060 is caught", () => {
    const wordJoiner = "⁠";
    const content = "DISCORD" + "_" + "TO" + wordJoiner + "KEN" + "=" + FAKE.envValue + "\n";
    const f = write("wj.env", content);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("credential-assignment");
  });

  test("[watched] a built-in credential shape split by U+00AD is caught", () => {
    const softHyphen = "­";
    const content = "DISCORD" + "_" + "TO" + softHyphen + "KEN" + "=" + FAKE.envValue + "\n";
    const f = write("sh.env", content);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("credential-assignment");
  });

  test("U+2060/U+00AD elsewhere on a clean line do not create a false positive", () => {
    const wordJoiner = "⁠";
    const softHyphen = "­";
    const content = "Just" + wordJoiner + " prose" + softHyphen + " about governance, nothing sensitive.\n";
    const f = write("clean-invisible.md", content);
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #46 — `credential-assignment`'s key alternation required the key
// word to be followed directly (mod whitespace) by `:`/`=`. A QUOTED key —
// the shape every JSON file, cloud service-account file, package.json-style
// config, and JS/TS object with quoted keys actually uses — has a closing
// quote sitting between the key and the separator, so the rule never even
// produced a candidate match there: `{"token": "<secret>"}` gave zero
// findings. Fix: a new leading alternative matching a whole quoted key —
// `"KEY"` or `'KEY'`, literal matching quote pair, no backreference (so the
// existing value capture groups m[1]..m[4] stay unshifted) — alongside the
// existing unquoted, boundary-based alternatives. See CRED_KEY_QUOTED in
// leak-check.ts.
//
// Every fixture below is built at RUNTIME via the quotedKV helper, never as
// `"token": "<value>"` contiguous literal text in this file's own source —
// this file is itself scanned by leak-check, and (per this issue's own fix)
// a literal quoted-key shape in source is now a real finding, not a
// synthetic one. Credential-shaped key words are additionally split across
// string-literal fragments ("to" + "ken"), matching this file's existing
// convention, so no keyword is ever contiguous in source either.
//
// "[watched]" tests were confirmed to give 0 findings against origin/main
// (4a69f59) — see the PR body for the captured output — and are BLOCKED
// after the fix.
// ---------------------------------------------------------------------------

/**
 * Builds `"key": "value"` (or `'key': 'value'`) without the shape ever
 * appearing as contiguous literal text in this file's source — see the note
 * above.
 */
function quotedKV(key: string, value: string, quote: '"' | "'" = '"'): string {
  return quote + key + quote + ":" + " " + quote + value + quote;
}

describe("leak-check.ts — issue #46: quoted credential keys", () => {
  test('[watched] {"token": "<40>"} in a .json file is flagged', () => {
    const key = "to" + "ken";
    const content = "{" + quotedKV(key, FAKE.envValue) + "}\n";
    const f = write("f46-1.json", content);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("f46-1.json:1: credential-assignment");
    expect(r.output).not.toContain(FAKE.envValue);
  });

  test('[watched] {"api_key": "<40>"} in a .json file is flagged', () => {
    const key = "api" + "_key";
    const content = "{" + quotedKV(key, FAKE.envValue) + "}\n";
    const f = write("f46-2.json", content);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("f46-2.json:1: credential-assignment");
  });

  test("[watched] {'secret': '<40>'} in a .ts file is flagged", () => {
    const key = "sec" + "ret";
    const content = "const cfg = {" + quotedKV(key, FAKE.envValue, "'") + "};\n";
    const f = write("f46-3.ts", content);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("f46-3.ts:1: credential-assignment");
  });

  test("[watched] a nested service-account-shaped object with a quoted key is flagged", () => {
    const key = "cli" + "ent_secret";
    const line3 = "  " + quotedKV(key, FAKE.envValue) + ",\n";
    const content = "{\n" + '  "type": "service_account",\n' + line3 + "}\n";
    const f = write("f46-4.json", content);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("f46-4.json:3: credential-assignment");
  });

  // Regression guards: the new quoted-key alternative must keep the same
  // last-segment / placeholder / quote-pairing discipline as the unquoted
  // branches, not become a looser match.
  test('a quoted "tokenizer" key is not flagged (last-segment rule holds for quoted keys too)', () => {
    const key = "token" + "izer";
    const content = "{" + quotedKV(key, FAKE.envValue) + "}\n";
    const f = write("f46-5.json", content);
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test('a quoted key with a placeholder value ("changeme") is still not flagged', () => {
    const key = "to" + "ken";
    const content = "{" + quotedKV(key, "change" + "me") + "}\n";
    const f = write("f46-6.json", content);
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("mismatched quote types around the key do not pair up (no match)", () => {
    const key = "to" + "ken";
    const dq = '"';
    const sq = "'";
    const content = "{" + dq + key + sq + ": " + dq + FAKE.envValue + dq + "}\n";
    const f = write("f46-7.json", content);
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("a quoted key with an unquoted, code-expression-shaped value in .json still blocks (JSON has no code — no exemption)", () => {
    // Answers the issue's last box directly: a JSON *value* is always a
    // string/number/bool/null/object/array — never a code expression — so
    // there is nothing to exempt. isCodeFile's extension list already
    // excludes .json; this pins that an unquoted, member-expression-shaped
    // value after a quoted JSON key is never accidentally given the .ts
    // code-expression carve-out.
    const key = "to" + "ken";
    const dq = '"';
    const value = "zeroReports" + "." + "token"; // shaped like the .ts code-expression carve-out
    const content = "{" + dq + key + dq + ": " + value + "}\n";
    const f = write("f46-8.json", content);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("f46-8.json:1: credential-assignment");
  });
});

// ---------------------------------------------------------------------------
// Review on #46, B1 — the first cut's CRED_KEY_QUOTED required the WHOLE
// quoted content to equal a bare CRED_KEYS word, which is narrower than the
// unquoted branches: those accept the keyword as the LAST SEGMENT after a
// `_`/`-` separator or a camelCase transition (issue #37). Realistic quoted
// keys with exactly that shape — `"refresh_token"`/`"access_token"` in an
// OAuth token cache or a gcloud `authorized_user` credential file,
// `"OPENAI_API_KEY"`/`"GITHUB_TOKEN"` in an MCP or Claude `settings.json`
// `env` block, `"botToken"` in a bot `config.json` — were missed, quoted,
// even though their unquoted forms were already caught.
//
// Fix: CRED_KEY_QUOTED now allows the same two boundary shapes inside the
// quotes that the unquoted branches already use (an optional prefix ending
// in `_`/`-`, or a prefix ending in a lowercase→uppercase camelCase step
// feeding CRED_KEY_UPPER_FIRST) — see CRED_KEY_QUOTED's own comment in
// leak-check.ts.
//
// "[watched]" tests were confirmed to give 0 findings against this PR's
// pre-review head (24df365) — see the PR body for the captured output —
// and are BLOCKED after the fix. N1 pins the negative the reviewer flagged
// as missing (a bare letter-run prefix with no boundary must not match, the
// mutation-surviving gap) alongside the existing "tokenizer" guard.
// ---------------------------------------------------------------------------

describe("leak-check.ts — #46 review B1: quoted keys keep the unquoted branches' prefix/boundary allowance", () => {
  const jsonCases: [string, string][] = [
    ["f46-b1-1.json", "refresh" + "_" + "token"], // snake_case prefix
    ["f46-b1-2.json", "access" + "_" + "token"], // snake_case prefix
    ["f46-b1-3.json", "id" + "_" + "token"], // short snake_case prefix
    ["f46-b1-4.json", "OPENAI" + "_" + "API" + "_" + "KEY"], // CONST_CASE prefix, compound keyword
    ["f46-b1-5.json", "GITHUB" + "_" + "TOKEN"], // CONST_CASE prefix
    ["f46-b1-6.json", "refresh" + "Token"], // camelCase prefix
    ["f46-b1-7.json", "bot" + "Token"], // short camelCase prefix
  ];

  for (const [name, key] of jsonCases) {
    // N5 (review on #46 round 2): a title built from key.slice(-5) collided
    // ("token" x3, "Token" x2) — a failure couldn't point at one case. The
    // fixture file name is unique per case and never itself credential-
    // shaped, so it's used here instead.
    test(`[watched] a quoted key is flagged in .json (${name})`, () => {
      const content = "{" + quotedKV(key, FAKE.envValue) + "}\n";
      const f = write(name, content);
      const r = run([f]);
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain(`${name}:1: credential-assignment`);
      expect(r.output).not.toContain(FAKE.envValue);
    });
  }

  test('[watched] the same camelCase-prefixed quoted key is flagged in .ts too', () => {
    const key = "refresh" + "Token";
    const content = "const cfg = {" + quotedKV(key, FAKE.envValue) + "};\n";
    const f = write("f46-b1-8.ts", content);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("f46-b1-8.ts:1: credential-assignment");
  });

  test('[N1] a quoted key with an arbitrary letter prefix and no boundary ("pretoken") is not flagged', () => {
    const key = "pre" + "token";
    const content = "{" + quotedKV(key, FAKE.envValue) + "}\n";
    const f = write("f46-n1-1.json", content);
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test('a quoted all-uppercase run with no separator and no camelCase transition ("MYTOKEN") is not flagged', () => {
    const key = "MY" + "TOKEN";
    const content = "{" + quotedKV(key, FAKE.envValue) + "}\n";
    const f = write("f46-n1-2.json", content);
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test('a quoted "tokenizer" key (keyword as a PREFIX, not the last segment) is still not flagged', () => {
    const key = "token" + "izer";
    const content = "{" + quotedKV(key, FAKE.envValue) + "}\n";
    const f = write("f46-n1-3.json", content);
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test('a quoted "passwordField" key (a type-annotation-style name, keyword as a PREFIX) is not flagged', () => {
    const key = "password" + "Field";
    const content = "{" + quotedKV(key, FAKE.envValue) + "}\n";
    const f = write("f46-n1-4.json", content);
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Review on #46 round 2, B2 — B1's fix widened the quoted prefix boundary to
// `[A-Za-z0-9_-]*[_-]` / `[A-Za-z0-9_-]*[a-z]`, but the UNQUOTED boundary
// (`(?<![A-Za-z0-9])`) accepts ANY non-alphanumeric character before the
// key, not only `_`/`-`. A dotted key (Spring Boot / VS Code
// `settings.json`-style: `"spring.datasource.password"`, `"<ext>.apiKey"`)
// or a colon-separated key (`"aws:secret"`) was still missed quoted while
// caught unquoted.
//
// Fix: CRED_KEY_QUOTED's prefix now runs up to its own branch's closing
// quote (`[^"\n]*`/`[^'\n]*`) and requires the character immediately before
// the keyword to be non-alphanumeric (not a fixed `[_-]` class) — see
// CRED_KEY_QUOTED's own comment in leak-check.ts. This makes the quoted
// boundary the SAME set of accepted preceding characters as the unquoted
// one, not merely similar to it.
//
// "[watched]" tests were confirmed to give 0 findings against this PR's
// pre-round-3-review head (9c71592) and are BLOCKED after the fix.
// `"x-api-key"` specifically pins the `-` (kebab-case) prefix character,
// the mutation (M12 in the review) that survived round 2's tests.
// ---------------------------------------------------------------------------

describe("leak-check.ts — #46 review B2: the quoted boundary accepts ANY non-alphanumeric character, not only _/-", () => {
  // The `.`/`:` cases below were 0 findings at this PR's pre-round-3-review
  // head (9c71592) — genuinely "[watched]". `-` (kebab-case) was ALREADY
  // handled correctly by round 2's `[_-]` class; it had no dedicated test
  // (the review's M12 mutation — dropping `-` from that class — survived
  // for exactly that reason), so it's pinned separately below WITHOUT the
  // "[watched]" tag, since it does not fail at 9c71592.
  const jsonCases: [string, string][] = [
    ["f46-b2-1.json", "spring" + "." + "datasource" + "." + "password"], // dotted prefix
    ["f46-b2-2.json", "github" + "." + "token"], // short dotted prefix
    ["f46-b2-4.json", "aws" + ":" + "secret"], // colon-separated prefix
  ];

  for (const [name, key] of jsonCases) {
    test(`[watched] a quoted key with a non-alnum-separated prefix is flagged in .json (${name})`, () => {
      const content = "{" + quotedKV(key, FAKE.envValue) + "}\n";
      const f = write(name, content);
      const r = run([f]);
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain(`${name}:1: credential-assignment`);
      expect(r.output).not.toContain(FAKE.envValue);
    });
  }

  test("a quoted kebab-case-prefixed key is flagged in .json (f46-b2-3.json) — pins M12 (dropping '-' from the boundary class survived round 2's tests)", () => {
    const key = "x" + "-" + "api" + "-" + "key";
    const content = "{" + quotedKV(key, FAKE.envValue) + "}\n";
    const f = write("f46-b2-3.json", content);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("f46-b2-3.json:1: credential-assignment");
    expect(r.output).not.toContain(FAKE.envValue);
  });

  test("[watched] the same dotted-prefix quoted key is flagged in .ts too", () => {
    const key = "github" + "." + "token";
    const content = "const cfg = {" + quotedKV(key, FAKE.envValue) + "};\n";
    const f = write("f46-b2-5.ts", content);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("f46-b2-5.ts:1: credential-assignment");
  });

  // Regression guards, re-pinned at this boundary too (unchanged per the
  // review): a letter-run prefix, an all-uppercase run with no transition,
  // the keyword as a prefix rather than the last segment, and a
  // type-annotation-style name all still don't match.
  test('a quoted key with an arbitrary letter prefix and no boundary ("pretoken") is still not flagged', () => {
    const key = "pre" + "token";
    const content = "{" + quotedKV(key, FAKE.envValue) + "}\n";
    const f = write("f46-b2-n1.json", content);
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test('a quoted all-uppercase run with no separator and no camelCase transition ("MYTOKEN") is still not flagged', () => {
    const key = "MY" + "TOKEN";
    const content = "{" + quotedKV(key, FAKE.envValue) + "}\n";
    const f = write("f46-b2-n2.json", content);
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test('a quoted "tokenizer" key is still not flagged', () => {
    const key = "token" + "izer";
    const content = "{" + quotedKV(key, FAKE.envValue) + "}\n";
    const f = write("f46-b2-n3.json", content);
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test('a quoted "passwordField" key is still not flagged', () => {
    const key = "password" + "Field";
    const content = "{" + quotedKV(key, FAKE.envValue) + "}\n";
    const f = write("f46-b2-n4.json", content);
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Review on #46 round 2, N4 — the factory scan (metafactory-factory-website)
// turned up a synthetic fixture whose quoted `*_token` value is a
// hyphenated, all-caps, multi-word phrase that labels itself a placeholder
// (contains words like "example"/"not"/"redacted"/"token") but whose FIRST
// word — a single-word placeholder like `redacted` — was recognised only as
// a whole value, not as a phrase head. `leak-check:allow` can't resolve
// this (line-scoped, needs a comment; JSON has no comment syntax), so
// editing the fixture would be a change made only to pass the detector —
// refused per this repo's own #30/#33 precedent. Fix: PLACEHOLDER_PHRASE_HEAD
// widens the phrase-head set from `not`/`should`/`never` to every
// single-word placeholder already recognised as a whole value, so a
// hyphenated, 2-or-more-more-word, all-letter phrase starting with ANY of
// them is recognised — case-insensitively — under the SAME shape
// (`(?:-[a-z]{1,12}){2,}`) that already protected `not`/`should`/`never`
// from swallowing a real secret or password.
//
// The fixture below is a SYNTHETIC value built for this shape, not the
// factory fixture's actual text — a different placeholder head
// ("placeholder" itself) and a different phrase.
//
// "[watched]" against this PR's pre-round-3-review head (9c71592).
// ---------------------------------------------------------------------------

describe("leak-check.ts — #46 review N4: the placeholder phrase-head set covers every whole-value placeholder word", () => {
  test('[watched] a quoted key whose value is a hyphenated ALL-CAPS phrase headed by "placeholder" is not flagged', () => {
    const key = "api" + "_token";
    const value = "PLACEHOLDER" + "-" + "EXAMPLE" + "-" + "VALUE" + "-" + "ONLY";
    const content = "{" + quotedKV(key, value) + "}\n";
    const f = write("f46-n4-1.json", content);
    const r = run([f]);
    expect(r.exitCode).toBe(0);
  });

  test("a hyphenated phrase whose FIRST word is a random 40-char token is still flagged (the head must be a real placeholder word)", () => {
    const key = "api" + "_token";
    const value = FAKE.envValue + "-not-real"; // 40-char synthetic "random" head, not a placeholder word
    const content = "{" + quotedKV(key, value) + "}\n";
    const f = write("f46-n4-2.json", content);
    const r = run([f]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("f46-n4-2.json:1: credential-assignment");
    expect(r.output).not.toContain(FAKE.envValue);
  });
});
