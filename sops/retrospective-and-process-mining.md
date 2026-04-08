# SOP: Retrospective and Process Mining

**Purpose:** After significant work (iterations, multi-round PR reviews, incident responses), extract patterns, codify learnings, and identify publishable artifacts.
**Audience:** All contributors and agents.

---

## Pre-flight

After reading this SOP, output:
```
SOP: retrospective | Scope: {session/sprint/project} | Decomposition level: {1-5}
```
Verify before proceeding:
- Identified the scope of the retrospective
- Know which trigger condition was met (multi-round PR, shipped iteration, incident, learned something)

---

## When to Trigger

Run this SOP after any of:
- A PR that went through 2+ review rounds
- An iteration that shipped
- A production incident and its resolution
- Any multi-session work where something was learned about *how* to work (not just *what* was built)

## The Retrospective

### Step 1: Capture the Timeline

Write a chronological trace of what happened. Include:
- What was attempted and in what order
- Where things went wrong (fixes that introduced new bugs, dismissed test failures, lost work)
- What the actual root causes were
- How long things took and why

**Format:** Prose or structured YAML trace.

### Step 2: Decompose Through the Five Levels

| Level | Question | What You Extract |
|-------|----------|-----------------|
| **5 — Global** | "What universal pattern does this follow?" | The org-level workflow (e.g., "code quality assurance") |
| **4 — Project** | "What's specific to how *we* do this?" | Project-specific conventions (e.g., severity-categorized reviews) |
| **3 — Session** | "What was unique about *this instance*?" | Learnings and incidents (e.g., "fixes caused regressions") |
| **2 — Task** | "What discrete steps were performed?" | Individual finding resolutions, each as a mini-trace |
| **1 — Tool Call** | "What atomic actions were taken?" | Raw tool sequences (too specific to publish, but feeds Level 2) |

### Step 3: Identify Publishable Artifacts

For each level, ask: **"Could this be a reusable package?"**

| Level | Package Type | Example |
|-------|-------------|---------|
| 5 | agent (graph of processes) | `code-quality-cycle` |
| 4 | process | `pr-review-response` |
| 3 | process (specialized) | `test-stabilization` |
| 2 | skill | `finding-resolver` |
| 1 | tool | Built-in (Read, Grep, Edit, Bash) |

Not every level produces a publishable artifact. Level 1 rarely does. Level 3 only does when the session revealed a reusable pattern.

### Step 4: Codify What Was Learned

Learnings go to one of three places:

| Learning Type | Where It Goes | Example |
|--------------|--------------|---------|
| **Process / workflow** | CLAUDE.md or new SOP | "PR Review Response" workflow |
| **Technical pattern** | Design doc or design decision | "Argon2id must use lightweight config in tests" |
| **Reusable procedure** | Process package manifest | `test-stabilization` YAML |

### Step 5: Update Process Knowledge

If this retrospective identified reusable processes not already documented:
- Add to the relevant repo's design docs
- Consider whether it should become a compass-core SOP (project-wide) or stay repo-specific

---

## The Dog-Fooding Principle

Every time you do work, ask:

> **"If someone else had this problem, what would they install or reuse to solve it?"**

If the answer is "nothing, because the package doesn't exist yet" — that's a product gap. The work you just did IS the first trace for that package.

This is the self-improvement loop:

```
DO WORK → RETROSPECTIVE → IDENTIFY PACKAGES → PUBLISH → USE ON NEXT WORK
   ↑                                                           │
   └───────────── new traces improve the packages ─────────────┘
```

---

## Output Checklist

After running this SOP, you should have produced:

- [ ] Timeline of what happened (Step 1)
- [ ] Decomposition through 5 levels (Step 2)
- [ ] List of candidate publishable packages with draft manifests (Step 3)
- [ ] Learnings codified in the right place (Step 4)
- [ ] Process knowledge updated if needed (Step 5)
