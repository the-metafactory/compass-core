# SOP: Plan Breakdown — frontier planning → executor-grade work

**Purpose:** How a frontier-tier session (the planner) turns a delegated body of analysis — a review, a stocktake, a design — into an **epic + sub-issues that a less capable executor model implements with high quality**, then runs the dev loop over them and closes with an implementation-vs-findings review.
**Audience:** The primary agent on the strongest available model. The output is consumed by **executor** agents — the same role the loop SOPs call the *implementer / build sub-agent* — on a cheaper model with **zero session context**.
**Configurable via:** `compass.config.yaml` (`org.default_branch`, `labels.required.types`, `labels.required.priorities`)
**Related:** [`autonomous-work.md`](./autonomous-work.md) + [`in-session-dev-loop.md`](./in-session-dev-loop.md) (the execution loop this feeds), [`pr-review.md`](./pr-review.md), [`worktree-discipline.md`](./worktree-discipline.md), [`design-process.md`](./design-process.md), [`retrospective-and-process-mining.md`](./retrospective-and-process-mining.md).

> **One line.** Spend the planner's intelligence making the work executable *without* it: every issue must stand alone — verified evidence, exact steps, binary acceptance, copy-pasteable verification — so the executor never has to be smart, only careful.

---

## When to use

The principal delegates a body of work that starts with *understanding* (review this workstream, stocktake where we are, audit X) and must end in *shipped changes by someone else* — typically: "review what happened, break it down, and hand it to the loop." If the work is a single obvious fix, skip this SOP and use the dev loop directly.

## Pre-flight

After reading this SOP, output:

```
SOP: plan-breakdown | Scope: {what is being broken down} | Executor: {model tier} | Findings: verified via {N} agents + adversarial pass | Output: epic + {M} sub-issues, {K} waves | Holds: {what stays with the principal}
```

---

## Phase 1 — Deep review: verify everything before it becomes a plan

The breakdown is only as good as its facts. A stale or wrong claim written into an issue sends an executor to implement against reality that doesn't exist.

1. **Fan out, don't serially read.** Spawn parallel reviewers per artifact class: one per PR under review, one per research thread, one per subsystem stocktake area. Each returns **structured output** (works / partial / missing / manual-steps / open-issues) with **evidence**: `file:line` anchors and the exact commands run.
2. **Adversarially verify every gap claim.** Every "missing" or "partial" claim gets an independent verify pass prompted to **refute** it: case-insensitive, separator-blind searches across snake/camel/kebab/Pascal variants; check merged PRs and open issues that may already cover it; check whether the capability exists under a different verb. Grep is case- and separator-blind — unverified absence claims are the #1 source of duplicate work.
3. **Pin to the remote ground truth.** Verify against `origin/{{config:org.default_branch}}` (or the PR head refs), not the local working tree — local checkouts go stale, and history rewrites make them lie. `git fetch origin pull/{N}/head` recovers content from closed or deleted branches.
4. **Incorporate corrections before writing anything down.** A claim the verify pass killed must not appear in any issue. Distinguish "merged but not deployed / not live" from "done" — operational state is a finding too.
5. **Mask as you go.** Reviewers reproduce **no** personal data, tokens, or customer identifiers in findings; refer generically.

**Exit bar:** a findings set where every claim carries evidence, every absence survived a variant-aware refutation attempt, and deploy/live state is explicitly known or explicitly marked unknown.

## Phase 2 — Work breakdown: the epic and the executor-grade sub-issues

### The epic (one issue, the umbrella)

| Section | Carries |
|---|---|
| **Why** | 2–4 sentences: what the review found, why this epic exists, provenance (who or what it reviews) |
| **Definition of Done** | A **demonstrable end-to-end scenario** — concrete walkthrough(s) a human can run, each step naming the verb or issue that makes it true. Not a work list: the *observable end state*. |
| **Stocktake** | A table: each capability → ✅ works / ⚠️ partial (issue#) / ❌ missing (issue#) / ⏸ held / 📋 specced. Numbers, not adjectives. |
| **Phases** | Ordered groups of sub-issues with the recommended execution order and what can parallelize |
| **Working notes for executors** | The traps: stale-clone resets, deploy footguns, ordering constraints, "read X before touching Y" |
| **Provenance** | How the findings were produced (agents, verification), so future readers can judge freshness |

### Sub-issues — the executor-grade bar

Create **new** issues only for genuinely untracked work. Existing issues **attach** to the epic (on GitHub, sub-issues are single-parent — an issue already under another umbrella stays there and is cross-referenced in the epic body instead). Every **new** issue body has exactly these sections:

1. **Context** — why this matters, in prose a newcomer can follow. No session shorthand, no "as discussed".
2. **Current state (verified {date})** — what exists today, every claim anchored to `path/file.ts:line` or to the output of a named command. Include the *negative* space: what was searched and not found, with the search variants.
3. **What to build** — numbered steps, sliced if more than one PR. Name the exact files, the pattern to copy ("mirror the handler registration at `src/registry.ts:338-350`"), the decisions already made, and the decisions the executor must **stop and ask** about (with whom).
4. **Explicitly out of scope** — the adjacent work the executor must NOT do, with the issue number where it lives.
5. **Acceptance criteria** — binary checkboxes. Each answerable yes/no by running something.
6. **Verification** — the exact commands (scoped test runs, the type check, smoke requests) with expected results.
7. **References** — ADRs, SOPs, sibling issues, the PRs that shipped the surrounding code.

**The bar, as a test:** *could a mid-tier model with no session context and no ability to ask you questions implement this correctly?* If a step requires knowing something only the planner knows, the issue is not done. Specificity rules: numbers and thresholds verbatim (never "reasonable" / "properly"); commands copy-pasteable; "don't print the key" spelled out, not implied.

### Bookkeeping (do it now, not later)

- Labels on every new issue per the repo standard — one of `{{config:labels.required.types}}` and one of `{{config:labels.required.priorities}}`.
- Stale issues discovered during review get a comment recommending verify-and-close — the tracker must reflect reality.
- Work auto-closed by force-pushes or history rewrites that was **not** rejected gets a comment saying so, pointing at the re-land path and crediting the original author.

## Phase 3 — The task list: waves the loop can actually run

Turn the sub-issues into an ordered wave plan and post it as a comment **on the epic** (ground truth), mirrored into the session task list (working memory). Partition by three rules:

1. **File-overlap:** slices touching the same hot file serialize into one lane; disjoint files parallelize.
2. **Trust-path serialization:** auth, signing, crypto, key-material, and boot-gate slices never run concurrently with each other, and each gets the adversarial review lane (see [`autonomous-work.md` §2](./autonomous-work.md#2-scaling-review-to-the-ask)).
3. **Dependency order:** a slice blocked by another (a shared signing path, a verb it extends) queues behind it; the epic's Definition-of-Done test suite (if the breakdown created one) starts in wave 1 as skipped/todo tests and becomes the progress meter — each merged fix flips one live.

Name the **holds** in the wave plan itself: infrastructure standups, production deploys, live-config edits, posture flips — anything that stays with the principal, listed so no executor "helpfully" does it.

## Phase 4 — Execute: hand the waves to the dev loop

Run [`autonomous-work.md`](./autonomous-work.md) (unattended) or [`in-session-dev-loop.md`](./in-session-dev-loop.md) (principal present). Breakdown-specific parameters:

- **Executor model:** the cheaper tier the principal named — the whole point of the bar in Phase 2. The planner session stays orchestrator: dispatch, gate, merge, narrate; it does not implement.
- **Briefs point at the issue,** not at a re-explanation: "`gh issue view {N}` — it contains exact steps", plus worktree setup, scoped verification commands, push-don't-merge, and structured report-back. If the brief needs to teach beyond the issue, fix the issue.
- **Review scaling** per [`autonomous-work.md` §2](./autonomous-work.md#2-scaling-review-to-the-ask); the trust-path lanes from Phase 3 carry the adversarial pass.
- **Fleet size small** (rate limits kill mid-task agents); salvage per [`autonomous-work.md` §3](./autonomous-work.md#3-surviving-sub-agent-failure).

## Phase 5 — Close the loop: implementation-vs-findings review

When the queue drains (or at the principal's checkpoint):

1. Spawn a **fresh-context** reviewer with the epic, the findings, and the merged PR list. It answers, per finding: *addressed by which PR / partially addressed (what remains) / not addressed (why)* — and per acceptance criterion: *pass with evidence / fail*. Deltas become new issues, not silent scope creep.
2. Deliver that report to the principal for their own review — it is the deliverable that started the delegation.
3. Retro per [`retrospective-and-process-mining.md`](./retrospective-and-process-mining.md); stale-claim escapes (a wrong "current state" that reached an executor) are the highest-value learning.

---

## Discipline rails (breakdown-specific; the loop's rails also apply)

- **No unverified claim enters an issue.** If the verify pass didn't run on it, it doesn't ship in a body an executor will trust blindly.
- **Never duplicate a tracked issue.** Attach and cross-reference; the single-parent rule decides placement, the epic body carries the map.
- **The epic's Definition of Done is observable, not aspirational.** If you can't write the walkthrough a human runs to confirm it, you don't have one yet.
- **Holds are written down where executors read.** An unstated hold is how autonomous runs overstep.
- **The planner does not implement.** The moment the strongest model starts typing fixes, the breakdown has failed its own bar — fix the issue text instead.

---

*This SOP applies to any project that adopts compass-core. The label sets, the default branch, and the executor model tier are project choices; the executor-grade bar in Phase 2 and the rails above are not.*
