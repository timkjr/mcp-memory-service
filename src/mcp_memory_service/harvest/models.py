"""Data models for session harvest."""

import logging
import os
from dataclasses import dataclass, field
from typing import List, Dict, Optional

HARVEST_TYPES = ["decision", "bug", "convention", "learning", "context"]

# Maximum characters for candidate content preview in MCP tool output
MAX_CANDIDATE_PREVIEW_LENGTH = 200


@dataclass
class HarvestCandidate:
    """A single extracted memory candidate."""
    content: str
    memory_type: str  # One of HARVEST_TYPES
    tags: List[str] = field(default_factory=list)
    confidence: float = 0.5
    source_line: str = ""  # Original text that triggered extraction


@dataclass
class HarvestResult:
    """Result of a harvest operation."""
    candidates: List[HarvestCandidate]
    session_id: str
    total_messages: int
    found: int
    by_type: Dict[str, int]
    stored: int = 0  # Only set when dry_run=False


@dataclass
class HarvestConfig:
    """Configuration for harvest operation."""
    sessions: int = 1
    session_ids: Optional[List[str]] = None
    types: List[str] = field(default_factory=lambda: list(HARVEST_TYPES))
    min_confidence: float = 0.75
    dry_run: bool = True
    project_path: Optional[str] = None  # Override project dir
    use_llm: bool = False  # Phase 2: LLM-based classification
    # P4: Harvest evolution — evolve existing memories instead of duplicating
    similarity_threshold: float = 0.85  # Cosine similarity to trigger evolution
    min_confidence_to_evolve: float = 0.3  # Skip evolution for very stale memories
    # Confidence-gated LLM fallback (#116): regex-only extraction misses ~33%
    # of extractable knowledge, but running the LLM on every candidate
    # (use_llm=True) blocks synchronously for 80-120s (#80). None disables
    # this — only candidates below the threshold get a background LLM
    # refinement pass; heuristic results still store immediately either way.
    llm_fallback_threshold: Optional[float] = None


def harvest_config_from_env(**overrides) -> HarvestConfig:
    """Create HarvestConfig with environment variable overrides.

    Environment variables (invalid values are logged and ignored):
        MCP_HARVEST_SIMILARITY_THRESHOLD: float (0.0-1.0) — cosine similarity
            above which harvest evolves an existing memory instead of creating
            a new one. Higher = fewer evolutions, more duplicates.
        MCP_HARVEST_MIN_CONFIDENCE_TO_EVOLVE: float (0.0-1.0) — minimum
            staleness-adjusted confidence to consider a memory for evolution.
            Very stale memories below this threshold get a fresh copy instead.
        MCP_HARVEST_MIN_CONFIDENCE: float (0.0-1.0) — regex-pattern confidence
            floor for a candidate to be extracted at all (default 0.75).
            Pattern YAMLs (en.yaml/de.yaml) never emit below 0.6, so lowering
            this to 0.6 admits every near-miss the patterns can produce
            without doing anything below that.
        HARVEST_LLM_FALLBACK_THRESHOLD: float (0.0-1.0) — candidates with
            regex confidence below this get a background LLM refinement pass.
            Unset (default) disables the fallback entirely. Must be set
            above min_confidence to have any effect — candidates below
            min_confidence are dropped during extraction and never reach
            this check at all.
    """
    defaults = {}
    for env_var, field_name in [
        ("MCP_HARVEST_SIMILARITY_THRESHOLD", "similarity_threshold"),
        ("MCP_HARVEST_MIN_CONFIDENCE_TO_EVOLVE", "min_confidence_to_evolve"),
        ("MCP_HARVEST_MIN_CONFIDENCE", "min_confidence"),
        ("HARVEST_LLM_FALLBACK_THRESHOLD", "llm_fallback_threshold"),
    ]:
        raw = os.environ.get(env_var)
        if raw is not None:
            try:
                defaults[field_name] = float(raw)
            except ValueError:
                logging.getLogger(__name__).warning(
                    f"Invalid {env_var}={raw!r}, using default"
                )
    defaults.update(overrides)
    config = HarvestConfig(**defaults)

    threshold = config.llm_fallback_threshold
    if threshold is not None and threshold <= config.min_confidence:
        logging.getLogger(__name__).warning(
            f"HARVEST_LLM_FALLBACK_THRESHOLD={threshold} <= min_confidence="
            f"{config.min_confidence} — no candidate can ever be below "
            "min_confidence (they're dropped during extraction), so the "
            "fallback will never trigger. Set the threshold above min_confidence."
        )

    return config


def default_llm_fallback_threshold() -> Optional[float]:
    """Read HARVEST_LLM_FALLBACK_THRESHOLD directly.

    For callers (the HTTP harvest endpoint, the memory_harvest MCP tool) that
    build HarvestConfig straight from per-call request/tool arguments rather
    than harvest_config_from_env() — without this, setting the env var in
    production .env would have no effect on those paths at all (#116).
    """
    raw = os.environ.get("HARVEST_LLM_FALLBACK_THRESHOLD")
    if raw is None:
        return None
    try:
        return float(raw)
    except ValueError:
        logging.getLogger(__name__).warning(
            f"Invalid HARVEST_LLM_FALLBACK_THRESHOLD={raw!r}, ignoring"
        )
        return None
