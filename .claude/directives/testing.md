# Test Architecture

## Structure (~2,400+ tests across ~216 files)

```
tests/
├── api/              # API layer tests (compact types, operations)
├── storage/          # Backend-specific tests (sqlite_vec, cloudflare, hybrid)
├── server/           # MCP server handler tests
├── consolidation/    # Memory maintenance tests
├── quality/          # Quality scoring tests
├── web/              # HTTP API and OAuth tests
├── conftest.py       # Shared fixtures
└── pytest.ini        # Test configuration
```

## Key Fixtures (`conftest.py`)

- **`temp_db_path`** — Temporary database directory (auto-cleanup)
- **`unique_content`** — Generate unique test content to avoid duplicates
- **`test_store`** — Auto-tags memories with `__test__` for cleanup
- **`TEST_MEMORY_TAG = "__test__"`** — Reserved tag for automatic test cleanup

## Test Safety (CRITICAL — PR #438)

**Triple Safety System** prevents production database deletion:
1. `conftest.py` creates an isolated temp directory with `mcp-test-` prefix at module import time
2. `pytest_sessionstart` aborts the run if a production path is detected
3. `pytest_sessionfinish` validates temp location + no production indicators + test markers present

**Backend Isolation:** Tests automatically override `MCP_MEMORY_STORAGE_BACKEND` to `sqlite_vec` unless `MCP_TEST_ALLOW_CLOUD_BACKEND=true`.

**Incident history:** Feb 8, 2026 — Test cleanup deleted 8,663 production memories. Resolved via emergency backup recovery + safeguards in PR #438.

## Test Markers

```python
@pytest.mark.unit         # Fast unit tests
@pytest.mark.integration  # Integration tests (require storage)
@pytest.mark.performance  # Performance benchmarks
@pytest.mark.asyncio      # Async tests (auto-detected)
```

## Running Tests

```bash
.venv/bin/pytest                          # All tests
.venv/bin/pytest -m unit                  # Fast only
.venv/bin/pytest -m integration           # Require storage
.venv/bin/pytest -m performance           # Benchmarks
.venv/bin/pytest -k "test_store"          # Name pattern
.venv/bin/pytest --cov=src/mcp_memory_service --cov-report=html
```
