/**
 * FDN-8 8b — headless tests for the HOPLOSPHERE SOCKET ruling (Austin, 2026-08-25):
 * weapon cadence 1→4, armor cadence 0→3, a 2-slot character-wide persistent pool that floats across
 * weapon+armor, and a CHARACTER-WIDE two-Immunity cap. Pure helpers only; no Foundry runtime.
 * Run: `npm test` (node --test test/*.test.mjs) from the module root.
 *
 * The module registers Foundry hooks at import time, so we shim the globals it touches BEFORE a
 * dynamic import (a static import would hoist above these assignments).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.Hooks = { on() {}, once() {} };
globalThis.CONFIG = { FU: {} };
globalThis.game = { modules: { get: () => null }, user: { isGM: false } };
globalThis.foundry = { utils: { hasProperty: () => false, escapeHTML: (s) => String(s ?? ''), mergeObject: (a, b) => ({ ...a, ...b }) } };
globalThis.ui = { notifications: { warn() {}, info() {} } };

const mod = await import('../scripts/rippers-guise.mjs');
const {
	hoplosphereSocketCapacity, baseSocketCapacity, persistentSlotsUnlocked, hoplosphereHostKind,
	checkHoplosphereSockets, characterHoplosphereImmunityCount, evaluateSlotting, seatedHoplospheres,
} = mod;

// --- fake builders ------------------------------------------------------------
const sphere = ({ slots = 1, imm = 0, statusImm = 0 } = {}) => ({
	type: 'hoplosphere',
	system: {
		requiredSlots: slots,
		effects: [
			...Array.from({ length: imm }, () => ({ type: 'gainImmunity' })),
			...Array.from({ length: statusImm }, () => ({ type: 'gainStatusImmunity' })),
		],
	},
});
// A host carrying `spheres`, wired to `actor` (which owns all hosts as .items).
function makeActor(level, hostSpecs) {
	const actor = { system: { level: { value: level } }, items: [] };
	const hosts = hostSpecs.map((h, i) => ({
		id: h.id ?? `h${i}`, name: h.name ?? `host${i}`, type: h.type,
		system: { slotted: (h.spheres ?? []) }, actor,
	}));
	actor.items = hosts;
	return { actor, hosts };
}

// --- host kind ----------------------------------------------------------------
test('hoplosphereHostKind maps customWeapon→weapon, armor→armor, else null', () => {
	assert.equal(hoplosphereHostKind({ type: 'customWeapon' }), 'weapon');
	assert.equal(hoplosphereHostKind({ type: 'armor' }), 'armor');
	assert.equal(hoplosphereHostKind({ type: 'weapon' }), null);
	assert.equal(hoplosphereHostKind(null), null);
});

// --- weapon cadence 1 → 4 -----------------------------------------------------
test('WEAPON base cadence: 1 at L1; +1 at 10/20/30; cap 4', () => {
	const w = { type: 'customWeapon' };
	assert.equal(baseSocketCapacity(w, { system: { level: { value: 1 } } }), 1);
	assert.equal(baseSocketCapacity(w, { system: { level: { value: 9 } } }), 1);
	assert.equal(baseSocketCapacity(w, { system: { level: { value: 10 } } }), 2);
	assert.equal(baseSocketCapacity(w, { system: { level: { value: 20 } } }), 3);
	assert.equal(baseSocketCapacity(w, { system: { level: { value: 30 } } }), 4);
	assert.equal(baseSocketCapacity(w, { system: { level: { value: 60 } } }), 4, 'no growth past 30 in the base track');
});

// --- armor cadence 0 → 3 ------------------------------------------------------
test('ARMOR base cadence: 0 at start; +1 at 10/20/30; cap 3', () => {
	const a = { type: 'armor' };
	assert.equal(baseSocketCapacity(a, { system: { level: { value: 1 } } }), 0);
	assert.equal(baseSocketCapacity(a, { system: { level: { value: 10 } } }), 1);
	assert.equal(baseSocketCapacity(a, { system: { level: { value: 20 } } }), 2);
	assert.equal(baseSocketCapacity(a, { system: { level: { value: 30 } } }), 3);
	assert.equal(baseSocketCapacity(a, { system: { level: { value: 55 } } }), 3);
});

// --- persistent pool 0/1/2 at 40/50 ------------------------------------------
test('persistent pool unlocks 1 at level 40, 1 at level 50', () => {
	assert.equal(persistentSlotsUnlocked({ system: { level: { value: 39 } } }), 0);
	assert.equal(persistentSlotsUnlocked({ system: { level: { value: 40 } } }), 1);
	assert.equal(persistentSlotsUnlocked({ system: { level: { value: 49 } } }), 1);
	assert.equal(persistentSlotsUnlocked({ system: { level: { value: 50 } } }), 2);
});

// --- floating pool adds to a host until spent elsewhere ------------------------
test('persistent slots float onto a host on top of its base, up to the pool size', () => {
	// L50 → weapon base 4 + persistent 2 (nothing spent elsewhere) = 6.
	const { hosts } = makeActor(50, [{ type: 'customWeapon', id: 'w' }, { type: 'armor', id: 'a' }]);
	const [w] = hosts;
	assert.equal(hoplosphereSocketCapacity(w), 6);
});

test('the 2-slot pool cannot be double-spent across weapon + armor', () => {
	// L50: weapon base 4, armor base 3. Armor seats 5 (3 base + 2 overflow → eats the whole pool).
	const { hosts } = makeActor(50, [
		{ type: 'customWeapon', id: 'w' },
		{ type: 'armor', id: 'a', spheres: [sphere(), sphere(), sphere(), sphere(), sphere()] }, // 5 slots
	]);
	const [w, a] = hosts;
	assert.equal(seatedHoplospheres(a).length, 5);
	// Armor's own effective cap is base 3 + full pool 2 = 5 → its loadout is legal.
	assert.equal(hoplosphereSocketCapacity(a), 5);
	// The weapon now sees the pool exhausted by armor's 2 overflow → base 4 + 0 = 4.
	assert.equal(hoplosphereSocketCapacity(w), 4);
});

// --- checkHoplosphereSockets audit -------------------------------------------
test('checkHoplosphereSockets reports base/persistent split and over-capacity', () => {
	const { hosts } = makeActor(30, [{ type: 'customWeapon', id: 'w', spheres: [sphere(), sphere(), sphere(), sphere(), sphere()] }]);
	const r = checkHoplosphereSockets(hosts[0]);
	assert.equal(r.baseCapacity, 4);
	assert.equal(r.persistentAvailable, 0, 'no persistent pool before level 40');
	assert.equal(r.capacity, 4);
	assert.equal(r.used, 5);
	assert.equal(r.overSockets, true);
	assert.equal(r.ok, false);
});

// --- CHARACTER-WIDE two-Immunity cap -----------------------------------------
test('two-Immunity cap sums across weapon AND armor (character-wide)', () => {
	const { actor, hosts } = makeActor(50, [
		{ type: 'customWeapon', id: 'w', spheres: [sphere({ imm: 1 })] },
		{ type: 'armor', id: 'a', spheres: [sphere({ statusImm: 1 })] },
	]);
	assert.equal(characterHoplosphereImmunityCount(actor), 2, 'one on the weapon + one on the armor = 2');
	const rw = checkHoplosphereSockets(hosts[0]);
	assert.equal(rw.immunities, 1, 'per-host count preserved for back-compat');
	assert.equal(rw.immunitiesCharacterWide, 2);
	assert.equal(rw.overImmunityCap, false, 'exactly two is allowed');
	assert.equal(rw.ok, true);
});

test('a third immunity anywhere on the character trips overImmunityCap', () => {
	const { actor, hosts } = makeActor(50, [
		{ type: 'customWeapon', id: 'w', spheres: [sphere({ imm: 2 })] },
		{ type: 'armor', id: 'a', spheres: [sphere({ imm: 1 })] },
	]);
	assert.equal(characterHoplosphereImmunityCount(actor), 3);
	assert.equal(checkHoplosphereSockets(hosts[1]).overImmunityCap, true);
});

// --- evaluateSlotting stays a pure per-set evaluator --------------------------
test('evaluateSlotting sums incoming slots + immunities against a supplied capacity', () => {
	const incoming = [sphere({ slots: 2 }), sphere({ imm: 1 })];
	const ev = evaluateSlotting(incoming, 3);
	assert.equal(ev.usedAfter, 3);
	assert.equal(ev.immAfter, 1);
	assert.equal(ev.overSockets, false);
	assert.equal(evaluateSlotting(incoming, 2).overSockets, true);
});
