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
const { buildRippersSheetVM } = mod;

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
	assert.deepEqual(vm.vitals.hp, { value: 20, max: 55 });
	assert.deepEqual(vm.vitals.mp, { value: 10, max: 40 });
	assert.deepEqual(vm.vitals.ip, { value: 4, max: 6 });
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
