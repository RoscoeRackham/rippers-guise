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
	WIZARD_STEPS, clampWizardStep, emptyGuiseDraft, guiseDraftToData, guiseDataToDraft, draftKey, AFFINITY_TYPES,
	validateAffinityTrio, affinityTrioToModifiers, validateGuiseDraft,
	SPECIALTY_LIST, SPECIALTY_COUNT, TALENTED_SPECIALTY_COUNT, specialtyCapFor, GUISE_MODES, REQUIRED_CLASS_COUNT,
	validateAffinitySet, newAffinitySet, affinityLevelOf, withAffinityLevel,
	parseClassSkills, guiseStepErrors, SPECIALTY_ATTRIBUTES,
} = mod;

const CU = (n) => `Compendium.x.classes.Item.${n}`;
const threeClasses = (d) => { d.classUuids = [CU('a'), CU('b'), CU('c')]; return d; };
// v0.7.6: min-per-class now requires ≥1 SL in EACH of the 3 classes; give each a cheap skill so a
// draft can be otherwise-valid. Uses distinct filler skill uuids (default maxSl → no cap trip).
const filled = (d) => { d.classUuids.filter(Boolean).forEach((cU, i) => { d.sl[draftKey(cU, `Compendium.x.skills.Item.fill${i}`)] = 1; }); return d; };
// v0.7.9 (#3): a worn guise now requires its attached ("signature") Heroic to validate.
const wornOk = (d) => { d.attachedHeroicUuid = 'Compendium.x.heroics.Item.sig'; return d; };

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
	assert.equal(validateGuiseDraft(wornOk(filled(threeClasses(emptyGuiseDraft()))), 'worn').ok, true);      // exactly 3 distinct, each with a skill + signature heroic
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

test('v0.7.9: Specialties are FREE TEXT — a name off the list survives, empties/whitespace are dropped', () => {
	const d = threeClasses(emptyGuiseDraft());
	d.mode = 'innate';
	// Neither of these is in SPECIALTY_LIST; the picker whitelist is gone.
	d.specialties = ['Aetheric Cartography', '  Séance Etiquette  '];
	const data = guiseDraftToData(d, {}, 30);
	assert.deepEqual(data.specialties, ['Aetheric Cartography', 'Séance Etiquette']); // kept + trimmed
	// empties and blanks never count toward the two
	d.specialties = ['Only One', '', '   '];
	assert.equal(validateGuiseDraft(d, 'innate').ok, false); // one real specialty ≠ two
	assert.deepEqual(guiseDraftToData(d, {}, 30).specialties, ['Only One']);
});

test('v0.7.9: Talented => four Specialties (dynamic count); default stays two', () => {
	const four = ['Arts', 'Crafts', 'Medicine', 'Seamanship'];
	// default (not Talented): caps at two; four is over-count → trimmed, and validate wants exactly two
	const d2 = filled(threeClasses(emptyGuiseDraft())); d2.mode = 'innate'; d2.specialties = four;
	assert.equal(guiseDraftToData(d2, {}, 30).specialties.length, SPECIALTY_COUNT); // trimmed to 2
	assert.equal(guiseDraftToData(d2, {}, 30).talented, false);
	assert.equal(validateGuiseDraft(d2, 'innate').ok, false);                        // 4 ≠ 2
	// Talented: caps at four; the full spread survives and persists, validate wants exactly four
	const d4 = filled(threeClasses(emptyGuiseDraft())); d4.mode = 'innate'; d4.talented = true; d4.specialties = four;
	const data4 = guiseDraftToData(d4, {}, 30);
	assert.equal(data4.specialties.length, TALENTED_SPECIALTY_COUNT);
	assert.deepEqual(data4.specialties, four);
	assert.equal(data4.talented, true);                                              // persisted on the guise
	assert.equal(validateGuiseDraft(d4, 'innate').ok, true);
	// a Talented guise with only two Specialties is incomplete (needs four)
	d4.specialties = ['Arts', 'Crafts'];
	assert.equal(validateGuiseDraft(d4, 'innate').ok, false);
	assert.equal(specialtyCapFor(true), 4);
	assert.equal(specialtyCapFor(false), 2);
});

test('v0.7.9 (#2): an innate draft carries armor + accessory refs; a worn guise carries neither', () => {
	const d = filled(threeClasses(emptyGuiseDraft())); d.mode = 'innate';
	d.specialties = [SPECIALTY_LIST[0], SPECIALTY_LIST[1]];
	d.armorUuid = 'Compendium.x.items.Item.coat'; d.accessoryUuid = 'Compendium.x.items.Item.locket';
	const data = guiseDraftToData(d, {}, 30);
	assert.equal(data.armorUuid, 'Compendium.x.items.Item.coat');   // persisted for materialise + re-edit
	assert.equal(data.accessoryUuid, 'Compendium.x.items.Item.locket');
	// armor/accessory are innate-only (like Specialties): a WORN guise's data carries neither.
	const w = filled(threeClasses(emptyGuiseDraft())); w.armorUuid = 'x'; w.accessoryUuid = 'y';
	const wd = guiseDraftToData(w, {}, 30);
	assert.equal(wd.armorUuid, undefined);
	assert.equal(wd.accessoryUuid, undefined);
});

test('v0.7.9 (#3): a worn guise requires an attached (signature) Heroic and carries it; innate leaves it empty', () => {
	// soft-required: an otherwise-valid worn draft with NO attached heroic fails validation…
	const d = filled(threeClasses(emptyGuiseDraft()));
	const v0 = validateGuiseDraft(d, 'worn');
	assert.equal(v0.ok, false);
	assert.ok(v0.errors.some((e) => /attached Heroic/i.test(e)));
	// …the loadout step is where that error surfaces (not identity/classes/skills)…
	assert.equal(guiseStepErrors(d, 'worn', {}, 30, 'loadout').ok, false);
	assert.equal(guiseStepErrors(d, 'worn', {}, 30, 'classes').ok, true);
	// …and once set, the draft validates and guiseDraftToData carries the ref.
	d.attachedHeroicUuid = 'Compendium.x.heroics.Item.sig';
	assert.equal(validateGuiseDraft(d, 'worn').ok, true);
	assert.equal(guiseDraftToData(d, {}, 30).attachedHeroicUuid, 'Compendium.x.heroics.Item.sig');
	// the innate guise carries no attached heroic (it has its own creation-heroic slot instead)
	const innate = filled(threeClasses(emptyGuiseDraft())); innate.mode = 'innate';
	innate.specialties = [SPECIALTY_LIST[0], SPECIALTY_LIST[1]]; innate.attachedHeroicUuid = 'Compendium.x.heroics.Item.sig';
	assert.equal(guiseDraftToData(innate, {}, 30).attachedHeroicUuid, undefined);
});

test('v0.7.9 (#5) / v0.7.36: a worn guise carries attached effects that ride it; blanks dropped; the innate guise carries them too', () => {
	const d = wornOk(filled(threeClasses(emptyGuiseDraft())));
	d.attachedEffects = [
		{ itemUuid: 'Compendium.x.items.Item.akromorphosis', name: 'Greater Akromorphosis' },
		{ itemUuid: '', name: 'blank — dropped' },
	];
	const data = guiseDraftToData(d, {}, 30);
	assert.deepEqual(data.attachedEffects, [{ itemUuid: 'Compendium.x.items.Item.akromorphosis' }]); // kept + normalised; blank gone
	// v0.7.36 (Austin): the INNATE guise now carries attached effects too — it binds through the same
	// _bindCore path, so they ride on while unmasked and are stripped when a mask is worn.
	const innate = filled(threeClasses(emptyGuiseDraft())); innate.mode = 'innate';
	innate.specialties = [SPECIALTY_LIST[0], SPECIALTY_LIST[1]];
	innate.attachedEffects = [{ itemUuid: 'Compendium.x.items.Item.akromorphosis' }, { itemUuid: '' }];
	assert.deepEqual(guiseDraftToData(innate, {}, 30).attachedEffects, [{ itemUuid: 'Compendium.x.items.Item.akromorphosis' }]);
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
	const d = wornOk(filled(threeClasses(emptyGuiseDraft())));
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
	const d = wornOk(threeClasses(emptyGuiseDraft()));
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
	const d = wornOk(filled(threeClasses(emptyGuiseDraft()))); // 3 SL so far (1 per class) + signature heroic
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

// --- #4 (v0.7.9): editable builder — guiseDataToDraft round-trip + soft override validation --------
test('#4 guiseDataToDraft round-trips a WORN guise (guiseDraftToData ∘ guiseDataToDraft = identity)', () => {
	// A fully-authored worn draft → data (the canonical stored shape) → draft → data must be stable.
	const src = wornOk(filled(threeClasses(emptyGuiseDraft())));
	src.name = 'Inspector Grange'; src.role = 'plain-clothes'; src.nature = 'dogged'; src.notes = '<p>hi</p>';
	src.perk = 'Nightsight'; src.bonusDescriptor = 'when protecting a child'; src.tell = 'cold hands'; src.bane = 'silver'; src.flaw = 'no running water';
	src.affinityImmunity = 'dark'; src.affinityVulnerability = 'light'; src.affinityResistance = 'fire';
	src.equipment = [{ itemUuid: 'Compendium.x.weapons.Item.w', slot: 'mainHand' }];
	src.attachedEffects = [{ itemUuid: 'Compendium.x.effects.Item.e' }];
	const data = guiseDraftToData(src);
	const rebuilt = guiseDataToDraft(data);
	assert.deepEqual(guiseDraftToData(rebuilt), data, 'worn data must survive a data→draft→data round-trip');
	// spot-check the trio was reconstructed from affinityModifiers, not lost
	assert.equal(rebuilt.affinityImmunity, 'dark');
	assert.equal(rebuilt.affinityVulnerability, 'light');
	assert.equal(rebuilt.affinityResistance, 'fire');
	assert.equal(rebuilt.attachedHeroicUuid, src.attachedHeroicUuid);
});

test('#4 guiseDataToDraft round-trips the INNATE guise (specialties/talented/kit refs preserved)', () => {
	const src = filled(threeClasses(emptyGuiseDraft()));
	src.mode = 'innate'; src.name = 'The face'; src.notes = '<p>self</p>';
	src.talented = true; src.specialties = ['Tracking', 'Lockpicking', 'Cooking', 'Riding'];
	src.innateHeroicUuid = 'Compendium.x.heroics.Item.h';
	src.hunterWeaponUuid = 'Compendium.x.weapons.Item.hw'; src.hunterMaterial = 'silver'; src.hunterOrigin = 'grandfather\'s cane'; src.hunterIsBane = true;
	src.armorUuid = 'Compendium.x.armor.Item.a'; src.accessoryUuid = 'Compendium.x.accessory.Item.ac';
	const data = guiseDraftToData(src);
	const rebuilt = guiseDataToDraft(data);
	assert.deepEqual(guiseDraftToData(rebuilt), data, 'innate data must survive a data→draft→data round-trip');
	assert.equal(rebuilt.talented, true);
	assert.deepEqual(rebuilt.specialties, ['Tracking', 'Lockpicking', 'Cooking', 'Riding']);
	assert.equal(rebuilt.hunterMaterial, 'silver');
	assert.equal(rebuilt.hunterIsBane, true); // C3=A bane flag survives the round-trip
	assert.equal(rebuilt.armorUuid, 'Compendium.x.armor.Item.a');
});

test('#4 the GM override softens validation (findings become warnings, ok stays true)', () => {
	// A worn draft missing its attached signature Heroic is INVALID by default...
	const bad = filled(threeClasses(emptyGuiseDraft()));
	bad.affinityImmunity = 'dark'; bad.affinityVulnerability = 'light'; bad.affinityResistance = 'fire';
	const strict = validateGuiseDraft(bad, 'worn');
	assert.equal(strict.ok, false);
	assert.ok(strict.errors.some((e) => /attached Heroic/i.test(e)));
	assert.deepEqual(strict.warnings, []);
	// ...but with the override on, it is allowed through, the same finding riding as a warning.
	const soft = validateGuiseDraft(bad, 'worn', {}, undefined, { override: true });
	assert.equal(soft.ok, true);
	assert.deepEqual(soft.errors, []);
	assert.ok(soft.warnings.some((w) => /attached Heroic/i.test(w)));
});

test('#4 override does not fabricate warnings for an already-valid draft', () => {
	const good = wornOk(filled(threeClasses(emptyGuiseDraft())));
	good.affinityImmunity = 'dark'; good.affinityVulnerability = 'light'; good.affinityResistance = 'fire';
	const soft = validateGuiseDraft(good, 'worn', {}, undefined, { override: true });
	assert.equal(soft.ok, true);
	assert.deepEqual(soft.warnings, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// #2 (v0.7.9) — innate-kit swap post-creation: the PURE reconcile plan + the
// destructive apply, with the creation-heroic dormant-while-masked CARE POINT.
// ─────────────────────────────────────────────────────────────────────────────
const {
	innateKitReconcilePlan, innateKitPlanIsEmpty, reconcileInnateKit,
	getHeroicSlots, suppressCreationHeroic, isHunterWeapon,
} = mod;
const RGID = 'rippers-guise';
const DORMANT_HEROIC_FLAG = 'dormantCreationHeroic';

// --- the pure planner ---------------------------------------------------------
test('#2 planner: identical kit → empty plan (no destructive reconcile)', () => {
	const d = { innateHeroicUuid: 'H', hunterWeaponUuid: 'W', hunterMaterial: 'silver', hunterOrigin: 'o', armorUuid: 'A', accessoryUuid: 'C' };
	const p = innateKitReconcilePlan(d, { ...d });
	assert.equal(innateKitPlanIsEmpty(p), true);
	assert.deepEqual(p, { heroic: null, hunterWeapon: null, armor: null, accessory: null });
});

test('#2 planner: a swapped/added/cleared ref each yields an entry', () => {
	const p = innateKitReconcilePlan(
		{ innateHeroicUuid: 'H1', hunterWeaponUuid: 'W', armorUuid: 'A1', accessoryUuid: '' },
		{ innateHeroicUuid: 'H2', hunterWeaponUuid: 'W', armorUuid: '', accessoryUuid: 'C1' },
	);
	assert.deepEqual(p.heroic, { from: 'H1', to: 'H2' });      // swapped
	assert.equal(p.hunterWeapon, null);                         // unchanged
	assert.deepEqual(p.armor, { from: 'A1', to: '' });          // cleared
	assert.deepEqual(p.accessory, { from: '', to: 'C1' });      // added
	assert.equal(innateKitPlanIsEmpty(p), false);
});

test('#2 planner: Hunter Weapon — uuid change → remake; same uuid, material/origin moved → retag', () => {
	const remake = innateKitReconcilePlan({ hunterWeaponUuid: 'W1', hunterMaterial: 'silver' }, { hunterWeaponUuid: 'W2', hunterMaterial: 'silver' });
	assert.equal(remake.hunterWeapon.op, 'remake');
	assert.equal(remake.hunterWeapon.to, 'W2');
	const retag = innateKitReconcilePlan({ hunterWeaponUuid: 'W', hunterMaterial: 'silver', hunterOrigin: '' }, { hunterWeaponUuid: 'W', hunterMaterial: 'cold_iron', hunterOrigin: 'forge' });
	assert.equal(retag.hunterWeapon.op, 'retag');
	assert.equal(retag.hunterWeapon.material, 'cold_iron');
	assert.equal(retag.hunterWeapon.origin, 'forge');
	// no weapon at all, nothing moved → null
	assert.equal(innateKitReconcilePlan({ hunterWeaponUuid: '' }, { hunterWeaponUuid: '' }).hunterWeapon, null);
});

// --- a compact Foundry actor stub for the destructive apply -------------------
function foundrySet(obj, path, value) {
	const parts = path.split('.'); let o = obj;
	for (let i = 0; i < parts.length - 1; i++) o = (o[parts[i]] ??= {});
	o[parts[parts.length - 1]] = value;
}
const UUID_SRC = new Map();
globalThis.fromUuid = async (uuid) => UUID_SRC.get(uuid) ?? null;
function srcHeroic(name, { effects = [{ _id: 'e0', disabled: false, changes: [] }] } = {}) {
	return { type: 'heroic', name, toObject: () => ({ type: 'heroic', name, system: {}, flags: {}, effects: effects.map((e) => ({ ...e })) }) };
}
function srcWeapon(name) { return { type: 'weapon', name, toObject: () => ({ type: 'weapon', name, system: {}, flags: {} }) }; }
function srcEquip(slot, name) { return { type: slot, name, toObject: () => ({ type: slot, name, system: {}, flags: {} }) }; }

function makeItemDoc(id, o, actor) {
	const flags = JSON.parse(JSON.stringify(o.flags ?? {}));
	const efx = (o.effects ?? []).map((e, i) => ({ id: e._id || e.id || `${id}e${i}`, disabled: !!e.disabled, changes: e.changes ?? [] }));
	const effects = { filter: (fn) => efx.filter(fn), get: (eid) => efx.find((e) => e.id === eid) ?? null, map: (fn) => efx.map(fn), get length() { return efx.length; } };
	const doc = {
		id, type: o.type, name: o.name ?? '', system: JSON.parse(JSON.stringify(o.system ?? {})), flags, effects, _efx: efx,
		getFlag: (m, k) => flags[m]?.[k],
		setFlag: async (m, k, v) => { (flags[m] ??= {})[k] = v; },
		update: async (patch) => { for (const [k, v] of Object.entries(patch)) foundrySet(doc, k, v); },
		updateEmbeddedDocuments: async (_t, ups) => { for (const u of ups) { const e = efx.find((x) => x.id === u._id); if (e) e.disabled = !!u.disabled; } },
		toObject: () => ({ type: o.type, name: o.name, system: doc.system, flags: JSON.parse(JSON.stringify(flags)), effects: efx.map((e) => ({ _id: e.id, disabled: e.disabled, changes: e.changes })) }),
		delete: async () => { const i = actor.items._docs.indexOf(doc); if (i >= 0) actor.items._docs.splice(i, 1); },
	};
	return doc;
}
function stubActor({ level = 5 } = {}) {
	const flags = { [RGID]: {} };
	const docs = [];
	let n = 1;
	const items = { _docs: docs, get: (id) => docs.find((d) => d.id === id) ?? null, find: (fn) => docs.find(fn) ?? null, filter: (fn) => docs.filter(fn) };
	const actor = {
		system: { level: { value: level }, equipped: {} }, items, flags,
		getFlag: (m, k) => (m === RGID ? flags[RGID][k] : undefined),
		setFlag: async (m, k, v) => { if (m === RGID) flags[RGID][k] = v; },
		unsetFlag: async (m, k) => { if (m === RGID) delete flags[RGID][k]; },
		update: async (patch) => { for (const [k, v] of Object.entries(patch)) foundrySet(actor, k, v); },
		createEmbeddedDocuments: async (_t, objs) => objs.map((o) => { const d = makeItemDoc(`it${n++}`, o, actor); docs.push(d); return d; }),
	};
	return { actor, flags, docs };
}

// --- the destructive apply ----------------------------------------------------
test('#2 apply: swapping the creation heroic while masked keeps the new one DORMANT (care point)', async () => {
	UUID_SRC.set('H1', srcHeroic('Old Heroic'));
	UUID_SRC.set('H2', srcHeroic('New Heroic'));
	const { actor, flags, docs } = stubActor();
	// seed: old creation heroic materialised, seated, and ASLEEP under a worn mask
	const [old] = await actor.createEmbeddedDocuments('Item', [(await fromUuid('H1')).toObject()]);
	flags[RGID].heroicSlots = { creation: old.id, level40: null, level50: null, earned: [] };
	old._efx[0].disabled = true; // slept
	flags[RGID][DORMANT_HEROIC_FLAG] = { id: old.id, effects: ['e0'] };

	const { changed } = await reconcileInnateKit(actor, { innateHeroicUuid: 'H1' }, { innateHeroicUuid: 'H2' });
	assert.ok(changed.includes('heroic'));
	assert.equal(actor.items.get(old.id), null);                       // old deleted
	const newId = getHeroicSlots(actor).creation;
	const fresh = actor.items.get(newId);
	assert.equal(fresh.name, 'New Heroic');                            // new seated in the creation slot
	assert.equal(fresh._efx[0].disabled, true);                        // RE-SLEPT — dormancy preserved
	const snap = actor.getFlag(RGID, DORMANT_HEROIC_FLAG);
	assert.equal(snap.id, newId);                                      // snapshot points at the NEW heroic, not a deleted id
	assert.equal(docs.filter((d) => d.type === 'heroic').length, 1);   // no orphan left behind
});

test('#2 apply: swapping the creation heroic while UNMASKED leaves the new one awake (no dormancy)', async () => {
	UUID_SRC.set('H1', srcHeroic('Old'));
	UUID_SRC.set('H2', srcHeroic('New'));
	const { actor } = stubActor();
	const [old] = await actor.createEmbeddedDocuments('Item', [(await fromUuid('H1')).toObject()]);
	actor.flags = null; // (unused) — no dormant flag set; not masked
	await actor.setFlag(RGID, 'heroicSlots', { creation: old.id, level40: null, level50: null, earned: [] });
	const { changed } = await reconcileInnateKit(actor, { innateHeroicUuid: 'H1' }, { innateHeroicUuid: 'H2' });
	assert.ok(changed.includes('heroic'));
	const fresh = actor.items.get(getHeroicSlots(actor).creation);
	assert.equal(fresh.name, 'New');
	assert.equal(fresh._efx[0].disabled, false);                       // awake — not slept
	assert.equal(actor.getFlag(RGID, DORMANT_HEROIC_FLAG), undefined); // no snapshot created
});

test('#2 apply: armour swap unequips + deletes the old and equips the new; accessory untouched', async () => {
	UUID_SRC.set('A1', srcEquip('armor', 'Plate'));
	UUID_SRC.set('A2', srcEquip('armor', 'Mail'));
	const { actor } = stubActor();
	// seed an old innate armour, equipped
	const obj = (await fromUuid('A1')).toObject(); obj.flags[RGID] = { innateEquip: 'armor' };
	const [oldArmor] = await actor.createEmbeddedDocuments('Item', [obj]);
	await actor.update({ 'system.equipped.armor': oldArmor.id });
	const { changed } = await reconcileInnateKit(actor, { armorUuid: 'A1', accessoryUuid: '' }, { armorUuid: 'A2', accessoryUuid: '' });
	assert.deepEqual(changed, ['armor']);                              // accessory unchanged → not touched
	assert.equal(actor.items.get(oldArmor.id), null);                 // old deleted
	const equippedId = actor.system.equipped.armor;
	assert.equal(actor.items.get(equippedId).name, 'Mail');           // new equipped
	assert.equal(actor.items.get(equippedId).getFlag(RGID, 'innateEquip'), 'armor');
});

test('#2 apply: Hunter Weapon remake vs retag — retag keeps the SAME weapon Item (hoplospheres survive)', async () => {
	UUID_SRC.set('W1', srcWeapon('Blade'));
	UUID_SRC.set('W2', srcWeapon('Axe'));
	const { actor } = stubActor();
	const [old] = await actor.createEmbeddedDocuments('Item', [(await fromUuid('W1')).toObject()]);
	await mod.setHunterWeapon(old, { material: 'silver' });
	// retag: same uuid, new material → the SAME item Item is updated in place, not replaced
	await reconcileInnateKit(actor, { hunterWeaponUuid: 'W1', hunterMaterial: 'silver' }, { hunterWeaponUuid: 'W1', hunterMaterial: 'cold_iron' });
	assert.equal(actor.items.find((i) => isHunterWeapon(i)).id, old.id); // same Item
	assert.equal(actor.items.find((i) => isHunterWeapon(i)).getFlag(RGID, 'hunter').material, 'cold_iron');
	// remake: uuid change → old deleted, new materialised + marked
	await reconcileInnateKit(actor, { hunterWeaponUuid: 'W1', hunterMaterial: 'cold_iron' }, { hunterWeaponUuid: 'W2', hunterMaterial: 'silver' });
	assert.equal(actor.items.get(old.id), null);                        // old gone
	const hw = actor.items.find((i) => isHunterWeapon(i));
	assert.equal(hw.name, 'Axe');
	assert.equal(hw.getFlag(RGID, 'hunter').material, 'silver');
});

test('#3 fold-in: swapping innate armour WHILE MASKED repoints preBindEquip (no orphan) and does not displace the mask', async () => {
	UUID_SRC.set('A1', srcEquip('armor', 'Plate'));
	UUID_SRC.set('A2', srcEquip('armor', 'Mail'));
	const { actor, flags } = stubActor();
	// seed the OLD innate armour (owned, but currently DISPLACED by a worn mask — not equipped)
	const obj = (await fromUuid('A1')).toObject(); obj.flags[RGID] = { innateEquip: 'armor' };
	const [oldArmor] = await actor.createEmbeddedDocuments('Item', [obj]);
	// a mask is worn: the slot holds the mask's armour; the innate armour id lives in the restore-snapshot
	flags[RGID].activeGuise = 'wornMask';
	await actor.update({ 'system.equipped.armor': 'maskArmourItem' });
	flags[RGID].preBindEquip = { armor: oldArmor.id };

	const { changed } = await reconcileInnateKit(actor, { armorUuid: 'A1' }, { armorUuid: 'A2' });
	assert.deepEqual(changed, ['armor']);
	assert.equal(actor.items.get(oldArmor.id), null);                         // old deleted
	const fresh = actor.items.find((i) => i.getFlag(RGID, 'innateEquip') === 'armor');
	assert.equal(fresh.name, 'Mail');                                         // new materialised
	assert.equal(actor.system.equipped.armor, 'maskArmourItem');             // mask NOT displaced (equip:false while masked)
	assert.equal(actor.getFlag(RGID, 'preBindEquip').armor, fresh.id);       // snapshot repointed → dismiss restores the NEW armour
});
