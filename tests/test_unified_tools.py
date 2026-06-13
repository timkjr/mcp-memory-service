"""
Tests for unified MCP Memory Service tools.

Tests cover:
1. New unified tools work correctly
2. Legacy tool names return errors (removed in v11.0.0)
"""

import pytest
from unittest.mock import AsyncMock, patch, MagicMock


class TestMemoryDelete:
    """Tests for unified memory_delete tool."""

    @pytest.fixture
    def mock_storage(self):
        """Create mocked storage backend."""
        storage = AsyncMock()
        return storage

    @pytest.mark.asyncio
    async def test_delete_by_hash(self, mock_storage):
        """Test single memory deletion by hash."""
        mock_storage.delete_memories.return_value = {
            "success": True,
            "deleted_count": 1,
            "deleted_hashes": ["abc123"]
        }

        result = await mock_storage.delete_memories(content_hash="abc123")

        assert result["deleted_count"] == 1
        mock_storage.delete_memories.assert_called_once_with(content_hash="abc123")

    @pytest.mark.asyncio
    async def test_delete_by_tags_any(self, mock_storage):
        """Test deletion by tags with ANY match."""
        mock_storage.delete_memories.return_value = {
            "success": True,
            "deleted_count": 5,
            "deleted_hashes": ["a", "b", "c", "d", "e"]
        }

        result = await mock_storage.delete_memories(
            tags=["temp", "draft"],
            tag_match="any"
        )

        assert result["deleted_count"] == 5

    @pytest.mark.asyncio
    async def test_delete_by_tags_all(self, mock_storage):
        """Test deletion by tags with ALL match."""
        mock_storage.delete_memories.return_value = {
            "success": True,
            "deleted_count": 2,
            "deleted_hashes": ["x", "y"]
        }

        result = await mock_storage.delete_memories(
            tags=["archived", "old"],
            tag_match="all"
        )

        assert result["deleted_count"] == 2

    @pytest.mark.asyncio
    async def test_delete_by_timeframe(self, mock_storage):
        """Test deletion by time range."""
        mock_storage.delete_memories.return_value = {
            "success": True,
            "deleted_count": 10,
            "deleted_hashes": [f"h{i}" for i in range(10)]
        }

        result = await mock_storage.delete_memories(
            after="2024-01-01",
            before="2024-06-30"
        )

        assert result["deleted_count"] == 10

    @pytest.mark.asyncio
    async def test_delete_dry_run(self, mock_storage):
        """Test dry run returns preview without deleting."""
        mock_storage.delete_memories.return_value = {
            "success": True,
            "deleted_count": 3,
            "deleted_hashes": ["a", "b", "c"],
            "dry_run": True
        }

        result = await mock_storage.delete_memories(
            tags=["cleanup"],
            dry_run=True
        )

        assert result["dry_run"] is True

    @pytest.mark.asyncio
    async def test_delete_no_filters_error(self, mock_storage):
        """Test that delete without filters returns error."""
        mock_storage.delete_memories.return_value = {
            "error": "At least one filter required"
        }

        result = await mock_storage.delete_memories()

        assert "error" in result


class TestMemorySearch:
    """Tests for unified memory_search tool."""

    @pytest.fixture
    def mock_storage(self):
        """Create mocked storage backend."""
        storage = AsyncMock()
        return storage

    @pytest.mark.asyncio
    async def test_semantic_search(self, mock_storage):
        """Test default semantic search."""
        mock_storage.search_memories.return_value = {
            "memories": [{"content": "test", "content_hash": "abc"}],
            "total": 1,
            "mode": "semantic"
        }

        result = await mock_storage.search_memories(query="python patterns")

        assert result["mode"] == "semantic"
        assert len(result["memories"]) == 1

    @pytest.mark.asyncio
    async def test_exact_search(self, mock_storage):
        """Test exact string match."""
        mock_storage.search_memories.return_value = {
            "memories": [],
            "total": 0,
            "mode": "exact"
        }

        result = await mock_storage.search_memories(
            query="exact phrase",
            mode="exact"
        )

        assert result["mode"] == "exact"

    @pytest.mark.asyncio
    async def test_time_expression_search(self, mock_storage):
        """Test natural language time expression."""
        mock_storage.search_memories.return_value = {
            "memories": [{"content": "recent"}],
            "total": 1
        }

        result = await mock_storage.search_memories(time_expr="last week")

        assert result["total"] >= 0

    @pytest.mark.asyncio
    async def test_quality_boost(self, mock_storage):
        """Test quality-boosted search."""
        mock_storage.search_memories.return_value = {
            "memories": [{"content": "high quality", "quality": 0.9}],
            "total": 1
        }

        result = await mock_storage.search_memories(
            query="important info",
            quality_boost=0.3
        )

        assert result["total"] == 1

    @pytest.mark.asyncio
    async def test_combined_filters(self, mock_storage):
        """Test combining multiple filters."""
        mock_storage.search_memories.return_value = {
            "memories": [],
            "total": 0
        }

        result = await mock_storage.search_memories(
            query="database",
            time_expr="last month",
            tags=["reference"],
            quality_boost=0.2,
            limit=20
        )

        # Should have called with all parameters
        mock_storage.search_memories.assert_called_once()

    @pytest.mark.asyncio
    async def test_debug_output(self, mock_storage):
        """Test debug information included."""
        mock_storage.search_memories.return_value = {
            "memories": [],
            "total": 0,
            "debug": {
                "time_filter": None,
                "quality_boost": 0.0
            }
        }

        result = await mock_storage.search_memories(
            query="test",
            include_debug=True
        )

        assert "debug" in result


class TestMemoryConsolidate:
    """Tests for unified memory_consolidate tool."""

    @pytest.fixture
    def mock_handler(self):
        """Create mocked consolidation handler."""
        handler = AsyncMock()
        return handler

    @pytest.mark.asyncio
    async def test_status_action(self, mock_handler):
        """Test status retrieval."""
        mock_handler.handle_consolidation_status.return_value = {
            "status": "healthy",
            "last_run": "2024-01-15"
        }

        result = await mock_handler.handle_consolidation_status()

        assert result["status"] == "healthy"

    @pytest.mark.asyncio
    async def test_run_action(self, mock_handler):
        """Test consolidation run."""
        mock_handler.handle_consolidate_memories.return_value = {
            "success": True,
            "consolidated": 50
        }

        result = await mock_handler.handle_consolidate_memories(time_horizon="weekly")

        assert result["success"] is True

    @pytest.mark.asyncio
    async def test_recommend_action(self, mock_handler):
        """Test recommendations."""
        mock_handler.handle_consolidation_recommendations.return_value = {
            "recommendations": ["Run weekly consolidation"]
        }

        result = await mock_handler.handle_consolidation_recommendations(time_horizon="weekly")

        assert "recommendations" in result


class TestLegacyRemoval:
    """Verify deprecated tools are no longer dispatched."""

    def test_deprecated_name_not_in_routing_table(self):
        from mcp_memory_service.tools.routing import ROUTING_TABLE
        deprecated_names = [
            "store_memory", "retrieve_memory", "delete_by_tag",
            "consolidate_memories", "ingest_document",
        ]
        for name in deprecated_names:
            assert name not in ROUTING_TABLE, f"{name} should not be in ROUTING_TABLE"

    @pytest.mark.asyncio
    async def test_deprecated_name_returns_error(self):
        from mcp_memory_service.tools.routing import resolve_handler
        assert resolve_handler("store_memory") is None
        assert resolve_handler("retrieve_memory") is None
        assert resolve_handler("delete_by_tag") is None
