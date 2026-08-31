# SOP: Versioning and Releases

**Purpose:** Standard versioning workflow for repos that adopt compass-core.
**Audience:** All contributors and agents working in a compass-governed repo.
**Configurable via:** `compass.config.yaml` (`versioning.manifest`, `versioning.release_title_format`, optional `extensions.registry`)

---

## Pre-flight

After reading this SOP, output:
```
SOP: versioning | Current: v{X.Y.Z} from {{config:versioning.manifest}} | Bump: {patch/minor/major} → v{A.B.C}
```

Verify before proceeding:
- Read `{{config:versioning.manifest}}` to get the current version
- Determined bump type (patch/minor/major) based on the changes since the last release
- **Pre-release classification scan:** before creating the release, scan the release title and every PR title that will be rolled into the auto-generated notes (`--generate-notes` composes the changelog from PR titles) for content your project classifies as non-public. A leaked term in a release title ships to every subscriber and to the public release feed. This is a distinct check from any per-PR gate — a per-PR gate never sees the composed release notes.

---

## Semantic Versioning

All compass-governed repos use semantic versioning (`MAJOR.MINOR.PATCH`) tracked in `{{config:versioning.manifest}}`.

| Bump | When | Example |
|------|------|---------|
| **Patch** | Bug fixes, config tweaks, minor corrections | `0.1.0` → `0.1.1` |
| **Minor** | New features, new capabilities, new validators | `0.1.x` → `0.2.0` |
| **Major** | Breaking changes, protocol changes, config schema changes | `0.x` → `1.0` |

## Manifest

The `version` field in the file pointed to by `versioning.manifest` is the single source of truth. Example for an arc-managed repo:

```yaml
# arc-manifest.yaml
name: my-package
version: 0.2.0
```

Do not track versions anywhere else. Do not use `package.json` version fields as authoritative unless `versioning.manifest` is explicitly set to `package.json`.

### Dual-versioned repos and the consistency gate

Some repos legitimately carry a version in **two** files: the manifest at
`{{config:versioning.manifest}}` (the release source of truth) **and** a
`package.json` read by the package manager and by any tool that derives a
`--version` string from the package. When both exist, they **must declare the
same version**. The invariant:

- **The manifest is the source of truth.** A repo's `--version` output MUST
  **derive from `{{config:versioning.manifest}}`**, not from an independently
  maintained `package.json` field. This is the drift the rule exists to
  prevent: the manifest says `0.33.0`, `package.json` still says `0.30.5`, and
  the CLI — which reads `package.json` — reports the stale number to every user
  who asks it what version they are running.
- **A version bump updates every version-bearing file.** When you bump the
  manifest, bump `package.json` in the same commit. Never in a follow-up.
- **CI enforces equality.** Add a check that fails when a dual-versioned repo's
  two `version` fields disagree. It must **skip** a repo that is not
  dual-versioned (one of the files is missing, or one has no `version` field —
  e.g. a `package.json` that omits it), so it never false-positives on a
  single-versioned repo.

compass-core does not ship this gate — the check is three lines of shell and
its correct home is your CI pipeline, next to the validators.

## Release Workflow

```bash
# 1. Bump version in the manifest file
#    Edit the version field to the new version

# 2. Commit the bump
git add {{config:versioning.manifest}}
git commit -m "chore: bump to v0.2.0"

# 3. Push to the default branch
git push origin {{config:org.default_branch}}

# 4. Create the GitHub release (this also creates the git tag)
gh release create v0.2.0 \
  --title "{{config:versioning.release_title_format}}" \
  --generate-notes \
  --notes-start-tag v0.1.0
```

The `release_title_format` template typically expands placeholders like `{repo}`, `{version}`, and `{description}`. See your repo's `compass.config.yaml` for the exact value.

### Optional: registry sync extension

Some organizations maintain a central package registry (a `REGISTRY.yaml` or equivalent) that lists every package and its current version, used for discovery and deployment automation. If your organization uses one, configure it in `compass.config.yaml` under the `extensions:` block:

```yaml
extensions:
  registry:
    repo: my-org/registry-repo
    file: REGISTRY.yaml
    update_command: |
      cd ../registry-repo
      # edit REGISTRY.yaml: set version for {{repo_name}} to {{new_version}}
      git add REGISTRY.yaml
      git commit -m "chore: bump {{repo_name}} to v{{new_version}}"
      git push origin main
```

When set, run the `update_command` after step 4 above. compass-core does not assume a registry exists — it is purely an opt-in extension.

### Optional: deploy step

If your tooling provides a deploy command (e.g., `arc upgrade {repo}`), run it after the release exists. compass-core does not prescribe a deploy command — set `versioning.deploy_command` in your config if you have one.

## Tag Conventions

- Tags are created by `gh release create`, not by `git tag` manually.
- Format: `v{MAJOR}.{MINOR}.{PATCH}` (e.g., `v0.2.0`)
- Every release gets a tag. Every tag gets a release. They are 1:1.

## Rules

- Bump version after every meaningful change before deploying.
- Release titles follow `{{config:versioning.release_title_format}}` (configurable per repo).
- Use `--generate-notes` for auto-generated changelogs.
- Use `--notes-start-tag` to scope the changelog to changes since the last release.
- Version bump commits use `chore:` prefix and go directly to the default branch.
- **If your repo is dual-versioned** (`{{config:versioning.manifest}}` + `package.json`), bump **both** in the same commit, derive any `--version` output from the manifest, and let a CI consistency check enforce that they stay equal.
- If your org uses a registry, **always update it** when bumping a version. A drifted registry is a stale source of truth and will mislead automation.
