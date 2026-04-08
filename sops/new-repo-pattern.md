# SOP: New Repository (Pattern)

**Status:** Placeholder — full content lands in Phase B (extraction from a private new-repo SOP).
**Target shape:** A *pattern* for bootstrapping a new repo into a project that uses compass-core. Concrete steps reference `{{config:org_name}}`, `{{config:default_license}}`, `{{config:label_set}}`, etc.

---

## Pre-flight (target)

After reading this SOP, output:
```
SOP: new-repo-pattern | Repo: {{config:org_name}}/{name} | Steps: {N}/{M} applicable
```

---

## Coming in Phase B

This SOP will define a generic bootstrap pattern:

1. Create the repo on the configured Git host with the project's default license
2. Apply the project's standard label set (from `compass.config.yaml`)
3. Bootstrap CLAUDE.md from the compass-core template
4. Bootstrap arc-manifest.yaml from the template
5. Wire up project-specific governance hooks (validators, CI checks)
6. Register the repo in the project's ecosystem registry (if any)
7. Create the first tracking issue

Project-specific extensions to this pattern (covering whichever infrastructure your project uses — chat channels, deploy hooks, dashboards, secret stores) live in consumer overlays, not in compass-core. This SOP is the *generic shape* — extend it with project-specific infrastructure steps in your own repo.

For now, consumer projects adopting compass-core v0.1.0 should bootstrap repos manually until Phase B ships v0.2.0.
