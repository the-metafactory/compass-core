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
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const TOOL = resolve(import.meta.dir, "..", "corpus-overlap.ts");

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

function run(args: string[], cwd: string): RunResult {
  const proc = Bun.spawnSync(["bun", TOOL, ...args], { cwd });
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

/** A corpus with one generic, invented "private" line, long enough to shingle at n=6. */
function makeCorpus(): string {
  const dir = join(workDir, "corpus");
  initRepo(dir);
  write(
    dir,
    "notes.txt",
    "The quarterly roadmap review covers three invented workstreams for planning purposes only.\n" +
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
});

describe("corpus-overlap.ts — watched failing cases (#32 acceptance)", () => {
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
      "- shingle: \"" + PLANTED_PHRASE + "\"",
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
      "- shingle: \"" + PLANTED_PHRASE + "\"",
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
      "- shingle: \"this phrase appears nowhere in the corpus at all\"",
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

    // The corpus fixture's own paths must never appear anywhere in output.
    expect(r.output).not.toContain(corpus);
    expect(r.output).not.toContain("notes.txt");
    // Nor may the tool ever print a "path:line" style locator for the corpus.
    expect(r.output).not.toMatch(/notes\.txt:\d+/);
  });

  test("an INERT run never leaks the (unfindable) control shingle it drew from the corpus", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    commit(consumer, [write(consumer, "added.txt", "clean unrelated content\n")], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    // n larger than any line in the corpus → no control shingle can be drawn → INERT.
    const r = run(["--corpus", corpus, "--base", base, "--head", head, "--n", "500"], consumer);

    expect(r.exitCode).toBe(2);
    expect(r.output).not.toContain(corpus);
    expect(r.output).not.toContain("notes.txt");
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

  test("--benign overrides the default benign-file path", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const benign = [
      "- shingle: \"" + PLANTED_PHRASE + "\"",
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

  test("a benign entry missing the mandatory reason field is treated as absent — still exit 1", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const benign = ["- shingle: \"" + PLANTED_PHRASE + "\"", '  reviewed_by: "octocat"', '  date: "2026-09-01"', ""].join(
      "\n",
    );
    const base = commit(consumer, [write(consumer, ".corpus-overlap-benign.yaml", benign)], "base");
    commit(consumer, [write(consumer, "added.txt", `${PLANTED_PHRASE}\n`)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);
    expect(r.exitCode).toBe(1);
  });

  test("the benign list's own newly-added entry is not scanned as a match against itself", () => {
    const corpus = makeCorpus();
    const consumer = join(workDir, "consumer");
    initRepo(consumer);
    const base = commit(consumer, [write(consumer, "README.md", "hello\n")], "base");
    // Add ONLY the benign file at head, listing the planted phrase — this alone
    // must not register as an unreviewed match against its own addition.
    const benign = [
      "- shingle: \"" + PLANTED_PHRASE + "\"",
      '  reason: "pre-emptively documented, not yet used anywhere"',
      '  reviewed_by: "octocat"',
      '  date: "2026-09-01"',
      "",
    ].join("\n");
    commit(consumer, [write(consumer, ".corpus-overlap-benign.yaml", benign)], "head");
    const head = git(["rev-parse", "HEAD"], consumer);

    const r = run(["--corpus", corpus, "--base", base, "--head", head], consumer);
    expect(r.exitCode).toBe(0);
  });
});
