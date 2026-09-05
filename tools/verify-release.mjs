// RELEASE-INTEGRITY GATE (TEST-AUTOMATION-STRATEGY §3, Phase 1).
// Validates the PUBLISHED GitHub release — the shipped bytes, not the working tree.
// Run after publishing:  node tools/verify-release.mjs [tag]   (default: the latest release)
// Exits non-zero on any failure so CI can fail the workflow.
//
// Checks (each guards a failure that actually shipped or nearly shipped):
//  1. TWO-ASSET RULE — assets named exactly `module.json` and `rippers-guise.zip`
//     (v0.7.39 lesson: a missing/mis-named module.json asset 404s the manifest and Forge
//     never offers the update; `gh release create file#name` sets a LABEL, not the filename).
//  2. Version triple-match — tag == module.json asset version == module.json INSIDE the zip.
//  3. Shipped-zip contents — every pack declared in module.json carries packs/<name>/CURRENT
//     (v0.7.47-and-earlier: git archive shipped the starter pack EMPTY), and NO local-only art
//     (assets/arcana, assets/portraits — licensed for local use only, must never be published).
//  4. Diagnostic-build hygiene — a release whose notes/name carry a DIAGNOSTIC or
//     instrumentation-only marker must be a PRERELEASE (the v0.7.43 stranding: Forge offered a
//     diagnostic bump as a normal update and it lacked a later fix).
// Requires: `gh` authenticated (CI: GH_TOKEN), `unzip`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'RoscoeRackham/rippers-guise';
const tagArg = process.argv[2] ?? '';
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok ' : 'FAIL'}  ${msg}`); if (!ok) fails.push(msg); };
const gh = (args) => execFileSync('gh', args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString();

const view = JSON.parse(gh(['release', 'view', ...(tagArg ? [tagArg] : []), '--repo', REPO,
	'--json', 'tagName,name,body,isPrerelease,assets']));
const tag = view.tagName;
const version = tag.replace(/^v/, '');
console.log(`verifying ${REPO} ${tag}${view.isPrerelease ? ' (prerelease)' : ''}`);

// 1 — assets present, exact names
const names = view.assets.map((a) => a.name);
check(names.includes('module.json'), `asset named exactly module.json (saw: ${names.join(', ')})`);
check(names.includes('rippers-guise.zip'), 'asset named exactly rippers-guise.zip');

const work = mkdtempSync(join(tmpdir(), 'rg-verify-'));
try {
	gh(['release', 'download', tag, '--repo', REPO, '--dir', work,
		'--pattern', 'module.json', '--pattern', 'rippers-guise.zip']);

	// 2 — version triple-match
	const manifest = JSON.parse(readFileSync(join(work, 'module.json'), 'utf8'));
	check(manifest.version === version, `module.json asset version ${manifest.version} == tag ${version}`);
	const zip = join(work, 'rippers-guise.zip');
	const zipManifest = JSON.parse(
		execFileSync('unzip', ['-p', zip, 'rippers-guise/module.json']).toString());
	check(zipManifest.version === version, `module.json INSIDE the zip ${zipManifest.version} == tag ${version}`);

	// 3 — shipped-zip contents
	const listing = execFileSync('unzip', ['-l', zip]).toString();
	for (const p of zipManifest.packs ?? []) {
		check(listing.includes(`rippers-guise/${p.path}/CURRENT`), `compiled pack shipped: ${p.path}/CURRENT`);
	}
	check(!/assets\/(arcana|portraits)\//.test(listing), 'no local-only art in the zip');

	// 4 — diagnostic hygiene
	const diagnostic = /\bDIAGNOSTIC\b|instrumentation-only/i.test(`${view.name}\n${view.body}`);
	check(!diagnostic || view.isPrerelease, 'diagnostic/instrumentation build is marked prerelease');
} finally {
	rmSync(work, { recursive: true, force: true });
}

if (fails.length) { console.error(`\nRELEASE INVALID — ${fails.length} check(s) failed`); process.exit(1); }
console.log(`\n${tag}: all release-integrity checks passed`);
