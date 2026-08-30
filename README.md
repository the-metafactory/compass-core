# compass-core

Reusable governance engine for Claude Code projects. Ships SOPs, validators, a governance skill, a governance subagent, and a CLAUDE.md template — installable into any repo via [arc](https://github.com/the-metafactory/arc).

> **Status:** v0.4.0 — Phase D. SOPs are de-metafactorized (Phase B), validators are parameterized via `compass.config.yaml` (Phase C), and the placeholder grammar is consistent end-to-end (Phase D).

## What you get

Four governance surfaces, all wired to one config:

| Surface | Where | What it does |
|---------|-------|-------------|
| **Skill** | `claude/skills/governance/` | Routes process questions to workflows (e.g., "how do I bump the version?") |
| **Subagent** | `claude/agents/governance.md` | Autonomous governance task execution from another agent |
| **CLAUDE.md template** | `templates/CLAUDE.md.template` | Standard rules + label table + SOP activation table |
| **Validators** | `engine/validators/` | Pre-commit / CI structural checks for CLAUDE.md sections + GitHub label hygiene |
| **SOPs** | `sops/` | Nine generic SOPs (dev-pipeline, versioning, worktree, design-process, retrospective, new-repo-pattern, pr-review, brainstorming-and-review, autonomous-work) |

## Install

```bash
arc install @the-metafactory/compass-core
```

Then create `compass.config.yaml` in your repo root. The simplest possible config:

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
├── sops/                             # 9 generic SOPs
├── standards/                        # Schemas + scripts (sync-labels.ts) + labels.example.yaml
├── templates/                        # CLAUDE.md + arc-manifest templates
├── engine/
│   ├── lib/                          # Shared config loader + tests
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

25 tests covering the config loader (19) and the claude-md validator CLI (6).

## Versioning

compass-core follows semver. The `arc-manifest.yaml` is the source of truth for the version. Releases are tagged on GitHub and document the upgrade path in their notes.

## License

MIT — see `LICENSE`.
