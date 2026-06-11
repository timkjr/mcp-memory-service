"""Memory type ontology configuration — custom types."""
import os
import logging

logger = logging.getLogger(__name__)

# =============================================================================
# Memory Type Ontology Configuration
# =============================================================================

# Custom memory types (JSON format)
# Example: {"planning": ["sprint_goal", "backlog_item"], "meeting": ["action_item"]}
CUSTOM_MEMORY_TYPES_JSON = os.getenv('MCP_CUSTOM_MEMORY_TYPES', '')

logger.info("Memory Type Ontology Configuration:")
if CUSTOM_MEMORY_TYPES_JSON:
    try:
        import json
        custom_types = json.loads(CUSTOM_MEMORY_TYPES_JSON)
        total_base = len(custom_types)
        total_subtypes = sum(len(subtypes) for subtypes in custom_types.values() if isinstance(subtypes, list))
        logger.info(f"  Custom types: {total_base} base types, {total_subtypes} subtypes")
        logger.info(f"  Custom base types: {', '.join(custom_types.keys())}")
    except json.JSONDecodeError:
        logger.error("  Failed to parse MCP_CUSTOM_MEMORY_TYPES (invalid JSON)")
else:
    logger.info("  Custom types: None (using built-in ontology only)")

# =============================================================================
# End Memory Type Ontology Configuration
