/**
 * EXPORT SHEET — the curated character export (SHEET-EXPORT-P1, god dispatch conv-export01).
 * Two artifacts from one Rippers actor: (1) a clean player-facing JSON (this module's stable schema,
 * NOT a raw actor dump) and (2) a self-contained register-styled printable HTML sheet.
 *
 * This file is PURE — no Foundry globals. `assembleExport(parts)` shapes the schema from already-read
 * plain data; `renderExportHTML(payload)` returns a standalone HTML string. The Foundry reads that
 * feed `parts` live in rippers-guise.mjs (collectExportParts), so both functions are headless-testable.
 *
 * SCHEMA CONTRACT (handed to Compiler for the P2 artifact viewer — keep STABLE; bump schemaVersion on
 * any breaking change, never silently repurpose a field):
 *   { schema:'rippers-guise.character-export', schemaVersion:1, exportedAt, moduleVersion,
 *     character:{ name, identity, pronouns, theme, origin, level, classes:[string],
 *                 vitals:{ hp:{value,max}, mp:{value,max}, ip:{value,max}, fp, exp, zenit,
 *                          crisis:{inCrisis,score} },
 *                 attributes:[{key,label,die}], affinities:[{type,level,word}],
 *                 derived:{ def, mdef, init } },
 *     guises:[{ name, role, identity, innate, worn, bane, tell, perk, heroicName,
 *               affinities:[{type,level,word}], classes:[{name, skills:[{name,sl,maxSl}]}] }],
 *     bonds:[{ name, admInf, loyMis, affHat, strength, tier }],
 *     inventory:[{ section, name, detail }],
 *     quirks:[{ name, fuid }] }
 */

export const EXPORT_SCHEMA = 'rippers-guise.character-export';
export const EXPORT_SCHEMA_VERSION = 1;

const s = (v) => (v == null ? '' : String(v));
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** value/max pool → {value, max|null} */
const pool = (p) => ({ value: n(p?.value), max: p?.max == null ? null : n(p.max) });

/**
 * Shape the export payload from collected plain parts (see collectExportParts in rippers-guise.mjs).
 * `now` is injected for deterministic tests. Invents nothing — every field traces to a read.
 */
export function assembleExport(parts = {}, { now = new Date(), moduleVersion = '' } = {}) {
	const c = parts.character ?? {};
	return {
		schema: EXPORT_SCHEMA,
		schemaVersion: EXPORT_SCHEMA_VERSION,
		exportedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
		moduleVersion: s(moduleVersion),
		character: {
			name: s(c.name), identity: s(c.identity), pronouns: s(c.pronouns),
			theme: s(c.theme), origin: s(c.origin), level: n(c.level),
			classes: (c.classes ?? []).map(s).filter(Boolean),
			vitals: {
				hp: pool(c.vitals?.hp), mp: pool(c.vitals?.mp), ip: pool(c.vitals?.ip),
				fp: n(c.vitals?.fp), exp: n(c.vitals?.exp), zenit: n(c.vitals?.zenit),
				crisis: { inCrisis: !!c.vitals?.crisis?.inCrisis, score: n(c.vitals?.crisis?.score) },
			},
			attributes: (c.attributes ?? []).map((a) => ({ key: s(a.key), label: s(a.label), die: s(a.die) })),
			affinities: (c.affinities ?? []).map((a) => ({ type: s(a.type), level: n(a.level), word: s(a.word) })),
			derived: { def: n(c.derived?.def), mdef: n(c.derived?.mdef), init: n(c.derived?.init) },
		},
		guises: (parts.guises ?? []).map((g) => ({
			name: s(g.name), role: s(g.role), identity: s(g.identity),
			innate: !!g.innate, worn: !!g.worn,
			bane: s(g.bane), tell: s(g.tell), perk: s(g.perk),
			heroicName: g.heroicName ? s(g.heroicName) : null,
			affinities: (g.affinities ?? []).map((a) => ({ type: s(a.type), level: n(a.level), word: s(a.word) })),
			classes: (g.classes ?? []).map((cl) => ({
				name: s(cl.name),
				skills: (cl.skills ?? []).map((sk) => ({ name: s(sk.name), sl: n(sk.sl), maxSl: n(sk.maxSl) })),
			})),
		})),
		bonds: (parts.bonds ?? []).map((b) => ({
			name: s(b.name), admInf: s(b.admInf), loyMis: s(b.loyMis), affHat: s(b.affHat),
			strength: n(b.strength), tier: s(b.tier || 'fleeting'),
		})).filter((b) => b.name || b.admInf || b.loyMis || b.affHat),
		inventory: (parts.inventory ?? []).map((it) => ({ section: s(it.section), name: s(it.name), detail: s(it.detail) })).filter((it) => it.name),
		quirks: (parts.quirks ?? []).map((q) => ({ name: s(q.name), fuid: s(q.fuid) })).filter((q) => q.name),
	};
}

/** A filesystem-safe base name for the download pair, from the character name. */
export function exportBaseName(payload) {
	const raw = s(payload?.character?.name).trim() || 'ripper';
	return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ripper';
}

const esc = (v) => s(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function poolLine(label, p) {
	const max = p.max == null ? '' : ` / ${p.max}`;
	return `<div class="pool"><span class="k">${esc(label)}</span><span class="v">${esc(p.value)}${esc(max)}</span></div>`;
}

/**
 * Register-styled, self-contained printable HTML (inline CSS, no external assets/fonts — font stacks
 * degrade to system serif/mono so it prints anywhere). Pirata used for names/headings in NATURAL CASE
 * (register law — never uppercased via CSS); mono for labels and numbers; blood/bone palette.
 */
export function renderExportHTML(payload = {}) {
	const c = payload.character ?? {};
	const attrs = (c.attributes ?? []).map((a) => `<div class="attr"><span class="k">${esc(a.short ?? a.key?.toUpperCase?.() ?? a.label)}</span><span class="v">${esc(a.die)}</span></div>`).join('');
	const affs = (c.affinities ?? []).filter((a) => a.word && a.word !== '—').map((a) => `<span class="aff">${esc(a.type)} · ${esc(a.word)}</span>`).join('') || '<span class="none">no marked affinities</span>';
	const classes = (c.classes ?? []).map(esc).join(' · ') || '<span class="none">—</span>';

	const guises = (payload.guises ?? []).map((g) => {
		const gAff = (g.affinities ?? []).filter((a) => a.word && a.word !== '—').map((a) => `<span class="aff">${esc(a.type)} · ${esc(a.word)}</span>`).join('') || '<span class="none">—</span>';
		const cls = (g.classes ?? []).map((cl) => {
			const sk = (cl.skills ?? []).map((skk) => `<li>${esc(skk.name)} <span class="sl">SL ${esc(skk.sl)}${skk.maxSl ? `/${esc(skk.maxSl)}` : ''}</span></li>`).join('');
			return `<div class="gcls"><div class="gcls-name">${esc(cl.name)}</div><ul>${sk || '<li class="none">—</li>'}</ul></div>`;
		}).join('');
		const tags = [g.worn ? '<span class="tag worn">worn</span>' : '', g.innate ? '<span class="tag innate">innate</span>' : ''].join('');
		const htp = [['Perk', g.perk], ['Tell', g.tell], ['Bane', g.bane]].filter(([, val]) => s(val).trim())
			.map(([k, val]) => `<div class="gtrait"><span class="k">${k}</span> ${esc(val)}</div>`).join('');
		return `<section class="guise">
			<h3>${esc(g.name)} ${tags}</h3>
			<div class="gmeta">${[g.role, g.identity].filter(Boolean).map(esc).join(' · ') || ''}${g.heroicName ? ` · <em>${esc(g.heroicName)}</em>` : ''}</div>
			<div class="affrow">${gAff}</div>
			${htp}
			${cls}
		</section>`;
	}).join('') || '<p class="none">No guises recorded.</p>';

	const bonds = (payload.bonds ?? []).map((b) => {
		const emo = [b.admInf, b.loyMis, b.affHat].filter(Boolean).map(esc).join(', ');
		return `<li><span class="bname">${esc(b.name || '(unnamed)')}</span> <span class="btier">${esc(b.tier)}</span><span class="bstr">strength ${esc(b.strength)}</span>${emo ? `<div class="bemo">${emo}</div>` : ''}</li>`;
	}).join('') || '<li class="none">No bonds recorded.</li>';

	const inv = (payload.inventory ?? []).map((it) => `<li><span class="isec">${esc(it.section)}</span> ${esc(it.name)}${it.detail ? ` <span class="idet">${esc(it.detail)}</span>` : ''}</li>`).join('') || '<li class="none">Nothing carried.</li>';
	const quirks = (payload.quirks ?? []).map((q) => `<li>${esc(q.name)}</li>`).join('') || '<li class="none">—</li>';

	const v = c.vitals ?? {};
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.name || 'Ripper')} — character sheet</title>
<style>
:root{--bg:#f3ece0;--ink:#1a1113;--blood:#c8102a;--bloodink:#8a0d1e;--bone:#efe6d5;--muted:#6b5d52;--line:#c9b79c;
--disp:'Pirata One','Grenze Gotisch','Times New Roman',serif;--mono:'IBM Plex Mono',ui-monospace,'Courier New',monospace;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--mono);font-size:12px;line-height:1.5;}
.sheet{max-width:820px;margin:0 auto;padding:28px 30px 40px;background:var(--bone);
box-shadow:0 0 0 1px var(--line);}
header{border-bottom:3px solid var(--blood);padding-bottom:10px;margin-bottom:14px;}
h1{font-family:var(--disp);font-weight:400;font-size:40px;line-height:1;margin:0 0 4px;color:var(--bloodink);letter-spacing:.5px;}
.idline{font-family:var(--mono);font-size:11px;color:var(--muted);letter-spacing:.06em;}
.idline b{color:var(--ink);font-weight:600;}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:14px 0;}
h2{font-family:var(--disp);font-weight:400;font-size:20px;color:var(--bloodink);margin:18px 0 6px;border-bottom:1px solid var(--line);}
.k{color:var(--muted);font-weight:600;letter-spacing:.08em;}
.pool{display:flex;justify-content:space-between;border-bottom:1px dotted var(--line);padding:2px 0;}
.pool .v{font-weight:600;}
.attrs{display:flex;gap:10px;flex-wrap:wrap;}
.attr{border:1px solid var(--line);padding:4px 10px;text-align:center;background:#fff8;}
.attr .k{display:block;font-size:9px;}
.attr .v{font-family:var(--disp);font-size:20px;color:var(--bloodink);}
.affrow{display:flex;gap:6px;flex-wrap:wrap;margin:4px 0;}
.aff{border:1px solid var(--bloodink);color:var(--bloodink);padding:1px 7px;font-size:10px;letter-spacing:.04em;}
.none{color:var(--muted);font-style:italic;}
.guise{border:1px solid var(--line);border-left:3px solid var(--blood);padding:8px 12px;margin:8px 0;background:#fff6;}
.guise h3{font-family:var(--disp);font-weight:400;font-size:22px;margin:0;color:var(--ink);}
.gmeta{font-size:10px;color:var(--muted);letter-spacing:.04em;margin-bottom:4px;}
.tag{font-family:var(--mono);font-size:8px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;
padding:1px 6px;border:1px solid var(--muted);color:var(--muted);vertical-align:middle;margin-left:4px;}
.tag.worn{background:var(--blood);color:#fff;border-color:var(--bloodink);}
.gtrait{font-size:11px;margin:2px 0;} .gtrait .k{color:var(--bloodink);font-weight:600;letter-spacing:.08em;text-transform:uppercase;font-size:9px;}
.gcls{margin-top:4px;} .gcls-name{font-weight:600;letter-spacing:.04em;}
.gcls ul{margin:2px 0 6px;padding-left:16px;} .gcls li{list-style:square;}
.sl{color:var(--muted);font-size:10px;}
ul.plain{list-style:none;padding:0;margin:0;} ul.plain li{border-bottom:1px dotted var(--line);padding:3px 0;}
.bname{font-weight:600;} .btier{border:1px solid var(--line);padding:0 5px;font-size:9px;margin-left:6px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);}
.bstr{float:right;color:var(--muted);font-size:10px;} .bemo{font-size:10px;color:var(--muted);}
.isec{color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.1em;margin-right:6px;}
.idet{color:var(--muted);font-size:10px;}
footer{margin-top:20px;border-top:1px solid var(--line);padding-top:6px;font-size:9px;color:var(--muted);letter-spacing:.06em;}
@media print{body{background:#fff}.sheet{box-shadow:none;max-width:none}}
</style></head>
<body><div class="sheet">
<header>
<h1>${esc(c.name || 'Ripper')}</h1>
<div class="idline">${[c.identity && `<b>${esc(c.identity)}</b>`, c.pronouns && esc(c.pronouns), c.theme && esc(c.theme), c.origin && esc(c.origin)].filter(Boolean).join(' · ')}${c.level ? ` · level <b>${esc(c.level)}</b>` : ''}</div>
<div class="idline">${classes}</div>
</header>
<div class="grid">
<div>
<h2>Vitals</h2>
${poolLine('HP', v.hp ?? { value: 0, max: null })}
${poolLine('MP', v.mp ?? { value: 0, max: null })}
${poolLine('IP', v.ip ?? { value: 0, max: null })}
<div class="pool"><span class="k">FP</span><span class="v">${esc(v.fp ?? 0)}</span></div>
<div class="pool"><span class="k">EXP</span><span class="v">${esc(v.exp ?? 0)}</span></div>
<div class="pool"><span class="k">Zenit</span><span class="v">${esc(v.zenit ?? 0)}</span></div>
<div class="pool"><span class="k">DEF / M.DEF / Init</span><span class="v">${esc(c.derived?.def ?? 0)} / ${esc(c.derived?.mdef ?? 0)} / ${esc(c.derived?.init ?? 0)}</span></div>
</div>
<div>
<h2>Attributes</h2>
<div class="attrs">${attrs || '<span class="none">—</span>'}</div>
<h2>Affinities</h2>
<div class="affrow">${affs}</div>
</div>
</div>
<h2>Guises</h2>
${guises}
<h2>Bonds</h2>
<ul class="plain">${bonds}</ul>
<div class="grid">
<div><h2>Inventory</h2><ul class="plain">${inv}</ul></div>
<div><h2>Quirks</h2><ul class="plain">${quirks}</ul></div>
</div>
<footer>Rippers Unmasked · exported ${esc((payload.exportedAt || '').replace('T', ' ').replace(/\..*$/, ' UTC'))} · module ${esc(payload.moduleVersion || '')} · schema ${esc(payload.schema)} v${esc(payload.schemaVersion)}</footer>
</div></body></html>`;
}
