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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

globalThis.Hooks = { on() {}, once() {} };
globalThis.CONFIG = { FU: {} };
globalThis.game = { modules: { get: () => null }, user: { isGM: false } };
globalThis.foundry = { utils: { hasProperty: () => false, escapeHTML: (s) => String(s ?? ''), mergeObject: (a, b) => ({ ...a, ...b }), randomID: () => 'idFIXEDforTEST1' } };
globalThis.ui = { notifications: { warn() {}, info() {} } };

const mod = await import('../scripts/rippers-guise.mjs');
const {
	WIZARD_STEPS, clampWizardStep, emptyGuiseDraft, guiseDraftToData, draftKey, AFFINITY_TYPES,
	validateAffinityTrio, affinityTrioToModifiers, validateGuiseDraft,
	SPECIALTY_LIST, SPECIALTY_COUNT, GUISE_MODES, REQUIRED_CLASS_COUNT,
	validateAffinitySet, newAffinitySet, affinityLevelOf, withAffinityLevel,
	parseClassSkills, guiseStepErrors, SPECIALTY_ATTRIBUTES,
} = mod;

const CU = (n) => `Compendium.x.classes.Item.${n}`;
const threeClasses = (d) => { d.classUuids = [CU('a'), CU('b'), CU('c')]; return d; };
// v0.7.6: min-per-class now requires ≥1 SL in EACH of the 3 classes; give each a cheap skill so a
// draft can be otherwise-valid. Uses distinct filler skill uuids (default maxSl → no cap trip).
const filled = (d) => { d.classUuids.filter(Boolean).forEach((cU, i) => { d.sl[draftKey(cU, `Compendium.x.skills.Item.fill${i}`)] = 1; }); return d; };

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
	assert.equal(d.perk, '');       // v0.7.4: Perk is free text
	assert.equal(d.bonusDescriptor, ''); // v0.7.4: Bonus is a free-text narrative descriptor
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
	assert.equal(validateGuiseDraft(filled(threeClasses(emptyGuiseDraft())), 'worn').ok, true);      // exactly 3 distinct, each with a skill
	assert.equal(REQUIRED_CLASS_COUNT, 3);
});

test('validateGuiseDraft (worn): a bad affinity trio blocks create', () => {
	const d = threeClasses(emptyGuiseDraft()); d.affinityImmunity = 'dark'; // no paired vulnerability
	const v = validateGuiseDraft(d, 'worn');
	assert.equal(v.ok, false);
	assert.ok(v.errors.some((e) => /Vulnerability/i.test(e)));
});

test('validateGuiseDraft (innate): requires exactly two Specialties, not the trio', () => {
	const d = filled(threeClasses(emptyGuiseDraft())); d.mode = 'innate';
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
	d.perk = 'Nightsight, Scent';       // v0.7.4: free text
	d.bonusDescriptor = 'when acting to protect a child'; // v0.7.4: narrative descriptor, +3 GM-applied
	d.tell = 'eyes reflect green'; d.bane = 'silver'; d.flaw = 'cannot cross running water'; d.nature = 'a tall stranger';
	const data = guiseDraftToData(d, { 'Compendium.x.skills.Item.s1': 10 }, 30);
	assert.equal(data.mode, 'worn');
	assert.equal(data.equipment.length, 2);
	assert.equal(data.equipment[0].slot, 'armor');
	assert.equal(data.equipment[1].slot, 'mainHand');               // bad slot defaulted
	assert.deepEqual(data.affinityModifiers.map((m) => m.level).sort(), [-1, 1, 2]);
	assert.equal(data.perk, 'Nightsight, Scent');                   // free text rides through
	assert.deepEqual(data.bonus, { descriptor: 'when acting to protect a child', value: 3 });
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
	d.perk = 'Nightsight';                                                        // ignored on innate
	const data = guiseDraftToData(d, {}, 30);
	assert.equal(data.mode, 'innate');
	assert.deepEqual(data.equipment, []);
	assert.deepEqual(data.affinityModifiers, []);
	assert.equal(data.perk, '');
	assert.equal(data.specialties.length, SPECIALTY_COUNT);         // trimmed to two
	assert.equal(data.innateHeroicUuid, 'Compendium.x.heroics.Item.h1');
});

// --- vocab sanity -------------------------------------------------------------
test('the canon vocabularies are well-formed', () => {
	assert.equal(SPECIALTY_LIST.length, 13);
	assert.ok(GUISE_MODES.includes('worn') && GUISE_MODES.includes('innate'));
	// v0.7.4: Perk and Bonus are free text now — no fixed Perk list, no Bonus check-type taxonomy.
	assert.equal(mod.PERK_LIST, undefined);
	assert.equal(mod.BONUS_CHECK_TYPES, undefined);
});

// --- v0.7.4: per-skill SL cap (the live-builder bug) --------------------------
test('validateGuiseDraft rejects a single skill set above its own max SL', () => {
	const d = filled(threeClasses(emptyGuiseDraft()));
	const key = draftKey(CU('a'), 'Compendium.x.skills.Item.s1');
	d.sl[key] = 7;
	const skillMax = { 'Compendium.x.skills.Item.s1': 5 };
	const v = validateGuiseDraft(d, 'worn', skillMax);
	assert.equal(v.ok, false);
	assert.ok(v.errors.some((e) => /above its max/i.test(e)));
	// within max → ok
	d.sl[key] = 5;
	assert.equal(validateGuiseDraft(d, 'worn', skillMax).ok, true);
});

test('guiseDraftToData clamps an over-max single skill down to its max SL', () => {
	const d = threeClasses(emptyGuiseDraft());
	const key = draftKey(CU('a'), 'Compendium.x.skills.Item.s1');
	d.sl[key] = 99;
	const data = guiseDraftToData(d, { 'Compendium.x.skills.Item.s1': 4 }, 30);
	assert.equal(data.classes.find((c) => c.classUuid === CU('a')).skills[0].sl, 4); // capped, not 99
});

test('parseClassSkills defaults a no-badge (single-rank) skill to maxSl:1, not 10', () => {
	// build-compendium.mjs omits the 【Max SL N】 badge ONLY for max_sl=1 by convention.
	const html = [
		'@UUID[Compendium.x.skills.Item.single]{Single Rank}',
		'@UUID[Compendium.x.skills.Item.multi]{Multi Rank} <strong>【Max SL 5】</strong>',
	].join(' ');
	const parsed = parseClassSkills(html);
	const single = parsed.find((s) => s.name === 'Single Rank');
	const multi = parsed.find((s) => s.name === 'Multi Rank');
	assert.equal(single.maxSl, 1); // was 10 before the ROS-27 fallback fix
	assert.equal(multi.maxSl, 5);
});

test('a no-badge skill (max 1) clamps a SKILLS-step entry down to 1', () => {
	const html = '@UUID[Compendium.x.skills.Item.single]{Single Rank}';
	const skillMax = Object.fromEntries(parseClassSkills(html).map((s) => [s.uuid, s.maxSl]));
	const d = threeClasses(emptyGuiseDraft());
	const key = draftKey(CU('a'), 'Compendium.x.skills.Item.single');
	d.sl[key] = 4; // player tries to over-allocate a single-rank skill
	// Create is blocked…
	const v = validateGuiseDraft(d, 'worn', skillMax);
	assert.equal(v.ok, false);
	assert.ok(v.errors.some((e) => /above its max/i.test(e)));
	// …and compile clamps it to 1.
	const data = guiseDraftToData(d, skillMax, 30);
	assert.equal(data.classes.find((c) => c.classUuid === CU('a')).skills[0].sl, 1);
});

// --- v0.7.6: the guardrails the wizard now actually consumes ---------------------------------
test('validateGuiseDraft blocks all SL piled into ONE class (min-per-class)', () => {
	// 3 distinct classes but every point in class a → the other two are empty (Austin's live bug).
	const d = threeClasses(emptyGuiseDraft());
	d.sl[draftKey(CU('a'), 'Compendium.x.skills.Item.s1')] = 5;
	const v = validateGuiseDraft(d, 'worn', {}, 30);
	assert.equal(v.ok, false);
	assert.ok(v.errors.some((e) => /at least one skill/i.test(e)));
	// spread one point to each of b and c → satisfied.
	d.sl[draftKey(CU('b'), 'Compendium.x.skills.Item.s2')] = 1;
	d.sl[draftKey(CU('c'), 'Compendium.x.skills.Item.s3')] = 1;
	assert.equal(validateGuiseDraft(d, 'worn', {}, 30).ok, true);
});

test('validateGuiseDraft blocks an allocation over the total budget', () => {
	const d = filled(threeClasses(emptyGuiseDraft())); // 3 SL so far (1 per class)
	d.sl[draftKey(CU('a'), 'Compendium.x.skills.Item.big')] = 6; // → 9 total
	const v = validateGuiseDraft(d, 'worn', {}, 5); // budget 5 (a level-5 character)
	assert.equal(v.ok, false);
	assert.ok(v.errors.some((e) => /over the budget/i.test(e)));
	assert.equal(validateGuiseDraft(d, 'worn', {}, 30).ok, true); // fits a larger budget
});

test('guiseStepErrors scopes each rule to its own step (so Next gates without trapping step 1)', () => {
	const d = threeClasses(emptyGuiseDraft()); // 3 classes, no skills yet
	d.sl[draftKey(CU('a'), 'Compendium.x.skills.Item.s1')] = 9; // all in one class, over a 5 budget
	// identity step is never blocked by allocation…
	assert.equal(guiseStepErrors(d, 'worn', {}, 5, 'identity').ok, true);
	// classes step only cares about class count/distinctness (all fine here)…
	assert.equal(guiseStepErrors(d, 'worn', {}, 5, 'classes').ok, true);
	// …the skills step owns min-per-class AND budget, so it blocks.
	const sk = guiseStepErrors(d, 'worn', {}, 5, 'skills');
	assert.equal(sk.ok, false);
	assert.ok(sk.errors.some((e) => /at least one skill/i.test(e)));
	assert.ok(sk.errors.some((e) => /over the budget/i.test(e)));
	// review sees everything.
	assert.equal(guiseStepErrors(d, 'worn', {}, 5, 'review').ok, false);
});

test('the Specialty picker offers exactly the four FU attributes', () => {
	assert.deepEqual(SPECIALTY_ATTRIBUTES.map((a) => a.key), ['dex', 'ins', 'mig', 'wlp']);
});

// --- ROS-30: the Guise section header must be stamped EXACTLY ONCE ----------------------------
// The bug: the Benefit panel's header carried the `rippers-guise-header` class, so a
// `.rippers-guise-header` selector matched it too — the Guise header read as duplicated (one in the
// benefit panel, one in the guise panel). No jsdom here, so we assert on the source markup: the
// class must appear on exactly one <header> template, and the benefit panel must use its own class.
test('only one panel header wears rippers-guise-header; the benefit panel has its own', () => {
	const src = readFileSync(fileURLToPath(new URL('../scripts/rippers-guise.mjs', import.meta.url)), 'utf8');
	const headerClasses = [...src.matchAll(/<header class="([^"]*)"/g)].map((m) => m[1]);
	const guiseHeaders = headerClasses.filter((c) => /\brippers-guise-header\b/.test(c));
	const benefitHeaders = headerClasses.filter((c) => /\brippers-benefit-header\b/.test(c));
	assert.equal(guiseHeaders.length, 1, `exactly one <header> may carry rippers-guise-header (found ${guiseHeaders.length})`);
	assert.equal(benefitHeaders.length, 1, 'the benefit panel header must use rippers-benefit-header');
	// and no <header> carries BOTH classes
	assert.ok(!headerClasses.some((c) => /rippers-guise-header/.test(c) && /rippers-benefit-header/.test(c)));
});

test('the CSS styles the benefit header by its own class, not rippers-guise-header', () => {
	const css = readFileSync(fileURLToPath(new URL('../styles/guise.css', import.meta.url)), 'utf8');
	assert.ok(!/\.rippers-benefit-panel\s+\.rippers-guise-header\b/.test(css),
		'no CSS rule may target .rippers-benefit-panel .rippers-guise-header (it would restyle a header that no longer exists / re-couple the classes)');
});

// --- retained affinity-set helpers (still exported; used by the runtime collected-library API) ---
test('the affinity-set helpers remain valid (runtime library path, not the builder)', () => {
	const s = newAffinitySet('idFIXEDforTEST1', 'Wolf');
	assert.equal(validateAffinitySet(s).ok, true);
	assert.equal(affinityLevelOf({ id: 'a', affinities: [{ type: 'fire', level: 2 }] }, 'fire'), 2);
	assert.deepEqual(withAffinityLevel([], AFFINITY_TYPES[0], 1), [{ type: AFFINITY_TYPES[0], level: 1 }]);
});
