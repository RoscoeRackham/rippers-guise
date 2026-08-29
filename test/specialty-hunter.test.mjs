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
} = mod;

const CU = (n) => `Compendium.x.classes.Item.${n}`;
const threeClasses = (d) => { d.classUuids = [CU('a'), CU('b'), CU('c')]; return d; };

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
	const d = threeClasses(emptyGuiseDraft());
	d.hunterMaterial = 'silver'; d.hunterWeaponUuid = 'x'; d.specialties = [SPECIALTY_LIST[0], SPECIALTY_LIST[1]];
	const data = guiseDraftToData(d, {}, 30);
	assert.equal(data.hunterWeaponUuid ?? '', '');   // worn compile omits it
	assert.deepEqual(data.specialties, []);
	// and the Hunter Weapon has no bearing on worn-guise validity (trio still governs)
	assert.equal(validateGuiseDraft(d, 'worn').ok, true);
});
