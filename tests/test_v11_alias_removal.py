"""V11 contract: legacy tool-name aliases are removed, but the log-injection
guard and the non-alias legacy handlers survive (Issue #53 Step 3, supersedes #60).

The cut is defined precisely: a name is a *deprecated alias* iff it was listed
in the (now removed) compat.DEPRECATED_TOOLS map. Everything else that lived in
the routing _LEGACY table is an active, non-advertised handler and must stay
reachable.
"""
import importlib

import pytest

from mcp_memory_service.tools.routing import resolve_handler, ROUTING_TABLE

# The 34 deprecated aliases that V11 removes (the old compat.DEPRECATED_TOOLS keys).
REMOVED_ALIASES = [
    "delete_memory", "delete_by_tag", "delete_by_tags", "delete_by_all_tags",
    "delete_by_timeframe", "delete_before_date",
    "retrieve_memory", "recall_memory", "recall_by_timeframe",
    "retrieve_with_quality_boost", "exact_match_retrieve", "debug_retrieve",
    "consolidate_memories", "consolidation_status", "consolidation_recommendations",
    "scheduler_status", "trigger_consolidation", "pause_consolidation",
    "resume_consolidation",
    "store_memory", "check_database_health", "get_cache_stats",
    "cleanup_duplicates", "update_memory_metadata", "list_memories",
    "search_by_tag", "ingest_document", "ingest_directory",
    "rate_memory", "get_memory_quality", "analyze_quality_distribution",
    "find_connected_memories", "find_shortest_path", "get_memory_subgraph",
]

# Non-alias legacy handlers (never in DEPRECATED_TOOLS) that MUST remain routable.
SURVIVING_HANDLERS = [
    "get_raw_embedding", "memory_rate", "infer",
    "memory_observe", "memory_review", "memory_analysis",
    "knowledge_export", "learning_session",
]


class TestAliasesRemoved:
    @pytest.mark.parametrize("alias", REMOVED_ALIASES)
    def test_alias_not_routable(self, alias):
        assert resolve_handler(alias) is None, f"{alias} should be unknown in V11"

    @pytest.mark.parametrize("alias", REMOVED_ALIASES)
    def test_alias_absent_from_routing_table(self, alias):
        assert alias not in ROUTING_TABLE, f"{alias} must be gone from ROUTING_TABLE"


class TestDeprecationLayerGone:
    def test_deprecated_tools_map_removed(self):
        compat = importlib.import_module("mcp_memory_service.compat")
        for attr in (
            "DEPRECATED_TOOLS", "transform_deprecated_call", "is_deprecated",
            "get_new_tool_name", "get_deprecated_tool_defs", "get_deprecation_message",
        ):
            assert not hasattr(compat, attr), f"compat.{attr} must be removed in V11"

    def test_tooldef_has_no_deprecated_fields(self):
        from mcp_memory_service.tools.registry import ToolDef
        td = ToolDef(name="x", description="d", input_schema={})
        assert not hasattr(td, "deprecated")
        assert not hasattr(td, "deprecated_replacement")


class TestLogGuardSurvives:
    def test_sanitize_log_value_still_exported(self):
        from mcp_memory_service.compat import _sanitize_log_value
        assert _sanitize_log_value("a\nb\rc\x1bd") == "a\\nb\\rc\\x1bd"


class TestNonAliasHandlersSurvive:
    @pytest.mark.parametrize("name", SURVIVING_HANDLERS)
    def test_handler_still_routable(self, name):
        assert resolve_handler(name) is not None, f"{name} is not a deprecated alias and must stay reachable"
