# SOP: Pull Request Review

**Purpose:** Standard procedure for reviewing PRs in any repo that adopts compass-core.
**Audience:** All contributors, agents, and reviewers.

---

## Pre-flight

After reading this SOP, output:
```
SOP: pr-review | PR: {owner/repo}#{N} | Workflow: {Standard/Security/Full}
```

Verify before proceeding:
- Identified the PR by `{owner}/{repo}#{number}`
- Picked the workflow appropriate for the diff scope
- Confirmed you are reviewing on a PR you have access to

---

## Staleness Check (mandatory before merge)

Before approving or merging any PR, verify the branch is up to date with the base branch:

```bash
# Check if the PR branch is behind base
gh pr view {N} --json mergeStateStatus --jq '.mergeStateStatus'
# If "BEHIND", the branch needs rebasing before merge
```

**Why this matters:** Squash merges on stale branches silently overwrite changes that landed on the base branch after the PR branch was created. There is no merge conflict — the host applies the PR's version of any file that both branches touched. This is not theoretical: it has caused real data loss, in one case overwriting 424 lines of working page implementations with 25-line stubs because the branch was 12 hours stale.

**Rule:** If the base branch has received commits touching any of the same files since the PR branch was created, the PR author must rebase or merge base into their branch before the PR can be approved. Review the updated diff after rebase to confirm no regressions.

---

## Workflows

| Workflow | When to use |
|----------|------------|
| **FullReview** | **Default.** All review lenses applied. Use for any non-trivial PR. |
| **SecurityReview** | Explicit security-only focus. Code quality + OWASP-oriented security analysis. Use when the PR touches auth, input validation, secrets handling, or dependencies. |
| **StandardReview** | Lightweight. Code quality + auto-detected lenses. Use only for trivial PRs (typo fixes, doc-only changes, dependency bumps). |
| **HardeningReview** | Defensive/adversarial pass for security-sensitive or trust-path code — abuse cases, input validation, failure modes beyond the OWASP surface. |
| **SweepReview** | Fix-or-justify sweep (`--fix` mode). Resolves each finding in place or records an explicit justification. See the **Sweep / --fix mode** section below. |

---

## Before you modify a PR (push a fix onto someone else's branch)

Reviewing may end in a fix you push to the PR's branch. Before you do, check
**where the branch lives** — many PRs come from a fork, and pushing to the wrong
remote silently misses the PR:

```bash
gh pr view {N} --json headRepository,headRepositoryOwner,maintainerCanModify \
  -q '.headRepositoryOwner.login+"/"+.headRepository.name+"  maintainerCanModify="+(.maintainerCanModify|tostring)'
```

- **Head repo is your own org** → push to `origin` as normal.
- **Head repo is a fork** → you can push only if `maintainerCanModify` is true,
  and you must push to the **fork's** branch, not `origin`. A push to `origin`
  creates a stray branch there that is **not** attached to the PR (a `git push`
  reporting `[new branch]` for a branch you expected to already exist is the
  tell). Add the fork as a remote (`git remote add fork <fork-url>`) and push to
  it, or use `gh pr checkout {N}` which wires the correct push target for you.

Base any such fix on the PR's real head first — see
[worktree-discipline: Basing a worktree on an existing PR](./worktree-discipline.md#basing-a-worktree-on-an-existing-pr).

---

## Review Lenses

Apply these lenses based on workflow and diff content:

| Lens | Scope |
|------|-------|
| **CodeQuality** | Error handling, dead code, naming, test coverage, commit hygiene (always applied) |
| **Security** | Injection, auth, data exposure, input validation, dependencies (OWASP) |
| **Architecture** | SRP, coupling, pattern consistency, abstraction, API surface |
| **Compliance** | CLAUDE.md present and valid, arc-manifest.yaml correct, labels applied per `compass.config.yaml`, SOP table present, conventional commits |
| **Performance** | N+1 queries, unbounded loops, missing pagination, memory leaks, blocking calls in async code |
| **Confidentiality** | Content your project classifies as non-public — client names, engagement codenames, real identities, secrets, private operational detail — leaking into code, tests, fixtures, or docs |
| **Hardening** | Defensive posture beyond OWASP — abuse cases, trust-path assumptions, fail-closed behaviour, error-handling completeness |

---

## Severity → Verdict

**This section is the single normative source of the review verdict contract.** The review procedure below, any review engine implementing this contract, and any autonomous merge gate must all resolve a review to a verdict the same way. If an implementation disagrees with this section, the implementation is wrong.

### 1. Severity vocabulary → finding buckets

Every finding carries one of four severities. Each maps to exactly one bucket:

| Severity | Bucket |
|----------|--------|
| `critical` | **blockers** |
| `warning` | **majors** |
| `suggestion` | **nits** |
| `nit` | **nits** |

### 2. Buckets → verdict

| Condition | Verdict |
|-----------|---------|
| `blockers > 0` **OR** `majors > 0` | `changes-requested` |
| only nits (`blockers == 0` **AND** `majors == 0` **AND** `nits > 0`) | `commented` |
| zero findings | `approved` |

**Canonical verdict tokens.** `changes-requested`, `commented`, and `approved` are the canonical verdict tokens — mapping to the `gh pr review --request-changes` / `--comment` / `--approve` actions respectively. This SOP is the single normative source for these tokens; any review tooling a project ships must conform to them rather than inventing its own spelling.

**Nit-only reviews do NOT block.** A review whose findings are all `suggestion`/`nit` resolves to `commented`, not `changes-requested` — the PR stays mergeable. This is deliberate: a zero-tolerance "any finding blocks" rule makes an autonomous loop fight itself over cosmetic nits and never converge. The contract is exactly three outcomes — `changes-requested` / `commented` / `approved`.

### 3. Confidentiality carve-out (non-waivable)

A **confidentiality `critical`** finding is a hard block: it forces `changes-requested` and is **NEVER waivable** — it cannot be downgraded, deferred, or justified past. It closes only by one of:

- **removal of the offending content** from the diff, or
- a **linked approval URL** where the party who owns the content has explicitly authorised the disclosure, recorded outside the public diff.

No reviewer — human or agent — may resolve a confidentiality critical any other way.

---

## Sweep / --fix mode

Review can run in **sweep (`--fix`) mode**: instead of only reporting findings, the reviewer resolves each one under a **fix-or-justify** contract — every finding is either fixed in place or given an explicit written justification for why it stands. This is the mode an autonomous work loop invokes per slice, rather than handing a report back to a human.

The verdict contract is unchanged in sweep mode: findings still carry the four severities above, and the sweep is complete only when every finding is either fixed or carries a recorded justification.

**Sweep mode respects the confidentiality carve-out.** A confidentiality `critical` (see the **Severity → Verdict** section) is **not** a "justify" candidate — it is never waivable, so in sweep mode it closes only by removing the content or linking an approval URL, exactly as in report mode. Every other finding may be fixed in place or justified.

---

## Review Procedure

1. **Read the PR description.** Understand the stated intent before reading code.
2. **Read the diff in full.** Don't review by skimming.
3. **Apply each lens systematically.** Note findings as you go.
4. **Assign each finding a severity** from the four-value vocabulary in **Severity → Verdict**: `critical`, `warning`, `suggestion`, or `nit`. Do not invent other severity words — the verdict mapping is defined only over these four.
5. **Post structured comments.** Per-finding inline comments are preferred over a single review essay.
6. **Resolve to a verdict** using the buckets table in **Severity → Verdict**, and post it with the matching `gh pr review` action. The verdict follows from the findings — it is not a separate judgement call.

## Custom Review Skill (optional)

If your project ships a custom code-review skill or plugin, prefer it over manual review — it can apply the lenses consistently and produce structured output. Any such tooling must implement the **Severity → Verdict** contract above unchanged. The compass-core governance skill exposes a `pr-review` workflow that codifies this procedure; consumer projects can extend it with project-specific lenses via `compass.config.yaml`.

---

*This SOP applies to any project that adopts compass-core. Review lenses are configurable; the severity vocabulary and verdict mapping are not.*
