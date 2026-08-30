# SOP: Multi-Agent Worktree Discipline

**Purpose:** Prevent race conditions when multiple agents work on the same repo concurrently.
**Audience:** All agents and contributors using Claude Code or similar multi-session tooling.

---

## Pre-flight

After reading this SOP, output:
```
SOP: worktree | Worktree: ../{repo}-{slug} | Branch: {type}/{name} | Main: untouched
```
Where `{type}` is one of `feat` (new feature), `fix` (bug fix), `infra` (tooling/CI), `docs` (documentation), `chore` (version bumps, metadata). The default for new feature work is `{{config:features.commit_prefix}}`.

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
git worktree add ../{repo}-{slug} -b {type}/{branch-name} origin/{{config:org.default_branch}}

# Install dependencies in the new worktree, using your stack's installer:
cd ../{repo}-{slug} && <install command>    # e.g. bun install
```

**Base new branches on the remote default branch (`origin/{{config:org.default_branch}}`), not the local one.** The local default branch may lag behind the remote, and branching from a stale local tip means you rediscover — or silently revert — work that already merged.

Examples:
```bash
# Feature
git worktree add ../myapp-payment-flow -b feat/f-042-payment-flow origin/main

# Bug fix
git worktree add ../myapp-home-responsive -b fix/home-responsive-layout origin/main

# Infrastructure
git worktree add ../myapp-ci-cache -b infra/f-210-ci-cache origin/main
```

## Naming Conventions

- Worktree directories go in sibling directories: `../{repo}-{slug}`
- The slug should match the branch name's slug portion (minus the `{type}/` prefix)
- Examples: `../myapp-auth`, `../myapp-search-index`, `../myapp-billing-fix`
- Branch prefix matches the change type: `feat/`, `fix/`, `infra/`, `docs/`, `chore/`. The prefix shows up in commit messages and the PR list — use it consistently.

## Working Rules

- The main worktree stays on whatever branch the primary agent is using. Do not touch it from a secondary agent.
- Each worktree gets its own branch. Never check out the same branch in two worktrees.
- Commit and push from the worktree, not the main directory.
- PRs are created from the worktree branch as normal.

## Basing a worktree on an existing PR

When you pick up or **expand an existing PR** (yours or a teammate's), base the
worktree on the PR's **actual head ref**, never a local branch of the same name —
a same-named local branch is routinely stale by one or more commits, and building
on it silently duplicates work already pushed to the PR (and can clobber it).

```bash
# Correct — fetch the PR's real head, then branch from it:
gh pr checkout {N}                       # checks out the PR head into a tracking branch
#   or, for a worktree:
git fetch origin pull/{N}/head && git worktree add ../{repo}-pr{N} FETCH_HEAD
```

Before adding your commit, confirm the base: `git log --oneline -1` should match
the PR's head SHA (`gh pr view {N} --json headRefOid -q .headRefOid`). If it
doesn't, you're on a stale base — reset to the real head before touching a line.

## Cleanup

After a PR merges, clean up in this order. Skipping steps leaves stale state that confuses future agents and `git worktree list` / `git branch` output.

### 1. Remove the worktree directory

```bash
git worktree remove ../{repo}-{slug}
```

If the directory was already deleted (or `remove` complains about being locked), prune stale entries:

```bash
git worktree prune
```

### 2. Delete the local branch

`git worktree remove` does NOT delete the branch — the branch stays in your local repo pointing at the pre-merge tip. Delete it:

```bash
git branch -d {type}/{branch-name}
```

`-d` (lowercase) is safe: it refuses to delete a branch that isn't merged. If git warns "not yet merged to HEAD" but the branch IS merged upstream via squash merge, that warning is expected — the branch's literal tip is not in the default branch's history because a squash merge creates a new commit that is not a descendant of the feature branch's tip. Verify the PR is merged with `gh pr view <pr-number> --json state --jq .state` (or `gh pr list --head {type}/{branch-name} --state merged` if you don't remember the PR number), then use `git branch -D` (capital D, force) to delete the local branch.

### 3. Delete the remote branch

If `gh pr merge --delete-branch` was used, the remote branch is already gone — nothing to do. If the host has "automatically delete head branches" enabled at the repo level, same. Otherwise:

```bash
git push origin --delete {type}/{branch-name}
```

Never force-push or delete branches belonging to other active worktrees — check `git worktree list` first.

### 4. Sync the main worktree

Bring the main worktree up to the new tip so subsequent work starts from the merged state:

```bash
# Find the primary worktree path — it's the first entry in `git worktree list`:
git worktree list

cd /path/to/primary-worktree   # the original repo root, NOT the sibling worktree you just removed
git pull origin {{config:org.default_branch}}
```

## Quick Reference

| Action | Command |
|--------|---------|
| Create worktree | `git worktree add ../{repo}-{slug} -b {type}/{branch} origin/{{config:org.default_branch}}` |
| List worktrees | `git worktree list` |
| Remove worktree | `git worktree remove ../{repo}-{slug}` |
| Prune stale worktrees | `git worktree prune` |
| Delete local branch (merged) | `git branch -d {type}/{branch}` |
| Delete local branch (force, post-squash-merge) | `git branch -D {type}/{branch}` |
| Delete remote branch | `git push origin --delete {type}/{branch}` |
| Sync main after merge | `cd /path/to/main && git pull origin {{config:org.default_branch}}` |
