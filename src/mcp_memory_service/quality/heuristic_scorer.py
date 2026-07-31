"""
Heuristic content quality scorer — no ML dependencies.

Scores content on structural signals: length, symbol density, word diversity,
sentence structure, and garbage content patterns. Designed for pre-store gating
where no query context is available and model inference is too slow.

Returns 0.0–1.0. Suggested threshold for gating: 0.25.
"""

import re
import math
import logging

logger = logging.getLogger(__name__)

# Patterns that strongly indicate tool output or structured data, not prose memory
_GARBAGE_PATTERNS = [
    re.compile(r'\{\s*"type"\s*:\s*"(content|tool)', re.IGNORECASE),
    re.compile(r'\b(tool_use|content_block|text_delta)\b', re.IGNORECASE),
    re.compile(r'^[\[\{]', re.MULTILINE),          # starts with JSON
    re.compile(r'"role"\s*:\s*"(user|assistant)"'), # raw conversation JSON
    re.compile(r'<\?xml|<!DOCTYPE|<html', re.IGNORECASE),
    re.compile(r'(item>\s*<title|<rss|<feed)', re.IGNORECASE),  # RSS/XML feeds
    re.compile(r'^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}'),   # log timestamps (with time component)
    # CRITICAL intentionally excluded — it's Tim's own note-emphasis prefix
    # ("CRITICAL: Tim NEVER uses..."), not just a log level, and was
    # hard-rejecting his own important notes to 0.05.
    re.compile(r'^\s*(WARNING|ERROR|INFO|DEBUG)\s*:', re.IGNORECASE | re.MULTILINE),  # log levels at line start only
]

# Words that appear in boilerplate/noise but not real memories
_NOISE_PHRASES = re.compile(
    r'\b(lorem ipsum|undefined|null|NaN|stacktrace|Traceback \(most recent)\b',
    re.IGNORECASE
)


def score_content(content: str) -> float:
    """
    Score content quality using structural heuristics.

    Args:
        content: Raw text content to evaluate

    Returns:
        Quality score 0.0–1.0
    """
    if not content:
        return 0.0

    text = content.strip()
    if not text:
        return 0.0

    # Hard-reject garbage patterns immediately
    sample = text[:1000]
    for pattern in _GARBAGE_PATTERNS:
        if pattern.search(sample):
            logger.debug("Heuristic: garbage pattern match → 0.05")
            return 0.05

    if _NOISE_PHRASES.search(sample):
        logger.debug("Heuristic: noise phrase match → 0.1")
        return 0.1

    length = len(text)
    words = text.split()
    word_count = len(words)

    if word_count < 3:
        return 0.05

    # --- Length score ---
    # Sweet spot: 40–2500 chars. Very short = fragment. Very long = likely dump.
    if length < 20:
        length_score = 0.05
    elif length < 40:
        length_score = 0.3
    elif length <= 2500:
        length_score = 1.0
    else:
        # Penalise gradually — tool dumps are often 5k–50k chars
        length_score = max(0.3, 1.0 - (length - 2500) / 8000)

    # --- Symbol density ---
    # High non-alphanumeric ratio → code, JSON, or markup
    non_alpha = sum(1 for c in text if not c.isalnum() and not c.isspace())
    symbol_ratio = non_alpha / length
    if symbol_ratio > 0.35:
        symbol_score = 0.1
    elif symbol_ratio > 0.20:
        symbol_score = 0.5
    elif symbol_ratio > 0.12:
        symbol_score = 0.8
    else:
        symbol_score = 1.0

    # --- Word diversity ---
    # Low unique-word ratio → repetitive content
    lower_words = [w.lower().strip(".,!?;:\"'") for w in words]
    unique_ratio = len(set(lower_words)) / word_count
    if unique_ratio < 0.2 and word_count >= 5:
        # Hard reject: highly repetitive regardless of other signals
        logger.debug(f"Heuristic: unique_ratio={unique_ratio:.2f} below 0.2 → 0.05")
        return 0.05
    # Short texts naturally have higher unique ratios — dampen slightly
    diversity_score = min(1.0, unique_ratio + 0.1 * math.log(word_count + 1, 10))

    # --- Sentence structure ---
    # Prose memories end with punctuation and have multiple words per sentence
    sentences = re.split(r'[.!?]+', text)
    non_empty = [s.strip() for s in sentences if s.strip()]
    has_punctuation = bool(re.search(r'[.!?]', text))
    avg_words_per_sentence = word_count / max(len(non_empty), 1)

    if not has_punctuation:
        structure_score = 0.4
    elif avg_words_per_sentence < 3:
        structure_score = 0.5
    elif avg_words_per_sentence > 60:
        # Very long "sentences" → likely unformatted dump
        structure_score = 0.5
    else:
        structure_score = 1.0

    # --- Digit density ---
    # Very high digit ratio → log output, timestamps, numeric dumps
    digit_ratio = sum(1 for c in text if c.isdigit()) / length
    digit_penalty = 1.0 if digit_ratio < 0.15 else max(0.3, 1.0 - (digit_ratio - 0.15) * 3)

    # Weighted combination
    score = (
        length_score    * 0.30 +
        symbol_score    * 0.30 +
        diversity_score * 0.20 +
        structure_score * 0.15 +
        digit_penalty   * 0.05
    )

    result = round(min(1.0, max(0.0, score)), 3)
    logger.debug(
        f"Heuristic: len={length} sym={symbol_ratio:.2f} div={unique_ratio:.2f} "
        f"struct={structure_score:.2f} → {result}"
    )
    return result
