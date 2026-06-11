"""Configuration validation — cross-field constraints."""
import os
import logging

logger = logging.getLogger(__name__)

# =============================================================================
# Configuration Validation
# =============================================================================

def validate_config() -> list:
    """
    Validate cross-field configuration constraints.

    Returns a list of warning/error message strings. Empty list means config is valid.
    Does not raise — callers decide how to handle issues (warn vs. fatal).

    Call at server startup after config module is loaded::

        warnings = validate_config()
        if warnings:
            for w in warnings:
                logger.warning(w)
    """
    # Import at call time from the package so that monkeypatched values are picked up
    import mcp_memory_service.config as cfg

    issues = []

    # HTTPS: cert and key files required when HTTPS is enabled
    if cfg.HTTPS_ENABLED:
        if not cfg.SSL_CERT_FILE:
            issues.append(
                "MCP_HTTPS_ENABLED=true but MCP_SSL_CERT_FILE is not set. "
                "Provide a valid SSL certificate file path."
            )
        elif not os.path.isfile(cfg.SSL_CERT_FILE):
            issues.append(
                f"MCP_SSL_CERT_FILE='{cfg.SSL_CERT_FILE}' does not exist or is not a file."
            )
        if not cfg.SSL_KEY_FILE:
            issues.append(
                "MCP_HTTPS_ENABLED=true but MCP_SSL_KEY_FILE is not set. "
                "Provide a valid SSL private key file path."
            )
        elif not os.path.isfile(cfg.SSL_KEY_FILE):
            issues.append(
                f"MCP_SSL_KEY_FILE='{cfg.SSL_KEY_FILE}' does not exist or is not a file."
            )

    # Hybrid search weights: warn if original env vars didn't sum to ~1.0
    # (config auto-normalizes, but user should know their config needed correction)
    try:
        raw_keyword = float(os.getenv('MCP_HYBRID_KEYWORD_WEIGHT', '0.3'))
        raw_semantic = float(os.getenv('MCP_HYBRID_SEMANTIC_WEIGHT', '0.7'))
        raw_sum = raw_keyword + raw_semantic
        if abs(raw_sum - 1.0) > 0.01:
            issues.append(
                f"MCP_HYBRID_KEYWORD_WEIGHT ({raw_keyword}) + "
                f"MCP_HYBRID_SEMANTIC_WEIGHT ({raw_semantic}) = {raw_sum:.3f}, "
                f"expected 1.0 (±0.01). Weights were auto-normalized at startup."
            )
    except (TypeError, ValueError):
        pass  # Invalid floats already handled by module-level validation

    return issues
