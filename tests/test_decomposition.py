"""Tests for §10 — sqlite_vec.py decomposition into mixins (TDD-first RED)."""

import pytest


EXPECTED_MIXINS = [
    "BaseMixin",
    "MigrationsMixin",
    "EmbeddingsMixin",
    "StoreMixin",
    "RetrieveMixin",
    "HybridMixin",
    "DeleteMixin",
    "MetadataMixin",
]


class TestDecomposition:
    """Verify mixin structure after decomposition."""

    def test_mixins_package_exists(self):
        import mcp_memory_service.storage.mixins
        assert mcp_memory_service.storage.mixins is not None

    def test_all_mixins_importable(self):
        from mcp_memory_service.storage.mixins import (
            BaseMixin,
            MigrationsMixin,
            EmbeddingsMixin,
            StoreMixin,
            RetrieveMixin,
            HybridMixin,
            DeleteMixin,
            MetadataMixin,
        )
        for name, cls in [
            ("BaseMixin", BaseMixin),
            ("MigrationsMixin", MigrationsMixin),
            ("EmbeddingsMixin", EmbeddingsMixin),
            ("StoreMixin", StoreMixin),
            ("RetrieveMixin", RetrieveMixin),
            ("HybridMixin", HybridMixin),
            ("DeleteMixin", DeleteMixin),
            ("MetadataMixin", MetadataMixin),
        ]:
            assert cls is not None, f"{name} not importable"

    def test_storage_class_inherits_all_mixins(self):
        from mcp_memory_service.storage.sqlite_vec import SqliteVecMemoryStorage
        from mcp_memory_service.storage.mixins import (
            BaseMixin,
            MigrationsMixin,
            EmbeddingsMixin,
            StoreMixin,
            RetrieveMixin,
            HybridMixin,
            DeleteMixin,
            MetadataMixin,
        )
        for mixin in [BaseMixin, MigrationsMixin, EmbeddingsMixin, StoreMixin,
                      RetrieveMixin, HybridMixin, DeleteMixin, MetadataMixin]:
            assert issubclass(SqliteVecMemoryStorage, mixin), \
                f"SqliteVecMemoryStorage does not inherit from {mixin.__name__}"

    def test_public_interface_preserved(self):
        """All MemoryStorage ABC methods must still exist."""
        from mcp_memory_service.storage.sqlite_vec import SqliteVecMemoryStorage
        required_methods = [
            "initialize", "store", "store_batch", "retrieve",
            "retrieve_hybrid", "search_by_tag", "delete",
            "delete_by_tag", "update_memory_metadata",
            "get_all_memories", "cleanup_duplicates",
        ]
        for method in required_methods:
            assert hasattr(SqliteVecMemoryStorage, method), \
                f"Missing public method: {method}"

    def test_backward_compat_import(self):
        """Existing import path must still work."""
        from mcp_memory_service.storage.sqlite_vec import SqliteVecMemoryStorage
        assert SqliteVecMemoryStorage is not None
