---
name: Governance
description: |
  Governance engine for any Claude Code project that adopts compass-core. Knows all SOPs,
  runs validators, bootstraps repos, enforces project standards.

  USE WHEN: "what's the SOP for", "process for", "how do I", "version bump", "bump version",
  "release", "tag version", "sync labels", "apply labels", "new repo", "bootstrap repo",
  "review PR", "review pull request", "create worktree", "worktree for", "validate CLAUDE.md",
  "run validators", "structural check", "pre-flight", "preflight banner", "retrospective",
  "extract patterns", "governance check".

  Reads compass.config.yaml from the consuming repo for project-specific values. Routes to
  one of nine workflows under workflows/.
---

# Governance Skill

**Purpose:** Apply compass-core's standard operating procedures consistently in any project that adopts compass-core. Look up SOPs, run validators, bootstrap repos, enforce structural compliance.

**Version:** 0.1.0 (2026-04-08)
**Status:** Phase A1 — bootstrap surface, mixed SOPs are placeholders until Phase B

---

## Routing

| Workflow | Trigger phrases | File |
|----------|----------------|------|
| **preflight** | "pre-flight", "preflight banner", "starting X", "what banner do I output" | `workflows/preflight.md` |
| **sop-lookup** | "what's the SOP for X?", "process for", "how do I", "where's the procedure" | `workflows/sop-lookup.md` |
| **version-bump** | "version bump", "bump version", "release", "tag version", "cut a release" | `workflows/version-bump.md` |
| **label-sync** | "sync labels", "apply labels", "label this repo" | `workflows/label-sync.md` |
| **new-repo** | "new repo", "bootstrap repo", "create repo", "initialize project" | `workflows/new-repo.md` |
| **pr-review** | "review PR", "review pull request", "review this diff" | `workflows/pr-review.md` |
| **worktree-setup** | "create worktree", "worktree for X", "feature branch worktree" | `workflows/worktree-setup.md` |
| **validator-run** | "validate", "run validators", "structural check", "compliance check" | `workflows/validator-run.md` |
| **retrospective** | "retrospective", "extract patterns", "process mining", "post-mortem" | `workflows/retrospective.md` |

---

## Configuration

The skill reads project-specific values from `compass.config.yaml` in the consuming repo. If the config is missing, the skill refuses to act on tasks that depend on project-specific values and tells the requester which keys are needed.

See `config-schema.md` for the full list of placeholders and their purpose.

## Source of Truth

Always read these before acting:

1. **`compass.config.yaml`** at the consuming repo root
2. **`sops/`** in compass-core (for procedures)
3. **`standards/`** in compass-core (for schemas)
4. **`engine/validators/`** in compass-core (for structural checks)

Never invent procedures or describe SOPs you haven't loaded in the current session.

## What This Skill Doesn't Do

- It doesn't run destructive operations (force push, history rewrite, branch deletion, table drops) without explicit confirmation.
- It doesn't merge PRs without explicit approval.
- It doesn't bypass validators by suggesting "skip this check."
- It doesn't write project-specific identifiers into compass-core itself — those belong in the consumer's `compass.config.yaml`.
