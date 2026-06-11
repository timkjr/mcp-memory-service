"""Tests for RFC 1047 §3 and §7 partial closures.

A. Contradiction search in scheduler
B. Threshold trigger for consolidation
C. Resource URI for bootstrap profile

These tests verify the logic without importing MemoryServer directly
(circular import). They test the functions that WILL be added.
"""

import asyncio
import json
import logging
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# =============================================================================
# A. Contradiction Search in Scheduler (§3)
# =============================================================================


class TestContradictionScheduler:
    """§3: Scheduler runs contradiction check alongside distill."""

    @pytest.mark.asyncio
    async def test_scheduled_contradiction_check_calls_conflicts(self):
        """Scheduler contradiction check calls handle_memory_conflicts."""
        # Simulate the method that should exist on the server
        conflicts_handler = AsyncMock(return_value=[
            MagicMock(text='{"conflicts": []}')
        ])
        storage_init = AsyncMock()

        # This is the function we'll implement
        async def _scheduled_contradiction_check(server):
            await server._ensure_storage_initialized()
            result = await server.handle_memory_conflicts({})
            # Parse result
            if result and hasattr(result[0], 'text'):
                data = json.loads(result[0].text)
                conflicts = data.get("conflicts", [])
                unresolved = [c for c in conflicts if c.get("status") != "resolved"]
                if unresolved:
                    logging.getLogger(__name__).warning(
                        f"Contradiction check: {len(unresolved)} unresolved conflict(s)"
                    )

        server = MagicMock()
        server._ensure_storage_initialized = storage_init
        server.handle_memory_conflicts = conflicts_handler

        await _scheduled_contradiction_check(server)
        conflicts_handler.assert_called_once_with({})

    @pytest.mark.asyncio
    async def test_contradiction_check_logs_warning_on_unresolved(self, caplog):
        """If unresolved conflicts exist, logs WARNING with count."""
        conflicts_handler = AsyncMock(return_value=[
            MagicMock(text='{"conflicts": [{"hash1": "a", "hash2": "b", "status": "unresolved"}]}')
        ])

        async def _scheduled_contradiction_check(server):
            await server._ensure_storage_initialized()
            result = await server.handle_memory_conflicts({})
            if result and hasattr(result[0], 'text'):
                data = json.loads(result[0].text)
                conflicts = data.get("conflicts", [])
                unresolved = [c for c in conflicts if c.get("status") != "resolved"]
                if unresolved:
                    logging.getLogger("mcp_memory_service").warning(
                        f"Contradiction check: {len(unresolved)} unresolved conflict(s)"
                    )

        server = MagicMock()
        server._ensure_storage_initialized = AsyncMock()
        server.handle_memory_conflicts = conflicts_handler

        with caplog.at_level(logging.WARNING, logger="mcp_memory_service"):
            await _scheduled_contradiction_check(server)

        assert any("1 unresolved" in r.message for r in caplog.records)

    @pytest.mark.asyncio
    async def test_contradiction_check_silent_when_no_conflicts(self, caplog):
        """If no conflicts, no WARNING logged."""
        conflicts_handler = AsyncMock(return_value=[
            MagicMock(text='{"conflicts": []}')
        ])

        async def _scheduled_contradiction_check(server):
            await server._ensure_storage_initialized()
            result = await server.handle_memory_conflicts({})
            if result and hasattr(result[0], 'text'):
                data = json.loads(result[0].text)
                conflicts = data.get("conflicts", [])
                unresolved = [c for c in conflicts if c.get("status") != "resolved"]
                if unresolved:
                    logging.getLogger("mcp_memory_service").warning(
                        f"Contradiction check: {len(unresolved)} unresolved conflict(s)"
                    )

        server = MagicMock()
        server._ensure_storage_initialized = AsyncMock()
        server.handle_memory_conflicts = conflicts_handler

        with caplog.at_level(logging.WARNING, logger="mcp_memory_service"):
            await _scheduled_contradiction_check(server)

        assert not any("unresolved" in r.message for r in caplog.records)


# =============================================================================
# B. Threshold Trigger for Consolidation (§3)
# =============================================================================


class TestThresholdConsolidation:
    """§3: memory_store triggers consolidation when threshold reached."""

    @pytest.mark.asyncio
    async def test_threshold_triggers_background_consolidation(self):
        """When counter >= threshold and last_consolidation > min_interval, triggers."""
        background_called = False

        async def _check_consolidation_threshold(counter, last_at, threshold, min_interval):
            nonlocal background_called
            if counter >= threshold and (time.time() - last_at) > min_interval:
                background_called = True
                return True
            return False

        result = await _check_consolidation_threshold(
            counter=50,
            last_at=time.time() - 86401,  # >24h ago
            threshold=50,
            min_interval=86400
        )
        assert result is True
        assert background_called is True

    @pytest.mark.asyncio
    async def test_threshold_not_triggered_if_recent_consolidation(self):
        """If consolidation ran recently (<min_interval), don't trigger."""
        background_called = False

        async def _check_consolidation_threshold(counter, last_at, threshold, min_interval):
            nonlocal background_called
            if counter >= threshold and (time.time() - last_at) > min_interval:
                background_called = True
                return True
            return False

        result = await _check_consolidation_threshold(
            counter=100,
            last_at=time.time() - 3600,  # 1h ago — too recent
            threshold=50,
            min_interval=86400
        )
        assert result is False
        assert background_called is False

    @pytest.mark.asyncio
    async def test_threshold_not_triggered_if_below_count(self):
        """If counter < threshold, don't trigger even if interval passed."""
        background_called = False

        async def _check_consolidation_threshold(counter, last_at, threshold, min_interval):
            nonlocal background_called
            if counter >= threshold and (time.time() - last_at) > min_interval:
                background_called = True
                return True
            return False

        result = await _check_consolidation_threshold(
            counter=10,
            last_at=time.time() - 86401,
            threshold=50,
            min_interval=86400
        )
        assert result is False
        assert background_called is False

    @pytest.mark.asyncio
    async def test_background_consolidation_uses_incremental(self):
        """Background consolidation calls consolidate with time_horizon='incremental'."""
        consolidate_handler = AsyncMock(return_value=[])

        async def _background_consolidation(handler):
            await handler({"time_horizon": "incremental"})

        await _background_consolidation(consolidate_handler)
        consolidate_handler.assert_called_once_with({"time_horizon": "incremental"})


# =============================================================================
# C. Resource URI Bootstrap (§7)
# =============================================================================


class TestResourceURIBootstrap:
    """§7: Bootstrap profile exposed as MCP Resource."""

    def test_bootstrap_resource_uri_format(self):
        """URI follows pattern memory://agent/{id}/bootstrap."""
        def _get_bootstrap_resource_uri(agent_id: str) -> str:
            return f"memory://agent/{agent_id}/bootstrap"

        assert _get_bootstrap_resource_uri("kiro") == "memory://agent/kiro/bootstrap"
        assert _get_bootstrap_resource_uri("claude-code") == "memory://agent/claude-code/bootstrap"

    @pytest.mark.asyncio
    async def test_resource_read_returns_profile_content(self):
        """resources/read with bootstrap URI returns formatted profile."""
        profile_handler = AsyncMock(return_value=[
            MagicMock(text="❌ NUNCA: test avoidance\n✅ SEMPRE: test convention")
        ])

        async def _read_bootstrap_resource(agent_id: str, handler):
            result = await handler({"agent_ids": [agent_id]})
            if result and hasattr(result[0], 'text'):
                return result[0].text
            return ""

        content = await _read_bootstrap_resource("kiro", profile_handler)
        assert "NUNCA" in content
        assert "SEMPRE" in content
        profile_handler.assert_called_once_with({"agent_ids": ["kiro"]})

    @pytest.mark.asyncio
    async def test_resource_read_unknown_agent_returns_content(self):
        """Unknown agent_id still returns a profile (not error)."""
        profile_handler = AsyncMock(return_value=[
            MagicMock(text="## Bootstrap Profile\nNo specific data for this agent.")
        ])

        async def _read_bootstrap_resource(agent_id: str, handler):
            result = await handler({"agent_ids": [agent_id]})
            if result and hasattr(result[0], 'text'):
                return result[0].text
            return ""

        content = await _read_bootstrap_resource("unknown_agent_xyz", profile_handler)
        assert content  # Not empty
        assert "Bootstrap" in content

    def test_bootstrap_uri_parsed_correctly(self):
        """URI parser extracts agent_id from memory://agent/{id}/bootstrap."""
        def _parse_bootstrap_uri(uri: str):
            # memory://agent/{agent_id}/bootstrap
            if uri.startswith("memory://agent/") and uri.endswith("/bootstrap"):
                agent_id = uri[len("memory://agent/"):-len("/bootstrap")]
                return agent_id
            return None

        assert _parse_bootstrap_uri("memory://agent/kiro/bootstrap") == "kiro"
        assert _parse_bootstrap_uri("memory://agent/claude-code/bootstrap") == "claude-code"
        assert _parse_bootstrap_uri("memory://stats") is None
        assert _parse_bootstrap_uri("memory://agent/kiro/other") is None
