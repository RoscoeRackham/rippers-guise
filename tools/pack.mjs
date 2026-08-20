// Compile src/packs/<pack>/*.json (one JSON per document) into LevelDB packs/<pack>.
// Mirrors the Project FU pack pipeline (tools/pullYMLtoLDB.mjs). Reusable across the
// Rippers Foundry modules — plugins 2-4 copy this file unchanged.
import { compilePack } from '@foundryvtt/foundryvtt-cli';
import { promises as fs } from 'fs';

const MODULE_ID = process.cwd();
const yaml = false; // sources are JSON, one document per file

const packs = await fs.readdir('./src/packs');
for (const pack of packs) {
	if (pack.startsWith('.')) continue;
	console.log('Packing ' + pack);
	await compilePack(`${MODULE_ID}/src/packs/${pack}`, `${MODULE_ID}/packs/${pack}`, { yaml });
}
console.log('Done.');
