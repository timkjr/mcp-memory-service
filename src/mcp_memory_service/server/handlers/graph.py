# Copyright 2024 Heinrich Krupp
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
Graph traversal handler functions for MCP server.

Provides graph database operations including:
- find_connected_memories: Multi-hop connection discovery
- find_shortest_path: Path finding between memories
- get_memory_subgraph: Subgraph extraction for visualization
"""

import json
import logging
from typing import List, Optional

from mcp import types
from ...storage.graph import GraphStorage, normalize_entity_id
from ...config import SQLITE_VEC_PATH, STORAGE_BACKEND

logger = logging.getLogger(__name__)


def _sanitize_log_value(value: object) -> str:
    """Sanitize a user-provided value for safe inclusion in log messages."""
    return str(value).replace("\n", "\\n").replace("\r", "\\r").replace("\x1b", "\\x1b")


async def get_graph_storage() -> Optional[GraphStorage]:
    """
    Get graph storage instance if available.

    Graph operations are available for SQLite-based backends
    (sqlite_vec and hybrid) and Milvus backend. Cloudflare backend
    does not support graph traversal.

    Returns:
        GraphStorage or MilvusGraphStorage instance if backend supports it, None otherwise
    """
    if STORAGE_BACKEND in ['sqlite_vec', 'hybrid']:
        try:
            return GraphStorage(SQLITE_VEC_PATH)
        except Exception as e:
            logger.error("Failed to initialize GraphStorage: %s", e)
            return None
    elif STORAGE_BACKEND == 'milvus':
        try:
            from ...storage.milvus_graph import MilvusGraphStorage
            from ...config import MILVUS_URI, MILVUS_TOKEN, MILVUS_COLLECTION_NAME
            gs = MilvusGraphStorage(
                uri=MILVUS_URI,
                token=MILVUS_TOKEN,
                collection_name=MILVUS_COLLECTION_NAME,
            )
            # Async init to avoid blocking the event loop.
            await gs.initialize()
            return gs
        except Exception as e:
            logger.error("Failed to initialize MilvusGraphStorage: %s", e)
            return None
    return None


async def handle_memory_graph(server, arguments: dict) -> List[types.TextContent]:
    """Unified handler for graph operations."""
    action = arguments.get("action")

    if not action:
        return [types.TextContent(type="text", text="Error: action parameter is required")]

    # Validate action
    valid_actions = ["connected", "path", "subgraph", "extract_entities", "infer", "suggest", "abduct", "list_entities", "entity_profile"]
    if action not in valid_actions:
        return [types.TextContent(
            type="text",
            text=f"Error: Invalid action '{action}'. Must be one of: {', '.join(valid_actions)}"
        )]

    try:
        # Route to appropriate handler based on action
        if action == "connected":
            # Find connected memories
            hash_val = arguments.get("hash")
            if not hash_val:
                return [types.TextContent(type="text", text="Error: hash is required for 'connected' action")]

            return await handle_find_connected_memories(server, {
                "hash": hash_val,
                "max_hops": arguments.get("max_hops", 2)
            })

        elif action == "path":
            # Find shortest path
            hash1 = arguments.get("hash1")
            hash2 = arguments.get("hash2")
            if not hash1 or not hash2:
                return [types.TextContent(type="text", text="Error: hash1 and hash2 are required for 'path' action")]

            return await handle_find_shortest_path(server, {
                "hash1": hash1,
                "hash2": hash2,
                "max_depth": arguments.get("max_depth", 5)
            })

        elif action == "subgraph":
            # Get memory subgraph
            hash_val = arguments.get("hash")
            if not hash_val:
                return [types.TextContent(type="text", text="Error: hash is required for 'subgraph' action")]

            return await handle_get_memory_subgraph(server, {
                "hash": hash_val,
                "radius": arguments.get("radius", 2)
            })

        elif action == "extract_entities":
            # Manual entity extraction for a specific memory
            hash_val = arguments.get("hash")
            if not hash_val:
                return [types.TextContent(type="text", text="Error: hash is required for 'extract_entities' action")]

            from mcp_memory_service.reasoning.entities import EntityExtractor

            storage = server.storage
            if not (hasattr(storage, 'graph') and storage.graph):
                return [types.TextContent(type="text", text="Error: graph storage required for entity extraction")]
            mem = await storage.retrieve(hash_val)
            if not mem:
                return [types.TextContent(type="text", text=f"Memory {hash_val} not found")]

            extractor = EntityExtractor()
            content = mem.get("content", "")
            metadata = mem.get("metadata", {})
            entities = extractor.extract_entities(content, metadata)

            stored = 0
            for ent in entities:
                ok = await storage.graph.store_entity_link(hash_val, ent.name, ent.entity_type)
                if ok:
                    stored += 1

            result = {
                "hash": hash_val,
                "entities_found": len(entities),
                "entities_stored": stored,
                "entities": [{"name": e.name, "type": e.entity_type, "source": e.source} for e in entities]
            }
            return [types.TextContent(type="text", text=json.dumps(result, indent=2))]

        elif action == "infer":
            return await handle_infer(arguments)

        elif action == "suggest":
            return await handle_suggest(arguments)

        elif action == "abduct":
            return await handle_abduct(arguments)

        elif action == "list_entities":
            try:
                limit = int(arguments.get("limit", 50))
            except (ValueError, TypeError):
                limit = 50
            graph = await get_graph_storage()
            if not graph:
                return [types.TextContent(type="text", text=json.dumps({"error": "graph storage not available"}))]
            entities = await graph.list_entities(limit=limit)
            return [types.TextContent(type="text", text=json.dumps({"entities": entities, "total": len(entities)}))]

        elif action == "entity_profile":
            entity_name = arguments.get("entity_name", "")
            if not entity_name:
                return [types.TextContent(type="text", text=json.dumps({"error": "entity_name required"}))]
            graph = await get_graph_storage()
            if not graph:
                return [types.TextContent(type="text", text=json.dumps({"error": "graph storage not available"}))]
            profile = await graph.get_entity_profile(entity_name)
            if not profile:
                return [types.TextContent(type="text", text=json.dumps({"error": f"entity '{entity_name}' not found"}))]
            memory_hashes = await graph.find_memories_by_entity(entity_name, limit=20)
            profile["memory_hashes"] = memory_hashes
            return [types.TextContent(type="text", text=json.dumps(profile))]

        else:
            # Should never reach here due to validation above
            return [types.TextContent(type="text", text=f"Error: Unknown action '{action}'")]

    except Exception as e:
        import traceback
        error_msg = f"Error in memory_graph action '{_sanitize_log_value(action)}': {str(e)}"
        logger.error("%s\n%s", error_msg, traceback.format_exc())
        return [types.TextContent(type="text", text=error_msg)]


async def handle_infer(arguments: dict) -> List[types.TextContent]:
    """Handle infer action: find transitive relationships."""
    graph = await get_graph_storage()
    if graph is None:
        return [types.TextContent(type="text", text=json.dumps({
            "success": False,
            "error": f"Graph operations not available for backend: {STORAGE_BACKEND}",
            "inferred": []
        }, indent=2))]

    from ...reasoning.inference import SemanticReasoner
    reasoner = SemanticReasoner(graph)

    rel_type = arguments.get("rel_type", "related")
    max_hops = arguments.get("max_hops", 2)
    decay_factor = arguments.get("decay_factor", 1.0)

    try:
        results = await reasoner.infer_transitive(rel_type, max_hops, decay_factor)
    except ValueError as e:
        return [types.TextContent(type="text", text=json.dumps({
            "success": False,
            "error": str(e),
            "inferred": []
        }, indent=2))]

    return [types.TextContent(type="text", text=json.dumps({
        "success": True,
        "inferred": [
            {"source": src, "target": tgt, "distance": dist, "weight": weight}
            for src, tgt, dist, weight in results
        ],
        "count": len(results)
    }, indent=2))]


async def handle_suggest(arguments: dict) -> List[types.TextContent]:
    """Handle suggest action: suggest potential relationships."""
    graph = await get_graph_storage()
    if graph is None:
        return [types.TextContent(type="text", text=json.dumps({
            "success": False,
            "error": f"Graph operations not available for backend: {STORAGE_BACKEND}",
            "suggestions": []
        }, indent=2))]

    hash_val = arguments.get("hash")
    if not hash_val:
        return [types.TextContent(type="text", text=json.dumps({
            "success": False,
            "error": "Missing required parameter: hash",
            "suggestions": []
        }, indent=2))]

    from ...reasoning.inference import SemanticReasoner
    reasoner = SemanticReasoner(graph)

    suggestions = await reasoner.suggest_relationships(hash_val)
    return [types.TextContent(type="text", text=json.dumps({
        "success": True,
        "suggestions": suggestions,
        "count": len(suggestions)
    }, indent=2))]


async def handle_abduct(arguments: dict) -> List[types.TextContent]:
    """Handle abduct action: find probable causes for an effect."""
    graph = await get_graph_storage()
    if graph is None:
        return [types.TextContent(type="text", text=json.dumps({
            "success": False,
            "error": f"Graph operations not available for backend: {STORAGE_BACKEND}",
            "causes": []
        }, indent=2))]

    hash_val = arguments.get("hash")
    if not hash_val:
        return [types.TextContent(type="text", text=json.dumps({
            "success": False,
            "error": "Missing required parameter: hash",
            "causes": []
        }, indent=2))]

    from ...reasoning.inference import SemanticReasoner
    reasoner = SemanticReasoner(graph)

    max_depth = arguments.get("max_depth", 2)
    causes = await reasoner.abduct(hash_val, max_depth=max_depth)
    return [types.TextContent(type="text", text=json.dumps({
        "success": True,
        "causes": causes,
        "count": len(causes)
    }, indent=2))]


async def handle_find_connected_memories(
    server,
    arguments: dict
) -> List[types.TextContent]:
    """
    Find memories connected to a given memory via associations.

    Performs breadth-first traversal of the association graph up to
    max_hops distance, returning all connected memories with their
    distance from the source.

    Args:
        server: MCP server instance (unused, for handler pattern consistency)
        arguments: Dict with:
            - hash: Content hash of the starting memory
            - max_hops: Maximum number of hops to traverse (default: 2)

    Returns:
        List with single TextContent containing JSON result:
        {
            "success": true,
            "connected": [
                {"hash": "abc123", "distance": 1},
                {"hash": "def456", "distance": 2}
            ],
            "count": 2
        }
        Or error result if graph unavailable or operation fails.
    """
    logger.info("=== EXECUTING FIND_CONNECTED_MEMORIES ===")

    # Get graph storage
    graph = await get_graph_storage()
    if graph is None:
        result = {
            "success": False,
            "error": f"Graph operations not available for backend: {STORAGE_BACKEND}",
            "connected": [],
            "count": 0
        }
        return [types.TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )]

    # Validate required parameters
    memory_hash = arguments.get("hash")
    if not memory_hash:
        result = {
            "success": False,
            "error": "Missing required parameter: hash",
            "connected": [],
            "count": 0
        }
        return [types.TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )]

    # Get optional parameters
    max_hops = arguments.get("max_hops", 2)

    try:
        # Perform graph traversal
        connected = await graph.find_connected(memory_hash, max_hops=max_hops)

        # Format results
        result = {
            "success": True,
            "connected": [
                {"hash": hash_val, "distance": distance}
                for hash_val, distance in connected
            ],
            "count": len(connected)
        }

        logger.info("Found %d connected memories within %s hops", len(connected), _sanitize_log_value(max_hops))

        return [types.TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )]

    except Exception as e:
        logger.error("Error finding connected memories: %s", e)
        result = {
            "success": False,
            "error": str(e),
            "connected": [],
            "count": 0
        }
        return [types.TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )]


async def handle_find_shortest_path(
    server,
    arguments: dict
) -> List[types.TextContent]:
    """
    Find shortest path between two memories in the association graph.

    Uses breadth-first search to find the shortest sequence of associations
    connecting two memories. Returns null if no path exists.

    Args:
        server: MCP server instance (unused, for handler pattern consistency)
        arguments: Dict with:
            - hash1: Starting memory hash
            - hash2: Target memory hash
            - max_depth: Maximum path length (default: 5)

    Returns:
        List with single TextContent containing JSON result:
        {
            "success": true,
            "path": ["hash1", "intermediate_hash", "hash2"],
            "length": 3
        }
        Or null path if no connection exists.
    """
    logger.info("=== EXECUTING FIND_SHORTEST_PATH ===")

    # Get graph storage
    graph = await get_graph_storage()
    if graph is None:
        result = {
            "success": False,
            "error": f"Graph operations not available for backend: {STORAGE_BACKEND}",
            "path": None,
            "length": 0
        }
        return [types.TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )]

    # Validate required parameters
    hash1 = arguments.get("hash1")
    hash2 = arguments.get("hash2")

    if not hash1 or not hash2:
        result = {
            "success": False,
            "error": "Missing required parameters: hash1 and hash2",
            "path": None,
            "length": 0
        }
        return [types.TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )]

    # Get optional parameters
    max_depth = arguments.get("max_depth", 5)

    try:
        # Find shortest path
        path = await graph.shortest_path(hash1, hash2, max_depth=max_depth)

        # Format results
        if path is not None:
            result = {
                "success": True,
                "path": path,
                "length": len(path)
            }
            logger.info("Found path of length %s between memories", len(path))
        else:
            result = {
                "success": True,
                "path": None,
                "length": 0,
                "message": "No path found within depth limit"
            }
            logger.info("No path found between %s and %s", _sanitize_log_value(hash1), _sanitize_log_value(hash2))

        return [types.TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )]

    except Exception as e:
        logger.error("Error finding shortest path: %s", e)
        result = {
            "success": False,
            "error": str(e),
            "path": None,
            "length": 0
        }
        return [types.TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )]


async def handle_get_memory_subgraph(
    server,
    arguments: dict
) -> List[types.TextContent]:
    """
    Get subgraph around a memory for visualization.

    Extracts all nodes and edges within the specified radius for
    graph visualization. Returns nodes (memory hashes) and edges
    (associations with metadata).

    Args:
        server: MCP server instance (unused, for handler pattern consistency)
        arguments: Dict with:
            - hash: Center memory hash
            - radius: Number of hops to include (default: 2)

    Returns:
        List with single TextContent containing JSON result:
        {
            "success": true,
            "nodes": ["hash1", "hash2", "hash3"],
            "edges": [
                {
                    "source": "hash1",
                    "target": "hash2",
                    "similarity": 0.65,
                    "connection_types": ["semantic", "temporal"],
                    "metadata": {}
                }
            ],
            "node_count": 3,
            "edge_count": 2
        }
    """
    logger.info("=== EXECUTING GET_MEMORY_SUBGRAPH ===")

    # Get graph storage
    graph = await get_graph_storage()
    if graph is None:
        result = {
            "success": False,
            "error": f"Graph operations not available for backend: {STORAGE_BACKEND}",
            "nodes": [],
            "edges": [],
            "node_count": 0,
            "edge_count": 0
        }
        return [types.TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )]

    # Validate required parameters
    memory_hash = arguments.get("hash")
    if not memory_hash:
        result = {
            "success": False,
            "error": "Missing required parameter: hash",
            "nodes": [],
            "edges": [],
            "node_count": 0,
            "edge_count": 0
        }
        return [types.TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )]

    # Get optional parameters
    radius = arguments.get("radius", 2)

    try:
        # Extract subgraph
        subgraph = await graph.get_subgraph(memory_hash, radius=radius)

        # Format results
        result = {
            "success": True,
            "nodes": subgraph["nodes"],
            "edges": subgraph["edges"],
            "node_count": len(subgraph["nodes"]),
            "edge_count": len(subgraph["edges"])
        }

        logger.info(
            f"Extracted subgraph: {len(subgraph['nodes'])} nodes, "
            f"{len(subgraph['edges'])} edges"
        )

        return [types.TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )]

    except Exception as e:
        logger.error("Error extracting subgraph: %s", e)
        result = {
            "success": False,
            "error": str(e),
            "nodes": [],
            "edges": [],
            "node_count": 0,
            "edge_count": 0
        }
        return [types.TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )]


async def _retrieve_candidates(storage, query: str, n_results: int, tags, store):
    """Thin, forward-compatible wrapper around storage.retrieve().

    Passes ``store`` only if the active backend's ``retrieve`` accepts it, so
    this composes the moment multi-store scoping reaches the retrieve path
    (#62) without breaking on backends that do not yet support it.
    """
    import inspect

    kwargs = {"n_results": n_results, "tags": tags}
    try:
        params = inspect.signature(storage.retrieve).parameters
        if store is not None and "store" in params:
            kwargs["store"] = store
    except (TypeError, ValueError):
        pass
    return await storage.retrieve(query, **kwargs)


async def _build_knowledge_map(graph, entities_raw, chunk_pool, chunks_per_entity):
    """Assemble the memory_explore response shape from discovered entities.

    Returns the locked per-entity shape with placeholder aggregation.

    TODO(filhocf): phase-1 aggregation fills this in —
      - entity discovery / dedup via normalize_entity_id (collision -> hash suffix)
      - extractive (LLM-free) summary from each entity's top-N chunks
      - per-entity top_chunks ranking against existing relevance
    Placeholder here: entity_type from profile, summary="", top_chunks =
    shared candidate-pool slice, relation_count = graph degree.
    """
    knowledge_map = []
    for ent in entities_raw:
        name = ent.get("entity_name", "")
        profile = await graph.get_entity_profile(name) if graph else {}
        entity_types = profile.get("entity_types") or []
        knowledge_map.append({
            "entity_id": normalize_entity_id(name),
            "name": name,
            "entity_type": entity_types[0] if entity_types else "",
            "summary": "",  # filled by aggregation
            "relation_count": ent.get("count", 0),
            "top_chunks": chunk_pool[:chunks_per_entity],  # placeholder ranking
        })
    return knowledge_map


async def handle_memory_explore(server, arguments: dict) -> List[types.TextContent]:
    """Explore a knowledge map of entities related to a query (read-only, LLM-free).

    SKELETON (#56/#61): does real candidate retrieval + real graph entity
    discovery and returns the locked response shape. The entity grouping,
    extractive summary, and per-entity top_chunks ranking are stubbed at the
    TODO(filhocf) boundary in ``_build_knowledge_map`` for the phase-1
    aggregation slice.

    Response: {"entities": [{entity_id, name, entity_type, summary,
    relation_count, top_chunks[]}], "count": N}.
    """
    query = arguments.get("query", "")
    if not query:
        return [types.TextContent(
            type="text",
            text=json.dumps({"success": False, "error": "Missing required parameter: query",
                             "entities": [], "count": 0}, indent=2)
        )]

    max_entities = arguments.get("max_entities", 10)
    chunks_per_entity = arguments.get("chunks_per_entity", 3)
    tags = arguments.get("tags")
    min_score = arguments.get("min_score", 0.0)
    store = arguments.get("store")  # forwarded to retrieve() when supported (now wired via #62)

    try:
        # 1. Candidate retrieval (real) — semantic search scoped by tags/store.
        candidates = await _retrieve_candidates(
            server.storage, query,
            n_results=max(max_entities * chunks_per_entity, max_entities),
            tags=tags, store=store,
        )
        chunk_pool = [
            {
                "hash": r.memory.content_hash,
                "content": r.memory.content[:500],
                "relevance": r.relevance_score,
            }
            for r in candidates
            if r.relevance_score >= min_score
        ]

        # 2. Entity discovery (real graph degree) — None when backend has no graph.
        graph = await get_graph_storage()
        entities_raw = await graph.list_entities(limit=max_entities) if graph else []

        knowledge_map = await _build_knowledge_map(
            graph, entities_raw, chunk_pool, chunks_per_entity
        )
        knowledge_map = knowledge_map[:max_entities]

        logger.info(
            "memory_explore: query=%s entities=%d candidates=%d",
            _sanitize_log_value(query), len(knowledge_map), len(chunk_pool)
        )
        return [types.TextContent(
            type="text",
            text=json.dumps({"entities": knowledge_map, "count": len(knowledge_map)}, indent=2)
        )]

    except Exception as e:
        logger.error("Error in memory_explore: %s", e, exc_info=True)
        return [types.TextContent(
            type="text",
            text=json.dumps({"success": False, "error": str(e), "entities": [], "count": 0}, indent=2)
        )]


async def _resolve_entity_name(graph, entity_id: str):
    """Resolve a canonical slug back to its stored entity name (or None)."""
    entities = await graph.list_entities(limit=500)
    return next(
        (e.get("entity_name", "") for e in entities
         if normalize_entity_id(e.get("entity_name", "")) == entity_id),
        None,
    )


async def _hydrate_chunks(storage, memory_hashes):
    """Fetch real chunk content for an entity's linked memories.

    TODO(filhocf): chunk ranking refinement (composite_score + score_components
    once #55 lands) is the phase-1 aggregation slice. ``relevance`` is left None
    here as the placeholder ranking field.
    """
    chunks = []
    for h in memory_hashes:
        mem = await storage.get_by_hash(h)
        chunks.append({
            "hash": h,
            "content": mem.content[:500] if mem else None,
            "relevance": None,
        })
    return chunks


async def _discover_related_entities(graph, memory_hashes, max_hops: int):
    """Discover related entities via shared neighbours (unranked skeleton).

    TODO(filhocf): scoring / dedup ranking of related_entities is the phase-1
    aggregation slice. Names are normalized but otherwise unranked here.
    """
    related = []
    seen = set()
    for h in memory_hashes[:max_hops + 1]:
        for cand_hash, shared, _deg in await graph.common_neighbors(h):
            if cand_hash in seen:
                continue
            seen.add(cand_hash)
            related.append({
                "entity_id": normalize_entity_id(cand_hash),
                "name": cand_hash,
                "shared_count": shared,
            })
    return related


async def handle_memory_detail(server, arguments: dict) -> List[types.TextContent]:
    """Full ranked detail for a single entity (read-only).

    SKELETON (#56/#61): resolves entity_id -> entity name (slug scan over real
    graph entities), fetches the entity's real memory chunks, and returns the
    locked response shape. Chunk ranking refinement and related-entity scoring
    are stubbed at the TODO(filhocf) boundary (see ``_hydrate_chunks`` and
    ``_discover_related_entities``).

    Response: {"entity_id", "name", "chunks": [{hash, content, relevance}],
    "related_entities": [...]}.
    """
    entity_id = arguments.get("entity_id")
    if not entity_id:
        return [types.TextContent(
            type="text",
            text=json.dumps({"success": False, "error": "Missing required parameter: entity_id",
                             "chunks": [], "related_entities": []}, indent=2)
        )]

    limit = arguments.get("limit", 50)
    include_related = arguments.get("include_related", True)
    max_hops = arguments.get("max_hops", 1)

    graph = await get_graph_storage()
    if graph is None:
        return [types.TextContent(
            type="text",
            text=json.dumps({
                "success": False,
                "error": f"Graph operations not available for backend: {STORAGE_BACKEND}",
                "entity_id": entity_id, "chunks": [], "related_entities": [],
            }, indent=2)
        )]

    try:
        name = await _resolve_entity_name(graph, entity_id)
        if name is None:
            return [types.TextContent(
                type="text",
                text=json.dumps({
                    "success": False, "error": f"Unknown entity_id: {entity_id}",
                    "entity_id": entity_id, "chunks": [], "related_entities": [],
                }, indent=2)
            )]

        memory_hashes = await graph.find_memories_by_entity(name, limit=limit)
        chunks = await _hydrate_chunks(server.storage, memory_hashes)
        related_entities = (
            await _discover_related_entities(graph, memory_hashes, max_hops)
            if include_related else []
        )

        logger.info(
            "memory_detail: entity_id=%s name=%s chunks=%d related=%d",
            _sanitize_log_value(entity_id), _sanitize_log_value(name),
            len(chunks), len(related_entities)
        )
        return [types.TextContent(
            type="text",
            text=json.dumps({
                "entity_id": entity_id,
                "name": name,
                "chunks": chunks,
                "related_entities": related_entities,
            }, indent=2)
        )]

    except Exception as e:
        logger.error("Error in memory_detail: %s", e, exc_info=True)
        return [types.TextContent(
            type="text",
            text=json.dumps({"success": False, "error": str(e),
                             "entity_id": entity_id, "chunks": [], "related_entities": []}, indent=2)
        )]
