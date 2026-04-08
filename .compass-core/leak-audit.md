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
