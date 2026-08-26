/**
 * GUISE-BUILDER-WIZARD Phase 2 — headless tests for the 5-step wizard's PURE model:
 * step clamping/order, the affinity-draft edit helpers (step 4), and that a draft with /
 * without affinities compiles to the right GuiseDataModel (affinityMode + sets + cap),
 * preserving the pre-wizard output for ordinary guises. The ApplicationV2 subclass itself
 * is runtime-only; these cover everything the wizard's Next/Back nav and Affinities step wire.
 *
 * The module registers Foundry hooks at import time, so we shim the globals it touches BEFORE
 * a dynamic import (a static import would hoist above these assignments).
 * Run: `npm test` (node --test test/*.test.mjs) from the module root.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.Hooks = { on() {}, once() {} };
globalThis.CONFIG = { FU: {} };
globalThis.game = { modules: { get: () => null }, user: { isGM: false } };
globalThis.foundry = { utils: { hasProperty: () => false, escapeHTML: (s) => String(s ?? ''), mergeObject: (a, b) => ({ ...a, ...b }), randomID: () => 'idFIXEDforTEST1' } };
globalThis.ui = { notifications: { warn() {}, info() {} } };

const mod = await import('../scripts/rippers-guise.mjs');
const {
	WIZARD_STEPS, clampWizardStep, affinityLevelOf, withAffinityLevel, newAffinitySet,
	emptyGuiseDraft, guiseDraftToData, validateAffinitySet, draftKey, AFFINITY_TYPES,
} = mod;

// --- step model ---------------------------------------------------------------
test('WIZARD_STEPS is the 5-step flow in order (Identity → Classes → Skills → Affinities → Review)', () => {
	assert.equal(WIZARD_STEPS.length, 5);
	assert.deepEqual(WIZARD_STEPS.map((s) => s.key), ['identity', 'classes', 'skills', 'affinities', 'review']);
});

test('clampWizardStep pins navigation inside 1..5', () => {
	assert.equal(clampWizardStep(0), 1);      // Back from step 1 stays on 1
	assert.equal(clampWizardStep(1), 1);
	assert.equal(clampWizardStep(3), 3);
	assert.equal(clampWizardStep(5), 5);
	assert.equal(clampWizardStep(6), 5);      // Next from step 5 stays on 5
	assert.equal(clampWizardStep(-4), 1);
	assert.equal(clampWizardStep(NaN), 1);
});

// --- affinity-draft edits (step 4 wiring) -------------------------------------
test('emptyGuiseDraft carries the affinity fields, defaulting to an ordinary (modify) guise', () => {
	const d = emptyGuiseDraft();
	assert.equal(d.affinityMode, 'modify');
	assert.deepEqual(d.affinitySets, []);
	assert.equal(d.affinitySetCap, null);
	assert.equal(d.affinityCapSkill, '');
});

test('newAffinitySet produces a valid, empty set', () => {
	const s = newAffinitySet('idFIXEDforTEST1', 'Wolf');
	assert.equal(validateAffinitySet(s).ok, true);
	assert.deepEqual(s.affinities, []);
	assert.equal(s.name, 'Wolf');
});

test('affinityLevelOf reads the current level, 0 when unset', () => {
	const set = { id: 'a', affinities: [{ type: 'fire', level: 2 }] };
	assert.equal(affinityLevelOf(set, 'fire'), 2);
	assert.equal(affinityLevelOf(set, 'ice'), 0);
	assert.equal(affinityLevelOf(null, 'fire'), 0);
});

test('withAffinityLevel adds, overwrites, removes-on-none, and rejects illegal input', () => {
	let a = [];
	a = withAffinityLevel(a, 'fire', 2);                 // add Immunity
	assert.deepEqual(a, [{ type: 'fire', level: 2 }]);
	a = withAffinityLevel(a, 'fire', -1);                // overwrite -> Vulnerability
	assert.deepEqual(a, [{ type: 'fire', level: -1 }]);
	a = withAffinityLevel(a, 'ice', 3);                  // add Absorption
	assert.equal(a.length, 2);
	a = withAffinityLevel(a, 'fire', 0);                 // 0/none removes the entry
	assert.deepEqual(a, [{ type: 'ice', level: 3 }]);
	a = withAffinityLevel(a, 'notAnElement', 2);         // illegal type -> unchanged (entry dropped)
	assert.deepEqual(a, [{ type: 'ice', level: 3 }]);
	a = withAffinityLevel(a, 'earth', 99);               // illegal level -> not added
	assert.deepEqual(a, [{ type: 'ice', level: 3 }]);
	// the result is always a valid set body
	assert.equal(validateAffinitySet({ id: 'x', affinities: a }).ok, true);
});

// --- draft -> GuiseDataModel (compile) ----------------------------------------
test('a draft WITHOUT affinities compiles to an ordinary modify-mode guise (pre-wizard output preserved)', () => {
	const d = emptyGuiseDraft();
	d.classUuids = ['Compendium.x.classes.Item.aaa'];
	d.sl[draftKey('Compendium.x.classes.Item.aaa', 'Compendium.x.skills.Item.s1')] = 3;
	const data = guiseDraftToData(d, { 'Compendium.x.skills.Item.s1': 10 }, 30);
	assert.equal(data.affinityMode, 'modify');
	assert.deepEqual(data.affinitySets, []);
	assert.equal(data.affinitySetCap, null);
	assert.equal(data.classes[0].skills[0].sl, 3);
});

test('a draft WITH a monstrous-form set compiles to replace mode, validates sets, passes the cap through', () => {
	const d = emptyGuiseDraft();
	d.affinityMode = 'replace';
	d.affinitySets = [
		{ id: 'wolf', name: 'Wolf', affinities: withAffinityLevel(withAffinityLevel([], 'dark', 2), 'light', -1) },
		{ id: 'bad', name: 'Bad', affinities: [{ type: 'notreal', level: 2 }] },  // invalid -> dropped
	];
	d.affinitySetCap = 2;
	d.affinityCapSkill = 'Beast Within';
	const data = guiseDraftToData(d, {}, 30);
	assert.equal(data.affinityMode, 'replace');
	assert.equal(data.affinitySets.length, 1);                 // the invalid set is filtered out
	assert.equal(data.affinitySets[0].id, 'wolf');
	assert.equal(data.affinitySetCap, 2);
	assert.equal(data.affinityCapSkill, 'Beast Within');
});

test('declaring any valid set forces replace mode even if the draft still says modify', () => {
	const d = emptyGuiseDraft();
	d.affinitySets = [{ id: 's', name: 'S', affinities: [{ type: AFFINITY_TYPES[0], level: 1 }] }];
	const data = guiseDraftToData(d, {}, 30);
	assert.equal(data.affinityMode, 'replace');
});
