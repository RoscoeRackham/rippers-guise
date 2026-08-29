/**
 * GUISE-BUILDER-FIX v0.7.0 — headless tests for the wizard's PURE model + the construction
 * guardrails (Austin's ROS-24 rulings): the 6-step flow, the affinity TRIO (1 Immunity +
 * 1 Vulnerability + 1 Resistance, NEVER Absorption; Immunity⇒Vulnerability), exactly-3-classes,
 * the two build modes (worn mask vs the Innate Guise), and that every missing field now compiles
 * (equipment is no longer hardcoded []; perks/bonus/tell/bane/flaw/specialties ride through).
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
	WIZARD_STEPS, clampWizardStep, emptyGuiseDraft, guiseDraftToData, draftKey, AFFINITY_TYPES,
	validateAffinityTrio, affinityTrioToModifiers, validateGuiseDraft,
	PERK_LIST, SPECIALTY_LIST, SPECIALTY_COUNT, BONUS_CHECK_TYPES, GUISE_MODES, REQUIRED_CLASS_COUNT,
	validateAffinitySet, newAffinitySet, affinityLevelOf, withAffinityLevel,
} = mod;

const CU = (n) => `Compendium.x.classes.Item.${n}`;
const threeClasses = (d) => { d.classUuids = [CU('a'), CU('b'), CU('c')]; return d; };

// --- step model ---------------------------------------------------------------
test('WIZARD_STEPS is the 6-step flow in order', () => {
	assert.equal(WIZARD_STEPS.length, 6);
	assert.deepEqual(WIZARD_STEPS.map((s) => s.key), ['identity', 'classes', 'skills', 'loadout', 'affinities', 'review']);
});

test('clampWizardStep pins navigation inside 1..6', () => {
	assert.equal(clampWizardStep(0), 1);
	assert.equal(clampWizardStep(1), 1);
	assert.equal(clampWizardStep(6), 6);
	assert.equal(clampWizardStep(7), 6);      // Next from the last step stays put
	assert.equal(clampWizardStep(NaN), 1);
});

// --- draft defaults -----------------------------------------------------------
test('emptyGuiseDraft defaults to a worn mask with an empty trio and no monstrous fields', () => {
	const d = emptyGuiseDraft();
	assert.equal(d.mode, 'worn');
	assert.deepEqual(d.equipment, []);
	assert.deepEqual(d.perks, []);
	assert.equal(d.affinityImmunity, '');
	assert.equal(d.affinityVulnerability, '');
	assert.equal(d.affinityResistance, '');
	assert.equal('affinitySets' in d, false); // the monstrous library is gone from the builder (Q7)
});

// --- the affinity TRIO (Q7) ---------------------------------------------------
test('affinityTrioToModifiers maps the three slots to fixed levels and never produces Absorption', () => {
	const mods = affinityTrioToModifiers({ immunity: 'dark', vulnerability: 'light', resistance: 'fire' });
	assert.deepEqual(mods.sort((a, b) => a.type.localeCompare(b.type)), [
		{ type: 'dark', level: 2 }, { type: 'fire', level: 1 }, { type: 'light', level: -1 },
	].sort((a, b) => a.type.localeCompare(b.type)));
	// empties are skipped; a bad element is skipped
	assert.deepEqual(affinityTrioToModifiers({ immunity: '', vulnerability: '', resistance: 'ice' }), [{ type: 'ice', level: 1 }]);
	assert.deepEqual(affinityTrioToModifiers({ resistance: 'notreal' }), []);
	// NEVER Absorption (level 3): no slot maps to it
	assert.ok(affinityTrioToModifiers({ immunity: 'dark', vulnerability: 'light', resistance: 'fire' }).every((m) => m.level !== 3));
});

test('validateAffinityTrio enforces the canon backstop', () => {
	assert.equal(validateAffinityTrio({}).ok, true);                                               // empty trio is fine
	assert.equal(validateAffinityTrio({ resistance: 'fire' }).ok, true);                            // resistance-only is fine
	assert.equal(validateAffinityTrio({ immunity: 'dark', vulnerability: 'light', resistance: 'fire' }).ok, true);
	assert.equal(validateAffinityTrio({ immunity: 'dark' }).ok, false);                             // Immunity needs a Vulnerability
	assert.equal(validateAffinityTrio({ immunity: 'dark', vulnerability: 'dark' }).ok, false);      // one element, two slots
	assert.equal(validateAffinityTrio({ resistance: 'notreal' }).ok, false);                        // unknown element
});

// --- construction guardrails (Q4 three classes, Q1 innate specialties) --------
test('validateGuiseDraft (worn): requires exactly three DISTINCT classes', () => {
	assert.equal(validateGuiseDraft(emptyGuiseDraft(), 'worn').ok, false);                          // 0 classes
	const one = emptyGuiseDraft(); one.classUuids = [CU('a')];
	assert.equal(validateGuiseDraft(one, 'worn').ok, false);                                        // 1 class
	const four = emptyGuiseDraft(); four.classUuids = [CU('a'), CU('b'), CU('c'), CU('d')];
	assert.equal(validateGuiseDraft(four, 'worn').ok, false);                                       // 4 classes
	const dup = emptyGuiseDraft(); dup.classUuids = [CU('a'), CU('a'), CU('b')];
	assert.equal(validateGuiseDraft(dup, 'worn').ok, false);                                        // not distinct
	assert.equal(validateGuiseDraft(threeClasses(emptyGuiseDraft()), 'worn').ok, true);             // exactly 3 distinct
	assert.equal(REQUIRED_CLASS_COUNT, 3);
});

test('validateGuiseDraft (worn): a bad affinity trio blocks create', () => {
	const d = threeClasses(emptyGuiseDraft()); d.affinityImmunity = 'dark'; // no paired vulnerability
	const v = validateGuiseDraft(d, 'worn');
	assert.equal(v.ok, false);
	assert.ok(v.errors.some((e) => /Vulnerability/i.test(e)));
});

test('validateGuiseDraft (innate): requires exactly two Specialties, not the trio', () => {
	const d = threeClasses(emptyGuiseDraft()); d.mode = 'innate';
	assert.equal(validateGuiseDraft(d, 'innate').ok, false);                                        // 0 specialties
	d.specialties = [SPECIALTY_LIST[0]];
	assert.equal(validateGuiseDraft(d, 'innate').ok, false);                                        // 1 specialty
	d.specialties = [SPECIALTY_LIST[0], SPECIALTY_LIST[1]];
	assert.equal(validateGuiseDraft(d, 'innate').ok, true);
	assert.equal(SPECIALTY_COUNT, 2);
});

// --- draft -> GuiseDataModel (compile): the missing fields now ride through ----
test('a worn draft compiles equipment (no longer hardcoded []), the trio, perks and bonus', () => {
	const d = threeClasses(emptyGuiseDraft());
	d.sl[draftKey(CU('a'), 'Compendium.x.skills.Item.s1')] = 3;
	d.equipment = [{ itemUuid: 'Compendium.x.items.Item.armor1', slot: 'armor' }, { itemUuid: 'Compendium.x.items.Item.bad' }];
	d.affinityImmunity = 'dark'; d.affinityVulnerability = 'light'; d.affinityResistance = 'fire';
	d.perks = ['Nightsight', 'not-a-perk', 'Scent'];
	d.bonus = { type: 'accuracy', value: 3 };
	d.tell = 'eyes reflect green'; d.bane = 'silver'; d.flaw = 'cannot cross running water'; d.nature = 'a tall stranger';
	const data = guiseDraftToData(d, { 'Compendium.x.skills.Item.s1': 10 }, 30);
	assert.equal(data.mode, 'worn');
	assert.equal(data.equipment.length, 2);
	assert.equal(data.equipment[0].slot, 'armor');
	assert.equal(data.equipment[1].slot, 'mainHand');               // bad slot defaulted
	assert.deepEqual(data.affinityModifiers.map((m) => m.level).sort(), [-1, 1, 2]);
	assert.deepEqual(data.perks, ['Nightsight', 'Scent']);          // non-canon perk dropped
	assert.deepEqual(data.bonus, { type: 'accuracy', value: 3 });
	assert.equal(data.tell, 'eyes reflect green');
	assert.equal(data.bane, 'silver');
	assert.equal(data.nature, 'a tall stranger');
	assert.equal(data.affinityMode, 'modify');                      // the monstrous replace path is gone (Q7)
	assert.deepEqual(data.affinitySets, []);
	assert.equal(data.classes[0].skills[0].sl, 3);
});

test('an innate draft compiles Specialties + heroic and carries NO equipment/affinities/perk (Q1)', () => {
	const d = threeClasses(emptyGuiseDraft());
	d.mode = 'innate';
	d.specialties = [SPECIALTY_LIST[0], SPECIALTY_LIST[1], SPECIALTY_LIST[2]]; // over-count trimmed
	d.innateHeroicUuid = 'Compendium.x.heroics.Item.h1';
	d.equipment = [{ itemUuid: 'Compendium.x.items.Item.armor1', slot: 'armor' }]; // ignored on innate
	d.affinityImmunity = 'dark'; d.affinityVulnerability = 'light';               // ignored on innate
	d.perks = ['Nightsight'];                                                     // ignored on innate
	const data = guiseDraftToData(d, {}, 30);
	assert.equal(data.mode, 'innate');
	assert.deepEqual(data.equipment, []);
	assert.deepEqual(data.affinityModifiers, []);
	assert.deepEqual(data.perks, []);
	assert.equal(data.specialties.length, SPECIALTY_COUNT);         // trimmed to two
	assert.equal(data.innateHeroicUuid, 'Compendium.x.heroics.Item.h1');
});

// --- vocab sanity -------------------------------------------------------------
test('the canon vocabularies are well-formed', () => {
	assert.equal(SPECIALTY_LIST.length, 13);
	assert.ok(!PERK_LIST.includes('Flight'));                       // Flight is deliberately NOT a Perk
	assert.ok(PERK_LIST.includes('Kin-Speech'));
	assert.ok(GUISE_MODES.includes('worn') && GUISE_MODES.includes('innate'));
	// the Bonus taxonomy is provisional but must at least be a non-empty keyed list
	assert.ok(BONUS_CHECK_TYPES.length >= 2 && BONUS_CHECK_TYPES.every((t) => t.key && t.label));
});

// --- retained affinity-set helpers (still exported; used by the runtime collected-library API) ---
test('the affinity-set helpers remain valid (runtime library path, not the builder)', () => {
	const s = newAffinitySet('idFIXEDforTEST1', 'Wolf');
	assert.equal(validateAffinitySet(s).ok, true);
	assert.equal(affinityLevelOf({ id: 'a', affinities: [{ type: 'fire', level: 2 }] }, 'fire'), 2);
	assert.deepEqual(withAffinityLevel([], AFFINITY_TYPES[0], 1), [{ type: AFFINITY_TYPES[0], level: 1 }]);
});
