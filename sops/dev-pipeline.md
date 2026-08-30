# SOP: Development Pipeline

**Purpose:** Standard development workflow for repos that adopt compass-core.
**Audience:** All contributors and agents working in a compass-governed repo.
**Configurable via:** `compass.config.yaml` (`features.branch_pattern`, `features.commit_prefix`, `org.default_branch`)

---

## Pre-flight

After reading this SOP, output:
```
SOP: dev-pipeline | Branch: {{config:features.branch_pattern}} | Prefix: {{config:features.commit_prefix}}
```

Verify before proceeding:
- Current branch is NOT `{{config:org.default_branch}}` (unless doing a version bump)
- No existing PR covers this work (`gh pr list`)
- No existing issue covers this work (`gh issue list`)

---

## Branch Strategy

- `{{config:org.default_branch}}` is the production branch. Always deployable.
- Feature branches follow `{{config:features.branch_pattern}}` (typically `feat/{id}-{slug}`, e.g., `feat/F-001-label-validator`).
- Bug fix branches use the same pattern with a `fix/` prefix (e.g., `fix/F-012-missing-section`).
- Never commit features directly to the default branch. Version bumps (`chore:`) are the exception.

The `{id}` placeholder corresponds to your project's feature numbering scheme (defined in `features.id_prefix`). The `{slug}` placeholder is a short kebab-case description.

## Commit Conventions

Use conventional commits. The `commit_prefix` config value controls the default for `feat:` work — other prefixes are universal:

| Prefix | Usage |
|--------|-------|
| `feat:` | New feature or capability |
| `fix:` | Bug fix |
| `chore:` | Maintenance (version bumps, dependency updates) |
| `docs:` | Documentation only |
| `test:` | Adding or updating tests |
| `refactor:` | Code restructuring without behavior change |

Examples:
```
feat: add CLAUDE.md section validator
fix: handle missing labels.yaml gracefully
chore: bump to v0.2.0
docs: add dev-pipeline SOP
test: add integration tests for label-check
refactor: extract label parsing into shared util
```

## Workflow

1. **Pick a task** — Check GitHub issues, pick one labeled `now` or `next` (or whatever priority labels your `labels.yaml` defines).
2. **Create branch** — `git checkout -b {{config:features.branch_pattern}} {{config:org.default_branch}}`
3. **Implement** — Write tests first, then code. Commit early, commit often.
4. **Push** — `git push -u origin {{config:features.branch_pattern}}`
5. **PR** — `gh pr create` with clear title and description. Link to the tracking issue.
6. **Review** — Address feedback. Keep commits clean.
7. **Merge** — Squash or merge to the default branch. Delete the feature branch. For worktree-based work, follow the full cleanup procedure in [`sops/worktree-discipline.md`](./worktree-discipline.md#cleanup) (remove worktree → delete local branch → delete remote branch → sync primary worktree).
8. **Version** — Bump `{{config:versioning.manifest}}`, commit, push, create release.

## Rules

- PRs require at least one review (human or agent) before merge.
- All CI checks must pass before merge.
- Keep PRs focused — one feature or fix per PR.
- Update the GitHub issue when work starts, progresses, and completes.
- Use worktrees for concurrent agent work (see `sops/worktree-discipline.md`).
