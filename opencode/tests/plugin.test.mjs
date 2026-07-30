import { test, describe, before, after, mock } from "node:test"
import assert from "node:assert"
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import { _internal } from "../memory-plugin.js"

const {
  isNoisySentence,
  extractProseSentences,
  analyzeSessionMessages,
  detectProjectContext,
  detectMemorySeekingQuery,
  detectValuableContent,
  detectOverrides,
  loadSessionTracker,
  saveSessionTracker,
  cleanupExpiredSessions,
  scoreContent,
  cleanTurnText,
  MEMORY_SEEKING_PATTERNS,
  QUALITY_THRESHOLD,
} = _internal

// ─── isNoisySentence ──────────────────────────────────────────────────

describe("isNoisySentence", () => {
  test("returns true for short text (< 100 chars)", () => {
    assert.strictEqual(isNoisySentence("short"), true)
  })

  test("returns true for JSON-like content", () => {
    assert.strictEqual(isNoisySentence('{"key": "value"}'), true)
  })

  test("returns true for bare URLs", () => {
    assert.strictEqual(isNoisySentence("https://example.com/very/long/path/with/many/segments/12345"), true)
  })

  test("returns true for log lines", () => {
    assert.strictEqual(isNoisySentence("WARN: something went wrong in the pipeline"), true)
    assert.strictEqual(isNoisySentence("ERROR: connection refused to database server"), true)
  })

  test("returns true for git/shell output", () => {
    assert.strictEqual(isNoisySentence("remote: Counting objects: 100% (42/42), done."), true)
  })

  test("returns true for RSS feed fragments", () => {
    assert.strictEqual(isNoisySentence('at_medium="email" at_campaign="newsletter" feed="rss"'), true)
  })

  test("returns true for markdown headings and list items", () => {
    assert.strictEqual(isNoisySentence("# This is a heading that is long enough"), true)
    assert.strictEqual(isNoisySentence("- This is a list item that is long enough to test"), true)
    assert.strictEqual(isNoisySentence("> This is a blockquote that is long enough to check"), true)
  })

  test("returns true for mostly-quoted short text", () => {
    assert.strictEqual(isNoisySentence('He said "hello" and "goodbye" in the same breath'), true)
  })

  test("returns false for real prose (100+ chars, no noise patterns)", () => {
    const prose = "We decided to use SQLite-vec as the primary storage backend because it offers the best performance for single-user deployments without requiring a separate database server."
    assert.strictEqual(isNoisySentence(prose), false)
  })
})

// ─── extractProseSentences ───────────────────────────────────────────

describe("extractProseSentences", () => {
  test("extracts clean sentences from prose", () => {
    const input = "We decided to use FastAPI for the API layer because it offers excellent async support and automatic OpenAPI documentation generation out of the box. The reason is that async Python is significantly more efficient for I/O-bound workloads compared to traditional synchronous frameworks. We learned that Pydantic v2 is substantially faster than v1 for data validation and serialization in production benchmarks."
    const sentences = extractProseSentences(input)
    assert.ok(sentences.length >= 2, `expected >= 2 sentences, got ${sentences.length}: ${JSON.stringify(sentences)}`)
    assert.ok(sentences.some(s => s.includes("FastAPI")))
  })

  test("filters out code blocks", () => {
    const input = "Here is the implementation:\n```python\ndef foo(): pass\n```\nThis is the conclusion."
    const sentences = extractProseSentences(input)
    assert.ok(sentences.every(s => !s.includes("def foo")))
  })

  test("filters markdown structural elements", () => {
    const input = "# Heading\n\nThis is substantive content about the architecture decision and why we chose PostgreSQL over MySQL for the primary database.\n\n| Table | Row |\n|-------|-----|\n\nThe key takeaway is that horizontal scaling was the deciding factor in this decision."
    const sentences = extractProseSentences(input)
    assert.ok(sentences.every(s => !s.startsWith("#")), "headings should be filtered")
    assert.ok(sentences.every(s => !s.startsWith("|")), "table rows should be filtered")
  })
})

// ─── detectOverrides ─────────────────────────────────────────────────

describe("detectOverrides", () => {
  test("detects #skip", () => {
    assert.strictEqual(detectOverrides("do not save this #skip").forceSkip, true)
    assert.strictEqual(detectOverrides("normal message").forceSkip, false)
  })

  test("detects #remember", () => {
    assert.strictEqual(detectOverrides("save this #remember").forceRemember, true)
    assert.strictEqual(detectOverrides("normal message").forceRemember, false)
  })

  test("returns false for null/undefined input", () => {
    assert.strictEqual(detectOverrides(null).forceSkip, false)
    assert.strictEqual(detectOverrides(undefined).forceSkip, false)
  })
})

// ─── detectValuableContent ──────────────────────────────────────────

describe("detectValuableContent", () => {
  const config = {
    autoCapture: {
      minMessageLength: 50,
      minSentenceLength: 20,
      patterns: ["decision", "error", "learning", "implementation", "important"],
    },
  }

  test("detects decision patterns", () => {
    const result = detectValuableContent("We decided to use SQLite-vec for the storage backend because it is faster for local deployments and requires no external dependencies.", config)
    assert.strictEqual(result.isValuable, true)
    assert.strictEqual(result.memoryType, "decision")
  })

  test("detects learning patterns", () => {
    const result = detectValuableContent("We discovered that the ONNX runtime is significantly faster when using int8 quantization rather than fp16 for embedding models on CPU.", config)
    assert.strictEqual(result.isValuable, true)
    assert.strictEqual(result.memoryType, "learning")
  })

  test("detects error patterns", () => {
    const result = detectValuableContent("We fixed a bug where the SQLite connection was timing out under load because the WAL mode wasn't properly configured in the connection pool.", config)
    assert.strictEqual(result.isValuable, true)
    assert.strictEqual(result.memoryType, "error")
  })

  test("returns not valuable for short text", () => {
    const result = detectValuableContent("short", config)
    assert.strictEqual(result.isValuable, false)
  })

  test("returns not valuable for text with no matching patterns", () => {
    const result = detectValuableContent("The sky is blue and the grass is green. The weather is nice today. I like programming.", config)
    assert.strictEqual(result.isValuable, false)
  })
})

// ─── detectMemorySeekingQuery ────────────────────────────────────────

describe("detectMemorySeekingQuery", () => {
  const config = {
    naturalTriggers: {
      enabled: true,
      triggerThreshold: 0.6,
    },
  }

  test("detects 'what did we' queries with multiple patterns", () => {
    const result = detectMemorySeekingQuery("what did we decide about the database schema? check memory for previous decisions on this topic", config)
    assert.ok(result !== null)
    assert.ok(result.confidence >= 0.6, `confidence ${result.confidence} < 0.6`)
  })

  test("detects 'remind me' queries with context signal", () => {
    const result = detectMemorySeekingQuery("remind me what we decided earlier about the database schema and what context was important", config)
    assert.ok(result !== null)
  })

  test("returns null for neutral queries", () => {
    const result = detectMemorySeekingQuery("can you show me the code for this function?", config)
    assert.strictEqual(result, null)
  })

  test("returns null for short text", () => {
    const result = detectMemorySeekingQuery("hi", config)
    assert.strictEqual(result, null)
  })
})

// ─── analyzeSessionMessages ──────────────────────────────────────────

describe("analyzeSessionMessages", () => {
  test("extracts decisions from assistant messages only", () => {
    const messages = [
      { role: "user", content: "What should we use for the database?" },
      { role: "assistant", content: "We decided to use SQLite-vec because it offers the best performance for local single-user deployments and requires no external database server or complex infrastructure to manage separately." },
      { role: "user", content: "Sounds good, let's do it." },
      { role: "assistant", content: "We implemented the SQLite-vec storage backend with proper connection pooling and WAL mode configuration for the database handler module. The integration tests confirm a 40% improvement in query latency compared to the previous file-based approach." },
    ]
    const result = analyzeSessionMessages(messages)
    assert.ok(result.decisions.length > 0, "should find decisions")
    assert.ok(result.codeChanges.length > 0, "should find code changes")
    assert.ok(result.confidence > 0, "should have confidence > 0")
  })

  test("returns empty analysis for empty messages", () => {
    const result = analyzeSessionMessages([])
    assert.strictEqual(result.topics.length, 0)
    assert.strictEqual(result.confidence, 0)
  })

  test("falls back to all messages when no assistant messages", () => {
    const messages = [
      { role: "user", content: "We decided to go with Python for the project backend." },
    ]
    const result = analyzeSessionMessages(messages)
    assert.ok(result.topics.length >= 0)
  })

  test("filters noisy sentences from analysis", () => {
    const messages = [
      { role: "assistant", content: "```json\n{\"key\": \"value\"}\n```\n\nWe discovered that the real issue was the connection pool size being too small for concurrent requests. Increasing it from 5 to 20 resolved the timeout errors." },
    ]
    const result = analyzeSessionMessages(messages)
    assert.ok(result.insights.length > 0, "should find insight in prose")
    assert.ok(result.insights.every(s => !s.includes('"key"')), "no JSON in results")
  })
})

// ─── scoreContent ───────────────────────────────────────────────────

describe("scoreContent", () => {
  test("returns null when backend unavailable (fail-open)", async () => {
    const config = {
      memoryService: { endpoint: "http://127.0.0.1:1", timeoutMs: 500 },
    }
    const score = await scoreContent(config, "test content", "note")
    assert.strictEqual(score, null)
  })

  test("QUALITY_THRESHOLD is 0.25", () => {
    assert.strictEqual(QUALITY_THRESHOLD, 0.25)
  })
})

// ─── detectProjectContext ────────────────────────────────────────────

describe("detectProjectContext", () => {
  test("detects JavaScript project from package.json", async () => {
    const dir = join(tmpdir(), `test-project-${Date.now()}`)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "package.json"), JSON.stringify({
      dependencies: { express: "^4.0.0", react: "^18.0.0" },
    }))

    const ctx = await detectProjectContext(dir)
    assert.strictEqual(ctx.language, "JavaScript")
    assert.ok(ctx.frameworks.includes("express"))
    assert.ok(ctx.frameworks.includes("react"))

    await unlink(join(dir, "package.json")).catch(() => {})
  })

  test("detects Python project from pyproject.toml", async () => {
    const dir = join(tmpdir(), `test-py-${Date.now()}`)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "pyproject.toml"), `[project]
name = "test"
requires-python = ">=3.11"
`)

    const ctx = await detectProjectContext(dir)
    assert.strictEqual(ctx.language, "Python")

    await unlink(join(dir, "pyproject.toml")).catch(() => {})
  })

  test("returns defaults for unknown project", async () => {
    const ctx = await detectProjectContext("/nonexistent")
    assert.strictEqual(ctx.language, "Unknown")
    assert.strictEqual(ctx.git.branch, null)
  })
})

// ─── Session Tracker ─────────────────────────────────────────────────

describe("session tracker persistence", () => {
  const testPath = join(tmpdir(), `test-tracker-${Date.now()}.json`)

  after(async () => {
    await unlink(testPath).catch(() => {})
  })

  test("loadSessionTracker returns valid structure", async () => {
    const tracker = await loadSessionTracker()
    assert.ok(Array.isArray(tracker.sessions))
    assert.ok(typeof tracker.threads === "object")
  })

  test("save and reload preserves data", async () => {
    const data = { sessions: [{ id: "s1", project: "test" }], threads: {} }
    await saveSessionTracker(data)
    const reloaded = await loadSessionTracker()
    assert.strictEqual(reloaded.sessions.length, 1)
    assert.strictEqual(reloaded.sessions[0].id, "s1")
  })

  test("cleanupExpiredSessions removes old sessions", () => {
    const old = new Date(Date.now() - 60 * 86400000).toISOString()
    const fresh = new Date().toISOString()
    const tracker = {
      sessions: [
        { id: "old", startTime: old },
        { id: "new", startTime: fresh },
      ],
    }
    cleanupExpiredSessions(tracker)
    assert.strictEqual(tracker.sessions.length, 1)
    assert.strictEqual(tracker.sessions[0].id, "new")
  })
})

// ─── cleanTurnText ───────────────────────────────────────────────────

describe("cleanTurnText", () => {
  test("is exported from _internal", () => {
    assert.strictEqual(typeof cleanTurnText, "function")
  })

  test("strips code blocks", () => {
    const input = "Before\n```js\nconst x = 1;\n```\nAfter the code."
    const result = cleanTurnText(input, 500)
    assert.ok(!result.includes("const x"), "code block content should be removed")
    assert.ok(result.includes("Before") && result.includes("After"))
  })

  test("strips markdown headers", () => {
    const input = "## Repository Report\n\nSome prose here about the findings."
    const result = cleanTurnText(input, 500)
    assert.ok(!result.includes("##"), "headers should be stripped")
    assert.ok(result.includes("Some prose here"))
  })

  test("truncates to maxLen", () => {
    const result = cleanTurnText("a".repeat(1000), 200)
    assert.ok(result.length <= 200)
  })
})

// ─── analyzeSessionMessages — echoed output guard ───────────────────

describe("analyzeSessionMessages echoed-output guard", () => {
  test("markdown-structured report does not produce high confidence", () => {
    // Simulate Claude echoing back file/tool output as a structured report.
    // Before fix: patterns like "fixed", "implemented", "added" inside the
    // report body would match and push confidence to 1.0.
    const messages = [
      {
        role: "assistant",
        content: [
          "## Repository Hook Infrastructure Report",
          "",
          "### HOOKS DIRECTORIES FOUND",
          "",
          "Three distinct hooks locations were found:",
          "",
          "**A. `/home/timkjr/dev/mcp-memory/claude-hooks/`**",
          "This is the primary directory. All hooks were added and implemented here.",
          "The service was configured and deployed. Bugs were fixed and the module was refactored.",
          "",
          "**B. `/home/timkjr/.claude/hooks/`**",
          "Installed copy. Updated and synced from source. The handler was migrated.",
          "",
          "**C. `/mnt/nas/claude/hooks-canonical/`**",
          "NFS distribution copy. Files were implemented and configured for distribution.",
        ].join("\n"),
      },
    ]
    const result = analyzeSessionMessages(messages)
    assert.ok(
      result.confidence < 0.5,
      `Echoed tool-output report should have confidence < 0.5, got ${result.confidence}`,
    )
  })

  test("genuine insight text still produces high confidence", () => {
    const messages = [
      {
        role: "assistant",
        content: "We discovered that the root cause was the connection pool being exhausted under concurrent load. The fix was increasing the pool size from 5 to 20 connections. We decided to also add a circuit breaker so the service degrades gracefully when the database is unavailable. The implementation uses a simple token-bucket algorithm in the connection manager module.",
      },
    ]
    const result = analyzeSessionMessages(messages)
    assert.ok(result.confidence >= 0.5, `Genuine insight should have confidence >= 0.5, got ${result.confidence}`)
  })
})

// ─── Memory Seeking Patterns (coverage validation) ──────────────────

describe("MEMORY_SEEKING_PATTERNS", () => {
  test("each pattern compiles and has 1+ match", () => {
    for (const pattern of MEMORY_SEEKING_PATTERNS) {
      assert.ok(pattern instanceof RegExp, "patterns should be RegExp")
    }
  })
})
