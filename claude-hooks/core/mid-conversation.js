#!/usr/bin/env node
/**
 * Tier 2 Checkpoint Hook — UserPromptSubmit
 *
 * Fires on two conditions:
 *   A) User message contains a conclusion/summary language signal
 *   B) Every 20 turns in sessions with no Tier 1 events
 *
 * Captures the last 10 conversation turns (prose only) as an insight or note.
 * Session state (turn counter) persists in /tmp/mcp-hooks-<session_id>.json.
 */

'use strict';

const fs = require('fs').promises;
const path = require('path');
const { resolveConfigPath } = require('../utilities/config-loader');
const { MemoryClient } = require('../utilities/memory-client');
const {
    detectTier2Signal,
    extractContextWindow,
    countProseWords,
    extractProjectName,
    hasUserOverride,
} = require('../utilities/auto-capture-patterns');

const STATE_DIR = '/tmp';

async function loadSessionState(sessionId) {
    const stateFile = path.join(STATE_DIR, `mcp-hooks-${sessionId}.json`);
    try {
        const data = await fs.readFile(stateFile, 'utf8');
        return JSON.parse(data);
    } catch {
        return { turnCount: 0, lastTier2Turn: 0 };
    }
}

async function saveSessionState(sessionId, state) {
    const stateFile = path.join(STATE_DIR, `mcp-hooks-${sessionId}.json`);
    await fs.writeFile(stateFile, JSON.stringify(state), 'utf8');
}

async function loadConfig() {
    const configPath = resolveConfigPath(__dirname);
    try {
        const data = await fs.readFile(configPath, 'utf8');
        const config = JSON.parse(data);
        return {
            memoryService: config.memoryService || { http: { endpoint: 'http://127.0.0.1:8000', apiKey: '' } },
            tier2: {
                enabled: config.autoCapture?.tier2?.enabled !== false,
                turnThreshold: config.autoCapture?.tier2?.turnThreshold || 20,
                cooldownTurns: config.autoCapture?.tier2?.cooldownTurns || 5,
                minProseWords: config.autoCapture?.tier2?.minProseWords || 150,
                debugMode: config.autoCapture?.debugMode || false,
            },
        };
    } catch {
        return {
            memoryService: { http: { endpoint: 'http://127.0.0.1:8000', apiKey: '' } },
            tier2: { enabled: true, turnThreshold: 20, cooldownTurns: 5, minProseWords: 150, debugMode: false },
        };
    }
}

async function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        const timeout = setTimeout(() => resolve(data || '{}'), 1000);
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => data += chunk);
        process.stdin.on('end', () => { clearTimeout(timeout); resolve(data); });
        process.stdin.on('error', () => resolve('{}'));
        process.stdin.resume();
    });
}

async function storeMemory(config, content, memoryType, tags) {
    const client = new MemoryClient({
        protocol: 'auto',
        preferredProtocol: 'http',
        http: {
            endpoint: config.memoryService.http.endpoint,
            apiKey: config.memoryService.http.apiKey,
        },
    });
    await client.connect();
    let result;
    try {
        result = await client.storeMemory(content, {
            tags,
            memoryType,
            metadata: { source: 'tier2-checkpoint', hook: 'UserPromptSubmit', captured_at: new Date().toISOString() },
        });
    } finally {
        await client.disconnect();
    }
    if (!result.success) throw new Error(result.error || 'store returned success=false');
    return result;
}

async function main() {
    try {
        const config = await loadConfig();
        if (!config.tier2.enabled) process.exit(0);

        const stdinData = await readStdin();
        let input = {};
        try { input = JSON.parse(stdinData); } catch { process.exit(0); }

        const sessionId = input.session_id || 'unknown';
        const transcriptPath = input.transcript_path || input.transcriptPath;
        const cwd = input.cwd || process.cwd();
        const userMessage = input.message || '';

        if (!transcriptPath) process.exit(0);

        // #skip override
        const overrides = hasUserOverride(userMessage);
        if (overrides.forceSkip) process.exit(0);

        // Load + increment session state
        const state = await loadSessionState(sessionId);
        state.turnCount += 1;

        const { turnThreshold, cooldownTurns, minProseWords, debugMode } = config.tier2;
        const turnsSinceLast = state.turnCount - state.lastTier2Turn;

        // Determine fire condition
        const isLanguageSignal = detectTier2Signal(userMessage);
        const isThresholdFire = (turnsSinceLast >= turnThreshold);
        const shouldFire = (isLanguageSignal || isThresholdFire) && (turnsSinceLast >= cooldownTurns);

        if (!shouldFire) {
            await saveSessionState(sessionId, state);
            process.exit(0);
        }

        if (debugMode) {
            const reason = isLanguageSignal ? 'language-signal' : 'turn-threshold';
            console.log(`[tier2] Firing (${reason}), turn ${state.turnCount}`);
        }

        // Extract conversation window
        const contextWindow = await extractContextWindow(transcriptPath, 10);
        const proseWords = countProseWords(contextWindow);

        if (proseWords < minProseWords) {
            if (debugMode) console.log(`[tier2] Skipping: only ${proseWords} prose words (min ${minProseWords})`);
            await saveSessionState(sessionId, state);
            process.exit(0);
        }

        // Build memory
        const projectName = extractProjectName(cwd);
        const memoryType = isLanguageSignal ? 'insight' : 'note';
        const tags = ['auto-capture', 'tier2', 'checkpoint'];
        if (projectName) tags.push(projectName.toLowerCase());

        const hostname = require('os').hostname();
        const topicHint = userMessage.slice(0, 120).replace(/\s+/g, ' ');
        const content = [
            `## Session Checkpoint — ${projectName || 'unknown project'} on ${hostname}`,
            `Working directory: ${cwd}`,
            isLanguageSignal ? `Trigger: "${topicHint}"` : `Trigger: turn threshold (${state.turnCount} turns)`,
            '',
            contextWindow,
        ].join('\n');

        await storeMemory(config, content, memoryType, tags);

        state.lastTier2Turn = state.turnCount;
        await saveSessionState(sessionId, state);

        if (debugMode) console.log(`[tier2] Stored ${memoryType} memory`);

        process.exit(0);
    } catch (err) {
        console.error('[tier2] Error:', err.message);
        process.exit(0);
    }
}

if (require.main === module) {
    main();
}

module.exports = { main, loadSessionState, saveSessionState };
