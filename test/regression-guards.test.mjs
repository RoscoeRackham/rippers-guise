// PERMANENT REGRESSION GUARDS (TEST-AUTOMATION-STRATEGY §2, Phase 1).
// Source-SHAPE checks on scripts/rippers-guise.mjs: each guards a hard-won fix so a future edit
// (or a rebase that silently drops one) fails the suite even if a mock would still pass.
// These complement — never replace — the behavioural tests in rippers-sheet.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../scripts/rippers-guise.mjs', import.meta.url)), 'utf8');

/** Extract a top-level `[async] function name(...) {...}` body by brace matching. */
function fnBody(name) {
	let start = src.indexOf(`async function ${name}(`);
	if (start === -1) start = src.indexOf(`function ${name}(`);
	assert.notEqual(start, -1, `function ${name} exists`);
	const open = src.indexOf('{', start);
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
	}
	throw new Error(`unbalanced braces in ${name}`);
}

test('GUARD v0.7.46 (guise-loss incident): classFeature registration is wired on init, before world validation', () => {
	// The drop-on-reload bug: registering on 'setup' runs AFTER Game.initializeDocuments, so every
	// guise item failed featureType validation and was silently excluded. init registration is the fix.
	assert.match(src, /Hooks\.once\('init',\s*registerGuiseClassFeature\)/);
	// and the setup fallback must still exist (registry-late edge)
	assert.match(src, /registerGuiseClassFeature\(\)/);
});

test('GUARD v0.7.46 safety: the dangling-guise repair never writes to the actor', () => {
	const body = fnBody('repairDanglingActiveGuise');
	// warn-only by design — a write here can persist the actor WITHOUT its excluded guise,
	// purging the recoverable _source. No unsetFlag/setFlag/update in this function, ever.
	assert.doesNotMatch(body, /unsetFlag|setFlag|\.update\(/);
});

test('GUARD v0.7.44: materialiseEquipment does ONE batched createEmbeddedDocuments, no per-item loop', () => {
	const body = fnBody('materialiseEquipment');
	const calls = body.match(/createEmbeddedDocuments/g) ?? [];
	// exactly one call site (comments mentioning it are stripped)
	const code = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
	const codeCalls = code.match(/createEmbeddedDocuments\(/g) ?? [];
	assert.equal(codeCalls.length, 1, `one call site (saw ${codeCalls.length}, comments carried ${calls.length - codeCalls.length})`);
	// and that call is not inside a for/while loop awaiting per item
	assert.doesNotMatch(code, /for\s*\([^)]*\)\s*\{[^{}]*await[^{}]*createEmbeddedDocuments/);
});

test('GUARD v0.7.42: the play-surface shell defers heavy work (deferHeavy path present, prewarm index-only)', () => {
	assert.match(src, /deferHeavy/);
	// prewarm must fetch pack INDEXES, not documents (the perf fix): getIndex, no getDocuments in prewarm
	const prewarm = fnBody('prewarmGuisePacks');
	assert.match(prewarm, /getIndex/);
	assert.doesNotMatch(prewarm, /getDocuments/);
});

test('GUARD P4: _ensureDefaultGuise is fire-and-forget at its render call site (never awaited)', () => {
	const callSites = [...src.matchAll(/^.*this\._ensureDefaultGuise\(\).*$/gm)].map((m) => m[0]);
	assert.ok(callSites.length >= 1, 'call site exists');
	for (const line of callSites) assert.doesNotMatch(line, /await/, `not awaited: ${line.trim()}`);
});

test('GUARD v0.7.49 (vault trade): both trade legs create BEFORE they delete — a guise is never lost', () => {
	// vaultConsign: the source item is deleted only after the vault create succeeds; vaultDraw: the
	// vault source is deleted only after the actor create, with rollback on delete failure. Reordering
	// either (delete-first, or dropping the rollback) can destroy a player's guise on a failed write.
	for (const name of ['vaultConsign', 'vaultDraw']) {
		const code = fnBody(name).replace(/\/\/[^\n]*/g, '');
		const create = code.indexOf('createEmbeddedDocuments');
		const del = code.search(/\.delete\(\)/);
		assert.ok(create !== -1 && del !== -1, `${name} has both create and delete`);
		assert.ok(create < del, `${name}: create comes before delete`);
	}
	assert.match(fnBody('vaultDraw'), /deleteEmbeddedDocuments/); // the rollback path exists
	// and trading must never write the repair path's forbidden actor flags (Turn economics untouched)
	assert.doesNotMatch(fnBody('vaultConsign'), /USED_GUISES_FLAG.*setFlag|setFlag.*USED_GUISES_FLAG/);
});

test('GUARD packaging (v0.7.48): module declares the guises pack and the release tool hard-verifies it', () => {
	const mod = JSON.parse(readFileSync(fileURLToPath(new URL('../module.json', import.meta.url)), 'utf8'));
	assert.ok(mod.packs?.some((p) => p.path === 'packs/guises'), 'packs/guises declared');
	const tool = readFileSync(fileURLToPath(new URL('../tools/release-zip.mjs', import.meta.url)), 'utf8');
	assert.match(tool, /CURRENT/, 'release-zip verifies the compiled LevelDB CURRENT marker');
});
