# SOP: In-Session Dev Loop

**Purpose:** How the primary agent drives a body of work — most often *feedback from a real user* — to **shipped**, in-session, by orchestrating **ephemeral fresh-context sub-agents** for implementation and review while keeping its own context clean for diagnosis, judgement, and a **live, honest narrative** posted to the team channel. The review-loop catching real problems *is* the trust signal.
**Audience:** The primary agent working interactively or semi-attended. Sub-agents it spawns do the build and the review; the primary session keeps the plan, the gates, and the story.
**Configurable via:** `compass.config.yaml` (`org.default_branch`, `channels.team`, `channels.public`, `versioning.deploy_command`)
**Related:** [`autonomous-work.md`](./autonomous-work.md) (the unattended / background-agent / morning-handover variant — shares the loop mechanics and the discipline rails), [`plan-breakdown.md`](./plan-breakdown.md), [`pr-review.md`](./pr-review.md), [`dev-pipeline.md`](./dev-pipeline.md), [`worktree-discipline.md`](./worktree-discipline.md), [`retrospective-and-process-mining.md`](./retrospective-and-process-mining.md).

> **One line.** The main session is the orchestrator, the system of record, and the narrator. It does not implement or review with its own hands — it *diagnoses*, dispatches the build and the review to clean-room sub-agents, *verifies the gates*, and *tells the story as it goes*.

---

## When to use this vs `autonomous-work.md`

Both run the same core loop (ground truth → build → review → gate → merge → report) and obey the same [discipline rails](./autonomous-work.md#5-discipline-rails). Pick by mode:

| | **In-session dev loop** (this SOP) | **Autonomous work** |
|---|---|---|
| Principal | present or semi-attended | asleep / away |
| Workers | **ephemeral** sub-agents the main session orchestrates turn-by-turn | background worktree agents running unsupervised |
| Reporting | **live running narrative** as state changes | one-liner per merge + **morning handover** |
| Trigger | often **external feedback** (a tester's or user's report) | a pre-queued slice list |
| Main session's job | diagnose · dispatch · verify · **narrate** | spawn · gate · merge · hand over |

They compose: a feedback-driven in-session loop can hand a long tail to an unattended autonomous run overnight, or vice-versa.

## Pre-flight

After reading this SOP, output:

```
SOP: in-session-dev-loop | Trigger: {feedback source / task} | Build: sub-agent(worktree) | Review: pr-review (+adversarial on trust-path) | Narrate: {{config:channels.team}} | Holds: {live infrastructure / deploy / what the principal said to hold}
```

---

## 1. Diagnose in the main session — *first*, and yourself

The single most leveraged step. **Pin the precise gap before dispatching anyone.**

- Read the actual code. Confirm the root cause. An **"X is missing / doesn't exist" claim is an assertion — verify it** (grep is case- and separator-blind; check camelCase *and* snake_case, or use an editor/LSP symbol search) before you act on it.
- Reduce the report to the **smallest true statement of the gap** — ideally one sentence naming the exact symbol, field, or line. *Example: "the provisioning step never writes back `config_path`, and the activation step derives its target from exactly that key with no shared default → it can't bootstrap → the manual workaround survives."*
- Only now decide the fix shape. A dispatched fix built on an unverified diagnosis wastes a whole sub-agent cycle.

The main session owns this. Don't outsource the diagnosis — outsource the *typing*.

## 2. Dispatch the build to a clean-room sub-agent

- Spawn **one fresh-context implementer** in an **isolated worktree** (see [`worktree-discipline.md`](./worktree-discipline.md)). Fresh context keeps the main session's orchestration judgement uncluttered by implementation detail, and gives the work a clean room.
- The brief carries: the **confirmed diagnosis**, an explicit **"verify before you change"** instruction, the **conventions to match** (don't let it invent a path, name, or shape the rest of the system doesn't already expect — point it at the reader on the other side), the **scoped** test command that proves the fix, and **"push the branch, do not merge, do not open the PR, report back structured."** The main session keeps control of the PR body — that's part of the narrative.
- Tell it to **report the non-obvious**: the convention it chose and *where it confirmed the other side reads the same*, anything that turned out bigger than the diagnosis, and the residual risk an adversarial reviewer should focus on.

## 3. Review with an *independent* sub-agent

- **Every change:** the project's review procedure ([`pr-review.md`](./pr-review.md)) run in a **fresh-context** sub-agent — unbiased precisely because it never saw the build.
- **Trust-path / security-sensitive** (auth, signing, crypto, key material, boot/verify gates, message-bus or account configuration, anything that fails *open*): **additionally** an **adversarial** pass prompted to *refute and break*, defaulting to "refuted" when uncertain. Treat blockers **FIX-FIRST** — fix before merge, never "merge then follow up". Route the fix back through a sub-agent the same way.
- This is where the loop earns the narrative in §5: when review catches a real bug *before* a live run, that catch is the story.

## 4. Gate, merge, ship — main session

- **Gate-verify:** rebase onto `origin/{{config:org.default_branch}}`; lint, type check, and full CI green. **Never merge through a red gate**; never force past a real failure with an admin override. Re-run a *known* flake to confirm; **fix** a real one (even pre-existing).
- **Merge** squash; delete the branch; remove the worktree.
- **Deploy and live-infrastructure changes are a HOLD by default.** Build it, stage it, and *offer* it in the narrative — but a production deploy, running `{{config:versioning.deploy_command}}` against live environments, a security-posture flip, or any destructive/outward action waits for the principal's explicit nod unless they pre-authorised it. (See the rails.)

## 5. Narrate the process — the part that makes this worth doing

The running, honest narrative to the team channel is a **first-class deliverable**, not a footnote. It turns the dev loop into a visible trust signal.

- **Narrate the *process*, not just the result.** State the precise gap in plain language, then what you're doing about it. People trust a team that can name its own bugs crisply.
- **Be honest about partials and regressions.** *"Fix #3 turned out partial"* lands as integrity, not weakness. Announcing only wins erodes trust the first time someone finds the seam.
- **Show the review-loop working.** *"Review caught a real one — before any live run"* is the strongest thing you can post. Surface the catch, the blast radius it prevented, and that no live system was touched.
- **Close the feedback loop with the reporter.** Thank whoever reported it, and when it ships, **ping them for a retest**. The loop is: report → precise gap → fix via review → ship → retest.
- **Cadence:** roughly one post per **state change** — opening (gap pinned, fixing now) → progress (N of M merged) → shipped (vX.Y.Z) → retest ping. Not one per commit; not silence until done.
- **Channel and safety discipline:** the dev narrative goes to the **internal team** channel (`{{config:channels.team|}}`). An outward-facing community channel (`{{config:channels.public}}`) is per-post sign-off only, public-safe copy, **no personal data or secrets, no internal identifiers**. The running story belongs in chat; the durable record — PR, review, decision — belongs on the git host.

## 6. Discipline rails

All of [`autonomous-work.md` §5](./autonomous-work.md#5-discipline-rails) apply unchanged — **honor HOLDs, never self-grant authority, escalate don't guess, never assert without verification, ask before destructive/outward-facing actions.** Two carry extra weight here because the loop is fast and public:

- **The narrative cannot outrun the evidence.** Never post "shipped" / "green" / "deployed" before you've verified it with your own tools. A public unverified claim is the most expensive kind.
- **A held action you *narrated as ready* is still held.** "Ready to deploy — your nod?" is the post. Running the deploy is not, until the nod arrives.

---

*This SOP applies to any project that adopts compass-core. Channels, the default branch, and the deploy command are configurable; the narration honesty rules in §5 and the rails in §6 are not.*
