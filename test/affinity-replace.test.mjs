/**
 * FDN-9 — headless tests for MONSTROUS-FORM AFFINITIES: the affinity-set REPLACE engine
 * (buildReplaceChanges), the affinity-set / library validators, the once-per-turn swap guard, the
 * replace-vs-modify fork, authored+collected library merge, and the cap source. Pure helpers only; no
 * Foundry runtime. Run: `npm test` (node --test test/*.test.mjs) from the module root.
 *
 * The module registers Foundry hooks at import time (Hooks.on/once only), so we shim the globals it
 * touches BEFORE a dynamic import (a static import would hoist above these assignments).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.Hooks = { on() {}, once() {} };
globalThis.CONFIG = { FU: {} };
globalThis.game = { modules: { get: () => null }, user: { isGM: false } };
globalThis.foundry = { utils: { hasProperty: () => false, escapeHTML: (s) => String(s ?? '') } };
globalThis.ui = { notifications: { warn() {}, info() {} } };

const mod = await import('../scripts/rippers-guise.mjs');
const {
	buildReplaceChanges, validateAffinitySet, validateAffinityLibrary, affinitySwapAllowed,
	buildGuiseAffinityChanges, isReplaceModeGuise, getAffinityLibrary, getActiveAffinitySet,
	affinitySetCapOf, namedSkillSL, AFFINITY_TYPES, AE_OVERRIDE,
	// back-compat aliases
	validatePactSet, swapPactSet, swapAffinitySet, miasmicFormsSL,
} = mod;

const changeFor = (changes, el) => changes.find((c) => c.key === `system.affinities.${el}.current`);

// ---------------------------------------------------------------------------
// buildReplaceChanges — the nine-element true-OVERRIDE set (C1).
test('buildReplaceChanges emits exactly one OVERRIDE change per affinity element', () => {
	const changes = buildReplaceChanges([{ type: 'fire', level: 3 }]);
	assert.equal(changes.length, AFFINITY_TYPES.length);
	assert.equal(new Set(changes.map((c) => c.key)).size, AFFINITY_TYPES.length, 'no duplicate element keys');
	for (const c of changes) {
		assert.equal(c.mode, AE_OVERRIDE, 'every change is true OVERRIDE (mode 5)');
		assert.match(c.key, /^system\.affinities\.[a-z]+\.current$/, 'writes .current, never .base');
	}
});

test('buildReplaceChanges: listed elements take their absolute value, omitted elements become "0" (none) — REPLACE, not merge', () => {
	const changes = buildReplaceChanges([
		{ type: 'dark', level: 3 },   // absorb
		{ type: 'light', level: -1 }, // vulnerable
		{ type: 'fire', level: 2 },   // immune
	]);
	assert.equal(changeFor(changes, 'dark').value, '3');
	assert.equal(changeFor(changes, 'light').value, '-1');
	assert.equal(changeFor(changes, 'fire').value, '2');
	// An element the form does not touch must be wiped to none — this is what makes it a replacement,
	// so a native resistance the character owns does not leak through the mask.
	assert.equal(changeFor(changes, 'ice').value, '0');
	assert.equal(changeFor(changes, 'poison').value, '0');
});

test('buildReplaceChanges: value 0 (none) is explicitly overridden, so a form can LOWER a native affinity', () => {
	const changes = buildReplaceChanges([{ type: 'fire', level: 0 }]);
	assert.equal(changeFor(changes, 'fire').value, '0', 'fire pinned to none even though it was listed');
});

test('buildReplaceChanges: duplicate type is last-write-wins; unknown type and illegal level are ignored', () => {
	const changes = buildReplaceChanges([
		{ type: 'earth', level: 1 },
		{ type: 'earth', level: 3 },     // duplicate — last wins
		{ type: 'aether', level: 2 },    // unknown element — ignored (still 9 changes)
		{ type: 'air', level: 7 },       // out-of-range level — ignored → air stays "0"
	]);
	assert.equal(changes.length, AFFINITY_TYPES.length);
	assert.equal(changeFor(changes, 'earth').value, '3');
	assert.equal(changeFor(changes, 'air').value, '0');
	assert.equal(changeFor(changes, 'aether'), undefined);
});

test('buildReplaceChanges tolerates empty/nullish input (a guise with no active form)', () => {
	for (const input of [[], null, undefined]) {
		const changes = buildReplaceChanges(input);
		assert.equal(changes.length, AFFINITY_TYPES.length);
		assert.ok(changes.every((c) => c.value === '0'), 'all elements none');
	}
});

// ---------------------------------------------------------------------------
// validateAffinitySet
test('validateAffinitySet accepts a well-formed set and rejects malformed ones', () => {
	assert.equal(validateAffinitySet({ id: 's1', name: 'Fire Fiend', affinities: [{ type: 'fire', level: 3 }] }).ok, true);
	assert.equal(validateAffinitySet(null).ok, false);
	assert.equal(validateAffinitySet({ affinities: [] }).ok, false, 'missing id');
	assert.equal(validateAffinitySet({ id: 's', affinities: 'nope' }).ok, false, 'affinities not array');
	assert.equal(validateAffinitySet({ id: 's', affinities: [{ type: 'plasma', level: 1 }] }).ok, false, 'unknown type');
	assert.equal(validateAffinitySet({ id: 's', affinities: [{ type: 'fire', level: 9 }] }).ok, false, 'illegal level');
	assert.equal(validateAffinitySet({ id: 's', affinities: [{ type: 'fire', level: 1 }, { type: 'fire', level: 2 }] }).ok, false, 'duplicate type in one set');
	// The pre-release pact alias still resolves.
	assert.equal(validatePactSet({ id: 's', affinities: [{ type: 'ice', level: 2 }] }).ok, true, 'validatePactSet alias works');
});

// ---------------------------------------------------------------------------
// validateAffinityLibrary — unique ids and the cap.
test('validateAffinityLibrary enforces array, unique ids, and the cap', () => {
	const s = (id) => ({ id, name: id, affinities: [{ type: 'dark', level: 1 }] });
	assert.equal(validateAffinityLibrary([s('a'), s('b')]).ok, true, 'no cap → ok');
	assert.equal(validateAffinityLibrary('x').ok, false, 'not an array');
	assert.equal(validateAffinityLibrary([s('a'), s('a')]).ok, false, 'duplicate id');
	assert.equal(validateAffinityLibrary([s('a'), s('b'), s('c')], 2).ok, false, '3 sets, cap 2');
	assert.equal(validateAffinityLibrary([s('a'), s('b')], 2).ok, true, 'exactly at cap');
	assert.equal(validateAffinityLibrary([], 0).ok, true, 'empty within cap 0');
});

// ---------------------------------------------------------------------------
// affinitySwapAllowed — the once-per-turn free-swap guard (mirrors swapActiveForm).
test('affinitySwapAllowed: unrestricted outside combat, once per turn within it', () => {
	assert.equal(affinitySwapAllowed('1:0:abc', null), true, 'outside combat (sig null) always allowed');
	assert.equal(affinitySwapAllowed(undefined, null), true, 'never swapped, outside combat');
	assert.equal(affinitySwapAllowed('1:0:abc', '1:0:abc'), false, 'already swapped this exact turn');
	assert.equal(affinitySwapAllowed('1:0:abc', '1:1:def'), true, 'a new turn signature');
	assert.equal(affinitySwapAllowed(undefined, '2:0:xyz'), true, 'first swap this combat');
});

// ---------------------------------------------------------------------------
// The replace-vs-modify FORK (C3) and the authored+collected library merge — via a fake guise Item.
const fakeGuise = ({ flags = {}, data = {} } = {}) => ({
	type: 'classFeature',
	system: { featureType: 'rippers-guise.guise', data },
	getFlag: (ns, k) => (ns === 'rippers-guise' ? flags[k] : undefined),
});

test('isReplaceModeGuise: true with authored sets, a collected library, or affinityMode=replace; false for a legacy mask', () => {
	assert.equal(isReplaceModeGuise(fakeGuise({ data: { affinitySets: [{ id: 'a', affinities: [] }] } })), true, 'authored set');
	assert.equal(isReplaceModeGuise(fakeGuise({ flags: { affinityLibrary: [{ id: 'a', affinities: [] }] } })), true, 'collected in play');
	assert.equal(isReplaceModeGuise(fakeGuise({ data: { affinityMode: 'replace' } })), true, 'declared mode, no set yet');
	assert.equal(isReplaceModeGuise(fakeGuise({ data: { affinityModifiers: [{ type: 'fire', level: 1 }] } })), false, 'legacy additive');
	assert.equal(isReplaceModeGuise({ type: 'skill' }), false, 'not even a guise');
});

test('getAffinityLibrary merges authored + collected + legacy pact flag, deduped by id (authored wins)', () => {
	const item = fakeGuise({
		data: { affinitySets: [{ id: 'auth', name: 'Authored', affinities: [] }, { id: 'dup', name: 'Authored dup', affinities: [] }] },
		flags: {
			affinityLibrary: [{ id: 'coll', name: 'Collected', affinities: [] }, { id: 'dup', name: 'Collected dup (loses)', affinities: [] }],
			pactLibrary: [{ id: 'legacy', name: 'Legacy pact', affinities: [] }],
		},
	});
	const lib = getAffinityLibrary(item);
	assert.deepEqual(lib.map((s) => s.id), ['auth', 'dup', 'coll', 'legacy']);
	assert.equal(lib.find((s) => s.id === 'dup').name, 'Authored dup', 'authored wins the id collision');
});

test('getActiveAffinitySet: honours the active pointer, falls back to the first set for a single-form guise', () => {
	const multi = fakeGuise({
		data: { affinitySets: [{ id: 'a', affinities: [{ type: 'fire', level: 1 }] }, { id: 'b', affinities: [{ type: 'ice', level: 2 }] }] },
		flags: { activeAffinitySetId: 'b' },
	});
	assert.equal(getActiveAffinitySet(multi).id, 'b', 'explicit pointer');
	const single = fakeGuise({ data: { affinitySets: [{ id: 'only', affinities: [] }] } });
	assert.equal(getActiveAffinitySet(single).id, 'only', 'no pointer → first set');
	// legacy activePactId pointer still resolves
	const legacy = fakeGuise({ data: { affinitySets: [{ id: 'a', affinities: [] }, { id: 'b', affinities: [] }] }, flags: { activePactId: 'b' } });
	assert.equal(getActiveAffinitySet(legacy).id, 'b', 'legacy pact pointer honoured');
});

test('buildGuiseAffinityChanges forks: REPLACE guise → 9 OVERRIDEs from the active set; legacy guise → additive modifiers', () => {
	const replaceMask = fakeGuise({
		data: { affinitySets: [{ id: 's1', name: 'Ice Thing', affinities: [{ type: 'ice', level: 2 }] }] },
		flags: { activeAffinitySetId: 's1' },
	});
	const rc = buildGuiseAffinityChanges(replaceMask);
	assert.equal(rc.length, AFFINITY_TYPES.length, 'replace path = full nine-element set');
	assert.equal(changeFor(rc, 'ice').value, '2');
	assert.equal(changeFor(rc, 'fire').value, '0', 'untouched element wiped to none');

	// A replace-mode guise with affinityMode='replace' but NO sets yields NO changes (nothing applied yet).
	const empty = fakeGuise({ data: { affinityMode: 'replace' } });
	assert.deepEqual(buildGuiseAffinityChanges(empty), []);

	// Legacy guise keeps the additive MODIFY idiom (relative upgrade / override on listed elements only).
	const legacy = fakeGuise({ data: { affinityModifiers: [{ type: 'fire', level: 1 }, { type: 'dark', level: 2 }] } });
	const lc = buildGuiseAffinityChanges(legacy);
	assert.equal(lc.length, 2, 'only the listed modifiers, not all nine');
	assert.ok(lc.some((c) => c.key === 'system.affinities.fire' && c.value === 'upgrade'), 'relative upgrade preserved');
	assert.ok(lc.some((c) => c.key === 'system.affinities.dark.current'), 'immunity override preserved');
});

// ---------------------------------------------------------------------------
// Cap source — explicit number, governing-skill SL, or unbounded (Diabolist coupling removed).
test('namedSkillSL reads a named skill level, 0 when absent; miasmicFormsSL alias still resolves', () => {
	const actor = { items: [{ type: 'skill', name: 'Beast Shape', system: { level: { value: 4 } } }, { type: 'skill', name: 'Other', system: { level: { value: 9 } } }] };
	assert.equal(namedSkillSL(actor, 'Beast Shape'), 4);
	assert.equal(namedSkillSL(actor, 'beast shape'), 4, 'case-insensitive');
	assert.equal(namedSkillSL(actor, 'Nope'), 0);
	assert.equal(namedSkillSL({ items: [] }, 'X'), 0);
	assert.equal(miasmicFormsSL({ items: [{ type: 'skill', name: 'Miasmic Forms', system: { level: { value: 3 } } }] }), 3, 'alias');
});

test('affinitySetCapOf: explicit numeric cap wins; else governing-skill SL; else unbounded', () => {
	const actor = { items: [{ type: 'skill', name: 'Beast Shape', system: { level: { value: 5 } } }] };
	assert.equal(affinitySetCapOf(actor, fakeGuise({ data: { affinitySetCap: 3 } })), 3, 'explicit cap');
	assert.equal(affinitySetCapOf(actor, fakeGuise({ data: { affinitySetCap: 0 } })), 0, 'zero is a real cap');
	assert.equal(affinitySetCapOf(actor, fakeGuise({ data: { affinityCapSkill: 'Beast Shape' } })), 5, 'skill-governed cap');
	assert.equal(affinitySetCapOf(actor, fakeGuise({ data: {} })), Infinity, 'unbounded by default');
});

// ---------------------------------------------------------------------------
// Alias identity — the pact-* runtime entrypoints ARE the affinity-* ones (no divergent behaviour).
test('back-compat: swapPactSet is the same function as swapAffinitySet', () => {
	assert.equal(swapPactSet, swapAffinitySet);
});
