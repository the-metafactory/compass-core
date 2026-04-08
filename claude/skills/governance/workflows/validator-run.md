# Workflow: Validator Run

**Trigger:** "validate", "run validators", "structural check", "compliance check"

**Purpose:** Run all validators in `engine/validators/` against the consuming repo.

---

## Steps

1. **Read `compass.config.yaml`** — find `validators.*` config blocks (one per validator).
2. **List validators** in `engine/validators/`. Each `.ts` file is one validator.
3. **For each validator:**
   - Read its source file to confirm what config keys it consumes
   - Verify those keys exist in `compass.config.yaml`. If missing, mark the validator as `skipped (missing config)` and don't run it.
   - Run with `bun engine/validators/{name}.ts {repo path}` (or whatever entrypoint the validator exposes)
   - Capture exit code and stdout
4. **Aggregate results.**

## Output

```
Validator run: {repo path}

[ok]      claude-md-check     (sections: Architecture, Critical Rules)
[fail]    label-check         (missing labels: handover; extra labels: legacy-x)
[skipped] required-files-check (config validators.required_files not set)

Summary: 1 failed, 1 ok, 1 skipped
```

5. **For each failure:** Show the validator's findings verbatim. Don't paraphrase.
6. **Recommendation:** If any validator failed, tell the requester to fix the findings before merging. Do not auto-fix.

## Failure Modes

- **Validator throws unexpected exception:** Treat as `[error]`. Surface the stack trace. Don't claim the repo passed.
- **Validator hangs:** Kill after a reasonable timeout (60s default). Mark as `[timeout]`.
- **Config block exists but is invalid:** Surface the schema error, mark validator as `[config error]`.

## Phase C note

Until Phase C, validators may have hardcoded values that don't match `compass.config.yaml`. Phase C parameterizes them. In v0.1.0, validators run with built-in defaults — they still produce useful results for projects whose conventions match the defaults.
