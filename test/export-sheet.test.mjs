// EXPORT SHEET — headless coverage of the pure export core (schema assembler + HTML renderer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleExport, renderExportHTML, exportBaseName, EXPORT_SCHEMA, EXPORT_SCHEMA_VERSION } from '../scripts/export-sheet.mjs';

const parts = () => ({
	character: {
		name: 'Vincent Cross', identity: 'The Alienist', pronouns: 'he/him', theme: 'Doubt', origin: 'Whitechapel', level: 12,
		classes: ['Orator', 'Sharpshooter'],
		vitals: { hp: { value: 26, max: 36 }, mp: { value: 11, max: 20 }, ip: { value: 4, max: 6 }, fp: 3, exp: 7, zenit: 250, crisis: { inCrisis: false, score: 18 } },
		attributes: [{ key: 'dex', label: 'Dexterity', short: 'DEX', die: 'd8' }, { key: 'mig', label: 'Might', short: 'MIG', die: 'd10' }],
		affinities: [{ type: 'physical', level: 0, word: '—' }, { type: 'dark', level: 1, word: 'Resistant' }],
		derived: { def: 11, mdef: 12, init: 6 },
	},
	guises: [{
		name: 'The Vampire Form', role: 'Predator', identity: 'a thing that was a man', innate: false, worn: true, heroicName: 'Nosferatu',
		affinities: [{ type: 'dark', level: 2, word: 'Immune' }],
		classes: [{ name: 'Vampire', skills: [{ name: 'Blood Drain', sl: 3, maxSl: 5 }] }],
	}],
	bonds: [
		{ name: 'Sister Ambroise', admInf: 'Admiration', loyMis: 'Loyalty', affHat: '', strength: 2, tier: 'solid' },
		{ name: '', admInf: '', loyMis: '', affHat: '', strength: 0, tier: 'fleeting' }, // empty → dropped
	],
	inventory: [{ section: 'Weapons', name: 'Service Revolver', detail: 'Accuracy DEX+INS · damage 8' }, { section: 'Consumables', name: '', detail: 'x' }],
	quirks: [{ name: 'Iron Constitution', fuid: 'talented' }, { name: '', fuid: '' }],
});

test('assembleExport: stable schema envelope + deterministic timestamp', () => {
	const p = assembleExport(parts(), { now: new Date('2026-09-05T20:00:00Z'), moduleVersion: '0.7.54' });
	assert.equal(p.schema, EXPORT_SCHEMA);
	assert.equal(p.schema, 'rippers-guise.character-export');
	assert.equal(p.schemaVersion, EXPORT_SCHEMA_VERSION);
	assert.equal(p.exportedAt, '2026-09-05T20:00:00.000Z');
	assert.equal(p.moduleVersion, '0.7.54');
});

test('assembleExport: character block coerces types and keeps pools shaped', () => {
	const p = assembleExport(parts());
	assert.equal(p.character.name, 'Vincent Cross');
	assert.equal(p.character.level, 12);
	assert.deepEqual(p.character.classes, ['Orator', 'Sharpshooter']);
	assert.deepEqual(p.character.vitals.hp, { value: 26, max: 36 });
	assert.equal(p.character.vitals.crisis.score, 18);
	assert.equal(p.character.attributes[1].die, 'd10');
	assert.equal(p.character.derived.mdef, 12);
});

test('assembleExport: guises carry classes→skills and affinity words', () => {
	const p = assembleExport(parts());
	assert.equal(p.guises.length, 1);
	assert.equal(p.guises[0].worn, true);
	assert.equal(p.guises[0].heroicName, 'Nosferatu');
	assert.equal(p.guises[0].classes[0].skills[0].name, 'Blood Drain');
	assert.equal(p.guises[0].classes[0].skills[0].sl, 3);
	assert.equal(p.guises[0].affinities[0].word, 'Immune');
});

test('assembleExport: drops empty bonds / inventory / quirks rows', () => {
	const p = assembleExport(parts());
	assert.equal(p.bonds.length, 1);            // the empty bond is dropped
	assert.equal(p.bonds[0].tier, 'solid');
	assert.equal(p.inventory.length, 1);        // nameless consumable dropped
	assert.equal(p.inventory[0].name, 'Service Revolver');
	assert.equal(p.quirks.length, 1);           // nameless quirk dropped
	assert.equal(p.quirks[0].fuid, 'talented');
});

test('assembleExport: tolerates a near-empty actor without throwing', () => {
	const p = assembleExport({ character: { name: 'X' } });
	assert.equal(p.character.name, 'X');
	assert.deepEqual(p.guises, []);
	assert.deepEqual(p.bonds, []);
	assert.equal(p.character.vitals.hp.max, null);
});

test('exportBaseName: filesystem-safe slug, fallback when blank', () => {
	assert.equal(exportBaseName({ character: { name: 'Vincent Cross' } }), 'vincent-cross');
	assert.equal(exportBaseName({ character: { name: '  ??? ' } }), 'ripper');
	assert.equal(exportBaseName({}), 'ripper');
});

test('renderExportHTML: self-contained, no external assets, escapes user text', () => {
	const evil = parts();
	evil.character.name = 'Vin <script>alert(1)</script> & "Co"';
	const html = renderExportHTML(assembleExport(evil));
	assert.match(html, /^<!doctype html>/i);
	assert.match(html, /<style>/); assert.match(html, /<\/style>/);
	// no external resource references (all inline)
	assert.doesNotMatch(html, /<link\b/i);
	assert.doesNotMatch(html, /src\s*=\s*["']http/i);
	assert.doesNotMatch(html, /@import/i);
	// the raw script tag must be escaped, never live
	assert.doesNotMatch(html, /<script>alert/);
	assert.match(html, /&lt;script&gt;/);
	// real content present
	assert.match(html, /The Vampire Form/);
	assert.match(html, /Blood Drain/);
	assert.match(html, /Sister Ambroise/);
	assert.match(html, /Service Revolver/);
	assert.match(html, /Iron Constitution/);
});

test('renderExportHTML: Pirata headings are NOT uppercased via CSS (register law)', () => {
	const html = renderExportHTML(assembleExport(parts()));
	// the display face is applied to h1/h2/h3; none of those rules may carry text-transform:uppercase
	assert.doesNotMatch(html, /h1[^}]*text-transform\s*:\s*uppercase/i);
	assert.doesNotMatch(html, /--disp[^;]*;[^}]*text-transform:uppercase/i);
	// tags (worn/innate) are the only uppercased bits and they're mono labels, not names
	assert.match(html, /\.tag\{[^}]*text-transform:uppercase/i);
});
