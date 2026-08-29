/**
 * v0.7.1 follow-up — headless tests for the Specialty die-bump PURE decision core (eligibility
 * excluding Magic/Accuracy per Austin's ruling; die improvement; which-die selection) and the
 * Hunter-Weapon-in-Innate compile. The runtime prepareCheck/processCheck hooks that raise the
 * transient die are FU-integration (verified live), not covered here.
 *
 * Globals shimmed BEFORE import (the module registers hooks at import time).
 * Run: `npm test`.
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
	specialtyBumpEligible, SPECIALTY_EXCLUDED_CHECKS, improveDieSize, CHECK_DIE_SIZES, chooseBumpSlot,
	HW_MATERIALS, emptyGuiseDraft, guiseDraftToData, SPECIALTY_LIST, validateGuiseDraft,
	actorSpecialties, armSpecialtyDieBump, disarmSpecialtyDieBump, SPECIALTY_ARM_FLAG, draftKey,
} = mod;

const CU = (n) => `Compendium.x.classes.Item.${n}`;
const threeClasses = (d) => { d.classUuids = [CU('a'), CU('b'), CU('c')]; return d; };
// v0.7.6 min-per-class: give each of the 3 classes a cheap skill so a draft is otherwise-valid.
const filled = (d) => { d.classUuids.filter(Boolean).forEach((cU, i) => { d.sl[draftKey(cU, `Compendium.x.skills.Item.fill${i}`)] = 1; }); return d; };

// A minimal FU-ish actor whose Innate guise holds Specialties. Flags stored in a plain object.
function stubActorWithSpecialties(specs = ['Medicine', 'Mechanics & Electrical Work']) {
	const flags = {};
	const innate = { type: 'classFeature', system: { featureType: 'rippers-guise.guise', data: { mode: 'innate', specialties: specs } }, getFlag: () => null };
	return {
		items: [innate],
		getFlag: (_m, k) => flags[k],
		setFlag: async (_m, k, v) => { flags[k] = v; },
		unsetFlag: async (_m, k) => { delete flags[k]; },
		_flags: flags,
	};
}

// --- Specialty die-bump eligibility (Austin: NOT Magic or Accuracy) -----------
test('specialtyBumpEligible excludes exactly magic/accuracy/display, allows the rest', () => {
	assert.equal(specialtyBumpEligible('magic'), false);
	assert.equal(specialtyBumpEligible('accuracy'), false);
	assert.equal(specialtyBumpEligible('display'), false);
	for (const t of ['open', 'attribute', 'opposed', 'group', 'support', 'ritual']) {
		assert.equal(specialtyBumpEligible(t), true, `${t} should be eligible`);
	}
	assert.equal(specialtyBumpEligible(''), false);       // no type
	assert.equal(specialtyBumpEligible(undefined), false);
	assert.deepEqual([...SPECIALTY_EXCLUDED_CHECKS], ['magic', 'accuracy', 'display']);
});

// --- die improvement ----------------------------------------------------------
test('improveDieSize walks d6→d8→d10→d12 and caps at d12', () => {
	assert.deepEqual([...CHECK_DIE_SIZES], [6, 8, 10, 12]);
	assert.equal(improveDieSize(6), 8);
	assert.equal(improveDieSize(8), 10);
	assert.equal(improveDieSize(10), 12);
	assert.equal(improveDieSize(12), 12);   // capped (d20 is Apex, not a Specialty target)
	assert.equal(improveDieSize(20), 20);   // unknown/apex unchanged
});

test('chooseBumpSlot prefers the named attribute when it is in the check, else primary', () => {
	const check = { primary: 'dex', secondary: 'ins' };
	assert.equal(chooseBumpSlot(check, 'ins'), 'secondary');
	assert.equal(chooseBumpSlot(check, 'dex'), 'primary');
	assert.equal(chooseBumpSlot(check, 'mig'), 'primary'); // preferred not in check → default primary
	assert.equal(chooseBumpSlot(check, null), 'primary');
});

// --- Hunter Weapon compile (Innate mode) --------------------------------------
test('an innate draft carries the Hunter Weapon ref + validated material + origin', () => {
	const d = threeClasses(emptyGuiseDraft());
	d.mode = 'innate';
	d.specialties = [SPECIALTY_LIST[0], SPECIALTY_LIST[1]];
	d.hunterWeaponUuid = 'Compendium.x.items.Item.arm';
	d.hunterMaterial = 'silver';
	d.hunterOrigin = 'the beast that took my hand';
	const data = guiseDraftToData(d, {}, 30);
	assert.equal(data.hunterWeaponUuid, 'Compendium.x.items.Item.arm');
	assert.equal(data.hunterMaterial, 'silver');
	assert.equal(data.hunterOrigin, 'the beast that took my hand');
});

test('a non-canon Hunter Weapon material is dropped on compile', () => {
	const d = threeClasses(emptyGuiseDraft());
	d.mode = 'innate';
	d.specialties = [SPECIALTY_LIST[0], SPECIALTY_LIST[1]];
	d.hunterMaterial = 'plutonium';
	assert.equal(guiseDraftToData(d, {}, 30).hunterMaterial, '');
	assert.ok(HW_MATERIALS.includes('silver') && HW_MATERIALS.includes('cursed') && HW_MATERIALS.length === 5);
});

test('a WORN draft never carries Hunter-Weapon or Specialty data', () => {
	const d = filled(threeClasses(emptyGuiseDraft()));
	d.hunterMaterial = 'silver'; d.hunterWeaponUuid = 'x'; d.specialties = [SPECIALTY_LIST[0], SPECIALTY_LIST[1]];
	const data = guiseDraftToData(d, {}, 30);
	assert.equal(data.hunterWeaponUuid ?? '', '');   // worn compile omits it
	assert.deepEqual(data.specialties, []);
	// and the Hunter Weapon has no bearing on worn-guise validity (trio still governs)
	assert.equal(validateGuiseDraft(d, 'worn').ok, true);
});

// --- v0.7.3 arm/disarm (sheet button + macro) ---------------------------------
test('actorSpecialties reads the two Specialties off the Innate guise', () => {
	assert.deepEqual(actorSpecialties(stubActorWithSpecialties(['Arts', 'Seamanship'])), ['Arts', 'Seamanship']);
	assert.deepEqual(actorSpecialties({ items: [] }), []); // no innate guise → none
});

test('armSpecialtyDieBump sets the arm flag when the character has Specialties; disarm clears it', async () => {
	const actor = stubActorWithSpecialties();
	const r = await armSpecialtyDieBump(actor, { attribute: 'ins' });
	assert.equal(r.ok, true);
	assert.deepEqual(actor.getFlag('rippers-guise', SPECIALTY_ARM_FLAG), { attribute: 'ins' });
	await disarmSpecialtyDieBump(actor);
	assert.equal(actor.getFlag('rippers-guise', SPECIALTY_ARM_FLAG), undefined);
});

test('armSpecialtyDieBump refuses a character with no Specialties', async () => {
	const actor = { items: [], getFlag: () => undefined, setFlag: async () => {}, unsetFlag: async () => {} };
	const r = await armSpecialtyDieBump(actor);
	assert.equal(r.ok, false);
	assert.equal(actor.getFlag('rippers-guise', SPECIALTY_ARM_FLAG), undefined);
});
