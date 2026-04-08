# Workflow: Worktree Setup

**Trigger:** "create worktree", "worktree for X", "feature branch worktree"

**Purpose:** Apply `worktree-discipline.md` with the project's `features.worktree_pattern`.

---

## Steps

1. **Read `compass.config.yaml`** — find `features.branch_pattern` and `features.worktree_pattern`.
2. **Read `sops/worktree-discipline.md`.**
3. **Identify the feature ID and slug** from the requester's input (e.g., "F-042 payment flow" → id `F-042`, slug `payment-flow`).
4. **Substitute the patterns:**
   - Branch: `features.branch_pattern` with `{id}` and `{slug}` replaced
   - Worktree dir: `features.worktree_pattern` with `{repo}` and `{slug}` replaced
5. **Output the pre-flight banner:**

```
SOP: worktree | Worktree: ../{repo}-{slug} | Branch: {branch} | Main: untouched
```

6. **Verify the worktree dir doesn't exist** with `ls`. If it does, refuse and tell the requester.
7. **Verify the branch doesn't exist** with `git branch --list`. If it does, refuse and tell the requester to either pick a different name or check it out manually.
8. **Create the worktree:**

```bash
git worktree add {worktree_dir} -b {branch} {default_branch}
```

9. **Install dependencies** in the new worktree (`bun install`, `npm install`, etc. — based on what's present).
10. **Verify** with `git worktree list` and `git -C {worktree_dir} branch --show-current`.

## Output

```
Worktree created:
  Path:   {absolute path}
  Branch: {branch name}
  Base:   {default branch} @ {commit hash}
```

## Failure Modes

- **Worktree dir exists:** Refuse, tell requester to pick another slug or remove the existing worktree.
- **Branch exists:** Refuse, surface the existing branch's location.
- **Not in a git repo:** Refuse, tell requester to cd into a repo first.
- **Bun/npm install fails:** Worktree is created but dependencies broken. Surface the install error, don't try to "fix" it.
