# SOP: Multi-Agent Worktree Discipline

**Purpose:** Prevent race conditions when multiple agents work on the same repo concurrently.
**Audience:** All agents and contributors using Claude Code or similar multi-session tooling.

---

## Pre-flight

After reading this SOP, output:
```
SOP: worktree | Worktree: ../{repo}-{slug} | Branch: feat/{name} | Main: untouched
```
Verify before proceeding:
- You are NOT switching branches in the main worktree
- The worktree directory does not already exist

---

## The Problem

When two agents share a worktree, they can conflict by:
- Switching branches under each other
- Stashing and popping each other's changes
- Editing the same files simultaneously
- Creating merge conflicts in uncommitted work

## The Rule

**Never switch branches or stash in the main worktree when another agent might be active.** Use `git worktree` for all feature work instead.

## Setup

```bash
# From the repo root, create a worktree for your feature:
git worktree add ../{repo}-{slug} -b feat/{branch-name} main

# Install dependencies in the new worktree:
cd ../{repo}-{slug} && bun install
```

Example:
```bash
git worktree add ../myapp-payment-flow -b feat/f-042-payment-flow main
cd ../myapp-payment-flow && bun install
```

## Naming Conventions

- Worktree directories go in sibling directories: `../{repo}-{slug}`
- The slug should match the branch name's slug portion
- Examples: `../myapp-auth`, `../myapp-search-index`, `../myapp-billing-fix`

## Working Rules

- The main worktree stays on whatever branch the primary agent is using. Do not touch it from a secondary agent.
- Each worktree gets its own branch. Never check out the same branch in two worktrees.
- Commit and push from the worktree, not the main directory.
- PRs are created from the worktree branch as normal.

## Cleanup

When your feature is merged, remove the worktree:

```bash
git worktree remove ../{repo}-{slug}
```

If the directory was already deleted, prune stale entries:

```bash
git worktree prune
```

## Quick Reference

| Action | Command |
|--------|---------|
| Create worktree | `git worktree add ../{repo}-{slug} -b feat/{branch} main` |
| List worktrees | `git worktree list` |
| Remove worktree | `git worktree remove ../{repo}-{slug}` |
| Prune stale | `git worktree prune` |
