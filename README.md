# compass-core

Reusable governance engine for Claude Code projects. Ships SOPs, validators, a governance skill, a governance subagent, and a CLAUDE.md template. Install it into a target repo with `bun engine/install.ts <dir>`, which renders the SOPs against that repo's config; the package itself is distributed via [arc](https://github.com/the-metafactory/arc).

> **Status:** v0.5.0 — arc-installable. SOPs are de-metafactorized (Phase B), validators are parameterized via `compass.config.yaml` (Phase C), and the placeholder grammar is consistent end-to-end (Phase D).

## What you get

Six governance surfaces, all wired to one config:

| Surface | Where | What it does |
|---------|-------|-------------|
| **Installer** | `engine/install.ts` | Renders the SOPs against a target repo's config and installs them into it |
| **Skill** | `claude/skills/governance/` | Routes process questions to workflows (e.g., "how do I bump the version?") |
| **Subagent** | `claude/agents/governance.md` | Autonomous governance task execution from another agent |
| **CLAUDE.md template** | `templates/CLAUDE.md.template` | Standard rules + label table + SOP activation table |
| **Validators** | `engine/validators/` | CLAUDE.md sections, GitHub label hygiene, and a leak/credential scanner |
| **CI gates** | `.githooks/`, `templates/workflows/` | Pre-commit hook + PR workflow, installed with `--with-ci` |
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

With `--with-ci`, two more — see [CI gates](#ci-gates---with-ci).

The rendering is the point. An installed SOP names your actual values, so no
generated file tells the model to go and read `compass.config.yaml` at run time
([#17](https://github.com/the-metafactory/compass-core/issues/17)). The output
is plain markdown: the target repo needs no bun, no runtime, no toolchain.

The block also carries the four generic critical rules, so an installed repo
passes compass-core's own `claude-md-check` out of the box — the installer and
the validator agree on what "governed" looks like.

**Flags:** `--with-ci` also installs the CI gates (below); `--force` overwrites
existing files that differ; `--dry-run` reports what would be written and
touches nothing.

### CI gates: `--with-ci`

```bash
bun engine/install.ts /path/to/your-repo --with-ci
```

Adds three more files, and changes nothing else — the CLAUDE.md block is a
function of your config alone, identical with or without this flag:

| Path | What |
|------|------|
| `<target>/.githooks/pre-commit` | local leak/credential scan over staged changes |
| `<target>/.githooks/leak-check.ts` | the scanner that hook runs |
| `<target>/.github/workflows/compass-governance.yml` | PR gate: claude-md-check, label-check, leak-check |

The workflow **checks compass-core out for itself**, pinned to an exact commit,
and runs the validators from that checkout against your files. Your repo carries
no engine tree and needs no bun manifest of its own. Bumping the pin is a
deliberate edit to that file — read what changed, land it in a PR.

The scanner is the one engine file that travels with the install, because the
local hook has no pinned checkout to lean on: it must run before a commit,
offline, in a repo that carries no engine. It is copied rather than referenced —
`leak-check.ts` imports node builtins only, so it starts anywhere `bun` does —
and it is refused, never overwritten, if you have edited your copy. Earlier
builds shipped the hook without it; the hook then resolved a path no installed
repo has, took its fail-open arm, and allowed every commit while scanning
nothing. If you installed before this fix, re-run with `--with-ci`.

The hook is inert until each clone opts in, which is the one manual step:

```bash
git config core.hooksPath .githooks
```

Optionally point the scanner at an operator pattern file (plaintext regexes, one
per line) kept **outside** the repo, so the guard is shared but your sensitive
strings never are:

```bash
export CONFIDENTIALITY_DENYLIST_FILE="$HOME/.config/compass/denylist.txt"
```

The variable ends in `_FILE` because it holds a path. `CONFIDENTIALITY_DENYLIST`
without the suffix is the org secret from `sops/confidentiality-gate.md`, which
carries a hashed payload — a different contract that this repo does not
implement. Sharing one name across both used to produce a silent fail-open.

In CI the scanner runs with `--require-patterns` whenever a denylist is
available, so a degraded gate fails rather than reporting green. The local hook
deliberately stays warn-and-continue: a hook that blocks every commit for an
unrelated reason gets deleted, and a deleted hook protects nothing.

**It will not surprise you.** Missing config is an error, not a silent install
with defaults. An existing file that differs is refused per file and reported —
never overwritten without `--force`, never deleted. An existing `CLAUDE.md` is
merged, not replaced: only the bytes between the markers change, and re-running
with unchanged config produces a byte-identical tree.

Exit codes: `0` success; `2` usage; `3` bad target; `4` no config; `5` invalid
config; `6` unresolved placeholder; `7` refused existing files; `8` malformed
markers.

### Getting the package: arc

```bash
arc install @the-metafactory/compass-core
# then, from the repo you want governed:
bun <store-path>/engine/install.ts <your-repo> [--with-ci]
```

`arc install` **fetches** compass-core into arc's store — engine, standards,
templates, governance skill. It does not govern a repo, and it no longer writes
anything into your working directory. `bun engine/install.ts` is the one blessed
project-install path, and the second line above is not optional if you want a
repo governed.

It used to be advertised as an alternative, and it behaved worse than that
description. arc renders a package's declared templates straight into your
current directory with a bare write — no existence check, no prompt, no backup —
so `arc install` in a repo that already had a `CLAUDE.md` overwrote it, and
overwrote it with unrendered `{{config:...}}` placeholders, because arc's
renderer speaks flat `{KEY}` and these templates do not. The manifest no longer
declares those templates, so arc has nothing to render. `templates/` still ships
them for `engine/install.ts` and the `new-repo` workflow, which render them with
the renderer that does speak their grammar.

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

# Scan a tree for credential shapes and operator-defined terms
bun engine/validators/leak-check.ts .

# Run all three at once
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

142 tests covering the config loader (19), the claude-md validator CLI (6), the
leak-check scanner (33), the install-time renderer (41), and the installer CLI
(43).

## Versioning

compass-core follows semver. The `arc-manifest.yaml` is the source of truth for the version. Releases are tagged on GitHub and document the upgrade path in their notes.

## License

MIT — see `LICENSE`.
