import { readFileSync, writeFileSync } from "node:fs"
import { mkdir, readFile as readFileP, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import http from "node:http"
import https from "node:https"
import path from "node:path"
import { execSync } from "node:child_process"

const STATUS_FILE = process.env.OPENCODE_MEMORY_STATUS_FILE
  || path.join(homedir(), ".local", "state", "opencode", ".memory-status.json")

process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED || "0"

const tlsAgent = new https.Agent({ rejectUnauthorized: false })

function httpsFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const { method = "GET", headers = {}, body, signal } = options
    const parsed = new URL(url)

    const isHttps = parsed.protocol === "https:"
    const req = (isHttps ? https : http).request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers,
        agent: isHttps ? tlsAgent : undefined,
        signal,
      },
      (res) => {
        let data = ""
        res.on("data", (chunk) => { data += chunk })
        res.on("end", () => resolve({ status: res.statusCode, statusText: res.statusMessage, text: () => Promise.resolve(data), ok: res.statusCode >= 200 && res.statusCode < 300 }))
      },
    )
    req.on("error", reject)
    if (body) req.write(body)
    req.end()
  })
}

const AGENT_ID = "opencode"

const DEFAULT_CONFIG = {
  memoryService: {
    endpoint: "http://127.0.0.1:8000",
    apiKey: "",
    timeoutMs: 5000,
    loadTimeoutMs: 2500,
    maxMemoriesPerSession: 8,
    searchTags: [],
    includeProjectTag: false,
    projectQueries: [
      "{project} architecture decisions",
      "{project} recent work",
      "{project} open issues",
    ],
  },
  output: {
    verbose: true,
    includeTimestamps: true,
    maxContentLength: 280,
  },
  autoCapture: {
    enabled: true,
    minMessageLength: 300,
    minSentenceLength: 80,
    maxContentLength: 4000,
    patterns: ["decision", "error", "learning", "implementation", "important"],
    tags: ["auto-capture"],
    requireToolUse: true,
    toolUseWindowMs: 120000,
  },
  sessionEnd: {
    enabled: true,
    minSessionLength: 100,
    maxMemoriesPerSession: 3,
    tags: ["opencode-session", "session-summary"],
  },
  harvest: {
    enabled: false,
    dryRunOnFirstUse: true,
    minSessionMessages: 10,
    sessions: 1,
    useLlm: false,
    minConfidence: 0.6,
    types: ["decision", "bug", "convention", "learning", "context"],
  },
  // --- NEW: Natural Memory Triggers (mid-conversation retrieval) ---
  naturalTriggers: {
    enabled: true,
    triggerThreshold: 0.6,
    cooldownPeriod: 30000,
    maxMemoriesPerTrigger: 3,
  },
  // --- NEW: Git-aware context ---
  gitAnalysis: {
    enabled: true,
    commitLookback: 14,
    maxCommits: 20,
    includeChangelog: true,
    maxGitMemories: 3,
    gitContextWeight: 1.2,
  },
  // --- NEW: Memory mode controller ---
  mode: {
    profile: "balanced",
    profiles: {
      speed_focused: {
        maxMemoriesPerSession: 4,
        loadTimeoutMs: 1000,
        naturalTriggersEnabled: false,
        gitAnalysisEnabled: false,
        description: "Fastest response, minimal memory awareness",
      },
      balanced: {
        maxMemoriesPerSession: 8,
        loadTimeoutMs: 2500,
        naturalTriggersEnabled: true,
        gitAnalysisEnabled: true,
        description: "Moderate latency, smart memory triggers",
      },
      memory_aware: {
        maxMemoriesPerSession: 12,
        loadTimeoutMs: 5000,
        naturalTriggersEnabled: true,
        gitAnalysisEnabled: true,
        description: "Full memory awareness, accept higher latency",
      },
    },
  },
}

function parseInteger(value) {
  if (typeof value !== "string" || !value.trim()) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function environmentOverrides() {
  const overrides = {
    memoryService: {},
  }

  const endpoint = process.env.OPENCODE_MEMORY_ENDPOINT || process.env.OPENCODE_MEMORY_URL
  if (endpoint) {
    overrides.memoryService.endpoint = endpoint
  }

  const apiKey = process.env.OPENCODE_MEMORY_API_KEY
  if (apiKey) {
    overrides.memoryService.apiKey = apiKey
  }

  const timeoutMs = parseInteger(process.env.OPENCODE_MEMORY_TIMEOUT_MS)
  if (timeoutMs !== undefined) {
    overrides.memoryService.timeoutMs = timeoutMs
  }

  const loadTimeoutMs = parseInteger(process.env.OPENCODE_MEMORY_LOAD_TIMEOUT_MS)
  if (loadTimeoutMs !== undefined) {
    overrides.memoryService.loadTimeoutMs = loadTimeoutMs
  }

  const mode = process.env.OPENCODE_MEMORY_MODE
  if (mode) {
    overrides.mode = { profile: mode }
  }

  return overrides
}

function mergeConfig(base, overrides = {}) {
  return {
    ...base,
    ...overrides,
    memoryService: {
      ...base.memoryService,
      ...(overrides.memoryService || {}),
    },
    output: {
      ...base.output,
      ...(overrides.output || {}),
    },
    autoCapture: {
      ...base.autoCapture,
      ...(overrides.autoCapture || {}),
      patterns: overrides.autoCapture?.patterns ?? base.autoCapture.patterns,
    },
    sessionEnd: {
      ...base.sessionEnd,
      ...(overrides.sessionEnd || {}),
    },
    harvest: {
      ...base.harvest,
      ...(overrides.harvest || {}),
    },
    naturalTriggers: {
      ...base.naturalTriggers,
      ...(overrides.naturalTriggers || {}),
    },
    gitAnalysis: {
      ...base.gitAnalysis,
      ...(overrides.gitAnalysis || {}),
    },
    mode: {
      ...base.mode,
      ...(overrides.mode || {}),
      profiles: {
        ...base.mode?.profiles,
        ...(overrides.mode?.profiles || {}),
      },
    },
  }
}

function pluginConfigPaths(directory, options = {}) {
  const configDir = path.join(homedir(), ".config", "opencode")
  const paths = [
    typeof options.configPath === "string" ? options.configPath : "",
    process.env.OPENCODE_MEMORY_PLUGIN_CONFIG || "",
    path.join(configDir, "memory-plugin.json"),
    path.join(configDir, "memory-awareness.json"),
  ]
  if (directory) {
    paths.push(
      path.join(directory, ".opencode", "memory-plugin.json"),
      path.join(directory, ".opencode", "memory-awareness.json"),
    )
  }
  return paths.filter(Boolean)
}

async function loadConfig(directory) {
  let config = DEFAULT_CONFIG

  for (const configPath of pluginConfigPaths(directory)) {
    try {
      const raw = await readFileP(configPath, "utf8")
      const parsed = JSON.parse(raw)
      config = mergeConfig(config, parsed)
      break
    } catch {
      // Keep searching for a readable config file.
    }
  }

  config = mergeConfig(config, environmentOverrides())

  const profile = config.mode?.profiles?.[config.mode?.profile]
  if (profile) {
    if (profile.maxMemoriesPerSession !== undefined) config.memoryService.maxMemoriesPerSession = profile.maxMemoriesPerSession
    if (profile.loadTimeoutMs !== undefined) config.memoryService.loadTimeoutMs = profile.loadTimeoutMs
    if (profile.naturalTriggersEnabled !== undefined && config.naturalTriggers) config.naturalTriggers.enabled = profile.naturalTriggersEnabled
    if (profile.gitAnalysisEnabled !== undefined && config.gitAnalysis) config.gitAnalysis.enabled = profile.gitAnalysisEnabled
  }

  return config
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildUrl(baseUrl, pathname) {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  const normalizedPath = pathname.startsWith("/") ? pathname.slice(1) : pathname
  return new URL(normalizedPath, normalizedBase).toString()
}

function buildHeaders(config, extraHeaders = {}) {
  const headers = {
    Accept: "application/json",
    ...extraHeaders,
  }

  if (config.memoryService.apiKey) {
    headers["X-API-Key"] = config.memoryService.apiKey
  }

  return headers
}

async function requestJson(config, pathname, init = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.memoryService.timeoutMs)

  try {
    const response = await httpsFetch(buildUrl(config.memoryService.endpoint, pathname), {
      ...init,
      headers: buildHeaders(config, init.headers || {}),
      signal: controller.signal,
    })

    const text = await response.text()
    let body = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = { detail: text }
      }
    }

    if (!response.ok) {
      const detail = body?.detail || body?.error || response.statusText
      throw new Error(`${response.status} ${detail}`)
    }

    return body
  } finally {
    clearTimeout(timeout)
  }
}

function projectNameFromDirectory(directory) {
  return path.basename(directory) || "project"
}

function buildQueries(projectName, config) {
  return config.memoryService.projectQueries
    .map((template) => template.replaceAll("{project}", projectName))
    .filter(Boolean)
}

function normalizeMemory(memory) {
  if (!memory || typeof memory !== "object") return null

  const base = memory.memory && typeof memory.memory === "object" ? memory.memory : memory
  const content = base.content || base.preview || ""
  if (!content) return null

  let createdAt = base.created_at_iso || base.created_at || base.created || undefined
  if (typeof createdAt === "number") {
    const timestamp = createdAt < 4102444800 ? createdAt * 1000 : createdAt
    createdAt = new Date(timestamp).toISOString()
  }

  return {
    id: base.content_hash || base.hash || base.id || content,
    content,
    tags: Array.isArray(base.tags) ? base.tags : [],
    createdAt,
    score: memory.similarity_score || base.similarity_score || base.relevanceScore || 0,
  }
}

function dedupeMemories(memories) {
  const seen = new Set()
  const unique = []

  for (const memory of memories) {
    if (!memory) continue
    if (seen.has(memory.id)) continue
    seen.add(memory.id)
    unique.push(memory)
  }

  return unique
}

function sortMemories(memories) {
  return [...memories].sort((left, right) => {
    if ((right.score || 0) !== (left.score || 0)) {
      return (right.score || 0) - (left.score || 0)
    }

    const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0
    const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0
    return rightTime - leftTime
  })
}

function truncateText(content, maxLength) {
  if (content.length <= maxLength) return content
  return `${content.slice(0, maxLength - 3).trimEnd()}...`
}

function formatTimestamp(memory) {
  if (!memory.createdAt) return ""
  const date = new Date(memory.createdAt)
  if (Number.isNaN(date.getTime())) return ""
  return date.toISOString().slice(0, 10)
}

function formatMemories(projectName, memories, config, options = {}) {
  if (!memories.length) return ""

  const includeHeader = options.includeHeader ?? true
  const limit = options.limit || config.memoryService.maxMemoriesPerSession
  const lines = []

  if (includeHeader) {
    lines.push(`# Memory Context - ${projectName}`)
    lines.push("")
    lines.push("Use this as supporting background only. The current repository state and user instructions take precedence.")
    lines.push("")
  }

  lines.push("## Relevant Memories")

  for (const memory of memories.slice(0, limit)) {
    const timestamp = config.output.includeTimestamps ? formatTimestamp(memory) : ""
    const prefix = timestamp ? `- [${timestamp}] ` : "- "
    lines.push(`${prefix}${truncateText(memory.content.replace(/\s+/g, " ").trim(), config.output.maxContentLength)}`)
  }

  return lines.join("\n")
}

function detectOverrides(content) {
  if (!content) return { forceSkip: false, forceRemember: false }
  const text = typeof content === "string" ? content : JSON.stringify(content)
  return {
    forceSkip: /(?:^|\s)#skip\b/i.test(text),
    forceRemember: /(?:^|\s)#remember\b/i.test(text),
  }
}

function splitSentences(text) {
  const blocks = []
  let lastIndex = 0
  const codeBlockRe = /```[\s\S]*?```/g
  let match
  while ((match = codeBlockRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({ type: "text", content: text.slice(lastIndex, match.index) })
    }
    blocks.push({ type: "code", content: match[0] })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) {
    blocks.push({ type: "text", content: text.slice(lastIndex) })
  }
  return blocks
}

function splitTextSentences(text) {
  const result = []
  const re = /[^.!?\n]+[.!?]+\s*/g
  let match
  while ((match = re.exec(text)) !== null) {
    const s = match[0].trim()
    if (s) result.push(s)
  }
  const remainder = text.replace(re, "").trim()
  if (remainder) result.push(remainder)
  return result.length ? result : [text.trim()].filter(Boolean)
}

// --- Ported from claude-hooks session-end.js ---
function isNoisySentence(sentence) {
  const s = sentence.trim()
  if (s.length < 60) return true
  if (/^\s*[{[\]`]/.test(s)) return true
  if (/"[a-z_]+"\s*:/.test(s)) return true
  if (/https?:\/\/\S{30,}/.test(s) && s.length < 150) return true
  if (/^\s*(Warning|Error|WARN|INFO|DEBUG|FAIL)[\s:]/.test(s)) return true
  if (/Permanently added|remote:\s|\.git\/|stderr|stdout/.test(s)) return true
  if (/\bat_medium=|at_campaign=|feed":|"published":/.test(s)) return true
  if (/^[-*]\s+`/.test(s)) return true
  if ((s.match(/"/g) || []).length > 2 && s.length < 150) return true
  if (/^(That's|Also\s)/i.test(s)) return true
  if (/^#{1,6}\s/.test(s)) return true
  if (/^\|/.test(s)) return true
  if (/^[-*+]\s/.test(s)) return true
  if (/^>\s/.test(s)) return true
  if (/\|.*\|/.test(s)) return true
  return false
}

function cleanTurnText(text, maxLen) {
  const len = maxLen || 1500
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/^\|.*$/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*{1,2}([^*\n]+)\*{1,2}/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, len)
}

function extractProseSentences(text) {
  const prose = text
    .replace(/```[\s\S]*?```/g, '.')
    .replace(/^#{1,6}\s+.*$/gm, '.')
    .replace(/^\|.*$/gm, '.')
    .replace(/^\s*[-*+]\s+(.*)/gm, '$1.')
    .replace(/^\s*\d+\.\s+(.*)/gm, '$1.')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*{1,2}([^*\n]+)\*{1,2}/g, '$1')
  return prose.split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => !isNoisySentence(s))
}

function detectValuableContent(text, config) {
  const patterns = config.autoCapture.patterns || DEFAULT_CONFIG.autoCapture.patterns
  const minLength = config.autoCapture.minMessageLength || DEFAULT_CONFIG.autoCapture.minMessageLength
  const minSentence = config.autoCapture.minSentenceLength || DEFAULT_CONFIG.autoCapture.minSentenceLength
  if (!text || text.length < minLength) return { isValuable: false, reason: "too short", memoryType: null, matchedPattern: null }

  const matchers = {
    decision: /\b(decided to|decision|chose to|will use|going with|opting for|better to|should use)\b/i,
    error: /\b(fixed|resolved|solved|patched|workaround)\b.{0,120}\b(error|bug|issue|problem|crash|exception)\b|\b(error|bug|crash|exception|regression)\b.{0,120}\b(fixed|resolved|solved|patched)\b/i,
    learning: /\b(learned|discovered|realized|turns out|insight|understanding|key finding|important to note)\b/i,
    implementation: /\b(implemented|refactored|extracted|migrated|deployed)\b/i,
    important: /\b(important|critical|notable|significant|worth noting|key takeaway)\b/i,
  }

  const blocks = splitSentences(text)
  const matched = []
  const types = new Set()

  for (const block of blocks) {
    if (block.type === "code") continue
    const sentences = splitTextSentences(block.content)
    for (const sentence of sentences) {
      if (sentence.length < minSentence) continue
      const lower = sentence.toLowerCase()
      for (const [name, regex] of Object.entries(matchers)) {
        if (!patterns.includes(name)) continue
        if (regex.test(lower)) {
          matched.push(sentence)
          types.add(name)
          break
        }
      }
    }
  }

  if (matched.length === 0) {
    return { isValuable: false, reason: "no pattern match", memoryType: null, matchedPattern: null, confidence: 0 }
  }

  const typeOrder = ["decision", "error", "learning", "implementation", "important"]
  const bestType = typeOrder.find((t) => types.has(t)) || [...types][0]
  return { isValuable: true, memoryType: bestType, matchedPattern: "sentence-split", confidence: 0.8, matchedContent: matched.join("\n") }
}

// --- NEW: Memory-seeking query detection (Natural Memory Triggers) ---
const MEMORY_SEEKING_PATTERNS = [
  /\b(what did we|what have we|what was|what about|tell me about|recall|remember|remind me)\b/i,
  /\b(how did we|how was|how does|how do we|how should we)\b.*\b(before|previously|last|earlier|past|old|prior)\b/i,
  /\b(where is|where are|where did we|where do we)\b/i,
  /\b(who is|who was|who did|who has)\b/i,
  /\b(why did we|why was|why is|why does)\b.*\b(decide|choose|pick|select|go with)\b/i,
  /\b(do you know|do we have|have we ever|is there a|are there any)\b.*\b(memory|stored|saved|previous|past|before|decision|reason|context)\b/i,
  /\b(what.*decision|what.*choice|what.*reason|what.*context)\b/i,
  /\b(check.*memory|look.*memory|search.*memory|find.*memory|get.*context)\b/i,
  /\b(load|fetch|retrieve|pull).*memory/i,
  /\b(previous|past|earlier).*(discussion|conversation|session|chat|work|project|task)\b/i,
]

function detectMemorySeekingQuery(text, config) {
  if (!config.naturalTriggers?.enabled) return null

  const trimmed = text.trim()
  if (!trimmed || trimmed.length < 20) return null

  const lower = trimmed.toLowerCase()
  const matches = []

  for (const pattern of MEMORY_SEEKING_PATTERNS) {
    if (pattern.test(lower)) {
      matches.push(pattern)
    }
  }

  if (matches.length === 0) return null

  const confidence = Math.min(1, matches.length / 3)
  if (confidence < config.naturalTriggers.triggerThreshold) return null

  const query = trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed
  return { query, confidence, patternCount: matches.length }
}

// --- NEW: Git-aware context ---
function getRecentCommits(directory, config) {
  if (!config.gitAnalysis?.enabled) return []

  try {
    const maxCount = config.gitAnalysis.maxCommits || 20
    const lookback = config.gitAnalysis.commitLookback || 14
    const since = new Date(Date.now() - lookback * 86400000).toISOString().split("T")[0]
    const raw = execSync(
      `git log --oneline --since="${since}" --max-count=${maxCount} 2>/dev/null`,
      { cwd: directory, encoding: "utf8", timeout: 3000 },
    )
    return raw.trim().split("\n").filter(Boolean).map((line) => {
      const idx = line.indexOf(" ")
      return { hash: line.slice(0, idx || 7), message: line.slice((idx || 0) + 1) }
    })
  } catch {
    return []
  }
}

function extractGitQueries(commits, projectName, config) {
  if (!commits.length) return []

  const queries = new Set()
  const prefixes = ["feat", "fix", "refactor", "perf", "feature", "update", "add", "implement", "change"]

  for (const commit of commits) {
    const msg = commit.message
    const lower = msg.toLowerCase()

    // Use the full commit message if it looks meaningful
    if (msg.length > 10 && !lower.includes("merge") && !lower.includes("wip") && !lower.includes("changelog")) {
      queries.add(msg)
    }

    // Extract topic from conventional commit prefix
    for (const prefix of prefixes) {
      if (lower.startsWith(prefix)) {
        const topic = msg.replace(/^[^(]*\(?([^)]*)\)?\s*:\s*/, "").trim()
        if (topic.length > 5) {
          queries.add(`${projectName} ${topic}`)
        }
        break
      }
    }
  }

  const maxGitMemories = config.gitAnalysis?.maxGitMemories || 3
  return [...queries].slice(0, maxGitMemories)
}

// --- END NEW ---

function analyzeSessionMessages(messages) {
  const analysis = {
    topics: [],
    decisions: [],
    insights: [],
    codeChanges: [],
    nextSteps: [],
    sessionLength: 0,
    confidence: 0,
  }

  if (!messages?.length) return analysis

  // Filter to assistant-only text — user messages and tool output are noise
  const assistantTexts = messages
    .filter(m => m.role === "assistant" || m.role === "model")
    .map(m => m.content || "")
    .filter(Boolean)

  // Fallback: if no assistant messages found, use all (existing behavior)
  const texts = assistantTexts.length > 0 ? assistantTexts : messages.map(m => m.content || "").filter(Boolean)

  const allText = texts.join("\n")
  analysis.sessionLength = allText.length

  const topicMatchers = {
    implementation: /implement|building|create|adding/i,
    debugging: /debug|bug|error|fix|issue|problem/i,
    architecture: /architecture|design|structure|pattern|framework/i,
    performance: /performance|optimization|speed|efficient/i,
    testing: /test|testing|coverage|spec/i,
    deployment: /deploy|production|release|ci/i,
    configuration: /config|setup|environment|settings/i,
    database: /database|schema|migration|query/i,
    api: /api|endpoint|rest|service|interface/i,
    ui: /ui|interface|component|styling/i,
  }
  for (const [topic, re] of Object.entries(topicMatchers)) {
    if (re.test(allText)) analysis.topics.push(topic)
  }

  const decisionPatterns = [/decided to|chose to|going with|will use|opted for|concluded that/i]
  const insightPatterns = [/learned that|turns out|the reason is|the issue was|the fix is|discovered that|realized that/i]
  const codeChangePatterns = [/(added|implemented|refactored|updated|fixed|removed|renamed|migrated)\b.{5,}(file|function|class|component|test|config|endpoint|method|module|hook|script|service|handler|route|middleware|schema|migration|interface|type|enum)/i]
  const nextStepPatterns = [/next step|still need to|todo|follow.?up|will need to|remaining/i]

  for (const text of texts) {
    const sentences = extractProseSentences(cleanTurnText(text))
    for (const sentence of sentences) {
      const lower = sentence.toLowerCase()
      if (decisionPatterns.some(p => p.test(lower))) analysis.decisions.push(sentence)
      if (insightPatterns.some(p => p.test(lower))) analysis.insights.push(sentence)
      if (codeChangePatterns.some(p => p.test(lower))) analysis.codeChanges.push(sentence)
      if (nextStepPatterns.some(p => p.test(lower))) analysis.nextSteps.push(sentence)
    }
  }

  const dedup = arr => [...new Map(arr.map(s => [s.slice(0, 80), s])).values()]
  analysis.decisions = dedup(analysis.decisions).slice(0, 3)
  analysis.insights = dedup(analysis.insights).slice(0, 3)
  analysis.codeChanges = dedup(analysis.codeChanges).slice(0, 4)
  analysis.nextSteps = dedup(analysis.nextSteps).slice(0, 3)

  // Only count substantive items (decisions + insights + code changes) for confidence
  const substantive = analysis.decisions.length + analysis.insights.length + analysis.codeChanges.length
  analysis.confidence = Math.min(1, substantive / 4)

  return analysis
}

function deriveProjectPath(directory) {
  if (!directory) return null
  return directory.split(path.sep).join("-")
}

// Ported from claude-hooks project-detector.js — reads package config for enriched context
async function detectProjectContext(directory) {
  const context = {
    name: projectNameFromDirectory(directory),
    language: "Unknown",
    frameworks: [],
    git: { branch: null, remote: null, lastCommit: null },
  }
  if (!directory) return context

  // Read project config files
  const tryReadSync = (filePath) => {
    try { return readFileSync(filePath, "utf8") } catch { return null }
  }
  const configFiles = [
    { file: "package.json", read: (d) => { const raw = tryReadSync(d); if (!raw) throw new Error("no file"); return JSON.parse(raw) }, map: (j) => { context.language = "JavaScript"; context.frameworks = [...new Set([...Object.keys(j.dependencies || {}), ...Object.keys(j.devDependencies || {})])].filter(k => !k.startsWith("@types/")) } },
    { file: "pyproject.toml", read: (d) => tryReadSync(d), map: (c) => { if (!c) return; if (c.includes("[tool.poetry]") || c.includes("[project]")) context.language = "Python"; if (c.includes("django")) context.frameworks.push("django"); if (c.includes("fastapi")) context.frameworks.push("fastapi"); if (c.includes("flask")) context.frameworks.push("flask") } },
    { file: "Cargo.toml", read: (d) => tryReadSync(d), map: (c) => { if (!c) return; context.language = "Rust" } },
    { file: "go.mod", read: (d) => tryReadSync(d), map: (c) => { if (!c) return; context.language = "Go" } },
    { file: "Gemfile", read: (d) => tryReadSync(d), map: (c) => { if (!c) return; context.language = "Ruby" } },
  ]

  for (const { file, read, map } of configFiles) {
    try {
      const data = read(path.join(directory, file))
      map(data)
      break
    } catch { /* file not found */ }
  }

  // Git info
  try {
    context.git.branch = execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", { cwd: directory, encoding: "utf8", timeout: 2000 }).toString().trim()
    context.git.remote = execSync("git remote get-url origin 2>/dev/null", { cwd: directory, encoding: "utf8", timeout: 2000 }).toString().trim()
    context.git.lastCommit = execSync("git log -1 --oneline 2>/dev/null", { cwd: directory, encoding: "utf8", timeout: 2000 }).toString().trim()
  } catch { /* not a git repo */ }

  return context
}

async function storeMemoryHttp(config, content, tags, memoryType, extra = {}) {
  const metadata = extra.metadata || {}
  const payload = {
    content,
    tags: [...new Set(tags.filter(Boolean).map((t) => String(t).toLowerCase()))],
    memory_type: memoryType || "note",
    metadata: {
      source: "opencode-plugin",
      ...metadata,
      captured_at: new Date().toISOString(),
    },
  }
  // Pass conversation_id for same-session dedup bypass, if provided
  if (extra.conversation_id) {
    payload.conversation_id = extra.conversation_id
  }
  return requestJson(config, "/api/memories", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-ID": "opencode" },
    body: JSON.stringify(payload),
  })
}

async function postHarvest(config, body) {
  return requestJson(config, "/api/harvest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function searchMemories(config, query, tags, limit) {
  const hasTagFilter = tags.length > 0
  const payload = {
    query,
    n_results: hasTagFilter ? Math.max(limit * 4, 20) : limit,
  }

  const result = await requestJson(config, "/api/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })

  const memories = Array.isArray(result)
    ? result
    : Array.isArray(result?.memories)
      ? result.memories
      : Array.isArray(result?.results)
        ? result.results
        : []

  let normalized = memories.map(normalizeMemory).filter(Boolean)

  if (hasTagFilter) {
    const wanted = new Set(tags)
    normalized = normalized.filter((memory) =>
      memory.tags.some((tag) => wanted.has(tag)),
    )
    normalized = normalized.slice(0, limit)
  }

  return normalized
}

async function callMCPTool(config, toolName, toolArgs) {
  try {
    const mcpEndpoint = "/mcp"
    const body = await requestJson(config, mcpEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: toolName, arguments: toolArgs },
        id: 1,
      }),
    })
    const text = body?.result?.content?.[0]?.text || ""
    return text
  } catch {
    return ""
  }
}

async function getBootstrapProfile(config, projectName, taskSummary) {
  const text = await callMCPTool(config, "get_bootstrap_profile", {
    agent_ids: [AGENT_ID],
    project_id: projectName,
    task_summary: taskSummary || `Working on ${projectName}`,
    max_tokens: 2048,
  })
  return text || ""
}

async function commitSession(config, sessionID, projectName, stateData) {
  await callMCPTool(config, "commit_session_legacy", {
    session_id: sessionID,
    agent_id: AGENT_ID,
    task_summary: `Session for ${projectName}`,
    outcome: "success",
    decisions: (stateData?.decisions || []).slice(0, 10),
    errors: (stateData?.errors || []).slice(0, 10),
    user_corrections: (stateData?.userCorrections || []).slice(0, 10),
    belief_updates: (stateData?.beliefUpdates || []).slice(0, 10),
  })
}

async function getHealth(config) {
  try {
    return await requestJson(config, "/api/health/detailed")
  } catch (_) {
    return await requestJson(config, "/api/health")
  }
}

// Quality scoring: scores content before storage to prevent garbage memories
const QUALITY_THRESHOLD = 0.25

async function scoreContent(config, content, memoryType) {
  try {
    const result = await requestJson(config, "/api/quality/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, memory_type: memoryType || "session-summary" }),
    })
    return result?.score ?? result?.quality_score ?? 0.5
  } catch {
    return null
  }
}

function triggerQualityEvaluation(endpoint, contentHash) {
  const url = `${endpoint.replace(/\/+$/, "")}/api/quality/memories/${contentHash}/evaluate`
  httpsFetch(url, { method: "POST", body: "{}" }).catch(() => {})
}

function triggerConsolidation(endpoint) {
  const url = `${endpoint.replace(/\/+$/, "")}/api/consolidation/trigger`
  httpsFetch(url, { method: "POST", body: JSON.stringify({ time_horizon: "daily" }) }).catch(() => {})
}

// --- Cross-session tracking (ported from claude-hooks session-tracker.js) ---
const SESSION_TRACKER_PATH = path.join(homedir(), ".local", "state", "opencode", "session-tracker.json")

async function loadSessionTracker() {
  try {
    const data = await readFileP(SESSION_TRACKER_PATH, "utf8")
    return JSON.parse(data)
  } catch {
    return { sessions: [], threads: {}, lastCleanup: null }
  }
}

async function saveSessionTracker(tracker) {
  try {
    await mkdir(path.dirname(SESSION_TRACKER_PATH), { recursive: true })
    await writeFile(SESSION_TRACKER_PATH, JSON.stringify(tracker, null, 2))
  } catch { /* best-effort */ }
}

function cleanupExpiredSessions(tracker) {
  const cutoff = Date.now() - 30 * 86400000
  const before = tracker.sessions.length
  tracker.sessions = tracker.sessions.filter(s => new Date(s.startTime).getTime() > cutoff)
  if (tracker.sessions.length < before) {
    tracker.lastCleanup = new Date().toISOString()
  }
  return tracker
}

function tagsForProject(projectName, config) {
  const tags = [...config.memoryService.searchTags]
  if (config.memoryService.includeProjectTag) {
    tags.push(projectName)
  }
  return tags
}

async function loadSessionMemories({ config, directory, logInfo, logWarn, healthState }) {
  const projectName = projectNameFromDirectory(directory)
  const tags = tagsForProject(projectName, config)
  const queries = buildQueries(projectName, config)

  // Enrich queries with project context (language, frameworks, git)
  const projectContext = await detectProjectContext(directory)
  if (projectContext.language !== "Unknown") {
    queries.unshift(`${projectName} ${projectContext.language} development`)
  }
  for (const framework of projectContext.frameworks.slice(0, 2)) {
    queries.unshift(`${projectName} ${framework}`)
  }
  if (projectContext.git.branch) {
    queries.unshift(`${projectName} ${projectContext.git.branch} branch`)
  }

  if (config.gitAnalysis?.enabled) {
    const commits = getRecentCommits(directory, config)
    if (commits.length > 0) {
      const gitQueries = extractGitQueries(commits, projectName, config)
      queries.push(...gitQueries)
    }
  }

  const perQueryLimit = Math.max(2, Math.ceil(config.memoryService.maxMemoriesPerSession / Math.max(queries.length, 1)))

  if (!healthState.checked) {
    healthState.checked = true
    try {
      const health = await getHealth(config)
      const backend = health?.storage_backend || health?.backend || "unknown"
      await logInfo(`Memory service connected (${backend})`)
    } catch (error) {
      await logWarn(`Memory service unavailable: ${error.message}`)
    }
  }

  const searchResults = await Promise.allSettled(
    queries.map((query) => searchMemories(config, query, tags, perQueryLimit)),
  )

  const found = []
  for (const [index, result] of searchResults.entries()) {
    if (result.status === "fulfilled") {
      found.push(...result.value)
      continue
    }

    await logWarn(`Memory search failed for "${queries[index]}": ${result.reason?.message || result.reason}`)
  }

  const deduped = sortMemories(dedupeMemories(found)).slice(0, config.memoryService.maxMemoriesPerSession)
  if (deduped.length) {
    await logInfo(`Loaded ${deduped.length} memories for ${projectName}`)
  }

  return {
    projectName,
    memories: deduped,
  }
}

const createPlugin = async ({ directory, client }) => {
  const config = await loadConfig(directory)
  const sessionState = new Map()
  const healthState = { checked: false }
  const harvestFirstRun = { done: false }

  const status = {
    projectName: projectNameFromDirectory(directory),
    loadedCount: 0,
    capturedCount: 0,
    lastAction: "",
    lastSummaryAt: null,
    updatedAt: null,
  }

  const writeStatus = async (patch) => {
    Object.assign(status, patch)
    status.updatedAt = new Date().toISOString()
    try {
      await mkdir(path.dirname(STATUS_FILE), { recursive: true })
      await writeFile(STATUS_FILE, JSON.stringify(status, null, 2))
    } catch (_) {}
  }

  const logInfo = async (message) => {
    if (!config.output.verbose) return
    try { await client?.app?.log?.({ service: "opencode-memory", level: "info", message }) } catch (_) {}
  }

  const logWarn = async (message) => {
    if (!config.output.verbose) return
    try { await client?.app?.log?.({ service: "opencode-memory", level: "warn", message }) } catch (_) {}
  }

  const refreshSession = (sessionID, sessionDirectory) => {
    const existingState = sessionState.get(sessionID)
    if (existingState?.promise) return existingState.promise

    const loadPromise = loadSessionMemories({
      config,
      directory: sessionDirectory,
      logInfo,
      logWarn,
      healthState,
    })
      .then(async (result) => {
        sessionState.set(sessionID, {
          ...result,
          messages: [],
          promise: null,
        })
        const count = result?.memories?.length ?? 0
        const project = result?.projectName ?? projectNameFromDirectory(sessionDirectory)
        try {
          await client?.tui?.showToast?.({
            body: {
              title: "Memory Plugin",
              message: count > 0
                ? `✓ ${count} memories loaded for ${project}`
                : `✓ Connected — no memories found for ${project}`,
              variant: count > 0 ? "success" : "info",
            },
            query: { directory },
          })
        } catch (_) {}
      })
      .catch(async (error) => {
        sessionState.set(sessionID, {
          projectName: projectNameFromDirectory(sessionDirectory),
          memories: [],
          messages: [],
          promise: null,
        })
        await logWarn(`Memory load failed: ${error.message}`)
        try {
          await client?.tui?.showToast?.({
            body: {
              title: "Memory Plugin",
              message: `Failed to load memories: ${error.message}`,
              variant: "error",
            },
            query: { directory },
          })
        } catch (_) {}
      })

    sessionState.set(sessionID, {
      projectName: projectNameFromDirectory(sessionDirectory),
      memories: [],
      messages: [],
      promise: loadPromise,
    })

    return loadPromise
  }

  const waitForSession = async (sessionID, fallbackDirectory) => {
    let state = sessionState.get(sessionID)

    if (!state) {
      refreshSession(sessionID, fallbackDirectory)
      state = sessionState.get(sessionID)
    }

    if (state?.promise) {
      const loadTimedOut = Symbol("load-timed-out")
      const result = await Promise.race([
        state.promise.then(() => null),
        sleep(config.memoryService.loadTimeoutMs).then(() => loadTimedOut),
      ])

      if (result === loadTimedOut) {
        const latestState = sessionState.get(sessionID)
        if (latestState?.promise) {
          return null
        }
      }
    }

    return sessionState.get(sessionID)
  }

  // --- Mid-conversation memory retrieval + debounce ---
  const _naturalTriggerTimers = new Map()

  const doNaturalTriggerSearch = async (sessionID, query) => {
    // Debounce: cancel any pending trigger for this session
    const existingTimer = _naturalTriggerTimers.get(sessionID)
    if (existingTimer) clearTimeout(existingTimer)

    return new Promise((resolve) => {
      const timer = setTimeout(async () => {
        _naturalTriggerTimers.delete(sessionID)
        const state = sessionState.get(sessionID)
        if (!state) { resolve(); return }

        const tags = tagsForProject(state.projectName, config)
        const maxResults = config.naturalTriggers?.maxMemoriesPerTrigger || 3

        try {
          const results = await searchMemories(config, query, tags, maxResults)
          if (results.length === 0) { resolve(); return }

          const existingIds = new Set((state.memories || []).map((m) => m.id))
          const newOnes = results.filter((m) => !existingIds.has(m.id))
          if (newOnes.length === 0) { resolve(); return }

          state.memories = sortMemories(dedupeMemories([...state.memories, ...newOnes]))
          state._pendingNaturalMemories = newOnes

          await logInfo(`Natural trigger: found ${newOnes.length} additional memories`)
          await writeStatus({
            lastAction: `Natural trigger: ${newOnes.length} memories (${query.slice(0, 40)}...)`,
          })
        } catch (error) {
          await logWarn(`Natural trigger search failed: ${error.message}`)
        }
        resolve()
      }, 2000) // 2s debounce window

      _naturalTriggerTimers.set(sessionID, timer)
    })
  }
  // --- END ---

  // Read DECISIONS.md from the session directory and store today's/yesterday's
  // entries as individual decision memories. Idempotent via content-hash dedup.
  const captureDecisionsLog = async (sessionDirectory, projectName) => {
    const decisionsPath = path.join(sessionDirectory, "DECISIONS.md")
    let content
    try {
      content = await readFileP(decisionsPath, "utf8")
    } catch (_) {
      return 0 // No DECISIONS.md — normal for most projects
    }

    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)

    // Parse multi-line entries: [YYYY-MM-DD] first line\ncontinuation...
    const entries = []
    let currentDate = null
    let currentLines = []
    for (const line of content.split("\n")) {
      const header = line.match(/^\[(\d{4}-\d{2}-\d{2})\]\s+(.*)/)
      if (header) {
        if (currentDate && (currentDate === today || currentDate === yesterday) && currentLines.length) {
          entries.push(currentLines.join(" ").replace(/\s+/g, " ").trim())
        }
        currentDate = header[1]
        currentLines = header[2] ? [header[2].trim()] : []
      } else if (currentDate && line.trim()) {
        currentLines.push(line.trim())
      }
    }
    // Flush last entry
    if (currentDate && (currentDate === today || currentDate === yesterday) && currentLines.length) {
      entries.push(currentLines.join(" ").replace(/\s+/g, " ").trim())
    }

    if (entries.length === 0) return 0

    let stored = 0
    for (const entry of entries) {
      try {
        await storeMemoryHttp(config, entry, ["decisions-log", projectName, "agent:opencode"], "decision", {
          source: "DECISIONS.md",
          project: projectName,
        })
        stored++
      } catch (_) {
        // Best-effort — one failed entry shouldn't abort the rest
      }
    }
    return stored
  }

  const handleSessionEnd = async (sessionID, sessionDirectory) => {
    try {
      let state = sessionState.get(sessionID)
      if (!state) {
        state = { projectName: projectNameFromDirectory(sessionDirectory), messages: [], memories: [] }
        sessionState.set(sessionID, state)
      }

      // --- Session-End Consolidation ---
      if (config.sessionEnd.enabled && state.messages?.length > 0) {
        const text = state.messages.map((m) => m.content || "").join("\n")
        if (text.length >= (config.sessionEnd.minSessionLength || 100)) {
          const analysis = analyzeSessionMessages(state.messages)
          if (analysis.confidence >= 0.4) {
            const tags = [
              ...config.sessionEnd.tags,
              state.projectName,
              ...analysis.topics.slice(0, 3),
              `confidence:${Math.round(analysis.confidence * 100)}`,
            ]
            const consolidation = [
              `## Session Summary — ${state.projectName}`,
              "",
              `**Topics:** ${analysis.topics.join(", ") || "general"}`,
              analysis.decisions.length ? `\n**Decisions:**\n${analysis.decisions.map((d) => `- ${d}`).join("\n")}` : "",
              analysis.insights.length ? `\n**Insights:**\n${analysis.insights.map((d) => `- ${d}`).join("\n")}` : "",
              analysis.codeChanges.length ? `\n**Code Changes:**\n${analysis.codeChanges.map((d) => `- ${d}`).join("\n")}` : "",
              analysis.nextSteps.length ? `\n**Next Steps:**\n${analysis.nextSteps.map((d) => `- ${d}`).join("\n")}` : "",
            ].filter(Boolean).join("\n")

            // Quality gate: score before storing; fail-open if scoring unavailable
            const qualityScore = await scoreContent(config, consolidation, "session-summary")
            if (qualityScore !== null && qualityScore < QUALITY_THRESHOLD) {
              await logInfo(`Session summary skipped (quality: ${qualityScore.toFixed(2)})`)
            } else {
            // Overwrite the previous summary of the same active session to avoid DB pollution
            if (state.lastSummaryHash) {
              try {
                await requestJson(config, `/api/memories/${state.lastSummaryHash}`, { method: "DELETE" })
                state.lastSummaryHash = null
              } catch (_) {}
            }

            try {
              const res = await storeMemoryHttp(config, consolidation, tags, "session-summary", {
                session_analysis: {
                  topics: analysis.topics,
                  decisions_count: analysis.decisions.length,
                  insights_count: analysis.insights.length,
                  code_changes_count: analysis.codeChanges.length,
                  next_steps_count: analysis.nextSteps.length,
                  session_length: analysis.sessionLength,
                  confidence: analysis.confidence,
                },
                session_id: sessionID,
              })
              
              if (res?.success && res?.content_hash) {
                state.lastSummaryHash = res.content_hash
              }

              await logInfo(`Session summary stored for ${state.projectName}`)
              await writeStatus({
                projectName: state.projectName,
                lastAction: `Session summary stored`,
                lastSummaryAt: new Date().toISOString(),
              })
              if (!state._sessionToastShown) {
                state._sessionToastShown = true
                try {
                  await client?.tui?.showToast?.({
                    body: {
                      title: "Memory Service",
                      message: `Storing session summary for ${state.projectName}.`,
                      variant: "success",
                    },
                    query: { directory },
                  })
                } catch (_) {}
              }
            } catch (error) {
              await logWarn(`Session summary store failed: ${error.message}`)
            }
            } // closes quality gate else
          }
        }
      }

      // Trigger post-session quality eval + consolidation (fire-and-forget)
      if (state.lastSummaryHash && config.memoryService.endpoint) {
        triggerQualityEvaluation(config.memoryService.endpoint, state.lastSummaryHash)
        triggerConsolidation(config.memoryService.endpoint)
      }

      // --- Commit session to bootstrap learning pipeline ---
      commitSession(config, sessionID, state.projectName, {
        decisions: state._decisions || [],
        errors: state._errors || [],
        userCorrections: state._userCorrections || [],
        beliefUpdates: state._beliefUpdates || [],
      })

      // --- Session-End Harvest ---
      const harvestCfg = config.harvest
      if (harvestCfg.enabled && state.messages?.length >= (harvestCfg.minSessionMessages || 10)) {
        const projectPath = deriveProjectPath(sessionDirectory)
        if (projectPath) {
          const forcedDryRun = harvestCfg.dryRunOnFirstUse !== false && !harvestFirstRun.done
          try {
            const result = await postHarvest(config, {
              sessions: harvestCfg.sessions || 1,
              use_llm: !!harvestCfg.useLlm,
              dry_run: forcedDryRun || !!harvestCfg.dryRun,
              min_confidence: harvestCfg.minConfidence || 0.6,
              types: Array.isArray(harvestCfg.types) ? harvestCfg.types : ["decision", "bug", "convention", "learning"],
              project_path: projectPath,
            })
            const found = result?.results?.reduce((s, r) => s + (r.found || 0), 0) || 0
            const stored = result?.results?.reduce((s, r) => s + (r.stored || 0), 0) || 0
            await logInfo(`Harvest: ${found} candidates, ${stored} stored (dry_run=${forcedDryRun || !!result?.dry_run})`)
            if (forcedDryRun) harvestFirstRun.done = true
          } catch (error) {
            await logWarn(`Harvest failed: ${error.message}`)
          }
        }
      }

      // Capture DECISIONS.md entries unconditionally — runs even when session
      // summary confidence is too low to store.
      try {
        const decisionsCount = await captureDecisionsLog(sessionDirectory, state.projectName)
        if (decisionsCount > 0) {
          await logInfo(`Captured ${decisionsCount} DECISIONS.md entr${decisionsCount === 1 ? "y" : "ies"}`)
        }
      } catch (error) {
        await logWarn(`DECISIONS.md capture skipped: ${error.message}`)
      }

    } catch (error) {
      await logWarn(`Session end handler error: ${error.message}`)
    }
  }

  const handleMessagePart = async (sessionID, part) => {
    // Track tool use so auto-capture only fires after actual tool execution
    if (part.type === "tool_use" || part.type === "tool-call") {
      let state = sessionState.get(sessionID)
      if (!state) {
        state = { projectName: projectNameFromDirectory(directory), memories: [], messages: [] }
        sessionState.set(sessionID, state)
      }
      state._lastToolUseAt = Date.now()
      state._lastToolName = part.name || part.toolName || ""
      state._lastToolInput = part.input || part.arguments || {}
      return
    }

    if (part.type === "tool_result") {
      let state = sessionState.get(sessionID)
      if (!state) {
        state = { projectName: projectNameFromDirectory(directory), memories: [], messages: [] }
        sessionState.set(sessionID, state)
      }
      state._lastToolUseAt = Date.now()

      // Tier 1: git commit detection
      if (!state._tier1Fired?.gitCommit && (state._lastToolName === "bash" || state._lastToolName === "Bash")) {
        const command = state._lastToolInput?.command || ""
        const commitMatch = command.match(/git\s+commit\s+(-m\s+['"]([^'"]+)['"]|.*)/)
        if (commitMatch) {
          state._pendingTier1Event = { type: "gitCommit", message: commitMatch[2] || command.slice(0, 200) }
        }
        state._tier1Fired = state._tier1Fired || {}
        state._tier1Fired.gitCommit = true
      }

      // Tier 1: deploy/restart detection
      if (state._lastToolName === "bash" || state._lastToolName === "Bash") {
        const command = state._lastToolInput?.command || ""
        if (/\b(docker compose (up|restart)|systemctl restart|service .* restart|kubectl (apply|rollout)|helm upgrade)\b/.test(command)) {
          state._pendingTier1Event = { type: "deployRestart", message: command.slice(0, 300) }
        }
      }
      return
    }

    if (part.type !== "text") return
    const text = part.text
    if (!text || text.length === 0) return

    if (!config.autoCapture.enabled) return
    const overrides = detectOverrides(text)
    if (overrides.forceSkip) return

    let state = sessionState.get(sessionID)
    if (!state) {
      state = { projectName: projectNameFromDirectory(directory), memories: [], messages: [] }
      sessionState.set(sessionID, state)
    }

    if (!state._capturedParts) state._capturedParts = new Set()
    if (state._capturedParts.has(part.id)) return
    state._capturedParts.add(part.id)

    // Mark as assistant text (message.part.updated delivers assistant parts)
    state.messages.push({ role: "assistant", content: text })

    // Process pending Tier 1 event captured from prior tool result
    if (state._pendingTier1Event) {
      const event = state._pendingTier1Event
      state._pendingTier1Event = null
      const tags = ["tier1-event", event.type, state.projectName.toLowerCase(), "auto-capture"]
      const memType = event.type === "gitCommit" ? "decision" : "note"
      const content = event.type === "gitCommit"
        ? `[Tier 1] Git commit: ${event.message}`
        : `[Tier 1] Deploy/restart: ${event.message}`
      try {
        await storeMemoryHttp(config, content, tags, memType)
        await logInfo(`Tier 1 captured: ${event.type}`)
      } catch (error) {
        await logWarn(`Tier 1 store failed: ${error.message}`)
      }
    }

    // --- NEW: Natural Memory Triggers — detect memory-seeking queries ---
    const triggerResult = detectMemorySeekingQuery(text, config)
    if (triggerResult) {
      const now = Date.now()
      if (!state._lastNaturalTriggerAt || (now - state._lastNaturalTriggerAt) > (config.naturalTriggers?.cooldownPeriod || 30000)) {
        state._lastNaturalTriggerAt = now
        doNaturalTriggerSearch(sessionID, triggerResult.query)
      }
    }
    // --- END NEW ---

    const detection = detectValuableContent(text, config)
    const requireToolUse = config.autoCapture.requireToolUse !== false
    const toolUseWindow = config.autoCapture.toolUseWindowMs || 120000
    const recentToolUse = state._lastToolUseAt && (Date.now() - state._lastToolUseAt) < toolUseWindow
    const isValuable = overrides.forceRemember || (detection.isValuable && (!requireToolUse || recentToolUse))

    if (isValuable) {
      const projectName = state.projectName
      if (!state._decisions) state._decisions = []
      if (!state._errors) state._errors = []
      if (!state._userCorrections) state._userCorrections = []
      if (!state._beliefUpdates) state._beliefUpdates = []
      if (detection.memoryType === "decision") {
        state._decisions.push({ what: detection.matchedContent?.slice(0, 200) || text.slice(0, 200), why: "auto-captured" })
      }
      if (detection.memoryType === "error") {
        state._errors.push({ tool: "assistant", error: text.slice(0, 200), count: 1, severity: "info" })
      }
      const memoryType = overrides.forceRemember ? "note" : detection.memoryType
      const tags = [
        ...config.autoCapture.tags,
        memoryType,
        projectName.toLowerCase(),
      ]
      const maxLen = config.autoCapture.maxContentLength || 4000
      const captureText = detection.matchedContent || text
      const content = captureText.length > maxLen ? captureText.slice(0, maxLen - 3) + "..." : captureText

      try {
        await storeMemoryHttp(config, content, tags, memoryType, { conversation_id: sessionID })
        await logInfo(`Auto-captured ${memoryType}`)
        state._captureCount = (state._captureCount || 0) + 1
        await writeStatus({
          projectName: state.projectName,
          capturedCount: state._captureCount,
          lastAction: `Captured ${memoryType} (#${state._captureCount})`,
        })
        try {
          await client?.tui?.showToast?.({
            body: {
              title: "Memory Service",
              message: `Captured ${memoryType} memory for ${state.projectName}.`,
              variant: "info",
            },
            query: { directory },
          })
        } catch (_) {}
      } catch (error) {
        await logWarn(`Auto-capture failed: ${error.message}`)
      }
    }
  }

  // Initialize session tracker
  let sessionTracker = null
  loadSessionTracker().then(t => { sessionTracker = t })

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const sid = event.properties.info.id
        const sdir = event.properties.info.directory || directory
        refreshSession(sid, sdir)

        // Track session for cross-session linking
        if (sessionTracker) {
          cleanupExpiredSessions(sessionTracker)
          sessionTracker.sessions.push({
            id: sid,
            project: projectNameFromDirectory(sdir),
            directory: sdir,
            startTime: new Date().toISOString(),
            endTime: null,
            summaryHash: null,
          })
          saveSessionTracker(sessionTracker)
        }
      }

      // session.idle fires DURING the session (bus subscription is alive).
      // We incrementally update the summary on idle so that the most
      // up-to-date summary is always preserved even if the session exits suddenly.
      if (event.type === "session.idle") {
        const sid = event.properties.info?.id || event.properties.sessionID
        if (sid) {
          const sdir = event.properties.info?.directory || directory
          await handleSessionEnd(sid, sdir)
        }
      }

      // session.deleted fires AFTER scope closes (subscription is gone).
      // If we do receive it, perform final cleanup and delete sessionState.
      if (event.type === "session.deleted") {
        const sid = event.properties.info?.id || event.properties.sessionID
        if (sid) {
          const sdir = event.properties.info?.directory || directory
          await handleSessionEnd(sid, sdir)

          // Update tracker with end time + summary hash
          if (sessionTracker) {
            const entry = sessionTracker.sessions.find(s => s.id === sid)
            if (entry) {
              entry.endTime = new Date().toISOString()
              const state = sessionState.get(sid)
              if (state?.lastSummaryHash) entry.summaryHash = state.lastSummaryHash
            }
            saveSessionTracker(sessionTracker)
          }

          sessionState.delete(sid)
        }
      }

      if (event.type === "message.part.updated") {
        await handleMessagePart(event.properties.sessionID, event.properties.part)
      }
    },

    "command.execute.before": async (input, output) => {
      if (input.command !== "memory") return

      const projectName = projectNameFromDirectory(directory)
      const args = (input.arguments || "").trim()
      const tokens = args ? args.split(/\s+/) : []
      const sub = (tokens[0] || "status").toLowerCase()

      let block = ""
      try {
        if (sub === "search" && tokens.length > 1) {
          const query = tokens.slice(1).join(" ")
          const tags = tagsForProject(projectName, config)
          const results = await searchMemories(config, query, tags, 5)
          if (!results.length) {
            block = `# Memory Search — "${query}"\n\nNo matches.`
          } else {
            const lines = [`# Memory Search — "${query}"`, ""]
            for (const m of results) {
              const ts = formatTimestamp(m)
              const prefix = ts ? `- [${ts}] ` : "- "
              lines.push(prefix + truncateText(m.content.replace(/\s+/g, " ").trim(), 240))
            }
            block = lines.join("\n")
          }
        } else if (sub === "health") {
          const h = await getHealth(config).catch((e) => ({ error: e.message }))
          const backend = h?.storage?.backend || h?.storage_backend || h?.backend || "unknown"
          const healthStatus = h?.error ? `error: ${h.error}` : (h?.status || "healthy")
          const memCount = h?.statistics?.total_memories ?? h?.total_memories
          const lines = [`# Memory Service Health`, ""]
          lines.push(`- Backend: ${backend}`)
          lines.push(`- Status: ${healthStatus}`)
          if (memCount !== undefined) lines.push(`- Total memories: ${memCount}`)
          lines.push(`- Endpoint: ${config.memoryService.endpoint}`)
          block = lines.join("\n")
        } else if (sub === "mode" && tokens.length > 1) {
          const newMode = tokens[1].toLowerCase()
          if (config.mode?.profiles?.[newMode]) {
            config.mode.profile = newMode
            const profile = config.mode.profiles[newMode]
            if (profile.maxMemoriesPerSession !== undefined) config.memoryService.maxMemoriesPerSession = profile.maxMemoriesPerSession
            if (profile.loadTimeoutMs !== undefined) config.memoryService.loadTimeoutMs = profile.loadTimeoutMs
            if (profile.naturalTriggersEnabled !== undefined && config.naturalTriggers) config.naturalTriggers.enabled = profile.naturalTriggersEnabled
            if (profile.gitAnalysisEnabled !== undefined && config.gitAnalysis) config.gitAnalysis.enabled = profile.gitAnalysisEnabled
            block = `# Memory Mode — ${newMode}\n\n${profile.description}`
          } else {
            const available = Object.keys(config.mode?.profiles || {}).join(", ")
            block = `# Unknown mode: "${newMode}"\n\nAvailable modes: ${available}`
          }
        } else if (sub === "export") {
          block = `# Memory Export\n\nUse \`/memory search <query>\` to find specific memories.`
        } else {
          // Read from this plugin instance's in-memory snapshot — not from
          // STATUS_FILE — so the displayed status is always the current
          // project's, even when another plugin instance (different project)
          // is also running and overwriting the shared file.
          const sessionMemories = input.sessionID
            ? sessionState.get(input.sessionID)?.memories?.length
            : undefined
          const modeLabel = config.mode?.profile || "balanced"
          const lines = [`# Memory Status — ${projectName}`, ""]
          lines.push(`- Mode: ${modeLabel}`)
          lines.push(`- Project: ${status.projectName || projectName}`)
          lines.push(`- Loaded this session: ${sessionMemories ?? status.loadedCount ?? 0}`)
          lines.push(`- Auto-captured: ${status.capturedCount ?? 0}`)
          // Show recent session count from tracker
          const projectSessions = sessionTracker?.sessions?.filter(s => s.project === projectName && s.endTime)?.length ?? 0
          if (projectSessions > 0) lines.push(`- Recent sessions: ${projectSessions}`)
          if (status.lastAction) lines.push(`- Last action: ${status.lastAction}`)
          if (status.lastSummaryAt) lines.push(`- Last summary: ${status.lastSummaryAt}`)
          if (status.updatedAt) lines.push(`- Updated: ${status.updatedAt}`)
          lines.push("")
          lines.push("Usage: `/memory`, `/memory search <query>`, `/memory health`, `/memory mode <profile>`")
          block = lines.join("\n")
        }
      } catch (error) {
        block = `# Memory command failed\n\n${error.message}`
      }

      output.parts.length = 0
      output.parts.push({
        type: "text",
        text: "Reply with the following block verbatim. No commentary, no questions.\n\n" + block,
      })
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return

      let state = sessionState.get(input.sessionID)
      if (!state) {
        refreshSession(input.sessionID, directory)
        state = sessionState.get(input.sessionID)
      }
      state = await waitForSession(input.sessionID, directory)
      if (!state) return

      // Load bootstrap profile (fire-and-forget, non-blocking)
      if (!state._bootstrapLoaded) {
        state._bootstrapLoaded = true
        getBootstrapProfile(config, state.projectName).then((profile) => {
          if (profile) {
            state._bootstrapProfile = profile
          }
        })
      }

      if (state?._bootstrapProfile) {
        output.system.push(state._bootstrapProfile)
      }

      if (!state?.memories?.length) return

      const formatted = formatMemories(state.projectName, state.memories, config)
      if (formatted) {
        await logInfo(`Memory: ${state.memories.length} loaded for ${state.projectName}`)
        await writeStatus({
          projectName: state.projectName,
          loadedCount: state.memories.length,
          lastAction: `Loaded ${state.memories.length} memories`,
        })
        output.system.push(formatted)
      }
    },

    "experimental.chat.messages.transform": async (input, output) => {
      // opencode passes {} as input to this hook (no sessionID in 1.17.x).
      // If sessionID is present use it; otherwise pick the active session.
      let state
      if (input.sessionID) {
        if (!sessionState.get(input.sessionID)) refreshSession(input.sessionID, directory)
        state = await waitForSession(input.sessionID, directory)
      } else {
        for (const s of sessionState.values()) {
          if (s?.memories?.length && (!state || s.memories.length > state.memories.length)) state = s
        }
      }
      if (!state?.memories?.length) return

      const formatted = formatMemories(state.projectName, state.memories, config)
      if (formatted) {
        output.messages.unshift({
          info: { role: "system" },
          parts: [{ type: "text", text: formatted }],
        })
      }
    },

    "experimental.session.compacting": async (input, output) => {
      if (!input.sessionID) return

      const state = await waitForSession(input.sessionID, directory)
      if (!state?.memories?.length) return

      const formatted = formatMemories(state.projectName, state.memories, config, {
        includeHeader: false,
        limit: Math.min(6, config.memoryService.maxMemoriesPerSession),
      })

      if (formatted) {
        output.context.push(formatted)
      }
    },
  }
}

export const OpenCodeMemoryPlugin = createPlugin
export default createPlugin

// Internal exports for testing (mirrors claude-hooks _internal pattern)
export const _internal = {
  isNoisySentence,
  extractProseSentences,
  cleanTurnText,
  analyzeSessionMessages,
  detectProjectContext,
  detectMemorySeekingQuery,
  detectValuableContent,
  detectOverrides,
  loadSessionTracker,
  saveSessionTracker,
  cleanupExpiredSessions,
  scoreContent,
  MEMORY_SEEKING_PATTERNS,
  QUALITY_THRESHOLD,
}
