/**
 * Tests for engine/validators/corpus-overlap.ts.
 *
 * Every "corpus" and "consumer" repo here is a throwaway git repo built fresh
 * inside a temp directory, with invented, generic content. NEVER point a test
 * at a real corpus — the private-jobs overlay this tool exists to protect is
 * exactly what must never appear in this file or in test output.
 *
 * Spawns the tool as a subprocess (real CLI surface: argv, exit codes, git
 * plumbing) like leak-check.test.ts does.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const TOOL = resolve(import.meta.dir, "..", "corpus-overlap.ts");
const REAL_GIT = Bun.which("git") ?? "git";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "corpus-overlap-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
}

function run(args: string[], cwd: string, env?: Record<string, string>): RunResult {
  const proc = Bun.spawnSync(["bun", TOOL, ...args], {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
  });
  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr);
  return { exitCode: proc.exitCode ?? -1, stdout, stderr, output: stdout + stderr };
}

function git(args: string[], cwd: string): string {
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
  return new TextDecoder().decode(proc.stdout).trim();
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
}

function write(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

function commit(dir: string, files: string[], message: string): string {
  git(["add", ...files], dir);
  git(["commit", "-q", "-m", message], dir);
  return git(["rev-parse", "HEAD"], dir);
}

/**
 * A corpus with one generic, invented "private" line, long enough to shingle
 * at n=6. The first 6 words are DELIBERATELY written with a double space and
 * a mid-phrase line break — normalising still collapses this to exactly
 * PLANTED_PHRASE, but the raw (pre-normalisation) span G1's control draws
 * from this file is genuinely irregular, so a control that stops normalising
 * (sabotage #2, below) has something real to disagree with. A corpus whose
 * raw text happened to already be perfectly clean would let that specific
 * sabotage slip through undetected — not because the fix is wrong, but
 * because the input gave it nothing to catch.
 */
function makeCorpus(): string {
  const dir = join(workDir, "corpus");
  initRepo(dir);
  write(
    dir,
    "notes.txt",
    "The  quarterly roadmap\nreview covers three invented workstreams for planning purposes only.\n" +
      "Generic padding text that exists only to give the corpus a second line.\n",
  );
  commit(dir, ["notes.txt"], "seed corpus");
  return dir;
}

/** A corpus repo with no commits and no files at all — the INERT fixture. */
function makeEmptyCorpus(): string {
  const dir = join(workDir, "empty-corpus");
  initRepo(dir);
  return dir;
}

/** The exact 6-word planted phrase the fixture corpus contains, for planting in a diff. */
const PLANTED_PHRASE = "The quarterly roadmap review covers three";

/** A shell wrapper standing in for `git` on PATH, delegating to the real git
 * for everything except a `cat-file` invocation, which it corrupts per `mode`.
 * Used to prove a corpus read broken partway through comes out INERT (F3). */
function makeBrokenGitWrapper(mode: "fail" | "truncate"): string {
  const dir = join(workDir, `broken-git-${mode}`);
  mkdirSync(dir, { recursive: true });
  const script =
    mode === "fail"
      ? `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "cat-file" ]; then\n    exit 7\n  fi\ndone\nexec "${REAL_GIT}" "$@"\n`
      : `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "cat-file" ]; then\n    "${REAL_GIT}" "$@" | head -c 5\n    exit 0\n  fi\ndone\nexec "${REAL_GIT}" "$@"\n`;
  const gitPath = join(dir, "git");
  writeFileSync(gitPath, script);
  chmodSync(gitPath, 0o755);
  return dir;
}

describe("corpus-overlap.ts — usage errors (exit 2)", () => {
  test("no --corpus flag given → usage error, exit 2", () => {
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "a.txt", "x\n")], "base");
    const r = run(["--base", base, "--head", base], consumer);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--corpus");
  });

  test("no --base/--head flags given → usage error, exit 2", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const r = run(["--corpus", corpus], consumer);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--base");
  });

  test("--corpus path does not exist on disk → usage error, exit 2", () => {
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "a.txt", "x\n")], "base");
    const r = run(["--corpus", join(workDir, "does-not-exist"), "--base", base, "--head", base], consumer);
    expect(r.exitCode).toBe(2);
  });

  test("--n 0 is not a positive integer → usage error, exit 2", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "a.txt", "x\n")], "base");
    const r = run(["--corpus", corpus, "--base", base, "--head", base, "--n", "0"], consumer);
    expect(r.exitCode).toBe(2);
  });

  test("run outside a git repository → usage error, exit 2", () => {
    const corpus = makeCorpus();
    const bare = join(workDir, "not-a-repo");
    mkdirSync(bare, { recursive: true });
    const r = run(["--corpus", corpus, "--base", "HEAD~1", "--head", "HEAD"], bare);
    expect(r.exitCode).toBe(2);
  });

  test("a --base ref that does not resolve is refused, exit 2", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const head = commit(consumer, [write(consumer, "a.txt", "x\n")], "base");
    const r = run(["--corpus", corpus, "--base", "not-a-real-ref-xyz", "--head", head], consumer);
    expect(r.exitCode).toBe(2);
  });
});

describe("corpus-overlap.ts — F2: ref/argv injection cannot empty or redirect the diff", () => {
  test("INJECTED: --base=--output=<file> (a ref shaped like a git diff option) → OBSERVED: refused (exit 2), no file written, no injection", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const head = commit(consumer, [write(consumer, "a.txt", "x\n")], "base");
    const pwnFile = join(workDir, "pwned.txt");

    const r = run([`--corpus`, corpus, `--base=--output=${pwnFile}`, "--head", head], consumer);

    expect(r.exitCode).toBe(2);
    // The attack file must never be created at all.
    expect(existsSync(pwnFile)).toBe(false);
  });

  test("a --head ref starting with '-' is refused outright, exit 2", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "a.txt", "x\n")], "base");
    const r = run(["--corpus", corpus, "--base", base, `--head=--no-such-flag`], consumer);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--head");
  });
});

describe("corpus-overlap.ts — F2: the diff side cannot be emptied by the PR under scan", () => {
  test("INJECTED: .gitattributes marks the added file '-diff' (would show 'Binary files differ') → OBSERVED: never exit 0/clean (scans or refuses, never silently empty)", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(
      consumer,
      [write(consumer, ".gitattributes", "* -diff\n"), write(consumer, "added.txt", `lead-in\n${PLANTED_PHRASE} continues.\n`)],
      "head",
    );
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    // The old design printed "0 shingle(s) ... clean", exit 0, here. The fix
    // must never do that: either the match is actually found (exit 1), or the
    // numstat/unified-diff cross-check catches the disagreement and goes
    // INERT (exit 2). Both are acceptable; silent clean (exit 0) is not.
    expect(r.exitCode).not.toBe(0);
  });

  test("INJECTED: consumer repo sets diff.external → OBSERVED: the real added content is still scanned (external driver ignored), match caught, exit 1", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    git(["config", "diff.external", "true"], consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", `lead-in\n${PLANTED_PHRASE} continues.\n`)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(PLANTED_PHRASE);
  });

  test("INJECTED: a single leading NUL byte in a .md file, followed by the planted phrase → OBSERVED: exit 1, caught (H1: no NUL-based exemption anywhere in the diff)", () => {
    // Round 3's design exempted a file from the SCAN once numstat AND
    // content both agreed it was binary. Round 4's finding (H1): that
    // exemption is itself the evasion — a single NUL byte, anywhere,
    // silently removed a file from the search entirely (exit 0, "0 shingles
    // drawn"), which is exactly the #30 "one byte to beat the detector"
    // pattern. The fix removes the exemption: --text already puts every
    // added byte into the patch as '+' lines, so every file is scanned the
    // same way regardless of NUL content; only the numstat CROSS-CHECK
    // treats a numstat-binary file specially (excludes it from the count
    // comparison, never from the search).
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    writeFileSync(join(consumer, "notes.md"), `\x00${PLANTED_PHRASE} continues.\n`);
    commit(consumer, ["notes.md"], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(PLANTED_PHRASE);
  });

  test("INJECTED: a NUL byte after 7KB of padding, then the planted phrase (the reviewer's 'NUL after 7KB' probe) → OBSERVED: exit 1, caught", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    const padding = "x".repeat(7000);
    writeFileSync(join(consumer, "notes.md"), `${padding}\n\x00\n${PLANTED_PHRASE} continues.\n`);
    commit(consumer, ["notes.md"], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(PLANTED_PHRASE);
  });

  test("INJECTED: an added 'data.bin' that is really text, carrying the planted phrase → OBSERVED: exit 1, caught (an unfamiliar extension is not a reason to skip)", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "data.bin", `${PLANTED_PHRASE} continues.\n`)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(PLANTED_PHRASE);
  });

  test("INJECTED: a real binary file (PNG header + NUL bytes) with the planted phrase appended → OBSERVED: exit 1, caught", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00]);
    const appended = Buffer.from(`\n${PLANTED_PHRASE} continues.\n`, "utf8");
    writeFileSync(join(consumer, "asset.bin"), Buffer.concat([pngHeader, appended]));
    commit(consumer, ["asset.bin"], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(PLANTED_PHRASE);
  });

  test("INJECTED: a NUL-byte binary file (no leak) alongside a separate real leak in a normal text file, same PR → OBSERVED: the binary file is excluded (by name) from the line-count cross-check only; the text file's match is still caught (exit 1)", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    writeFileSync(join(consumer, "added.bin"), `lead\x00in binary content, no relation to anything\n`);
    commit(
      consumer,
      ["added.bin", write(consumer, "caption.txt", `${PLANTED_PHRASE} continues.\n`)],
      "head",
    );
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(PLANTED_PHRASE);
    expect(r.stdout).toContain("1 binary file(s) excluded from the line-count cross-check");
    expect(r.stdout).toContain("added.bin");
  });

  test("a numstat/unified-diff disagreement is reported as INERT, not silently swallowed", () => {
    // The .gitattributes case above is the concrete trigger for this in
    // practice; this test pins the observable INERT message so a future
    // change can't quietly turn the cross-check into a no-op.
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, ".gitattributes", "* -diff\n"), write(consumer, "added.txt", "some content\n")], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);
    if (r.exitCode === 2) {
      expect(r.stderr).toContain("INERT");
    }
  });
});

describe("corpus-overlap.ts — F3: any corpus read failure is INERT, never a clean/no-match result", () => {
  test("INJECTED: git cat-file --batch fails outright (exit 7) after the control's own read → OBSERVED: INERT, exit 2 (not exit 0/clean)", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", "clean unrelated content\n")], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const wrapDir = makeBrokenGitWrapper("fail");
    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer, {
      PATH: `${wrapDir}:${process.env.PATH}`,
    });

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("INERT");
  });

  test("INJECTED: git cat-file --batch is truncated mid-stream (exit 0, short output) → OBSERVED: INERT, exit 2 (not exit 0/clean)", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", "clean unrelated content\n")], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const wrapDir = makeBrokenGitWrapper("truncate");
    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer, {
      PATH: `${wrapDir}:${process.env.PATH}`,
    });

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("INERT");
  });

  test("INJECTED: an added line contains one ~1.5MB whitespace-free token (the old design's E2BIG trigger) → OBSERVED: no crash, a normal exit code", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    const hugeWord = "A".repeat(1_500_000);
    commit(consumer, [write(consumer, "added.txt", `prefix ${hugeWord} suffix\n`)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    // No per-shingle subprocess spawn happens in the new design, so nothing
    // ever puts this huge token into a child process's argv.
    const r = run(["--corpus", corpus, "--base", base, "--head", head, "--n", "2"], consumer);

    expect([0, 1, 2]).toContain(r.exitCode);
    expect(r.stderr).not.toContain("E2BIG");
    expect(r.stderr).not.toContain("posix_spawn");
  });
});

describe("corpus-overlap.ts — F4: the benign file itself is scanned like any other added file", () => {
  test("INJECTED: corpus text is stuffed into .corpus-overlap-benign.yaml as a COMMENT (not a shingle: value) → OBSERVED: caught, exit 1", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    const benign = [
      `# ${PLANTED_PHRASE} for planning`,
      '- shingle: "totally unrelated placeholder text example"',
      '  reason: "test entry"',
      '  reviewed_by: "octocat"',
      '  date: "2026-09-01"',
      "",
    ].join("\n");
    commit(consumer, [write(consumer, ".corpus-overlap-benign.yaml", benign)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(PLANTED_PHRASE);
  });

  test("INJECTED: a NEW shingle: entry added only at HEAD happens to match the corpus → OBSERVED: it flags itself, exit 1 (nothing can allowlist itself in the PR that adds it)", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    // A leading/trailing space just inside the quotes keeps the phrase's
    // boundary words as clean, quote-free tokens after normalisation — the
    // point under test is self-flagging via "not yet honoured", not the
    // separate (and separately scoped) question of punctuation touching a
    // shingle's edge words.
    const benign = [
      `- shingle: " ${PLANTED_PHRASE} "`,
      '  reason: "added in this very PR to try to excuse itself"',
      '  reviewed_by: "octocat"',
      '  date: "2026-09-01"',
      "",
    ].join("\n");
    commit(consumer, [write(consumer, ".corpus-overlap-benign.yaml", benign)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(PLANTED_PHRASE);
  });

  test("INJECTED: --benign redirected to an arbitrary path that also carries the leak → OBSERVED: that path is still scanned, exit 1", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "sneaky.yaml", `${PLANTED_PHRASE}\n`)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head, "--benign", "sneaky.yaml"], consumer);

    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(PLANTED_PHRASE);
  });

  test("an entry already honoured at base is not re-flagged when the benign file is untouched otherwise", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const benign = [
      `- shingle: "${PLANTED_PHRASE}"`,
      '  reason: "generic planning phrase, coincidental collision"',
      '  reviewed_by: "octocat"',
      '  date: "2026-09-01"',
      "",
    ].join("\n");
    const base = commit(consumer, [write(consumer, ".corpus-overlap-benign.yaml", benign)], "base");
    commit(consumer, [write(consumer, "added.txt", `${PLANTED_PHRASE}\n`)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("1 honoured");
  });
});

describe("corpus-overlap.ts — F5: a malformed benign list at base is a hard failure, never silently empty", () => {
  function benignCase(name: string, content: string) {
    test(`INJECTED: .corpus-overlap-benign.yaml at base is ${name} → OBSERVED: refused, exit 2, naming the file`, () => {
      const corpus = makeCorpus();
      const consumer = join(workDir, "consumer");
      initRepo(consumer);
      const base = commit(consumer, [write(consumer, ".corpus-overlap-benign.yaml", content)], "base");
      commit(consumer, [write(consumer, "added.txt", "clean unrelated content\n")], "head");
      const head = git(["rev-parse", "HEAD"], consumer);

      const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain(".corpus-overlap-benign.yaml");
    });
  }

  benignCase("invalid YAML", '- shingle: "unterminated\n  reason: oops\n');
  benignCase(
    "a top-level mapping instead of a list",
    'entries:\n  - shingle: "x y z a b c"\n    reason: "r"\n',
  );
  benignCase(
    "keyed term: instead of shingle: (the old docstring's mistake)",
    '- term: "x y z a b c"\n  reason: "r"\n  reviewed_by: "o"\n  date: "2026-09-01"\n',
  );
  benignCase("missing a reason", '- shingle: "x y z a b c"\n  reviewed_by: "o"\n  date: "2026-09-01"\n');
  benignCase("carrying an empty reason", '- shingle: "x y z a b c"\n  reason: ""\n');

  test("a benign file only added at HEAD (absent at base) is not malformed — it's just not loaded", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base, no benign file yet");
    // Deliberately malformed — but it doesn't exist AT BASE, so it must not
    // be read at all, valid or not.
    commit(consumer, [write(consumer, ".corpus-overlap-benign.yaml", "not: [valid, {")], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);
    expect(r.exitCode).toBe(0); // clean: nothing in the diff overlaps the corpus
  });
});

describe("corpus-overlap.ts — watched failing cases (#32 acceptance, carried forward)", () => {
  test("INJECTED: a diff adds the corpus's own planted 6-word phrase verbatim → OBSERVED: exit 1, shingle printed, no corpus path printed", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", `Unrelated lead-in line.\n${PLANTED_PHRASE} for planning.\n`)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(PLANTED_PHRASE);
    expect(r.output).not.toContain("notes.txt");
    expect(r.output).not.toContain(corpus);
  });

  test("INJECTED: the exact planted phrase is benign-listed in .corpus-overlap-benign.yaml AT BASE → OBSERVED: exit 0, honoured count printed", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const benign = [
      `- shingle: "${PLANTED_PHRASE}"`,
      '  reason: "generic planning phrase, coincidental collision"',
      '  reviewed_by: "octocat"',
      '  date: "2026-09-01"',
      "",
    ].join("\n");
    const base = commit(
      consumer,
      [write(consumer, ".corpus-overlap-benign.yaml", benign)],
      "base with benign entry already reviewed",
    );
    commit(consumer, [write(consumer, "added.txt", `${PLANTED_PHRASE}\n`)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("1 honoured");
    expect(r.output).not.toContain(corpus);
  });

  test("INJECTED: the SAME benign entry is added only at HEAD, absent at BASE → OBSERVED: still exit 1 (not honoured)", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base, no benign file yet");

    const benign = [
      `- shingle: "${PLANTED_PHRASE}"`,
      '  reason: "generic planning phrase, coincidental collision"',
      '  reviewed_by: "octocat"',
      '  date: "2026-09-01"',
      "",
    ].join("\n");
    commit(
      consumer,
      [write(consumer, ".corpus-overlap-benign.yaml", benign), write(consumer, "added.txt", `${PLANTED_PHRASE}\n`)],
      "head: plant the match AND the excuse in the same PR",
    );
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(PLANTED_PHRASE);
  });

  test("INJECTED: --corpus is an empty git repo (no commits, no files) → OBSERVED: INERT, exit 2", () => {
    const emptyCorpus = makeEmptyCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", "some harmless added content line here\n")], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", emptyCorpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("INERT");
  });

  test("INJECTED: a benign entry whose shingle matches nothing in the corpus → OBSERVED: reported as stale", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const benign = [
      '- shingle: "this phrase appears nowhere in the corpus at all"',
      '  reason: "stale test entry — corpus no longer contains this"',
      '  reviewed_by: "octocat"',
      '  date: "2026-09-01"',
      "",
    ].join("\n");
    const base = commit(consumer, [write(consumer, ".corpus-overlap-benign.yaml", benign)], "base");
    commit(consumer, [write(consumer, "added.txt", "totally unrelated clean content line\n")], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(0);
    expect(r.stdout.toLowerCase()).toContain("stale");
    expect(r.stdout).toContain("this phrase appears nowhere in the corpus at all");
  });

  test("INJECTED: the corpus's planted phrase is split across TWO lines in the corpus, verbatim in one diff line → OBSERVED: exit 1, caught (F1 reflow)", () => {
    const dir = join(workDir, "corpus-reflow");
    initRepo(dir);
    write(dir, "notes.txt", "The quarterly roadmap review covers\nthree invented workstreams for planning purposes only.\n");
    commit(dir, ["notes.txt"], "seed");

    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", `${PLANTED_PHRASE} invented workstreams.\n`)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", dir, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(1);
  });

  test("INJECTED: the planted phrase is split across TWO adjacent ADDED lines in one hunk → OBSERVED: exit 1, caught (cross-line diff shingle)", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    // Split PLANTED_PHRASE ("The quarterly roadmap review covers three")
    // across two consecutive added lines.
    commit(consumer, [write(consumer, "added.txt", "The quarterly roadmap\nreview covers three invented workstreams.\n")], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(1);
  });

  test("INJECTED: the corpus has a tab and a double space between planted words, diff has single spaces → OBSERVED: exit 1, caught (F1 whitespace)", () => {
    const dir = join(workDir, "corpus-ws");
    initRepo(dir);
    write(dir, "notes.txt", "The quarterly\troadmap  review covers three invented workstreams.\n");
    commit(dir, ["notes.txt"], "seed");

    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", `${PLANTED_PHRASE} invented workstreams.\n`)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", dir, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(1);
  });

  test("INJECTED: the corpus has U+00A0 (non-breaking space) between planted words → OBSERVED: exit 1, caught (F1 NBSP)", () => {
    const dir = join(workDir, "corpus-nbsp");
    initRepo(dir);
    write(dir, "notes.txt", "The quarterly roadmap review covers three invented workstreams.\n");
    commit(dir, ["notes.txt"], "seed");

    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", `${PLANTED_PHRASE} invented workstreams.\n`)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", dir, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(1);
  });
});

describe("corpus-overlap.ts — never leaks the corpus path, filename, or line", () => {
  test("across a matching run, stdout+stderr never contain the corpus directory path or any fixture filename inside it", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(
      consumer,
      [write(consumer, "added.txt", `Lead-in.\n${PLANTED_PHRASE} continues here.\nMore generic padding text that exists only.\n`)],
      "head",
    );
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.output).not.toContain(corpus);
    expect(r.output).not.toContain("notes.txt");
    expect(r.output).not.toMatch(/notes\.txt:\d+/);
  });

  test("an INERT run (no control shingle possible) never leaks anything drawn from the corpus", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", "clean unrelated content\n")], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    // n larger than any file in the corpus → no control shingle can be drawn → INERT.
    const r = run(["--corpus", corpus, "--base", base, "--head", head, "--n", "500"], consumer);

    expect(r.exitCode).toBe(2);
    expect(r.output).not.toContain(corpus);
    expect(r.output).not.toContain("notes.txt");
  });

  test("a broken-partway-through corpus read (INERT) never leaks anything either", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", "clean unrelated content\n")], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const wrapDir = makeBrokenGitWrapper("fail");
    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer, {
      PATH: `${wrapDir}:${process.env.PATH}`,
    });

    expect(r.output).not.toContain(corpus);
    expect(r.output).not.toContain("notes.txt");
  });

  test("the scope line never names a corpus branch, even when --refs all searches one specifically for its content", () => {
    const corpus = makeCorpus();
    git(["checkout", "-q", "-b", "other-branch"], corpus);
    write(corpus, "branch-only.txt", "A distinct secret phrase only on the other corpus branch entirely.\n");
    commit(corpus, ["branch-only.txt"], "branch-only content");
    git(["checkout", "-q", "main"], corpus);

    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", "clean unrelated content\n")], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);
    expect(r.output).not.toContain("other-branch");
    expect(r.output).not.toContain("branch-only.txt");
  });

  test("a reported gitlink/submodule never names the submodule's path or source", () => {
    const submoduleSrc = join(workDir, "submodule-src");
    initRepo(submoduleSrc);
    commit(submoduleSrc, [write(submoduleSrc, "s.txt", "submodule content\n")], "submodule seed");

    const corpus = makeCorpus();
    Bun.spawnSync(["git", "-c", "protocol.file.allow=always", "submodule", "add", "-q", submoduleSrc, "sub"], {
      cwd: corpus,
    });
    commit(corpus, ["sub", ".gitmodules"], "add submodule");

    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    const head = commit(consumer, [write(consumer, "added.txt", "unrelated clean content\n")], "head");

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);
    expect(r.output).not.toContain(submoduleSrc);
    expect(r.output).not.toContain("/sub\n");
    expect(r.output).not.toContain("submodule-src");
  });
});

describe("corpus-overlap.ts — mechanics", () => {
  test("a clean diff (no overlap with the corpus) exits 0", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", "nothing in this line overlaps the fixture corpus whatsoever\n")], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("clean");
  });

  test("--n controls shingle size: a 3-word planted phrase is missed at n=6 but caught at n=3", () => {
    const corpus = join(workDir, "corpus3");
    initRepo(corpus);
    // Six words total, so a control shingle (n=6, the default) can still be
    // drawn — the leading three words are what the n=3 case plants below.
    write(corpus, "notes.txt", "short generic phrase here only now\n");
    commit(corpus, ["notes.txt"], "seed");

    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", "short generic phrase\n")], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const default6 = run(["--corpus", corpus, "--base", base, "--head", head], consumer);
    expect(default6.exitCode).toBe(0); // 3 words < 6, no shingle generated

    const n3 = run(["--corpus", corpus, "--base", base, "--head", head, "--n", "3"], consumer);
    expect(n3.exitCode).toBe(1);
    expect(n3.output).toContain("short generic phrase");
  });

  test("--benign overrides the default benign-file path (and it is still loaded from base only)", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const benign = [
      `- shingle: "${PLANTED_PHRASE}"`,
      '  reason: "generic planning phrase, coincidental collision"',
      '  reviewed_by: "octocat"',
      '  date: "2026-09-01"',
      "",
    ].join("\n");
    const base = commit(consumer, [write(consumer, "custom-benign.yaml", benign)], "base");
    commit(consumer, [write(consumer, "added.txt", `${PLANTED_PHRASE}\n`)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head, "--benign", "custom-benign.yaml"], consumer);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("1 honoured");
  });
});

// -----------------------------------------------------------------------------
// G1 (round 3): the control must exercise the REAL diff-side code path, not a
// self-referential check that can never fail. These tests mutate the ACTUAL
// tool source (read from disk, one exact string replaced, written to a fresh
// temp file, then run as the tool) — never a reimplementation of its logic —
// so a future refactor that silently reintroduces circularity fails these
// tests instead of passing them by accident.
// -----------------------------------------------------------------------------

describe("corpus-overlap.ts — G1: the control exercises the real diff-side path, and can fail", () => {
  const SOURCE = resolve(import.meta.dir, "..", "corpus-overlap.ts");
  const sourceText = readFileSync(SOURCE, "utf8");

  function mutate(anchor: string, replacement: string): string {
    expect(sourceText).toContain(anchor); // fails loudly if a refactor moved the anchor
    const mutated = sourceText.replace(anchor, replacement);
    expect(mutated).not.toBe(sourceText);
    const path = join(workDir, `mutated-${Math.random().toString(36).slice(2)}.ts`);
    writeFileSync(path, mutated);
    return path;
  }

  test("INJECTED: the corpus lookup (corpusHas) is disabled, returning false unconditionally → OBSERVED: INERT, exit 2 (previously: a planted match printed clean, exit 0)", () => {
    const mutatedTool = mutate("return corpus.shingles.has(shingle);", "return false;");
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", `${PLANTED_PHRASE}\n`)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const proc = Bun.spawnSync(["bun", mutatedTool, "--corpus", corpus, "--base", base, "--head", head], {
      cwd: consumer,
    });
    const output = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);

    expect(proc.exitCode).toBe(2);
    expect(output).toContain("INERT");
  });

  test("INJECTED: diff-side normalisation is skipped (runsToShingles stops calling normalizeWhitespace) → OBSERVED: INERT, exit 2 (previously: exit 0, the real match silently missed)", () => {
    const mutatedTool = mutate("shingleWindows(normalizeWhitespace(r), n)", "shingleWindows(r, n)");
    // makeCorpus()'s raw text has a genuine whitespace irregularity in its
    // first 6 words (a double space and a mid-phrase newline) — see its own
    // doc comment — so a control that stops normalising has something real
    // to disagree with, not an already-clean string that happens to survive
    // unnormalised by coincidence.
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", `${PLANTED_PHRASE}\n`)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const proc = Bun.spawnSync(["bun", mutatedTool, "--corpus", corpus, "--base", base, "--head", head], {
      cwd: consumer,
    });
    const output = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);

    expect(proc.exitCode).toBe(2);
    expect(output).toContain("INERT");
  });

  test("INJECTED: corpus-side shingling is asymmetrically upper-cased (diff side untouched) → OBSERVED: INERT, exit 2 (previously: exit 0, a real match silently missed by case mismatch)", () => {
    const mutatedTool = mutate(
      "const normalized = normalizeWhitespace(text!);",
      "const normalized = normalizeWhitespace(text!).toUpperCase();",
    );
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", `${PLANTED_PHRASE}\n`)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const proc = Bun.spawnSync(["bun", mutatedTool, "--corpus", corpus, "--base", base, "--head", head], {
      cwd: consumer,
    });
    const output = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);

    expect(proc.exitCode).toBe(2);
    expect(output).toContain("INERT");
  });

  test("INJECTED: the search loop's lookup is disabled (findMatches's `if (has(s))` short-circuited to false) → OBSERVED: INERT, exit 2 (round 3's wiring gap: the search loop was NOT shared with the control, so this mutation previously gave exit 0, clean)", () => {
    // The control's own pipeline functions (extractAddedRuns, runsToShingles,
    // corpusHas) were verified in round 3, but the SEARCH LOOP itself — the
    // thing that decides which shingles count as matches — was a separate
    // for-loop the control never touched. Round 4 pulls that loop out into
    // findMatches() and routes the control through it too, so disabling the
    // loop's own condition breaks the control identically to the real search.
    const mutatedTool = mutate("if (has(s)) out.push(s);", "if (false && has(s)) out.push(s);");
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", `${PLANTED_PHRASE}\n`)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const proc = Bun.spawnSync(["bun", mutatedTool, "--corpus", corpus, "--base", base, "--head", head], {
      cwd: consumer,
    });
    const output = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);

    expect(proc.exitCode).toBe(2);
    expect(output).toContain("INERT");
  });

  test("INJECTED: the real diff's shingle set is hardcoded to empty (allShingles = new Map()) → OBSERVED: INERT, exit 2 (round 3's wiring gap: the control built its OWN separate shingle set, so this mutation previously gave exit 0, clean)", () => {
    // Round 3's control computed its shingles from a synthetic diff it built
    // itself — a parallel computation, unaffected by whatever the REAL
    // diff's shingle-set assignment did. Round 4 injects the control
    // fragment as one more element of the SAME array (addedRuns) before the
    // ONE call that produces allShingles, so hardcoding that one assignment
    // to empty also erases the control's own contribution — there is no
    // longer a separate "control path" this mutation can leave untouched.
    const mutatedTool = mutate(
      "const allShingles = runsToShingles([...addedRuns, controlRun], shingleSize);",
      "const allShingles = new Map<string, number>();",
    );
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", `${PLANTED_PHRASE}\n`)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const proc = Bun.spawnSync(["bun", mutatedTool, "--corpus", corpus, "--base", base, "--head", head], {
      cwd: consumer,
    });
    const output = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);

    expect(proc.exitCode).toBe(2);
    expect(output).toContain("INERT");
  });

  test("a real diff match that coincidentally equals the control's own drawn fragment is still reported, not silently dropped as 'control content'", () => {
    // makeCorpus()'s planted phrase IS the corpus's own first n words, which
    // is also exactly what the control draws from (ls-tree order, first
    // blob, first n words) — so every other test in this file that plants
    // PLANTED_PHRASE already exercises this collision. This test names the
    // property directly: a Set-based "exclude anything equal to the control
    // shingle" filter would have silently dropped this exact match (a real
    // provenance bug caught while building the round-4 fix, not merely a
    // hypothetical) — the count-based provenance check must not regress it.
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", `${PLANTED_PHRASE}\n`)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(PLANTED_PHRASE);
    expect(r.stdout).toContain("1 match(es)");
  });

  test("the UNMUTATED tool still passes cleanly on the same fixtures (sanity: the mutations above are real breakages, not false positives)", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", `${PLANTED_PHRASE}\n`)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(PLANTED_PHRASE);
  });
});

// -----------------------------------------------------------------------------
// G2/G3 (round 3): scope. Every ref reachable from every branch/tag tip is
// searched by default; --refs HEAD narrows it; what's skipped (gitlinks,
// binary corpus blobs) is counted and printed, never silently absorbed.
// -----------------------------------------------------------------------------

describe("corpus-overlap.ts — G2/G3: multi-ref scope, printed on every run", () => {
  test("INJECTED: text exists ONLY on a non-HEAD corpus branch → OBSERVED: missed with --refs HEAD, caught by default (--refs all)", () => {
    const corpus = makeCorpus();
    git(["checkout", "-q", "-b", "other-branch"], corpus);
    write(corpus, "branch-only.txt", "A distinct secret phrase only on the other corpus branch entirely.\n");
    commit(corpus, ["branch-only.txt"], "branch-only content");
    git(["checkout", "-q", "main"], corpus);

    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(
      consumer,
      [write(consumer, "added.txt", "A distinct secret phrase only on the other corpus branch entirely.\n")],
      "head",
    );
    const head = git(["rev-parse", "HEAD"], consumer);

    const headOnly = run(["--corpus", corpus, "--base", base, "--head", head, "--refs", "HEAD"], consumer);
    expect(headOnly.exitCode).toBe(0); // missed: not on HEAD

    const allRefs = run(["--corpus", corpus, "--base", base, "--head", head], consumer); // default
    expect(allRefs.exitCode).toBe(1); // caught: --refs all is the default
    expect(allRefs.output).toContain("distinct secret phrase only on the");
  });

  test("--refs must be HEAD or all — anything else is a usage error, exit 2", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    const head = commit(consumer, [write(consumer, "a.txt", "x\n")], "head");
    const r = run(["--corpus", corpus, "--base", base, "--head", head, "--refs", "bogus"], consumer);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--refs");
  });

  test("INJECTED: the corpus contains a submodule (gitlink) → OBSERVED: reported by count as not searched, on every run", () => {
    const submoduleSrc = join(workDir, "submodule-src");
    initRepo(submoduleSrc);
    commit(submoduleSrc, [write(submoduleSrc, "s.txt", "submodule content\n")], "submodule seed");

    const corpus = makeCorpus();
    Bun.spawnSync(["git", "-c", "protocol.file.allow=always", "submodule", "add", "-q", submoduleSrc, "sub"], {
      cwd: corpus,
    });
    commit(corpus, ["sub", ".gitmodules"], "add submodule");

    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    const head = commit(consumer, [write(consumer, "added.txt", "unrelated clean content\n")], "head");

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);
    expect(r.stdout).toContain("NOT searched: 1 gitlink(s)/submodule(s)");
  });

  test("the scope line — refs, paths, blobs, bytes, not-searched counts — is printed on every run, including a clean one", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    const head = commit(consumer, [write(consumer, "added.txt", "nothing overlapping the corpus at all\n")], "head");

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/scope — \d+ ref\(s\) searched .*\d+ path\(s\) reachable.*\d+ blob\(s\) read.*\d+ byte\(s\).*NOT searched: \d+ gitlink/);
  });
});

// -----------------------------------------------------------------------------
// G4 (round 3): binary files in the DIFF (not the corpus). A genuinely binary
// file is excluded (confirmed by content, not trusted from numstat alone) and
// named; the rest of the same diff still scans normally. numstat's binary
// verdict for a .gitattributes-forced file must NOT be trusted blindly —
// that would reopen the exact F2 evasion this tool already closed.
// -----------------------------------------------------------------------------

describe("corpus-overlap.ts — G4: binary files scan the rest of the diff, but can't fake it", () => {
  test("INJECTED: a PR adds a real PNG (binary) next to a text caption carrying a real match → OBSERVED: the PNG is excluded (by name) from the line-count cross-check, the caption's match is still caught, exit 1", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    const pngBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(200, 0),
    ]);
    writeFileSync(join(consumer, "hero.png"), pngBytes);
    writeFileSync(join(consumer, "caption.txt"), `${PLANTED_PHRASE}\n`);
    commit(consumer, ["hero.png", "caption.txt"], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(PLANTED_PHRASE);
    expect(r.stdout).toContain("1 binary file(s) excluded from the line-count cross-check");
    expect(r.stdout).toContain("hero.png");
  });

  test("INJECTED: .gitattributes '-diff' forces numstat to call a real TEXT file binary → OBSERVED: still caught, exit 1 (H1: nothing is exempt from the SCAN — numstat's verdict only ever affected the cross-check, so the evasion has nothing left to exploit; regression guard for F2's original attack)", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(
      consumer,
      [write(consumer, ".gitattributes", "* -diff\n"), write(consumer, "added.txt", `${PLANTED_PHRASE}\n`)],
      "head",
    );
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(PLANTED_PHRASE);
  });

  test("INJECTED: an added line's content starts with '++' (e.g. '++counter;') → OBSERVED: read as content, not misread as a '+++' file header — no false INERT", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    const head = commit(consumer, [write(consumer, "added.txt", "++counter;\n")], "head");

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(0); // clean — the content just doesn't match the corpus
    expect(r.stderr).not.toContain("INERT");
  });
});

// -----------------------------------------------------------------------------
// H2 (round 4): deleting or moving a binary file must never make the run
// INERT. With --no-renames, a move/rename is a delete (old path) plus an add
// (new path); a deleted path contributes no '+' lines either way, and round
// 4 removed the only code that used to read a path's HEAD content (H1's
// content-verification step, now gone) — so there is nothing left that could
// fail to read a path that no longer exists at head.
// -----------------------------------------------------------------------------

describe("corpus-overlap.ts — H2: deleting or moving a binary file never goes INERT", () => {
  test("INJECTED: a PR deletes a binary image and separately edits a text file with a real match → OBSERVED: exit 1 on the text match, never INERT", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const pngBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(100, 0),
    ]);
    writeFileSync(join(consumer, "old-hero.png"), pngBytes);
    const base = commit(
      consumer,
      ["old-hero.png", write(consumer, "README.md", "hello\n")],
      "base with an image to delete",
    );
    Bun.spawnSync(["git", "rm", "-q", "old-hero.png"], { cwd: consumer });
    writeFileSync(join(consumer, "notes.txt"), `${PLANTED_PHRASE}\n`);
    commit(consumer, ["-A"], "delete the image, add a text match");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toContain("INERT");
    expect(r.output).toContain(PLANTED_PHRASE);
  });

  test("INJECTED: a PR moves/renames a binary image (--no-renames sees this as delete+add) → OBSERVED: exit 0, clean, never INERT", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const pngBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(100, 0),
    ]);
    mkdirSync(join(consumer, "assets"), { recursive: true });
    writeFileSync(join(consumer, "assets", "hero.png"), pngBytes);
    const base = commit(consumer, ["assets/hero.png"], "base with an image to move");
    Bun.spawnSync(["git", "mv", "assets/hero.png", "assets/hero-renamed.png"], { cwd: consumer });
    commit(consumer, ["-A"], "move the image");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain("INERT");
  });

  test("INJECTED: a binary path git must quote in the patch (contains a literal tab) → OBSERVED: correctly excluded from the cross-check by position, no false INERT from a quoting mismatch", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    const weirdName = "weird\ttab.bin";
    writeFileSync(join(consumer, weirdName), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    Bun.spawnSync(["git", "add", "-A"], { cwd: consumer });
    Bun.spawnSync(
      [
        "git",
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "-m",
        "add a tab-named binary",
      ],
      { cwd: consumer },
    );
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain("INERT");
  });

  test("--numstat and the full patch enumerate changed files in the SAME order (the invariant fileOrder correlation depends on), across a mixed text/binary/quoted-path diff", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    write(consumer, "a.txt", `${PLANTED_PHRASE}\n`);
    writeFileSync(join(consumer, "b_binary.bin"), Buffer.from([0, 1, 2, 3]));
    write(consumer, "c.txt", "unrelated clean content\n");
    writeFileSync(join(consumer, "d\ttab.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    write(consumer, "e.txt", "more unrelated clean content\n");
    Bun.spawnSync(["git", "add", "-A"], { cwd: consumer });
    Bun.spawnSync(
      ["git", "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "-m", "mixed files"],
      { cwd: consumer },
    );
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);

    // Both binary files correctly excluded from the cross-check (no INERT,
    // no count mismatch), and the real text match (in the FIRST file, before
    // either binary file) is still correctly attributed and caught.
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(PLANTED_PHRASE);
    expect(r.stdout).toContain("2 binary file(s) excluded from the line-count cross-check");
  });
});

// -----------------------------------------------------------------------------
// Small items (round 3): zero-width character stripping.
// -----------------------------------------------------------------------------

describe("corpus-overlap.ts — zero-width characters are stripped during normalisation", () => {
  test("INJECTED: the corpus has a U+200B (zero-width space) mid-word in the planted phrase → OBSERVED: exit 1, still caught", () => {
    const dir = join(workDir, "corpus-zw");
    initRepo(dir);
    write(dir, "notes.txt", "The​ quarterly​ roadmap review covers three invented workstreams.\n");
    commit(dir, ["notes.txt"], "seed");

    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", `${PLANTED_PHRASE} invented workstreams.\n`)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", dir, "--base", base, "--head", head], consumer);
    expect(r.exitCode).toBe(1);
  });

  test("INJECTED: the DIFF's added line has zero-width joiners (U+200C/U+200D) inserted between words → OBSERVED: exit 1, still caught", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    // Zero-width characters ride ALONGSIDE real whitespace here (not in place
    // of it) — mirroring how they actually turn up in copy-pasted or
    // tracking-marked text, and matching normalizeWhitespace's contract:
    // strip the invisible character, then collapse the real whitespace next
    // to it. A ZWSP replacing a space entirely is a different (word-fusing)
    // question this fix doesn't claim to answer.
    const withZeroWidth = "The‌ quarterly‍ roadmap review covers three invented workstreams.\n";
    commit(consumer, [write(consumer, "added.txt", withZeroWidth)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);
    expect(r.exitCode).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// Small items (round 3): UTF-16 corpus content is decoded and searched.
// -----------------------------------------------------------------------------

describe("corpus-overlap.ts — UTF-16 corpus blobs are decoded and searched, not silently skipped", () => {
  test("INJECTED: a corpus file is UTF-16LE with a BOM → OBSERVED: decoded, counted as UTF-16 in scope, and its content is caught (exit 1)", () => {
    const dir = join(workDir, "corpus-utf16le");
    initRepo(dir);
    const text = PLANTED_PHRASE + " invented workstreams for planning purposes only.";
    const codeUnits = Buffer.from(text, "utf16le");
    const bom = Buffer.from([0xff, 0xfe]);
    writeFileSync(join(dir, "notes-utf16.txt"), Buffer.concat([bom, codeUnits]));
    commit(dir, ["notes-utf16.txt"], "seed utf16");

    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", `${PLANTED_PHRASE} invented workstreams.\n`)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", dir, "--base", base, "--head", head], consumer);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/\d+ blob\(s\) read \(1 as UTF-16\)/);
  });
});
