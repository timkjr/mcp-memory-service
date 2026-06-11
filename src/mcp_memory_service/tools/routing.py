"""Routing table for MCP tool dispatch.

Maps tool names (and legacy aliases) to their handler functions via lazy
imports. This replaces the 59-branch elif chain in server_impl.py call_tool().

Handler resolution is lazy: modules are imported only on first call to
avoid circular imports and reduce cold-start time.
"""

from __future__ import annotations

from typing import Callable


def _handler(module: str, func: str) -> tuple[str, str]:
    """Create a lazy handler reference (module_path, function_name)."""
    return (f"mcp_memory_service.server.handlers.{module}", func)


# Primary tools (advertised in list_tools via TOOL_REGISTRY)
_PRIMARY: dict[str, tuple[str, str]] = {
    "memory_store": _handler("memory", "handle_store_memory"),
    "memory_store_session": _handler("memory", "handle_store_session"),
    "memory_search": _handler("memory", "handle_memory_search"),
    "memory_list": _handler("memory", "handle_memory_list"),
    "memory_delete": _handler("memory", "handle_memory_delete"),
    "memory_cleanup": _handler("memory", "handle_cleanup_duplicates"),
    "memory_health": _handler("utility", "handle_check_database_health"),
    "memory_stats": _handler("utility", "handle_get_cache_stats"),
    "memory_update": _handler("memory", "handle_update_memory_metadata"),
    "memory_consolidate": _handler("consolidation", "handle_memory_consolidate"),
    "memory_ingest": _handler("documents", "handle_memory_ingest"),
    "memory_harvest": ("__self__", "handle_memory_harvest"),
    "memory_quality": _handler("quality", "handle_memory_quality"),
    "memory_graph": _handler("graph", "handle_memory_graph"),
    "memory_conflicts": _handler("quality", "handle_memory_conflicts"),
    "memory_resolve": _handler("quality", "handle_memory_resolve"),
    "mistake_note_add": _handler("mistake_notes", "handle_mistake_note_add"),
    "mistake_note_search": _handler("mistake_notes", "handle_mistake_note_search"),
    "mistake_note_update": _handler("mistake_notes", "handle_mistake_note_update"),
    "mistake_note_delete": _handler("mistake_notes", "handle_mistake_note_delete"),
    "get_quarantined_memories": ("__self__", "handle_get_quarantined_memories"),
    "unquarantine_memory": ("__self__", "handle_unquarantine_memory"),
    "commit_session_legacy": ("__self__", "handle_commit_session_legacy"),
    "get_bootstrap_profile": ("__self__", "handle_get_bootstrap_profile"),
    "get_onboarding_guide": ("__self__", "handle_get_onboarding_guide"),
    "memory_distill": ("__self__", "handle_memory_distill"),
}

# Legacy/alias names (not advertised but still handled in call_tool)
_LEGACY: dict[str, tuple[str, str]] = {
    # Memory retrieval aliases
    "retrieve_memory": _handler("memory", "handle_retrieve_memory"),
    "recall_memory": _handler("memory", "handle_recall_memory"),
    "recall_by_timeframe": _handler("memory", "handle_recall_memory"),
    "retrieve_with_quality_boost": _handler("memory", "handle_retrieve_with_quality_boost"),
    "exact_match_retrieve": _handler("memory", "handle_exact_match_retrieve"),
    "debug_retrieve": _handler("memory", "handle_debug_retrieve"),
    "get_raw_embedding": _handler("memory", "handle_get_raw_embedding"),
    # Search aliases
    "search_by_tag": _handler("memory", "handle_search_by_tag"),
    # Delete aliases
    "delete_memory": _handler("memory", "handle_delete_memory"),
    "delete_by_tag": _handler("memory", "handle_delete_by_tag"),
    "delete_by_tags": _handler("memory", "handle_delete_by_tags"),
    "delete_by_all_tags": _handler("memory", "handle_delete_by_all_tags"),
    "delete_before_date": _handler("memory", "handle_memory_delete"),
    "delete_by_timeframe": _handler("memory", "handle_memory_delete"),
    # Consolidation aliases
    "consolidate_memories": _handler("consolidation", "handle_consolidate_memories"),
    "consolidation_status": _handler("consolidation", "handle_consolidation_status"),
    "consolidation_recommendations": _handler("consolidation", "handle_consolidation_recommendations"),
    "scheduler_status": _handler("consolidation", "handle_scheduler_status"),
    "trigger_consolidation": _handler("consolidation", "handle_trigger_consolidation"),
    "pause_consolidation": _handler("consolidation", "handle_pause_consolidation"),
    "resume_consolidation": _handler("consolidation", "handle_resume_consolidation"),
    # Quality aliases
    "memory_rate": _handler("quality", "handle_rate_memory"),
    "get_memory_quality": _handler("quality", "handle_get_memory_quality"),
    "analyze_quality_distribution": _handler("quality", "handle_analyze_quality_distribution"),
    # Graph aliases
    "find_connected_memories": _handler("graph", "handle_find_connected_memories"),
    "find_shortest_path": _handler("graph", "handle_find_shortest_path"),
    "get_memory_subgraph": _handler("graph", "handle_get_memory_subgraph"),
    "infer": _handler("graph", "handle_infer"),
    # Document aliases
    "ingest_document": _handler("documents", "handle_ingest_document"),
    "ingest_directory": _handler("documents", "handle_ingest_directory"),
    # Observe (inline in server_impl)
    "memory_observe": _handler("memory", "handle_memory_observe"),
    # Other inline handlers
    "memory_review": ("__self__", "handle_memory_review"),
    "memory_analysis": ("__self__", "handle_memory_analysis"),
    "knowledge_export": ("__self__", "handle_knowledge_export"),
    "learning_session": ("__self__", "handle_learning_session"),
}

# Combined routing table
ROUTING_TABLE: dict[str, tuple[str, str]] = {**_PRIMARY, **_LEGACY}

# Handler cache (populated on first resolve)
_cache: dict[str, Callable] = {}


def resolve_handler(name: str) -> Callable | tuple | None:
    """Resolve a tool name to its handler function (lazy import + cache).

    Returns a callable for module-based handlers, or a tuple ('__self__', method_name)
    for tools whose logic lives as instance methods on MemoryServer.
    """
    if name in _cache:
        return _cache[name]

    entry = ROUTING_TABLE.get(name)
    if entry is None:
        return None

    module_path, func_name = entry

    # Sentinel: handler is an instance method on MemoryServer
    if module_path == "__self__":
        _cache[name] = entry
        return entry

    import importlib
    mod = importlib.import_module(module_path)
    handler = getattr(mod, func_name, None)
    if handler is not None:
        _cache[name] = handler
    return handler
