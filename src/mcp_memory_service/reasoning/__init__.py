"""Reasoning module — entity extraction, linking, inference, NLI, temporal edges, mutability, and multi-strategy search."""

from .entities import Entity, EntityExtractor
from .entity_linker import EntityLinker
from .nli import NLIClassifier, NLIResult, detect_contradictions_nli
from .temporal import TemporalEdge, store_temporal_association, filter_temporal_edges, classify_temporal_relationship
from .mutability import classify_mutability, contradiction_action
from .multi_strategy import rrf_fuse, multi_strategy_search

__all__ = [
    "Entity",
    "EntityExtractor",
    "EntityLinker",
    "NLIClassifier",
    "NLIResult",
    "detect_contradictions_nli",
    "TemporalEdge",
    "store_temporal_association",
    "filter_temporal_edges",
    "classify_temporal_relationship",
    "classify_mutability",
    "contradiction_action",
    "rrf_fuse",
    "multi_strategy_search",
]
