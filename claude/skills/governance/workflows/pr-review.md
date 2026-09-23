# Workflow: PR Review

**Trigger:** "review PR", "review pull request", "review this diff"

**Purpose:** Walk the pr-review SOP, apply each lens, post structured comments.

---

## Steps

1. **Read `sops/pr-review.md`.** Don't summarize from memory.
2. **Identify the PR.** Owner/repo + number.
3. **Pick the workflow:** FullReview (default), SecurityReview (auth/secrets/deps changed), or StandardReview (typo / docs only).
4. **Output the pre-flight banner:**

```
SOP: pr-review | PR: {owner/repo}#{N} | Workflow: {Standard/Security/Full}
```

5. **Read the PR description and full diff** with `gh pr view {N}` and `gh pr diff {N}`.
6. **Apply each lens systematically:**

| Lens | What you check |
|------|----------------|
| **CodeQuality** | Error handling, dead code, naming, test coverage, commit hygiene |
| **Security** | Injection, auth, data exposure, input validation, dependencies |
| **Architecture** | SRP, coupling, pattern consistency, abstraction, API surface |
| **Compliance** | CLAUDE.md present + valid, arc-manifest.yaml correct, labels per `compass.config.yaml`, conventional commits |
| **Performance** | N+1 queries, unbounded loops, missing pagination, blocking calls in async |

7. **Apply the detector-driven-change probe** from `sops/pr-review.md` § Review Procedure — for each *Detector hits* entry, compare the diff to the finding and check `git log -p` over the changed fixture/test files for a rewrite with no behaviour change. Where the issue states a threat model, apply `sops/pr-review.md` § Severity → Verdict § 4 to every finding, not only detector hits — a Compliance blocker below and the confidentiality carve-out are never reclassified by it.
8. **Categorize each finding** as Blocker / Should-fix / Nit.
9. **Post structured comments.** Per-finding inline comments are preferred over a single review essay.
10. **Submit the review** with the appropriate action: approve / request-changes / comment.

## Output

```
PR Review: {owner/repo}#{N} ({workflow})

Blockers:
  1. {finding} — {file:line}
Should-fix:
  1. {finding} — {file:line}
Nits:
  1. {finding} — {file:line}

Recommendation: {approve / request changes / comment}
```

## Failure Modes

- **PR not accessible:** gh auth or repo permissions. Surface, don't retry.
- **Diff too large to review in one pass:** Tell the requester, suggest splitting the PR.
- **CLAUDE.md / arc-manifest.yaml validation fails on the PR branch:** Add a Compliance blocker; do not approve.
