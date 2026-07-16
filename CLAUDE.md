# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this MCP Memory Service repository. It is written to be self-sufficient: a model should be able to work correctly here from this file alone, without filling gaps from prior knowledge.

> **Personal Customizations**: You can create `CLAUDE.local.md` (gitignored) for personal notes, custom workflows, or environment-specific instructions. This file contains shared project conventions.

> **Information Lookup**: Files first, memory second, user last. See [`.claude/directives/memory-first.md`](.claude/directives/memory-first.md) for strategy. Comprehensive project context is stored in the MCP Memory Server with tag `claude-code-reference`.

## Non-Negotiables (hard rules)

Quick reference; each rule is expanded in the sections below. Violations cause real incidents.

1. **This repo lives on Codeberg, not GitHub.** `origin` is `codeberg.org:doobidoo/mcp-memory-service`; CI is Forgejo Actions (`.forgejo/workflows/`). The `github` remote is a suspended mirror — do **not** use `gh` or `github.com` URLs for CI, releases, or issues.
2. **Never manually bump versions.** Use the `codeberg-release-manager` agent for every version bump and release.
3. **Run `bash scripts/pr/pre_pr_check.sh` before every PR.** It is the mandatory pre-PR gate and must pass.
4. **Use the project venv.** Run `.venv/bin/python` and `.venv/bin/pytest` (Python 3.11) — the system interpreters are not the project environment.
5. **Store context in the MCP Memory Server, tagged `mcp-memory-service` first.** Never write `MEMORY.md` or local memory files unless the user explicitly asks for file-based storage.
6. **Access `Memory` fields by attribute** (`memory.tags`), never via `memory.metadata.get('tags')`. This has caused 3 production bugs.
7. **Sanitize user-provided values in logs** with `_sanitize_log_value()` (from `mcp_memory_service.compat`).
8. **MCP server configs go in `.mcp.json`**, not `settings.json`.
9. **Update `site/index.html` version strings on every MINOR/MAJOR release** (a CI gate enforces this).
10. **Never click "Always allow" on heredoc commands** — it corrupts `.claude/settings.local.json`.
11. **Before any SSH/network task, verify `hostname` and connection direction** (source → target).
12. **Report outcomes faithfully.** "Tests pass" means you ran them and saw them pass; if a step was skipped or failed, say so with the output.

## Critical Directives

**IMPORTANT**: Before working with this project, read:
- **`.claude/directives/memory-tagging.md`** - MANDATORY: Always tag memories with `mcp-memory-service` as first tag
- **`.claude/directives/README.md`** - Additional topic-specific directives

## Operational Rules

**These rules apply to every session. Violations cause real incidents — follow them exactly.**

### Memory Storage
- **Always use the MCP Memory Server** (`mcp__memory__memory_store`) for storing context, learnings, and decisions
- **Never write to `MEMORY.md` or local memory files** unless the user explicitly asks for file-based storage
- Tag all memories with `mcp-memory-service` as the first tag (per `memory-tagging.md`)

### MCP Configuration
- **MCP server configs go in `.mcp.json`**, not in `settings.json`

### SSH / Network Safety
- **Before any SSH or network task**: confirm machine identity with `hostname` and verify connection direction (source → target)
- **Never assume** which machine you're on or which direction a connection flows — always verify first

### Auto-Save Learnings
- **After completing tasks**: automatically save key learnings, decisions, and patterns to the MCP Memory Server without being asked
- Include relevant tags: `mcp-memory-service`, task-specific tags, and `learnings`

### Source Control & Hosting (Codeberg, not GitHub)
- **`origin` is Codeberg**: `git@codeberg.org:doobidoo/mcp-memory-service.git`. CI runs as **Forgejo Actions** in `.forgejo/workflows/`.
- **The `github` remote is a suspended mirror.** Do not use `gh` CLI, `github.com` URLs, or GitHub Actions for CI/release/issue work.
- **GHSA identifiers** (e.g. `GHSA-2r68-g678-7qr3`) are just advisory IDs and remain valid references.

### Release Workflow Checklist
Before merging or releasing:
1. Verify CI is green on the target branch (Forgejo Actions on Codeberg).
2. **Update `site/index.html` version strings** whenever MAJOR.MINOR changes — ALL occurrences: `<title>`, `<meta og:title>`, hero badge, "What's New" section, release link `href`. Use `grep -n "v11\." site/index.html` to find them. The `version-drift-check` CI gate enforces this.
3. Clean up merged branches after release (`git branch -d`, `git push origin --delete`).
4. Use the `codeberg-release-manager` agent — never manually bump versions.

## Overview

MCP Memory Service is a semantic memory layer for AI applications, accessible via REST API and MCP transport. It supports multiple storage backends (SQLite-vec, Cloudflare, Hybrid), vector embeddings for semantic search, memory consolidation, quality scoring, and OAuth 2.1 team collaboration.

**Current Version:** v11.5.4 - PATCH release: web dashboard GitHub references replaced with Codeberg (#158, #159, @sunnyagain); see [CHANGELOG.md](CHANGELOG.md) for details. (Issue/PR numbers refer to Codeberg.)

> **History (v10.0.0):** The v10 API consolidation unified 34 tools into 12. The deprecated tool-name alias layer (`compat.DEPRECATED_TOOLS`) was later **removed in v11** (Issue #53) — old tool names no longer resolve. The registry has since grown to ~28 tools (see `src/mcp_memory_service/tools/registry.py`).

> **History (Feb 2026 roadmap review):** The Q1 2026 quarterly review delivered 6/9 high-priority items ahead of schedule (Python 3.14 support, backup scheduler fix, CI/CD stability). Current roadmap: the **Development Roadmap** page on the Codeberg wiki.

## Essential Commands

### Python Environment

This repo uses a project virtualenv at `.venv` (Python 3.11). Always use the venv binaries:

```bash
.venv/bin/python -m mcp_memory_service.server   # run a module
.venv/bin/pytest                                # run the test suite
.venv/bin/python -m pip install -e .            # editable install
```

For `git commit`, the pre-commit hook uses **system** Python and will fail with "Package not installed"; prefix commits with `PATH=".venv/bin:$PATH"`.

### Development Server

```bash
memory launch                              # Background (default)
memory launch --foreground                 # Foreground
memory launch --storage-backend hybrid     # With specific backend
memory info                                # Check if running
memory stop / memory restart
memory logs / memory logs -n 50
```

Legacy: `python scripts/server/run_http_server.py` and `./scripts/update_and_restart.sh` still work.

### Testing
```bash
.venv/bin/pytest                                        # All tests
.venv/bin/pytest tests/storage/test_sqlite_vec.py       # Specific file
.venv/bin/pytest -m unit                                # Fast unit tests only
.venv/bin/pytest -m integration                         # Require storage
bash scripts/pr/pre_pr_check.sh                         # MANDATORY pre-PR gate
```

### Building & Installation
```bash
pip install -e .             # editable (development)
pip install -e ".[full]"     # all features
pip install -e ".[sqlite]"   # SQLite + ONNX only
```

### Health Checks
```bash
curl http://127.0.0.1:8000/api/health
python scripts/validation/validate_configuration_complete.py
python scripts/validation/diagnose_backend_config.py
```

**Full command reference:** [scripts/README.md](scripts/README.md)

## Memory Field Access Pattern (CRITICAL)

**ALWAYS use direct attribute access on Memory objects. NEVER access via the metadata dict.**

This anti-pattern has caused 3 production bugs (v10.13.1: PRs #466, #467, #469).

```python
# WRONG — always returns [] or '' even when field is populated
memory.metadata.get('tags', [])
memory.metadata.get('memory_type', '')

# CORRECT
memory.tags
memory.memory_type
memory.content_hash
memory.created_at
```

`Memory.metadata` is for **custom key-value pairs only** — not standard fields. Standard fields (`tags`, `memory_type`, `content_hash`, etc.) are top-level dataclass attributes.

**Log injection:** Never log user-provided values in raw f-strings. Always wrap with `_sanitize_log_value()` from `mcp_memory_service.compat`.

## Development Guidelines

**Read before working:**
- [`.claude/directives/development-setup.md`](.claude/directives/development-setup.md) - Editable install
- [`.claude/directives/pr-workflow.md`](.claude/directives/pr-workflow.md) - Pre-PR checks (MANDATORY)
- [`.claude/directives/refactoring-checklist.md`](.claude/directives/refactoring-checklist.md) - Refactoring safety
- [`.claude/directives/version-management.md`](.claude/directives/version-management.md) - Release workflow (HOW)
- [`.claude/directives/release-cadence.md`](.claude/directives/release-cadence.md) - Release batching (WHEN)

**Quick workflow:** `pip install -e .` → make changes → `.venv/bin/pytest` → `bash scripts/pr/pre_pr_check.sh` → PR via `codeberg-release-manager` agent.

**Adding a new MCP tool (v11 declarative flow):**
1. Add `ToolDef(name, description, input_schema, annotations)` to `TOOL_REGISTRY` in `tools/registry.py`
2. Implement handler `async def handle_X(server, arguments) -> List[types.TextContent]` in `server/handlers/`
3. Add `"<tool_name>": <handler>` to `ROUTING_TABLE` in `tools/routing.py`
4. If the tool reads caller-supplied paths, add to `local_only_tools()` in `server_impl.py`
5. Add tests in `tests/server/test_handlers.py`

**Renaming a tool is a breaking change** — the v11 alias layer was removed. Treat renames as major-version changes.

**Removing a feature:** run `grep -r "<term>" docs/ README.md` and clean up references in the same PR.

**External data parsers:** Always inspect real data before writing parsers — real JSON structures often differ from API docs.

**Dashboard changes (`web/static/`):** Verify in a browser before merging. No automated JS coverage.

## Definition of Done

**Every code change:**
- [ ] Relevant tests pass: `.venv/bin/pytest tests/<area>` or `.venv/bin/pytest -k <pattern>`
- [ ] `bash scripts/pr/pre_pr_check.sh` passes
- [ ] New code within complexity budget (A-B grade, complexity ≤8)
- [ ] User-provided log values wrapped with `_sanitize_log_value()`
- [ ] `Memory` fields accessed by attribute (`memory.tags`), never `memory.metadata.get('tags')`
- [ ] If a feature/port/command was removed: references cleaned up in `docs/` and `README.md`

**Dashboard changes:** verified in a browser — include a screenshot or testing note.

**Before a release / version bump:**
- [ ] CI is green on the target branch
- [ ] Version bumped via `codeberg-release-manager` agent (never by hand)
- [ ] `site/index.html` version strings updated if MAJOR.MINOR changed

**After finishing a task:** save key learnings/decisions to the MCP Memory Server, tagged `mcp-memory-service` first.

## Agent Integrations

- **codeberg-release-manager** — ALL releases (version bump, CHANGELOG, `_version.py`, PR, release notes)
- **changelog-archival** — keeps CHANGELOG lean by archiving old versions
- **amp-automation** — coding tasks + PR quality analysis
- **code-quality-guard** — quality analysis before commits
- **gemini-pr-automator** — automated PR reviews and fixes

See [`.claude/directives/agents.md`](.claude/directives/agents.md) for complete workflows.

## Additional Resources

- **Architecture:** [`.claude/directives/architecture.md`](.claude/directives/architecture.md)
- **Testing:** [`.claude/directives/testing.md`](.claude/directives/testing.md)
- **Configuration:** [`.claude/directives/configuration.md`](.claude/directives/configuration.md)
- **Troubleshooting:** [`.claude/directives/troubleshooting.md`](.claude/directives/troubleshooting.md)
- **Storage Backends:** [`.claude/directives/storage-backends.md`](.claude/directives/storage-backends.md)
- **Hooks Configuration:** [`.claude/directives/hooks-configuration.md`](.claude/directives/hooks-configuration.md)
- **Quality System:** [`.claude/directives/quality-system-details.md`](.claude/directives/quality-system-details.md)
- **Consolidation:** [`.claude/directives/consolidation-details.md`](.claude/directives/consolidation-details.md)
- **Code Quality:** [`.claude/directives/code-quality-workflow.md`](.claude/directives/code-quality-workflow.md)
- **Wiki:** https://codeberg.org/doobidoo/mcp-memory-service/wiki

---

**Quick Start Checklist for New Contributors:**
1. [ ] Read this file (CLAUDE.md), especially the Non-Negotiables
2. [ ] Read `.claude/directives/memory-tagging.md` (MANDATORY)
3. [ ] Run `pip install -e .` into `.venv` (editable install)
4. [ ] Run `.venv/bin/pytest` (verify tests pass)
5. [ ] Read the relevant directive files for your work area
6. [ ] Make changes and run `bash scripts/pr/pre_pr_check.sh` before a PR
