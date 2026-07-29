# Mid-Session Auto-Capture — Design Spec

**Date:** 2026-07-29  
**Branch:** tlkMods  
**Status:** Approved, pending implementation plan

---

## Problem

Session-end harvest produces junk: by the time a session ends, context is compressed, the
interesting moments are long past, and reconstruction is lossy. Manual memory stores work
but aren't sufficient. The real need is **session reconstruction** — a fresh session should
be able to understand not just what the codebase looks like, but why it got there and what
was decided along the way.

Two failure modes to cover:

1. **Committed work:** Decisions and rationale made during a coding session that led to a
   git commit — these exist in the commit message but aren't surfaced as searchable memories.

2. **Commitment-free sessions:** Debugging marathons, architectural discussions, incident
   response (e.g., Proxmox completely barfing at 11pm) — valuable context produced but no
   git artifacts to anchor it. Currently lost entirely.

---

## Non-Goals

- Error resolution capture (too much noise)
- LLM-based quality judgment in the capture path (too slow, too fragile)
- Further investment in session-end harvest
- Changes to session-start hook (already working well)

---

## Design

Two capture tiers wired into existing hook events. Both store metadata tags:
`project:<name>`, `hostname:<node>`, `dir:<working-directory>`, `branch:<branch>` (where
available), plus tier-specific tags below. All fires are non-blocking and must not delay
the session.

---

### Tier 1 — Completion Event Capture (PostToolUse)

Fires when a meaningful unit of work just completed. High signal, near-zero noise.

**Trigger conditions:**

| Event | Detection |
|---|---|
| git commit | Bash tool containing `git commit`, or `mcp__git__git_commit` tool use |
| Deploy / restart | Bash matching: `systemctl restart`, `systemctl start`, `docker compose up`, `docker restart`, `./deploy.sh`, `kubectl apply` |
| DECISIONS.md write | Write or Edit tool targeting a file named `DECISIONS.md` |

**What's captured per event:**

- **git commit:** commit message + changed file list + last 8 conversation turns (prose only,
  tool output stripped)
- **deploy/restart:** command string + inferred service name (from args) + last 8 conversation
  turns
- **DECISIONS.md write:** the new entry or entries parsed directly from the file diff — already
  structured, no extraction needed

**Memory type:** `decision` for commits and DECISIONS.md entries; `note` for deploy/restart  
**Tags:** `auto-capture`, `tier1`, plus event-specific: `commit` / `deploy` / `decision`

---

### Tier 2 — Conversation Checkpoints (UserPromptSubmit)

Covers sessions that produce no Tier 1 events. Captures at the moment of articulation,
not reconstruction.

**Trigger conditions (either fires it):**

**Condition A — Language signal:** User message contains conclusion/summary patterns:
- "I think what happened", "turns out", "the root cause", "the fix was"
- "here's what we learned", "so the theory is", "what we found"
- "I believe the issue is", "the problem was", "what I think is"

This fires at the exact moment insight is being stated — context is freshest here.

**Condition B — Turn threshold:** Every 20 conversation turns in sessions where Tier 1
has not yet fired. Resets if Tier 1 fires (a commit signals the session produced artifacts;
checkpoint cadence relaxes). Also resets after each Condition B fire.

**Cooldown:** 5 turns minimum between any two Tier 2 fires, regardless of condition.

**What's captured:** Last 10 conversation turns (prose only, tool output stripped) + project
+ hostname + working directory. Topic hint inferred from the first substantive user message
in the window — no LLM call, no network call.

**Memory type:** `insight` for Condition A fires; `note` for Condition B fires  
**Tags:** `auto-capture`, `tier2`, `checkpoint`

---

### Quality Gating

**Pre-store prose-density check (hook-side, inline, no network):**  
Before any Tier 2 store, count prose words in the extracted window (after stripping tool
output blocks). Minimum **150 prose words**. Skip if below. This is the only pre-store gate
— fast, dependency-free.

Tier 1 events skip the prose-density check: the commit message and DECISIONS.md content
are inherently structured, and conversation context is captured as a best-effort supplement.

**Post-store async quality scoring:**  
Existing `/api/quality/score` call (heuristic scorer) runs after storage as it does today.
Useful for service-level health and retrieval ranking. Not a meaningful discrimination gate
for captured prose (the heuristic scorer distinguishes prose-vs-garbage well, but within
already-filtered prose content, scores cluster at 0.85–0.95). Accept this limitation; rely
on consolidation over time to surface what's durable.

**No LLM call in the capture path.** `llm-proxy.k-lab.lan` (failover: downstairsPC llama.cpp
→ crof.ai/v2 glm-4.7-flash) is available in the homelab for future async post-store
summarization, but adding it to the hook path is too fragile for a hook that fires on every
user message.

---

## What's NOT Changing

| Component | Status |
|---|---|
| `session-start.js` | Unchanged — already working well |
| `session-end.js` | Stays registered, exits immediately (`enableSessionConsolidation=false`) |
| `session-end-harvest.js` | Stays registered; no further investment — Tier 1/2 make it redundant |
| Error resolution capture | Explicitly excluded — too much noise |
| DECISIONS.md as explicit mechanism | Complemented by Tier 1 sync, not replaced |
| Permission request hook | Unchanged |

---

## Implementation Surface

All changes in `claude-hooks/`:

| File | Change |
|---|---|
| `core/auto-capture-hook.js` | Add Tier 1 event detection: git commit, deploy/restart patterns, DECISIONS.md write |
| `core/mid-conversation.js` | Replace current T1/T2/T3 tiered analysis with Tier 2 logic: language-signal patterns + turn threshold. The existing tiered analysis (instant keyword scan → semantic → full LLM) is gone entirely — do not extend it. |
| `utilities/auto-capture-patterns.js` | Add Tier 1 completion-event patterns + Tier 2 checkpoint language patterns |
| `config.json` / `config.template.json` | Add enable flags for Tier 1 and Tier 2 independently |

Config flags to add:
```json
"autoCapture": {
  "tier1": { "enabled": true },
  "tier2": {
    "enabled": true,
    "turnThreshold": 20,
    "cooldownTurns": 5,
    "minProseWords": 150
  }
}
```

After changes: `cp claude-hooks/config.json ~/.claude/hooks/config.json` (no auto-sync exists).

---

## Open Questions (deferred to implementation)

- Exact deploy command pattern list — needs to be comprehensive without being overbroad
- Conversation window extraction: reuse existing `extractProseSentences` or a new utility?
- Turn counter state: in-memory per session (acceptable) or persisted via session-tracker.js?
- Should Tier 2 Condition B fire even if only tool-calling has happened (no user prose at all)?
  Likely no — add a minimum-prose-word guard on the window before Condition B fires.
