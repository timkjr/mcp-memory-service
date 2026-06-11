"""Embedding model configuration — ONNX and model selection."""
import os
import logging

from .base import BASE_DIR

logger = logging.getLogger(__name__)

# ONNX Configuration
USE_ONNX = os.getenv('MCP_MEMORY_USE_ONNX', '').lower() in ('1', 'true', 'yes')
if USE_ONNX:
    logger.info("ONNX embeddings enabled - using PyTorch-free embedding generation")
    # ONNX model cache directory
    ONNX_MODEL_CACHE = os.path.join(BASE_DIR, 'onnx_models')
    os.makedirs(ONNX_MODEL_CACHE, exist_ok=True)

# Embedding model configuration
EMBEDDING_MODEL_NAME = os.getenv('MCP_EMBEDDING_MODEL', 'all-MiniLM-L6-v2')
