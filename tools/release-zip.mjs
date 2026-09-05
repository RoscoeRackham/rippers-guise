// Build the RELEASE zip for rippers-guise.
//
// WHY THIS SCRIPT EXISTS (the v0.7.47-and-earlier packaging bug): the release zip used to be
// `git archive HEAD` alone — but `/packs/` is gitignored (compiled LevelDB), so every release
// shipped the `rippers-guise.guises` starter pack EMPTY. Same failure class as the
// rippers-compendium v0.4.2 lesson: a Foundry release must carry the COMPILED packs, not the
// JSON sources.
//
// THE METHOD (hybrid, durable — do not regress to bare `git archive`):
//   1. `npm run pack`  — compile src/packs/*.json → packs/<name>/ (Foundry CLI LevelDB).
//   2. `git archive --prefix=rippers-guise/` HEAD → the zip (code exactly as committed; the
//      gitignore keeps local-only art out, which must stay true — never zip the working tree
//      blindly, assets/arcana + assets/portraits must NEVER ship).
//   3. Append packs/ into the zip under the same prefix (LOCK excluded — LevelDB lockfile).
//   4. Verify: the zip must contain packs/<name>/CURRENT for every pack declared in
//      module.json, or this script exits non-zero.
//
// Usage: node tools/release-zip.mjs [outDir]   (default: the repo root; writes rippers-guise.zip)
// Release checklist (TWO-ASSET RULE): upload BOTH rippers-guise.zip AND a file named exactly
// `module.json` to the GitHub release, then verify latest/download/module.json serves the version.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = resolve(process.argv[2] ?? root);
const zipPath = join(outDir, 'rippers-guise.zip');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], ...opts });

// 1. compile the packs from source (tools/pack.mjs invoked directly — same as `npm run pack`,
//    but immune to npm not being on the spawning process's PATH)
run(process.execPath, [join(root, 'tools', 'pack.mjs')]);

// 2. code from git (committed state only)
rmSync(zipPath, { force: true });
run('git', ['archive', '--format=zip', '--prefix=rippers-guise/', '-o', zipPath, 'HEAD']);

// 3. append the compiled packs under the prefix
const stage = mkdtempSync(join(tmpdir(), 'rg-release-'));
try {
	cpSync(join(root, 'packs'), join(stage, 'rippers-guise', 'packs'), { recursive: true });
	run('zip', ['-r', '-q', zipPath, 'rippers-guise/packs', '-x', '*/LOCK'], { cwd: stage });
} finally {
	rmSync(stage, { recursive: true, force: true });
}

// 4. verify every declared pack ships with a LevelDB CURRENT marker
const listing = run('unzip', ['-l', zipPath]).toString();
const packs = JSON.parse(readFileSync(join(root, 'module.json'), 'utf8')).packs ?? [];
const missing = packs.filter((p) => !listing.includes(`rippers-guise/${p.path}/CURRENT`));
if (missing.length) {
	console.error(`RELEASE ZIP INVALID — compiled pack(s) missing: ${missing.map((p) => p.path).join(', ')}`);
	process.exit(1);
}
console.log(`ok: ${zipPath} — ${packs.length} pack(s) verified (${packs.map((p) => p.path).join(', ')})`);
