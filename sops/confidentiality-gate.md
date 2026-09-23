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
  - **Fork coverage.** This depends on how the gate is triggered. A gate on plain `pull_request`
    never sees secrets on a fork PR, so it runs **shape-pattern tiers only** there, and a
    maintainer MUST run the local gate before merging any fork PR (§5). compass-governance.yml
    (compass-core#41) runs on `pull_request_target` instead specifically so the workflow and its
    pin cannot be chosen by the PR that's gated by it — and that event hands EVERY PR the same
    secrets and token, fork or not, so a repo on that workflow gets the denylist tier on fork PRs
    too. §5's local-gate step is still worth running there as belt-and-suspenders, but it is no
    longer the only thing standing between a fork PR and a degraded scan. A repo still gated by
    plain `pull_request` keeps the original fork-coverage gap described above.

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

### 4c. Private-corpus overlap check (`corpus-overlap.ts`)

Before a PR leaves a shared repo, check its added lines for overlap with a private corpus you
hold separately (for example an engagement's private jobs overlay). This is **the** method for
that check (#32) — before it, builders hand-rolled it themselves, differently each time, with
`git grep -F -f` in their own working notes (see factory PR #265); this SOP carried no shingle,
corpus, or `git grep` instructions to replace.

```bash
bun engine/validators/corpus-overlap.ts \
  --corpus /path/to/private-corpus-checkout \
  --base <merge-base-sha> --head <PR-head-sha>
```

It breaks the diff's added lines into *n*-word shingles (`--n`, default 6) and checks the set
against a shingle set built once from the corpus's read (`git -C <corpus> for-each-ref` +
`ls-tree` + `cat-file --batch`, read-only — it never writes to the corpus, never reads its working
tree or index, and never touches the filesystem directly). Output is the shingle count, the match
count, and each unreviewed match's shingle **text** — **never a corpus path, filename, ref name,
or line**: the corpus is private, and this is the same withholding discipline as leak-check's
NEVER-ECHO rule (§0).

**Scope — searched every run, printed every run (`--refs HEAD|all`, default `all`):** by default
the tool searches every blob in the **tip tree** of every local branch, remote-tracking branch,
and tag — not HEAD alone, and not "every reachable blob" in git's own sense of reachable, which
includes history this tool does not walk (see below). `--refs HEAD` narrows it to HEAD's tip tree
only, which is faster but searches less; the first line of every run states which was used, plus
refs searched, paths reachable, blobs fetched, and total bytes fetched (searched and not — see the
binary paragraph below), so the scope is never a guess. Three things are **never folded silently
into a clean result**, and are always counted (never just "0 matches"):
  - **gitlinks/submodules** — `ls-tree` entries of type `commit` point at a separate repository
    this tool does not follow. Counted as not searched.
  - **binary corpus blobs** — content with a NUL in its first 8KB (the same heuristic
    `leak-check.ts` uses) is counted as not searched, never shingled. This heuristic applies to the
    corpus side only — the diff side deliberately has no NUL-based check at all; see the
    binary-files-in-the-diff paragraph below.
  - **UTF-16 corpus blobs** (BOM-detected, LE or BE) ARE decoded and searched, and counted
    separately in the "blobs read" line — a UTF-16 file with no BOM, or any other multi-byte
    encoding, is indistinguishable from binary to the NUL heuristic and is counted as binary.
  Four things are **out of scope entirely**, invisible to any of the counts above because this
  tool has no way to see them:
  - content only in the corpus checkout's **uncommitted working tree or index** (only committed,
    tip-tree content is ever read);
  - **history** — text that exists only in an older commit, not at any current ref's tip, is not
    searched, by the tip-tree-only design above;
  - **`refs/stash`** — the ref search asks for `refs/heads`, `refs/remotes`, and `refs/tags`
    explicitly; a stash is none of those;
  - the real content behind a **Git LFS pointer file** (the pointer text is searched like any
    blob; the object it points to is never fetched).

**Any git failure, anywhere in the read, is INERT — never treated as "no match."** The corpus read
(refs, tree listings, the batched object read, and their own internal consistency — an object
count or a byte count that doesn't add up) and the diff read (cross-checked against a second,
independent `git diff --numstat` run) are both verified this way. Before trusting a clean result,
the tool draws a raw, pre-normalisation fragment from the corpus and injects it as one more element
of the SAME array the real diff's added lines come from, before the one shared call that turns
that array into shingles and the one shared function (`findMatches`) that both the control and the
real search use to look them up — not a parallel computation of its own, and not a check that the
corpus's own shingle set is merely non-empty, which can never fail once the corpus has been read at
all and proves nothing about whether the diff side would actually find something real. If the
control's own shingle produces no match, the run is INERT: the observable symptom of a broken
lookup, a normalisation step that silently stopped running, or the corpus and diff sides drifting
out of sync — not "the corpus is empty," which is a narrower and weaker claim.

Sharing that array closes a mutation that disables `findMatches`'s own lookup loop, or that breaks
either shared function — but NOT, on its own, a mutation that narrows or replaces the array itself
(a review found two: the spread narrowed from `[...addedRuns, controlRun]` to `[controlRun]`, and
`addedRuns` reassigned to `[]` right after extraction). Either way the control's own shingle is
still present — it's appended after whatever the array already holds — so the control alone cannot
notice the real diff's contribution is gone. That gap is closed separately: `runsToShingles` itself
returns the exact word count of whatever it just processed, in the SAME call that produces the
shingle set used for matching — not a count read from a separate variable elsewhere, which a later
review found could be left correct while the *call* was pointed at a smaller array instead
(`runsToShingles([controlRun], n)`, bypassing the combined array while leaving it untouched). That
returned count is compared, immediately, against an independent expectation `extractAddedRuns`
captured before any of this ran; any shortfall is INERT.

**The match report is checked against an independent re-derivation, not against itself.** An
earlier version of this check computed two counts both derived from the same filtering predicate
over the same `matches` — they partitioned `matches` by construction, so they were equal for any
predicate, including a broken one, and the check could fire only when the `rawMatches` variable was
reassigned outright, never when the filtering *logic* was wrong (forced to reject everything, off
by one, or with the search itself narrowed to admit only shingles the control happens to share).
The fix computes the diff's own shingles alone — `runsToShingles(addedRuns, n)`, with no control run
mixed in and so no provenance arithmetic needed — intersects that with `corpusHas`, and requires the
reported matches to equal that set exactly. It still shares `runsToShingles` and `corpusHas` with the
control above (already exercised there), but shares nothing with the filtering predicate itself, so
a broken predicate produces a disagreement the check can actually see. **What this does not cover:**
benign-list honouring — deciding a reported match is excused by an entry at `--base`, and moving it
from "unreviewed" to "honoured" — happens after this check runs and is not itself re-verified at
runtime. That stage is guarded only by the ordinary planted-match and benign-list tests in
`corpus-overlap.test.ts` (a benign entry that shouldn't honour a match, but does, would show up
there as a wrong exit code on an existing test — not as an INERT this tool produces on its own).

The diff read is hardened against the PR under scan controlling its own visibility: `git diff` runs
with `--no-ext-diff --no-textconv --text --no-renames`, so a `.gitattributes` `-diff` marker or a
`diff.external` config cannot make the tool see an empty diff. `--no-renames` means a move/rename
is a delete (old path) plus an add (new path), each scanned independently — an ordinary asset
reshuffle in a consuming repo must not need special handling. `--base` and `--head` are verified
with `git rev-parse --verify --end-of-options` and refused outright if either looks like a flag
(e.g. `--base=--output=<file>`) — a ref is data, never an option to the git commands it's passed to.

**The patch is parsed structurally, not by what a line looks like.** A round-4 version of this tool
decided "is this a file header" by checking whether a raw line started with `"+++ "`, wherever it
appeared — ambiguous, because an ADDED line whose own content is `++ <text>` renders as `+++ <text>`,
indistinguishable by text alone from a genuine header. Paired with a change that has a `--numstat`
row but no `"+++ "` line at all (an empty new file, a mode-only change), that ambiguity let a PR
plant such a line, have it misread as a phantom file boundary, and have the file-count cross-check
still balance — the content was never scanned, exit 0. The fix reads the patch's own structure
instead: a section starts at `diff --git`; `"--- "`/`"+++ "` are headers only in that section's own
header region, before its first `"@@ "` hunk line; once a hunk has started, a line beginning `+` is
unconditionally content, whatever follows it. The same structural read also fixed the reverse
problem: an empty file, a mode-only change, or a file↔symlink type change either has no `"+++ "`
line at all, or (a type change) renders as two `diff --git` sections for one `--numstat` row —
both used to desynchronise the file-count cross-check and refuse an entirely routine change, INERT.

**Binary files in the diff** (not the corpus — see Scope above for that) are handled, not treated
as a reason to refuse the whole PR, and — this is the correction to an earlier round of this
section — **not by a content-based exemption of any kind**. A file `--numstat` reports as binary is
excluded from the added-line **cross-check only**; its `+` lines are turned into runs and shingled
exactly like any other file's (`--text` already puts every added byte of every file into the patch
as `+` lines). A round-3 version of this tool additionally trusted a numstat "binary" verdict only
once the file's actual HEAD content backed it up (a NUL byte in its first 8KB), and went INERT
otherwise — but that check's converse turned out to be the bug: a single NUL byte anywhere in an
ordinary text file made numstat call it binary, the content check agreed, and the ENTIRE file
became invisible to the search, exit 0. That is exactly the "one byte past the detector" pattern
this tool exists to catch, not to have. So the exemption is removed outright, not tightened — a
`.gitattributes -diff` marker trying the same trick on a real text file now simply fails to hide
anything, because nothing about what gets scanned depends on numstat's opinion any more. Excluded
files are still named in the output (safe: the path is from the public PR, never the corpus), now
worded "excluded from the line-count cross-check" rather than "not scanned," because they are.

**The benign list** (`.corpus-overlap-benign.yaml`, in the *consuming* repo, public) follows the
same rule as §4b: each entry is `{shingle, reason, reviewed_by, date}` with a mandatory reason,
and it is loaded from the PR's **base** commit, never its head — **no benign addition in the same
PR as the match it excuses**. A malformed file at base (invalid YAML, a top-level mapping instead
of a list, or any entry missing `shingle` or a non-empty `reason`) is a hard failure (exit 2,
naming the file), never silently treated as empty. The one git-read failure in this tool that is
**deliberately not INERT**: the benign file simply not existing at base (never created, or only
added at head) — that means "nothing is honoured this run," which the file's own absence already
implies, not a broken read. The benign file is itself scanned like any other added file — only
shingles already honoured (parsed from base) are exempt, so a new entry added at head that happens
to match the corpus flags itself, by construction. An honoured entry is counted in the output; a
benign entry that no longer matches the corpus at all is reported **stale**, so the list doesn't
accumulate dead carve-outs.

**Limits, not silently absorbed:** matching is case-sensitive, and HTML entities are not decoded
(`&amp;` and a literal `&` are different words to the tokenizer). Both are tracked, not silently
tolerated — see #36.

Exit codes: `0` clean (matches honoured or none found), `1` unreviewed matches, `2` INERT (the
control fragment didn't match through the real search path, or a read failed or was inconsistent)
or a usage error.

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
