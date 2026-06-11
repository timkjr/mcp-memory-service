"""Pure belief derivation functions — no LLM, no storage dependencies.

Implements RFC #1 §2: confidence scoring via sigmoid over weighted observations
with exponential decay and asymmetric contradiction penalty (lambda).
"""

import math
import os
import logging
from datetime import datetime, timezone
from typing import List, Dict, Optional

logger = logging.getLogger(__name__)

# Observation subtype weights (configurable via env)
OBSERVATION_WEIGHTS = {
    "user_correction": 1.0,
    "preference_signal": 0.8,
    "tool_outcome": 0.6,
    "automated": 0.4,  # distill, pattern extraction
}

# Error multiplier: contradictions hurt more than support helps
LAMBDA = float(os.getenv("MCP_BELIEF_LAMBDA", "3.0"))

# Minimum independent observations to promote from candidate → active
PROVENANCE_FLOOR = int(os.getenv("MCP_BELIEF_PROVENANCE_FLOOR", "2"))

# Confidence floor: below this, belief is not surfaced
CONFIDENCE_FLOOR = float(os.getenv("MCP_BELIEF_CONFIDENCE_FLOOR", "0.35"))


def sigmoid(x: float) -> float:
    """Map raw score to (0, 1) range."""
    return 1.0 / (1.0 + math.exp(-x))


def decay(age_days: float, retention_period: float = 30.0) -> float:
    """Exponential decay matching existing consolidation/decay.py curve."""
    return math.exp(-age_days / retention_period)


def get_observation_weight(observation_metadata: dict) -> float:
    """Get weight for an observation based on its subtype."""
    obs_type = observation_metadata.get("observation_type", "automated")
    return OBSERVATION_WEIGHTS.get(obs_type, OBSERVATION_WEIGHTS["automated"])


def derive_confidence(
    supporting: List[Dict],
    contradicting: List[Dict],
    current_time: Optional[datetime] = None,
    lambda_weight: float = LAMBDA,
) -> float:
    """
    Derive belief confidence from supporting and contradicting observations.

    Formula: conf = sigmoid(Σ(w_s × decay(age_s)) - λ × Σ(w_c × decay(age_c)))
    """
    if current_time is None:
        current_time = datetime.now(timezone.utc)

    support_score = 0.0
    for obs in supporting:
        w = get_observation_weight(obs.get("metadata", {}))
        age = _get_age_days(obs, current_time)
        support_score += w * decay(age)

    contradict_score = 0.0
    for obs in contradicting:
        w = get_observation_weight(obs.get("metadata", {}))
        age = _get_age_days(obs, current_time)
        contradict_score += w * decay(age)

    raw = support_score - lambda_weight * contradict_score
    return sigmoid(raw)


def _get_age_days(observation: dict, current_time: datetime) -> float:
    """Calculate age in days from observation timestamp."""
    created = observation.get("created_at_iso") or observation.get("created_at", "")
    if isinstance(created, str) and created:
        try:
            obs_time = datetime.fromisoformat(created.replace("Z", "+00:00"))
            delta = current_time - obs_time
            return max(0, delta.total_seconds() / 86400)
        except (ValueError, TypeError):
            pass
    return 0.0


def should_promote(confidence: float, num_supporting: int) -> bool:
    """Check if a candidate belief should be promoted to active."""
    return confidence >= CONFIDENCE_FLOOR and num_supporting >= PROVENANCE_FLOOR


def should_supersede(confidence: float) -> bool:
    """Check if an active belief should be superseded (confidence dropped below floor)."""
    return confidence < CONFIDENCE_FLOOR
