"""Unit tests for MigrationRunner.

Tests the versioned SQL migration runner with registry tracking.
"""

import sqlite3
from pathlib import Path

import pytest

from mcp_memory_service.storage.migration_runner import MigrationRunner


@pytest.fixture
def setup_migrations(tmp_path):
    """Create a migrations directory with test files and a DB connection."""
    migrations_dir = tmp_path / "migrations"
    migrations_dir.mkdir()

    (migrations_dir / "001_first.sql").write_text(
        "CREATE TABLE IF NOT EXISTS first_table (id INTEGER PRIMARY KEY);"
    )
    (migrations_dir / "002_second.sql").write_text(
        "CREATE TABLE IF NOT EXISTS second_table (id INTEGER);"
    )

    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    return migrations_dir, conn


@pytest.mark.unit
def test_migration_runner_sync_executes_sql_files(setup_migrations):
    """Test that migration runner executes SQL files."""
    migrations_dir, conn = setup_migrations

    runner = MigrationRunner(migrations_dir)
    result = runner.run_pending(conn)

    assert result["error"] is None
    assert len(result["applied"]) == 2

    # Verify table was created
    cursor = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='first_table'"
    )
    assert cursor.fetchone() is not None


@pytest.mark.unit
def test_migration_runner_sync_multiple_files(setup_migrations):
    """Test that migration runner executes multiple files in order."""
    migrations_dir, conn = setup_migrations

    runner = MigrationRunner(migrations_dir)
    result = runner.run_pending(conn)

    assert result["error"] is None
    assert len(result["applied"]) == 2

    # Verify both tables were created
    cursor = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )
    table_names = [row[0] for row in cursor.fetchall()]
    assert "first_table" in table_names
    assert "second_table" in table_names


@pytest.mark.unit
def test_migration_runner_sync_invalid_sql(tmp_path):
    """Test that migration runner handles invalid SQL gracefully."""
    migrations_dir = tmp_path / "migrations"
    migrations_dir.mkdir()
    (migrations_dir / "001_invalid.sql").write_text("INVALID SQL STATEMENT;")

    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")

    runner = MigrationRunner(migrations_dir)
    result = runner.run_pending(conn)

    assert result["error"] is not None


@pytest.mark.unit
def test_migration_runner_sync_idempotent(setup_migrations):
    """Test that migrations are idempotent (can run multiple times)."""
    migrations_dir, conn = setup_migrations

    runner = MigrationRunner(migrations_dir)

    # Run first time
    result1 = runner.run_pending(conn)
    assert result1["error"] is None
    assert len(result1["applied"]) == 2

    # Run second time (should skip all)
    result2 = runner.run_pending(conn)
    assert result2["error"] is None
    assert len(result2["applied"]) == 0
    assert len(result2["skipped"]) == 2
