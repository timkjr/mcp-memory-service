/**
 * Claude Code Session End Hook
 * Automatically consolidates session outcomes and stores them as memories
 */

const fs = require('fs').promises;
const path = require('path');
const { resolveConfigPath } = require('../utilities/config-loader');
const https = require('https');
const http = require('http');

// Import utilities
const { detectProjectContext } = require('../utilities/project-detector');
const { formatSessionConsolidation } = require('../utilities/context-formatter');
const { detectUserOverrides, logOverride } = require('../utilities/user-override-detector');
const { MemoryClient } = require('../utilities/memory-client');

/**
 * Load hook configuration
 */
async function loadConfig() {
    try {
        const configPath = resolveConfigPath(__dirname);
        const configData = await fs.readFile(configPath, 'utf8');
        return JSON.parse(configData);
    } catch (error) {
        console.warn('[Memory Hook] Using default configuration:', error.message);
        return {
            memoryService: {
                http: {
                    endpoint: 'http://127.0.0.1:8000',
                    apiKey: 'test-key-123'
                },
                defaultTags: ['claude-code', 'auto-generated'],
                enableSessionConsolidation: true
            },
            sessionAnalysis: {
                extractTopics: true,
                extractDecisions: true,
                extractInsights: true,
                extractCodeChanges: true,
                extractNextSteps: true,
                minSessionLength: 100 // Minimum characters for meaningful session
            }
        };
    }
}

/**
 * Extract plain text from a message content field.
 * Handles both string content and content-block arrays (Claude API format).
 * Only returns text blocks — skips tool_use, tool_result, images, etc.
 */
function extractTextContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(block => block && block.type === 'text')
            .map(block => block.text || '')
            .join('\n');
    }
    return '';
}

/**
 * Return true for sentences that are tool output, JSON fragments, URLs,
 * stderr lines, or other noise that shouldn't be stored as a memory.
 */
function isNoisySentence(sentence) {
    const s = sentence.trim();
    if (s.length < 60) return true;
    if (/^\s*[{[\]`]/.test(s)) return true;                          // JSON / code block
    if (/"[a-z_]+"\s*:/.test(s)) return true;                        // JSON key-value
    if (/https?:\/\/\S{30,}/.test(s) && s.length < 150) return true; // bare URL line
    if (/^\s*(Warning|Error|WARN|INFO|DEBUG|FAIL)[\s:]/i.test(s)) return true; // log lines
    if (/Permanently added|remote:\s|\.git\/|stderr|stdout/.test(s)) return true; // git/shell
    if (/\bat_medium=|at_campaign=|feed":|"published":/.test(s)) return true;    // RSS
    if (/^[-*]\s+`/.test(s)) return true;                            // skill doc bullet
    return false;
}

/**
 * Split prose text into sentences, stripping content inside code blocks first.
 */
function extractProseSentences(text) {
    // Remove fenced code blocks entirely
    const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]+`/g, ' ');
    return prose.split(/[.!?]+/).map(s => s.trim()).filter(s => !isNoisySentence(s));
}

/**
 * Analyze conversation to extract key information.
 * Only examines assistant text turns — user messages, tool results, and
 * system content are excluded to prevent RSS feeds, skill docs, stderr,
 * and other tool output from being stored as decisions or insights.
 */
function analyzeConversation(conversationData) {
    try {
        const analysis = {
            topics: [],
            decisions: [],
            insights: [],
            codeChanges: [],
            nextSteps: [],
            sessionLength: 0,
            confidence: 0
        };

        if (!conversationData || !conversationData.messages) {
            return analysis;
        }

        const messages = conversationData.messages;

        // Pull assistant text only for content extraction
        const assistantTexts = messages
            .filter(msg => msg.role === 'assistant')
            .map(msg => extractTextContent(msg.content))
            .filter(text => text.length > 0);

        // Topics: keyword scan over all assistant text (broad, OK for classification)
        const allAssistantText = assistantTexts.join('\n').toLowerCase();
        analysis.sessionLength = allAssistantText.length;

        const topicKeywords = {
            'implementation': /implement|building|creating/g,
            'debugging': /debug|bug fix|fixing|troubleshoot/g,
            'architecture': /architecture|design decision|structure|pattern/g,
            'performance': /performance|optimization|faster|latency/g,
            'testing': /unit test|integration test|coverage/g,
            'deployment': /deploy|production|release/g,
            'configuration': /configuration|environment variable|settings/g,
            'database': /database|migration|schema|query/g,
            'api': /api endpoint|rest api|graphql/g,
            'ui': /frontend|component|css|html/g
        };

        Object.entries(topicKeywords).forEach(([topic, regex]) => {
            if (allAssistantText.match(regex)) analysis.topics.push(topic);
        });

        // Decisions, insights, code changes, next steps: prose sentences only
        const decisionPatterns = [
            /\b(decided to|chose to|going with|will use|opted for|concluded that)\b/i,
        ];
        const insightPatterns = [
            /\b(learned that|turns out|the reason is|the issue was|the fix is|discovered that|realized that)\b/i,
        ];
        const codeChangePatterns = [
            /\b(added|implemented|refactored|updated|fixed|removed|renamed|migrated)\b.{10,}\b(in|to|from|the)\b/i,
        ];
        const nextStepPatterns = [
            /\b(next step|still need to|todo|follow.?up|will need to|remaining)\b/i,
        ];

        for (const text of assistantTexts) {
            const sentences = extractProseSentences(text);
            for (const sentence of sentences) {
                const lower = sentence.toLowerCase();
                if (decisionPatterns.some(p => p.test(lower)))   analysis.decisions.push(sentence);
                if (insightPatterns.some(p => p.test(lower)))    analysis.insights.push(sentence);
                if (codeChangePatterns.some(p => p.test(lower))) analysis.codeChanges.push(sentence);
                if (nextStepPatterns.some(p => p.test(lower)))   analysis.nextSteps.push(sentence);
            }
        }

        // Deduplicate (same sentence can match multiple patterns)
        const dedup = arr => [...new Map(arr.map(s => [s.slice(0, 80), s])).values()];
        analysis.decisions  = dedup(analysis.decisions).slice(0, 3);
        analysis.insights   = dedup(analysis.insights).slice(0, 3);
        analysis.codeChanges = dedup(analysis.codeChanges).slice(0, 4);
        analysis.nextSteps  = dedup(analysis.nextSteps).slice(0, 3);

        const totalExtracted = analysis.decisions.length + analysis.insights.length +
                               analysis.codeChanges.length + analysis.nextSteps.length;
        analysis.confidence = Math.min(1.0, totalExtracted / 6);

        return analysis;

    } catch (error) {
        console.error('[Memory Hook] Error analyzing conversation:', error.message);
        return {
            topics: [], decisions: [], insights: [],
            codeChanges: [], nextSteps: [],
            sessionLength: 0, confidence: 0,
            error: error.message
        };
    }
}

/**
 * Decide whether an analyzed session is substantive enough to store.
 *
 * Topics and next-steps are keyword-matched on generic vocabulary
 * ("debugging", "testing", "should", "will") and fire on almost any
 * conversation, so they are NOT counted as evidence. Only decisions,
 * insights, and code changes indicate a session worth remembering.
 * This prevents trivial sessions from producing generic "Session Summary"
 * memories that score 0.0 on quality.
 *
 * The #remember override (forceRemember) bypasses the gate.
 */
function isSessionMeaningful(analysis, { forceRemember = false } = {}) {
    if (forceRemember) return true;
    if (!analysis) return false;
    const substantive = (analysis.decisions?.length || 0)
        + (analysis.insights?.length || 0)
        + (analysis.codeChanges?.length || 0);
    return substantive > 0;
}

/**
 * Trigger quality evaluation for a stored memory (async, non-blocking)
 * This calls the backend's quality scoring system to pre-score the memory
 */
function triggerQualityEvaluation(endpoint, apiKey, contentHash) {
    return new Promise((resolve, reject) => {
        const url = new URL(`/api/quality/memories/${contentHash}/evaluate`, endpoint);
        const isHttps = url.protocol === 'https:';
        const requestModule = isHttps ? https : http;

        const postData = JSON.stringify({});

        const options = {
            hostname: url.hostname,
            port: url.port ? Number(url.port) : (isHttps ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'Authorization': `Bearer ${apiKey}`
            },
            timeout: 10000 // 10 second timeout for quality evaluation
        };

        if (isHttps) {
            options.rejectUnauthorized = false;
        }

        const req = requestModule.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    resolve(response);
                } catch (parseError) {
                    resolve({ success: false, error: 'Parse error', data });
                }
            });
        });

        req.on('error', (error) => {
            resolve({ success: false, error: error.message });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({ success: false, error: 'Quality evaluation timed out' });
        });

        req.write(postData);
        req.end();
    });
}

/**
 * Trigger end-of-session harvest to extract learnings from transcript (async, non-blocking)
 */
function triggerHarvest(endpoint, apiKey, projectPath) {
    return new Promise((resolve) => {
        const url = new URL('/api/harvest', endpoint);
        const isHttps = url.protocol === 'https:';
        const requestModule = isHttps ? https : http;

        const postData = JSON.stringify({
            sessions: 1,
            dry_run: false,
            min_confidence: 0.6,
            project_path: projectPath || null
        });

        const options = {
            hostname: url.hostname,
            port: url.port ? Number(url.port) : (isHttps ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'Authorization': `Bearer ${apiKey}`
            },
            timeout: 15000
        };

        if (isHttps) options.rejectUnauthorized = false;

        const req = requestModule.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    const stored = response.results?.reduce((n, r) => n + (r.stored_count || 0), 0) ?? 0;
                    const candidates = response.results?.reduce((n, r) => n + (r.candidate_count || 0), 0) ?? 0;
                    console.log(`[Memory Hook] Harvest complete: ${stored} stored, ${candidates} candidates found`);
                    resolve(response);
                } catch {
                    resolve({ success: false });
                }
            });
        });

        req.on('error', (err) => {
            console.warn('[Memory Hook] Harvest failed:', err.message);
            resolve({ success: false });
        });
        req.on('timeout', () => { req.destroy(); resolve({ success: false }); });

        req.write(postData);
        req.end();
    });
}

/**
 * Store session consolidation to memory service
 */
async function storeSessionMemory(endpoint, apiKey, content, projectContext, analysis) {
    // Generate and normalize tags
    const tags = [
        'claude-code-session',
        'session-consolidation',
        projectContext.name,
        projectContext.language ? `language:${projectContext.language}` : null,
        ...analysis.topics.slice(0, 3),
        ...projectContext.frameworks.slice(0, 2),
        `confidence:${Math.round(analysis.confidence * 100)}`,
    ]
        .filter(Boolean)
        .map((tag) => String(tag).toLowerCase());

    const uniqueTags = [...new Set(tags)];

    const client = new MemoryClient({
        protocol: 'auto',
        preferredProtocol: 'http',
        http: { endpoint, apiKey },
    });

    try {
        await client.connect();
    } catch (err) {
        return { success: false, error: `Connect failed: ${err.message}` };
    }

    let result;
    try {
        result = await client.storeMemory(content, {
            tags: uniqueTags,
            memoryType: 'session-summary',
            metadata: {
                session_analysis: {
                    topics: analysis.topics,
                    decisions_count: analysis.decisions.length,
                    insights_count: analysis.insights.length,
                    code_changes_count: analysis.codeChanges.length,
                    next_steps_count: analysis.nextSteps.length,
                    session_length: analysis.sessionLength,
                    confidence: analysis.confidence,
                },
                project_context: {
                    name: projectContext.name,
                    language: projectContext.language,
                    frameworks: projectContext.frameworks,
                },
                generated_by: 'claude-code-session-end-hook',
                generated_at: new Date().toISOString(),
            },
        });
    } finally {
        await client.disconnect();
    }
    return result;
}

/**
 * Main session end hook function
 */
async function onSessionEnd(context) {
    try {
        // Check for user overrides in the last user message (#skip / #remember)
        let lastUserMessage = null;
        if (context.conversation && context.conversation.messages) {
            const userMessages = context.conversation.messages.filter(msg => msg.role === 'user');
            if (userMessages.length > 0) {
                lastUserMessage = userMessages[userMessages.length - 1].content || '';
            }
        }

        const overrides = detectUserOverrides(lastUserMessage);
        if (overrides.forceSkip) {
            logOverride('skip');
            console.log('[Memory Hook] Session consolidation skipped by user override (#skip)');
            return;
        }
        // forceRemember will bypass minSessionLength and confidence checks below

        console.log('[Memory Hook] Session ending - consolidating outcomes...');

        // Load configuration
        const config = await loadConfig();

        if (!config.memoryService.enableSessionConsolidation) {
            console.log('[Memory Hook] Session consolidation disabled in config');
            return;
        }
        
        // Check if session is meaningful enough to store (bypass with #remember)
        if (!overrides.forceRemember && context.conversation && context.conversation.messages) {
            const totalLength = context.conversation.messages
                .map(msg => (msg.content || '').length)
                .reduce((sum, len) => sum + len, 0);

            if (totalLength < config.sessionAnalysis.minSessionLength) {
                console.log('[Memory Hook] Session too short for consolidation');
                return;
            }
        }

        if (overrides.forceRemember) {
            logOverride('remember');
            console.log('[Memory Hook] Force consolidation requested (#remember)');
        }

        // Detect project context
        const projectContext = await detectProjectContext(context.workingDirectory || process.cwd());
        console.log(`[Memory Hook] Consolidating session for project: ${projectContext.name}`);

        // Analyze conversation
        const analysis = analyzeConversation(context.conversation);

        // Only store sessions with real substance (decisions/insights/code
        // changes). Topic- or next-step-only sessions are generic noise.
        // #remember bypasses this gate.
        if (!isSessionMeaningful(analysis, { forceRemember: overrides.forceRemember })) {
            console.log('[Memory Hook] Session not substantive (no decisions/insights/code changes), skipping consolidation');
            return;
        }
        
        console.log(`[Memory Hook] Session analysis: ${analysis.topics.length} topics, ${analysis.decisions.length} decisions, confidence: ${(analysis.confidence * 100).toFixed(1)}%`);
        
        // Format session consolidation
        const consolidation = formatSessionConsolidation(analysis, projectContext);

        // Get endpoint and apiKey from new config structure
        const endpoint = config.memoryService?.http?.endpoint || config.memoryService?.endpoint || 'http://127.0.0.1:8000';
        const apiKey = config.memoryService?.http?.apiKey || config.memoryService?.apiKey || 'test-key-123';

        // Store to memory service
        const result = await storeSessionMemory(
            endpoint,
            apiKey,
            consolidation,
            projectContext,
            analysis
        );
        
        const hash = result.content_hash || result.contentHash;
        if (result.success || hash) {
            console.log(`[Memory Hook] Session consolidation stored successfully`);
            if (hash) {
                console.log(`[Memory Hook] Memory hash: ${hash.substring(0, 8)}...`);

                // Trigger async quality evaluation (non-blocking)
                triggerQualityEvaluation(endpoint, apiKey, hash)
                    .then(evalResult => {
                        if (evalResult.success) {
                            console.log(`[Memory Hook] Quality evaluated: ${evalResult.quality_score?.toFixed(3)} (${evalResult.quality_provider})`);
                        }
                    })
                    .catch(err => {
                        // Don't fail the hook if quality evaluation fails
                        console.warn('[Memory Hook] Quality evaluation skipped:', err.message);
                    });
            }
        } else {
            console.warn('[Memory Hook] Failed to store session consolidation:', result.error || 'Unknown error');
        }

    } catch (error) {
        console.error('[Memory Hook] Error in session end:', error.message);
        // Fail gracefully - don't prevent session from ending
    }
}

/**
 * Hook metadata for Claude Code
 */
module.exports = {
    name: 'memory-awareness-session-end',
    version: '1.0.0',
    description: 'Automatically consolidate and store session outcomes',
    trigger: 'session-end',
    handler: onSessionEnd,
    config: {
        async: true,
        timeout: 15000, // 15 second timeout
        priority: 'normal'
    },
    // Exported for testing
    _internal: {
        parseTranscript: null,  // Will be set after function definition
        analyzeConversation,
        isSessionMeaningful
    }
};

/**
 * Read JSON context from stdin (provided by Claude Code)
 * Returns: { transcript_path, reason, cwd, session_id, ... }
 */
async function readStdinContext() {
    return new Promise((resolve, reject) => {
        let data = '';

        // Set a timeout in case stdin is empty or never closes
        const timeout = setTimeout(() => {
            resolve(null); // No stdin data - likely manual test run
        }, 100);

        process.stdin.setEncoding('utf8');
        process.stdin.on('readable', () => {
            let chunk;
            while ((chunk = process.stdin.read()) !== null) {
                data += chunk;
            }
        });

        process.stdin.on('end', () => {
            clearTimeout(timeout);
            if (data.trim()) {
                try {
                    resolve(JSON.parse(data));
                } catch (error) {
                    console.error('[Memory Hook] Failed to parse stdin JSON:', error.message);
                    reject(error);
                }
            } else {
                resolve(null);
            }
        });

        process.stdin.on('error', (error) => {
            clearTimeout(timeout);
            console.error('[Memory Hook] Stdin error:', error.message);
            reject(error);
        });
    });
}

/**
 * Parse JSONL transcript file to extract conversation messages
 * @param {string} transcriptPath - Path to the .jsonl transcript file
 * @returns {Object} - { messages: Array<{role, content}> }
 */
async function parseTranscript(transcriptPath) {
    try {
        const content = await fs.readFile(transcriptPath, 'utf8');
        const lines = content.trim().split('\n');
        const messages = [];

        for (const line of lines) {
            if (!line.trim()) continue;

            try {
                const entry = JSON.parse(line);

                // Only process user and assistant messages
                if (entry.type === 'user' || entry.type === 'assistant') {
                    const msg = entry.message;
                    if (msg && msg.role && msg.content) {
                        // Handle content that can be string or array of content blocks
                        let contentText = '';
                        if (typeof msg.content === 'string') {
                            contentText = msg.content;
                        } else if (Array.isArray(msg.content)) {
                            // Extract text from content blocks
                            contentText = msg.content
                                .filter(block => block.type === 'text')
                                .map(block => block.text)
                                .join('\n');
                        }

                        if (contentText) {
                            messages.push({
                                role: msg.role,
                                content: contentText
                            });
                        }
                    }
                }
            } catch (parseError) {
                // Skip malformed lines
                continue;
            }
        }

        return { messages };
    } catch (error) {
        console.error('[Memory Hook] Failed to parse transcript:', error.message);
        return { messages: [] };
    }
}

// Set parseTranscript on exports for testing (after function is defined)
module.exports._internal.parseTranscript = parseTranscript;

/**
 * Mock conversation for manual testing (when no stdin/transcript available)
 */
const mockConversation = {
    messages: [
        {
            role: 'user',
            content: 'I need to implement a memory awareness system for Claude Code'
        },
        {
            role: 'assistant',
            content: 'I\'ll help you create a memory awareness system. We decided to use hooks for session management and implement automatic context injection.'
        },
        {
            role: 'user',
            content: 'Great! I learned that we need project detection and memory scoring algorithms.'
        },
        {
            role: 'assistant',
            content: 'Exactly. I implemented the project detector in project-detector.js and created scoring algorithms. Next we need to test the complete system.'
        }
    ]
};

// Direct execution - reads stdin context from Claude Code
if (require.main === module) {
    (async () => {
        try {
            // Read context from stdin (Claude Code provides this)
            const stdinContext = await readStdinContext();

            let context;

            if (stdinContext && stdinContext.transcript_path) {
                // Real execution: parse transcript file
                console.log(`[Memory Hook] Reading transcript: ${stdinContext.transcript_path}`);
                console.log(`[Memory Hook] Session end reason: ${stdinContext.reason || 'unknown'}`);

                const conversation = await parseTranscript(stdinContext.transcript_path);

                context = {
                    workingDirectory: stdinContext.cwd || process.cwd(),
                    sessionId: stdinContext.session_id || 'unknown',
                    reason: stdinContext.reason,
                    conversation: conversation
                };

                console.log(`[Memory Hook] Parsed ${conversation.messages.length} messages from transcript`);
            } else {
                // Manual test: use mock data
                console.log('[Memory Hook] No stdin context - using mock data for testing');
                context = {
                    workingDirectory: process.cwd(),
                    sessionId: 'test-session',
                    conversation: mockConversation
                };
            }

            await onSessionEnd(context);
            console.log('Session end hook completed');

        } catch (error) {
            console.error('Session end hook failed:', error);
            process.exit(1);
        }
    })();
}