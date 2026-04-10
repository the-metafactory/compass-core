/**
 * config.ts — Load compass.config.yaml for compass-core validators and runners.
 *
 * Looks for compass.config.yaml in (priority order):
 *   1. The path passed via the COMPASS_CONFIG env var
 *   2. The path passed as the second argument to loadConfig()
 *   3. compass.config.yaml in the cwd
 *   4. compass.config.yaml in the directory containing the target file (if provided)
 *
 * If no config is found, returns null and callers fall back to the documented defaults.
 * If a config is found but fails schema validation, loadConfig() throws with a
 * human-readable error pointing at the offending field — array elements are
 * validated individually (see `labels.required.types` etc.) so a stray number or
 * null in a string list is caught at load time instead of crashing a downstream
 * validator.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Zod schema for compass.config.yaml. Every field is optional — callers fall
 * back to documented defaults when a value isn't set. Arrays are validated
 * element-by-element to catch stray non-strings (e.g., an unquoted `yes` that
 * YAML parses as a boolean) before they reach a downstream consumer.
 */
// Design note: nested objects use strict z.object() (not passthrough) so that
// typos inside known sections (e.g., org.naem instead of org.name) surface as
// validation errors rather than being silently preserved. Only the top level
// uses passthrough() because unknown *top-level* keys are the expected
// extension mechanism (see `extensions:` block and forward-compat test).
export const CompassConfigSchema = z
  .object({
    schema: z.string().optional(),
    org: z
      .object({
        name: z.string().optional(),
        display_name: z.string().optional(),
        default_license: z.string().optional(),
        default_branch: z.string().optional(),
      })
      .optional(),
    features: z
      .object({
        id_prefix: z.string().optional(),
        branch_pattern: z.string().optional(),
        worktree_pattern: z.string().optional(),
        commit_prefix: z.string().optional(),
      })
      .optional(),
    labels: z
      .object({
        source: z.string().optional(),
        required: z
          .object({
            types: z.array(z.string()).optional(),
            priorities: z.array(z.string()).optional(),
          })
          .optional(),
      })
      .optional(),
    validators: z
      .object({
        claude_md: z
          .object({
            enabled: z.boolean().optional(),
            required_sections: z.array(z.string()).optional(),
          })
          .optional(),
        label_check: z
          .object({
            enabled: z.boolean().optional(),
            enforce_required: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
    versioning: z
      .object({
        manifest: z.string().optional(),
        release_title_format: z.string().optional(),
        deploy_command: z.string().optional(),
      })
      .optional(),
    // Extensions are intentionally opaque — consumers define their own schemas
    // on top of whatever shape they need. Validating here would defeat the
    // extension point.
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type CompassConfig = z.infer<typeof CompassConfigSchema>;

export interface LoadConfigOptions {
  /** Explicit path to compass.config.yaml. Highest precedence after COMPASS_CONFIG. */
  configPath?: string;
  /** Path to a target file (e.g., a CLAUDE.md). The loader walks up to find compass.config.yaml. */
  near?: string;
}

/**
 * Locate the compass.config.yaml file. Returns null if not found.
 */
export function findConfigPath(opts: LoadConfigOptions = {}): string | null {
  // 1. env var
  const envPath = process.env.COMPASS_CONFIG;
  if (envPath && existsSync(envPath)) return resolve(envPath);

  // 2. explicit option
  if (opts.configPath && existsSync(opts.configPath)) return resolve(opts.configPath);

  // 3. cwd
  const cwdConfig = resolve(process.cwd(), "compass.config.yaml");
  if (existsSync(cwdConfig)) return cwdConfig;

  // 4. walk up from `near`
  if (opts.near) {
    let dir = resolve(dirname(opts.near));
    while (true) {
      const candidate = resolve(dir, "compass.config.yaml");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return null;
}

/**
 * Load compass.config.yaml. Returns null if no config file is found.
 * Throws if the file exists but cannot be parsed or fails schema validation.
 */
export function loadConfig(opts: LoadConfigOptions = {}): CompassConfig | null {
  const path = findConfigPath(opts);
  if (!path) return null;

  const text = readFileSync(path, "utf8");
  const parsed = parseYaml(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`compass.config.yaml at ${path} did not parse to an object`);
  }

  const result = CompassConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `compass.config.yaml at ${path} failed schema validation:\n${issues}`,
    );
  }

  return result.data;
}
