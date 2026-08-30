# compass-core — Reusable Governance Engine

Reusable governance engine for Claude Code projects. Ships SOPs, validators, a governance skill, a governance subagent, and a CLAUDE.md template — installable into any repo via [arc](https://github.com/the-metafactory/arc).

## Architecture

- `claude/agents/` — Governance subagent persona (markdown definition)
- `claude/skills/governance/` — Governance skill: SKILL.md routing + workflow files
- `sops/` — Standard operating procedures (generic, parameterizable via `compass.config.yaml`)
- `standards/` — Schemas (label shape, required-section shape) and helper scripts
- `templates/` — File templates for new repos (CLAUDE.md, arc-manifest.yaml)
- `engine/validators/` — Structural validators (run via `bun engine/validators/*.ts`)
- `engine/ci/` — CI runners that compose validators

## Critical Rules

- This is a **public reusable package**. NEVER add project-specific identifiers (org names, infrastructure paths, secrets locations, internal SOP numbers, vendor names) to any file. All such values must live in consumer-side `compass.config.yaml` and be referenced via `{{config:...}}` placeholders.
- Before every commit, run the leak audit grep documented in `compass.config.example.yaml`. Zero tolerance for leaks — one hit means rollback the commit, not patch it forward.
- NEVER describe code you haven't read. Use Read/Glob/Grep to verify before making claims.
- NEVER fabricate file names, class names, or architecture. If unsure, read the source.
- Fix ALL errors found during type checks, tests, or linting — even if pre-existing. If you see it, fix it.
- Before fixing a bug or implementing a feature, ALWAYS check open PRs (`gh pr list`) and issues (`gh issue list`) first. Don't duplicate work.

## Standard Operating Procedures

This repo dogfoods the SOPs it ships. Before starting work, identify which SOPs apply and Read them. Output the pre-flight line from each loaded SOP.

| SOP | Activate when | File |
|-----|--------------|------|
| **Design process** | Creating specs, design docs, or research docs | `sops/design-process.md` |
| **Dev pipeline** | Creating branches, making PRs, starting any feature/fix work | `sops/dev-pipeline.md` *(placeholder until Phase B)* |
| **Versioning** | After merging PRs, before deploying, any version bump | `sops/versioning.md` *(placeholder until Phase B)* |
| **Worktree discipline** | Starting feature work (always — even solo) | `sops/worktree-discipline.md` |
| **PR review** | Reviewing a PR, before approving or merging | `sops/pr-review.md` |
| **Brainstorming + review** | Capturing strategic discussions or design decisions | `sops/brainstorming-and-review.md` |
| **Retrospective** | Post-work review, extracting process patterns | `sops/retrospective-and-process-mining.md` |
| **New repo pattern** | Bootstrapping a new repository | `sops/new-repo-pattern.md` *(placeholder until Phase B)* |
| **Autonomous work** | Driving a queue of slices to merge unattended | `sops/autonomous-work.md` |
| **In-session dev loop** | Driving feedback to shipped with the principal present | `sops/in-session-dev-loop.md` |

## Configuration Model

compass-core is parameterized via `compass.config.yaml` in the consuming repo. See `compass.config.example.yaml` for the full schema. Every SOP, workflow, validator, and template that needs project-specific values reads from this config — never from hardcoded values.

| Placeholder | Purpose |
|------------|---------|
| `{{config:org.name}}` | Git host org slug |
| `{{config:org.display_name}}` | Brand / display name |
| `{{config:org.default_branch}}` | Default branch (usually `main`) |
| `{{config:org.default_license}}` | License identifier (MIT, Apache-2.0, etc.) |
| `{{config:features.id_prefix}}` | Feature ID prefix (`F-`, `P-`, etc.) |
| `{{config:features.branch_pattern}}` | Branch naming pattern |
| `{{config:features.worktree_pattern}}` | Worktree directory pattern |
| `{{config:labels.required.types}}` | Required type labels |
| `{{config:labels.required.priorities}}` | Required priority labels |
| `{{config:validators.claude_md.required_sections}}` | CLAUDE.md sections to enforce |
| `{{config:channels.team}}` | Internal channel the loop SOPs report into |
| `{{config:channels.public}}` | Outward-facing channel (sign-off only) |
| `{{config:versioning.manifest}}` | Version source of truth |
| `{{config:versioning.release_title_format}}` | Release title format |

## Dogfooding

compass-core uses its own SOPs to develop compass-core. The same SOPs that ship to consumers are the ones followed in this repo. If a SOP is unclear when applied to compass-core itself, it's unclear for everyone — fix the SOP, not the workaround.

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
