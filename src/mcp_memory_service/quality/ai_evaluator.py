"""
AI-powered quality evaluator with multi-tier fallback.
Coordinates between local SLM, Groq, Gemini, and implicit signals.
"""

import asyncio
import logging
import os
import re
from typing import List, Optional
import httpx
from .config import QualityConfig
from .onnx_ranker import get_onnx_ranker_model, ONNXRankerModel
from .implicit_signals import ImplicitSignalsEvaluator
from ..models.memory import Memory

logger = logging.getLogger(__name__)

# ONNX tiers truncate at 512 tokens (~2000 chars for typical English text);
# the LLM-endpoint prompt used to cut off 4x earlier at 500 chars, scoring a
# much smaller slice of the same memory than the local tier does (#174).
_SCORING_CONTENT_CHARS = 2000

# Recovers a score from responses that wrap the number in prose, a code
# fence, or a "Score: 0.7" prefix instead of returning it bare (#174).
_SCORE_PATTERN = re.compile(r"-?\d+\.?\d*")

# Asking for "a number between 0.0 and 1.0" without a precision hint led
# models to reply with a single decimal place (tecnobrat, #170) — collapsing
# the usable range to 11 values. Spelling out two decimal places recovers
# the resolution these scores need for ranking/retention comparisons (#174).
_SCORING_SYSTEM_MESSAGE = (
    "You are a quality scorer. Respond only with a number between 0.00 and "
    "1.00, expressed to at least two decimal places (e.g. 0.62, not 0.6)."
)


def _parse_score(response_text: str) -> float:
    """Parse a quality score out of a model response.

    Raises ValueError if no number can be recovered at all.
    """
    try:
        return float(response_text)
    except ValueError:
        pass

    match = _SCORE_PATTERN.search(response_text)
    if not match:
        raise ValueError(f"No numeric score found in response: {response_text!r}")
    return float(match.group())


class QualityEvaluator:
    """
    Multi-tier AI quality evaluator with fallback chain.
    Tries: Local ONNX → OpenAI-compatible → Groq → Gemini → Implicit Signals
    """

    def __init__(self, config: Optional[QualityConfig] = None):
        """
        Initialize quality evaluator with configuration.

        Args:
            config: Quality configuration (defaults to env-based config)
        """
        self.config = config or QualityConfig.from_env()
        self.config.validate()

        # Initialize tier components
        self._onnx_ranker: Optional[ONNXRankerModel] = None
        self._onnx_models: dict = {}  # For fallback mode (multiple models)
        self._implicit_evaluator = ImplicitSignalsEvaluator()
        self._groq_bridge = None
        self._httpx_client: Optional[httpx.AsyncClient] = None
        self._initialized = False

    def _ensure_initialized(self):
        """Lazy initialization of heavy components."""
        if self._initialized:
            return

        # Initialize local ONNX ranker(s) if using local provider
        if self.config.ai_provider in ['local', 'auto']:
            # Check if fallback mode enabled
            if self.config.fallback_enabled:
                # Load multiple models for fallback scoring
                try:
                    model_names = [m.strip() for m in self.config.local_model.split(',')]
                    logger.info(f"Loading {len(model_names)} models for fallback mode")

                    for model_name in model_names:
                        try:
                            model = get_onnx_ranker_model(
                                model_name=model_name,
                                device=self.config.local_device
                            )
                            if model:
                                self._onnx_models[model_name] = model
                                logger.info(f"✓ Loaded fallback model: {model_name}")
                        except Exception as e:
                            logger.warning(f"Failed to load model {model_name}: {e}")

                    if len(self._onnx_models) < 2:
                        logger.warning(
                            f"Fallback mode enabled but only {len(self._onnx_models)} models loaded. "
                            "Falling back to single model mode."
                        )
                        # Use first available model as single model fallback
                        if self._onnx_models:
                            self._onnx_ranker = list(self._onnx_models.values())[0]
                except Exception as e:
                    logger.error(f"Failed to initialize fallback models: {e}")
                    self._onnx_ranker = None
            else:
                # Single model mode (current behavior)
                try:
                    self._onnx_ranker = get_onnx_ranker_model(
                        model_name=self.config.local_model,
                        device=self.config.local_device
                    )
                    if self._onnx_ranker:
                        logger.info(f"ONNX ranker model initialized: {self.config.local_model}")
                except Exception as e:
                    logger.warning(f"Failed to initialize ONNX ranker: {e}")
                    self._onnx_ranker = None

        # Initialize Groq bridge if using Groq provider
        if self.config.can_use_groq:
            try:
                # Import Groq bridge dynamically to avoid hard dependency
                import sys
                from pathlib import Path
                # Add scripts directory to path for import
                scripts_path = Path(__file__).parent.parent.parent.parent / 'scripts' / 'utils'
                if scripts_path.exists():
                    sys.path.insert(0, str(scripts_path))
                    from groq_agent_bridge import GroqAgentBridge
                    self._groq_bridge = GroqAgentBridge(api_key=self.config.groq_api_key)
                    logger.info("Groq bridge initialized successfully")
            except Exception as e:
                logger.warning(f"Failed to initialize Groq bridge: {e}")
                self._groq_bridge = None

        self._initialized = True

    async def evaluate_quality(self, query: str, memory: Memory) -> float:
        """
        Evaluate memory quality using multi-tier approach.

        Args:
            query: Search query for context
            memory: Memory object to evaluate

        Returns:
            Quality score between 0.0 and 1.0
        """
        self._ensure_initialized()

        if not self.config.enabled:
            # Quality system disabled, return neutral score
            return 0.5

        # Capture the store-time heuristic score before any tier below can
        # overwrite memory.metadata — if no AI tier produces a real score,
        # this is preserved instead of being silently discarded in favor of
        # a weaker implicit-only result (the pre-store gate trusts this
        # heuristic score; the async evaluation shouldn't erase it).
        existing_score = memory.metadata.get('quality_score')
        existing_provider = memory.metadata.get('quality_provider')

        # Try tiers in order based on configuration
        provider_used = None
        score = None

        # Tier 1: Local ONNX (if available)
        if self.config.ai_provider in ['local', 'auto']:
            # Check if fallback mode enabled with multiple models
            if self.config.fallback_enabled and len(self._onnx_models) >= 2:
                try:
                    score, components = self._score_with_fallback(query, memory.content)
                    provider_used = 'fallback_deberta-msmarco'

                    # Store components in metadata for debugging
                    memory.metadata['quality_components'] = components

                    decision = components.get('decision', 'unknown')
                    deberta_s = components.get('deberta_score', 'N/A')
                    msmarco_s = components.get('ms_marco_score', 'N/A')

                    logger.info(
                        f"Fallback score: {score:.3f} ({decision}) - "
                        f"DeBERTa: {deberta_s}, MS-MARCO: {msmarco_s}"
                    )
                except Exception as e:
                    logger.error(f"Fallback scoring failed: {e}, falling back to single model")
                    score = None
            # Single model mode (existing code)
            elif self._onnx_ranker:
                try:
                    score = self._onnx_ranker.score_quality(query, memory.content)
                    if score is None:
                        logger.debug("Local ONNX model cannot score without a query, trying next tier")
                    else:
                        provider_used = 'onnx_local'
                        logger.debug(f"Local ONNX score: {score:.3f}")
                except Exception as e:
                    logger.warning(f"ONNX scoring failed: {e}")
                    score = None
            else:
                score = None

        # Tier 2: OpenAI-compatible endpoint (if configured)
        if score is None and self.config.can_use_openai_compatible:
            try:
                score = await self._score_with_openai_compatible(query, memory)
                provider_used = 'openai_compatible'
                logger.debug(f"OpenAI-compatible score: {score:.3f}")
            except Exception as e:
                logger.warning(f"OpenAI-compatible scoring failed: {e}")
                score = None

        # Tier 3: Groq API (if available and ONNX failed or in auto mode)
        if score is None and self.config.can_use_groq and self._groq_bridge:
            try:
                score = await self._score_with_groq(query, memory)
                provider_used = 'groq'
                logger.debug(f"Groq score: {score:.3f}")
            except Exception as e:
                logger.warning(f"Groq scoring failed: {e}")
                score = None

        # Tier 4: Gemini API (if available and previous tiers failed)
        if score is None and self.config.can_use_gemini:
            try:
                score = await self._score_with_gemini(query, memory)
                provider_used = 'gemini'
                logger.debug(f"Gemini score: {score:.3f}")
            except Exception as e:
                logger.warning(f"Gemini scoring failed: {e}")
                score = None

        # Tier 5: Implicit signals (always available as fallback)
        if score is None:
            implicit_score = self._implicit_evaluator.evaluate_quality(memory, query)
            if existing_provider == 'heuristic' and existing_score is not None:
                # No AI tier could score this — preserve the store-time
                # heuristic assessment rather than replacing it outright.
                score = (existing_score + implicit_score) / 2
                provider_used = 'heuristic+implicit'
                logger.debug(
                    f"No AI tier available; blended heuristic ({existing_score:.3f}) "
                    f"+ implicit ({implicit_score:.3f}) = {score:.3f}"
                )
            else:
                score = implicit_score
                provider_used = 'implicit_signals'
                logger.debug(f"Implicit signals score: {score:.3f}")

        # Store provider information in memory metadata
        memory.metadata['quality_provider'] = provider_used

        return score

    async def evaluate_quality_batch(self, query: str, memories: List[Memory]) -> List[float]:
        """
        Evaluate quality for multiple memories in a single batch.

        Uses batched ONNX inference for local tiers. Non-ONNX tiers
        (Groq/Gemini/implicit) fall back to sequential evaluation.

        Args:
            query: Search query for context
            memories: List of Memory objects to evaluate

        Returns:
            List of quality scores between 0.0 and 1.0
        """
        self._ensure_initialized()

        if not memories:
            return []

        if not self.config.enabled:
            return [0.5] * len(memories)

        # Tier 1: Local ONNX batched scoring
        if self.config.ai_provider in ['local', 'auto']:
            # Fallback mode with multiple models
            if self.config.fallback_enabled and len(self._onnx_models) >= 2:
                try:
                    return self._score_with_fallback_batch(query, memories)
                except Exception as e:
                    logger.error(f"Batch fallback scoring failed: {e}")
            # Single model mode
            elif self._onnx_ranker:
                try:
                    pairs = [(query, m.content) for m in memories]
                    scores = self._onnx_ranker.score_quality_batch(pairs)
                    for memory, score in zip(memories, scores):
                        memory.metadata['quality_provider'] = 'onnx_local'
                    return scores
                except Exception as e:
                    logger.warning(f"Batch ONNX scoring failed: {e}")

        # Fall back to sequential for non-ONNX tiers or on error
        logger.debug("Falling back to sequential evaluation for batch")
        return await asyncio.gather(*(self.evaluate_quality(query, m) for m in memories))

    def _score_with_fallback_batch(
        self, query: str, memories: List[Memory]
    ) -> List[float]:
        """
        Batch version of _score_with_fallback.

        DeBERTa scores all items first. Items below threshold get
        a second-pass MS-MARCO score.
        """
        deberta = self._onnx_models.get('nvidia-quality-classifier-deberta')
        ms_marco = self._onnx_models.get('ms-marco-MiniLM-L-6-v2')

        if not deberta:
            return [0.5] * len(memories)

        # Step 1: Batch DeBERTa score for all items
        deberta_pairs = [("", m.content) for m in memories]
        deberta_scores = deberta.score_quality_batch(deberta_pairs)

        deberta_threshold = self.config.deberta_threshold
        final_scores = list(deberta_scores)

        # Step 2: Find items below threshold that need MS-MARCO rescue
        if ms_marco:
            low_indices = [
                i for i, s in enumerate(deberta_scores) if s < deberta_threshold
            ]
            if low_indices:
                msmarco_pairs = [("", memories[i].content) for i in low_indices]
                msmarco_scores = ms_marco.score_quality_batch(msmarco_pairs)

                ms_marco_threshold = self.config.ms_marco_threshold
                for idx, ms_score in zip(low_indices, msmarco_scores):
                    if ms_score >= ms_marco_threshold:
                        final_scores[idx] = ms_score
                        memories[idx].metadata['quality_components'] = {
                            'deberta_score': deberta_scores[idx],
                            'ms_marco_score': ms_score,
                            'decision': 'ms_marco_rescue',
                        }
                    else:
                        memories[idx].metadata['quality_components'] = {
                            'deberta_score': deberta_scores[idx],
                            'ms_marco_score': ms_score,
                            'decision': 'both_low',
                        }

        for memory in memories:
            memory.metadata['quality_provider'] = 'fallback_deberta-msmarco'

        return final_scores

    def _get_httpx_client(self) -> httpx.AsyncClient:
        """Lazy-init a shared httpx.AsyncClient with a connection pool.

        Reused across scoring calls so batches don't pay TCP/TLS handshake cost
        per request. Closed via `aclose()`.
        """
        if self._httpx_client is None:
            # httpx defaults to the bundled certifi CA list, not the system
            # trust store — internal Caddy-issued certs (e.g. llm-proxy.k-lab.lan)
            # need the system bundle explicitly, same fix this homelab has
            # needed for every other Python service hitting an internal
            # Caddy endpoint (obsidian-daily-notes, local-deep-research).
            verify = os.getenv('SSL_CERT_FILE') or os.getenv('REQUESTS_CA_BUNDLE') or True
            self._httpx_client = httpx.AsyncClient(
                timeout=self.config.openai_compat_timeout, verify=verify
            )
        return self._httpx_client

    async def aclose(self) -> None:
        """Close the shared httpx client. Safe to call multiple times."""
        if self._httpx_client is not None:
            await self._httpx_client.aclose()
            self._httpx_client = None

    async def _score_with_openai_compatible(self, query: str, memory: Memory) -> float:
        """
        Score quality using any OpenAI-compatible /v1/chat/completions endpoint.

        Works with LiteLLM proxy, Ollama, vLLM, MLX-LM server, or any server
        that implements the OpenAI chat completions API shape.

        Args:
            query: Search query
            memory: Memory to score

        Returns:
            Quality score between 0.0 and 1.0

        Raises:
            RuntimeError: On HTTP errors or unparseable responses (caller falls through to next tier)
        """
        base_url = (self.config.openai_compat_base_url or "").rstrip("/")
        model = self.config.openai_compat_model
        api_key = self.config.openai_compat_api_key or "none"

        prompt = self._create_scoring_prompt(query, memory.content)

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        }
        payload = {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": _SCORING_SYSTEM_MESSAGE,
                },
                {"role": "user", "content": prompt},
            ],
        }
        # OpenAI's gpt-5.x family rejects `max_tokens` and custom `temperature`
        # (HTTP 400 "Unsupported parameter"). Reasoning variants also need extra
        # headroom for internal reasoning tokens before emitting the score (#797).
        if model.startswith("gpt-5"):
            payload["max_completion_tokens"] = 800
        else:
            payload["max_tokens"] = 50
            # 0, not 0.1 — these scores feed quality-boosted search ranking and
            # consolidation retention tiers, which assume the same content
            # scores the same way across calls (#174).
            payload["temperature"] = 0
            # Reasoning-capable models (behind proxies like llm-proxy, whose
            # failover target can change without this config knowing) can burn
            # the whole 50-token budget on chain-of-thought before emitting a
            # score, leaving nothing to parse. Harmless no-op on backends that
            # don't recognize the field (unrecognized JSON keys are ignored).
            payload["reasoning_effort"] = "none"

        client = self._get_httpx_client()
        try:
            response = await client.post(
                f"{base_url}/chat/completions",
                headers=headers,
                json=payload,
            )
            response.raise_for_status()
            data = response.json()
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(
                f"OpenAI-compatible endpoint returned HTTP {exc.response.status_code}: {exc.response.text[:200]}"
            ) from exc
        except httpx.RequestError as exc:
            raise RuntimeError(f"OpenAI-compatible endpoint request failed: {exc}") from exc

        # Extract text from standard OpenAI response shape
        try:
            response_text = data["choices"][0]["message"]["content"].strip()
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError(f"Unexpected response shape from endpoint: {data}") from exc

        # Parse float and clamp to [0, 1]
        try:
            score = _parse_score(response_text)
            return max(0.0, min(1.0, score))
        except ValueError:
            raise RuntimeError(
                f"Could not parse score from openai-compatible response: {response_text!r}"
            )

    async def _score_with_groq(self, query: str, memory: Memory) -> float:
        """
        Score quality using Groq API with model fallback chain.

        Tries models in order, falling back on 429 rate limit errors
        or unparseable responses:
        1. moonshotai/kimi-k2-instruct (richer comprehension, 1T MoE)
        2. llama-3.1-8b-instant (faster, independent quota)

        Args:
            query: Search query
            memory: Memory to score

        Returns:
            Quality score between 0.0 and 1.0
        """
        if not self._groq_bridge:
            raise RuntimeError("Groq bridge not initialized")

        prompt = self._create_scoring_prompt(query, memory.content)
        models = ["moonshotai/kimi-k2-instruct", "llama-3.1-8b-instant"]

        last_error = None
        for model in models:
            result = self._groq_bridge.call_model(
                prompt=prompt,
                model=model,
                max_tokens=50,
                temperature=0,
                system_message=_SCORING_SYSTEM_MESSAGE,
            )

            if result["status"] != "success":
                error_msg = result.get("error", "Unknown error")
                if "429" in str(error_msg):
                    logger.warning(f"Groq rate limit on {model}, trying next model")
                    last_error = error_msg
                    continue
                raise RuntimeError(f"Groq API error: {error_msg}")

            # Parse score from response
            response_text = result["response"].strip()
            try:
                score = _parse_score(response_text)
                return max(0.0, min(1.0, score))
            except ValueError:
                logger.warning(f"Could not parse Groq score from {model}: {response_text}")
                last_error = f"Invalid score format from {model}: {response_text}"
                continue

        raise RuntimeError(f"All Groq models rate-limited: {last_error}")

    async def _score_with_gemini(self, query: str, memory: Memory) -> float:
        """
        Score quality using Gemini API.

        Args:
            query: Search query
            memory: Memory to score

        Returns:
            Quality score between 0.0 and 1.0
        """
        # Placeholder for Gemini integration
        # This would use Gemini CLI or API similar to Groq
        # TODO: use _create_scoring_prompt(query, memory.content) to handle empty queries
        logger.warning("Gemini scoring not yet implemented")
        raise NotImplementedError("Gemini scoring tier not yet implemented")

    def _score_with_fallback(
        self,
        query: str,
        memory_content: str
    ) -> tuple[float, dict]:
        """
        Score using fallback approach: DeBERTa primary, MS-MARCO rescue.

        Logic:
        1. Always score with DeBERTa first
        2. If DeBERTa >= threshold → use DeBERTa (confident)
        3. Else score with MS-MARCO:
           - If MS-MARCO >= threshold → use MS-MARCO (rescue technical content)
           - Else → use DeBERTa (both agree it's low)

        Args:
            query: Search query (may be empty for DeBERTa)
            memory_content: Memory content to score

        Returns:
            Tuple of (final_score, components_dict)
        """
        # Get model references
        deberta = self._onnx_models.get('nvidia-quality-classifier-deberta')
        ms_marco = self._onnx_models.get('ms-marco-MiniLM-L-6-v2')

        if not deberta:
            logger.error("DeBERTa model not loaded for fallback scoring")
            return 0.5, {'error': 'DeBERTa not available'}

        # Step 1: Always score with DeBERTa first
        try:
            deberta_score = deberta.score_quality("", memory_content)
            logger.debug(f"DeBERTa score: {deberta_score:.3f}")
        except Exception as e:
            logger.error(f"DeBERTa scoring failed: {e}")
            return 0.5, {'error': str(e)}

        # Step 2: If DeBERTa confident (high score), use it
        deberta_threshold = self.config.deberta_threshold
        if deberta_score >= deberta_threshold:
            logger.debug(
                f"DeBERTa confident ({deberta_score:.3f} >= {deberta_threshold}), using DeBERTa"
            )
            return deberta_score, {
                'final_score': deberta_score,
                'deberta_score': deberta_score,
                'ms_marco_score': None,
                'decision': 'deberta_confident'
            }

        # Step 3: DeBERTa scored low - try MS-MARCO rescue
        if not ms_marco:
            logger.warning("MS-MARCO not loaded, cannot rescue low DeBERTa score")
            return deberta_score, {
                'final_score': deberta_score,
                'deberta_score': deberta_score,
                'ms_marco_score': None,
                'decision': 'deberta_only'
            }

        try:
            # MS-MARCO is a cross-encoder: it scores query-document relevance,
            # not absolute quality, and cannot score at all without a query.
            # score_quality() returns None in that case — treat it the same
            # as a scoring failure and stick with DeBERTa's result.
            ms_marco_score = ms_marco.score_quality("", memory_content)
            if ms_marco_score is None:
                logger.debug("MS-MARCO cannot score without a query, using DeBERTa only")
                return deberta_score, {
                    'final_score': deberta_score,
                    'deberta_score': deberta_score,
                    'ms_marco_score': None,
                    'decision': 'ms_marco_unscoreable'
                }
            logger.debug(f"MS-MARCO score: {ms_marco_score:.3f}")
        except Exception as e:
            logger.error(f"MS-MARCO scoring failed: {e}")
            return deberta_score, {
                'final_score': deberta_score,
                'deberta_score': deberta_score,
                'ms_marco_score': None,
                'decision': 'ms_marco_failed'
            }

        # Step 4: Check if MS-MARCO thinks it's good (technical content rescue)
        ms_marco_threshold = self.config.ms_marco_threshold
        if ms_marco_score >= ms_marco_threshold:
            logger.info(
                f"Technical content rescue: MS-MARCO {ms_marco_score:.3f} >= {ms_marco_threshold} "
                f"(DeBERTa was {deberta_score:.3f})"
            )
            return ms_marco_score, {
                'final_score': ms_marco_score,
                'deberta_score': deberta_score,
                'ms_marco_score': ms_marco_score,
                'decision': 'ms_marco_rescue'
            }

        # Step 5: Both agree it's low quality, use DeBERTa
        logger.debug(
            f"Both agree low quality: DeBERTa={deberta_score:.3f}, MS-MARCO={ms_marco_score:.3f}"
        )
        return deberta_score, {
            'final_score': deberta_score,
            'deberta_score': deberta_score,
            'ms_marco_score': ms_marco_score,
            'decision': 'both_low'
        }

    def _create_scoring_prompt(self, query: str, memory_content: str) -> str:
        """
        Create a prompt for AI-based quality scoring.

        When query is empty (e.g. during store_memory), uses an absolute
        quality prompt instead of a relevance-based one to avoid the model
        returning 0.0 for missing query context.

        Args:
            query: Search query (may be empty for store operations)
            memory_content: Memory content to score

        Returns:
            Formatted prompt for AI model
        """
        content_preview = memory_content[:_SCORING_CONTENT_CHARS]

        if not query or not query.strip():
            return f"""Rate the absolute quality of this memory content.
Consider: specificity, structure, actionability, completeness.

Use these anchors to calibrate:
0.15 = vague, no structure, nothing a reader could act on
0.50 = specific but incomplete, or unclear how to use it
0.85 = specific, well-structured, and immediately actionable

Respond only with a number between 0.00 and 1.00, to at least two decimal
places (e.g. 0.62, not 0.6).

<memory>
{content_preview}
</memory>

Score:"""

        return f"""Rate the relevance and quality of this memory for the given query.

Use these anchors to calibrate:
0.15 = irrelevant to the query, or low quality even if on-topic
0.50 = related to the query but incomplete or partly off-target
0.85 = directly relevant, specific, and high quality

Respond only with a number between 0.00 and 1.00, to at least two decimal
places (e.g. 0.62, not 0.6).

<query>{query}</query>

<memory>
{content_preview}
</memory>

Score:"""
