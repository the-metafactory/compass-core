# Leak Audit Log

This file records every leak audit run against compass-core. Every commit that touches user-facing files MUST run the audit and append a result here.

The leak audit grep is:

```bash
rg -i 'metafactory|meta-factory|grove|mellanon|cloudflare|hooks\.meta-factory|SOP-7|CLOUDFLARE_API_TOKEN|GITHUB_WEBHOOK_SECRET|GITHUB_REPOS|grove-bot|pai/secrets|discord' .
rg 'metafactory-specific|G-\d{2,3}|@metafactory/|meta-factory\.ai|the-metafactory/grove|the-metafactory/blueprint|the-metafactory/pulse|the-metafactory/compass-metafactory' .
rg -i 'SOP-\d|grove|blueprint:|pulse|nz/eu|nz↔eu|operator|on-call' .
```

## Allowed references

These are NOT leaks — they are factual references to the parent org as the package owner / installer:

- `the-metafactory` appearing as a GitHub org slug in package metadata (`arc-manifest.yaml` author/repository, LICENSE copyright, README install URL)
- `@the-metafactory/compass-core` as the package namespace
- `https://github.com/the-metafactory/arc` as the install tool URL

## Forbidden references

Any of the following hits = LEAK = rollback the commit:

- Internal SOP numbers (SOP-7, SOP-8, etc.)
- Internal infrastructure paths (`~/.config/pai/secrets/`, `cloudflare.env`, `hooks.meta-factory.ai`, internal Worker bindings)
- Internal product names beyond the parent org reference (grove specifics, pulse specifics, blueprint feature IDs, compass-metafactory)
- Internal team naming, operator names, internal user IDs (mellanon, etc.)
- Internal feature ID examples (G-200 from grove, B-109 from blueprint, etc.)
- Internal incident response, on-call, NZ↔EU bridge framing

---

## v0.1.0 — 2026-04-08

**Audit pattern 1** — broad forbidden terms:

```
LICENSE:3                  Copyright (c) 2026 the-metafactory contributors          ALLOWED (copyright)
README.md:3                via [arc](https://github.com/the-metafactory/arc)        ALLOWED (install tool URL)
README.md:21               arc install @the-metafactory/compass-core                ALLOWED (package namespace)
arc-manifest.yaml:1        name: "@the-metafactory/compass-core"                    ALLOWED (package name)
arc-manifest.yaml:6        name: the-metafactory                                    ALLOWED (author)
arc-manifest.yaml:7        github: the-metafactory                                  ALLOWED (author github)
arc-manifest.yaml:8        repository: the-metafactory/compass-core                 ALLOWED (repo metadata)
CLAUDE.md:3                via [arc](https://github.com/the-metafactory/arc)        ALLOWED (install tool URL)
```

**Audit pattern 2** — specific internal references:

```
(no matches)
```

**Audit pattern 3** — internal SOPs / infra terminology:

```
(no matches)
```

**Verdict:** PASS. All hits are factual package-metadata references to the parent org. Zero internal leaks.

---

## v0.2.0 — 2026-04-08 — Phase B (de-metafactorization)

**Scope of edits:**
- `sops/dev-pipeline.md` — placeholder replaced with full generic content (parameterized via `features.branch_pattern`, `features.commit_prefix`, `org.default_branch`)
- `sops/versioning.md` — placeholder replaced; registry sync moved to `extensions.registry`; `versioning.deploy_command` added as optional field
- `sops/new-repo-pattern.md` — placeholder replaced with the seven generic bootstrap steps; project-specific infrastructure (chat, deploys, dashboards) routed through `extensions.new_repo`
- `claude/skills/governance/workflows/version-bump.md` — Phase A1 placeholder note removed; `extensions.registry` reference added
- `claude/skills/governance/workflows/new-repo.md` — Phase A1 placeholder note removed
- `claude/skills/governance/workflows/sop-lookup.md` — placeholder failure-mode replaced with generic missing-file handling
- `claude/skills/governance/config-schema.md` — placeholders standardized to dotted notation; `extensions.registry` documented; `versioning.deploy_command` documented
- `compass.config.example.yaml` — `extensions.registry` and `deploy_command` examples added

**Audit pattern 1** — broad forbidden terms:

```
(only previously-allowed factual package-metadata references remain — same set as v0.1.0)
```

**Audit pattern 2** — specific internal references:

```
(no matches outside leak-audit.md itself)
```

**Audit pattern 3** — internal SOPs / infra terminology:

```
(no matches; "on-call rotations" example in new-repo-pattern.md was rephrased to "paging schedules" to avoid the on-call false positive)
```

**Verdict:** PASS. The de-metafactorized SOPs introduce zero new internal references. All metafactory-specific content (Cloudflare bindings, grove bot, discord channels, REGISTRY.yaml in meta-factory repo, the SOP-7 incident framing, etc.) is correctly routed to consumer overlay extensions (`extensions.new_repo`, `extensions.registry`) instead of being baked into compass-core.

---

## v0.3.0 — 2026-04-08 — Phase C (parameterized validators)

**Scope of edits:**
- `engine/lib/config.ts` — new shared `compass.config.yaml` loader (`findConfigPath`, `loadConfig`); supports `COMPASS_CONFIG` env var, explicit `--config` flag, cwd, and walk-up-from-target precedence; opaque `extensions` block preserved as `Record<string, unknown>`
- `engine/lib/__tests__/config.test.ts` — 8 tests covering loader precedence, parsing, error handling, and the opaque extensions block
- `engine/validators/claude-md-check.ts` — now reads `validators.claude_md.{enabled,required_sections}` from config; `--config` flag supported; falls back to `["Critical Rules", "Standard Operating Procedures"]` when no config is present
- `engine/validators/__tests__/claude-md-check.test.ts` — 7 tests covering default sections, config-driven sections, the disabled toggle, and case-insensitive matching
- `engine/validators/label-check.ts` — now reads `labels.required.{types,priorities}` from config; supports `validators.label_check.{enabled,enforce_required}`; `--config` flag supported; falls back to `["bug", "documentation", "feature", "infrastructure"]` + `["now", "next", "future"]`
- `claude/skills/governance/config-schema.md` — `validators` section expanded with default values, fallback behaviour, and a new "Where the validators look for `compass.config.yaml`" subsection documenting the loader precedence
- `package.json` — new minimal manifest declaring `yaml` dependency, `@types/bun` devDep, and `bun test` script
- `bun.lock` — generated by `bun install`

**Audit pattern 1** — broad forbidden terms:

```
(only previously-allowed factual package-metadata references remain — same set as v0.1.0/v0.2.0,
plus identical references in the new package.json and bun.lock files)
```

**Audit pattern 2** — specific internal references:

```
(no matches outside leak-audit.md itself)
```

**Audit pattern 3** — internal SOPs / infra terminology:

```
(no matches outside leak-audit.md itself)
```

**Verdict:** PASS. The new validator config loader and tests reference only generic concepts (`acme-corp` in the test fixture, the documented default label set). Zero new internal references. The `package.json` adds the parent-org package name once (`@the-metafactory/compass-core`), which matches the existing `arc-manifest.yaml` allowed reference.

---

## v0.4.0 — 2026-04-08 — Phase D (quality hardening)

**Scope of edits:**
- `CLAUDE.md` — placeholder reference table fixed: `{{config:org_name}}`/`{{config:org_display_name}}`/`{{config:default_branch}}`/`{{config:default_license}}` → dotted notation matching the schema
- `templates/CLAUDE.md.template` — `{{config:repo_name}}`, `{{config:repo_description}}`, `{{config:sops_path}}` migrated to a new `{{template:...}}` namespace; `{{config:org_name}}` → `{{config:org.name}}`; `{{config:default_branch}}` → `{{config:org.default_branch}}`
- `templates/arc-manifest.template.yaml` — `{{config:package_name}}`, `{{config:repo_description}}`, `{{config:author_name}}`, `{{config:author_github}}`, `{{config:repo_name}}` → `{{template:...}}`; `{{config:org_name}}` → `{{config:org.name}}`; `{{config:default_license}}` → `{{config:org.default_license}}`
- `claude/skills/governance/config-schema.md` — new "Template inputs" section documenting the `{{template:...}}` namespace and the six template-instantiation variables (`repo_name`, `repo_description`, `package_name`, `author_name`, `author_github`, `sops_path`); rationale for the two-namespace split spelled out
- `claude/skills/governance/workflows/new-repo.md` — Step 6 (CLAUDE.md bootstrap) and Step 7 (arc-manifest bootstrap) updated to mention both placeholder namespaces and link to the schema
- `standards/labels.example.yaml` (new) — starter label set matching the validator's fallback defaults so a fresh consumer can sync labels out-of-the-box without writing their own from scratch

**Why this matters:**

Phase B/C left the canonical schema dotted (`{{config:org.name}}`) but never propagated the change into `CLAUDE.md` and the two `templates/`, which still used the legacy underscored form. This release closes that gap and additionally introduces a clean separation between *config-driven* placeholders (read from `compass.config.yaml`) and *template-instantiation* placeholders (provided by the developer running the `new-repo` workflow). The two now live in distinct namespaces (`{{config:...}}` vs `{{template:...}}`), so workflows can confidently say: "if it's `{{config:...}}`, it's already in the consumer's config — never prompt."

**Audit pattern 1** — broad forbidden terms:

```
(only previously-allowed factual package-metadata references remain — same set as v0.1.0/v0.2.0/v0.3.0;
no new hits introduced by the placeholder rename or the new labels.example.yaml)
```

**Audit pattern 2** — specific internal references:

```
(no matches outside leak-audit.md itself)
```

**Audit pattern 3** — internal SOPs / infra terminology:

```
(no matches outside leak-audit.md itself; the initial draft of config-schema.md → "Template inputs"
used the word "operator" five times, which tripped the audit because internal metafactory roles use
that term — replaced with "the developer running new-repo" / "the developer" before commit)
```

**Test suite:** `bun test` → 15 pass / 0 fail (config loader: 8 tests; claude-md-check.ts: 7 tests).

**Verdict:** PASS — all three audit patterns clean, all tests green, the placeholder contract is now consistent end-to-end across CLAUDE.md, templates, schema doc, and workflows. The quality hardening pass uncovered (and fixed) a real false-positive leak ("operator") that the previous releases would have missed if not for the iterated audit. **This entry doubles as the comprehensive final audit covering v0.1.0 → v0.4.0.**
