# Workflow: Label Sync

**Trigger:** "sync labels", "apply labels", "label this repo", "label drift"

**Purpose:** Apply the project's standard label set to a target repo.

---

## Steps

1. **Read `compass.config.yaml`** — find `labels.source` (path to the project's `labels.yaml`) and `labels.required` (the type/priority labels that must exist).
2. **Read the source file.** It should match the schema in `standards/labels.schema.yaml`.
3. **Validate the source** against the schema. If invalid, refuse and report which fields are wrong.
4. **Identify the target repo.** Default: the consuming repo. Can be overridden by the requester.
5. **List existing labels** in the target with `gh label list --repo {target}`.
6. **Compute the diff:**
   - **Add** — labels in source but not in target
   - **Update** — labels in both but with different color/description
   - **Skip** — labels in target but not in source (don't delete unless requester explicitly asks)
7. **Show the diff to the requester.** Confirm before mutating.
8. **On confirmation, apply** with `gh label create` / `gh label edit`.
9. **Verify** by re-listing labels and confirming the diff is empty.

## Output

```
Label sync: {target}
  Added:    [bug, feature, infrastructure, ...]
  Updated:  [now (color #0E8A16 → #00C853)]
  Skipped:  [legacy-label-1, legacy-label-2]  (delete with --prune)
```

## Failure Modes

- **labels.source missing or invalid:** Refuse, point at the schema.
- **Target repo not accessible:** gh auth or repo permissions issue. Surface, don't retry.
- **Label has reserved color from another project:** Surface as a conflict, ask requester.
