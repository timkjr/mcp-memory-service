"""
MCP Memory Service
Copyright (c) 2024 Heinrich Krupp
Licensed under the MIT License. See LICENSE file in the project root for full license text.
"""
"""
Test semantic search functionality of the MCP Memory Service.
"""
import pytest
import pytest_asyncio
import asyncio
from mcp_memory_service.server import MemoryServer
from mcp_memory_service.storage.mixins.embeddings import SENTENCE_TRANSFORMERS_AVAILABLE

pytestmark = pytest.mark.skipif(
    not SENTENCE_TRANSFORMERS_AVAILABLE,
    reason="Requires real embedding model for semantic similarity"
)

@pytest_asyncio.fixture
async def memory_server():
    """Create a test instance of the memory server."""
    server = MemoryServer()
    yield server

@pytest.fixture(autouse=True)
def _skip_if_hash_embeddings(memory_server):
    """Skip semantic search tests when no ML embedding backend is available."""
    storage = getattr(memory_server, 'storage', None)
    if storage and type(getattr(storage, 'embedding_model', None)).__name__ == "_HashEmbeddingModel":
        pytest.skip("Semantic search requires real embeddings (install mcp-memory-service[ml])")

@pytest.mark.asyncio
async def test_semantic_similarity(memory_server):
    """Test semantic similarity scoring."""
    # Store related memories
    memories = [
        "The quick brown fox jumps over the lazy dog",
        "A fast auburn fox leaps above a sleepy canine",
        "A cat chases a mouse"
    ]
    
    for memory in memories:
        await memory_server.store_memory(content=memory)
    
    # Test semantic retrieval
    query = "swift red fox jumping over sleeping dog"
    results = await memory_server.debug_retrieve(
        query=query,
        n_results=2,
        similarity_threshold=0.0  # Get all results with scores
    )
    
    # First two results should be the fox-related memories
    assert len(results) >= 2
    assert all("fox" in result for result in results[:2])
    
@pytest.mark.asyncio
async def test_similarity_threshold(memory_server):
    """Test similarity threshold filtering."""
    await memory_server.store_memory(
        content="Python is a programming language"
    )
    
    # This query is semantically unrelated
    results = await memory_server.debug_retrieve(
        query="Recipe for chocolate cake",
        similarity_threshold=0.8
    )
    
    assert len(results) == 0  # No results above threshold

@pytest.mark.asyncio
async def test_exact_match(memory_server):
    """Test exact match retrieval."""
    test_content = "This is an exact match test"
    await memory_server.store_memory(content=test_content)
    
    results = await memory_server.exact_match_retrieve(
        content=test_content
    )
    
    assert len(results) == 1
    assert results[0] == test_content

@pytest.mark.asyncio
async def test_semantic_ordering(memory_server):
    """Test that results are ordered by semantic similarity."""
    # Store memories with varying relevance
    memories = [
        "Machine learning is a subset of artificial intelligence",
        "Deep learning uses neural networks",
        "A bicycle has two wheels"
    ]
    
    for memory in memories:
        await memory_server.store_memory(content=memory)
    
    query = "What is AI and machine learning?"
    results = await memory_server.debug_retrieve(
        query=query,
        n_results=3,
        similarity_threshold=0.0
    )
    
    # Check ordering
    assert "machine learning" in results[0].lower()
    assert "bicycle" not in results[0].lower()