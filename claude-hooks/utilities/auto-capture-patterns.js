/**
 * Auto-Capture Pattern Detection Module
 *
 * Ported from shodh-cloudflare for intelligent automatic memory capture.
 * Detects valuable conversation patterns and classifies memory types.
 *
 * @module auto-capture-patterns
 * @version 1.0.0
 */

'use strict';

/**
 * Pattern definitions for automatic memory capture.
 * Each pattern has:
 * - regex: Pattern to match (case-insensitive)
 * - memoryType: Type to assign when matched
 * - priority: Lower = higher priority (first match wins)
 * - minLength: Optional minimum content length for this pattern
 * - confidence: Base confidence score for this pattern
 */
const PATTERNS = {
    decision: {
        regex: /\b(decided|chose|will use|let's go with|i'll use|we'll use|settled on|going with|picked|selected|opting for|entschieden|gewählt|nehmen wir|verwenden wir|machen wir|nutzen wir|ausgewählt)/i,
        memoryType: 'decision',
        priority: 1,
        confidence: 0.9,
        description: 'Decision-making statements'
    },
    error: {
        regex: /\b(error|exception|failed|fixed|bug|issue|crash|broken|resolved|solved|debugging|debugged|patched|fehler|behoben|gefixt|problem|kaputt|gelöst|repariert|fehlerbehebung)/i,
        memoryType: 'error',
        priority: 2,
        confidence: 0.85,
        description: 'Error reports and fixes'
    },
    learning: {
        regex: /\b(learned|discovered|realized|found out|turns out|interestingly|til|understanding now|now i see|aha|insight|gelernt|entdeckt|herausgefunden|stellte sich heraus|interessanterweise|jetzt verstehe ich)/i,
        memoryType: 'learning',
        priority: 3,
        confidence: 0.85,
        description: 'New knowledge acquisition'
    },
    implementation: {
        regex: /\b(implemented|created|built|added|refactored|set up|configured|deployed|developed|wrote|coding|programmed|implementiert|erstellt|gebaut|hinzugefügt|konfiguriert|eingerichtet|refaktoriert|entwickelt|programmiert)/i,
        memoryType: 'learning',
        priority: 4,
        confidence: 0.8,
        description: 'Implementation work'
    },
    important: {
        regex: /\b(critical|important|remember|note|key|essential|must|never|always|crucial|vital|significant|wichtig|merken|notiz|niemals|immer|kritisch|wesentlich|unbedingt|entscheidend)/i,
        // 'note' is the observation subtype for exactly this: something the
        // user marked as worth remembering. 'Context' is not in the ontology
        // and was silently coerced to 'observation' on store (#177).
        memoryType: 'note',
        priority: 5,
        confidence: 0.75,
        description: 'Important information markers'
    },
    code: {
        regex: /\b(function|class|component|api|endpoint|database|schema|test|config|module|interface|method|funktion|klasse|komponente|datenbank|schnittstelle|konfiguration|modul)/i,
        // Substantial code discussion is lookup material later — 'reference'
        // is the observation subtype for that (#177).
        memoryType: 'reference',
        priority: 6,
        confidence: 0.7,
        minLength: 600,
        description: 'Substantial code discussions'
    }
};

/**
 * User override markers for explicit control
 */
const USER_OVERRIDES = {
    forceRemember: /#remember\b/i,
    forceSkip: /#skip\b/i
};

/**
 * Default configuration
 */
const DEFAULT_CONFIG = {
    minLength: 300,
    maxLength: 4000,
    enabledPatterns: ['decision', 'error', 'learning', 'implementation', 'important', 'code'],
    debugMode: false
};

/**
 * Detect patterns in content and determine if it's worth capturing.
 *
 * @param {string} content - The conversation content to analyze
 * @param {Object} options - Configuration options
 * @param {number} options.minLength - Minimum content length (default: 300)
 * @param {string[]} options.enabledPatterns - Which patterns to check
 * @returns {Object} Detection result
 */
function detectPatterns(content, options = {}) {
    const config = { ...DEFAULT_CONFIG, ...options };

    // Validate input
    if (!content || typeof content !== 'string') {
        return {
            isValuable: false,
            reason: 'Invalid or empty content'
        };
    }

    // Length check
    if (content.length < config.minLength) {
        return {
            isValuable: false,
            reason: `Content too short (${content.length} < ${config.minLength} chars)`
        };
    }

    const contentLower = content.toLowerCase();

    // Check patterns in priority order
    const sortedPatterns = Object.entries(PATTERNS)
        .filter(([name]) => config.enabledPatterns.includes(name))
        .sort((a, b) => a[1].priority - b[1].priority);

    for (const [patternName, pattern] of sortedPatterns) {
        // Check minimum length requirement for this pattern
        if (pattern.minLength && content.length < pattern.minLength) {
            continue;
        }

        // Test pattern
        if (pattern.regex.test(contentLower)) {
            const match = contentLower.match(pattern.regex);

            if (config.debugMode) {
                console.log(`[auto-capture] Matched pattern: ${patternName}`);
                console.log(`[auto-capture] Matched text: "${match[0]}"`);
            }

            return {
                isValuable: true,
                memoryType: pattern.memoryType,
                matchedPattern: patternName,
                matchedText: match[0],
                confidence: pattern.confidence,
                description: pattern.description
            };
        }
    }

    return {
        isValuable: false,
        reason: 'No pattern matched'
    };
}

/**
 * Check for user override markers in the message.
 *
 * @param {string} userMessage - The user's message to check
 * @returns {Object} Override flags
 */
function hasUserOverride(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') {
        return {
            forceRemember: false,
            forceSkip: false
        };
    }

    return {
        forceRemember: USER_OVERRIDES.forceRemember.test(userMessage),
        forceSkip: USER_OVERRIDES.forceSkip.test(userMessage)
    };
}

/**
 * Generate automatic tags based on pattern detection result.
 *
 * @param {Object} detectionResult - Result from detectPatterns()
 * @param {string} projectName - Optional project name from cwd
 * @returns {string[]} Array of tags
 */
function generateTags(detectionResult, projectName = null) {
    const tags = ['auto-captured', 'smart-ingest'];

    if (detectionResult.memoryType) {
        tags.push(detectionResult.memoryType.toLowerCase());
    }

    if (detectionResult.matchedPattern) {
        tags.push(detectionResult.matchedPattern.toLowerCase());  // Case-normalize
    }

    if (projectName) {
        tags.push(projectName.toLowerCase());  // Case-normalize
    }

    // Deduplicate case-insensitively
    return [...new Set(tags.map(t => t.toLowerCase()))];
}

/**
 * Truncate content to maximum length while preserving meaning.
 *
 * @param {string} content - Content to truncate
 * @param {number} maxLength - Maximum length (default: 4000)
 * @returns {string} Truncated content
 */
function truncateContent(content, maxLength = 4000) {
    if (content.length <= maxLength) {
        return content;
    }

    const truncated = content.substring(0, maxLength);

    // Search for multiple sentence boundary delimiters
    const delimiters = ['. ', '! ', '? ', '.\n', '!\n', '?\n', '.\t', ';\n', '\n\n'];
    let bestBreak = -1;

    for (const delimiter of delimiters) {
        const pos = truncated.lastIndexOf(delimiter);
        if (pos > bestBreak) {
            bestBreak = pos;
        }
    }

    // Use best break point if it preserves at least 70% of content
    // (Lowered from 80% to allow more flexibility in finding good breaks)
    if (bestBreak > maxLength * 0.7) {
        return truncated.substring(0, bestBreak + 1) + '\n[truncated]';
    } else {
        return truncated + '\n[truncated]';
    }
}

/**
 * Compute SHA-256 hash of content for deduplication.
 *
 * @param {string} content - Content to hash
 * @returns {Promise<string>} Hex-encoded hash
 */
async function computeContentHash(content) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Extract project name from current working directory.
 *
 * @param {string} cwd - Current working directory path
 * @returns {string|null} Project name or null
 */
function extractProjectName(cwd) {
    if (!cwd) return null;

    // Get the last directory component
    const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
    const lastPart = parts[parts.length - 1];

    // Skip common non-project directories
    const skipDirs = ['home', 'users', 'documents', 'desktop', 'repositories', 'projects', 'src'];
    if (skipDirs.includes(lastPart.toLowerCase())) {
        return parts.length > 1 ? parts[parts.length - 2] : null;
    }

    return lastPart;
}

const { execSync } = require('child_process');
const fs_sync = require('fs');
const path_mod = require('path');

const TIER1_DEPLOY_REGEX = /(\bsystemctl\s+(restart|start)\b|\bdocker\s+compose\s+(up|restart)\b|\bdocker\s+restart\b|\.\/deploy\.sh\b|\bkubectl\s+apply\b)/;

const TIER2_SIGNAL_REGEX = /\b(I think what happened|turns out|the root cause|the fix was|here['']s what we learned|so the theory is|what we found|I believe the issue is|the problem was|what I think is)\b/i;

/**
 * Detect if a PostToolUse event is a Tier 1 completion event.
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {{ type: string, tool: string, input: object } | null}
 */
function detectTier1Event(toolName, toolInput) {
    if (!toolName) return null;

    if (toolName === 'mcp__git__git_commit') {
        return { type: 'gitCommit', tool: toolName, input: toolInput || {} };
    }

    if (toolName === 'Bash') {
        const cmd = toolInput?.command || '';
        if (/git\s+commit\b/.test(cmd)) {
            return { type: 'gitCommit', tool: toolName, input: toolInput };
        }
        if (TIER1_DEPLOY_REGEX.test(cmd)) {
            return { type: 'deployRestart', tool: toolName, input: toolInput };
        }
    }

    if ((toolName === 'Write' || toolName === 'Edit') && /DECISIONS\.md$/.test(toolInput?.file_path || '')) {
        return { type: 'decisionsFile', tool: toolName, input: toolInput };
    }

    return null;
}

/**
 * Detect if a user message contains a Tier 2 language signal.
 * @param {string} userMessage
 * @returns {boolean}
 */
function detectTier2Signal(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return TIER2_SIGNAL_REGEX.test(userMessage);
}

/**
 * Extract prose text from a Claude Code content block array or string.
 * Strips tool_use / tool_result blocks; keeps only text blocks.
 * @param {string|Array} content
 * @returns {string}
 */
function extractProseFromContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter(block => block.type === 'text')
        .map(block => block.text || '')
        .join('\n');
}

/**
 * Truncate text to at most maxLen chars without cutting a sentence in half.
 * Accumulates whole sentences until the next one would exceed the budget.
 * Falls back to a hard slice only if a single sentence alone exceeds maxLen.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function truncateAtSentenceBoundary(text, maxLen) {
    if (text.length <= maxLen) return text;
    const sentences = text.split(/(?<=[.!?])\s+/);
    let result = '';
    for (const sentence of sentences) {
        const candidate = result ? `${result} ${sentence}` : sentence;
        if (candidate.length > maxLen) break;
        result = candidate;
    }
    return result || text.slice(0, maxLen);
}

/**
 * Strip markdown structure, code blocks, and URLs from a turn's text,
 * then truncate to maxLen. Produces a signal-dense summary, not a verbatim dump.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function cleanTurnText(text, maxLen) {
    const len = maxLen || 300;
    const cleaned = text
        .replace(/```[\s\S]*?```/g, '')
        .replace(/^#{1,6}\s+.*$/gm, '')
        .replace(/^\|.*$/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/`[^`\n]+`/g, '')
        .replace(/\*{1,2}([^*\n]+)\*{1,2}/g, '$1')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return truncateAtSentenceBoundary(cleaned, len);
}

/**
 * Read the last `windowSize` user/assistant turns from a JSONL transcript,
 * stripping tool output and truncating per-turn to avoid verbatim dumps.
 * @param {string} transcriptPath
 * @param {number} windowSize
 * @returns {Promise<string>}
 */
async function extractContextWindow(transcriptPath, windowSize = 8) {
    const fsAsync = require('fs').promises;
    const raw = await fsAsync.readFile(transcriptPath, 'utf8');
    const turns = [];

    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const parsed = JSON.parse(trimmed);
            const items = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of items) {
                const role = item.message?.role || item.role;
                if (role !== 'user' && role !== 'assistant') continue;
                const rawContent = item.message?.content ?? item.content;
                // User turns get more room; assistant turns are heavily truncated
                // to avoid storing full analyses verbatim.
                const maxLen = role === 'user' ? 400 : 200;
                const text = cleanTurnText(extractProseFromContent(rawContent), maxLen);
                if (text.length >= 10) turns.push({ role, text });
            }
        } catch { /* skip malformed lines */ }
    }

    return turns
        .slice(-windowSize)
        .map(t => `${t.role === 'user' ? 'User' : 'A'}: ${t.text}`)
        .join('\n\n');
}

/**
 * Count prose words in text (split on whitespace, min 2 chars).
 * @param {string} text
 * @returns {number}
 */
function countProseWords(text) {
    if (!text) return 0;
    return text.trim().split(/\s+/).filter(w => w.length > 1).length;
}

/**
 * Get the last git commit info from the repo at `cwd`.
 * @param {string} cwd
 * @returns {{ hash: string, subject: string, body: string, files: string } | null}
 */
function getLastCommitInfo(cwd) {
    try {
        const opts = { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] };
        const hash = execSync('git log -1 --format=%H', opts).trim();
        const subject = execSync('git log -1 --format=%s', opts).trim();
        const body = execSync('git log -1 --format=%b', opts).trim();
        const files = execSync('git show --stat --format= HEAD', opts).trim();
        return { hash, subject, body, files };
    } catch {
        return null;
    }
}

/**
 * Infer a service name from a deploy/restart command string.
 * @param {string} cmd
 * @returns {string}
 */
function extractServiceName(cmd) {
    const patterns = [
        /systemctl\s+(?:restart|start)\s+(\S+)/,
        /docker\s+restart\s+(\S+)/,
        /docker\s+compose\s+(?:up|restart)(?:\s+-\S+)*\s+(\S+)/,
    ];
    for (const p of patterns) {
        const m = cmd.match(p);
        if (m) return m[1];
    }
    if (/deploy\.sh/.test(cmd)) return 'deploy.sh';
    return cmd.slice(0, 60);
}

/**
 * Build the memory content, type, and tags for a Tier 1 event.
 * @param {string} eventType - 'gitCommit' | 'deployRestart' | 'decisionsFile'
 * @param {object} eventData - event-specific data
 * @param {string} contextWindow - formatted conversation window
 * @param {string|null} projectName
 * @returns {{ content: string, memoryType: string, tags: string[] }}
 */
function buildTier1Memory(eventType, eventData, contextWindow, projectName) {
    const baseTags = ['auto-capture', 'tier1'];
    if (projectName) baseTags.push(projectName.toLowerCase());

    if (eventType === 'gitCommit') {
        const { subject = '', body = '', files = '' } = eventData;
        const parts = [`## Commit: ${subject}`];
        if (body) parts.push(body);
        if (files) parts.push(`Files changed:\n${files}`);
        if (contextWindow) parts.push(`## Session Context\n${contextWindow}`);
        return {
            content: parts.join('\n\n'),
            memoryType: 'decision',
            tags: [...baseTags, 'commit'],
        };
    }

    if (eventType === 'deployRestart') {
        const cmd = eventData?.input?.command || 'unknown';
        const service = extractServiceName(cmd);
        const parts = [`## Deploy/Restart: ${service}`, `Command: \`${cmd}\``];
        if (contextWindow) parts.push(`## Session Context\n${contextWindow}`);
        return {
            content: parts.join('\n\n'),
            memoryType: 'note',
            tags: [...baseTags, 'deploy'],
        };
    }

    if (eventType === 'decisionsFile') {
        const raw = eventData?.input?.content || eventData?.input?.new_string || '';
        const entries = raw.match(/^\[\d{4}-\d{2}-\d{2}\].+/gm) || [];
        const latest = entries[entries.length - 1] || raw.slice(0, 500);
        return {
            content: `## Decision recorded\n${latest}`,
            memoryType: 'decision',
            tags: [...baseTags, 'decision'],
        };
    }

    return { content: '', memoryType: 'note', tags: baseTags };
}

// Export for Node.js
module.exports = {
    PATTERNS,
    USER_OVERRIDES,
    DEFAULT_CONFIG,
    detectPatterns,
    hasUserOverride,
    generateTags,
    truncateContent,
    computeContentHash,
    extractProjectName,
    detectTier1Event,
    detectTier2Signal,
    extractProseFromContent,
    truncateAtSentenceBoundary,
    cleanTurnText,
    extractContextWindow,
    countProseWords,
    getLastCommitInfo,
    extractServiceName,
    buildTier1Memory,
};
