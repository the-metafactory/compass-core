# SOP: Autonomous Work

**Purpose:** How the primary agent drives a delegated body of work to completion **unattended** — the principal asleep or away — merging slices safely without supervision, while staying inside the authority that was actually granted.
**Audience:** The primary agent entrusted with an unattended, multi-slice run. Sub-agents spawned by the loop follow the per-slice steps but do not themselves merge or self-extend scope.
**Configurable via:** `compass.config.yaml` (`org.default_branch`, `channels.team`)
**Related:** [`in-session-dev-loop.md`](./in-session-dev-loop.md) (the attended variant — same loop, live narrative), [`plan-breakdown.md`](./plan-breakdown.md) (produces the slice queue this drains), [`dev-pipeline.md`](./dev-pipeline.md), [`worktree-discipline.md`](./worktree-discipline.md), [`pr-review.md`](./pr-review.md), [`versioning.md`](./versioning.md), [`retrospective-and-process-mining.md`](./retrospective-and-process-mining.md)

---

## Activation

Activate **only** when the principal delegates a body of work with explicit unattended authority — e.g. *"drive this through, I'm going to bed"*, *"do this autonomously"*, *"keep going until it's merged"*. The grant is **scoped to the work named**. It is not a licence to invent new scope, flip safety toggles, or take destructive/outward-facing actions the principal did not authorise (see [§5 Discipline rails](#5-discipline-rails)).

## Pre-flight

After reading this SOP, output:

```
SOP: autonomous-work | Slices: {N} queued | Review: pr-review (+adversarial on trust-path) | Report: {{config:channels.team}} | Holds: {what the principal said to hold}
```

If you cannot name what is held, re-read the principal's instruction before starting — an unstated hold is the most common way autonomous runs overstep.

---

## 1. The loop (per slice)

Ground truth → build → review → gate → merge → report → sync → next.

1. **Scope from ground truth.** Pick the next **unblocked** slice from the task list / ready queue / issue dependency order. Never work blocked slices or invent slices not in the plan. "Do the rest" means finish the named scope, not expand it.
2. **Build in isolation.** Spawn a **worktree-isolated** sub-agent per slice (see [`worktree-discipline.md`](./worktree-discipline.md)). Tests first; the branch must come back gate-clean. Parallel agents must touch **non-overlapping files**.
3. **Review proportional to risk.**
   - **Every slice:** the project's review procedure — see [`pr-review.md`](./pr-review.md). If your project ships a review skill or automation, use it rather than reviewing by hand.
   - **Trust-path / security-sensitive code** (auth, signing, crypto, key material, boot/verify gates, anything that fails *open* if wrong): **additionally** run an **independent adversarial review** — a second agent prompted to *refute and break* the change, defaulting to "refuted" when uncertain. Treat blockers **FIX-FIRST**: fix before merge, never "merge then follow up".
4. **Gate-verify before merge.** Rebase onto `origin/{{config:org.default_branch}}`, then confirm **all** checks green: lint, type check, full CI. **Never merge through a red gate.** If a check fails on a *known, unrelated* flake, confirm by **re-run** — do not force-merge past it with an admin override. If the failure is real (even pre-existing, even another author's), **fix it** (file + fix or file + flag); a red default branch blocks everyone.
5. **Merge.** Squash (`gh pr merge --squash --delete-branch`); remove the worktree.
6. **Report.** Post a **one-liner** to the team channel (`{{config:channels.team|}}`): verdict + counts + deep link. The full review/decision output goes to the PR or issue — the durable record lives on the git host; the channel carries the pointer, not the prose.
7. **Sync state.** Tick the task list **and** the issue/plan checkbox — both, every time. The task list must always reflect reality; no stale "in-progress" on finished work.
8. **Next slice.** Repeat until the queue is drained or a hold/escalation stops you.

---

## 2. Scaling review to the ask

| The principal asked for… | Review depth |
|---|---|
| a quick fix / mechanical change | single review pass (`pr-review.md` → StandardReview) |
| a feature slice | full review pass (`pr-review.md` → FullReview), fixes applied before merge |
| **trust-path / security / "be thorough" / "audit"** | full review **+ independent adversarial review** (refute-to-kill), FIX-FIRST on blockers |

When unsure, lean **thorough**. The cost of an extra review pass is minutes; the cost of an unattended bad merge is the principal waking up to a broken default branch.

---

## 3. Surviving sub-agent failure

Background agents die mid-task (API rate-limit, crash, timeout). When one does:

- **Preserve the work first.** If the agent left **uncommitted** changes in its worktree, **commit them to its branch** (a clear `wip(...): SALVAGED` message) **before** doing anything else — never let effort evaporate. Note in the message that it is incomplete and what remains.
- **Diagnose before salvage-vs-redo.** Check whether the branch base is **stale** (commits merged to `origin/{{config:org.default_branch}}` since it forked) — a stale base makes a raw diff look like it *deletes* recently-merged work when it only lacks it. Confirm with `git merge-base --is-ancestor` and `git log base..origin/{{config:org.default_branch}}` before judging the change.
- **Salvage if the work is coherent and substantial; redo if it's partial/tangled.** Salvage = commit → rebase onto the default branch → resolve conflicts → finish → verify → review. Redo from a fresh default branch when the salvage cost exceeds a clean re-run.

---

## 4. Parallelism

- **Cap concurrent background agents.** Too many in flight invites API rate-limiting — and a rate-limited agent can die mid-task (see §3). Run a small fleet; queue the rest.
- **Sequence trust-path work.** Don't spawn a second agent into a trust-path slice while another trust-path agent is running — serialise so an adversarial review has a stable target and rate-limit risk stays low.
- **Non-overlapping files.** Two agents editing the same file in parallel will conflict at merge. Partition by file/area.
- **A blocking flake gates the whole pipeline.** If a flaky/red gate is blocking *every* PR's merge, fixing it is the **highest-priority** slice — it unblocks everything else. Spawn the de-flake first.

---

## 5. Discipline rails

These are non-negotiable, and they are the difference between trusted autonomy and a revoked grant:

- **Honor HOLDs.** Anything the principal said to hold — live-infrastructure migrations, security-posture flips (signing, mTLS, encryption enforcement), production deploys, destructive ops — **stays held**, no matter how ready the code looks. Stage it; don't fire it.
- **Never self-grant authority.** Stay inside the named scope. No bonus refactors, no "while I'm in here", no flipping safety defaults to the secure-but-unrequested setting without asking.
- **Escalate, don't guess.** When a slice hits genuine ambiguity, a missing decision, or a blocker only the principal can clear, **leave it for the principal** with a crisp summary — don't invent a resolution and merge on it.
- **Never assert without verification.** No "merged", "deployed", "green", or "done" without evidence you produced with your own tools (CI status, test output, a diff, a live probe). Unattended is exactly when unverified claims do the most damage.
- **Ask before destructive / outward-facing actions** even mid-run — deletes, force-push, production deploy, sending external messages. Unattended ≠ unrestricted.

---

## 6. Morning handover

When the principal returns (or the queue drains), post a single handover to the team channel and/or the umbrella issue:

- **Merged:** PRs landed, one line each (with links).
- **Held:** what was deliberately *not* done and why (the HOLDs, deferrals).
- **Escalations:** anything waiting on a principal decision, with the options.
- **In-flight:** agents still running, what they're on.

The principal should be able to reconstruct the whole night from that one message without reading the transcript.

---

*This SOP applies to any project that adopts compass-core. Channel names, the default branch, and the review procedure are configurable; the discipline rails in §5 are not.*
