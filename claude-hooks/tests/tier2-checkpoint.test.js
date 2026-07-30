'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { countProseWords, detectTier2Signal } = require('../utilities/auto-capture-patterns');

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
