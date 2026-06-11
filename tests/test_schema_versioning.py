"""Tests for schema versioning and migration registry."""

import hashlib
import sqlite3
import tempfile
from pathlib import Path

import pytest


@pytest.fixture
def migrations_dir(tmp_path):
    """Create a temporary migrations directory with test migration files."""
    d = tmp_path / "migrations"
    d.mkdir()
    (d / "008_add_graph_table.sql").write_text(
        "CREATE TABLE IF NOT EXISTS memory_graph (\n"
        "    source_hash TEXT NOT NULL,\n"
        "    target_hash TEXT NOT NULL,\n"
        "    PRIMARY KEY (source_hash, target_hash)\n"
        ")"
    )
    (d / "009_add_relationship_type.sql").write_text(
        "ALTER TABLE memory_graph ADD COLUMN relationship_type TEXT"
    )
    (d / "010_add_index.sql").write_text(
        "CREATE INDEX IF NOT EXISTS idx_graph_source ON memory_graph(source_hash)"
    )
    (d / "011_add_metadata.sql").write_text(
        "ALTER TABLE memory_graph ADD COLUMN metadata TEXT"
    )
    return d


@pytest.fixture
def db_conn():
    """Create an in-memory SQLite database with metadata table."""
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    return conn


@pytest.fixture
def runner(migrations_dir):
    from mcp_memory_service.storage.migration_runner import MigrationRunner
    return MigrationRunner(migrations_dir)


class TestMigrationDiscovery:
    def test_discovers_all_migrations(self, runner, migrations_dir):
        migrations = runner._discover_migrations()
        assert len(migrations) == 4
        assert migrations[0][0] == 8
        assert migrations[1][0] == 9
        assert migrations[2][0] == 10
        assert migrations[3][0] == 11

    def test_ignores_non_matching_files(self, runner, migrations_dir):
        (migrations_dir / "README.md").write_text("not a migration")
        (migrations_dir / "backup.sql").write_text("not numbered")
        migrations = runner._discover_migrations()
        assert len(migrations) == 4


class TestFreshDatabase:
    def test_all_migrations_applied(self, runner, db_conn):
        result = runner.run_pending(db_conn)
        assert result["error"] is None
        assert len(result["applied"]) == 4
        assert len(result["skipped"]) == 0

    def test_registry_populated(self, runner, db_conn):
        runner.run_pending(db_conn)
        cursor = db_conn.execute("SELECT version, name FROM migration_registry ORDER BY version")
        rows = cursor.fetchall()
        assert len(rows) == 4
        assert rows[0] == (8, "add_graph_table")
        assert rows[3] == (11, "add_metadata")

    def test_version_updated_to_latest(self, runner, db_conn):
        runner.run_pending(db_conn)
        assert runner._get_current_version(db_conn) == 11

    def test_checksum_stored(self, runner, db_conn, migrations_dir):
        runner.run_pending(db_conn)
        cursor = db_conn.execute("SELECT checksum FROM migration_registry WHERE version=8")
        stored = cursor.fetchone()[0]
        expected = hashlib.sha256(
            (migrations_dir / "008_add_graph_table.sql").read_text().encode()
        ).hexdigest()
        assert stored == expected


class TestExistingDatabase:
    def test_version_7_runs_all(self, runner, db_conn):
        """Existing DB with version 7 (pre-migration era) runs all migrations."""
        db_conn.execute("INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '7')")
        result = runner.run_pending(db_conn)
        assert result["error"] is None
        assert len(result["applied"]) == 4

    def test_already_up_to_date(self, runner, db_conn):
        """Running twice applies nothing the second time."""
        runner.run_pending(db_conn)
        result = runner.run_pending(db_conn)
        assert result["error"] is None
        assert len(result["applied"]) == 0
        assert len(result["skipped"]) == 4

    def test_existing_db_no_registry_stamps_baseline(self, runner, db_conn):
        """Existing DB with 008-011 artifacts but no registry → stamp without re-executing."""
        # Simulate a DB where the old idempotent runner already applied 008-011
        db_conn.execute("""
            CREATE TABLE memory_graph (
                source_hash TEXT NOT NULL,
                target_hash TEXT NOT NULL,
                relationship_type TEXT,
                metadata TEXT,
                PRIMARY KEY (source_hash, target_hash)
            )
        """)
        db_conn.execute("CREATE INDEX IF NOT EXISTS idx_graph_source ON memory_graph(source_hash)")
        # 011 adds 'version' column to memories — simulate it exists
        db_conn.execute("CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT, version INTEGER)")
        db_conn.execute("INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '7')")
        db_conn.commit()

        # run_pending should stamp 008-011 and NOT re-execute them
        result = runner.run_pending(db_conn)
        assert result["error"] is None
        assert len(result["applied"]) == 0  # Nothing actually executed
        assert len(result["skipped"]) == 4  # All stamped → skipped

        # Registry should have all 4 stamped
        cursor = db_conn.execute("SELECT version FROM migration_registry ORDER BY version")
        versions = [r[0] for r in cursor.fetchall()]
        assert versions == [8, 9, 10, 11]

    def test_stamp_baseline_noop_when_registry_populated(self, runner, db_conn):
        """If registry already has entries, _stamp_baseline does nothing."""
        runner.run_pending(db_conn)  # Normal run populates registry
        # Call stamp directly — should return empty
        stamped = runner._stamp_baseline(db_conn)
        assert stamped == []


class TestCheckDiagnosis:
    def test_healthy_after_all_applied(self, runner, db_conn):
        runner.run_pending(db_conn)
        report = runner.check(db_conn)
        assert report["healthy"] is True
        assert report["current_version"] == 11
        assert len(report["pending"]) == 0

    def test_pending_detected(self, runner, db_conn):
        report = runner.check(db_conn)
        assert report["healthy"] is False
        assert len(report["pending"]) == 4

    def test_checksum_mismatch_detected(self, runner, db_conn, migrations_dir):
        runner.run_pending(db_conn)
        # Tamper with a migration file
        (migrations_dir / "008_add_graph_table.sql").write_text("-- tampered")
        report = runner.check(db_conn)
        assert report["healthy"] is False
        assert len(report["checksum_mismatches"]) == 1
        assert report["checksum_mismatches"][0]["version"] == 8

    def test_check_on_readonly_db(self, runner, tmp_path):
        """check() works on a read-only connection."""
        db_path = tmp_path / "test.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        conn.execute("INSERT INTO metadata (key, value) VALUES ('schema_version', '7')")
        conn.commit()
        conn.close()

        ro_conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        report = runner.check(ro_conn)
        ro_conn.close()

        assert report["current_version"] == 7
        assert len(report["pending"]) == 4


class TestRegistryGapDetection:
    def test_half_applied_detectable(self, runner, db_conn):
        """Simulate partial application (only first 2 migrations in registry)."""
        runner._ensure_registry_table(db_conn)
        # Manually insert only first 2 migrations as applied
        db_conn.execute(
            "INSERT INTO migration_registry (version, name, filename, applied_at, checksum) VALUES (8, 'add_graph_table', '008_add_graph_table.sql', '2024-01-01T00:00:00', 'x')"
        )
        db_conn.execute(
            "INSERT INTO migration_registry (version, name, filename, applied_at, checksum) VALUES (9, 'add_relationship_type', '009_add_relationship_type.sql', '2024-01-01T00:00:00', 'x')"
        )
        # Need the table to exist for migration 009's ALTER TABLE to have worked
        db_conn.execute("CREATE TABLE IF NOT EXISTS memory_graph (source_hash TEXT, target_hash TEXT, relationship_type TEXT, PRIMARY KEY (source_hash, target_hash))")
        db_conn.execute("INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '9')")
        db_conn.commit()

        result = runner.run_pending(db_conn)
        assert result["error"] is None
        assert len(result["applied"]) == 2  # 010 and 011
        assert len(result["skipped"]) == 2  # 008 and 009


class TestDryRun:
    def test_dry_run_no_writes(self, runner, db_conn):
        result = runner.run_pending(db_conn, dry_run=True)
        assert len(result["applied"]) == 4
        # Verify nothing was written
        cursor = db_conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='migration_registry'"
        )
        assert cursor.fetchone() is None


class TestTransactionSafety:
    def test_failed_migration_rolls_back(self, tmp_path):
        """A failing migration should not leave partial state."""
        from mcp_memory_service.storage.migration_runner import MigrationRunner

        d = tmp_path / "migrations"
        d.mkdir()
        (d / "008_good.sql").write_text("CREATE TABLE test_table (id INTEGER PRIMARY KEY)")
        (d / "009_bad.sql").write_text("ALTER TABLE nonexistent_table ADD COLUMN x TEXT")

        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")

        runner = MigrationRunner(d)
        result = runner.run_pending(conn)

        assert result["error"] is not None
        assert "009" in result["error"]
        assert len(result["applied"]) == 1  # Only 008 succeeded
        # Version should be 8 (last successful)
        assert runner._get_current_version(conn) == 8


class TestCLICommands:
    def _create_test_db(self, db_path):
        """Create a test DB with the base schema (pre-migration era)."""
        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        conn.execute("INSERT INTO metadata (key, value) VALUES ('schema_version', '7')")
        conn.execute("""
            CREATE TABLE memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content_hash TEXT UNIQUE NOT NULL,
                content TEXT NOT NULL,
                tags TEXT,
                memory_type TEXT,
                metadata TEXT,
                created_at REAL,
                updated_at REAL,
                created_at_iso TEXT,
                updated_at_iso TEXT,
                deleted_at REAL DEFAULT NULL
            )
        """)
        conn.commit()
        conn.close()

    def test_check_db_command(self, tmp_path):
        """Test that check-db CLI command works."""
        from click.testing import CliRunner
        from mcp_memory_service.cli.main import cli

        db_path = tmp_path / "test.db"
        self._create_test_db(db_path)

        cli_runner = CliRunner()
        result = cli_runner.invoke(cli, ["check-db", "--db-path", str(db_path)])
        assert "Current version: 7" in result.output
        assert result.exit_code == 1  # pending migrations

    def test_migrate_command(self, tmp_path):
        """Test that migrate CLI command works."""
        from click.testing import CliRunner
        from mcp_memory_service.cli.main import cli

        db_path = tmp_path / "test.db"
        self._create_test_db(db_path)

        cli_runner = CliRunner()
        result = cli_runner.invoke(cli, ["migrate", "--db-path", str(db_path)])
        assert result.exit_code == 0, f"Output: {result.output}"
        assert "Schema is up-to-date" in result.output

    def test_migrate_dry_run(self, tmp_path):
        """Test that migrate --dry-run doesn't write."""
        from click.testing import CliRunner
        from mcp_memory_service.cli.main import cli

        db_path = tmp_path / "test.db"
        self._create_test_db(db_path)

        cli_runner = CliRunner()
        result = cli_runner.invoke(cli, ["migrate", "--dry-run", "--db-path", str(db_path)])
        assert "[DRY RUN]" in result.output
        assert result.exit_code == 0

        # Verify nothing was written
        conn = sqlite3.connect(str(db_path))
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='migration_registry'"
        )
        assert cursor.fetchone() is None
        conn.close()
