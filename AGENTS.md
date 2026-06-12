<!-- gitnexus:start -->
# GitNexus MCP

This project is indexed by GitNexus as **mcp-memory-service** (6259 symbols, 18031 relationships, 300 execution flows).

GitNexus provides a knowledge graph over this codebase — call chains, blast radius, execution flows, and semantic search.

## Always Start Here

For any task involving code understanding, debugging, impact analysis, or refactoring, you must:

1. **Read `gitnexus://repo/{name}/context`** — codebase overview + check index freshness
2. **Match your task to a skill below** and **read that skill file**
3. **Follow the skill's workflow and checklist**

> If step 1 warns the index is stale, run `npx gitnexus analyze` in the terminal first.

## Skills

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/refactoring/SKILL.md` |

## Tools Reference

| Tool | What it gives you |
|------|-------------------|
| `query` | Process-grouped code intelligence — execution flows related to a concept |
| `context` | 360-degree symbol view — categorized refs, processes it participates in |
| `impact` | Symbol blast radius — what breaks at depth 1/2/3 with confidence |
| `detect_changes` | Git-diff impact — what do your current changes affect |
| `rename` | Multi-file coordinated rename with confidence-tagged edits |
| `cypher` | Raw graph queries (read `gitnexus://repo/{name}/schema` first) |
| `list_repos` | Discover indexed repos |

## Resources Reference

Lightweight reads (~100-500 tokens) for navigation:

| Resource | Content |
|----------|---------|
| `gitnexus://repo/{name}/context` | Stats, staleness check |
| `gitnexus://repo/{name}/clusters` | All functional areas with cohesion scores |
| `gitnexus://repo/{name}/cluster/{clusterName}` | Area members |
| `gitnexus://repo/{name}/processes` | All execution flows |
| `gitnexus://repo/{name}/process/{processName}` | Step-by-step trace |
| `gitnexus://repo/{name}/schema` | Graph schema for Cypher |

## Graph Schema

**Nodes:** File, Function, Class, Interface, Method, Community, Process
**Edges (via CodeRelation.type):** CALLS, IMPORTS, EXTENDS, IMPLEMENTS, DEFINES, MEMBER_OF, STEP_IN_PROCESS

```cypher
MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(f:Function {name: "myFunc"})
RETURN caller.name, caller.filePath
```

<!-- gitnexus:end -->

---

# Information Retrieval Directive

## Layered Lookup: Files → Memory → User

When you need information about this project, follow this order:

### 1. Files First (Source of Truth)
**Always check files before anything else:**
- **Code**: `src/`, `tests/`, `scripts/`
- **Docs**: `docs/`, `CHANGELOG.md`, `README.md`
- **Config**: `.env`, `pyproject.toml`, `.claude/directives/`

### 2. Memory Second (Historical Context)
Use memory-service MCP tools when files don't explain WHY:
- **Design decisions**: search `"<topic> design decision"`
- **Known issues**: search `"<topic> troubleshooting"`
- **Performance baselines**: search `"<topic> performance"`
- **Architecture decisions**: search `"<topic> architecture"`
- **Error patterns**: use `memory-service_mistake_note_search` with the error message

### 3. User Last (Genuine Unknowns)
Only ask the user when files don't have the information and memory has no relevant context.

**Files always win.** If memory says X but code does Y, code is current truth.

---

# Memory Tagging

When storing memories manually, ALWAYS include `mcp-memory-service` as the first tag.

**Tag Priority Order:**
1. Project identifier: `mcp-memory-service` (REQUIRED)
2. Content category: `architecture`, `configuration`, `bug-fix`, `release`, `performance`
3. Specifics: `graph-database`, `hybrid-backend`, `sqlite-vec`, `v10.x`

**Standard Categories:**
| Category | Use Case |
|----------|----------|
| `architecture` | Design decisions, system structure |
| `configuration` | Setup, environment, settings |
| `performance` | Optimization, benchmarks |
| `bug-fix` | Issue resolution |
| `release` | Version management |
| `documentation` | Guides, references |

---

# Development Guide

## Quick Setup

```bash
python install.py                 # Auto-detects platform, installs deps
pip install -e ".[dev]"           # Editable install with dev deps
pytest                            # Run all tests
```

## Editable Install is MANDATORY

**ALWAYS use editable install** to avoid stale package issues:
```bash
pip install -e .  # or: uv pip install -e .
```

**Why:** MCP servers load from `site-packages`, not source files. Without `-e`, source changes won't be reflected until reinstall.

**Common symptom**: Code shows v8.23.0 but server reports v8.5.3

**Fix stale installation:**
```bash
pip uninstall mcp-memory-service
pip install -e .
```

## Essential Commands

### Testing
```bash
pytest                            # All tests
pytest tests/storage/test_sqlite_vec.py   # Single test file
pytest tests/storage/test_sqlite_vec.py::test_store_memory_success  # Single test
pytest -k "test_store"            # Tests matching name pattern
pytest -m unit                    # Fast unit tests only
pytest -m integration             # Integration tests (require storage)
pytest -m performance             # Performance benchmarks
pytest --cov=src/mcp_memory_service       # With coverage
```

### Linting & Formatting
```bash
ruff check src/                   # Lint with ruff
ruff check --fix src/             # Auto-fix lint issues
ruff format src/                  # Format with ruff
black src/                        # Format with black (88 char line length)
```

### Pre-PR Validation (MANDATORY before PR)
```bash
bash scripts/pr/pre_pr_check.sh   # Full pre-PR check
```

### Building & Release
```bash
python -m build                   # Build package
pip install -e ".[full]"          # Install all features
```

**Version bumps:** NEVER manual. Use `github-release-manager` agent.

## Code Style Guidelines

### Formatting
- **Line length:** 88 characters (Black default)
- **Formatter:** Black + Ruff
- **Quotes:** Double quotes for strings
- **Trailing commas:** Yes (Black style)

### Imports
```python
import os
import asyncio

import httpx
from fastapi import FastAPI

from mcp_memory_service.storage.base import BaseStorage
from mcp_memory_service.models.memory import Memory
```

### Type Hints
- **Required** on all function signatures
- Use `typing` module: `Optional`, `List`, `Dict`, `Any`
- Async functions return explicit types
- Docstrings: Google format required on all public functions

### Naming Conventions
- **Modules/files:** `snake_case.py`
- **Classes:** `PascalCase`
- **Functions/variables:** `snake_case`
- **Constants:** `UPPER_SNAKE_CASE`
- **Private members:** `_leading_underscore`

### Error Handling
- Use specific exception types, never bare `except:`
- Provide helpful error messages with context
- Never silently fail
- Chain exceptions with `from e`

### Async Patterns
- Use `async/await` consistently
- Mark tests with `@pytest.mark.asyncio`
- pytest.ini has `asyncio_mode = auto`

### Critical Anti-Pattern: Memory Field Access
```python
# ❌ WRONG - metadata dict access
memory.metadata.get('tags', [])

# ✅ CORRECT - direct attribute access
memory.tags
memory.memory_type
memory.content_hash
```

## Storage Backends

| Backend | Performance | Use Case |
|---------|-------------|----------|
| **Hybrid** | Fast (5ms read) | Production (Recommended) |
| **SQLite-Vec** | Fast (5ms read) | Development, single-user local |
| **Cloudflare** | Network dependent | Cloud-only deployment |

**Hybrid**: SQLite-vec local + Cloudflare background sync. Best of both worlds.

### Database Lock Prevention
```bash
# Add to .env, then RESTART all servers
MCP_MEMORY_SQLITE_PRAGMAS=busy_timeout=15000,cache_size=20000
```

### Graph Table (v8.51.0+)
- Graph associations are LOCAL-ONLY (not synced to Cloudflare)
- Derived data — can be reconstructed from memory metadata
- Cluster summaries DO sync to Cloudflare

## Quality System

```bash
# Local-first defaults (no cloud key required)
MCP_QUALITY_SYSTEM_ENABLED=true
MCP_QUALITY_AI_PROVIDER=local
MCP_QUALITY_LOCAL_MODEL=nvidia-quality-classifier-deberta

# Quality-boosted search
MCP_QUALITY_BOOST_ENABLED=true
MCP_QUALITY_BOOST_WEIGHT=0.3
```

The quality system uses a local DeBERTa model (no cloud key required). Quality scores range 0-1, with mean ~0.60-0.70.

**MCP Tools:** `memory_service_memory_quality` for rating, getting, analyzing quality.

## Consolidation System

Acts like dream-inspired memory optimization:
- Exponential decay scoring
- Creative association discovery
- Semantic clustering (DBSCAN)
- Compression and controlled forgetting

**API Endpoints:**
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/consolidation/trigger` | POST | Trigger consolidation |
| `/api/consolidation/status` | GET | Scheduler status |

**MCP Tool:** `memory-service_memory_consolidate` for run/status/recommend/scheduler operations.

## Code Quality Workflow

Three-layer QA:
1. **Pre-commit** (<5s): Complexity checks, security scan
2. **PR Quality Gate** (10-60s): Standard + comprehensive checks
3. **Periodic Review** (Weekly): Full codebase analysis

**Release Blocker** (Health Score <50): Cannot merge or create release.

## Refactoring Safety Checklist

When extracting, moving, or refactoring code:
1. Validate import paths from new location
2. Check response format compatibility (handler keys match service keys)
3. Create integration tests BEFORE committing
4. Coverage must not decrease (≥80%)
5. Run pre-commit validation before every refactoring commit
6. Commit incrementally (one extraction per commit)

## Commit Messages (Semantic)
```
feat: add memory export functionality
fix: resolve timezone handling in memory search
docs: update installation guide for Windows
test: add coverage for storage backends
refactor: extract handler logic from server_impl
perf: optimize vector search caching
```

## Project Structure
```
src/mcp_memory_service/
├── server/           # MCP server layer
├── server_impl.py    # Main MCP handlers
├── storage/          # Storage backends (Strategy Pattern)
├── web/              # FastAPI dashboard + REST API
├── services/         # Business logic orchestrator
├── quality/          # AI quality scoring
├── consolidation/    # Memory maintenance
├── embeddings/       # ONNX embeddings
├── ingestion/        # Document loaders
├── models/           # Data models
└── utils/            # Utilities
```
