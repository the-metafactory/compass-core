# Workflow: SOP Lookup

**Trigger:** "what's the SOP for X?", "process for Y", "how do I Z", "where's the procedure for W"

**Purpose:** Find the right SOP, summarize its pre-flight + key rules, and link the requester to the file.

---

## Steps

1. **Identify the topic.** Map the request to one of the SOPs in `sops/`:

| Topic phrases | SOP |
|--------------|-----|
| design, research, spec, decision, ADR | `sops/design-process.md` |
| brainstorm, capture conversation, doc review | `sops/brainstorming-and-review.md` |
| branch, commit, PR, dev pipeline, feature workflow | `sops/dev-pipeline.md` |
| version, release, semver, tag, bump | `sops/versioning.md` |
| worktree, parallel work, multi-agent | `sops/worktree-discipline.md` |
| review PR, code review, lens | `sops/pr-review.md` |
| new repo, bootstrap, initialize | `sops/new-repo-pattern.md` |
| retro, retrospective, post-mortem, process mining | `sops/retrospective-and-process-mining.md` |

2. **Read the SOP file in full.** Don't summarize from memory.
3. **Extract:**
   - The Purpose line
   - The Pre-flight banner template
   - The numbered procedure (or main rules)
   - Any anti-patterns or failure modes
4. **Reply with a structured summary:**

```markdown
**SOP:** {name}
**File:** sops/{file}.md
**Pre-flight:**
\`\`\`
{banner template, with config placeholders if any}
\`\`\`
**Procedure:**
1. ...
2. ...
**Key rules:**
- ...
**Anti-patterns:**
- ...
```

5. **Point at the file** so the requester can read it themselves.

## Failure Modes

- **Topic doesn't map to any SOP:** Tell the requester the available SOPs and ask them to clarify.
- **SOP is a placeholder (Phase B not done):** Tell them the SOP is a v0.1.0 placeholder, full content lands in v0.2.0, and link to the placeholder file so they can read the target shape.
