# Workflow: Pre-flight

**Trigger:** "pre-flight", "preflight banner", "what banner do I output", "starting X — what SOPs apply"

**Purpose:** Identify which SOPs apply to a task and emit the pre-flight banner from each.

---

## Steps

1. **Read the request.** Extract the task type (feature work, bug fix, version bump, PR review, retrospective, etc.).
2. **Read `compass.config.yaml`.** If missing, refuse and tell the requester the config is required.
3. **Map task type to SOPs** using this table:

| Task type | SOPs to load |
|-----------|-------------|
| Starting any feature/fix work | `dev-pipeline.md` + `worktree-discipline.md` |
| Creating a design doc, research, or spec | `design-process.md` + `brainstorming-and-review.md` |
| Bumping a version, cutting a release | `versioning.md` |
| Reviewing a PR | `pr-review.md` |
| Bootstrapping a new repo | `new-repo-pattern.md` + `dev-pipeline.md` |
| Post-work review | `retrospective-and-process-mining.md` |

4. **Read each mapped SOP** from `sops/`. Extract its pre-flight section.
5. **Substitute values** from `compass.config.yaml`. Every `{{config:...}}` placeholder becomes its concrete value.
6. **Emit each banner** as a separate code block.

## Output Format

```
SOP: dev-pipeline | Branch: feat/f-042-payment-flow | Prefix: feat:
SOP: worktree | Worktree: ../myapp-payment-flow | Branch: feat/f-042-payment-flow | Main: untouched
```

One line per loaded SOP. Use the SOP's exact pre-flight template — only fill in the placeholders, don't reword.

## Failure Modes

- **No config found:** Refuse, tell the requester the path you looked at and the keys you need.
- **SOP file missing:** The consumer's compass-core install may be partial. Tell them which SOP file you couldn't find.
- **Placeholder unresolved:** A required config key is missing. Name the key and stop.
