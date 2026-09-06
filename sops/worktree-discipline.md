# SOP: Multi-Agent Worktree Discipline

**Purpose:** Prevent race conditions when multiple agents work on the same repo concurrently.
**Audience:** All agents and contributors using Claude Code or similar multi-session tooling.

---

## Pre-flight

After reading this SOP, output:
```
SOP: worktree | Placement: {placement} | Worktree: {path} | Branch: {type}/{name} | Main: untouched
```
Where `{placement}` is `sibling` or `in-repo` and `{path}` is the path you actually chose — report the decision, not the default, so a wrong placement is visible in the line rather than three commands later. Where `{type}` is one of `feat` (new feature), `fix` (bug fix), `infra` (tooling/CI), `docs` (documentation), `chore` (version bumps, metadata). The default for new feature work is `{{config:features.commit_prefix}}`.

Verify before proceeding:
- You are NOT switching branches in the main worktree
- The worktree directory does not already exist
- You have chosen a placement your session can actually enter (see § Placement)

---

## The Problem

When two agents share a worktree, they can conflict by:
- Switching branches under each other
- Stashing and popping each other's changes
- Editing the same files simultaneously
- Creating merge conflicts in uncommitted work

## The Rule

**Never switch branches or stash in the main worktree when another agent might be active.** Use `git worktree` for all feature work instead.

## Placement

Where the worktree goes is a precondition, not a preference. Choose once, before `git worktree add`:

| Placement | Path | Precondition |
|-----------|------|--------------|
| **Sibling** (default) | `../{repo}-{slug}` | The session can read and write sibling directories **and reach them with its own file tools** — only the first half is testable |
| **In-repo** | `.claude/worktrees/{slug}` | Always available; the directory must be gitignored |

Sibling is the default because it keeps the repo tree clean. It is not universally available: a session sandboxed to its working directory creates the sibling directory successfully and then cannot enter it — `git worktree add` succeeds, and every command after it fails.

**In Claude Code under any restricted or unattended permission mode, skip the probe entirely and use the built-in EnterWorktree tool.** That covers the default auto mode, any permission mode short of full access, and every harness-spawned agent. Those sessions are confined by construction — there is nothing to find out.

Everywhere else, probe — but read the result correctly, because **the probe is one-way**. Failure is conclusive: the sibling placement is unusable. A pass proves only that the *shell* can write and enter the parent, and success is not proof the placement will work: a harness can permit exactly that while still blocking the session from `cd`-ing there, or from reading and editing files there with its own file tools. This is not hypothetical — the session that produced this rule ran `git worktree add ../…`, a parent-directory write, and was boxed in regardless. No shell command can see the file-tool boundary, because that boundary is not in the shell.

```bash
# One-way. A failure rules the sibling placement out; a pass rules nothing in.
mkdir -p ../.wt-probe && (cd ../.wt-probe) && rmdir ../.wt-probe
```

When the probe fails — or whenever you are unsure — put the worktree **inside** the working directory:

```bash
git worktree add .claude/worktrees/{slug} -b {type}/{branch-name} origin/{{config:org.default_branch}}
```

In Claude Code, prefer the built-in **EnterWorktree** tool over that raw command: it creates the worktree under `.claude/worktrees/` and moves the session into it in one step. Name the worktree `{type}/{slug}` — that name becomes the branch, so it is what keeps the result matching the dev-pipeline convention.

**Recovery.** If any command is blocked *after* you created a sibling worktree, you are in the failure this section exists to prevent. Do not work around it one command at a time — remove the half-made sibling, then redo it in-repo:

```bash
git worktree remove ../{repo}-{slug}
```

A half-made sibling left on disk also collides with the next `git worktree add` for the same slug.

**In-repo worktrees carry one hazard: `git add -A` stages a nested worktree as a gitlink** — a submodule-shaped entry nobody intended, in a commit nobody reviewed. Where in-repo worktrees exist:

- Gitignore the worktree directory (`.claude/worktrees/`).
- Stage explicit paths. Never `git add -A`.

## Setup

The commands below use the sibling path; substitute `.claude/worktrees/{slug}` throughout if § Placement sent you in-repo.

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

- Worktree directories follow the placement chosen in § Placement: `../{repo}-{slug}` when the session can reach sibling directories, `.claude/worktrees/{slug}` when it cannot
- The slug should match the branch name's slug portion (minus the `{type}/` prefix)
- Examples: `../myapp-auth`, `../myapp-search-index`, `../myapp-billing-fix`; in-repo, `.claude/worktrees/auth`
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
#   in-repo placement (see § Placement):
git fetch origin pull/{N}/head && git worktree add .claude/worktrees/pr{N} FETCH_HEAD
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
| Probe the sibling precondition (one-way — a pass rules nothing in) | `mkdir -p ../.wt-probe && (cd ../.wt-probe) && rmdir ../.wt-probe` |
| Create worktree (sibling — needs sibling access) | `git worktree add ../{repo}-{slug} -b {type}/{branch} origin/{{config:org.default_branch}}` |
| Create worktree (in-repo — confined, unattended, or unsure) | `git worktree add .claude/worktrees/{slug} -b {type}/{branch} origin/{{config:org.default_branch}}` (Claude Code: the EnterWorktree tool, named `{type}/{slug}`) |
| Recover from a blocked sibling | `git worktree remove ../{repo}-{slug}`, then redo it in-repo |
| List worktrees | `git worktree list` |
| Remove worktree | `git worktree remove ../{repo}-{slug}` (or `.claude/worktrees/{slug}`) |
| Prune stale worktrees | `git worktree prune` |
| Delete local branch (merged) | `git branch -d {type}/{branch}` |
| Delete local branch (force, post-squash-merge) | `git branch -D {type}/{branch}` |
| Delete remote branch | `git push origin --delete {type}/{branch}` |
| Sync main after merge | `cd /path/to/main && git pull origin {{config:org.default_branch}}` |
