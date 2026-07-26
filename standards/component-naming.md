# Standard: Component Taxonomy & Naming

**Purpose:** One place that answers "what *is* this thing, and what do I call it" for every metafactory
component — a skill, a tool, an agent, an adapter, a bundle, a factory. Consolidates rules that were
scattered across arc's `skill-repo-migration-spec.md`, the public taxonomy at
[meta-factory.ai/taxonomy](https://meta-factory.ai/taxonomy), and tribal knowledge, so they stop drifting.

**Audience:** Anyone creating a repo, writing a manifest, or naming a component in the ecosystem.

**Authoritative sources this consolidates:** the public taxonomy page (the taxonomy of *kinds*), arc's
manifest schema (the machine-readable `type:` field + `toStrictName` validator), and the XDG standard
(`xdg-base-directories.md`, whose suite-namespacing this grammar deliberately mirrors).

---

## 1. The three axes (never conflate them)

Every component has **three independent coordinates**. Confusing them is the root of most naming drift.

| Axis | Question | Where it lives | Example |
|---|---|---|---|
| **Provenance / scope** | *Who publishes it?* | the registry scope `@metafactory/<name>` — the ONLY namespace axis | `@metafactory/luna-lite` |
| **Artifact class** | *What kind is it?* | the manifest `type:` field (machine) + the repo-name `<type>` slot (humans) | `type: agent` |
| **Repo name** | *Where do humans find the source?* | the GitHub repo name — a **sortability convention, not an identity** | `metafactory-cortex-agent-luna-lite` |

**The load-bearing rule: identity is the manifest coordinate (`@scope/<name>@<version>` + `type:`), never
the repo name.** Nothing may derive identity from a repo name except the recorded source URL. Same-concept
different-class artifacts disambiguate **by name** (`dev-loop` vs `dev-loop-blueprint`), never by parallel
scopes — categories multiply; scopes are ownership. Putting a class into the scope fragments the namespace
and breaks "list everything `@metafactory` publishes."

---

## 2. The taxonomy of kinds

Every published unit is a **blueprint** — the atomic publishing unit. What a blueprint *is* comes from one
of three groups.

### 2a. Execution stack (vertical — each builds on the one below)

| Kind | Definition |
|---|---|
| **Tool** | Atomic capability — a single executable that does one thing well. |
| **Skill** | Capability + judgment — a tool plus AI judgment about when/how to use it. |
| **Process** | Orchestrated workflow — a DAG of executable steps. |
| **Agent** | Autonomous executor with memory — a process plus autonomy and persistent state. |
| **Graph** | Multi-agent coordination — multiple agents running processes through shared state. |

### 2b. Shaping artifacts (horizontal — applied at any stack level)

| Kind | Definition |
|---|---|
| **Prompt** | Context + framing — structured instructions that shape how a model approaches a task. |
| **Rules** | Constraints + gates — declarative boundaries governing what can and cannot happen. |
| **Playbook** | Ordered procedural guide — step-by-step procedure with gates and decision points. |

### 2c. App-runtime types (host-specific installables)

Some kinds exist only relative to a host app's plugin surface. They are real artifact classes but are not
in the public taxonomy because they mean nothing outside their host:

| Kind | Host | Definition |
|---|---|---|
| **Adapter** | cortex | A surface plugin — connects a platform (Discord/Slack/…) to the bus. |
| **Renderer** | cortex | A dispatch-sink plugin — turns lifecycle events into a surface's calls. |

The manifest `type:` set also admits `component`, `pipeline`, `action`, `system`, `library` for artifacts
that don't map to a taxonomy kind — use the closest accurate one; when unsure, ask in review, don't invent.

---

## 3. Composition tiers

Blueprints compose upward. These tiers are **not manifest `type:` values** — they are composition concepts
(and repo-name classes), see §4.

| Tier | Definition |
|---|---|
| **Blueprint** | The atomic published unit. Every component is one. |
| **Bundle** | A curated **collection of blueprints** — multiple blueprints of different types packaged because they belong together (e.g. a CLI plus the skills that drive it). A bundle has no runtime of its own. |
| **Factory** | A curated composition of bundles/blueprints **plus the runtime that composes them into an installable, runnable product** — "a factory you install." Distinguished from a bundle by carrying (or depending on) the runtime that makes the composition *run*, not just *install*. **Reference: the Factory MVP** = cortex (runtime) + a surface bundle (Discord) + compass-core (governance) + an agent bundle (Luna). The full, current definition is owned by the [vision](https://github.com/the-metafactory/vision); this standard fixes the *shape* (bundle-of-bundles + runtime → product), not the product roadmap. |

---

## 4. Repo-name grammar

GitHub repo names follow `metafactory-<owner>-<type>-<name>` — a flat-org human-sortability convention that
**mirrors** the XDG suite-namespacing (`<xdg-base>/metafactory/<app>/…`) but does **not** govern identity or
disk paths.

| Class | Shape | When | Example |
|---|---|---|---|
| Cross-app skill-led | `metafactory-skill-<name>` | the lead artifact is a `SKILL.md`, usable across apps | `metafactory-skill-plan-breakdown` |
| App-coupled skill | `metafactory-<app>-skill-<name>` | a skill inseparable from one app's runtime | `metafactory-soma-skill-handoff` |
| App-coupled component | `metafactory-<app>-<type>-<name>` | an agent/adapter/renderer owned by one app | `metafactory-cortex-agent-luna-lite`, `metafactory-cortex-adapter-discord`, `metafactory-cortex-renderer-pagerduty` |
| Cross-app bundle | `metafactory-bundle-<name>` | CLI-led, or multiple unrelated blueprints, spanning apps | `metafactory-bundle-discord` |
| Factory | `metafactory-factory-<name>` | a composed installable product (bundle-of-bundles + runtime) | *(the Factory MVP, when it takes a dedicated repo)* |

**Class-choice rule (mechanical):**
- Lead artifact is a `SKILL.md` (even if it ships tools/commands that serve the skill) → `metafactory-skill-<name>`.
- Lead artifact is a CLI, or the repo carries multiple unrelated blueprints → `metafactory-bundle-<name>`.
- The blueprint is inseparable from one app's runtime → `metafactory-<app>-<type>-<name>` (or `-<app>-skill-<name>`).
- A composition that ships/needs a runtime to run → `metafactory-factory-<name>`.

---

## 5. The name mapping (repo → manifest → frontmatter)

One name, three renderings, no arbitrary divergence — the validator (arc `toStrictName`) enforces it:

```
repo:      metafactory-cortex-agent-luna-lite
manifest:  name: luna-lite            # the <name> tail, verbatim
skill md:  name: luna-lite            # for a skill: LOWERCASE, matching the skill directory
```

- **The manifest `name:` is the `<name>` tail of the repo, verbatim** (lowercase, hyphenated).
- **A skill's `SKILL.md` frontmatter `name:` is lowercase and matches its skill directory** — per the
  [Agent Skill spec](https://agentskills.io/specification) (max 64 chars, lowercase letters/digits/hyphens,
  no leading/trailing hyphen). **This corrects arc's `skill-repo-migration-spec.md` §128, which said
  PascalCase** — that rule predates Anthropic's spec and would break under Claude Code's own skill
  validation. Lowercase wins everywhere; PascalCase frontmatter is a defect to fix on sight.

> **Follow-up owed:** arc's `skill-repo-migration-spec.md` §128 and any validator asserting PascalCase must
> be updated to lowercase to match this standard. Track it as an arc issue.

---

## 6. What the manifest `type:` accepts (and what it does NOT)

`type:` is the machine-readable artifact class: `skill | tool | agent | prompt | rules | playbook | process |
graph | adapter | renderer | component | pipeline | action | system | library`.

**`type:` is NEVER `bundle`, `blueprint`, or `factory`** — those are composition concepts / repo-name classes,
not installable types. A bundle-class repo declares the installable `type:` of its *lead* artifact (a
CLI-led bundle is usually `type: tool`; a skill-led one `type: skill`). arc installs by `type:`; it composes
by dependency graph.

---

## 7. Common mistakes this standard prevents

- **Deriving identity from the repo name.** The repo name is a convention; identity is `@scope/<name>@<version>`.
- **Putting the class in the scope** (`@metafactory-agent/luna`). Class is `type:`; scope is provenance only.
- **PascalCase skill names.** Lowercase, matching the dir (§5).
- **Calling a composition a `type:`.** Bundle/blueprint/factory are tiers, not `type:` values (§6).
- **Inventing a repo class.** The five classes in §4 are the set; a new one is a review conversation, not a fait accompli.
- **A repo name / manifest name / frontmatter name that disagree.** One name, three renderings (§5); the validator enforces it.

---

## 8. Applying this standard

- **New repo:** pick the class (§4 class-choice rule) → name the repo → set `name:` + `type:` (§5, §6) →
  `arc validate` enforces the derivation.
- **Reviewing a repo/PR:** confirm the three axes aren't conflated (§1), the class is right (§4), the name
  mapping holds (§5), and `type:` is a real installable class (§6).
- **The taxonomy of *kinds* is owned by [meta-factory.ai/taxonomy](https://meta-factory.ai/taxonomy)** — when
  a new kind is added there, add its row here; this standard governs *naming*, the taxonomy page governs
  *what exists*.
