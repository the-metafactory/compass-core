# compass-core

Reusable governance engine for Claude Code projects. Ships SOPs, validators, a governance skill, a governance subagent, and a CLAUDE.md template. Install it into a target repo with `bun engine/install.ts <dir>`, which renders the SOPs against that repo's config; the package itself is distributed via [arc](https://github.com/the-metafactory/arc).

> **Status:** v0.4.0 — Phase D. SOPs are de-metafactorized (Phase B), validators are parameterized via `compass.config.yaml` (Phase C), and the placeholder grammar is consistent end-to-end (Phase D).

## What you get

Six governance surfaces, all wired to one config:

| Surface | Where | What it does |
|---------|-------|-------------|
| **Installer** | `engine/install.ts` | Renders the SOPs against a target repo's config and installs them into it |
| **Skill** | `claude/skills/governance/` | Routes process questions to workflows (e.g., "how do I bump the version?") |
| **Subagent** | `claude/agents/governance.md` | Autonomous governance task execution from another agent |
| **CLAUDE.md template** | `templates/CLAUDE.md.template` | Standard rules + label table + SOP activation table |
| **Validators** | `engine/validators/` | Pre-commit / CI structural checks for CLAUDE.md sections + GitHub label hygiene |
| **SOPs** | `sops/` | Twelve generic SOPs (dev-pipeline, versioning, worktree, design-process, retrospective, new-repo-pattern, pr-review, brainstorming-and-review, autonomous-work, in-session-dev-loop, plan-breakdown, confidentiality-gate) |

## Install

Governance follows the code: you install **into a project directory**, and the
SOPs are rendered against that project's config as they are written.

```bash
# 1. give the target repo a config
cp compass.config.example.yaml /path/to/your-repo/compass.config.yaml
$EDITOR /path/to/your-repo/compass.config.yaml

# 2. install into it
bun engine/install.ts /path/to/your-repo
```

That writes two things, and nothing outside the target:

| Path | What |
|------|------|
| `<target>/sops/*.md` | the SOPs, **rendered** — real branch pattern, real manifest, real channel |
| `<target>/CLAUDE.md` | a `<!-- compass-core:begin -->…<!-- compass-core:end -->` block: critical rules, then the SOP activation table, then your repo-specific values |

The rendering is the point. An installed SOP names your actual values, so no
generated file tells the model to go and read `compass.config.yaml` at run time
([#17](https://github.com/the-metafactory/compass-core/issues/17)). The output
is plain markdown: the target repo needs no bun, no runtime, no toolchain.

The block also carries the four generic critical rules, so an installed repo
passes compass-core's own `claude-md-check` out of the box — the installer and
the validator agree on what "governed" looks like.

**Flags:** `--force` overwrites existing files that differ; `--dry-run` reports
what would be written and touches nothing.

**It will not surprise you.** Missing config is an error, not a silent install
with defaults. An existing file that differs is refused per file and reported —
never overwritten without `--force`, never deleted. An existing `CLAUDE.md` is
merged, not replaced: only the bytes between the markers change, and re-running
with unchanged config produces a byte-identical tree.

Exit codes: `0` success; `2` usage; `3` bad target; `4` no config; `5` invalid
config; `6` unresolved placeholder; `7` refused existing files; `8` malformed
markers.

### Alternative: the arc package

```bash
arc install @the-metafactory/compass-core
```

This installs the compass-core package itself (engine, standards, templates,
governance skill). Use it when you want the whole toolkit; use
`bun engine/install.ts` when you want a repo governed.

Either way, create `compass.config.yaml` in your repo root. The simplest possible config:

```yaml
schema: compass-config/v1
org:
  name: acme-corp
  display_name: Acme
  default_license: MIT
  default_branch: main
features:
  id_prefix: F-
labels:
  source: standards/labels.yaml
```

Copy `compass.config.example.yaml` from the installed package as a starting point, or copy `standards/labels.example.yaml` for a working starter label set that matches the validator defaults.

See `claude/skills/governance/config-schema.md` for the full reference, including:

- The `extensions` block (consumer-owned opaque extensions to `new-repo` and `version-bump` workflows)
- The two placeholder namespaces:
  - `{{config:...}}` — values from `compass.config.yaml`
  - `{{template:...}}` — values supplied at template-instantiation time during the `new-repo` workflow

## Running the validators

Both validators auto-discover `compass.config.yaml` (env > `--config` flag > cwd > walk-up).

```bash
# Check CLAUDE.md has the required sections
bun engine/validators/claude-md-check.ts CLAUDE.md

# Check a GitHub repo has the required labels
bun engine/validators/label-check.ts owner/repo

# Run both at once
bun engine/ci/run-all.ts . owner/repo
```

When no config is present, the validators fall back to sensible defaults:

- **CLAUDE.md sections:** `Critical Rules`, `Standard Operating Procedures`
- **Required labels:** `bug`, `documentation`, `feature`, `infrastructure` (types) + `now`, `next`, `future` (priorities)

To customize, set `validators.claude_md.required_sections` and `labels.required.{types,priorities}` in your `compass.config.yaml`.

## Skill / subagent

The governance skill activates on phrases like:

- "look up the SOP for X"
- "bump the version"
- "bootstrap a new repo"
- "sync labels to repo X"

See `claude/skills/governance/SKILL.md` for the full trigger list and `claude/skills/governance/workflows/` for the nine workflow files.

To delegate a governance task autonomously, invoke the subagent at `claude/agents/governance.md`.

## Layout

```
compass-core/
├── claude/
│   ├── agents/governance.md          # Subagent persona
│   └── skills/governance/            # Skill + 9 workflows + config schema doc
├── sops/                             # 12 generic SOPs
├── standards/                        # Schemas + scripts (sync-labels.ts) + labels.example.yaml
├── templates/                        # CLAUDE.md + arc-manifest templates
├── engine/
│   ├── install.ts                    # Installer: render SOPs into a target repo
│   ├── lib/                          # Config loader + install-time renderer + tests
│   ├── validators/                   # CLAUDE.md + label validators + tests
│   └── ci/run-all.ts                 # CI runner
├── compass.config.example.yaml       # Starter config
└── arc-manifest.yaml                 # Arc package manifest
```

## Tests

```bash
bun install
bun test
```

94 tests covering the config loader (19), the claude-md validator CLI (6), the
install-time renderer (41), and the installer CLI (28).

## Versioning

compass-core follows semver. The `arc-manifest.yaml` is the source of truth for the version. Releases are tagged on GitHub and document the upgrade path in their notes.

## License

MIT — see `LICENSE`.
