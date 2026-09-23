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

## Threat model in the issue

Every issue for a detector, guard, check, or trust-path change states its **threat model** and what "done" means **before the build starts.** Name what it catches and what it doesn't:

> catches accidental copy-paste of 6+ consecutive words of client material; deliberate evasion is out of scope and listed as known limits.

Where deliberate evasion **is** in scope — credentials handling, CI trust paths — the issue says so, and the build and review are held to that higher bar instead. `sops/plan-breakdown.md` § Sub-issues — the executor-grade bar (item 2, Current state) is where an executor-grade issue carries this; a hand-written issue states it in its own "why" section.

**Why this is a rule, not a nicety.** #32 — the issue behind `corpus-overlap.ts` (#34) — never said which model it wanted. Review then had to work it out one construction at a time: round 3's H1 (a NUL-byte binary exemption) and round 4's J1 (a phantom `+++` file header) were both deliberate-evasion constructions the issue never scoped as in or out of bounds. `sops/pr-review.md` § Severity → Verdict § 4 uses the stated threat model to decide, at review time, which findings like these actually block.

## Detector-driven changes

**The test:** would we make this change if the detector didn't exist?

- **Yes** — the change is legitimate, even though a detector prompted it.
- **No** — it is evasion, and the change is refused.

A detector hit — a linter, a leak scanner, a CI gate, any automated red — resolves exactly one of three ways:

- (a) **Code changed**, because the detector was right. Name the desired state in one sentence that does not mention the detector, its rule, or passing: "fixtures use only synthetic names", not "reworded to clear the scrub". If the edit changes only whether the detector matches (fixture or test text, a renamed identifier, a restructured line with the same behaviour), (a) is not available. Resolve it as (b) or (c).
- (b) **Detector corrected**, because it was wrong. Either fix its pattern, with a test that watches it fail on the false positive first, or use its sanctioned exemption with a reason: e.g. `gate:allow <reason>`, the leak-check allow marker (#31), or the private-corpus scrub's reviewed-benign list (#32).
- (c) **Left open**, filed as an issue.

**Rewording until it passes is not a resolution.** Rewriting a fixture, renaming a variable, or restructuring a test line so a scanner stops matching — with no change to the desired state — is evasion under the test above, whichever of the three resolutions it's dressed up as. It gets refused in review (`sops/pr-review.md`) whether or not the author meant it that way.

## Independent source for a self-check

A fix that adds a runtime self-check or internal cross-check — an assertion the code runs against itself to prove its own output is right — must name, in the brief and the PR body, an **independent source for the expected value: one that exists before the checked thing is built.** If no such source exists, the fix deletes the claim the check was meant to support and relies on tests instead.

A check that recomputes the same function from the same inputs and compares the two answers will agree however broken the logic is — it partitions or repeats the same computation by construction, so it can only catch a variable getting reassigned underneath it, never the logic itself being wrong. `sops/confidentiality-gate.md` § 4c documents this in detail for `corpus-overlap.ts`'s own checks; the review findings that forced the fix are the pattern to recognise:

- **#34 K1.** A "filter check" computed `matches.filter(s => !fromRealDiff(s)).length` against `matches.length - matches.filter(fromRealDiff).length` — both derived from the same predicate over the same array, so they agreed for *any* predicate, including one forced to reject everything. The fix: recompute the expected set as `runsToShingles(addedRuns) ∩ corpusHas` — the diff's own added lines, shingled and intersected with the same corpus lookup the control already exercises, not the added lines alone — before any filtering runs, and require the reported matches to equal it exactly.
- **factory #277 Q1 / #280 V1.** Two ledger-tally reconciliation asserts each checked a count derived from `rows` against another value derived from those same `rows` — a bug that mis-tallied both the same way was invisible to either. The fix: reconcile against the reports actually *loaded* plus the receipt's own per-artboard digests, both available before any row is built, not against the rows the primary computation already produced.

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
