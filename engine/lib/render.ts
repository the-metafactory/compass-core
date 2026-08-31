/**
 * render.ts — install-time rendering of `{{config:...}}` placeholders.
 *
 * compass-core's SOPs ship with `{{config:...}}` placeholders. Historically a
 * governed repo carried them verbatim, so every skill invocation cost the model
 * four indirections: read the skill, read compass.config.yaml, read the SOP,
 * substitute by hand (the-metafactory/compass-core#17). This module moves that
 * substitution to install time: the rendered SOP in the target repo is the
 * single source of truth and names real values inline.
 *
 * ## Grammar
 *
 *   {{config:<key.path>}}              — substitute the value for <key.path>
 *   {{config:<key.path>|<fallback>}}   — ...or this phrasing when it is unset
 *   {{config:<key.path>|}}             — ...or drop it (empty fallback)
 *
 * `<key.path>` is dotted lower-snake (`org.default_branch`). Anything that is
 * not a key path — the meta-references `{{config:*}}` and `{{config:...}}` that
 * the SOPs use when *describing* the grammar — is left verbatim and reported,
 * never treated as a lookup. Other namespaces (`{{template:...}}`,
 * `{{repo_name}}`, `{{branch}}`) are outside this module's remit and untouched.
 *
 * ## Resolution rule for an unset key
 *
 * Every key is optional in the Zod schema, so "required" here means required by
 * `claude/skills/governance/config-schema.md`, which is the human contract. The
 * order is:
 *
 *   1. Value present in the target's config     → substitute it.
 *   2. Inline `|fallback` given in the source   → use the SOP author's phrasing.
 *   3. Key has a documented default             → substitute the default, and
 *                                                 report it (never silent).
 *   4. Key is documented optional               → drop-mode (see below).
 *   5. Otherwise                                → unresolved; the installer
 *                                                 aborts naming the key. We
 *                                                 never ship a half-rendered
 *                                                 SOP or a blank where a value
 *                                                 belongs.
 *
 * Drop-mode, for an optional key that is genuinely unset: if the placeholder
 * sits inside a parenthetical on its line, the whole parenthetical goes (a
 * parenthetical exists precisely to be optional — "post to the team channel
 * (`#eng` if configured)" becomes "post to the team channel"). Otherwise the
 * key's documented neutral phrase is substituted, so prose that depends on the
 * value grammatically still reads ("Report: the team channel").
 *
 * Rendering is pure and deterministic: same source + same config, same bytes.
 * That is what makes `install.ts` byte-idempotent.
 */

import type { CompassConfig } from "./config.ts";

export const BEGIN_MARKER = "<!-- compass-core:begin -->";
export const END_MARKER = "<!-- compass-core:end -->";

/** A `{{config:...}}` occurrence. The body may carry an inline `|fallback`. */
const PLACEHOLDER_RE = /\{\{config:([^}]*)\}\}/g;

/** Dotted lower-snake key path. Anything else is a meta-reference, not a key. */
const KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/** A balanced, non-nested `( ... )` span. */
const PAREN_RE = /\([^()]*\)/g;

type KeyKind = "required" | "default" | "optional";

interface KeyPolicy {
  kind: KeyKind;
  /** For `default`: the documented default. For `optional`: the neutral phrase. */
  value?: string | string[];
}

/**
 * The rendering contract for every key the shipped SOPs and the CLAUDE.md block
 * reference. Mirrors `claude/skills/governance/config-schema.md` — if that doc
 * and this table disagree, the doc is right and this is a bug.
 */
export const KEY_POLICY: Record<string, KeyPolicy> = {
  // Required: the doc marks these required and offers no default. A SOP that
  // says `gh repo create {{config:org.name}}/x` is useless without a value, so
  // an unset one fails the install rather than rendering a hole.
  "org.name": { kind: "required" },
  "org.display_name": { kind: "required" },
  "org.default_license": { kind: "required" },
  "features.id_prefix": { kind: "required" },
  "labels.source": { kind: "required" },

  // Documented defaults.
  "org.default_branch": { kind: "default", value: "main" },
  "features.branch_pattern": { kind: "default", value: "feat/{id}-{slug}" },
  "features.worktree_pattern": { kind: "default", value: "../{repo}-{slug}" },
  "features.commit_prefix": { kind: "default", value: "feat" },
  "labels.required.types": {
    kind: "default",
    value: ["bug", "documentation", "feature", "infrastructure"],
  },
  "labels.required.priorities": {
    kind: "default",
    value: ["now", "next", "future"],
  },
  "validators.claude_md.required_sections": {
    kind: "default",
    value: ["Critical Rules", "Standard Operating Procedures"],
  },
  "versioning.manifest": { kind: "default", value: "arc-manifest.yaml" },
  "versioning.release_title_format": {
    kind: "default",
    value: "{repo} v{version} — {description}",
  },

  // Optional: the doc says omitting these leaves the SOPs reading as plain
  // prose. The phrase is what a sentence that needs a noun falls back to.
  "channels.team": { kind: "optional", value: "the team channel" },
  "channels.public": { kind: "optional", value: "the public channel" },
  "versioning.deploy_command": {
    kind: "optional",
    value: "your configured deploy command",
  },
};

export interface RenderResult {
  text: string;
  /** Keys rendered from a documented default because the config did not set them. */
  defaulted: string[];
  /** Optional keys that were unset — parenthetical dropped or phrase substituted. */
  dropped: string[];
  /** Keys with no value, no fallback and no default. The installer aborts on these. */
  unresolved: string[];
  /** Placeholder bodies left verbatim because they are not key paths. */
  verbatim: string[];
}

/**
 * Look a dotted path up in the config. Returns undefined when the key is
 * absent, null, or *present but empty*.
 *
 * An empty value is treated as unset so it falls into the four-step resolution
 * chain rather than rendering a hole. `org.name: ""` must not quietly produce
 * `gh repo create /{repo-name}`; `channels.team: ""` must not produce an empty
 * backtick parenthetical. This matches how config.ts treats an empty
 * COMPASS_CONFIG, and it is what rule 5 of this module's header already
 * promised: we never ship a blank where a value belongs.
 *
 * Emptiness is judged on a trimmed copy; the value itself renders as authored.
 */
function lookup(config: CompassConfig, key: string): unknown {
  let node: unknown = config;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
    if (node === undefined || node === null) return undefined;
  }
  if (typeof node === "string" && node.trim() === "") return undefined;
  if (Array.isArray(node) && node.filter((v) => String(v).trim() !== "").length === 0) {
    return undefined;
  }
  return node;
}

/**
 * Format a config value for prose. Arrays join in config order — never sorted,
 * because the author's order is meaningful and re-ordering would make the
 * output depend on something other than the input.
 */
function format(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((v) => (typeof v === "string" ? v : String(v)));
    return parts.join(", ");
  }
  return undefined;
}

interface Edit {
  start: number;
  end: number;
  replacement: string;
}

/**
 * Render one line. Kept line-scoped because drop-mode reasons about the
 * parenthetical a placeholder sits in, and a parenthetical never spans lines in
 * these documents.
 */
function renderLine(line: string, config: CompassConfig, out: RenderResult): string {
  const parens = [...line.matchAll(PAREN_RE)].map((m) => ({
    start: m.index!,
    end: m.index! + m[0].length,
  }));

  const edits: Edit[] = [];
  const parenDeletions = new Set<number>();

  for (const match of line.matchAll(PLACEHOLDER_RE)) {
    const start = match.index!;
    const end = start + match[0].length;
    const body = match[1] ?? "";

    const bar = body.indexOf("|");
    const key = (bar === -1 ? body : body.slice(0, bar)).trim();
    const inlineFallback = bar === -1 ? undefined : body.slice(bar + 1);

    if (!KEY_RE.test(key)) {
      // A meta-reference to the grammar itself, e.g. `{{config:*}}`. Leaving it
      // verbatim is correct: the SOP is talking *about* placeholders.
      out.verbatim.push(body);
      continue;
    }

    const configured = format(lookup(config, key));
    if (configured !== undefined) {
      edits.push({ start, end, replacement: configured });
      continue;
    }

    if (inlineFallback !== undefined) {
      if (inlineFallback === "") {
        record(out.dropped, key);
        dropOrBlank(start, end, parens, parenDeletions, edits, "");
      } else {
        edits.push({ start, end, replacement: inlineFallback });
      }
      continue;
    }

    const policy = KEY_POLICY[key];
    if (policy?.kind === "default") {
      record(out.defaulted, key);
      edits.push({ start, end, replacement: format(policy.value) ?? "" });
      continue;
    }

    if (policy?.kind === "optional") {
      record(out.dropped, key);
      dropOrBlank(start, end, parens, parenDeletions, edits, format(policy.value) ?? "");
      continue;
    }

    // `required`, or a key we have never heard of. Either way the installer
    // must stop and say which key — leave the placeholder so the failure is
    // visible if anything ever renders past it.
    record(out.unresolved, key);
  }

  // A deleted parenthetical subsumes every edit inside it. Drop those edits
  // here, at construction, so the surviving spans cannot overlap. Deciding
  // subsumption while *applying* right-to-left got this backwards: the inner
  // edit sorted first, applied, and then the enclosing deletion was skipped
  // for overlapping it — which shipped a live `{{config:...}}` into a rendered
  // SOP whenever an unset optional key shared a parenthetical with a
  // resolvable one. Overlap is a construction-time concern, not an
  // application-time one.
  const deletions = [...parenDeletions].map((index) => {
    const span = parens[index]!;
    // Absorb one preceding space so "team (`#x`) only" closes to "team only".
    const start = span.start > 0 && line[span.start - 1] === " " ? span.start - 1 : span.start;
    return { start, end: span.end, replacement: "" };
  });

  const surviving = edits.filter(
    (edit) => !deletions.some((d) => d.start <= edit.start && d.end >= edit.end),
  );

  // Apply right-to-left so earlier offsets stay valid.
  const final = [...deletions, ...surviving].sort((a, b) => b.start - a.start);
  let result = line;
  for (const edit of final) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  return result;
}

function record(list: string[], key: string): void {
  if (!list.includes(key)) list.push(key);
}

/**
 * Drop-mode. Prefer deleting the enclosing parenthetical; fall back to
 * substituting the neutral phrase when the placeholder stands in open prose.
 */
function dropOrBlank(
  start: number,
  end: number,
  parens: { start: number; end: number }[],
  parenDeletions: Set<number>,
  edits: Edit[],
  phrase: string,
): void {
  const index = parens.findIndex((p) => p.start < start && p.end > end);
  if (index !== -1) {
    parenDeletions.add(index);
    return;
  }
  edits.push({ start, end, replacement: phrase });
}

/** Render every `{{config:...}}` placeholder in `text` against `config`. */
export function renderText(text: string, config: CompassConfig): RenderResult {
  const out: RenderResult = {
    text: "",
    defaulted: [],
    dropped: [],
    unresolved: [],
    verbatim: [],
  };
  out.text = text
    .split("\n")
    .map((line) => (line.includes("{{config:") ? renderLine(line, config, out) : line))
    .join("\n");
  return out;
}

/**
 * The SOP activation table. Ordered here, not by directory listing, so the
 * rendered block does not depend on filesystem enumeration order. A SOP without
 * a row still gets one — appended alphabetically with a generic phrase — so
 * adding a SOP can never silently drop it from the table.
 */
const ACTIVATION: Array<[file: string, label: string, when: string]> = [
  ["design-process.md", "Design process", "Creating specs, design docs, or research docs"],
  [
    "brainstorming-and-review.md",
    "Brainstorming + review",
    "Capturing strategic discussions or design decisions",
  ],
  [
    "dev-pipeline.md",
    "Dev pipeline",
    "Creating branches, making PRs, starting any feature/fix work",
  ],
  [
    "in-session-dev-loop.md",
    "In-session dev loop",
    "Driving work to shipped in-session, with a live narrative",
  ],
  [
    "autonomous-work.md",
    "Autonomous work",
    "Running a multi-slice body of work unattended",
  ],
  [
    "plan-breakdown.md",
    "Plan breakdown",
    "Turning a plan or review into executor-grade issues",
  ],
  ["versioning.md", "Versioning", "After merging PRs, before deploying, any version bump"],
  [
    "worktree-discipline.md",
    "Worktree discipline",
    "Starting feature work (always — even solo)",
  ],
  ["pr-review.md", "PR review", "Reviewing a PR, before approving or merging"],
  [
    "confidentiality-gate.md",
    "Confidentiality gate",
    "Client or confidential work, denylist and gate changes",
  ],
  [
    "retrospective-and-process-mining.md",
    "Retrospective",
    "Post-work review, extracting process patterns",
  ],
  ["new-repo-pattern.md", "New repo", "Bootstrapping a new repository"],
];

function title(file: string): string {
  const stem = file.replace(/\.md$/, "").replace(/[-_]/g, " ");
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

/** Resolve a key for the block, using the same rules as prose rendering. */
function value(config: CompassConfig, key: string): string | null {
  const configured = format(lookup(config, key));
  if (configured !== undefined) return configured;
  const policy = KEY_POLICY[key];
  if (policy?.kind === "default") return format(policy.value) ?? null;
  return null;
}

/**
 * Build the marked CLAUDE.md block: the critical rules, the SOP activation
 * table, and the repo-specific values, all fully rendered. The rules are the
 * four generic ones from templates/CLAUDE.md.template — universal engineering
 * discipline, nothing org-flavoured — and they are here so an installed repo
 * satisfies compass-core's own claude-md-check out of the box rather than the
 * installer and the validator disagreeing about what "governed" means.
 *
 * Deterministic for fixed inputs — no timestamps, no version stamp, nothing
 * that would break idempotency.
 */
export function buildClaudeBlock(config: CompassConfig, sopFiles: string[]): string {
  const present = new Set(sopFiles);
  const known = ACTIVATION.filter(([file]) => present.has(file));
  const extra = sopFiles
    .filter((f) => !ACTIVATION.some(([file]) => file === f))
    .sort()
    .map((f) => [f, title(f), "Consult before related work"] as const);

  const rows = [...known, ...extra].map(
    ([file, label, when]) => `| **${label}** | ${when} | \`sops/${file}\` |`,
  );

  const facts: Array<[string, string]> = [];
  const push = (label: string, key: string) => {
    const v = value(config, key);
    if (v !== null) facts.push([label, v]);
  };
  push("Default branch", "org.default_branch");
  push("Feature branch pattern", "features.branch_pattern");
  push("Worktree pattern", "features.worktree_pattern");
  push("Commit prefix", "features.commit_prefix");
  push("Feature ID prefix", "features.id_prefix");
  push("Version manifest", "versioning.manifest");
  push("Release title format", "versioning.release_title_format");
  push("Label set", "labels.source");

  return [
    BEGIN_MARKER,
    "<!-- Managed by compass-core. Everything between these markers is regenerated",
    "     by `bun engine/install.ts <dir>`; bytes outside them are never touched.",
    "     To change what appears here, edit compass.config.yaml and re-run install. -->",
    "",
    "## Critical Rules",
    "",
    "- NEVER describe code you haven't read. Use Read/Glob/Grep to verify before making claims.",
    "- NEVER fabricate file names, class names, or architecture. If unsure, read the source.",
    "- Fix ALL errors found during type checks, tests, or linting — even pre-existing ones, and",
    "  even ones another developer introduced. Never dismiss an error as \"not from our changes\".",
    "- Before fixing a bug or building a feature, ALWAYS check open PRs (`gh pr list`) and issues",
    "  (`gh issue list`) first. Someone may already be on it, or a PR may already fix it.",
    "",
    "## Standard Operating Procedures",
    "",
    "This repo follows compass-core SOPs. Before starting work, identify which SOPs",
    "apply and Read them. Output the pre-flight line from each loaded SOP.",
    "",
    "| SOP | Activate when | File |",
    "|-----|--------------|------|",
    ...rows,
    "",
    "### Repo-specific governance values",
    "",
    "Rendered from `compass.config.yaml` at install time. The SOP files above",
    "already carry these values inline — there is nothing to look up at run time.",
    "",
    ...facts.map(([label, v]) => `- ${label}: \`${v}\``),
    END_MARKER,
  ].join("\n");
}

/**
 * Merge `block` into an existing CLAUDE.md.
 *
 * - No file           → the block alone.
 * - No markers        → the block appended, existing bytes untouched.
 * - Markers present   → only the bytes *between* them are replaced. This is
 *                       what makes re-install idempotent and what keeps a
 *                       user's own content, above and below, byte-exact.
 */
export function mergeClaudeMd(existing: string | null, block: string): string {
  if (existing === null) return `${block}\n`;

  const begin = existing.indexOf(BEGIN_MARKER);
  const end = existing.indexOf(END_MARKER);

  if (begin === -1 && end === -1) {
    const base = existing.endsWith("\n") || existing === "" ? existing : `${existing}\n`;
    return `${base}\n${block}\n`;
  }

  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      "MARKERS_MALFORMED — CLAUDE.md has an unbalanced compass-core marker pair. " +
        `Expected ${BEGIN_MARKER} followed by ${END_MARKER}. Fix by hand; the ` +
        "installer will not guess where the managed block ends.",
    );
  }

  return existing.slice(0, begin) + block + existing.slice(end + END_MARKER.length);
}
