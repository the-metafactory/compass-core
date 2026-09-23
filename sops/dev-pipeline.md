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

## Detector-driven changes

**The test:** would we make this change if the detector didn't exist?

- **Yes** — the change is legitimate, even though a detector prompted it.
- **No** — it is evasion, and the change is refused.

A detector hit — a linter, a leak scanner, a CI gate, any automated red — resolves exactly one of three ways:

- (a) **Code changed**, because the detector was right. Name the desired state in one sentence that does not mention the detector, its rule, or passing: "fixtures use only synthetic names", not "reworded to clear the scrub". If the edit changes only whether the detector matches (fixture or test text, a renamed identifier, a restructured line with the same behaviour), (a) is not available. Resolve it as (b) or (c).
- (b) **Detector corrected**, because it was wrong. Either fix its pattern, with a test that watches it fail on the false positive first, or use its sanctioned exemption with a reason: e.g. `gate:allow <reason>`, the leak-check allow marker (#31), or the private-corpus scrub's reviewed-benign list (#32).
- (c) **Left open**, filed as an issue.

**Rewording until it passes is not a resolution.** Rewriting a fixture, renaming a variable, or restructuring a test line so a scanner stops matching — with no change to the desired state — is evasion under the test above, whichever of the three resolutions it's dressed up as. It gets refused in review (`sops/pr-review.md`) whether or not the author meant it that way.

## PR Body

If the repo has a PR template, it carries these sections. Otherwise this list is the source.

Every PR body includes:

- **Summary** — what changed and why.
- **Test plan** — how it was verified: commands run, gates passed.
- **Detector hits** — every red a detector produced during the work, each listed with its resolution letter (a/b/c) from **Detector-driven changes** above. `None` is a valid entry when nothing fired. A hit the diff shows evidence of that this section omits is itself a review finding (`sops/pr-review.md`).

Example entry:

```
## Detector hits
- leak-check `credential-assignment` on `token: someObject.token` — (b) detector corrected: false positive on a code expression, not a literal (#31)
```

## Rules

- PRs require at least one review (human or agent) before merge.
- All CI checks must pass before merge.
- Keep PRs focused — one feature or fix per PR.
- Update the GitHub issue when work starts, progresses, and completes.
- Use worktrees for concurrent agent work (see `sops/worktree-discipline.md`).
