// player-trading.test.mjs — pure tests for PC-to-PC trading helpers
// Must stub Foundry globals before importing the module (same pattern as rippers-sheet.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.Hooks = { on() {}, once() {} };
globalThis.CONFIG = { FU: {} };
globalThis.game = { modules: { get: () => null }, user: { isGM: false }, users: { activeGM: null } };
globalThis.foundry = { utils: { escapeHTML: (s) => String(s ?? ''), deepClone: (o) => JSON.parse(JSON.stringify(o ?? null)) } };
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.fromUuid = async (u) => null;
globalThis.fromUuidSync = (u) => null;

const { canGiveItem, parseGiveQty } = await import('../scripts/rippers-guise.mjs');

/* ── canGiveItem ── */

test('canGiveItem: unequipped item is giveable', () => {
	assert.equal(canGiveItem({}, false), true);
});

test('canGiveItem: equipped item is blocked', () => {
	assert.equal(canGiveItem({}, true), false);
});

/* ── parseGiveQty ── */

test('parseGiveQty: valid qty within range is returned as-is', () => {
	assert.equal(parseGiveQty('3', 5), 3);
	assert.equal(parseGiveQty('1', 5), 1);
	assert.equal(parseGiveQty('5', 5), 5);
});

test('parseGiveQty: qty over max is clamped to max', () => {
	assert.equal(parseGiveQty('10', 5), 5);
});

test('parseGiveQty: qty under 1 is clamped to 1', () => {
	assert.equal(parseGiveQty('0', 5), 1);
	assert.equal(parseGiveQty('-2', 5), 1);
});

test('parseGiveQty: non-numeric string defaults to max; empty string clamps to 1', () => {
	assert.equal(parseGiveQty('abc', 5), 5);  // NaN → not finite → max
	assert.equal(parseGiveQty('', 3), 1);      // '' → Number('')=0 → clamps to min 1
});

test('parseGiveQty: float is rounded', () => {
	assert.equal(parseGiveQty('2.9', 5), 3);
	assert.equal(parseGiveQty('1.1', 5), 1);
});

test('parseGiveQty: max=1 (non-stackable) always returns 1', () => {
	assert.equal(parseGiveQty('5', 1), 1);
	assert.equal(parseGiveQty('0', 1), 1);
});
