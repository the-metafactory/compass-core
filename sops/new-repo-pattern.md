# SOP: New Repository (Pattern)

**Purpose:** A *pattern* for bootstrapping a new repository into an organization that adopts compass-core. The seven generic steps below cover what every compass-governed project needs. Project-specific infrastructure (chat channels, deploy hooks, dashboards, secret stores) is added by your own consumer overlay, not by compass-core.
**Audience:** Founders, agents, and contributors creating new repos under a compass-governed org.
**Configurable via:** `compass.config.yaml` (`org.name`, `org.default_license`, `org.default_branch`, `labels.source`, `versioning.manifest`, optional `extensions.new_repo`)

---

## Pre-flight

After reading this SOP, output:
```
SOP: new-repo-pattern | Repo: {{config:org.name}}/{name} | Steps: {N}/7 applicable
```

Verify before proceeding:
- Repo name follows your org's conventions
- `gh` CLI is authenticated for the target org
- `arc` (or your equivalent installer) is available
- If your config defines `extensions.new_repo`, you have any prerequisites that extension declares

---

## The Seven Generic Steps

### 1. Create the repository on the host

**Visibility is an explicit decision, not a silent default.** Before running
`gh repo create`, decide — and record in the tracking issue — whether this repo
is `public` or `private`. Does it ship a product or package meant for external
consumers (public), or does it carry operational, client, or privately-held
content (private)? **Do not default to `--public`.** Accepting the default is
how repos go live before anyone has reviewed what is in them or registered
that they exist.

```bash
# Pick ONE, deliberately:
gh repo create {{config:org.name}}/{repo-name} --public --clone   # ships to external consumers
gh repo create {{config:org.name}}/{repo-name} --private --clone  # internal / client / operational
cd {repo-name}
```

- Initialize with README.md
- Add the org's default license: `{{config:org.default_license}}`
- Set default branch to `{{config:org.default_branch}}`

**If public, turn on the security baseline in the same session — don't defer it.**
At minimum: secret scanning, push protection, and a branch protection ruleset on
`{{config:org.default_branch}}`. A public repo without push protection can accept
a committed secret before anyone notices it exists, and the window between
`gh repo create --public` and "I'll harden it tomorrow" is exactly when the first
commits land. If your overlay vendors a security-baseline tool, run it here;
otherwise configure the settings directly via `gh api` or the repo settings UI.

### 2. Apply the standard label set

```bash
# From a checkout of compass-core (or your overlay), run:
bun standards/scripts/sync-labels.ts --source {{config:labels.source}} --owner {{config:org.name}} --repo {repo-name}
```

The script reads the label definitions from `{{config:labels.source}}` and applies them via `gh label`. The label *schema* (shape — color, name, description, required type/priority groupings) lives in compass-core at `standards/labels.schema.yaml`. The label *values* (the actual list of labels your org uses) live in your overlay.

### 3. Bootstrap CLAUDE.md from the compass-core template

```bash
# Either copy the template directly:
cp <compass-core>/templates/CLAUDE.md.template ./CLAUDE.md

# Or, if your overlay provides arc-driven generation:
arc upgrade <your-rules-package>
```

Edit the file:
- Replace any `{{config:*}}` placeholders not auto-substituted
- Add repo-specific sections (architecture, file structure, etc.)
- Keep all required sections (declared in your `compass.config.yaml` `validators.claude_md.required_sections`) intact

### 4. Create the version manifest

```bash
cp <compass-core>/templates/arc-manifest.template.yaml ./{{config:versioning.manifest}}
```

Fill in package name, initial version, description, and author. The file location is whatever your `versioning.manifest` config points to (default `arc-manifest.yaml`).

### 5. Wire up governance validators

If your project runs the compass-core validators in CI, copy the runner config and reference the validator entry points:

```bash
# Run validators locally to confirm the new repo passes
bun <compass-core>/engine/ci/run-all.ts --owner {{config:org.name}} --repo {repo-name}
```

Add an equivalent CI job in your repo's pipeline (GitHub Actions, CircleCI, etc.). The validators are repo-agnostic — they read `compass.config.yaml` for required sections, label set, and other policy.

**Sequencing a new required check — avoid the bootstrap deadlock.** Do **not**
make any new CI gate a required status check on day one of a brand-new repo.
Bring it up in this order:

1. Wire the gate as a **non-required** (warn-only) job first.
2. Confirm it is green on a burn-in PR or two.
3. **Only then** add it to required status checks.

Flipping a gate to required before step 2 creates a deadlock: an empty repo
with no prior burn-in has no way to merge its own first PR if the caller
workflow has a typo or the gate misfires. The gate is meant to block bad
changes, not to block the repo from ever having a good one.

**Break-glass (logged, not silent).** If a required gate is genuinely blocked
by a CI outage and an urgent merge cannot wait, an admin merge is permitted
only as a logged exception: comment on the PR with the reason and a link to
the outage, then merge. Routine `--admin` use to skip a gate is not
break-glass — it is the bypass habit that makes the gate decorative.

### 6. Register the repo in the project's ecosystem registry (optional)

If your overlay maintains an ecosystem registry (a YAML file listing every repo, used by downstream tools like dashboards or aggregated digests), add an entry there:

```yaml
# Example shape — your overlay defines its own schema
{repo-name}:
  description: "{one-line description}"
  type: {product|infrastructure|tool|skill}
  url: https://github.com/{{config:org.name}}/{repo-name}
  status: active
  visibility: {public|private}   # the decision made in Step 1 — never omitted
```

The `visibility:` field is not optional metadata: it is what lets a registry
validator fail closed on a live public repo that nobody registered. If your
registry omits it, an unregistered public repo is indistinguishable from an
unregistered private one.

compass-core does NOT prescribe an ecosystem registry format. If your overlay has one, document its location in your overlay's CLAUDE.md.

### 7. Create the first tracking issue

```bash
gh issue create --title "Bootstrap: {repo-name}" --label "infrastructure,now"
```

Apply the appropriate type label (`infrastructure`, `feature`, etc.) and a priority label (`now`, `next`, etc.) — both groups are defined in `{{config:labels.source}}`.

---

## Project-Specific Extensions

The seven steps above are the universal bootstrap. Real organizations have additional infrastructure: chat channels, deploy hooks, secret stores, paging schedules, dashboards. compass-core does not own those steps because they vary too much across projects.

If you need to standardize them, add an `extensions.new_repo` block to your `compass.config.yaml`:

```yaml
extensions:
  new_repo:
    script: scripts/extra-bootstrap.sh
    steps:
      - "Apply org-specific SAML SSO settings"
      - "Add to internal CODEOWNERS map"
      - "Create chat channel"
      - "Configure deploy webhook"
```

The `script` is a path inside your overlay repo that runs after step 7. The `steps` array is documentation only — it shows up in the pre-flight output so the agent knows what extra work this project requires.

compass-core treats the `extensions:` block as opaque — your overlay defines the shape and semantics.

---

## Verification Checklist

After completing all applicable steps, verify:

- [ ] Repo exists at `github.com/{{config:org.name}}/{repo-name}`
- [ ] Standard labels applied (run `gh label list --repo {{config:org.name}}/{repo-name}`)
- [ ] CLAUDE.md present and passes `bun engine/validators/claude-md-check.ts`
- [ ] `{{config:versioning.manifest}}` present with correct metadata
- [ ] Validators pass via `bun engine/ci/run-all.ts`
- [ ] Registered in the ecosystem registry (if applicable), including an explicit `visibility:` value (never the silent public default)
- [ ] First tracking issue created with appropriate labels
- [ ] Any `extensions.new_repo.script` ran successfully

---

## Removing a Repo

To archive or remove a repo:

1. Update its entry in your ecosystem registry to `archived` status (if applicable)
2. Remove any project-specific webhook / dashboard / chat-channel infrastructure (covered by your overlay's removal procedure)
3. Optionally archive the GitHub repo itself (`gh repo archive`)

compass-core does not prescribe a removal procedure beyond updating the registry — extend this section in your overlay if your infrastructure needs cleanup steps.

---

*This pattern is intentionally minimal. Extend it in your overlay; do not fork it in compass-core.*
