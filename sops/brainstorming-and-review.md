# SOP: Brainstorming and Document Review

**Purpose:** Formalize the workflow for capturing strategic discussions, design decisions, and collaborative reviews — from freeform conversation to merged, authoritative documents.
**Audience:** All contributors and agents.

---

## Pre-flight

After reading this SOP, output:
```
SOP: brainstorming-review | Stage: {capture/draft/review/refine/merge} | Output: {doc type}
```
Verify before proceeding:
- Identified which stage of the workflow this task falls into
- Know which artifact type you're producing (design decisions, research, strategy, etc.)
- Know which repo the artifact belongs to

---

## The Workflow

```
1. Brainstorm (freeform conversation)
   └── 2. Capture (agent extracts structured decisions)
         └── 3. Draft PR (document committed on branch)
               └── 4. Inline Review (reviewers comment per-section)
                     └── 5. Refine (address feedback, push updates)
                           └── 6. Merge (document becomes authoritative)
```

Each stage has clear inputs, outputs, and responsibilities.

---

## Stage 1: Brainstorm

**Where:** Chat thread, voice call, or any freeform medium.
**Who:** Participants (humans and/or agents).
**Output:** Raw conversation with ideas, decisions, and open questions.

**Rules:**
- No structure required — this is exploratory
- Capture happens AFTER, not during (don't interrupt flow with formatting)
- Tag open questions explicitly when they arise ("open question: should we X or Y?")

---

## Stage 2: Capture

**Who:** Agent (or human) responsible for synthesizing the conversation.
**Input:** Raw conversation from Stage 1.
**Output:** Structured document draft.

**Rules:**
- Extract explicit decisions, implicit decisions, and open questions
- Use numbered identifiers (DD-1, DD-2, ... for design decisions; RD-1 for research decisions, etc.)
- For each decision, capture:
  - **Status:** Decided / Open / Revisit
  - **Decision statement:** What was decided and why
  - **Options evaluated:** What alternatives were considered
  - **Review notes:** Any caveats or dissenting views from participants
- Flag anything that was implied but not explicitly stated as "inferred" — reviewers must confirm
- Capture verbatim quotes when they convey intent that paraphrasing would lose
- Link to source artefacts (research docs, prior design specs, issues)

**Quality check:** Before drafting PR, verify:
- [ ] Every explicit decision has a DD-N identifier
- [ ] Open questions are flagged with status "Open"
- [ ] No decisions are fabricated — everything traces to the conversation
- [ ] Related artefacts are linked

---

## Stage 3: Draft PR

**Who:** Agent creates branch and PR.
**Input:** Structured document from Stage 2.
**Output:** PR with document committed, reviewers assigned.

**Rules:**
- Branch naming: `docs/{document-slug}` (e.g., `docs/strategy-design-decisions`)
- Use worktree discipline (SOP: `worktree-discipline.md`)
- PR title: `docs: {descriptive title}`
- PR body: Summary of what was captured, count of decisions, list of open questions
- Assign reviewers: all participants from the brainstorm
- Document goes in `docs/` directory of the appropriate repo

---

## Stage 4: Inline Review

**Who:** Assigned reviewers.
**Input:** PR with document.
**Output:** Inline comments on specific decisions.

**Rules:**
- Reviewers comment per-decision, not as a single review comment
- Comments should state: agree, disagree (with alternative), or refine (suggest modification)
- Agent summarizes all inline comments and proposes resolutions
- Agent does NOT merge without explicit approval from at least one human reviewer

---

## Stage 5: Refine

**Who:** Agent (or original author).
**Input:** Reviewer comments from Stage 4.
**Output:** Updated document addressing all feedback.

**Rules:**
- Push refinements as new commits (not force-push — preserve review history)
- For each reviewer comment, either:
  - **Accept:** Incorporate the change, note in review notes
  - **Discuss:** If comments conflict, surface the disagreement and propose resolution
  - **Defer:** If the comment opens a new topic, create a follow-up issue
- Post a PR comment summarizing all changes made in the refinement
- Request re-review if substantive changes were made

---

## Stage 6: Merge

**Who:** Human with merge authority (or agent with explicit approval).
**Input:** Approved PR with all feedback addressed.
**Output:** Merged document on main branch.

**Rules:**
- Squash merge to keep history clean
- Delete the source branch after merge
- The merged document is now authoritative — future work references it
- If the document defines design decisions, downstream artefacts (roadmaps, specs, iteration plans) should reference its DD-N identifiers

---

## Anti-patterns

| Don't | Do Instead |
|-------|------------|
| Capture during brainstorming (interrupts flow) | Let conversation finish, then synthesize |
| Create decisions not in the conversation | Flag inferred decisions explicitly |
| Merge without human review | Always require at least one human reviewer |
| Force-push over review comments | Push new commits to preserve review history |
| Dump raw notes as the document | Structure with identifiers, status, options |
| Skip the PR — commit straight to main | Always use the branch → PR → review flow |

---

## Activation

| Signal | Action |
|--------|--------|
| A strategic or design conversation just happened in chat or call | Start at Stage 2 (Capture) |
| Someone says "let's document this" or "capture these decisions" | Start at Stage 2 (Capture) |
| A design document needs review | Start at Stage 4 (Inline Review) |
| Review feedback received on a PR | Start at Stage 5 (Refine) |
| PR approved and ready | Start at Stage 6 (Merge) |
