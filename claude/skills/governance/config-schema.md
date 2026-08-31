# Config Schema: compass.config.yaml

The governance skill, the validators, the templates, and the SOPs all read project-specific values from `compass.config.yaml` at the root of the consuming repo. This document is the canonical reference for every supported key.

See `compass.config.example.yaml` in the compass-core root for a working example.

---

## Schema header

```yaml
schema: compass-config/v1
```

Required, and the only key in this document that the **Zod schema itself** rejects you for omitting — `loadConfigFrom()` fails the config outright, and the installer exits 5 (`CONFIG_INVALID`) naming this key. Today only `v1` exists.

Every other key here is "required" in the sense described under [Resolution rule for an unset key](#resolution-rule-for-an-unset-key): Zod leaves it optional, and the installer fails late, when a SOP interpolates it and the value turns out not to exist. `schema` cannot work that way — nothing interpolates `{{config:schema}}`, because it is a version discriminator rather than prose input, so the late gate can never fire on it. It is checked at load instead. A discriminator that may be absent does not discriminate: a missing `schema` is indistinguishable from `compass-config/v1`, and the version it declines to state is the one fact no default can supply on its behalf.

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

## `channels` (optional)

```yaml
channels:
  team: "#eng-internal"      # optional
  public: "#community"       # optional
```

| Key | Used by | Purpose |
|-----|---------|---------|
| `channels.team` | `autonomous-work`, `in-session-dev-loop` | The internal channel the loop reports into: per-merge one-liners, the running dev narrative, the handover. Replaces `{{config:channels.team}}`. |
| `channels.public` | `in-session-dev-loop` | An outward-facing community channel, if the project has one. The SOPs treat it as sign-off-only, public-safe copy — never the default destination. Replaces `{{config:channels.public}}`. |

compass-core does not post anywhere and does not integrate with any chat platform. These values exist only so a SOP that says "narrate to the team channel" can name the actual channel in a consuming repo. Omit the block entirely and the SOPs read as plain prose — no workflow depends on a channel being configured.

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
| `{{config:channels.team}}` | `channels.team` |
| `{{config:channels.public}}` | `channels.public` |
| `{{config:versioning.manifest}}` | `versioning.manifest` |
| `{{config:versioning.release_title_format}}` | `versioning.release_title_format` |

If you see a `{{config:...}}` placeholder in a compass-core file that isn't in this table, it's a bug — file an issue.

### When placeholders are resolved

`bun engine/install.ts <target-dir>` renders every `{{config:...}}` placeholder **at install time**, writing real values into `<target-dir>/sops/*.md`. The installed SOP is the single source of truth: it names your branch pattern, your manifest, your channel. Nothing installed asks the model to read `compass.config.yaml` at run time.

### Fallback grammar

A SOP may supply its own phrasing for a key that a given project leaves unset:

| Form | Key set | Key unset |
|------|---------|-----------|
| `{{config:key}}` | the value | resolved by the rule below |
| `{{config:key\|some phrasing}}` | the value | `some phrasing` |
| `{{config:key\|}}` | the value | dropped — see step 3 below |

### Resolution rule for an unset key

Every field is optional in the Zod schema — every field except [`schema`](#schema-header), which is rejected at load — so *required* here means required by this document, and enforced at render time rather than at load. In order:

1. **Inline fallback** — if the source supplies `|phrasing`, that wins.
2. **Documented default** — keys with a default in the tables above render it. The installer **reports** every default it applied; defaults are applied, never applied silently.
3. **Documented optional** (`channels.team`, `channels.public`, `versioning.deploy_command`) — *drop*: if the placeholder sits inside a parenthetical, the whole parenthetical goes, so "post to the team channel (`#eng`)" closes cleanly to "post to the team channel". Otherwise the key's neutral phrase is substituted ("Report: the team channel"), so prose that needs a noun still reads.
4. **Anything else** — the install **fails**, naming the key and the files that referenced it, and writes nothing. A SOP with a blank where a branch name belongs is worse than no SOP.

A `{{config:...}}` token whose body is not a dotted key path — the meta-references this document uses when *describing* the grammar — is left verbatim, never treated as a lookup.

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
