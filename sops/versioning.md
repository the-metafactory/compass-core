# SOP: Versioning and Releases

**Status:** Placeholder — full content lands in Phase B (de-metafactorization).
**Target shape:** Generic semver workflow with `{{config:versioning.manifest}}`, `{{config:versioning.release_title_format}}`, `{{config:versioning.registry}}` placeholders.

---

## Pre-flight (target)

After reading this SOP, output:
```
SOP: versioning | Current: v{X.Y.Z} from {{config:versioning.manifest}} | Bump: {patch/minor/major} → v{A.B.C}
```

---

## Coming in Phase B

This SOP will define:

- Semantic versioning rules (when to bump patch / minor / major)
- The single source of truth for version (configurable: `arc-manifest.yaml`, `package.json`, etc.)
- Release procedure (commit → tag → GitHub release → optional registry update)
- Release title format (configurable)
- Tag conventions

For now, consumer projects adopting compass-core v0.1.0 should follow standard semver and conventional release practices until Phase B ships v0.2.0.
