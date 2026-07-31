#!/usr/bin/env node
/**
 * Claude Code Auto-Capture Hook
 *
 * Tier 1 completion-event capture: detects git commits, deploy/restart
 * commands, and DECISIONS.md writes, and stores them with surrounding
 * conversation context.
 *
 * Trigger: PostToolUse (Edit, Write, Bash) — requires input.tool_name
 * Input: JSON via stdin with transcript_path and tool info
 *
 * @module auto-capture-hook
 * @version 1.0.0
 */

'use strict';

const fs = require('fs').promises;
const path = require('path');
const { resolveConfigPath, applyEnvOverrides } = require('../utilities/config-loader');
const { MemoryClient } = require('../utilities/memory-client');

// Import pattern detection
const {
    extractProjectName,
    detectTier1Event,
    extractContextWindow,
    buildTier1Memory,
    getLastCommitInfo,
} = require('../utilities/auto-capture-patterns');

/**
 * Load hook configuration
 */
async function loadConfig() {
    const configPath = resolveConfigPath(__dirname);
    try {
        const configData = await fs.readFile(configPath, 'utf8');
        const config = applyEnvOverrides(JSON.parse(configData));

        return {
            memoryService: config.memoryService || {
                http: {
                    endpoint: 'http://127.0.0.1:8000',
                    apiKey: ''
                }
            },
            autoCapture: {
                ...(config.autoCapture || {}),
                enabled: config.autoCapture?.enabled !== false,
                tier1: {
                    enabled: config.autoCapture?.tier1?.enabled !== false,
                    contextWindowSize: config.autoCapture?.tier1?.contextWindowSize || 8,
                },
                debugMode: config.autoCapture?.debugMode || false,
            }
        };
    } catch (error) {
        console.warn(`[auto-capture] Config not found at ${configPath}, using defaults:`, error.message);
        return {
            memoryService: {
                http: {
                    endpoint: 'http://127.0.0.1:8000',
                    apiKey: ''
                }
            },
            autoCapture: {
                enabled: true,
                tier1: {
                    enabled: true,
                    contextWindowSize: 8,
                },
                debugMode: false
            }
        };
    }
}

/**
 * Read input from stdin
 */
async function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        const timeout = setTimeout(() => {
            resolve(data || '{}');
        }, 1000);

        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => data += chunk);
        process.stdin.on('end', () => {
            clearTimeout(timeout);
            resolve(data);
        });
        process.stdin.on('error', reject);

        // Resume stdin in case it's paused
        process.stdin.resume();
    });
}

/**
 * Parse transcript file to extract last user and assistant messages
 */
async function parseTranscript(transcriptPath) {
    try {
        const content = await fs.readFile(transcriptPath, 'utf8');

        // Claude Code writes transcripts as JSONL (newline-delimited JSON),
        // one message envelope per line. Tolerate trailing whitespace and skip
        // malformed lines instead of failing the whole hook.
        const transcript = [];
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const parsed = JSON.parse(trimmed);
                const items = Array.isArray(parsed) ? parsed : [parsed];
                for (const item of items) {
                    if (item && typeof item === 'object') transcript.push(item);
                }
            } catch {
                // skip malformed line
            }
        }

        if (transcript.length === 0) {
            return null;
        }

        // Find last user and assistant messages
        let lastUser = null;
        let lastAssistant = null;

        for (let i = transcript.length - 1; i >= 0; i--) {
            const msg = transcript[i];
            // Claude Code envelope nests the actual message under `message`;
            // fall back to flat shape for compatibility with older formats.
            const role = msg.message?.role || msg.role || msg.type;
            const content = msg.message?.content ?? msg.content;

            if (!lastAssistant && role === 'assistant') {
                lastAssistant = extractTextContent(content);
            }
            if (!lastUser && role === 'user') {
                lastUser = extractTextContent(content);
            }

            if (lastUser && lastAssistant) break;
        }

        return {
            userMessage: lastUser || '',
            assistantMessage: lastAssistant || '',
            combined: `User: ${lastUser || '[no message]'}\n\nAssistant: ${lastAssistant || '[no response]'}`
        };
    } catch (error) {
        console.error('[auto-capture] Failed to parse transcript:', error.message);
        return null;
    }
}

/**
 * Extract text content from various message formats
 */
function extractTextContent(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .filter(item => item.type === 'text')
            .map(item => item.text)
            .join('\n');
    }

    return '';
}

/**
 * Store memory via MemoryClient
 */
async function storeMemory(config, content, memoryType, tags) {
    const client = new MemoryClient({
        protocol: 'auto',
        preferredProtocol: 'http',
        http: {
            endpoint: config.memoryService.http.endpoint,
            apiKey: config.memoryService.http.apiKey,
        },
    });

    try {
        await client.connect();
    } catch (err) {
        throw new Error(`Connect failed: ${err.message}`);
    }

    let result;
    try {
        result = await client.storeMemory(content, {
            tags,
            memoryType,
            metadata: {
                source: 'auto-capture',
                hook: 'PostToolUse',
                captured_at: new Date().toISOString(),
            },
        });
    } finally {
        await client.disconnect();
    }

    if (!result.success) {
        throw new Error(result.error || 'storeMemory returned success=false');
    }
    return result;
}

/**
 * Main hook execution
 */
async function main() {
    const startTime = Date.now();

    try {
        // Load configuration
        const config = await loadConfig();

        // Check if auto-capture is enabled
        if (!config.autoCapture.enabled) {
            if (config.autoCapture.debugMode) {
                console.log('[auto-capture] Disabled in configuration');
            }
            process.exit(0);
        }

        // Read stdin input
        const stdinData = await readStdin();
        let input = {};

        try {
            input = JSON.parse(stdinData);
        } catch {
            // No valid input, might be empty
            if (config.autoCapture.debugMode) {
                console.log('[auto-capture] No valid stdin input');
            }
            process.exit(0);
        }

        // Extract transcript path and cwd
        const transcriptPath = input.transcript_path || input.transcriptPath;
        const cwd = input.cwd || process.cwd();

        if (!transcriptPath) {
            if (config.autoCapture.debugMode) {
                console.log('[auto-capture] No transcript path provided');
            }
            process.exit(0);
        }

        // Parse transcript
        const transcript = await parseTranscript(transcriptPath);
        if (!transcript) {
            process.exit(0);
        }

        // --- Tier 1: completion event capture ---
        if (config.autoCapture.tier1.enabled) {
            const toolName = input.tool_name || '';
            const toolInput = input.tool_input || {};
            const tier1Event = detectTier1Event(toolName, toolInput);

            if (tier1Event) {
                let eventData = { input: toolInput };

                // For git commits, fetch actual commit info from git log
                if (tier1Event.type === 'gitCommit') {
                    const commitInfo = getLastCommitInfo(cwd);
                    if (commitInfo) {
                        eventData = commitInfo;
                    } else {
                        // Fallback: extract message from command if git log unavailable
                        const cmdMatch = (toolInput.command || '').match(/-m\s+['"]([^'"]+)['"]/);
                        eventData = { subject: cmdMatch ? cmdMatch[1] : 'commit', body: '', files: '' };
                    }
                }

                let contextWindow = '';
                try {
                    contextWindow = await extractContextWindow(
                        transcriptPath,
                        config.autoCapture.tier1.contextWindowSize
                    );
                } catch (err) {
                    if (config.autoCapture.debugMode) {
                        console.log(`[auto-capture] Context window extraction failed: ${err.message}`);
                    }
                }

                const projectName = extractProjectName(cwd);
                const { content, memoryType, tags } = buildTier1Memory(
                    tier1Event.type, eventData, contextWindow, projectName
                );

                if (content) {
                    if (config.autoCapture.debugMode) {
                        console.log(`[auto-capture] Tier 1 event: ${tier1Event.type}, storing as ${memoryType}`);
                    }
                    try {
                        await storeMemory(config, content, memoryType, tags);
                        if (config.autoCapture.debugMode) {
                            console.log(`[auto-capture] Tier 1 stored successfully`);
                        }
                    } catch (err) {
                        console.error(`[auto-capture] Tier 1 store failed: ${err.message}`);
                    }
                }
                // Don't exit — fall through to existing keyword detection as well,
                // which will likely not match (commit output rarely has keyword patterns),
                // and will exit normally.
            } else if (input.tool_name) {
                // PostToolUse call with no Tier 1 event — exit early to avoid processing full transcript
                if (config.autoCapture.debugMode) {
                    console.log(`[auto-capture] PostToolUse (${toolName}) - no Tier 1 event, exiting`);
                }
                process.exit(0);
            }
        }
        // --- end Tier 1 ---

        // No further capture path — Tier 1 above is the only source this hook stores.
        // (The legacy keyword-pattern "smart-ingest" capture was retired 2026-07-30:
        // its broad regexes matched almost any technical turn and stored raw
        // verbatim transcript with no prose filtering, dwarfing and duplicating
        // the deliberate Tier 1/Tier 2 capture system by volume.)
        process.exit(0);

    } catch (error) {
        const elapsed = Date.now() - startTime;
        console.error(`[auto-capture] Error after ${elapsed}ms:`, error.message);

        // Exit gracefully - don't block the user's workflow
        process.exit(0);
    }
}

// Run if executed directly
if (require.main === module) {
    main();
}

module.exports = { main, loadConfig, parseTranscript, storeMemory };
