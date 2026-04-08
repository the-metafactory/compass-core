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
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export interface CompassConfig {
  schema?: string;
  org?: {
    name?: string;
    display_name?: string;
    default_license?: string;
    default_branch?: string;
  };
  features?: {
    id_prefix?: string;
    branch_pattern?: string;
    worktree_pattern?: string;
    commit_prefix?: string;
  };
  labels?: {
    source?: string;
    required?: {
      types?: string[];
      priorities?: string[];
    };
  };
  validators?: {
    claude_md?: {
      enabled?: boolean;
      required_sections?: string[];
    };
    label_check?: {
      enabled?: boolean;
      enforce_required?: boolean;
    };
  };
  versioning?: {
    manifest?: string;
    release_title_format?: string;
    deploy_command?: string;
  };
  extensions?: Record<string, unknown>;
}

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
 * Throws if the file exists but cannot be parsed.
 */
export function loadConfig(opts: LoadConfigOptions = {}): CompassConfig | null {
  const path = findConfigPath(opts);
  if (!path) return null;

  const text = readFileSync(path, "utf8");
  const parsed = parseYaml(text) as CompassConfig | null | undefined;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`compass.config.yaml at ${path} did not parse to an object`);
  }
  return parsed;
}
