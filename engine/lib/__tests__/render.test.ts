/**
 * Tests for engine/lib/render.ts — the install-time placeholder renderer.
 *
 * These are unit tests over pure functions. The CLI surface that consumes them
 * is tested end-to-end in engine/__tests__/install.test.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  BEGIN_MARKER,
  END_MARKER,
  buildClaudeBlock,
  mergeClaudeMd,
  renderText,
} from "../render.ts";
import type { CompassConfig } from "../config.ts";

const FULL: CompassConfig = {
  schema: "compass-config/v1",
  org: {
    name: "acme-corp",
    display_name: "Acme",
    default_license: "MIT",
    default_branch: "trunk",
  },
  features: {
    id_prefix: "F-",
    branch_pattern: "feat/{id}-{slug}",
    worktree_pattern: "../{repo}-{slug}",
    commit_prefix: "feat",
  },
  labels: {
    source: "standards/labels.yaml",
    required: {
      types: ["bug", "feature"],
      priorities: ["now", "next"],
    },
  },
  channels: { team: "#eng-internal", public: "#community" },
  versioning: {
    manifest: "arc-manifest.yaml",
    release_title_format: "{repo} v{version}",
  },
} as CompassConfig;

/** The minimum a config can carry and still render: every `required` key set. */
const MINIMAL: CompassConfig = {
  schema: "compass-config/v1",
  org: { name: "acme-corp", display_name: "Acme", default_license: "MIT" },
  features: { id_prefix: "F-" },
  labels: { source: "standards/labels.yaml" },
} as CompassConfig;

describe("renderText — direct substitution", () => {
  test("substitutes a configured scalar", () => {
    const r = renderText("Branch from {{config:org.default_branch}}.", FULL);
    expect(r.text).toBe("Branch from trunk.");
    expect(r.unresolved).toEqual([]);
  });

  test("substitutes every occurrence of a repeated placeholder", () => {
    const r = renderText(
      "{{config:org.name}}/repo and {{config:org.name}}/other",
      FULL,
    );
    expect(r.text).toBe("acme-corp/repo and acme-corp/other");
  });

  test("renders an array as a comma-joined list in config order", () => {
    const r = renderText("Types: {{config:labels.required.types}}", FULL);
    expect(r.text).toBe("Types: bug, feature");
  });

  test("leaves non-config placeholder namespaces untouched", () => {
    const src = "{{template:sops_path}} {{repo_name}} {{new_version}} {{branch}}";
    const r = renderText(src, FULL);
    expect(r.text).toBe(src);
  });
});

describe("renderText — documented defaults", () => {
  test("falls back to the documented default when a defaulted key is unset", () => {
    const r = renderText("Base: {{config:org.default_branch}}", MINIMAL);
    expect(r.text).toBe("Base: main");
    expect(r.defaulted).toContain("org.default_branch");
    expect(r.unresolved).toEqual([]);
  });

  test("does not report a default when the config supplies the value", () => {
    const r = renderText("Base: {{config:org.default_branch}}", FULL);
    expect(r.defaulted).toEqual([]);
  });
});

describe("renderText — optional keys (the team-channel rule)", () => {
  const line =
    "6. **Report.** Post a one-liner to the team channel (`{{config:channels.team}}` if configured): verdict + counts.";

  test("team channel SET renders the real value", () => {
    const r = renderText(line, FULL);
    expect(r.text).toContain("#eng-internal");
    expect(r.text).not.toContain("{{config:");
    expect(r.dropped).toEqual([]);
  });

  test("team channel UNSET drops the parenthetical cleanly", () => {
    const r = renderText(line, MINIMAL);
    expect(r.text).toBe(
      "6. **Report.** Post a one-liner to the team channel: verdict + counts.",
    );
    expect(r.dropped).toContain("channels.team");
    expect(r.unresolved).toEqual([]);
  });

  test("optional key unset outside a parenthetical renders the documented phrase", () => {
    const r = renderText("| Report: {{config:channels.team}} | Holds: none", MINIMAL);
    expect(r.text).toBe("| Report: the team channel | Holds: none");
    expect(r.text).not.toContain("{{config:");
  });

  test("optional deploy_command unset renders its documented phrase", () => {
    const r = renderText("running `{{config:versioning.deploy_command}}` live", MINIMAL);
    expect(r.text).toBe("running `your configured deploy command` live");
  });

  test("parenthetical drop removes exactly one preceding space", () => {
    const r = renderText("narrate to team (`{{config:channels.public}}`) only", MINIMAL);
    expect(r.text).toBe("narrate to team only");
  });
});

describe("renderText — inline fallback grammar", () => {
  test("uses the SOP-supplied fallback when the key is unset", () => {
    const r = renderText("Ping {{config:channels.team|your team channel}}.", MINIMAL);
    expect(r.text).toBe("Ping your team channel.");
  });

  test("prefers the configured value over the inline fallback", () => {
    const r = renderText("Ping {{config:channels.team|your team channel}}.", FULL);
    expect(r.text).toBe("Ping #eng-internal.");
  });

  test("an empty inline fallback drops the enclosing parenthetical", () => {
    const r = renderText("report it (to {{config:channels.team|}}) now", MINIMAL);
    expect(r.text).toBe("report it now");
  });
});

describe("renderText — unresolvable keys", () => {
  test("a required key with no value is reported unresolved", () => {
    const r = renderText("{{config:org.name}}/repo", {} as CompassConfig);
    expect(r.unresolved).toContain("org.name");
    expect(r.text).toContain("{{config:org.name}}");
  });

  test("an unknown key with no value and no fallback is unresolved", () => {
    const r = renderText("{{config:made.up.key}}", FULL);
    expect(r.unresolved).toContain("made.up.key");
  });

  test("an unknown key present in config renders (extension mechanism)", () => {
    const cfg = { ...FULL, made: { up: "yes" } } as unknown as CompassConfig;
    const r = renderText("{{config:made.up}}", cfg);
    expect(r.text).toBe("yes");
    expect(r.unresolved).toEqual([]);
  });

  test("a meta-reference that is not a key path is left verbatim, not an error", () => {
    const r = renderText("Replace any `{{config:*}}` placeholders", FULL);
    expect(r.text).toBe("Replace any `{{config:*}}` placeholders");
    expect(r.unresolved).toEqual([]);
    expect(r.verbatim).toContain("*");
  });
});

describe("mergeClaudeMd", () => {
  const block = `${BEGIN_MARKER}\nhello\n${END_MARKER}`;

  test("creates a file containing just the block when none exists", () => {
    expect(mergeClaudeMd(null, block)).toBe(`${block}\n`);
  });

  test("appends the block to an existing CLAUDE.md", () => {
    const out = mergeClaudeMd("# Repo\n\nMy rules.\n", block);
    expect(out).toBe(`# Repo\n\nMy rules.\n\n${block}\n`);
  });

  test("replaces only the bytes between the markers", () => {
    const existing = `# Repo\n\nabove\n\n${BEGIN_MARKER}\nOLD\n${END_MARKER}\n\nbelow\n`;
    const out = mergeClaudeMd(existing, block);
    expect(out).toBe(`# Repo\n\nabove\n\n${block}\n\nbelow\n`);
    expect(out).toContain("above");
    expect(out).toContain("below");
    expect(out).not.toContain("OLD");
  });

  test("is idempotent — merging its own output changes nothing", () => {
    const once = mergeClaudeMd("# Repo\n\nMy rules.\n", block);
    expect(mergeClaudeMd(once, block)).toBe(once);
  });

  test("throws on a begin marker with no end marker", () => {
    expect(() => mergeClaudeMd(`x\n${BEGIN_MARKER}\ny\n`, block)).toThrow(
      /MARKERS_MALFORMED/,
    );
  });

  test("throws when the end marker precedes the begin marker", () => {
    expect(() => mergeClaudeMd(`${END_MARKER}\n${BEGIN_MARKER}\n`, block)).toThrow(
      /MARKERS_MALFORMED/,
    );
  });
});

describe("buildClaudeBlock", () => {
  const sops = ["dev-pipeline.md", "versioning.md", "autonomous-work.md"];

  test("is wrapped in the compass-core markers", () => {
    const b = buildClaudeBlock(FULL, sops);
    expect(b.startsWith(BEGIN_MARKER)).toBe(true);
    expect(b.endsWith(END_MARKER)).toBe(true);
  });

  test("carries an activation row per installed SOP, pointing at sops/", () => {
    const b = buildClaudeBlock(FULL, sops);
    for (const f of sops) expect(b).toContain(`\`sops/${f}\``);
  });

  test("renders config values inline rather than telling the model to read the config", () => {
    const b = buildClaudeBlock(FULL, sops);
    expect(b).toContain("trunk");
    expect(b).toContain("arc-manifest.yaml");
    expect(b).not.toContain("{{config:");
    expect(b).not.toContain("{{template:");
  });

  test("is deterministic for the same inputs", () => {
    expect(buildClaudeBlock(FULL, sops)).toBe(buildClaudeBlock(FULL, sops));
  });

  test("orders rows independently of the order files are discovered in", () => {
    const a = buildClaudeBlock(FULL, ["versioning.md", "dev-pipeline.md"]);
    const b = buildClaudeBlock(FULL, ["dev-pipeline.md", "versioning.md"]);
    expect(a).toBe(b);
  });
});
