# SOP: Pull Request Review

**Purpose:** Standard procedure for reviewing PRs in any repo that adopts compass-core.
**Audience:** All contributors, agents, and reviewers.

---

## Pre-flight

After reading this SOP, output:
```
SOP: pr-review | PR: {owner/repo}#{N} | Workflow: {Standard/Security/Full}
```

Verify before proceeding:
- Identified the PR by `{owner}/{repo}#{number}`
- Picked the workflow appropriate for the diff scope
- Confirmed you are reviewing on a PR you have access to

---

## Workflows

| Workflow | When to use |
|----------|------------|
| **FullReview** | **Default.** All review lenses applied. Use for any non-trivial PR. |
| **SecurityReview** | Explicit security-only focus. Code quality + OWASP-oriented security analysis. Use when the PR touches auth, input validation, secrets handling, or dependencies. |
| **StandardReview** | Lightweight. Code quality + auto-detected lenses. Use only for trivial PRs (typo fixes, doc-only changes, dependency bumps). |

---

## Review Lenses

Apply these lenses based on workflow and diff content:

| Lens | Scope |
|------|-------|
| **CodeQuality** | Error handling, dead code, naming, test coverage, commit hygiene (always applied) |
| **Security** | Injection, auth, data exposure, input validation, dependencies (OWASP) |
| **Architecture** | SRP, coupling, pattern consistency, abstraction, API surface |
| **Compliance** | CLAUDE.md present and valid, arc-manifest.yaml correct, labels applied per `compass.config.yaml`, SOP table present, conventional commits |
| **Performance** | N+1 queries, unbounded loops, missing pagination, memory leaks, blocking calls in async code |

---

## Review Procedure

1. **Read the PR description.** Understand the stated intent before reading code.
2. **Read the diff in full.** Don't review by skimming.
3. **Apply each lens systematically.** Note findings as you go.
4. **Categorize findings:**
   - **Blocker** — must be fixed before merge (correctness, security, broken tests)
   - **Should-fix** — strongly recommended (architecture smells, missing tests for risky paths)
   - **Nit** — optional polish (naming, formatting)
5. **Post structured comments.** Per-finding inline comments are preferred over a single review essay.
6. **Approve, request changes, or comment.** Match the action to the severity of findings.

## Custom Review Skill (optional)

If your project ships a custom code-review skill or plugin, prefer it over manual review — it can apply the lenses consistently and produce structured output. The compass-core governance skill exposes a `pr-review` workflow that codifies this procedure; consumer projects can extend it with project-specific lenses via `compass.config.yaml`.

---

*This SOP applies to any project that adopts compass-core. Review lenses and severity categories are configurable.*
