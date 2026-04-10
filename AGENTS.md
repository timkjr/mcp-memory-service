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

# Development Guide

## Quick Setup

```bash
python install.py                 # Auto-detects platform, installs deps
pip install -e ".[dev]"           # Editable install with dev deps
pytest                            # Run all tests
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
pytest --cov=src/mcp_memory_service --cov-report=html  # HTML coverage report
pytest -v -s                      # Verbose with print output
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
# Order: stdlib → third-party → local
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

```python
async def process_memory(content: str) -> Dict[str, Any]:
    """Process and store memory content.

    Args:
        content: The memory content to process

    Returns:
        Dictionary containing memory metadata
    """
```

### Naming Conventions
- **Modules/files:** `snake_case.py`
- **Classes:** `PascalCase`
- **Functions/variables:** `snake_case`
- **Constants:** `UPPER_SNAKE_CASE`
- **Private members:** `_leading_underscore`

### Error Handling
- Use specific exception types, never bare `except:`
- Provide helpful error messages with context
- Log errors appropriately
- Never silently fail
- Chain exceptions with `from e`

```python
try:
    result = await storage.store(memory)
except StorageError as e:
    logger.error(f"Failed to store memory: {e}")
    raise MemoryServiceError(f"Storage operation failed: {e}") from e
```

### Docstrings
- **Style:** Google format
- **Required on:** All public functions, classes, and methods
- Include Args, Returns, Raises sections

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
