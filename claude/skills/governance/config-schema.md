# Config Schema: compass.config.yaml

The governance skill, the validators, the templates, and the SOPs all read project-specific values from `compass.config.yaml` at the root of the consuming repo. This document is the canonical reference for every supported key.

See `compass.config.example.yaml` in the compass-core root for a working example.

---

## Schema header

```yaml
schema: compass-config/v1
```

Required. compass-core uses this to detect schema version. Today only `v1` exists.

---

## `org`

```yaml
org:
  name: acme-corp                    # required — git host org slug
  display_name: Acme                  # required — brand / display name
  default_license: MIT                # required — SPDX identifier
  default_branch: main                # default: main
```

| Key | Used by | Purpose |
|-----|---------|---------|
| `org.name` | `new-repo`, `version-bump`, validators | The git host org slug. Replaces `{{config:org_name}}`. |
| `org.display_name` | templates, READMEs | Human-readable brand name. Replaces `{{config:org_display_name}}`. |
| `org.default_license` | `new-repo`, templates | SPDX license identifier. Replaces `{{config:default_license}}`. |
| `org.default_branch` | `dev-pipeline`, `worktree-setup` | Default branch name. Replaces `{{config:default_branch}}`. |

---

## `features`

```yaml
features:
  id_prefix: F-                                # required
  branch_pattern: "feat/{id}-{slug}"           # default
  worktree_pattern: "../{repo}-{slug}"         # default
  commit_prefix: feat                          # default
```

| Key | Used by | Purpose |
|-----|---------|---------|
| `features.id_prefix` | `design-process`, blueprint | Feature ID prefix (e.g., `F-`, `P-`, `T-`). |
| `features.branch_pattern` | `dev-pipeline`, `worktree-setup` | Branch naming pattern. `{id}` and `{slug}` are substituted. |
| `features.worktree_pattern` | `worktree-setup` | Worktree directory pattern. `{repo}` and `{slug}` are substituted. |
| `features.commit_prefix` | `dev-pipeline` | Default commit type prefix (e.g., `feat`, `fix`, `chore`). |

---

## `labels`

```yaml
labels:
  source: standards/labels.yaml       # path or URL to the label set
  required:
    types: [bug, feature, infrastructure, documentation]
    priorities: [now, next, future]
```

| Key | Used by | Purpose |
|-----|---------|---------|
| `labels.source` | `label-sync`, `label-check` validator | Path or URL to the project's `labels.yaml`. |
| `labels.required.types` | `label-check` validator | Type labels every open issue must have at least one of. |
| `labels.required.priorities` | `label-check` validator | Priority labels every open issue must have at least one of. |

The format of `labels.source` is defined in `standards/labels.schema.yaml`.

---

## `validators`

```yaml
validators:
  claude_md:
    enabled: true
    required_sections:
      - Architecture
      - Critical Rules
  label_check:
    enabled: true
    enforce_required: true
```

| Key | Used by | Purpose |
|-----|---------|---------|
| `validators.claude_md.enabled` | `validator-run` | Toggle the CLAUDE.md validator. |
| `validators.claude_md.required_sections` | `claude-md-check.ts` | Section headings the validator enforces. Phase C parameterization. |
| `validators.label_check.enabled` | `validator-run` | Toggle the label validator. |
| `validators.label_check.enforce_required` | `label-check.ts` | If true, open issues without a required type/priority label fail. |

---

## `versioning`

```yaml
versioning:
  manifest: arc-manifest.yaml                                    # default
  release_title_format: "{repo} v{version} — {description}"      # default
  registry: {}                                                   # optional
```

| Key | Used by | Purpose |
|-----|---------|---------|
| `versioning.manifest` | `version-bump` | Path to the file that holds the canonical version. |
| `versioning.release_title_format` | `version-bump` | Format string for `gh release create --title`. `{repo}`, `{version}`, `{description}` are substituted. |
| `versioning.registry` | `version-bump` (optional) | Project-specific registry update procedure. Project-defined block. |

---

## `extensions` (optional)

```yaml
extensions:
  new_repo:
    script: scripts/extra-bootstrap.sh         # optional
    steps:                                      # optional
      - "Apply SAML SSO settings"
      - "Add to internal CODEOWNERS map"
```

The `extensions` block is where the consumer adds project-specific procedures that aren't generic enough for compass-core. compass-core's workflows look up `extensions.<workflow_name>` and run whatever is there. Anything inside `extensions` is opaque to compass-core — the consumer is responsible for its shape and content.

---

## Placeholder reference

Every `{{config:...}}` placeholder used anywhere in compass-core resolves to a key in this config:

| Placeholder | Config key |
|------------|-----------|
| `{{config:org_name}}` | `org.name` |
| `{{config:org_display_name}}` | `org.display_name` |
| `{{config:default_license}}` | `org.default_license` |
| `{{config:default_branch}}` | `org.default_branch` |
| `{{config:features.id_prefix}}` | `features.id_prefix` |
| `{{config:features.branch_pattern}}` | `features.branch_pattern` |
| `{{config:features.worktree_pattern}}` | `features.worktree_pattern` |
| `{{config:features.commit_prefix}}` | `features.commit_prefix` |
| `{{config:labels.source}}` | `labels.source` |
| `{{config:labels.required.types}}` | `labels.required.types` |
| `{{config:labels.required.priorities}}` | `labels.required.priorities` |
| `{{config:validators.claude_md.required_sections}}` | `validators.claude_md.required_sections` |
| `{{config:versioning.manifest}}` | `versioning.manifest` |
| `{{config:versioning.release_title_format}}` | `versioning.release_title_format` |

If you see a placeholder in a compass-core file that isn't in this table, it's a bug — file an issue.

## Defaults

When a key is marked "default" in this doc, the resolver substitutes the listed default value if the consumer's config omits the key. Required keys with no default cause the workflow to refuse and surface the missing-key error.
