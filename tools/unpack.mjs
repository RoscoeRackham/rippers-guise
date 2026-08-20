// Reverse of pack.mjs: extract LevelDB packs/<pack> back to src/packs/<pack>/*.json
// so a pack edited inside Foundry can be round-tripped to source. Reusable.
import { extractPack } from '@foundryvtt/foundryvtt-cli';
import { promises as fs } from 'fs';

const MODULE_ID = process.cwd();
const yaml = false;

const packs = await fs.readdir('./packs');
for (const pack of packs) {
	if (pack.startsWith('.')) continue;
	console.log('Unpacking ' + pack);
	await extractPack(`${MODULE_ID}/packs/${pack}`, `${MODULE_ID}/src/packs/${pack}`, { yaml });
}
console.log('Done.');
