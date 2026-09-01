---
name: plan-breakdown
description: Break a detailed plan, review, or stocktake into an epic + executor-grade sub-issues a less capable model can implement with high quality, then run the auto-dev loop over them and close with an implementation-vs-findings review. USE WHEN break down this plan, plan breakdown, work breakdown, turn findings into issues, epic and sub-issues, make this executable by a smaller model, frontier to executor handoff, hand this to the dev loop, break down for Opus.
---

# /plan-breakdown — frontier planning → executor-grade work

Canonical procedure: **compass-core [`sops/plan-breakdown.md`](../../../sops/plan-breakdown.md)** ([github.com/the-metafactory/compass-core/blob/main/sops/plan-breakdown.md](https://github.com/the-metafactory/compass-core/blob/main/sops/plan-breakdown.md)) — read it when a checkout is available; it is binding and this skill is its operational front-end. The execution loop it feeds: compass-core `sops/autonomous-work.md` (unattended) / `sops/in-session-dev-loop.md` (attended). Without a compass-core checkout, the procedure below is self-contained.

> **One line.** Spend the planner's intelligence making the work executable *without* it: every issue must stand alone — verified evidence, exact steps, binary acceptance, copy-pasteable verification — so the executor never has to be smart, only careful.

## Step 0 — scope + pre-flight

Establish from the principal's ask: what is being broken down, which repo(s), which executor model tier, and what is HELD (infra standups, prod deploys, live config edits, security-posture flips). Output:

```
SOP: plan-breakdown | Scope: … | Executor: … | Findings: … | Output: epic + N sub-issues, K waves | Holds: …
```

## Step 1 — verified findings (skip only if the principal hands you already-verified findings)

- Fan out parallel reviewers per artifact class (per-PR, per-doc, per-subsystem stocktake). Structured returns: works / partial / missing / manual-steps / open-issues, each claim with `file:line` evidence and the exact commands run.
- **Adversarially verify EVERY missing/partial claim**: refutation-prompted agents; case-insensitive + snake/camel/kebab/Pascal variant searches; check merged PRs and open issues that may already cover it; check whether the capability exists under a different verb name. Grep is case- and separator-blind — unverified absence claims are the #1 source of duplicate work.
- Pin to `origin/main` / PR head refs (`git fetch origin pull/{N}/head` recovers closed-branch content), never the local tree. Mask all PII. Distinguish "merged" from "deployed/live". Kill or correct refuted claims BEFORE writing issues.

## Step 2 — epic + sub-issues (the executor-grade bar)

- **Epic body**: Why / **Definition of Done as a demonstrable walkthrough** (observable end state a human can run, each step naming the verb/issue that makes it true) / stocktake table (✅ works · ⚠️ partial · ❌ missing · ⏸ held, each with issue numbers) / phases / working-notes-for-executors (traps, footguns, ordering constraints) / provenance.
- **New issues ONLY for untracked work**; existing issues attach as sub-issues (`gh sub-issue add <epic> <n>`; sub-issues are single-parent — an issue already under another umbrella stays there and is cross-referenced in the epic body instead). Cross-repo attach: `gh api -X POST repos/{o}/{r}/issues/{epic}/sub_issues -F sub_issue_id=<global-id>` (the global id, not the number).
- **Every new issue body**: Context / Current state (verified date, `file:line` evidence incl. negative-space searches) / What to build (numbered steps, exact files, pattern-to-copy pointers, stop-and-ask decisions with named owner) / Explicitly out of scope / Acceptance criteria (binary checkboxes) / Verification (copy-pasteable commands + expected results) / References.
- **The bar, as a test**: *could a mid-tier model with zero session context and no ability to ask questions implement this correctly?* Numbers and thresholds verbatim (never "reasonable"/"properly"); commands runnable as pasted; prohibitions explicit ("never print the key"), not implied.
- **Bookkeeping now, not later**: labels per repo standard (type + priority); stale issues found during review get a verify-and-close comment; work auto-closed by force-pushes/history rewrites that was NOT rejected gets a re-land comment crediting the original author.

## Step 3 — wave task list

Partition sub-issues into waves by three rules: (1) **file-overlap** — slices touching the same hot file serialize into one lane; (2) **trust-path serialization** — auth/signing/crypto/key-material/boot-gate slices never run concurrently with each other and each gets an adversarial review lane; (3) **dependency order**. If the breakdown includes an E2E guard test, it starts in wave 1 with `test.todo` entries per gated slice — it is the epic's progress meter; each merged fix flips one live. Post the wave table as a comment ON the epic (ground truth); mirror it into the session task list with owners and blockedBy. Name the HOLDS in the wave plan itself so no executor "helpfully" does them.

## Step 4 — run the loop

Hand the waves to the consumer's dev loop (compass-core `sops/autonomous-work.md` unattended / `sops/in-session-dev-loop.md` attended). Breakdown-specific parameters:

- **Executor model** = the cheaper tier the principal named. The planner session stays orchestrator — dispatch, gate, merge, narrate — and NEVER implements. If a brief needs to teach beyond the issue, fix the issue.
- **Implementer briefs**: worktree from `origin/main`; "gh issue view {N} — it contains exact steps"; verify-before-change; scoped tests + typecheck only (never the full suite in a fresh worktree); push the branch, do NOT merge, do NOT open the PR; structured report-back (branch, files, test output, residual risk).
- **Review scaling**: every slice through the code-review skill; trust-path lanes additionally get an independent adversarial pass (refute-to-kill, FIX-FIRST on blockers). Gate-green before merge, never through a red gate.
- **Small fleet** (rate limits kill mid-task agents); salvage dead agents' worktrees before redoing (commit WIP as SALVAGED first).

## Step 5 — implementation-vs-findings close-out

When the queue drains (or at the principal's checkpoint): spawn a **fresh-context** reviewer with the epic, the findings, and the merged PR list. Per finding: addressed by which PR / partially addressed (what remains) / not addressed (why). Per acceptance criterion: pass with evidence / fail. Deltas become new issues — never silent scope creep. Deliver the report to the principal (it is the deliverable that started the delegation), then run the consumer's retrospective SOP; stale-claim escapes are the highest-value learning.

## Rails

No unverified claim enters an issue · never duplicate a tracked issue · the Definition of Done is an observable walkthrough, not an aspiration · holds are written where executors read · the strongest model writes issues, not fixes.
