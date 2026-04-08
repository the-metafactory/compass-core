# compass-core

Reusable governance engine for Claude Code projects. Ships SOPs, validators, a governance skill, a governance subagent, and a CLAUDE.md template — installable into any repo via [arc](https://github.com/the-metafactory/arc).

> **Status:** v0.1.0 — Phase A1. Bootstrap surfaces in place; Phase B will de-metafactorize the mixed SOPs and Phase C will parameterize the validators.

## What you get

Four governance surfaces, all wired to one config:

| Surface | Where | What it does |
|---------|-------|-------------|
| **Skill** | `claude/skills/governance/` | Routes process questions to workflows |
| **Subagent** | `claude/agents/governance.md` | Autonomous governance task execution |
| **CLAUDE.md template** | `templates/CLAUDE.md.template` | Standard rules + label table + SOP activation table |
| **Validators** | `engine/validators/` | Pre-commit / CI structural checks |

## Install

```bash
arc install @the-metafactory/compass-core
```

Then create `compass.config.yaml` in your repo (use `compass.config.example.yaml` as a starting point) and run:

```bash
arc upgrade compass-core
```

## Usage

See `claude/skills/governance/SKILL.md` for the trigger phrases that activate the skill in any Claude Code session.

## Layout

```
compass-core/
├── claude/
│   ├── agents/governance.md          # Subagent persona
│   └── skills/governance/            # Skill + workflows
├── sops/                             # Standard operating procedures
├── standards/                        # Schemas + scripts
├── templates/                        # CLAUDE.md + arc-manifest templates
├── engine/                           # Validators + CI runners
└── arc-manifest.yaml                 # Arc package manifest
```

## License

MIT — see `LICENSE`.
