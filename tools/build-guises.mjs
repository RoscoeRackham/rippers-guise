// build-guises.mjs — generate the rippers-guise 'guises' pack (v0.2 Stage A).
// Emits type:"classFeature" Item docs (featureType "rippers-guise.guise") whose system.data
// is the v0.2 GuiseDataModel: { narrative, classes:[{classUuid, skills:[{skillUuid, sl}]}],
// equipment:[{itemUuid, slot}], affinityModifiers:[{type, level}] }.
//
// Binding a guise materialises its classes' SKILL Items (owned, at their allocated sl — never
// the class Item, so no innate pool), equips its equipment, and applies its affinities.
//
// D5 (Austin): the 3 MVP starters had raw stat deltas that don't fit v0.2 — they migrate to
// NARRATIVE-ONLY here (deltas dropped). "The Alienist" is a fully-authored v0.2 sample so the
// engine is testable without the (alpha.2) authoring UI: a Physician mask activating three
// Physician skills at allocated SL, with an affinity trio.
//
// Run:  node tools/build-guises.mjs
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = dirname(HERE);
const MODULE_ID = 'rippers-guise';
const FEATURE_TYPE = `${MODULE_ID}.guise`;
const COMP = 'Compendium.rippers-compendium';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function id16(prefix, n) {
	const p = prefix.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
	return (p + String(n).padStart(16 - p.length, '0')).slice(0, 16);
}
// affinity level -> ActiveEffect change (mirrors affinityChange() in the esmodule)
function affinityChange(type, level) {
	const n = Number(level);
	if (n === 1) return { key: `system.affinities.${type}`, mode: 0, value: 'upgrade', priority: null };
	if (n === -1) return { key: `system.affinities.${type}`, mode: 0, value: 'downgrade', priority: null };
	if (n === 2) return { key: `system.affinities.${type}.current`, mode: 4, value: '2', priority: null };
	if (n === 3) return { key: `system.affinities.${type}.current`, mode: 4, value: '3', priority: null };
	return null;
}
const affinityWord = (n) => ({ '-1': 'Vulnerability', 1: 'Resistance', 2: 'Immunity', 3: 'Absorption' }[String(n)] ?? '?');

// ---- the guises -----------------------------------------------------------
const GUISES = [
	// D5 migration: the 3 MVP starters -> narrative-only (raw deltas dropped).
	{
		fuid: 'guise-inspector-grange', name: 'Inspector Grange', img: 'icons/environment/people/commoner.webp',
		identity: 'Inspector Grange', role: 'Scotland Yard, plainclothes',
		notes: '<p>A warrant card and a level stare. Doors open; questions get answered.</p>',
		summary: 'A Scotland Yard inspector cover.',
		classes: [], equipment: [], affinityModifiers: [],
	},
	{
		fuid: 'guise-dr-ravensworth', name: 'Dr. Ravensworth', img: 'icons/tools/cooking/mortar-herbs-yellow.webp',
		identity: 'Dr. Ravensworth', role: 'Harley Street consulting physician',
		notes: '<p>A respectable practice and a diagnostic eye.</p>',
		summary: 'A Harley Street physician cover.',
		classes: [], equipment: [], affinityModifiers: [],
	},
	{
		fuid: 'guise-the-ragged-man', name: 'The Ragged Man', img: 'icons/environment/people/beggar.webp',
		identity: 'The Ragged Man', role: 'A nobody the city looks past',
		notes: '<p>Nobody remembers a beggar.</p>',
		summary: 'A street-beggar cover.',
		classes: [], equipment: [], affinityModifiers: [],
	},
	// A fully-authored v0.2 sample — testable end to end without the authoring UI.
	{
		fuid: 'guise-the-alienist', name: 'The Alienist', img: 'icons/tools/cooking/mortar-herbs-yellow.webp',
		identity: 'Dr. Aldous Vane, alienist', role: 'A mad-doctor with a black bag',
		notes: '<p>A sample v0.2 guise. Binding it activates three <strong>Physician</strong> skills at their allocated Skill Levels — <em>without</em> granting the Physician class\'s innate pool — and applies an affinity trio. Dismiss to reverse.</p>',
		summary: 'Sample: a Physician mask (skills at allocated SL + an affinity trio).',
		classes: [
			{
				classUuid: `${COMP}.classes.Item.RCcl000000000036`, // Physician
				skills: [
					{ skillUuid: `${COMP}.skills.Item.RCsk000000000186`, sl: 1 }, // Doctorate (max 1)
					{ skillUuid: `${COMP}.skills.Item.RCsk000000000188`, sl: 2 }, // Drug Synthesis (max 3)
					{ skillUuid: `${COMP}.skills.Item.RCsk000000000189`, sl: 3 }, // Emergency Aid (max 5)
				], // per-class Σ = 6 ≤ 10 ✓; each ≤ its max_sl ✓
			},
		],
		equipment: [], // engine-ready; add a weapon/armor UUID to demo equip
		affinityModifiers: [
			{ type: 'dark', level: 1 },   // Resistance
			{ type: 'light', level: -1 }, // Vulnerability
			{ type: 'poison', level: 2 }, // Immunity
		],
	},
];

rmSync(join(MODULE, 'src', 'packs', 'guises'), { recursive: true, force: true });
mkdirSync(join(MODULE, 'src', 'packs', 'guises'), { recursive: true });

let i = 0;
for (const g of GUISES) {
	i += 1;
	const _id = id16('RGgu', i);
	const effects = [];
	// Pre-bake the affinity effect for authored guises (the module also keeps it in sync).
	const changes = (g.affinityModifiers ?? []).map((m) => affinityChange(m.type, m.level)).filter(Boolean);
	if (changes.length) {
		const effId = id16('RGae', i);
		effects.push({
			name: 'Guise affinities', img: g.img, _id: effId, transfer: true, disabled: false,
			changes, statuses: [],
			description: `<p>${g.affinityModifiers.map((m) => `${affinityWord(m.level)} to ${m.type}`).join(' · ')} — while this guise is bound.</p>`,
			origin: `Compendium.${MODULE_ID}.guises.Item.${_id}`,
			duration: { rounds: null, startTime: null, combat: null },
			flags: { [MODULE_ID]: { affinityEffect: true } },
			sort: 0, tint: '#ffffff',
			_key: `!items.effects!${_id}.${effId}`,
		});
	}
	const skillLines = (g.classes ?? []).flatMap((c) => c.skills.map((s) => `<li><code>${esc(s.skillUuid.split('.').pop())}</code> @ SL ${s.sl}</li>`));
	const doc = {
		name: g.name, type: 'classFeature', _id, img: g.img,
		system: {
			fuid: g.fuid,
			summary: { value: g.summary },
			description: `<p><strong>${esc(g.role)}.</strong></p>${g.notes}`
				+ (skillLines.length ? `<p><em>Activates on bind:</em></p><ul>${skillLines.join('')}</ul>` : '')
				+ (changes.length ? `<p><em>Affinities:</em> ${g.affinityModifiers.map((m) => `${affinityWord(m.level)} ${m.type}`).join(' · ')}</p>` : ''),
			featureType: FEATURE_TYPE,
			data: {
				identity: g.identity, role: g.role, notes: g.notes,
				classes: g.classes ?? [], equipment: g.equipment ?? [], affinityModifiers: g.affinityModifiers ?? [],
			},
		},
		effects,
		folder: null,
		flags: { [MODULE_ID]: { fuid: g.fuid, schemaVersion: 2 } },
		sort: 0, ownership: { default: 0 },
		_stats: { systemId: 'projectfu', coreVersion: '13.0.0' },
		_key: `!items!${_id}`,
	};
	writeFileSync(join(MODULE, 'src', 'packs', 'guises', `guise_${g.fuid}.json`), JSON.stringify(doc, null, '\t'));
	const alloc = (g.classes ?? []).reduce((a, c) => a + c.skills.reduce((x, s) => x + s.sl, 0), 0);
	console.log(`guise: ${g.name} — ${(g.classes ?? []).length} class(es), ${alloc} SL allocated, ${changes.length} affinity change(s)`);
}
console.log(`\nTOTAL guise classFeature Items: ${i} (3 narrative-only migrated starters + 1 authored sample)`);
