# Workflow: New Repo Bootstrap

**Trigger:** "new repo", "bootstrap repo", "create repo in {project}", "initialize project"

**Purpose:** Walk the new-repo-pattern SOP, fill in project-specific steps from config.

> **Phase A1 note:** `sops/new-repo-pattern.md` is a placeholder until Phase B. Until then, this workflow runs the generic skeleton below; consumer projects should write their own infrastructure-specific extension and reference it from `compass.config.yaml`'s `extensions.new_repo`.

---

## Steps

1. **Read `compass.config.yaml`** — find `org.name`, `org.default_license`, `org.default_branch`, `labels.source`, `extensions.new_repo` (optional, for project-specific steps).
2. **Read the requested repo name.** Validate it follows the project's naming conventions if any are configured.
3. **Output the pre-flight banner:**

```
SOP: new-repo-pattern | Repo: {org.name}/{repo-name} | Steps: {N}/{M} applicable
```

4. **Create the repo** with `gh repo create {org.name}/{repo-name} --{visibility} --license {license} --clone`.
5. **Apply the standard label set** by invoking the `label-sync` workflow against the new repo.
6. **Bootstrap CLAUDE.md** by copying `templates/CLAUDE.md.template` and substituting all `{{config:...}}` placeholders.
7. **Bootstrap arc-manifest.yaml** by copying `templates/arc-manifest.template.yaml`.
8. **Run the project-specific extension** if `extensions.new_repo` is configured:
   - `extensions.new_repo.script` — a path to a shell script the consumer wrote
   - `extensions.new_repo.steps` — a list of additional manual steps the consumer wants the agent to walk through
9. **Create the first tracking issue** with the appropriate labels (type + priority).
10. **Verify** with `gh repo view {org.name}/{repo-name}` and confirm:
    - Repo exists
    - License applied
    - Default branch correct
    - Labels match config
    - CLAUDE.md committed
    - First issue exists with required labels

## Failure Modes

- **Org permissions insufficient:** Surface the gh error, don't retry.
- **Repo name conflicts:** Refuse, tell the requester to pick another.
- **Extension script fails:** Stop, surface the error, leave the repo in its partial state — don't try to "clean up" by deleting it.
- **Required label set has labels missing from `labels.source`:** Refuse, tell the requester to fix the source first.

## Verification

After bootstrap, the new repo should pass `validator-run` against compass-core's validators with zero structural failures.
