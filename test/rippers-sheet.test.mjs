/**
 * Sheet Phase 1 — headless test for buildRippersSheetVM: the READ-ONLY view-model must bind real
 * actor.system.* (verified FU paths) and the guise API, inventing nothing. The ApplicationV2 sheet
 * class + Actors.registerSheet are runtime-only (foundry.applications.sheets), not covered here.
 * Run: `npm test` (node --test test/*.test.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.Hooks = { on() {}, once() {} };
globalThis.CONFIG = { FU: {} };
globalThis.game = { modules: { get: () => null }, user: { isGM: false } };
globalThis.foundry = { utils: { hasProperty: () => false, escapeHTML: (s) => String(s ?? ''), mergeObject: (a, b) => ({ ...a, ...b }), deepClone: (o) => JSON.parse(JSON.stringify(o ?? null)), randomID: () => 'idFIXEDforTEST1' }, data: { fields: {} } };
globalThis.ui = { notifications: { warn() {}, info() {} } };
const UUIDS = new Map();
globalThis.fromUuid = async (u) => UUIDS.get(u) ?? null;

const mod = await import('../scripts/rippers-guise.mjs');
const { buildRippersSheetVM, statusTargetActor, sheetAdjustResource, rsAffFlags, RS_STATUS_IDS, RS_TABS, sheetRollWeapon, sheetRest, sheetSpendFabula, sheetRollCheck, handOffDecision, sheetHandOffGuise } = mod;

const FEATURE_TYPE = 'rippers-guise.guise';
const RGID = 'rippers-guise';

function guise(id, { innate = false, role = '', affinityModifiers = [], classes = [], innateHeroicUuid = '', attachedHeroicUuid = '', lentHp, lentMp, ipSatchel } = {}) {
	const iflags = { [RGID]: { ...(innate ? { isInnate: true } : {}) } };
	return {
		id, name: `Guise ${id}`, img: `g${id}.png`, type: 'classFeature',
		system: { featureType: FEATURE_TYPE, data: { mode: innate ? 'innate' : 'worn', role, affinityModifiers, classes, innateHeroicUuid, attachedHeroicUuid, lentHp, lentMp, ipSatchel } },
		getFlag: (m, k) => iflags[m]?.[k], flags: iflags,
	};
}
function actorStub() {
	const flags = { [RGID]: { activeGuise: 'w1' } };
	const items = [
		guise('w1', { role: 'The Blade', affinityModifiers: [{ type: 'dark', level: 2 }, { type: 'light', level: -1 }, { type: 'fire', level: 1 }], classes: [{ classUuid: 'c1', skills: [{ skillUuid: 's1', sl: 2 }, { skillUuid: 's2', sl: 1 }] }], attachedHeroicUuid: 'H.worn', lentHp: { current: 3, maximum: 6 } }),
		guise('inn', { innate: true, innateHeroicUuid: 'H.creation', classes: [{ classUuid: 'c2', skills: [{ skillUuid: 's3', sl: 4 }] }], ipSatchel: { stock: 2, capacity: 8 } }),
	];
	const list = {
		filter: (fn) => items.filter(fn),
		get: (id) => items.find((i) => i.id === id) ?? null,
	};
	return {
		name: 'Cordelia', img: 'port.png',
		system: {
			level: { value: 12 },
			resources: {
				hp: { value: 20, max: 55, inCrisis: true, crisisScore: 27 },
				mp: { value: 10, max: 40 }, ip: { value: 4, max: 6 }, fp: { value: 3 },
				exp: { value: 8 }, zenit: { value: 250 },
				identity: { name: 'The Masked Duelist' }, pronouns: { name: 'she/her' },
				theme: { name: 'Vengeance' }, origin: { name: 'Whitechapel' },
			},
			attributes: { dex: { current: 10 }, ins: { current: 8 }, mig: { base: 6 }, wlp: { current: 12 } },
			affinities: { physical: { current: 0 }, air: { current: 0 }, bolt: { current: -1 }, dark: { current: 2 }, earth: { current: 0 }, fire: { current: 1 }, ice: { current: 0 }, light: { current: 0 }, poison: { current: 3 } },
			bonds: [
				{ name: 'Dr. Vane', admInf: 'Admiration', loyMis: 'Loyalty', affHat: '', strength: 3 },
				{ name: '', admInf: '', loyMis: '', affHat: '', strength: 0 }, // empty → dropped
			],
		},
		itemTypes: { class: [{ name: 'Rogue' }, { name: 'Chimerist' }] },
		items: list,
		statuses: new Set(['slow', 'dazed']),
		getFlag: (m, k) => (m === RGID ? flags[RGID][k] : undefined),
	};
}

test('buildRippersSheetVM binds the masthead + vitals + crisis from real actor.system.*', async () => {
	UUIDS.set('H.worn', { name: 'Riposte' });
	UUIDS.set('H.creation', { name: 'First Blood' });
	const vm = await buildRippersSheetVM(actorStub());
	assert.equal(vm.masthead.name, 'Cordelia');
	assert.equal(vm.masthead.level, 12);
	assert.deepEqual(vm.masthead.classes, ['Rogue', 'Chimerist']);
	assert.equal(vm.masthead.identity, 'The Masked Duelist');
	assert.equal(vm.masthead.pronouns, 'she/her');
	assert.equal(vm.masthead.theme, 'Vengeance');
	assert.equal(vm.vitals.hp.value, 20); assert.equal(vm.vitals.hp.max, 55);
	assert.equal(vm.vitals.mp.value, 10); assert.equal(vm.vitals.mp.max, 40);
	assert.equal(vm.vitals.ip.value, 4); assert.equal(vm.vitals.ip.max, 6);
	// X1: vitals carry a lent-overlay bar/dots (the worn guise w1 lends HP 3 in the stub)
	assert.equal(vm.vitals.hp.bar.display, '20 (+3)');
	assert.equal(vm.vitals.hp.bar.lent, 3);
	assert.ok(Array.isArray(vm.vitals.ip.dots.dots));
	assert.equal(vm.vitals.fp, 3);
	assert.equal(vm.vitals.exp, 8);
	assert.equal(vm.vitals.crisis.inCrisis, true);
	assert.equal(vm.vitals.crisis.score, 27);
});

test('buildRippersSheetVM renders attributes as die sizes (current, else base)', async () => {
	const vm = await buildRippersSheetVM(actorStub());
	assert.deepEqual(vm.attributes.map((a) => [a.key, a.die]), [['dex', 'd10'], ['ins', 'd8'], ['mig', 'd6'], ['wlp', 'd12']]);
	assert.equal(vm.attributes[0].label, 'Dexterity');
});

test('buildRippersSheetVM maps the nine affinities to words, dimming normals', async () => {
	const vm = await buildRippersSheetVM(actorStub());
	assert.equal(vm.affinities.length, 9);
	const by = Object.fromEntries(vm.affinities.map((a) => [a.type, a]));
	assert.deepEqual([by.bolt.word, by.bolt.level], ['Vulnerability', -1]);
	assert.deepEqual([by.dark.word, by.dark.level], ['Immunity', 2]);
	assert.deepEqual([by.fire.word, by.fire.level], ['Resistance', 1]);
	assert.deepEqual([by.poison.word, by.poison.level], ['Absorption', 3]);
	assert.equal(by.physical.normal, true);
	assert.equal(by.physical.word, '—');
});

test('buildRippersSheetVM builds the guise roster with worn/innate/tradable markers + resolved heroic', async () => {
	UUIDS.set('H.worn', { name: 'Riposte' });
	UUIDS.set('H.creation', { name: 'First Blood' });
	const vm = await buildRippersSheetVM(actorStub());
	assert.equal(vm.guises.length, 2);
	// worn sorts first
	const worn = vm.guises[0], innate = vm.guises[1];
	assert.equal(worn.id, 'w1');
	assert.equal(worn.worn, true); assert.equal(worn.innate, false); assert.equal(worn.tradable, true);
	assert.equal(worn.role, 'The Blade');
	assert.deepEqual(worn.trio.map((t) => `${t.word} ${t.type}`), ['Immunity dark', 'Vulnerability light', 'Resistance fire']);
	assert.equal(worn.skillCount, 2); assert.equal(worn.slTotal, 3); assert.equal(worn.budget, 12);
	assert.equal(worn.heroicName, 'Riposte');           // attachedHeroicUuid resolved
	assert.deepEqual(worn.lent.hp, { current: 3, maximum: 6 });
	assert.equal(innate.innate, true); assert.equal(innate.tradable, false);
	assert.equal(innate.heroicName, 'First Blood');      // innateHeroicUuid resolved
	assert.deepEqual(innate.lent.ip, { stock: 2, capacity: 8 });
});

test('buildRippersSheetVM binds bonds (non-empty) and active statuses', async () => {
	const vm = await buildRippersSheetVM(actorStub());
	assert.equal(vm.bonds.length, 1);
	assert.equal(vm.bonds[0].name, 'Dr. Vane');
	assert.equal(vm.bonds[0].strength, 3);
	assert.deepEqual(vm.bonds[0].emotions, ['Admiration', 'Loyalty']);
	assert.deepEqual(vm.statuses.sort(), ['dazed', 'slow']);
});

test('buildRippersSheetVM tolerates a bare actor (no guises, no crisis fields)', async () => {
	const bare = { name: 'Nobody', system: { resources: { hp: { value: 0, max: 0 } } }, items: { filter: () => [] }, getFlag: () => undefined };
	const vm = await buildRippersSheetVM(bare);
	assert.equal(vm.masthead.name, 'Nobody');
	assert.deepEqual(vm.guises, []);
	assert.deepEqual(vm.bonds, []);
	assert.deepEqual(vm.statuses, []);
	assert.equal(vm.vitals.crisis.inCrisis, false);
});

// ── P2a additions: derived, worn state, tabs, status chips, control helpers ──
test('buildRippersSheetVM adds derived def/mdef/init + worn state', async () => {
	const a = actorStub();
	a.system.derived = { def: { value: 11 }, mdef: { value: 7 }, init: { value: 4 } };
	const vm = await buildRippersSheetVM(a);
	assert.deepEqual(vm.derived, { def: 11, mdef: 7, init: 4 });
	assert.equal(vm.worn, true);            // activeGuise = 'w1'
	assert.equal(vm.wornName, 'Guise w1');
});

test('buildRippersSheetVM: tabs reflect the active tab; unimplemented tabs get a stub note', async () => {
	const form = await buildRippersSheetVM(actorStub(), { activeTab: 'form' });
	assert.equal(form.tabs.find((t) => t.key === 'form').active, true);
	assert.equal(form.tab.form, true);
	assert.equal(RS_TABS[0].key, 'form');
	const clots = await buildRippersSheetVM(actorStub(), { activeTab: 'clots' });
	assert.equal(clots.tab.other, true);
	assert.match(clots.tab.otherNote, /Clot/i);
	// a bad tab falls back to form
	const bad = await buildRippersSheetVM(actorStub(), { activeTab: 'nope' });
	assert.equal(bad.tab.form, true);
});

test('buildRippersSheetVM: status chips + condition groups reflect actor.statuses; self/showConditions carry', async () => {
	const vm = await buildRippersSheetVM(actorStub(), { statusSelf: false, showConditions: true });
	assert.deepEqual(vm.statusChips.map((c) => c.id), RS_STATUS_IDS);
	assert.equal(vm.statusChips.find((c) => c.id === 'slow').active, true);   // actorStub has slow
	assert.equal(vm.statusChips.find((c) => c.id === 'weak').active, false);
	assert.equal(vm.statusSelf, false);
	assert.equal(vm.showConditions, true);
	assert.ok(vm.condGroups.length >= 1 && vm.condGroups[0].items.length);
});

test('rsAffFlags: >=1 is good (resist/immune/absorb), -1 is bad (vulnerable), 0 neither', () => {
	assert.deepEqual(rsAffFlags(2), { good: true, bad: false });
	assert.deepEqual(rsAffFlags(-1), { good: false, bad: true });
	assert.deepEqual(rsAffFlags(0), { good: false, bad: false });
});

test('statusTargetActor: self → the sheet actor; target → the first targeted token actor, else null', () => {
	const me = { id: 'me' };
	const other = { id: 'them' };
	assert.equal(statusTargetActor(me, true, null), me);
	assert.equal(statusTargetActor(me, false, new Set([{ actor: other }])), other);
	assert.equal(statusTargetActor(me, false, new Set()), null);
	assert.equal(statusTargetActor(me, false, null), null);
});

test('sheetAdjustResource: IP (no lent layer) falls back to a clamped direct update when the FU pipeline import is unavailable', async () => {
	// IP has no lent layer, so it always takes the ResourcePipeline path; in node that import throws →
	// clamped direct fallback (HP/MP spend now route through applyResourceCost — covered elsewhere).
	function resActor(value, max) {
		const a = { system: { resources: { ip: { value, max } } }, update: async (p) => { for (const [k, v] of Object.entries(p)) { const parts = k.split('.'); let o = a; for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]]; o[parts.at(-1)] = v; } } };
		return a;
	}
	const dmg = resActor(6, 6); await sheetAdjustResource(dmg, 'ip', -3);
	assert.equal(dmg.system.resources.ip.value, 3);
	const overheal = resActor(5, 6); await sheetAdjustResource(overheal, 'ip', 100);
	assert.equal(overheal.system.resources.ip.value, 6);       // clamped to max
	const overkill = resActor(2, 6); await sheetAdjustResource(overkill, 'ip', -100);
	assert.equal(overkill.system.resources.ip.value, 0);       // clamped to 0
	const noop = resActor(4, 6); await sheetAdjustResource(noop, 'ip', 0);
	assert.equal(noop.system.resources.ip.value, 4);           // zero delta = no change
});

test('buildRippersSheetVM: the background watermark initial is the character name first letter (dynamic)', async () => {
	const vm = await buildRippersSheetVM(actorStub());
	assert.equal(vm.masthead.initial, 'C');          // "Cordelia"
	const bare = await buildRippersSheetVM({ name: '', system: {}, items: { filter: () => [] }, getFlag: () => undefined });
	assert.equal(bare.masthead.initial, '?');        // no name → placeholder, never a hardcoded 'V'
});

// ── P2b: weapons in the VM + the attack / rest / fabula control helpers ──
test('buildRippersSheetVM: weapons (weapon + customWeapon) surface for the Kit tab', async () => {
	const a = actorStub();
	a.itemTypes.weapon = [{ id: 'wpn1', name: 'Consecrated Rifle', img: 'r.png', type: 'weapon' }];
	a.itemTypes.customWeapon = [{ id: 'cw1', name: 'Maxim Fist', img: 'm.png', type: 'customWeapon' }];
	const vm = await buildRippersSheetVM(a, { activeTab: 'kit' });
	assert.deepEqual(vm.weapons.map((w) => w.id), ['wpn1', 'cw1']);
	assert.equal(vm.tab.kit, true);
	assert.equal(vm.tab.other, undefined);   // kit is implemented, not a stub tab
});

test('sheetRollWeapon: calls item.roll() on the resolved weapon (the FU attack→damage flow)', async () => {
	let rolled = false;
	const item = { id: 'wpn1', roll: async () => { rolled = true; } };
	const actor = { items: { get: (id) => (id === 'wpn1' ? item : null) } };
	await sheetRollWeapon(actor, 'wpn1');
	assert.equal(rolled, true);
	await sheetRollWeapon(actor, 'nope');    // missing → no throw
});

test('sheetRest: calls actor.rest(true) (fires REST_EVENT → lent-vitals refill)', async () => {
	let restedWith = null;
	await sheetRest({ rest: async (ip) => { restedWith = ip; } });
	assert.equal(restedWith, true);
	await sheetRest({});                      // no rest method → no throw
});

test('sheetSpendFabula: fallback spends 1 FP when >0, else notifies (deep import unavailable in node)', async () => {
	function fpActor(v) { const a = { system: { resources: { fp: { value: v } } }, update: async (p) => { for (const [k, val] of Object.entries(p)) { const parts = k.split('.'); let o = a; for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]]; o[parts.at(-1)] = val; } } }; return a; }
	const has = fpActor(3); await sheetSpendFabula(has);
	assert.equal(has.system.resources.fp.value, 2);   // -1
	const none = fpActor(0); await sheetSpendFabula(none);
	assert.equal(none.system.resources.fp.value, 0);  // unchanged
});

test('sheetRollCheck: resolves without throwing when the CheckPrompt deep import is unavailable', async () => {
	await sheetRollCheck({ name: 'x' });     // node has no /systems import → warns, no throw
});

// ── P2c: editor tab target + trade / hand-off ──
test('buildRippersSheetVM: editor targets the worn guise, else innate, else first; edit tab implemented', async () => {
	const worn = await buildRippersSheetVM(actorStub(), { activeTab: 'edit' });
	assert.equal(worn.editor.has, true);
	assert.equal(worn.editor.guiseId, 'w1');     // worn wins
	assert.equal(worn.editor.bound, true);
	assert.equal(worn.tab.edit, true);
	assert.equal(worn.tab.other, undefined);     // edit is implemented, not a stub
	// no worn guise → falls to innate
	const a = actorStub(); a.getFlag = () => undefined; // activeGuise null
	const unworn = await buildRippersSheetVM(a);
	assert.equal(unworn.editor.guiseId, 'inn');  // innate is the fallback target
	assert.equal(unworn.editor.bound, false);
	// no guises at all
	const bare = await buildRippersSheetVM({ name: 'x', system: {}, items: { filter: () => [] }, getFlag: () => undefined });
	assert.equal(bare.editor.has, false);
});

test('handOffDecision: only a real non-innate guise, a distinct recipient, and write access pass', () => {
	const g = { type: 'classFeature', system: { featureType: FEATURE_TYPE, data: { mode: 'worn' } }, getFlag: () => undefined };
	const innate = { type: 'classFeature', system: { featureType: FEATURE_TYPE, data: { mode: 'innate' } }, getFlag: (m, k) => (k === 'isInnate' ? true : undefined) };
	const src = { id: 'A' }; const rec = { id: 'B' };
	assert.deepEqual(handOffDecision(src, null, rec, true), { ok: false, reason: 'no-guise' });
	assert.deepEqual(handOffDecision(src, innate, rec, true), { ok: false, reason: 'innate-untradable' });
	assert.deepEqual(handOffDecision(src, g, null, true), { ok: false, reason: 'no-recipient' });
	assert.deepEqual(handOffDecision(src, g, { id: 'A' }, true), { ok: false, reason: 'same-actor' });
	assert.deepEqual(handOffDecision(src, g, rec, false), { ok: false, reason: 'needs-gm-socket' }); // cross-owner, no write
	assert.deepEqual(handOffDecision(src, g, rec, true), { ok: true, reason: 'ok' });
});

test('sheetHandOffGuise: refuses cleanly (no mutation) without write access; moves the Item on the clean path', async () => {
	function guiseItem2(id, innate = false) {
		let deleted = false;
		return { id, name: `G${id}`, type: 'classFeature', system: { featureType: FEATURE_TYPE, data: { mode: innate ? 'innate' : 'worn' } },
			getFlag: (m, k) => (innate && k === 'isInnate' ? true : undefined),
			toObject: () => ({ type: 'classFeature', name: `G${id}`, system: { featureType: FEATURE_TYPE, data: { mode: innate ? 'innate' : 'worn' } }, flags: {} }),
			delete: async () => { deleted = true; }, get _deleted() { return deleted; } };
	}
	const item = guiseItem2('g1');
	const src = { id: 'A', getFlag: () => null, items: { get: (id) => (id === 'g1' ? item : null) } };
	// no write access (recipient not owned, not GM) → needs-gm-socket, no move
	const created = [];
	const recNoWrite = { id: 'B', isOwner: false, createEmbeddedDocuments: async (_t, d) => created.push(...d) };
	const r1 = await sheetHandOffGuise(src, 'g1', recNoWrite);
	assert.equal(r1.reason, 'needs-gm-socket');
	assert.equal(item._deleted, false); assert.equal(created.length, 0);
	// clean path: recipient owned → the Item moves whole (create on B, delete on A)
	const recOwned = { id: 'B', isOwner: true, createEmbeddedDocuments: async (_t, d) => created.push(...d) };
	const r2 = await sheetHandOffGuise(src, 'g1', recOwned);
	assert.equal(r2.ok, true);
	assert.equal(created.length, 1);
	assert.equal(created[0].system.data.mode, 'worn');   // guise data (lent layer/satchel would ride here too)
	assert.equal(item._deleted, true);
});

// ── Deeper Bonds native panel (SHEET-INJECTION-AUDIT.md, arch B) ──────────────
const { bondClockPips, bondPanelRow, buildBondPanelRows, SOLID_BOND_CAP, deeperBondsApi } = mod;

// The real module's ladder logic (mirrored for the shim): cleanse/coverRegen s>=2, attrDieUp s>=3, skillGrant=eternal.
const fakeLadder = (s, tier) => ({ cleanse: s >= 2, coverRegen: s >= 2, attrDieUp: s >= 3, skillGrant: tier === 'eternal' });

test('bondClockPips: fills sections up to clock, clamped 0..4', () => {
	assert.deepEqual(bondClockPips(0).map((p) => p.filled), [false, false, false, false]);
	assert.deepEqual(bondClockPips(2).map((p) => p.filled), [true, true, false, false]);
	assert.deepEqual(bondClockPips(9).map((p) => p.filled), [true, true, true, true]); // clamp
	assert.equal(bondClockPips().length, 4);
});

test('bondPanelRow: tier flags, clock only on solid, solidify gating, ladder passthrough', () => {
	const fleeting = bondPanelRow({ name: 'A', admInf: 'Admiration' }, { tier: 'fleeting', clock: 0 }, 1, fakeLadder(1, 'fleeting'), { solidCount: 0 });
	assert.equal(fleeting.isFleeting, true);
	assert.equal(fleeting.showClock, false);           // fleeting carries no clock
	assert.equal(fleeting.solidifyShow, true);
	assert.equal(fleeting.solidifyDisabled, false);
	assert.deepEqual(fleeting.emotions, ['Admiration']);

	const capped = bondPanelRow({ name: 'B' }, { tier: 'fleeting' }, 1, fakeLadder(1, 'fleeting'), { solidCount: SOLID_BOND_CAP });
	assert.equal(capped.solidifyDisabled, true);       // at the solid cap

	const solid = bondPanelRow({ name: 'C' }, { tier: 'solid', clock: 3 }, 3, fakeLadder(3, 'solid'), {});
	assert.equal(solid.isSolid, true);
	assert.equal(solid.showClock, true);
	assert.equal(solid.canEternal, true);
	assert.equal(solid.solidifyShow, false);
	assert.deepEqual(solid.clockPips.map((p) => p.filled), [true, true, true, false]);
	assert.deepEqual(solid.ladder, { cleanse: true, coverRegen: true, attrDieUp: true, skillGrant: false });

	const eternal = bondPanelRow({ name: 'D' }, { tier: 'eternal', grantedSkill: { skillName: 'Riposte' } }, 4, fakeLadder(4, 'eternal'), {});
	assert.equal(eternal.isEternal, true);
	assert.equal(eternal.ladder.skillGrant, true);
	assert.equal(eternal.grantedSkill, 'Riposte');
});

test('buildBondPanelRows: assembles a row per bond, counts solids for the cap, drops empty bonds', () => {
	const fuBonds = [{ name: 'Solid1', admInf: 'X' }, { name: 'Solid2' }, { name: 'Fleet' }, { name: '', admInf: '', loyMis: '', affHat: '' }];
	const records = [{ name: 'Solid1', tier: 'solid', clock: 1 }, { name: 'Solid2', tier: 'solid' }, { name: 'Fleet', tier: 'fleeting' }];
	const rows = buildBondPanelRows(fuBonds, records, { strengthOf: (n) => (n === 'Fleet' ? 1 : 3), ladderOf: fakeLadder }, { cap: 2 });
	assert.equal(rows.length, 3);                       // the empty bond is dropped
	const fleet = rows.find((r) => r.name === 'Fleet');
	assert.equal(fleet.solidifyDisabled, true);         // 2 solids already == cap 2
});

test('deeperBondsApi: null when the module is absent (fallback path)', () => {
	assert.equal(deeperBondsApi(), null); // harness game.modules.get returns null
});

test('buildRippersSheetVM: native Deeper Bonds panel when the module API is present', async () => {
	const savedGame = globalThis.game;
	try {
		const api = {
			getRecords: () => [{ name: 'Dr. Vane', tier: 'solid', clock: 2 }],
			bondStrength: (_a, name) => (name === 'Dr. Vane' ? 3 : 0),
			ladderAbilities: fakeLadder,
		};
		globalThis.game = { modules: { get: (id) => (id === 'rippers-deeper-bonds' ? { api } : null) }, user: { isActiveGM: true } };
		const vm = await buildRippersSheetVM(actorStub());
		assert.equal(vm.bondsNative, true);
		assert.equal(vm.bondsIsGM, true);
		assert.equal(vm.bonds.length, 1);
		const row = vm.bonds[0];
		assert.equal(row.name, 'Dr. Vane');
		assert.equal(row.tier, 'solid');
		assert.equal(row.strength, 3);
		assert.equal(row.showClock, true);
		assert.deepEqual(row.clockPips.map((p) => p.filled), [true, true, false, false]);
		assert.equal(row.ladder.attrDieUp, true);       // strength 3 unlocks the die-up
	} finally {
		globalThis.game = savedGame;
	}
});

test('buildRippersSheetVM: falls back to the plain grid when no Deeper Bonds API', async () => {
	const vm = await buildRippersSheetVM(actorStub()); // harness game has no module api
	assert.equal(vm.bondsNative, false);
	assert.equal(vm.bonds.length, 1);
	assert.equal(vm.bonds[0].name, 'Dr. Vane');
	assert.equal(vm.bonds[0].strength, 3);              // simple shape preserved
});

// ── T4: the runtime Talented seam ─────────────────────────────────────────────
const { isTalented, actorSpecialtyCap } = mod;

// A minimal actor with an innate guise item (mode 'innate') carrying optional talented + specialties.
function talentedActor({ talented = false, specialties = [], quirkTalented = false } = {}) {
	const items = [{
		type: 'classFeature',
		system: { featureType: 'rippers-guise.guise', data: { mode: 'innate', talented, specialties } },
		getFlag: (m, k) => (m === RGID && k === 'isInnate' ? true : undefined), flags: { [RGID]: { isInnate: true } },
	}];
	if (quirkTalented) items.push({ type: 'feature', system: { fuid: 'talented' }, getFlag: (m, k) => (m === 'rippers-automation' && k === 'fuid' ? 'talented' : undefined), flags: { 'rippers-automation': { fuid: 'talented' } } });
	return { items };
}

test('isTalented: true from the innate-guise boolean, false otherwise', () => {
	assert.equal(isTalented(talentedActor({ talented: true })), true);
	assert.equal(isTalented(talentedActor({ talented: false })), false);
	assert.equal(isTalented({ items: [] }), false);
});

test('isTalented: also recognizes a held Talented quirk Item (fuid talented) — the generalized source', () => {
	assert.equal(isTalented(talentedActor({ talented: false, quirkTalented: true })), true);
});

test('actorSpecialtyCap: 4 when Talented, 2 otherwise (mirrors the builder cap)', () => {
	assert.equal(actorSpecialtyCap(talentedActor({ talented: true })), 4);
	assert.equal(actorSpecialtyCap(talentedActor({ talented: false })), 2);
	assert.equal(actorSpecialtyCap(talentedActor({ quirkTalented: true })), 4);
});

// ── Unit 1: lent-vital display (X1/H5) + Resources tab (G4) ───────────────────
const { vitalBar, vitalDots, adjustTrackedResource, TRACKED_RESOURCES_FLAG } = mod;

test('vitalBar: plain number with no lent; parens + overlay segment when lent > 0', () => {
	const plain = vitalBar(20, 55, 0);
	assert.equal(plain.display, '20');
	assert.equal(plain.lentPct, 0);
	assert.equal(plain.fillPct, 36);                 // 20/55
	const lent = vitalBar(45, 50, 8);
	assert.equal(lent.display, '45 (+8)');           // X1 parens
	assert.equal(lent.lent, 8);
	assert.ok(lent.lentPct > 0 && lent.basePct > 0); // shield sits atop the bar
	assert.equal(vitalBar(0, 0, 0).display, '0');    // no max, no lent
});

test('vitalDots: base dots filled to value, extra temporary lent dots, parens number', () => {
	const d = vitalDots(4, 6, 2);
	assert.equal(d.dots.length, 6);
	assert.equal(d.dots.filter((x) => x.filled).length, 4);
	assert.equal(d.lentDots.length, 2);
	assert.equal(d.display, '4 (+2)');
	assert.equal(vitalDots(3, 6, 0).display, '3');
});

test('adjustTrackedResource: clamps 0..max when a cap is set, unbounded otherwise', () => {
	const list = [{ key: 'a', label: 'Reputation', value: 2, max: 5 }, { key: 'b', label: 'Combo', value: 0 }];
	assert.equal(adjustTrackedResource(list, 'a', 4).find((r) => r.key === 'a').value, 5); // clamp to max
	assert.equal(adjustTrackedResource(list, 'a', -5).find((r) => r.key === 'a').value, 0); // clamp to 0
	assert.equal(adjustTrackedResource(list, 'b', 9).find((r) => r.key === 'b').value, 9); // no cap
	assert.deepEqual(adjustTrackedResource(list, 'zzz', 1), list);                          // unknown key: untouched
});

test('buildRippersSheetVM: Resources tab binds tracked resources from the actor flag', async () => {
	const a = actorStub();
	a.getFlag = (m, k) => (m === RGID && k === TRACKED_RESOURCES_FLAG
		? [{ key: 'rep', label: 'Reputation', value: 3, max: 5 }, { key: 'x', label: '', value: 1 }]
		: (m === RGID ? { activeGuise: 'w1' }[k] : undefined));
	const vm = await buildRippersSheetVM(a, { activeTab: 'resources' });
	assert.equal(vm.tab.resources, true);
	assert.equal(vm.trackedResources.length, 1);      // the empty-label row is dropped
	assert.equal(vm.trackedResources[0].label, 'Reputation');
	assert.equal(vm.trackedResources[0].max, 5);
});

// ── H3 "The Turn": guise-swap action economy ──────────────────────────────────────────────────────
const { guiseSwapActionDecision, markGuiseUsed, guiseSceneState, accountGuiseSwap, USED_GUISES_FLAG, TURN_REFUND_FLAG } = mod;

test('guiseSwapActionDecision: fresh guise + Turn available → FREE (refunded once/scene)', () => {
	assert.deepEqual(guiseSwapActionDecision([], false, 'g1'), { cost: 'free', refunded: true, reason: 'the-turn' });
	// The Turn already spent this scene → the next fresh swap costs an Action.
	assert.deepEqual(guiseSwapActionDecision(['g1'], true, 'g2'), { cost: 'action', refunded: false, reason: 'turn-spent' });
	// Swapping back to a guise already used this scene → an Action, even with the Turn unspent.
	assert.deepEqual(guiseSwapActionDecision(['g1'], false, 'g1'), { cost: 'action', refunded: false, reason: 'already-used' });
	assert.equal(guiseSwapActionDecision(null, false, '').cost, 'action'); // no target → not free
});

test('markGuiseUsed: appends once, dedups, tolerates non-arrays', () => {
	assert.deepEqual(markGuiseUsed([], 'g1'), ['g1']);
	assert.deepEqual(markGuiseUsed(['g1'], 'g1'), ['g1']);           // dedup
	assert.deepEqual(markGuiseUsed(['g1'], 'g2'), ['g1', 'g2']);     // order preserved
	assert.deepEqual(markGuiseUsed(undefined, 'g1'), ['g1']);
});

function turnActor() {
	const flags = { [RGID]: { activeGuise: null } };
	const items = new Map([['g1', { id: 'g1', name: 'Alpha' }], ['g2', { id: 'g2', name: 'Beta' }]]);
	return {
		id: 'A1', updates: [],
		items: { get: (id) => items.get(id) ?? null },
		getFlag: (m, k) => (m === RGID ? flags[RGID][k] : undefined),
		async update(u) {
			this.updates.push(u);
			for (const [path, val] of Object.entries(u)) {
				const k = path.replace(`flags.${RGID}.`, '');
				flags[RGID][k] = val;
			}
		},
	};
}

test('accountGuiseSwap: first fresh swap is refunded; the next fresh swap costs an Action', async () => {
	const a = turnActor();
	assert.deepEqual(guiseSceneState(a), { used: [], turnRefundUsed: false });
	const d1 = await accountGuiseSwap(a, 'g1');
	assert.equal(d1.refunded, true);
	assert.deepEqual(guiseSceneState(a), { used: ['g1'], turnRefundUsed: true });
	const d2 = await accountGuiseSwap(a, 'g2');           // Turn spent → Action
	assert.equal(d2.refunded, false);
	assert.deepEqual(guiseSceneState(a).used, ['g1', 'g2']);
	const d3 = await accountGuiseSwap(a, 'g1');           // back to a used guise → Action, no dup
	assert.equal(d3.reason, 'already-used');
	assert.deepEqual(guiseSceneState(a).used, ['g1', 'g2']);
});

test('buildRippersSheetVM: guise rows hint The Turn refund, plus a top-level theTurn flag', async () => {
	const a = actorStub(); // worn = w1, no scene state yet (getFlag returns undefined for the Turn flags)
	const vm = await buildRippersSheetVM(a);
	assert.equal(vm.theTurn.available, true);
	const inn = vm.guises.find((g) => g.id === 'inn');
	assert.equal(inn.worn, false);
	assert.equal(inn.usedThisScene, false);
	assert.equal(inn.swapWouldRefund, true);             // unused, unworn, Turn available
	const worn = vm.guises.find((g) => g.worn);
	assert.equal(worn.swapWouldRefund, false);           // the worn guise is never a "fresh" swap
});

// ── 2a guise-identity arcana tiles ────────────────────────────────────────────────────────────────
const { ARCANA, arcanaBySlug, guiseArcana, arcanaImg, arcanaImgAt, arcanaBasePath, DEFAULT_ARCANA_BASE } = mod;

test('ARCANA: the 22 major arcana, each with a slug, name, and a <slug>.png filename', () => {
	assert.equal(ARCANA.length, 22);
	assert.equal(ARCANA[0].slug, '00-the-fool');
	assert.equal(ARCANA[21].name, 'The World');
	assert.ok(ARCANA.every((a) => a.file === `${a.slug}.png`));
	assert.equal(arcanaBySlug('13-death').name, 'Death');
	assert.equal(arcanaBySlug('nope'), null);
});

test('arcana image base is configurable: default is the module folder; a set base composes base/<slug>.png', () => {
	// no game.settings registered here → falls back to the module-internal default
	assert.equal(DEFAULT_ARCANA_BASE, 'modules/rippers-guise/assets/arcana');
	assert.equal(arcanaBasePath(), DEFAULT_ARCANA_BASE);
	assert.equal(arcanaImg('00-the-fool'), 'modules/rippers-guise/assets/arcana/00-the-fool.png');
	assert.equal(arcanaImg('nope'), null);
	// PURE join tolerates a trailing slash and works with a Forge world-data path (spaces included)
	assert.equal(arcanaImgAt('Rippers/Arcana/Major Arcana', '05-the-hierophant'), 'Rippers/Arcana/Major Arcana/05-the-hierophant.png');
	assert.equal(arcanaImgAt('Rippers/Arcana/Major Arcana/', '21-the-world'), 'Rippers/Arcana/Major Arcana/21-the-world.png');
});

test('arcanaBasePath reads the setting when registered, stripping a trailing slash', () => {
	const savedGame = globalThis.game;
	try {
		globalThis.game = { settings: { get: (m, k) => (m === RGID && k === 'arcanaBasePath' ? 'Rippers/Arcana/Major Arcana/' : undefined) }, modules: { get: () => null }, user: { isGM: false } };
		assert.equal(arcanaBasePath(), 'Rippers/Arcana/Major Arcana');
		assert.equal(arcanaImg('13-death'), 'Rippers/Arcana/Major Arcana/13-death.png');
	} finally { globalThis.game = savedGame; }
});

test('guiseArcana + VM: a guise renders its chosen arcana tile (name + resolved img) from the Item flag', async () => {
	const g = { getFlag: (m, k) => (m === RGID && k === 'arcana' ? '18-the-moon' : undefined) };
	assert.equal(guiseArcana(g).name, 'The Moon');
	assert.equal(guiseArcana(g).img, 'modules/rippers-guise/assets/arcana/18-the-moon.png');
	assert.equal(guiseArcana({ getFlag: () => undefined }), null);
	// the Form-tab guise rows carry .arcana (null when unset in the base stub)
	const vm = await buildRippersSheetVM(actorStub());
	assert.ok(vm.guises.every((row) => 'arcana' in row));
	assert.equal(vm.guises[0].arcana, null);
});

// ── H2 two-portrait swap (normal / other-shape) ───────────────────────────────────────────────────
const { faceForGuise, resolveFaceImg, nextManualFace, applyGuiseFace, restoreBaseFace, sheetToggleFace, NO_PORTRAIT_WELL } = mod;

test('faceForGuise + resolveFaceImg: guise face assignment maps to an image path', () => {
	const mk = (f) => ({ getFlag: (m, k) => (m === RGID && k === 'face' ? f : undefined) });
	assert.equal(faceForGuise(mk('other')), 'other');
	assert.equal(faceForGuise(mk('bogus')), null);
	assert.equal(faceForGuise(mk(undefined)), null);
	const faces = { normal: 'n.png', other: 'o.png' };
	assert.equal(resolveFaceImg(faces, 'normal'), 'n.png');
	assert.equal(resolveFaceImg(faces, 'other'), 'o.png');
	assert.equal(resolveFaceImg(faces, 'none'), NO_PORTRAIT_WELL);
	assert.equal(resolveFaceImg({}, 'other'), null);           // unset face → no swap
	assert.equal(resolveFaceImg(faces, 'zzz'), undefined);     // unassigned → leave unchanged
});

test('nextManualFace: flips to whichever face is not current; falls back sensibly', () => {
	const faces = { normal: 'n.png', other: 'o.png' };
	assert.equal(nextManualFace(faces, 'n.png'), 'o.png');
	assert.equal(nextManualFace(faces, 'o.png'), 'n.png');
	assert.equal(nextManualFace(faces, 'other.png'), 'n.png'); // neither current → normal first
	assert.equal(nextManualFace({ other: 'o.png' }, 'x'), 'o.png');
	assert.equal(nextManualFace({}, 'x'), null);
});

function faceActor(img, faces, guiseFace) {
	const aflags = { [RGID]: { faces } };
	const guise = { getFlag: (m, k) => (m === RGID && k === 'face' ? guiseFace : undefined) };
	const a = {
		img, items: { get: () => guise },
		getFlag: (m, k) => (m === RGID ? aflags[RGID][k] : undefined),
		setFlag: async (m, k, v) => { if (m === RGID) aflags[RGID][k] = v; },
		update: async (p) => { if ('img' in p) a.img = p.img; },
	};
	return { a, guise };
}

test('applyGuiseFace: swaps actor.img to the assigned face, caches the original, non-destructive', async () => {
	const { a, guise } = faceActor('orig.png', { normal: 'n.png', other: 'o.png' }, 'other');
	await applyGuiseFace(a, guise);
	assert.equal(a.img, 'o.png');                              // swapped to the other-shape face
	assert.equal(a.getFlag(RGID, 'faceCache'), 'orig.png');   // original cached once (safe-revert)
	// a guise that assigns no face leaves the portrait untouched
	const { a: b, guise: bg } = faceActor('orig.png', { normal: 'n.png' }, undefined);
	await applyGuiseFace(b, bg);
	assert.equal(b.img, 'orig.png');
});

test('restoreBaseFace: unmask restores the NORMAL face', async () => {
	const { a } = faceActor('o.png', { normal: 'n.png', other: 'o.png' }, 'other');
	await restoreBaseFace(a);
	assert.equal(a.img, 'n.png');
});

test('sheetToggleFace: manual flip between the two faces, independent of any guise', async () => {
	const { a } = faceActor('n.png', { normal: 'n.png', other: 'o.png' }, undefined);
	await sheetToggleFace(a);
	assert.equal(a.img, 'o.png');
	await sheetToggleFace(a);
	assert.equal(a.img, 'n.png');
});

// ── Unit 3 Party Vault (V1–V5, X4) ────────────────────────────────────────────────────────────────
const { guiseFieldLimit, fieldSlots, buildVaultVM } = mod;

test('guiseFieldLimit: party size + 2, floored at 1', () => {
	assert.equal(guiseFieldLimit(4), 6);
	assert.equal(guiseFieldLimit(0), 2);
	assert.equal(guiseFieldLimit(-5), 1); // never below 1
});

test('fieldSlots: fills one slot per guise, pads dashed empties to the limit, never truncates', () => {
	const two = fieldSlots(['a', 'b'], 4);
	assert.equal(two.count, 2); assert.equal(two.limit, 4);
	assert.equal(two.slots.length, 4);           // 2 filled + 2 dashed empties (V1/V5)
	assert.equal(two.slots.filter((s) => s.filled).length, 2);
	assert.equal(two.empties, 2); assert.equal(two.overLimit, false);
	const over = fieldSlots(['a', 'b', 'c', 'd', 'e'], 4); // V1: display, do NOT enforce
	assert.equal(over.slots.length, 5);          // every guise kept, no empties
	assert.equal(over.empties, 0); assert.equal(over.overLimit, true);
});

test('buildVaultVM: party roster with field slots, worn tag, and the cabinet compendium (V2/V3/V4)', async () => {
	const g1 = guise('vg1', { role: 'The Blade' });
	const memberActor = {
		id: 'M1', name: 'Vin', img: 'vin.png', isOwner: true, hasPlayerOwner: true,
		items: { filter: (fn) => [g1].filter(fn) },
		getFlag: (m, k) => (m === RGID && k === 'activeGuise' ? 'vg1' : undefined),
	};
	const savedGame = globalThis.game;
	globalThis.game = {
		modules: { get: () => null }, user: { isGM: true },
		settings: { get: (m, k) => (m === RGID && k === 'partySize' ? 4 : undefined) },
		actors: { filter: (fn) => [memberActor].filter(fn) },
		packs: { get: (id) => (id === 'rippers-guise.guises' ? {
			metadata: { label: 'Rippers Guises' },
			async getIndex() { return [{ _id: 'c1', name: 'The Hollow', img: 'h.png' }]; },
		} : null) },
	};
	try {
		const vm = await buildVaultVM(memberActor);
		assert.equal(vm.partySize, 4);
		assert.equal(vm.fieldLimit, 6);
		assert.equal(vm.members.length, 1);
		const m = vm.members[0];
		assert.equal(m.name, 'Vin'); assert.equal(m.worn, 'Guise vg1'); // getActiveGuise → vg1 worn
		assert.equal(m.limit, 6); assert.equal(m.count, 1); assert.equal(m.slots.length, 6);
		assert.equal(m.canWrite, true);
		assert.equal(vm.cabinet.label, 'Rippers Guises');
		assert.equal(vm.cabinet.entries.length, 1);
		assert.equal(vm.cabinet.entries[0].uuid, 'Compendium.rippers-guise.guises.c1');
	} finally { globalThis.game = savedGame; }
});

test('buildRippersSheetVM: the Rival waiver toggle is hidden by default, shown+armed via the automation api (R1)', async () => {
	const off = await buildRippersSheetVM(actorStub());
	assert.deepEqual(off.rivalWaiver, { has: false, armed: false }); // no automation module in the base stub → hidden
	const saved = globalThis.game;
	globalThis.game = {
		modules: { get: (id) => (id === 'rippers-automation' ? { api: {
			actorHasQuirk: (_a, fuid) => fuid === 'rival-prodigies',
			isRivalWaiverArmed: () => true,
		} } : null) },
		user: { isGM: false },
	};
	try {
		const on = await buildRippersSheetVM(actorStub());
		assert.deepEqual(on.rivalWaiver, { has: true, armed: true });
	} finally { globalThis.game = saved; }
});

test('buildRippersSheetVM: the Vault embedded tab builds a vault VM (V3); other tabs skip it', async () => {
	const off = await buildRippersSheetVM(actorStub(), { activeTab: 'form' });
	assert.equal(off.vault, null);                     // not built when the tab is closed
	const on = await buildRippersSheetVM(actorStub(), { activeTab: 'vault' });
	assert.equal(on.tab.vault, true);
	assert.ok(on.vault);                               // built when open (defensive w/ the minimal game stub)
	assert.equal(on.vault.fieldLimit, 6);              // partySize falls back to 4 → +2
	assert.equal(on.vault.cabinet.missing, true);      // no packs in the minimal stub
	assert.ok(RS_TABS.some((t) => t.key === 'vault'));
});
