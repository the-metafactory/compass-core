# Workflow: Version Bump

**Trigger:** "version bump", "bump version", "release", "tag version", "cut a release"

**Purpose:** Walk the versioning SOP (`sops/versioning.md`), propose the bump, and create the release.

---

## Steps

1. **Read `compass.config.yaml`** — find `versioning.manifest`, `versioning.release_title_format`, and any `extensions.registry` block.
2. **Read the manifest file** at the configured path. Extract the current version.
3. **Determine the bump type:**
   - **Patch** — bug fixes, config tweaks, doc-only changes
   - **Minor** — new features, new capabilities, additive changes
   - **Major** — breaking changes, schema changes, removed features
4. **Compute the new version.** Apply semver to `current → new`.
5. **Output the pre-flight banner:**

```
SOP: versioning | Current: v{X.Y.Z} from {manifest path} | Bump: {patch/minor/major} → v{A.B.C}
```

6. **Confirm with the requester** before mutating anything. Show: current → new, and the bump rationale.
7. **On confirmation, edit the manifest** to the new version.
8. **Commit with `chore: bump to v{A.B.C}`** (or the project's chore prefix if configured).
9. **Push to the default branch.**
10. **Create the GitHub release** with `gh release create v{A.B.C} --title "{release_title_format}" --generate-notes --notes-start-tag v{X.Y.Z}`.
11. **Optional registry update** — if `extensions.registry` is set in `compass.config.yaml`, run its `update_command` to refresh the registry. compass-core treats this block as opaque; the consumer overlay defines the shape.
12. **Verify** — `gh release view v{A.B.C}` to confirm it exists.

## Failure Modes

- **Manifest not at configured path:** Refuse, tell the requester the path you looked at.
- **Current version invalid semver:** Refuse, ask the requester to fix the manifest first.
- **Uncommitted changes in working tree:** Refuse, ask the requester to commit or stash first.
- **gh CLI not authenticated:** Surface the auth error, don't try to retry.
- **Release already exists:** Refuse, ask the requester to either pick a different version or delete the existing release first.

## Verification

After the release is created, output:
- Release URL
- Tag name
- Manifest diff
- Commit hash
