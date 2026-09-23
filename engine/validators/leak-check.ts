#!/usr/bin/env bun
/**
 * leak-check.ts — Scan content for credentials and operator-defined confidential terms.
 *
 * Usage:
 *   bun engine/validators/leak-check.ts <path...> [--patterns <file>] [--require-patterns]
 *   bun engine/validators/leak-check.ts --staged  [--patterns <file>] [--require-patterns]
 *
 *   <path...>            Files or directories to scan (directories are walked recursively).
 *   --staged             Scan the *staged blobs* of the current git repo instead of paths.
 *   --patterns <file>    Operator pattern file. Overrides CONFIDENTIALITY_DENYLIST_FILE.
 *   --require-patterns   Treat a missing/unreadable pattern file as an error instead of a warning.
 *
 * Pattern file format: one regular expression per line; `#` comments and blank
 * lines are ignored; patterns are matched case-insensitively, one line of input
 * at a time.
 *
 * Two tiers of rules:
 *   1. Built-ins — generic credential shapes that are wrong in any repo (see RULES).
 *   2. Operator patterns — loaded from the file named by `--patterns` or the
 *      `CONFIDENTIALITY_DENYLIST_FILE` env var. This is the public-hook/private-patterns
 *      split: the guard is shared, the sensitive strings never are.
 *
 * WHY THE ENV VAR ENDS IN _FILE (it was renamed, deliberately):
 * it used to be `CONFIDENTIALITY_DENYLIST`, the same name
 * sops/confidentiality-gate.md (§0, §2) gives an org CI secret carrying the
 * HASHED denylist payload consumed by a gate engine with a separate pepper
 * secret. This repo implements only the SOP's PLAINTEXT "local gate" tier, so
 * the value here is a FILE PATH, not a payload. Sharing one name across two
 * contracts was not a naming wart but a fail-open: a SOP-shaped hashed payload
 * fed to the old name produced "pattern file not found", a warning, and exit 0
 * — green on precisely the terms the operator meant to guard. The SOP keeps
 * `CONFIDENTIALITY_DENYLIST` for its payload; this scanner reads
 * `CONFIDENTIALITY_DENYLIST_FILE`, and the suffix states what the value is.
 *
 * Residual, and NOT fixed by the rename: a *readable* file whose contents are
 * hashes still loads happily — every line is a valid regex that matches
 * nothing. `--require-patterns` catches an absent or unreadable file, not a
 * well-formed file of the wrong kind. Verifying payload shape is a job for the
 * hashed tier this repo does not implement.
 *
 * NEVER-ECHO RULE (sops/confidentiality-gate.md §0): this scanner reports
 * `file:line: rule-name` and nothing else. It never prints the matched text, the
 * surrounding line, or the operator pattern that fired — an operator pattern is
 * itself confidential, so operator findings are reported by index (`denylist[3]`)
 * only. Do not add a "context" or "--verbose" mode that breaks this; the tool's
 * output goes into CI logs, PR comments, and hook output that anyone can read.
 *
 * WHAT THE WALK DOES NOT LOOK AT, and why it says so out loud:
 * a symlink met while walking a directory is NOT followed — a symlinked cycle
 * would hang the walk and a symlinked tree would report the same finding under
 * two paths. The count is printed in the summary, because an uncounted skip is
 * a hiding place. A symlink named directly on the command line IS followed and
 * scanned; only the recursive walk declines. Same for binary files (NUL in the
 * first 8 KB) and files over the size cap: skipped, counted, never silent.
 *
 * CODE EXPRESSIONS ARE NOT CREDENTIALS (issue #31, tightened after review on
 * #35): `credential-assignment` used to flag any `token:`/`secret:`/`password:`
 * followed by 8+ unquoted characters, including a code expression that merely
 * happens to be long enough — `token: ZERO_REPORTS().token` (a call), `token:
 * zeroReports.token` (a member access), `token: computeTally(x)` (a call with
 * an argument). "token" was a domain word there, not a secret, and rewording
 * the code to dodge the detector was the wrong fix (see the companion SOP
 * issue #30 and the factory PR #280 review this issue references).
 *
 * The first cut of this fix excluded any unquoted dotted/call-shaped value in
 * ANY file, which a review on #35 showed let real dotted-and-call-shaped
 * secrets straight through — a dotted password shaped like a capitalised
 * word plus a year followed by another capitalised word, a call-shaped
 * password whose argument was just a random-looking string, base64 blobs
 * with a stray dot inserted. The carve-out is now narrowed on three axes,
 * ALL of which must hold:
 *   1. File type — only `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`, or markdown
 *      where the value sits inside an inline-code span (the backtick handling
 *      below is what recognises that; a plain, un-fenced value in `.md`,
 *      `.yml`, `.env`, or `.json` is never a JS expression and is never
 *      exempt).
 *   2. Shape — a dot-separated chain of plain members and/or calls with a
 *      plausible argument list: `a`, `a.b`, `a.b()`, `a.b(x).c`. A bare word
 *      with no dot and no call is NOT exempt (see looksLikeChainExpression) —
 *      a long bare word is exactly what a real secret looks like.
 *   3. Plausibility — every identifier-looking segment (a call's name, a call's
 *      simple arguments, a member step) must read as a NAME, not a VALUE
 *      wearing a name's charset: `^[A-Za-z_$][A-Za-z0-9_$]{0,39}$`, so no
 *      segment over 40 characters (an HS256 JWT signature is 43), AND —
 *      because digits alone don't prove anything (`Item2024` is a normal
 *      identifier) — a segment that mixes letters and digits is disqualified
 *      unless it has camelCase's internal lower→upper transition or
 *      CONST_CASE/snake_case's underscore. `zeroReports`, `ZERO_REPORTS`,
 *      `computeTally`, `x` all pass. `Fake2024` does not — see
 *      isPlausibleIdentifier.
 * See looksLikeCodeExpression / looksLikeChainExpression / isPlausibleIdentifier.
 *
 * A QUOTED value (`"…"`, `'…'`, or a backtick-quoted value — see BACKTICK
 * HANDLING below) is a string literal by construction and is NEVER exempted
 * this way: `token: "ghp_…"` and a bare unquoted 40-char token both still
 * block, because quoting a real credential must never launder it past this
 * check.
 *
 * DEDICATED SHAPE RULES (review on #35, F1): the carve-out above is a
 * backstop, not the primary defence for known provider-token shapes — those
 * get their own rule so they never depend on a key name (`token:`/`secret:`)
 * being present at all, and are non-exemptable (see NON-EXEMPTABLE RULES):
 * `jwt`, `sendgrid-api-key`, `google-oauth-token`, `discord-bot-token`. A JWT
 * unquoted in YAML or `.env` — the most likely real leak this scanner will
 * ever see — no longer depends on credential-assignment's carve-out at all.
 *
 * BACKTICK HANDLING (issue #31 review on #33 found the first bug here; a
 * second review on #35 found the fix was itself unsafe — F2):
 *   - A value that STARTS with a backtick is a backtick-quoted literal (a JS
 *     template literal, or markdown code notation placed directly after the
 *     key) — a fourth quoted branch alongside `"…"`/`'…'`, never code-exempt,
 *     same as the other two: `token: \`<24 chars>\`` still blocks.
 *   - Inside the UNQUOTED branch, a backtick is consumed as an ordinary value
 *     character UNLESS it is immediately followed by whitespace, one of
 *     `"'#,;`, or end-of-line — i.e. unless it is actually closing something.
 *     A value with an INTERIOR backtick and no space after it (nothing
 *     closes there) still captures the whole thing and still blocks.
 *     `` `token: someObject.token` `` — a
 *     markdown line wrapping the WHOLE key:value phrase in inline code, where
 *     the opening backtick sits before the key, not the value — captures
 *     `someObject.token` cleanly (the closing backtick is a real boundary
 *     here: whitespace/EOL follows it) and is what the "markdown inline code"
 *     exception in axis 1 above actually recognises: the code-expression
 *     carve-out applies to a markdown value if and only if it was immediately
 *     followed by a closing backtick.
 *
 * SANCTIONED FALSE-POSITIVE ESCAPE — `leak-check:allow` (issue #31): mirrors
 * `gate:allow` in sops/confidentiality-gate.md §4a, on purpose, because it is
 * the same shape of problem (a finding that is real but acceptable, escaped
 * inline, never a blanket skip and never `--no-verify`):
 *
 *   line of code                          // leak-check:allow <rule> — <reason>
 *
 *   - One line only, same rules as §4a: the marker suppresses findings ONLY
 *     for the rule it names, ONLY on the line it sits on. A different rule's
 *     finding sharing that line is untouched — the marker cannot become a
 *     blanket skip by naming one rule and hiding another.
 *   - A reason is mandatory and must contain a letter or digit — a bare
 *     marker, one with a punctuation-only "reason" (`— ---`), or one with
 *     trailing text but no `—`/`--` separator at all, suppresses nothing; the
 *     finding still blocks and a warning explains why
 *     (`leak-check-allow-unjustified`).
 *   - The reason itself is scanned with every rule — built-in and operator —
 *     before the exemption is honoured (review on #35, F3). If the reason
 *     contains a finding, the marker is invalid: the finding still blocks,
 *     and the reason is NOT printed — only `reason withheld: contains a
 *     finding`. This is what stops a marker placed BEFORE a credential from
 *     suppressing it (the credential ends up inside the reason) and stops an
 *     honoured exemption from printing a denylisted term that happens to
 *     appear in its own reason.
 *   - An honoured reason is printed scrubbed of emails and long numeric id
 *     sequences (§4a: "Reasons are scrubbed of ids, emails, and codes before
 *     display") — see scrubReason.
 *   - Any comment syntax works (`//`, `#`, `<!-- -->`, …) — the marker is
 *     matched anywhere on the line, not tied to a language's comment grammar.
 *   - The separator is the em dash `—` (as in the SOP) or `--` as a plain-
 *     ASCII fallback, since not every keyboard types an em dash easily.
 *   - Honoured exemptions are never silent: each prints as
 *     `[EXEMPT] file:line: rule — reason` and is counted in the
 *     `N exemption(s) honoured` summary.
 *
 *   NON-EXEMPTABLE RULES (mirrors §4a's "not exemptable at any severity"
 *   carve-out for denylist/internal-email/compliance-code, widened after
 *   review on #35, F7): `private-key-header`, every operator pattern
 *   (`denylist[N]`), and every provider-token shape rule with no ambiguous,
 *   legitimately-public example (`github-token`, `anthropic-api-key`,
 *   `slack-token`, `jwt`, `sendgrid-api-key`, `google-oauth-token`,
 *   `discord-bot-token`) cannot be marked away. `aws-access-key-id` stays
 *   exemptable — AWS documents an intentionally-public example access-key id
 *   (the well-known one ending in "EXAMPLE" in their own docs) that
 *   legitimately appears in docs, and that is the one case §4a's "a reason
 *   is arguable" test can actually pass. A PEM
 *   private-key header is never a false positive — if it's present, it's a
 *   real key, and the fix is removing it, not annotating it. An operator
 *   pattern is this repo's own denylist tier; the SOP is explicit that
 *   denylist findings resolve only via a carve-out in the private source,
 *   never an inline annotation, and a local marker capable of suppressing an
 *   organisation's confidential term would be exactly the security hole that
 *   rule exists to prevent. Naming any of these still blocks the finding and
 *   prints `leak-check-allow-unsupported`.
 *
 * CREDENTIAL KEY NAMES MATCH AS THE LAST SEGMENT OF AN IDENTIFIER (issue #37):
 * the leading edge of `credential-assignment`'s key alternation used to be a
 * plain `\b`, which never fires between two word characters — and `_` IS a
 * word character to `\b`. `DISCORD_TOKEN=`, `GITLAB_TOKEN=`, `OPENAI_API_KEY=`
 * and `AWS_SECRET_ACCESS_KEY=` (the `.env` shape most likely to hold a real
 * secret) all produced zero findings as a result. The fix widens what counts
 * as a valid start for the key phrase to two shapes:
 *   1. Start of line, or preceded by anything that is not `[A-Za-z0-9]` —
 *      this already covered a plain word boundary and kebab-case
 *      (`foo-api-key`, since `-` was never a word character); it now also
 *      covers `_` (`FOO_TOKEN`, `foo_secret`), because `_` is deliberately
 *      excluded from that class.
 *   2. A genuine camelCase transition: the character immediately before the
 *      key phrase is a lowercase ASCII letter AND the key phrase's own first
 *      character is uppercase — `fooSecret`, `FooPassword`. `mytoken`
 *      (lowercase throughout, no transition) does NOT qualify and stays
 *      unflagged, same as before.
 *   3. Nothing else. A digit or an uppercase letter immediately before the
 *      key phrase is never a valid segment start.
 *
 * THE BOUNDARY RULE LIVES IN THE REGEX ITSELF, not in a post-match `accept`
 * callback (review on #42, F2 — see the git history of this file for the
 * first cut, which put it in `accept` and was wrong). `ci()` turns a
 * lowercase pattern fragment into one that matches either case letter by
 * letter, WITHOUT the `/i` flag: `CRED_KEY_ANY` is every credential keyword
 * in any case combination, used after a clean boundary; `CRED_KEY_UPPER_FIRST`
 * is the same keywords with the FIRST letter forced literally uppercase,
 * used after a lowercase letter (the camelCase-transition branch). Dropping
 * the `/i` flag is what makes this work: under `/i`, `(?<=[a-z])` and an
 * uppercase-first check both fold case and stop meaning anything, which is
 * exactly why the first cut needed a separate case-sensitive `accept`-level
 * check at all. With the boundary IN the regex, the engine simply never
 * produces a candidate match at a position like `token` inside `mytoken` —
 * there is nothing for `accept` to reject there, and nothing for a rejected
 * match's greedy value capture to swallow. See F2 below for why that matters
 * far more than tidiness.
 *
 * The TRAILING side is unchanged and untouched by this issue: the key phrase
 * must still be immediately (modulo whitespace) followed by `:`/`=` for the
 * whole rule to match at all — `(?![A-Za-z0-9_])` in place of the old
 * trailing `\b` (equivalent for this purpose: a hyphen still ends the key
 * phrase, since it was never a word character either). That is what already
 * excludes `tokenizer = x`, `secretaryName = x` (the key phrase is a PREFIX
 * of a longer identifier, followed by more identifier characters before any
 * operator — the regex itself finds no match anywhere on the line) and a
 * TYPE ANNOTATION such as `passwordField: string` (same reason: "password"
 * is a prefix of "passwordField", not its last segment, so the whole
 * pattern never matches at all — there is no separate "is this a type
 * annotation" case to decide, because the identifier shape alone already
 * disqualifies it). DECISION: a key name is recognised only when it is the
 * LAST segment of the identifier immediately left of the operator; a type
 * annotation's declared name never qualifies unless the credential word IS
 * that whole trailing segment ("secretKey: string" — "secret" is not
 * "secretKey"'s last segment either, still unmatched). When the credential
 * word IS the whole key, a type annotation gets no special exemption: a
 * credential key followed immediately by a bare, unquoted, non-code-shaped
 * type name still matches, the same as any other `key: value` shape, and
 * that is correct — a genuinely code-shaped type reference is still covered
 * by the existing code-expression carve-out for `.ts`/`.tsx`/etc., not by
 * anything new here. (This file's own source carries no credential-shaped
 * literal for that example, including in this comment — see #35's second
 * review and #42's F3: examples are described, not quoted, and a
 * `leak-check:allow` marker is not used to launder one back in.)
 *
 * `isValidCredentialKeyBoundary` still exists and is still called first in
 * `accept`, as a backstop — belt-and-braces against a future regex edit that
 * reopens the boundary — but with the rule now in the regex, it should never
 * actually have anything to reject; it is not what makes any test in this
 * file pass.
 *
 * FIRSTACCEPTEDMATCH, AND WHY A NAIVE RETRY IS A DENIAL OF SERVICE (#42, F2):
 * `credential-assignment` is still the one rule with an `accept` callback
 * (the code-expression carve-out can still reject a regex-level match), and
 * a single non-retrying `exec` only ever reports the FIRST position where
 * the whole pattern matches — if THAT position is rejected, a real finding
 * later on the same line could go unseen. `firstAcceptedMatch` retries via a
 * cloned global regex, resuming each attempt at the END of the previous
 * (rejected) match. Before the boundary rule moved into the regex, THAT
 * specific resume point was the bug: the old `accept`-level boundary check
 * could reject a candidate the regex should never have produced (`token`
 * inside `mytoken`, under the old `/i`-folded lookbehind), and that
 * candidate's own greedy unquoted-value capture ran to the next whitespace —
 * swallowing a REAL key that followed it with no space in between
 * (`?mytoken=abc&auth_token=<real secret>`), because the resume point sat
 * past it. Resuming at `m.index + 1` instead of end-of-match would dodge the
 * swallowing, but is quadratic: a rejected candidate's value capture is
 * O(remaining line length), and re-attempting the match one character later
 * repeats that scan, so a single long line of near-duplicate rejected
 * candidates is O(n²) — measured at over 120s for a 140 KB line during
 * review. The actual fix is the one above: put the boundary rule in the
 * regex so the engine never generates that candidate in the first place.
 * `firstAcceptedMatch`'s resume-at-end-of-match loop then stays linear,
 * because the only remaining source of rejection (a real code-expression
 * carve-out) doesn't have unbounded, whitespace-free values to swallow.
 *
 * ZERO-WIDTH AND OTHER INVISIBLE CHARACTERS ARE STRIPPED BEFORE ANY RULE OR
 * THE DENYLIST SEES CONTENT (issue #37, widened on #42 review): U+200B (ZERO
 * WIDTH SPACE), U+200C (ZERO WIDTH NON-JOINER), U+200D (ZERO WIDTH JOINER),
 * U+FEFF (ZERO WIDTH NO-BREAK SPACE / BOM), U+2060 (WORD JOINER) and U+00AD
 * (SOFT HYPHEN) are invisible in a rendered diff or PR comment but split a
 * literal substring match apart — a denylisted term (or a credential shape)
 * with one spliced into the middle of it passed every rule and the denylist
 * on main. `stripZeroWidth` runs once per scanned line (and once on a
 * `leak-check:allow` reason before it is checked for a finding) before
 * anything else touches that text — see the call sites in the main scan
 * loop and in `reasonContainsFinding`.
 *
 * QUOTED KEYS (issue #46): `credential-assignment`'s key alternation used to
 * require the key word to sit directly (mod whitespace) before `:`/`=`. A
 * quoted key — `"token": "…"`, the shape of every JSON file, cloud
 * service-account file, `package.json`-style config, and JS/TS object with
 * quoted keys — has a closing quote in between, so the rule never fired
 * there at all; this was probably the biggest miss of anything #37/#42
 * fixed. Fixed with a new leading alternative, CRED_KEY_QUOTED, matching a
 * whole quoted key — `"KEY"`/`'KEY'`, or the key word preceded, inside the
 * quotes, by ANY non-alphanumeric character or by a lowercase-to-uppercase
 * step (`"refresh_token"`, `"spring.datasource.password"`, `"aws:secret"`,
 * `"OPENAI_API_KEY"`, `"refreshToken"` all match; `"pretoken"`/`"tokenizer"`
 * still don't — reviews on #46, B1 and B2; see CRED_KEY_QUOTED's own comment
 * for the two boundary constructions, why they're quantifier-based rather
 * than lookaround, and why that set of accepted preceding characters is
 * exactly the unquoted boundary's set, not merely similar to it). No other
 * rule needed a quoted-key path: the dedicated shape rules (`jwt`,
 * `sendgrid-api-key`, etc.) never depended on a key name in the first
 * place, and the denylist is a plain substring match regardless of
 * surrounding syntax.
 *
 * JSON VALUES NEVER GET THE CODE-EXPRESSION CARVE-OUT, AND THAT IS CORRECT,
 * NOT AN OVERSIGHT (issue #46's last box): the code-expression exemption in
 * `accept` (see CODE EXPRESSIONS ARE NOT CREDENTIALS above) only applies
 * when `isCodeFile` or `isMarkdown && closesInlineCode` is true, and
 * `isCodeFile`'s extension list (`.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`)
 * has never included `.json` — an unquoted, member-expression-shaped value
 * in a `.json` file already fell through to `return true` (flagged)
 * unconditionally, before and after this issue's fix. That is the right
 * behaviour, not an accident worth widening: valid JSON has exactly six
 * value kinds — string, number, boolean, null, object, array — and NONE of
 * them is a code expression. `token: zeroReports.token` reads as a call/
 * member-access chain only because JS/TS syntax makes an unquoted bareword
 * a variable reference; the identical bytes in a `.json` file are either a
 * syntax error (if genuinely unquoted) or, quoted, an ordinary string whose
 * content happens to contain dots — never evaluated, never a reference to
 * anything. A "JS/TS code expression exemption for JSON" would just be a
 * new way to launder a real secret past the scanner by wrapping the file in
 * `.json`, for a carve-out whose entire justification (the domain-word
 * false positive from issue #31 — `token: zeroReports.token` meaning "the
 * `.token` property of `zeroReports`") cannot occur in JSON at all.
 *
 * Exit codes: 0 = clean, 1 = findings, 2 = usage/configuration error.
 */

import { parseArgs } from "node:util";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const EXIT_CLEAN = 0;
const EXIT_FINDINGS = 1;
const EXIT_USAGE = 2;

const USAGE =
  "Usage: bun engine/validators/leak-check.ts <path...> | --staged [--patterns <file>] [--require-patterns]";

/** Directories never worth scanning — noise, and huge. */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "vendor", "coverage"]);

/** Files above this size are skipped with a visible notice (never silently). */
const MAX_BYTES = 5 * 1024 * 1024;

/** What an `accept` callback needs beyond the regex match itself. */
interface AcceptContext {
  /** The full line the match came from — needed to look at what follows the match (backtick handling). */
  line: string;
  /** The scanned file's display path, or a synthetic non-file name when checking a `leak-check:allow` reason. */
  display: string;
}

interface Rule {
  name: string;
  re: RegExp;
  /** Optional second-stage check; receives the match and its context. Return false to drop it. */
  accept?: (m: RegExpExecArray, ctx: AcceptContext) => boolean;
  /**
   * Defaults to true. false means `leak-check:allow <rule> — <reason>` can
   * never suppress a finding for this rule — see the NON-EXEMPTABLE RULES
   * note in the file header.
   */
  exemptable?: boolean;
}

/**
 * A backtick is an ordinary value character UNLESS it's immediately followed
 * by whitespace, a stop character, or end-of-line — i.e. unless it's actually
 * closing something. See BACKTICK HANDLING in the file header.
 */
const UNQUOTED_CHAR = '(?:[^\\s"\'#,;`]|`(?=[^\\s"\'#,;]))';

/**
 * `credential-assignment`'s key alternation, matched WITHOUT the `/i` flag —
 * see CREDENTIAL KEY NAMES MATCH AS THE LAST SEGMENT OF AN IDENTIFIER in the
 * file header (issue #37 / #42's F2). `ci(w)` turns each lowercase letter of
 * a pattern fragment into a `[xX]`-style either-case class, so the keyword
 * matches any casing letter by letter, without folding the rest of the
 * pattern (the lookbehinds in particular) the way the `/i` flag would.
 * `CRED_KEY_ANY` is used after a clean (non-alnum) boundary; `CRED_KEY_UPPER_FIRST`
 * — the same keywords with the FIRST letter forced literally uppercase — is
 * used only after a genuine lowercase-letter precede (the camelCase
 * transition), so `mytoken` never matches (lowercase "token" doesn't satisfy
 * the upper-first form) while `fooSecret`/`FooPassword` do.
 */
const ci = (w: string) => w.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
const CRED_KEYS = [
  "pass(?:word|wd)",
  "secret",
  "token",
  "api[_-]?key",
  "access[_-]?key",
  "client[_-]?secret",
  "auth[_-]?token",
];
const CRED_KEY_ANY = `(?:${CRED_KEYS.map(ci).join("|")})`;
const CRED_KEY_UPPER_FIRST = `(?:${CRED_KEYS.map((k) => k[0]!.toUpperCase() + ci(k.slice(1))).join("|")})`;

/**
 * A QUOTED key — issue #46: `credential-assignment`'s key alternation above
 * requires the key word to be followed directly (mod whitespace) by `:`/`=`,
 * which is exactly what a JSON file, a cloud service-account file, a
 * `package.json`-style config, or a JS/TS object with quoted keys never
 * gives it — a closing quote sits between the key and the separator
 * (`"token": "…"`), so the rule never produced a candidate match there at
 * all. `{"token": "<secret>"}` gave zero findings on main.
 *
 * First cut (review on #46, B1) required the WHOLE quoted content to equal a
 * bare `CRED_KEYS` word, so it was narrower than the unquoted branches — it
 * missed `"refresh_token"`, `"access_token"`, `"OPENAI_API_KEY"`,
 * `"GITHUB_TOKEN"` (snake_case / CONST_CASE prefix) and `"refreshToken"` /
 * `"botToken"` (camelCase prefix). B1's fix only widened the prefix class to
 * `[A-Za-z0-9_-]` with the boundary character restricted to `_`/`-`, which a
 * second review (B2) found was STILL narrower than the unquoted boundary:
 * the unquoted `(?<![A-Za-z0-9])` lookbehind accepts ANY non-alphanumeric
 * character before the key (`.`, `:`, `/`, a space — not just `_`/`-`), so a
 * dotted key like `"spring.datasource.password"` (Spring Boot / VS Code
 * `settings.json`-style: `"<ext>.apiKey"`) or a colon-separated
 * `"aws:secret"` was still missed quoted while caught unquoted.
 *
 * Fixed (B2) by making the prefix's terminal character ANY non-alphanumeric
 * character, not a fixed `[_-]` class, and bounding the arbitrary run by the
 * quote the branch itself uses (so a double-quote branch's prefix can never
 * run past the next `"` on the line, keeping backtracking bounded):
 *   1. `"(?:[^"\n]*[^A-Za-z0-9"\n])?${CRED_KEY_ANY}"` — an optional prefix of
 *      any characters except the closing quote or a newline, but ONLY when
 *      the character immediately before the keyword is neither alphanumeric
 *      nor the quote nor a newline. With no prefix at all, this reduces to
 *      the original bare `"KEY"` case.
 *   2. `"[^"\n]*[a-z]${CRED_KEY_UPPER_FIRST}"` — the same unbounded prefix,
 *      but required to end in a lowercase ASCII letter immediately before
 *      `CRED_KEY_UPPER_FIRST` (which forces the keyword's own first letter
 *      literally uppercase), so `"refreshToken"` and `"botToken"` match via
 *      the camelCase transition, same as their unquoted forms — a run of
 *      uppercase letters with no such transition (`"MYTOKEN"`) still doesn't
 *      match, because there is no lowercase letter anywhere for `[a-z]` to
 *      land on.
 * The single-quote branch is the same shape with `'` in place of `"`
 * throughout (`[^'\n]`, terminated by `'`).
 *
 * This is now the SAME RULE as the unquoted boundary — "any non-alphanumeric
 * character, or a lowercase-to-uppercase step, immediately before the key
 * word" — expressed with quantifiers instead of lookaround, because a
 * variable-length prefix can't sit inside a fixed-width lookbehind. It is
 * not merely similar to the unquoted rule; it accepts exactly the same set
 * of preceding characters.
 *
 * The keyword must still be the LAST segment before the closing quote —
 * nothing follows it but the literal quote character — so `"tokenizer"` and
 * `"pretoken"` (no non-alnum/camelCase boundary immediately before "token")
 * still don't match: an arbitrary letter-run prefix with no boundary is
 * exactly what this is designed to reject. See the quoted-key tests in
 * `__tests__/leak-check.test.ts` for both directions.
 *
 * Neither alternative adds a capturing group (`(?:…)` throughout), so the
 * value alternation's existing `m[1]`..`m[4]` indices (read throughout
 * `accept`) stay unshifted.
 */
const CRED_KEY_QUOTED_DQ =
  `(?:"(?:[^"\\n]*[^A-Za-z0-9"\\n])?${CRED_KEY_ANY}"` + `|"[^"\\n]*[a-z]${CRED_KEY_UPPER_FIRST}")`;
const CRED_KEY_QUOTED_SQ =
  `(?:'(?:[^'\\n]*[^A-Za-z0-9'\\n])?${CRED_KEY_ANY}'` + `|'[^'\\n]*[a-z]${CRED_KEY_UPPER_FIRST}')`;
const CRED_KEY_QUOTED = `(?:${CRED_KEY_QUOTED_DQ}|${CRED_KEY_QUOTED_SQ})`;

/**
 * Built-in ruleset — deliberately small and shape-based. These are the leaks that
 * are wrong in *any* repository; anything organisation-specific belongs in the
 * operator pattern file, never here (this file is public).
 */
const RULES: Rule[] = [
  {
    name: "private-key-header",
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/,
    // Never a false positive — see the NON-EXEMPTABLE RULES note above.
    exemptable: false,
  },
  {
    name: "anthropic-api-key",
    re: /sk-ant-[A-Za-z0-9_-]{16,}/,
    exemptable: false,
  },
  {
    name: "github-token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{28,}|github_pat_[A-Za-z0-9_]{20,})\b/,
    exemptable: false,
  },
  {
    name: "aws-access-key-id",
    re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/,
    // Stays exemptable — see the NON-EXEMPTABLE RULES note above (the AWS
    // documented example key is the one legitimately-public case).
  },
  {
    name: "slack-token",
    re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
    exemptable: false,
  },
  {
    name: "jwt",
    // Header and payload are both base64url-encoded JSON objects, which is
    // why a real JWT (almost) always has both start `eyJ` (base64url of
    // `{"`). Fires regardless of key name — a JWT never depends on
    // credential-assignment's carve-out (review on #35, F1).
    re: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}\b/,
    exemptable: false,
  },
  {
    name: "sendgrid-api-key",
    re: /\bSG\.[A-Za-z0-9_-]{20,24}\.[A-Za-z0-9_-]{38,48}\b/,
    exemptable: false,
  },
  {
    name: "google-oauth-token",
    re: /\bya29\.[A-Za-z0-9_-]{20,}\b/,
    exemptable: false,
  },
  {
    name: "discord-bot-token",
    re: /\b[A-Za-z0-9_-]{23,26}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}\b/,
    exemptable: false,
  },
  {
    name: "credential-assignment",
    // key = value / key: value, where key names a credential and value is
    // not a placeholder, an environment/CI expression, a quoted string
    // literal (including backtick-quoted), or — narrowly, see the file
    // header — a code expression.
    // No `/i` flag — the boundary rule depends on real (not case-folded)
    // case, so case-insensitivity is baked into CRED_KEY_ANY /
    // CRED_KEY_UPPER_FIRST letter by letter instead. See CREDENTIAL KEY
    // NAMES in the file header and #42's F2. The quoted-key alternative
    // (CRED_KEY_QUOTED, issue #46) comes first — see its own comment above.
    re: new RegExp(
      `(?:${CRED_KEY_QUOTED}|(?<![A-Za-z0-9])${CRED_KEY_ANY}|(?<=[a-z])${CRED_KEY_UPPER_FIRST})(?![A-Za-z0-9_])\\s*[:=]\\s*` +
        `(?:"([^"\\n]*)"|'([^'\\n]*)'|\`([^\`\\n]*)\`|(${UNQUOTED_CHAR}+))`,
    ),
    accept: (m, ctx) => {
      // Backstop, not the enforcement mechanism — the boundary rule now
      // lives in the regex itself (see CREDENTIAL KEY NAMES in the file
      // header and #42's F2). This should never actually reject anything;
      // kept as belt-and-braces against a future regex edit that reopens
      // the boundary.
      if (!isValidCredentialKeyBoundary(ctx.line, m.index)) return false;

      // A backtick-quoted value is a literal by construction — never
      // code-exempt, same as "…"/'…'. See BACKTICK HANDLING.
      const backtickQuoted = m[3];
      if (backtickQuoted !== undefined) return !isPlaceholder(backtickQuoted);
      const quoted = m[1] ?? m[2];
      if (quoted !== undefined) return !isPlaceholder(quoted);

      const raw = m[4] ?? "";
      if (isPlaceholder(raw)) return false;

      const matchEnd = m.index + m[0].length;
      const closesInlineCode = ctx.line[matchEnd] === "`";
      const isCodeFile = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(ctx.display);
      const isMarkdown = /\.md$/i.test(ctx.display);

      // The code-expression carve-out applies in JS/TS source, and in
      // markdown ONLY when the value sits inside an inline-code span — see
      // the file header's CODE EXPRESSIONS / BACKTICK HANDLING notes.
      if (!isCodeFile && !(isMarkdown && closesInlineCode)) return true;

      return !looksLikeCodeExpression(raw);
    },
  },
];

/**
 * Values that name a credential without being one. Keeping this list tight
 * matters in both directions: too loose and a real secret slips through the
 * `credential-assignment` rule, too tight and the rule cries wolf until someone
 * deletes the hook.
 */
// Note the `[-_]` after your/my/sample/fake/example: those words only mean
// "placeholder" when they head a hyphenated stand-in (`your-api-key`,
// `my_token_here`). Without the separator the alternation is greedy enough
// to swallow real secrets — `mysecretvalue123` would suppress itself.
//
// `not`/`should`/`never` (issue #37, tightened on #42 review, F1): the
// widened last-segment key match now reaches a dotted/nested property key
// it never used to (`doc.x.api_token = "…"`, `{ cloudflare_api_token: "…"
// }`) — a shape common in test fixtures asserting that a field NAME alone is
// enough to trip a *different* check. Those fixtures' values are
// hand-written English disclaimers, not credentials — `"not-a-real-token"`,
// `"should-never-be-here"` — found by this issue's own factory-scan probe
// (metafactory-factory-website).
//
// The first cut used the SAME `[-_]` single-separator shape as
// your/my/sample/fake/example, and that was too loose specifically for
// these three words: `[-_][a-z0-9_-]*` under `/i` is (almost) the whole
// base64url alphabet, so ANY value starting `not-`/`not_`/`should-`/`never-`
// was swallowed regardless of what followed — including a real secret that
// happened to start that way, and a human-chosen password that reads as a
// sentence for exactly that reason (`not_my_password_2024`,
// `never-guess-me-99`), which main correctly still blocks. The two factory
// fixtures are hyphenated ENGLISH PHRASES, so the fix matches that shape
// instead of the single-separator one: a placeholder word followed by AT
// LEAST TWO more hyphen-separated letter-only words (no digits, no
// underscores) — `(?:-[a-z]{1,12}){2,}`. `not-a-real-token` and
// `should-never-be-here` still match (three and four more words); a real
// secret or password that merely starts with the bare word does not, since
// a base64url/digit-bearing/underscore-joined tail never satisfies "two more
// all-letter hyphen segments" by chance.
//
// PHRASE-HEAD SET WIDENED FROM `not`/`should`/`never` TO EVERY WHOLE-VALUE
// PLACEHOLDER WORD (review on #46, N4): the factory scan turned up a
// fixture whose quoted `*_token` value is a hyphenated, all-caps, five-word
// phrase that labels itself a placeholder — it contains "example", "not",
// "redacted" and "token" — but its FIRST word is "redacted", and `redacted`
// was accepted only as a whole value (`^redacted$`), not as a phrase head.
// A `leak-check:allow` marker can't fix this: it's line-scoped and needs a
// comment, and JSON has no comment syntax, so the only way to attach one
// would be editing the fixture's value or structure — a change made only to
// pass the detector, which sops/confidentiality-gate.md and this repo's own
// #30/#33 precedent refuse. The right fix is the detector: `redacted` (and
// every other single-word placeholder already recognised as a whole value —
// `placeholder`, `unset`, `dummy`, `test`, `todo`, `tbd`, `none`, `null`,
// `nil`, `true`, `false`, `undefined`, `empty`, `secret`, `password`,
// `token`, alongside the existing `not`/`should`/`never`) is now ALSO a
// valid phrase head, case-insensitively, under the same "two or more
// all-letter hyphenated words follow" shape. This passes the same test
// `not`/`should`/`never` passed on #42 review: no accidental real secret is
// a grammatical, multi-word, all-letter hyphenated English phrase that
// happens to start with one of these words — a base64url/digit-bearing/
// underscore-joined tail never satisfies "two more all-letter hyphen
// segments" by chance, exactly as already true for `not`/`should`/`never`.
// PLACEHOLDER_PHRASE_HEAD deliberately excludes the punctuation-repeat
// entries (`x+`, `*+`, `.+`, `-+`, `_+`) — not word-shaped, so "a phrase
// starting with one of these" isn't a coherent idea — and the
// `change[-_ ]?me` entry, which already has its own internal separator
// shape and isn't a plain word literal.
const PLACEHOLDER_PHRASE_HEAD =
  "(?:redacted|placeholder|unset|dummy|test|todo|tbd|none|null|nil|true|false|undefined|empty|secret|password|token|not|should|never)";
const PLACEHOLDER = new RegExp(
  "^(?:x+|\\*+|\\.+|-+|_+|change[-_ ]?me|redacted|placeholder|unset|dummy|test|todo|tbd|none|null|nil|true|false|undefined|empty|secret|password|token|" +
    "(?:your|my|sample|fake|example|dummy|replace)[-_][a-z0-9_-]*|" +
    `${PLACEHOLDER_PHRASE_HEAD}(?:-[a-z]{1,12}){2,})$`,
  "i",
);

/**
 * Last-segment-of-an-identifier check for `credential-assignment`'s key
 * phrase — see CREDENTIAL KEY NAMES MATCH AS THE LAST SEGMENT OF AN
 * IDENTIFIER in the file header (issue #37). `line` and `keyStart` are the
 * RAW, case-preserved scanned text and the index the key phrase starts at —
 * never derived from anything the pattern's `i` flag has case-folded.
 */
function isValidCredentialKeyBoundary(line: string, keyStart: number): boolean {
  if (keyStart <= 0) return true; // start of line — always a valid segment start
  const prev = line[keyStart - 1]!;
  if (!/[A-Za-z0-9]/.test(prev)) return true; // `_`, `-`, whitespace, quote, punctuation…
  if (!/[a-z]/.test(prev)) return false; // an uppercase letter or a digit — never a segment start
  const first = line[keyStart]!;
  return /[A-Z]/.test(first); // only a genuine camelCase transition qualifies
}

/**
 * Zero-width and other invisible characters an attacker (or an accident) can
 * splice into a denylisted term or a credential shape to break a literal
 * regex match while leaving the text visually unchanged — see ZERO-WIDTH AND
 * OTHER INVISIBLE CHARACTERS ARE STRIPPED in the file header (issue #37,
 * widened on #42 review). U+200B–U+200D and U+FEFF from #37; U+2060 (WORD
 * JOINER) and U+00AD (SOFT HYPHEN) added on #42 review — same splitting
 * trick, different invisible character. Stripped once per scanned line,
 * before any rule or the denylist runs — see the main scan loop and
 * `reasonContainsFinding`.
 */
const ZERO_WIDTH_RE = /[​-‍﻿⁠­]/g;
function stripZeroWidth(s: string): string {
  return s.replace(ZERO_WIDTH_RE, "");
}

/**
 * Finds the first match of `rule` in `text` that `rule.accept` (if any)
 * actually accepts, trying successive candidate positions rather than
 * giving up after the first rejected one — see the file header's note on
 * why a single non-retrying `exec` can miss a real finding later on the
 * same line once `accept` can reject a match (issue #37). A rule with no
 * `accept` callback never rejects, so this is a plain `exec` for it.
 */
function firstAcceptedMatch(rule: Rule, text: string, ctx: AcceptContext): RegExpExecArray | null {
  if (!rule.accept) return rule.re.exec(text);
  const flags = rule.re.flags.includes("g") ? rule.re.flags : `${rule.re.flags}g`;
  const re = new RegExp(rule.re.source, flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (rule.accept(m, ctx)) return m;
    if (re.lastIndex === m.index) re.lastIndex++; // never loop forever on a zero-length match
  }
  return null;
}

function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (v.length < 8) return true; // too short to be a credential worth blocking
  // Environment / CI / template indirection: `$VAR`, `${VAR}`, `${{ secrets.X }}`,
  // `<your-key>`, `{{ config }}`, `process.env.X`, `os.environ[...]`.
  if (/^[$<{[]/.test(v)) return true;
  if (/\$\{|\{\{|process\.env|os\.environ|secrets\./i.test(v)) return true;
  if (PLACEHOLDER.test(v)) return true;
  return false;
}

/** Longest a single identifier-looking segment may be — see isPlausibleIdentifier. */
const MAX_IDENT_LEN = 40;
const IDENT_RE = new RegExp(`^[A-Za-z_$][A-Za-z0-9_$]{0,${MAX_IDENT_LEN - 1}}$`);

/**
 * A segment that reads as a NAME, not a VALUE wearing a name's charset — see
 * the file header's "Plausibility" axis. Two independent tests:
 *   1. Charset + length: `^[A-Za-z_$][A-Za-z0-9_$]{0,39}$` — an HS256 JWT
 *      signature (43 chars) already fails this alone.
 *   2. Case/underscore structure: a segment that MIXES letters and digits is
 *      disqualified unless it has camelCase's internal lower→upper
 *      transition (`zeroReports2`) or CONST_CASE/snake_case's underscore
 *      (`ZERO_2`, `value_1`). A capitalised-word-plus-digits value has
 *      neither and reads as a password, not a name — this is what actually
 *      closes a dotted, capitalised-word-shaped password value (review on
 *      #35, F1). Pure letters or pure digits are unaffected.
 */
function isPlausibleIdentifier(segment: string): boolean {
  if (!IDENT_RE.test(segment)) return false;
  const hasDigit = /[0-9]/.test(segment);
  const hasLetter = /[A-Za-z]/.test(segment);
  const hasUnderscore = /_/.test(segment);
  const hasCamelTransition = /[a-z][A-Z]/.test(segment);
  if (hasDigit && hasLetter && !hasUnderscore && !hasCamelTransition) return false;
  return true;
}

/** A call's argument list is plausible when every argument is a plausible identifier or a bare number. */
function isPlausibleArgList(args: string): boolean {
  const trimmed = args.trim();
  if (trimmed.length === 0) return true;
  return trimmed.split(",").every((arg) => {
    const a = arg.trim();
    if (a.length === 0) return false;
    if (/^-?\d+(?:\.\d+)?$/.test(a)) return true; // a numeric literal argument
    return isPlausibleIdentifier(a);
  });
}

/**
 * A dot-separated chain of plausible-identifier "steps", each a plain member
 * (`b`) or a call (`b(...)` with a plausible argument list) — `a.b`, `a.b()`,
 * `a.b(x).c`, or a bare call with no dot at all (`f(x)`). Requires at least
 * one dot or one call: a bare word with neither is NOT "provably code" —
 * isPlaceholder's length floor already handles short values, and a long bare
 * word is exactly what a real secret looks like (see the "trailing garbage"
 * guard test).
 */
function looksLikeChainExpression(value: string): boolean {
  const steps = value.split(".");
  let sawStructure = false;
  for (const step of steps) {
    const call = /^([A-Za-z_$][A-Za-z0-9_$]{0,39})\(([^()]*)\)$/.exec(step);
    if (call) {
      if (!isPlausibleIdentifier(call[1]!) || !isPlausibleArgList(call[2]!)) return false;
      sawStructure = true;
      continue;
    }
    if (!isPlausibleIdentifier(step)) return false;
  }
  if (steps.length > 1) sawStructure = true;
  return sawStructure;
}

/**
 * A value is "provably code, not a literal" when it has JS/TS syntax that no
 * hand-typed credential would ever have: a member-expression or call chain
 * (`a.b`, `f(x)`, `a.b.getToken().value`), an object/array literal, or a
 * spread. See the CODE EXPRESSIONS ARE NOT CREDENTIALS note in the file
 * header for the full contract (file type + shape + plausibility), and for
 * the (deliberate) limit that this applies only to UNQUOTED values —
 * `credential-assignment`'s `accept` callback is what enforces that limit,
 * not this function.
 *
 * The object/array/spread branches below are redundant with `isPlaceholder`'s
 * leading-bracket check today (both reject a value starting with `{`/`[`) —
 * kept anyway, and documented as such, so this function states the full
 * "provably code" contract on its own rather than depending on an unrelated
 * function's ordering to hold half of it.
 */
function looksLikeCodeExpression(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return false;
  if (v.startsWith("...")) return true; // spread: ...base
  if (/^\{[\s\S]*\}$/.test(v)) return true; // object literal: {a, b}
  if (/^\[[\s\S]*\]$/.test(v)) return true; // array literal: [a, b]
  return looksLikeChainExpression(v);
}

/**
 * Per-line sanctioned false-positive marker — mirrors `gate:allow`
 * (sops/confidentiality-gate.md §4a). See the SANCTIONED FALSE-POSITIVE
 * ESCAPE note in the file header for the full contract.
 */
const ALLOW_MARKER_HEAD_RE = /leak-check:allow\s+(\S+)(.*)$/;
const ALLOW_SEPARATOR_RE = /^\s*(?:—|--)\s*([\s\S]*)$/;

/** True when a "reason" is nothing but punctuation/whitespace — §4a: "Punctuation-only reasons don't count." */
function isPunctuationOnlyReason(s: string): boolean {
  return !/[A-Za-z0-9]/.test(s);
}

interface AllowMarker {
  /** The rule name as written on the line — compared case-insensitively. */
  rule: string;
  /** null when absent or punctuation-only: a bare marker suppresses nothing. */
  reason: string | null;
  /** true when there's trailing text after the rule name but no `—`/`--` separator was found. */
  malformed: boolean;
}

function parseAllowMarker(line: string): AllowMarker | null {
  const head = ALLOW_MARKER_HEAD_RE.exec(line);
  if (!head) return null;
  const rule = head[1]!;
  const rest = (head[2] ?? "").trim();
  if (rest.length === 0) return { rule, reason: null, malformed: false };

  const sep = ALLOW_SEPARATOR_RE.exec(rest);
  if (!sep) return { rule, reason: null, malformed: true };

  const rawReason = sep[1]!.trim();
  const reason = rawReason.length > 0 && !isPunctuationOnlyReason(rawReason) ? rawReason : null;
  return { rule, reason, malformed: false };
}

/**
 * §4a: "Reasons are scrubbed of ids, emails, and codes before display, so an
 * exemption can never become a disclosure channel." Applied to an HONOURED
 * reason right before it's printed. A reason found to contain a finding
 * (see reasonContainsFinding) is handled separately and never printed at all.
 */
function scrubReason(reason: string): string {
  return reason
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b\d{6,}\b/g, "[id]");
}

/**
 * A neutral display name for scanning a `leak-check:allow` REASON, not a
 * file — no recognised extension, so the reason can never borrow the
 * code-expression carve-out to hide a credential inside itself.
 */
const REASON_SCAN_DISPLAY = "leak-check-allow-reason";

/**
 * §4a / review on #35 (F3): a reason is scanned with every rule — built-in
 * and operator — before it can be honoured. If it contains a finding, the
 * marker is invalid: most concretely, this is what happens when the marker
 * is placed BEFORE the credential it's meant to excuse — the credential ends
 * up inside the "explanation", not beside it.
 */
function reasonContainsFinding(reason: string, allRules: Rule[]): boolean {
  const cleaned = stripZeroWidth(reason);
  const ctx: AcceptContext = { line: cleaned, display: REASON_SCAN_DISPLAY };
  for (const rule of allRules) {
    if (firstAcceptedMatch(rule, cleaned, ctx)) return true;
  }
  return false;
}

interface Finding {
  display: string;
  line: number;
  rule: string;
}

interface Exemption {
  display: string;
  line: number;
  rule: string;
  /** Already scrubbed — see scrubReason. Never the raw marker text. */
  reason: string;
}

/**
 * Files the scanner declined to read (binary, or over the size cap). Counted and
 * surfaced in the summary — a silently skipped file is a hiding place, and a
 * reader deserves to know the number is not zero.
 */
let skipped = 0;

/** Symlinks declined by the recursive walk (loop safety — see the header). */
let skippedSymlinks = 0;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

let values: { staged?: boolean; patterns?: string; "require-patterns"?: boolean };
let positionals: string[];
try {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      staged: { type: "boolean" },
      patterns: { type: "string" },
      "require-patterns": { type: "boolean" },
    },
  });
  values = parsed.values;
  positionals = parsed.positionals;
} catch (err) {
  console.error(`leak-check: ${(err as Error).message}`);
  console.error(USAGE);
  process.exit(EXIT_USAGE);
}

if (!values.staged && positionals.length === 0) {
  console.error("leak-check: nothing to scan — pass one or more paths, or --staged.");
  console.error(USAGE);
  process.exit(EXIT_USAGE);
}

// ---------------------------------------------------------------------------
// Operator patterns
// ---------------------------------------------------------------------------

const envPatterns = (process.env.CONFIDENTIALITY_DENYLIST_FILE ?? "").trim();
const patternsPath = values.patterns ?? (envPatterns.length > 0 ? envPatterns : undefined);

const operatorRules: Rule[] = [];

if (patternsPath && existsSync(patternsPath) && statSync(patternsPath).isFile()) {
  const raw = readFileSync(patternsPath, "utf8").split(/\r?\n/);
  let index = 0;
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]!.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    index++;
    try {
      // Case-insensitive: a confidential term is confidential in any casing.
      // Not exemptable — see the NON-EXEMPTABLE RULES note in the file header:
      // an operator pattern IS this repo's denylist tier, and the SOP is
      // explicit that denylist findings resolve only in the private source,
      // never via an inline annotation in the (public) repo the pattern fired in.
      operatorRules.push({ name: `denylist[${index}]`, re: new RegExp(line, "i"), exemptable: false });
    } catch {
      // Fail closed, and never echo the pattern — it may itself be the secret.
      console.error(
        `leak-check: pattern file ${patternsPath} line ${i + 1} is not a valid regular expression (pattern withheld).`,
      );
      process.exit(EXIT_USAGE);
    }
  }
} else if (patternsPath) {
  const message = `leak-check: pattern file not found or unreadable (${patternsPath}) — built-in rules only.`;
  if (values["require-patterns"]) {
    console.error(message.replace("built-in rules only.", "--require-patterns is set, refusing to run degraded."));
    process.exit(EXIT_USAGE);
  }
  console.error(message);
} else if (values["require-patterns"]) {
  console.error(
    "leak-check: --require-patterns is set but no pattern file was given (--patterns or CONFIDENTIALITY_DENYLIST_FILE).",
  );
  process.exit(EXIT_USAGE);
} else {
  console.error(
    "leak-check: CONFIDENTIALITY_DENYLIST_FILE is unset and no --patterns given — built-in rules only.",
  );
}

const allRules = [...RULES, ...operatorRules];

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/** A unit of content to scan: what to read, and what to call it in a report. */
interface Target {
  display: string;
  text: string;
}

function looksBinary(buf: Buffer): boolean {
  const window = buf.subarray(0, 8000);
  return window.includes(0);
}

function collectFiles(path: string, out: string[]): void {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      if (entry.isSymbolicLink()) {
        skippedSymlinks++;
        continue;
      }
      collectFiles(join(path, entry.name), out);
    }
    return;
  }
  if (st.isFile()) out.push(path);
}

function readTarget(path: string, display: string): Target | null {
  const st = statSync(path);
  if (st.size > MAX_BYTES) {
    console.error(`leak-check: skipped ${display} — larger than ${MAX_BYTES} bytes, not scanned.`);
    skipped++;
    return null;
  }
  const buf = readFileSync(path);
  if (looksBinary(buf)) {
    skipped++;
    return null;
  }
  return { display, text: buf.toString("utf8") };
}

function git(args: string[], cwd?: string) {
  const proc = Bun.spawnSync(["git", ...args], cwd ? { cwd } : {});
  return {
    ok: (proc.exitCode ?? 1) === 0,
    stdout: proc.stdout,
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

function stagedTargets(): Target[] {
  const top = git(["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    console.error("leak-check: --staged requires a git repository (git rev-parse --show-toplevel failed).");
    process.exit(EXIT_USAGE);
  }
  const root = new TextDecoder().decode(top.stdout).trim();

  const list = git(["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"], root);
  if (!list.ok) {
    console.error(`leak-check: could not list staged files: ${list.stderr.trim()}`);
    process.exit(EXIT_USAGE);
  }
  const names = new TextDecoder()
    .decode(list.stdout)
    .split("\0")
    .filter((n) => n.length > 0);

  const targets: Target[] = [];
  for (const name of names) {
    // Read the STAGED blob, not the working-tree file — they can differ, and it
    // is the staged content that is about to be committed.
    const blob = git(["show", `:${name}`], root);
    if (!blob.ok) continue; // deleted or unreadable in the index — nothing to scan
    const buf = Buffer.from(blob.stdout);
    if (buf.length > MAX_BYTES) {
      console.error(`leak-check: skipped ${name} — larger than ${MAX_BYTES} bytes, not scanned.`);
      skipped++;
      continue;
    }
    if (looksBinary(buf)) {
      skipped++;
      continue;
    }
    targets.push({ display: name, text: buf.toString("utf8") });
  }
  return targets;
}

function pathTargets(paths: string[]): Target[] {
  const resolvedPatterns = patternsPath ? resolve(patternsPath) : null;
  const files: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) {
      console.error(`leak-check: path not found: ${p}`);
      process.exit(EXIT_USAGE);
    }
    collectFiles(p, files);
  }
  const targets: Target[] = [];
  for (const file of files) {
    // The pattern file legitimately contains every term it defends; scanning it
    // would produce a finding for each one.
    if (resolvedPatterns && resolve(file) === resolvedPatterns) continue;
    const rel = relative(process.cwd(), file);
    const target = readTarget(file, rel.startsWith("..") ? file : rel);
    if (target) targets.push(target);
  }
  return targets;
}

const targets = values.staged ? stagedTargets() : pathTargets(positionals);

const findings: Finding[] = [];
const exemptions: Exemption[] = [];
const warnings: string[] = [];

for (const target of targets) {
  const lines = target.text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // Zero-width characters stripped before ANY rule or the denylist sees
    // this line — see ZERO-WIDTH CHARACTERS ARE STRIPPED in the file header.
    const line = stripZeroWidth(lines[i]!);
    if (line.length === 0) continue;

    // Computed once per line — it doesn't depend on which rule fired, only
    // on which rule (if any) the marker names.
    const marker = parseAllowMarker(line);
    const ctx: AcceptContext = { line, display: target.display };

    for (const rule of allRules) {
      // Fresh search per line; no /g state to carry between lines. Retries
      // past a rejected candidate — see firstAcceptedMatch.
      const m = firstAcceptedMatch(rule, line, ctx);
      if (!m) continue;

      // A marker suppresses ONLY the rule it names, on the line it sits on —
      // a different rule's finding sharing that line is untouched.
      if (marker && marker.rule.toLowerCase() === rule.name.toLowerCase()) {
        if (rule.exemptable === false) {
          warnings.push(
            `${target.display}:${i + 1}: ${rule.name} is not exemptable via leak-check:allow — finding still blocks (leak-check-allow-unsupported)`,
          );
        } else if (marker.malformed) {
          warnings.push(
            `${target.display}:${i + 1}: leak-check:allow ${rule.name} — marker has no \`—\`/\`--\` separator; finding still blocks (leak-check-allow-unjustified)`,
          );
        } else if (marker.reason) {
          if (reasonContainsFinding(marker.reason, allRules)) {
            warnings.push(
              `${target.display}:${i + 1}: leak-check:allow ${rule.name} — reason withheld: contains a finding; finding still blocks (leak-check-allow-unjustified)`,
            );
          } else {
            exemptions.push({
              display: target.display,
              line: i + 1,
              rule: rule.name,
              reason: scrubReason(marker.reason),
            });
            continue; // suppressed — not added to findings
          }
        } else {
          warnings.push(
            `${target.display}:${i + 1}: leak-check:allow ${rule.name} — marker present without a reason; finding still blocks (leak-check-allow-unjustified)`,
          );
        }
      }

      findings.push({ display: target.display, line: i + 1, rule: rule.name });
    }
  }
}

// ---------------------------------------------------------------------------
// Report — locations and rule names only, never content.
// ---------------------------------------------------------------------------

const ruleSummary = `${RULES.length} built-in rule(s) + ${operatorRules.length} operator pattern(s)`;
const skipParts: string[] = [];
if (skipped > 0) skipParts.push(`${skipped} binary/oversize file(s) NOT scanned`);
if (skippedSymlinks > 0) skipParts.push(`${skippedSymlinks} symlink(s) NOT followed`);
const skipNote = skipParts.length > 0 ? `, ${skipParts.join(", ")}` : "";
const exemptionNote = exemptions.length > 0 ? `, ${exemptions.length} exemption(s) honoured` : "";

// Warnings and honoured exemptions are printed up front, independent of the
// overall pass/fail outcome — §4a: "Visible, never silent."
for (const w of warnings) {
  console.error(`leak-check: ${w}`);
}
for (const e of exemptions) {
  console.error(`[EXEMPT] ${e.display}:${e.line}: ${e.rule} — ${e.reason}`);
}

if (findings.length === 0) {
  console.log(
    `leak-check: clean — ${targets.length} file(s) scanned${skipNote}${exemptionNote}, ${ruleSummary} active.`,
  );
  process.exit(EXIT_CLEAN);
}

const files = new Set(findings.map((f) => f.display));
for (const f of findings) {
  console.error(`${f.display}:${f.line}: ${f.rule}`);
}
console.error(
  `\nleak-check: ${findings.length} finding(s) in ${files.size} file(s) — matched content withheld by design.`,
);
console.error(`Scanned ${targets.length} file(s)${skipNote}${exemptionNote} with ${ruleSummary}.`);
console.error("Open each location yourself. Do not paste the matched text into a PR, an issue, or a chat.");
process.exit(EXIT_FINDINGS);
