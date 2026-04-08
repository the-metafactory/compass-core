# Workflow: Retrospective

**Trigger:** "retrospective", "extract patterns", "process mining", "post-mortem", "what did we learn"

**Purpose:** Walk the retrospective SOP, decompose through 5 levels, identify reusable patterns.

---

## Steps

1. **Read `sops/retrospective-and-process-mining.md`.** Don't summarize from memory.
2. **Identify the trigger:** PR rounds, shipped iteration, incident, or learned-something session.
3. **Output the pre-flight banner:**

```
SOP: retrospective | Scope: {session/sprint/project} | Decomposition level: {1-5}
```

4. **Step 1 — Capture the timeline.** Read whatever artefacts exist:
   - Git log of the relevant range
   - PR conversations
   - Iteration plan checkboxes (what got done, what got dropped)
   - Issue comments
   - Any handover docs
5. **Write the chronological trace.** Include attempts, missteps, root causes, durations.
6. **Step 2 — Decompose through 5 levels.**

| Level | Question |
|-------|----------|
| 5 — Global | "What universal pattern does this follow?" |
| 4 — Project | "What's specific to how *we* do this?" |
| 3 — Session | "What was unique about *this instance*?" |
| 2 — Task | "What discrete steps were performed?" |
| 1 — Tool Call | "What atomic actions were taken?" |

7. **Step 3 — Identify publishable artifacts.** For each level, ask "could this be a reusable package?"
8. **Step 4 — Codify learnings.** Process learnings → CLAUDE.md or new SOP. Technical learnings → design doc. Reusable procedures → process package draft.
9. **Step 5 — Update process knowledge.** If a learning should become a compass-core SOP (cross-project applicable), file an issue against compass-core.

## Output

A markdown document containing:
- **Timeline** (chronological)
- **Five-level decomposition** (filled table)
- **Candidate publishable artifacts** (with draft package names + types)
- **Codified learnings** (where each one goes)
- **Updates required** (to CLAUDE.md, SOPs, design docs)

## The Dog-Fooding Principle

Always end with the question:

> "If someone else had this problem, what would they install or reuse to solve it?"

If the answer is "nothing exists", that's a product gap. Capture it.

## Failure Modes

- **Insufficient artefact trail:** If git log + PRs + issues don't tell the full story, the retrospective will be shallow. Surface this; don't fabricate details.
- **Trying to retro something still in flight:** Refuse, tell the requester to wait until the work has actually shipped.
