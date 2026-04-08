# SOP: Dev Pipeline

**Status:** Placeholder — full content lands in Phase B (de-metafactorization).
**Target shape:** Generic branch / commit / PR / merge workflow with `{{config:branch_pattern}}`, `{{config:commit_prefix}}`, `{{config:default_branch}}` placeholders.

---

## Pre-flight (target)

After reading this SOP, output:
```
SOP: dev-pipeline | Branch: {{config:branch_pattern}} | Prefix: {{config:commit_prefix}}
```

---

## Coming in Phase B

This SOP will define:

- Branch naming pattern (configurable via `compass.config.yaml`)
- Commit message conventions (conventional commits, configurable prefix list)
- PR creation procedure
- Review + merge workflow
- Pre-merge checklist
- Post-merge cleanup

For now, see the design doc at the consuming repo's private fork for reference. Consumer projects adopting compass-core v0.1.0 should write their own dev-pipeline procedure until Phase B ships v0.2.0.
