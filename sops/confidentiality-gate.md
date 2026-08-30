# SOP: Confidentiality Gate & Denylist Stewardship

**Purpose:** Operate a confidentiality denylist and the gates that consume it — from opening a
client engagement, through rolling the CI gate out, to handling false positives, reviewing fork
PRs, and the periodic posture check.
**Audience:** The principal (denylist writes, org-admin operations) and the maintainer who owns
the gate engine and triage.
**Configurable via:** `compass.config.yaml` (`org.default_branch`)

---

## What this SOP assumes you have

compass-core ships the *procedure*, not the scanner. To follow this SOP a project needs four
capabilities, however they are implemented:

| Capability | Must be able to |
|---|---|
| **denylist tool** | `validate` the source file, `lookup` a word with **masked** output, and `sync` the hashed form to the CI secret |
| **CI gate** | Run on every PR: denylist tier (hashed) + shape-pattern tiers (emails, identifiers, codes) |
| **local gate** | Run the **plaintext** denylist against a checkout, for cases CI cannot cover (fork PRs) |
| **baseline verifier** | Report, read-only, per public repo: secret scanning, push protection, rulesets, required checks, and unregistered public repos |

Commands below are written as `<denylist-tool> validate` etc. Substitute your project's actual
entry points; the discipline is what transfers.

---

## Pre-flight

After reading this SOP, output:
```
SOP: confidentiality-gate | Action: {engagement-open|sync|burn-in|enforce|fp|fork-pr|verify} | Denylist: {path to the private denylist source}
```

---

## 0. Ground rules

- **Denylist writes are the principal's, non-delegable.** Edit the denylist source (this SOP
  writes it as `confidentiality/denylist.yaml`, in a **private** repo) only in a session with **no
  client-engagement material in context**.
- **Never quote a term** anywhere outside the denylist source — not in commits, PRs, comments,
  fixtures, worklogs, events, chat, or tool output. All tooling masks to first character +
  length. To check a word: `<denylist-tool> lookup <word>` (masked output).
- **Two decisions to settle before first use**, and to write down where the team reads them:
  - **Secret visibility.** The org secret carrying the hashed denylist (e.g.
    `CONFIDENTIALITY_DENYLIST`) is readable by whichever repos you scope it to. Scoping it to
    *all repositories* makes the gate work everywhere and widens who can read the payload;
    scoping to *selected repositories* is tighter and needs upkeep as repos are added. Pick one
    deliberately — the hashing posture in §2 depends on which you chose.
  - **Fork coverage.** Secrets are not exposed to fork PRs, so the CI gate runs **shape-pattern
    tiers only** there. A maintainer MUST run the local gate before merging any fork PR (§5).

---

## 1. Engagement-open ritual (do this the SAME DAY an engagement opens)

Classes 1–4 (client name, engagement phrase, client+platform pairing, acronym) have **no
deterministic coverage until an entry exists**. This ritual is the process control that converts
them from model-judgement-only to deterministic. It is a hard checklist gate, not a nicety.

1. In a session with no engagement material in context, add one entry per term family to the
   denylist source:
   ```yaml
   - term: "<the term>"
     class: client-name        # or engagement-phrase | platform-pairing | acronym
     action: block             # block for names and pairings; warn for softer phrases
     public_hash: true         # false ONLY for a short, brute-forceable acronym
     added: "YYYY-MM-DD"
     note: "why — never quote the term here"
   ```
2. Validate: `<denylist-tool> validate`
3. Push the hashed form to CI: `<denylist-tool> sync --apply`
4. Refresh the installed copy on **every machine that runs the local gate** — a cheap pull of the
   installed governance package, decoupled from any larger regeneration step.
5. Round-trip check: add the entry ⇒ sync ⇒ a sandbox PR containing the term BLOCKs.

> `sync` should **refuse** to push a placeholder-only denylist — real entries must exist first.

---

## 2. Denylist stewardship

- **Single writer, clean sessions, never quote** (see §0).
- **Recoverability and the pepper.** A single salted SHA-256 of a low-entropy name is
  offline-recoverable by anyone who can read the secret — the salt ships inside it — and that
  includes **client names, not just short acronyms**. Configure a **separate** pepper secret
  (e.g. `CONF_DENYLIST_PEPPER`), never carried in the payload, before syncing real
  `client-name` / `engagement-phrase` / `platform-pairing` entries. `sync` should refuse them
  otherwise, with an explicit opt-out flag for a principal who accepts the exposure knowingly.
  The gate engine reads the same pepper from its own secret.
- **`public_hash` opt-out:** set `false` to enforce a term via the plaintext local-gate path only
  (short acronyms, or any term you will not accept as brute-forceable from the published hash).
- **Salt rotation:** changing the salt re-hashes the whole set; follow with `sync --apply` and a
  refresh of every installed copy. A `version` stamp inside the secret lets the verifier detect
  secret-vs-source skew.
- **Never commit the hashed output.** `sync` pushes straight to the secret. A local
  `--emit-hashed <path>` option, if your tool has one, is for debugging only — that file is
  git-ignored territory.

---

## 3. Gate rollout: burn-in → enforce

1. **Wire the callers** (dry-run first): generate the rollout plan, review it, then apply it
   pinned to a specific gate commit — a caller MUST be **SHA-pinned**, never floating on a tag or
   branch.
2. **Burn in warn-only** on one active repo for **3–5 days**. Target: **fewer than one false
   BLOCK per week** before enforcing. WARN findings land on a sticky PR comment (entry ids only,
   never terms) so the dev loop sees them — see [`autonomous-work.md`](./autonomous-work.md).
3. **Enforce:** add the observed check context to the branch protection rules for
   `{{config:org.default_branch}}` (dry-run, then apply). Read the **actual** check-run context
   name from the API rather than guessing the string — a renamed job blocks every merge
   fail-closed and trains the team into admin-override habits, which is the exact culture this
   gate exists to prevent.

---

## 4. False-positive handling (allowlist discipline)

### 4a. Per-line justified exemption (`gate:allow`)

Some findings are unavoidable rather than false: a chat channel topic that must carry a literal
account-id mention cannot resolve without the real id, and an integration's account id is public
by design and inert without its token. An integration account id and a personal user id are the
**same numeric shape**, so "allow integration ids" cannot be expressed as a pattern. The escape is
therefore explicit, local, and justified — never a blanket skip and never `--no-verify`:

```yaml
topic: "… <mention:000000000000000000> …"  # gate:allow platform-id — public integration account id; the mention must resolve
```

Rules, all enforced by the scanner:

- **One line only.** The annotation suppresses findings on the line it sits on. There is no
  file-level or block-level form.
- **A reason is mandatory.** A bare `# gate:allow platform-id` suppresses nothing — the finding
  still blocks and a `gate-allow-unjustified` WARN says why. Punctuation-only reasons don't count.
- **Shape-pattern classes only.** Denylist, internal-email, and compliance-code findings are
  **NOT exemptable at any severity**; naming one emits a `gate-allow-unsupported` WARN and
  suppresses nothing. This carve-out is not waivable — not by a reviewer, not by the principal,
  not "just this once". A term that must appear in a public repo is a denylist decision made in
  the private source, not an inline annotation.
- **Any comment syntax.** `#`, `//`, and `<!-- -->` all work; the marker is matched anywhere on
  the line.
- **Visible, never silent.** Every honoured exemption prints as `[EXEMPT] <rule> line N: <reason>`
  and is counted in the `N exemption(s) honoured` summary. Reasons are scrubbed of ids, emails,
  and codes before display, so an exemption can never become a disclosure channel.

An exemption is a diff a reviewer reads. Adding one is a claim that the id is public and inert —
if that is not true of the id in front of you, fix the fixture instead.

### 4b. Everything else

- **Shape-pattern false positives** (email, code, identifier) resolve via the repo's
  `.confidentiality-allow.yaml`, loaded from the **base commit** (never the PR head) and owned via
  CODEOWNERS — **no allowlist addition in the same PR as the violation**. Justifications must be
  engagement-neutral, because the file is public.
- **Denylist false positives are NOT allowlistable in a public repo**, and the response must never
  echo the term or a paste-ready allowlist line. They resolve only via a carve-out in the private
  denylist source.
- Every false positive that survives a week **feeds back**: patch the pattern or this SOP in the
  session where it was found. A gate nobody maintains becomes the bypass culture the gate exists
  to prevent.

---

## 5. Fork-PR procedure

A fork PR runs the shape-pattern tiers only (no denylist secret) and should emit a degraded
notice. Before merging:

```bash
gh pr checkout <N>            # fork PR checkout
<local-gate> .                # full plaintext denylist + shape patterns, masked output
```

Exit 1 (any BLOCK) ⇒ do not merge; investigate with the masked output. Exit 0 ⇒ clear on the
confidentiality axis. This step is SOP-mandatory — the degraded CI run does not cover the
denylist. See [`pr-review.md`](./pr-review.md) for the rest of the fork-PR review path.

---

## 6. Periodic baseline verify (drift and visibility-flip watch)

Run the baseline verifier on a fixed cadence — monthly is a reasonable default:

```bash
<baseline-verifier> verify
```

Read-only. It reports, per public repo: secret scanning and push protection status, ruleset
presence, whether the confidentiality gate is a required check, and **unregistered public repos**.
A newly-public repo is a mass-leak vector — register it in your repo inventory and run a
**full-history** scan before anything else. Exit 1 on drift; drive each finding to zero. Enabling
features and creating rulesets are mutating operations owned by a separate, reviewed change — not
by this read-only check.

---

## Ownership

**Stays with the principal:** denylist writes, org-admin operations (the secret, code-security
configuration, ruleset bypass), and any break-glass use.
**The maintainer can own:** engine and pattern maintenance plus the false-positive budget, the
periodic `verify` and coverage triage, the caller and ruleset rollout, and the burn-in data.

---

*This SOP applies to any project that adopts compass-core. The tool names, the secret names, and
the class list are project choices; the never-quote rule in §0, the engagement-open ritual in §1,
and the non-exemptable classes in §4a are not.*
