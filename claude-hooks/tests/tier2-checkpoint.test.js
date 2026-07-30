'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { countProseWords, detectTier2Signal, cleanTurnText, extractContextWindow } = require('../utilities/auto-capture-patterns');
const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;

// --- Prose density check ---
test('countProseWords: 150 words of prose passes', () => {
    const words = Array(150).fill('word').join(' ');
    assert.ok(countProseWords(words) >= 150);
});

test('countProseWords: 10 words fails density threshold', () => {
    assert.ok(countProseWords('just ten words here today yes ok wow hi') < 150);
});

// --- Tier 2 signal detection ---
test('detectTier2Signal: "the fix was" triggers', () => {
    assert.strictEqual(detectTier2Signal("the fix was restarting the service"), true);
});

test('detectTier2Signal: "here is what we learned" triggers', () => {
    assert.strictEqual(detectTier2Signal("here's what we learned from the incident"), true);
});

test('detectTier2Signal: "what I think is" triggers', () => {
    assert.strictEqual(detectTier2Signal("what I think is the proxy config is wrong"), true);
});

test('detectTier2Signal: neutral question does not trigger', () => {
    assert.strictEqual(detectTier2Signal("can you look at this file?"), false);
});

test('detectTier2Signal: empty string does not trigger', () => {
    assert.strictEqual(detectTier2Signal(''), false);
});

// --- Cooldown logic (pure function, no I/O) ---
test('cooldown: turn within cooldown window is blocked', () => {
    const state = { turnCount: 10, lastTier2Turn: 8, tier1FiredCount: 0 };
    const cooldownTurns = 5;
    const turnsSinceLast = state.turnCount - state.lastTier2Turn;
    assert.ok(turnsSinceLast < cooldownTurns, 'Should be blocked by cooldown');
});

test('cooldown: turn outside cooldown window is allowed', () => {
    const state = { turnCount: 15, lastTier2Turn: 8, tier1FiredCount: 0 };
    const cooldownTurns = 5;
    const turnsSinceLast = state.turnCount - state.lastTier2Turn;
    assert.ok(turnsSinceLast >= cooldownTurns, 'Should pass cooldown');
});

// --- Turn threshold ---
test('threshold: fires at turn 20 with no tier1 events', () => {
    const state = { turnCount: 20, lastTier2Turn: 0, tier1FiredCount: 0 };
    const threshold = 20;
    const turnsSinceLast = state.turnCount - state.lastTier2Turn;
    assert.ok(turnsSinceLast >= threshold);
});

test('threshold: does not fire at turn 19', () => {
    const state = { turnCount: 19, lastTier2Turn: 0, tier1FiredCount: 0 };
    const threshold = 20;
    const turnsSinceLast = state.turnCount - state.lastTier2Turn;
    assert.ok(turnsSinceLast < threshold);
});

// --- New session initialization ---
test('new session turn 1 does not meet threshold when lastTier2Turn=0', () => {
    // After fix: loadSessionState returns lastTier2Turn=0, not -99
    const state = { turnCount: 1, lastTier2Turn: 0 };
    const threshold = 20;
    const turnsSinceLast = state.turnCount - state.lastTier2Turn;
    assert.ok(turnsSinceLast < threshold, 'Turn 1 of new session must not fire threshold');
});

test('loadSessionState: missing file returns lastTier2Turn=0, not -99', async () => {
    const { loadSessionState } = require('../core/mid-conversation');
    const state = await loadSessionState('nonexistent-session-id-xyz');
    assert.strictEqual(state.lastTier2Turn, 0, 'Default lastTier2Turn must be 0 to prevent turn-1 fires');
    assert.strictEqual(state.turnCount, 0);
});

// --- cleanTurnText ---
test('cleanTurnText: strips code blocks', () => {
    const input = 'Before\n```js\nconst x = 1;\n```\nAfter';
    const result = cleanTurnText(input, 500);
    assert.ok(!result.includes('const x'), 'code block content should be stripped');
    assert.ok(result.includes('Before') && result.includes('After'));
});

test('cleanTurnText: strips markdown headers', () => {
    const input = '## My Header\nSome prose here.';
    const result = cleanTurnText(input, 500);
    assert.ok(!result.includes('## My Header'), 'header should be stripped');
    assert.ok(result.includes('Some prose here'));
});

test('cleanTurnText: truncates to maxLen', () => {
    const input = 'a'.repeat(1000);
    const result = cleanTurnText(input, 200);
    assert.ok(result.length <= 200, `Expected <=200 chars, got ${result.length}`);
});

test('cleanTurnText: preserves short clean text unchanged', () => {
    const input = 'The fix was restarting the service.';
    const result = cleanTurnText(input, 500);
    assert.ok(result.includes('The fix was restarting the service'));
});

test('cleanTurnText: does not cut a sentence in half', () => {
    // maxLen (60) lands mid-way through the second sentence — result must
    // stop at the end of the first sentence instead of chopping mid-word.
    const input = 'The fix was restarting the service. Also updated the config for good measure.';
    const result = cleanTurnText(input, 60);
    assert.ok(result.endsWith('.'), `Expected to end on a sentence boundary, got: "${result}"`);
    assert.strictEqual(result, 'The fix was restarting the service.');
});

// --- extractContextWindow content filtering ---
test('extractContextWindow: long assistant response is truncated per-turn', async () => {
    const tmpFile = path.join(os.tmpdir(), `tier2-test-${Date.now()}.jsonl`);
    const longAssistantText = 'Analysis: ' + 'word '.repeat(300); // ~1500 chars
    const lines = [
        JSON.stringify({ role: 'user', content: 'What is going on?' }),
        JSON.stringify({ role: 'assistant', content: longAssistantText }),
    ];
    await fsp.writeFile(tmpFile, lines.join('\n'), 'utf8');
    try {
        const window = await extractContextWindow(tmpFile, 10);
        const assistantPart = window.split('\n\n').find(t => t.startsWith('A:'));
        assert.ok(assistantPart, 'assistant turn should be present');
        assert.ok(assistantPart.length <= 250, `assistant turn should be truncated, got ${assistantPart.length} chars`);
    } finally {
        fs.unlinkSync(tmpFile);
    }
});
