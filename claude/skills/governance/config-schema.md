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
| `org.name` | `new-repo`, `version-bump`, validators | The git host org slug. Replaces `{{config:org.name}}`. |
| `org.display_name` | templates, READMEs | Human-readable brand name. Replaces `{{config:org.display_name}}`. |
| `org.default_license` | `new-repo`, templates | SPDX license identifier. Replaces `{{config:org.default_license}}`. |
| `org.default_branch` | `dev-pipeline`, `worktree-setup` | Default branch name. Replaces `{{config:org.default_branch}}`. |

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
    enabled: true                  # default: true
    required_sections:             # default: ["Critical Rules", "Standard Operating Procedures"]
      - Architecture
      - Critical Rules
      - Standard Operating Procedures
  label_check:
    enabled: true                  # default: true
    enforce_required: true         # default: true
```

| Key | Used by | Purpose |
|-----|---------|---------|
| `validators.claude_md.enabled` | `claude-md-check.ts`, `run-all.ts` | Toggle the CLAUDE.md validator. If `false`, the check skips with exit code 0. |
| `validators.claude_md.required_sections` | `claude-md-check.ts` | List of `## ` section headings every CLAUDE.md must contain. Match is case-insensitive on the heading text. If absent, the validator falls back to `["Critical Rules", "Standard Operating Procedures"]`. |
| `validators.label_check.enabled` | `label-check.ts`, `run-all.ts` | Toggle the label validator. If `false`, the check skips with exit code 0. |
| `validators.label_check.enforce_required` | `label-check.ts` | If `true` (default), missing required labels fail the check. If `false`, the check reports missing labels but exits 0 (warning mode). |

The label validator's *required label set* is the union of `labels.required.types` and `labels.required.priorities` (see the `labels` section above). If `labels.required` is absent the validator falls back to `["bug", "documentation", "feature", "infrastructure"]` for types and `["now", "next", "future"]` for priorities.

### Where the validators look for `compass.config.yaml`

Both validators use a shared loader at `engine/lib/config.ts`. The loader resolves the config path in this priority order:

1. The `COMPASS_CONFIG` environment variable (absolute or cwd-relative path)
2. The `--config <path>` flag passed to the validator
3. `compass.config.yaml` in the current working directory
4. (claude-md-check only) `compass.config.yaml` walked up from the directory of the CLAUDE.md being checked

If no config file is found, both validators fall back to the documented defaults so they remain useful out-of-the-box on a freshly bootstrapped repo.

---

## `versioning`

```yaml
versioning:
  manifest: arc-manifest.yaml                                    # default
  release_title_format: "{repo} v{version} — {description}"      # default
  deploy_command: ""                                             # optional
```

| Key | Used by | Purpose |
|-----|---------|---------|
| `versioning.manifest` | `version-bump` | Path to the file that holds the canonical version. |
| `versioning.release_title_format` | `version-bump` | Format string for `gh release create --title`. `{repo}`, `{version}`, `{description}` are substituted. |
| `versioning.deploy_command` | `version-bump` (optional) | Shell command run after release creation if your tooling has one (e.g., `arc upgrade {repo}`). compass-core does not prescribe a deploy command. |

For project-specific registry updates (a `REGISTRY.yaml` or equivalent that needs to be bumped after every release), use the `extensions.registry` block below — registries vary too much across organizations to live in the core schema.

---

## `extensions` (optional)

```yaml
extensions:
  new_repo:
    script: scripts/extra-bootstrap.sh         # optional
    steps:                                      # optional
      - "Apply SAML SSO settings"
      - "Add to internal CODEOWNERS map"
  registry:
    repo: my-org/registry-repo                  # optional
    file: REGISTRY.yaml
    update_command: |
      cd ../registry-repo
      # edit REGISTRY.yaml: set version for {{repo_name}} to {{new_version}}
      git add REGISTRY.yaml
      git commit -m "chore: bump {{repo_name}} to v{{new_version}}"
      git push origin main
```

The `extensions` block is where the consumer adds project-specific procedures that aren't generic enough for compass-core. compass-core's workflows look up `extensions.<workflow_name>` and run whatever is there. Anything inside `extensions` is opaque to compass-core — the consumer is responsible for its shape and content.

| Extension | Used by | Purpose |
|-----------|---------|---------|
| `extensions.new_repo` | `new-repo` workflow | Org-specific bootstrap steps (chat channels, deploys, dashboards, secret stores) that run after the seven generic steps. |
| `extensions.registry` | `version-bump` workflow | Org-specific package registry that needs version sync after each release. |

---

## Placeholder reference

Every `{{config:...}}` placeholder used anywhere in compass-core resolves to a key in this config:

All placeholders use dotted notation matching the config key path:

| Placeholder | Config key |
|------------|-----------|
| `{{config:org.name}}` | `org.name` |
| `{{config:org.display_name}}` | `org.display_name` |
| `{{config:org.default_license}}` | `org.default_license` |
| `{{config:org.default_branch}}` | `org.default_branch` |
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

If you see a `{{config:...}}` placeholder in a compass-core file that isn't in this table, it's a bug — file an issue.

---

## Template inputs

In addition to `{{config:...}}` placeholders (which come from `compass.config.yaml`), compass-core's templates use a separate `{{template:...}}` namespace for values that are supplied at template-instantiation time — i.e., facts about the *new repo being bootstrapped* that don't live in the existing repo's config.

These are used by `templates/CLAUDE.md.template` and `templates/arc-manifest.template.yaml` during the `new-repo` workflow.

| Placeholder | Provided by | Purpose |
|-------------|-------------|---------|
| `{{template:repo_name}}` | the developer running `new-repo` | Slug of the new repo (e.g., `acme-pipeline`) |
| `{{template:repo_description}}` | the developer | One-line description of the new repo |
| `{{template:package_name}}` | the developer | arc package name (often `@{{config:org.name}}/{{template:repo_name}}`) |
| `{{template:author_name}}` | the developer | Human / team owner name for the manifest |
| `{{template:author_github}}` | the developer | GitHub handle for the manifest |
| `{{template:sops_path}}` | new-repo workflow | Path the new repo will use to reference SOPs (e.g., `sops`, `compass-core/sops`) |

Why two namespaces? `compass.config.yaml` describes the *current* repo's governance values and is read at every workflow invocation. Template inputs describe a *new* repo at creation time and are only meaningful during a one-shot bootstrap. Keeping them separate lets workflows say with confidence "if it's `{{config:...}}`, it's already in the consumer's config — never prompt the developer for it."

If you see a `{{template:...}}` placeholder in a compass-core file that isn't in this table, it's a bug — file an issue.

---

## Defaults

When a key is marked "default" in this doc, the resolver substitutes the listed default value if the consumer's config omits the key. Required keys with no default cause the workflow to refuse and surface the missing-key error.

---

## Validation

`loadConfig()` (in `engine/lib/config.ts`) parses the YAML and then runs it through a Zod schema (`CompassConfigSchema`) that enforces the types documented above — including **element-level** checks on list fields like `labels.required.types`, `labels.required.priorities`, and `validators.claude_md.required_sections`. An unquoted `true` in a `priorities:` list, a stray number in `types:`, or a string passed where a boolean is expected all surface as a load-time error pointing at the offending field path (e.g., `labels.required.types.1: Expected string, received number`) rather than crashing a downstream validator with a cryptic traceback.

The schema uses `passthrough()` at the top level, so an unknown top-level key is preserved in the returned object instead of being stripped. This keeps compass-core forward-compatible with consumer repos that add their own extensions without having to declare every new section in the schema.
