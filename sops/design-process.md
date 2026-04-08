# SOP: Design and Planning Process

**Purpose:** Define how design artifacts flow from research to implementation, ensuring every decision is traceable and every feature is grounded in evidence.
**Audience:** All contributors and agents working on any project that adopts compass-core.

---

## Pre-flight

After reading this SOP, output:
```
SOP: design-process | Stage: {research/decisions/spec/implementation} | Output: {doc type}
```
Verify before proceeding:
- Identified which stage of the document lineage this work falls into
- Know which artifact type you're producing

---

## Document Lineage

```
Research (evidence)
  └── Design Decisions (rules)
        └── Roadmap (phases + iterations)
              └── Design Specs (features, acceptance criteria, UX flows)
                    └── Iteration Plan (live checklist on GitHub)
                          └── Feature Issues (trackable work with sub-tasks)
                                └── Code (implementation)
```

Each level in the chain is grounded in the level above it. Decisions trace back to research. Features trace back to decisions. Issues trace back to features. Code traces back to issues.

---

## Artifact Types

| Artifact | Authority | Format | Where It Lives |
|----------|-----------|--------|---------------|
| **Research** | Evidence base for all decisions | Markdown studies with sources | `research/*.md` |
| **Design Decisions** | The rules. If anything contradicts a DD, the DD wins. | Numbered ADRs (DD-1, DD-2, ...) | `design/design-decisions.md` |
| **SOPs** | Operational procedures derived from DDs | Step-by-step with checklists | `sops/` or `docs/sops/` |
| **Roadmap** | Phases and iteration mapping | Phase stack with milestones | `ROADMAP.md` |
| **Design Specs** | Feature breakdown with acceptance criteria and UX flows | One doc per area or phase | `design/{area}.md` |
| **Iteration Plans** | Live checklists linking features to issues | Checkboxes, emoji status, issue links | GitHub Issues (one per iteration) |
| **Feature Issues** | Trackable work with sub-tasks and acceptance criteria | GitHub Issues with task lists | GitHub Issues (one per feature area) |
| **Mockups** | Visual design direction | HTML mockups, multiple concepts | `mockups/` |
| **Handovers** | Async status updates between collaborators | Daily markdown with agent context section | `handovers/` |
| **CLAUDE.md** | Agent onboarding -- how to start working on this repo | Reading order, principles, key decisions | Repo root (see `templates/CLAUDE.md.template`) |

---

## How to Add a New Feature

1. **Check research** -- Is there evidence from existing studies? Read `research/` before proposing.
2. **Create or reference a DD** -- Every feature needs a design decision. Add to `design/design-decisions.md`.
3. **Update the design spec** -- Add the feature to the appropriate `design/*.md` with acceptance criteria.
4. **Update the iteration plan** -- Add to the GitHub iteration issue with checkbox and feature issue link.
5. **Create a feature issue** -- GitHub issue with sub-tasks and acceptance criteria.
6. **Implement** -- Code against the acceptance criteria. Link commits to the issue.
7. **Verify** -- Check the exit criteria in the iteration plan.

## How to Make a Design Decision

1. **Ground in research** -- Reference the specific research finding that informs the decision.
2. **Number it** -- Next sequential DD number (DD-1, DD-2, ...).
3. **Document in `design-decisions.md`** -- Status, context, decision, research reference.
4. **Update affected docs** -- Design specs, SOPs, roadmap if impacted.
5. **Commit with DD reference** -- Commit message references the DD number.

## How to Write a Handover

1. Follow the template in `handovers/README.md` (if the repo uses handovers).
2. One per working day (skip days with no meaningful work).
3. Include the **Agent Context** section -- required reading, current state, document lineage, key constraints.
4. Include **What's Next in the Plan** -- structured by immediate/after-alignment/parallel.
5. Keep it to one screen.

---

## Naming Conventions

| Artifact | Naming Pattern | Example |
|----------|---------------|---------|
| Research | Descriptive topic | `trust-model-synthesis.md` |
| Design decisions | DD-{number} | DD-12 |
| Design specs | `{area}.md` | `auth-flow.md` |
| Features | {prefix}-{seq}: {name} | F-042: Payment Flow |
| SOPs | Descriptive slug | `design-process.md` |
| Handovers | `YYYY-MM-DD-handover.md` | `2026-03-28-handover.md` |
| Iterations | `iteration-{n}.md` (repo) + GitHub Issue (live) | `iteration-1.md` + #12 |
| Feature branches | `feat/{id}-{slug}` | `feat/f-042-payment-flow` |

Each repo defines its own feature prefix convention (a short identifier like `F-`, `P-`, etc.). Pick a short prefix and use it consistently. The prefix is configurable via `compass.config.yaml`'s `features.id_prefix`.

## Iteration Plan Sync

Iteration plans are maintained in **two places**:

1. **`iterations/iteration-{n}.md`** (or `docs/iteration-*.md`) -- repo artifact. Agents read this to understand what work exists and what's done. Durable record that lives with the code.
2. **GitHub Issue** -- trackable, commentable, assignable. The collaboration surface where humans discuss progress.

**Both must stay in sync.** When a checkbox is completed, update both the repo file and the GitHub issue. When a new task is discovered during implementation, add it to both.

The repo file is authoritative for content (agents trust it). The GitHub issue is authoritative for status (who's working on what, comments, links to PRs).

---

*Each repo may extend this with project-specific conventions.*
