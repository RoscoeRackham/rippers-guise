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
	actorHunterWeapon, isHunterWeapon,
	CHECK_BUMP_KINDS, checkBumpEligible, flatCheckModifier,
	armCheckBump, armCheckFlatBump, disarmCheckFlatBump, pendingFlatModifier, CHECK_FLAT_ARM_FLAG,
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
	d.attachedHeroicUuid = 'Compendium.x.heroics.Item.sig'; // v0.7.9 (#3): worn guises need their signature heroic to validate
	const data = guiseDraftToData(d, {}, 30);
	assert.equal(data.hunterWeaponUuid ?? '', '');   // worn compile omits it
	assert.deepEqual(data.specialties, []);
	// and the Hunter Weapon has no bearing on worn-guise validity (trio + signature heroic govern)
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

// --- ROS-29: Specialties + Hunter Weapon are INVARIANT across guise swaps -----
// A worn-mask swap only flips the active-guise flag (and materialises/removes the mask's OWN skills
// and equipment). The Specialties live on the Innate-guise item and the Hunter Weapon is a plain
// character-owned weapon — neither is keyed off the active flag, so both survive A→B→none.
function makeWeapon(id, flags = {}) {
	return { id, type: 'weapon', getFlag: (_m, k) => flags[k], _flags: flags };
}
function guiseItem(id, mode) {
	return { id, type: 'classFeature', system: { featureType: 'rippers-guise.guise', data: { mode, specialties: mode === 'innate' ? ['Arts', 'Seamanship'] : [] } }, getFlag: (_m, k) => (k === 'isInnate' ? mode === 'innate' : null) };
}
function stubSwapActor() {
	const flags = { activeGuise: null };
	const innate = guiseItem('innate1', 'innate');
	const maskA = guiseItem('maskA', 'worn');
	const maskB = guiseItem('maskB', 'worn');
	const hw = makeWeapon('hw1', { isHunterWeapon: true, hunter: { material: 'silver', baneKey: 'silver' } });
	return {
		items: [innate, maskA, maskB, hw],
		getFlag: (_m, k) => flags[k],
		setFlag: async (_m, k, v) => { flags[k] = v; },
		unsetFlag: async (_m, k) => { delete flags[k]; },
		_flags: flags,
	};
}

test('actorHunterWeapon finds the character-owned marked weapon regardless of active guise', () => {
	const a = stubSwapActor();
	assert.equal(isHunterWeapon(a.items[3]), true);
	assert.equal(actorHunterWeapon(a).id, 'hw1');
	assert.equal(actorHunterWeapon({ items: [] }), null);
});

test('Specialties + Hunter Weapon stay invariant through a swap A → B → none', () => {
	const a = stubSwapActor();
	const readSpecs = () => actorSpecialties(a);
	const readHW = () => { const w = actorHunterWeapon(a); return w && { id: w.id, marked: isHunterWeapon(w) }; };
	// no mask
	assert.deepEqual(readSpecs(), ['Arts', 'Seamanship']);
	assert.deepEqual(readHW(), { id: 'hw1', marked: true });
	// bind mask A
	a._flags.activeGuise = 'maskA';
	assert.deepEqual(readSpecs(), ['Arts', 'Seamanship']);
	assert.deepEqual(readHW(), { id: 'hw1', marked: true });
	// swap to mask B
	a._flags.activeGuise = 'maskB';
	assert.deepEqual(readSpecs(), ['Arts', 'Seamanship']);
	assert.deepEqual(readHW(), { id: 'hw1', marked: true });
	// dismiss (none)
	a._flags.activeGuise = null;
	assert.deepEqual(readSpecs(), ['Arts', 'Seamanship']);
	assert.deepEqual(readHW(), { id: 'hw1', marked: true });
});

// --- Phase 2a: the generalized check-bump seam (die + flat) --------------------
test('CHECK_BUMP_KINDS is exactly the two kinds', () => {
	assert.deepEqual([...CHECK_BUMP_KINDS], ['die', 'flat']);
});

test("checkBumpEligible: 'die' keeps the Specialty carve-out; specialtyBumpEligible now rides it", () => {
	// die-bump = the Specialty rule: never Magic/Accuracy/display, everything else allowed.
	for (const t of ['magic', 'accuracy', 'display']) assert.equal(checkBumpEligible('die', t), false);
	for (const t of ['open', 'attribute', 'opposed', 'group', 'support', 'ritual']) assert.equal(checkBumpEligible('die', t), true);
	assert.equal(checkBumpEligible('die', ''), false);
	// specialtyBumpEligible is now defined as the 'die' arm — identical results, one source of truth.
	for (const t of ['magic', 'accuracy', 'display', 'open', 'attribute', 'ritual', '']) {
		assert.equal(specialtyBumpEligible(t), checkBumpEligible('die', t));
	}
});

test("checkBumpEligible: 'flat' has no Magic/Accuracy carve-out (only 'display' is excluded)", () => {
	// A flat check bonus (Robot's +2) is not the Specialty die-bump — it may ride magic/accuracy too;
	// WHICH checks it actually applies to (subject-scope) is the consumer's predicate, not this gate.
	for (const t of ['open', 'attribute', 'magic', 'accuracy', 'opposed', 'ritual']) assert.equal(checkBumpEligible('flat', t), true);
	assert.equal(checkBumpEligible('flat', 'display'), false); // not a real check
	assert.equal(checkBumpEligible('flat', ''), false);
});

test('flatCheckModifier builds the FU check.modifiers {label,value:int} entry, or null for nothing', () => {
	assert.deepEqual(flatCheckModifier(2, 'RIPPERS.Quirk.Robot'), { label: 'RIPPERS.Quirk.Robot', value: 2 });
	assert.deepEqual(flatCheckModifier(2.9, 'x'), { label: 'x', value: 2 });   // truncated to int
	assert.deepEqual(flatCheckModifier(-1, 'y'), { label: 'y', value: -1 });    // negatives allowed
	assert.equal(flatCheckModifier(0, 'z'), null);                              // adds nothing → null
	assert.equal(flatCheckModifier('nope', 'z'), null);                        // non-numeric → null
	assert.equal(flatCheckModifier(1).label, 'RIPPERS.Specialty.Arm');         // default label
});

// --- Phase 2a: the flat check-bump runtime (Robot rides the player-armed toggle) ----
function stubActorFlags() {
	const flags = {};
	return { getFlag: (_m, k) => flags[k], setFlag: async (_m, k, v) => { flags[k] = v; }, unsetFlag: async (_m, k) => { delete flags[k]; }, _flags: flags };
}

test('armCheckFlatBump arms a non-zero +N; zero/blank is refused; disarm clears', async () => {
	const a = stubActorFlags();
	const r = await armCheckFlatBump(a, { value: 2, label: 'RIPPERS.Quirk.Robot' });
	assert.equal(r.ok, true);
	assert.deepEqual(a.getFlag('rippers-guise', CHECK_FLAT_ARM_FLAG), { value: 2, label: 'RIPPERS.Quirk.Robot' });
	await disarmCheckFlatBump(a);
	assert.equal(a.getFlag('rippers-guise', CHECK_FLAT_ARM_FLAG), undefined);
	const z = await armCheckFlatBump(a, { value: 0 });
	assert.equal(z.ok, false);
	assert.equal(a.getFlag('rippers-guise', CHECK_FLAT_ARM_FLAG), undefined); // nothing armed
});

test('armCheckBump dispatches by kind: flat → flat flag, die → the Specialty arm', async () => {
	const flat = stubActorFlags();
	await armCheckBump(flat, { kind: 'flat', amount: 3, label: 'x' });
	assert.deepEqual(flat.getFlag('rippers-guise', CHECK_FLAT_ARM_FLAG), { value: 3, label: 'x' });
	assert.equal(flat.getFlag('rippers-guise', 'specialtyBump'), undefined); // not the die path
	// 'die' path defers to armSpecialtyDieBump (needs an Innate guise with Specialties)
	const die = stubActorWithSpecialties(['Arts', 'Seamanship']);
	await armCheckBump(die, { kind: 'die', attribute: 'mig' });
	assert.deepEqual(die.getFlag('rippers-guise', 'specialtyBump'), { attribute: 'mig' });
	assert.equal(die.getFlag('rippers-guise', CHECK_FLAT_ARM_FLAG), undefined);
});

test('pendingFlatModifier: armed+eligible → {label,value}; ineligible or unarmed → null', () => {
	const a = stubActorFlags();
	a._flags[CHECK_FLAT_ARM_FLAG] = { value: 2, label: 'RIPPERS.Quirk.Robot' };
	assert.deepEqual(pendingFlatModifier(a, 'open'), { label: 'RIPPERS.Quirk.Robot', value: 2 });
	assert.deepEqual(pendingFlatModifier(a, 'accuracy'), { label: 'RIPPERS.Quirk.Robot', value: 2 }); // flat has no magic/accuracy carve-out
	assert.equal(pendingFlatModifier(a, 'display'), null);  // not a real check
	assert.equal(pendingFlatModifier(stubActorFlags(), 'open'), null); // nothing armed
	// default label when none was stored
	a._flags[CHECK_FLAT_ARM_FLAG] = { value: 1, label: null };
	assert.equal(pendingFlatModifier(a, 'open').label, 'RIPPERS.Specialty.Arm');
});
