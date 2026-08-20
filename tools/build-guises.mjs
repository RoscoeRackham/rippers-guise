// build-guises.mjs — generate the rippers-guise 'guises' pack.
// Emits type:"classFeature" Item docs whose system.featureType = "rippers-guise.guise"
// (the classFeature this module registers) and whose embedded ActiveEffect carries the
// guise's stat delta. Project FU applies that effect to the actor only while the guise is
// the actor's ACTIVE guise (GuiseDataModel.transferEffects() gates on the module flag), so
// binding/dismissing a guise moves its deltas.
//
// These are ILLUSTRATIVE STARTER guises that exercise the mechanism with three different
// delta kinds (accuracy / IP / HP). A campaign's real guises are per-character personas the
// players author on the guise sheet; expand the GUISES array (or author in-world) to add more.
//
// Run:  node tools/build-guises.mjs
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = dirname(HERE);
const MODULE_ID = 'rippers-guise';
const FEATURE_TYPE = `${MODULE_ID}.guise`;
const MODE = { CUSTOM: 0, MULTIPLY: 1, ADD: 2, DOWNGRADE: 3, UPGRADE: 4, OVERRIDE: 5 };

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function id16(prefix, n) {
  const p = prefix.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  return (p + String(n).padStart(16 - p.length, '0')).slice(0, 16);
}

const GUISES = [
  {
    fuid: 'guise-inspector-grange',
    name: 'Inspector Grange',
    img: 'icons/environment/people/commoner.webp',
    identity: 'Inspector Grange',
    role: 'Scotland Yard, plainclothes',
    notes: '<p>A warrant card and a level stare. Doors open; questions get answered. The mask of the law — steadier aim, sharper attention.</p>',
    summary: 'A Scotland Yard inspector cover — steadier aim.',
    changes: [{ key: 'system.bonuses.accuracy.accuracyCheck', mode: MODE.ADD, value: '1' }],
    effectLabel: '+1 Accuracy',
  },
  {
    fuid: 'guise-dr-ravensworth',
    name: 'Dr. Ravensworth',
    img: 'icons/tools/cooking/mortar-herbs-yellow.webp',
    identity: 'Dr. Ravensworth',
    role: 'Harley Street consulting physician',
    notes: '<p>A respectable practice and a diagnostic eye. The mask of medicine — you read a room, a wound and a lie the same way.</p>',
    summary: 'A Harley Street physician cover — a diagnostic eye.',
    // Legal (outside the innate benefit pool): a bonus to Open Checks (the doctor's read).
    changes: [{ key: 'system.bonuses.accuracy.openCheck', mode: MODE.ADD, value: '1' }],
    effectLabel: '+1 to Open Checks',
  },
  {
    fuid: 'guise-the-ragged-man',
    name: 'The Ragged Man',
    img: 'icons/environment/people/beggar.webp',
    identity: 'The Ragged Man',
    role: 'A nobody the city looks past',
    notes: '<p>Nobody remembers a beggar, and no blow quite lands on a man already beneath notice. The mask of the overlooked.</p>',
    summary: 'A street-beggar cover — the city looks past you.',
    // Legal (outside the innate benefit pool): a bonus to Defense (harder to pin down).
    changes: [{ key: 'system.derived.def.bonus', mode: MODE.ADD, value: '1' }],
    effectLabel: '+1 Defense',
  },
];

// INNATE BENEFIT POOL guard (Austin canon): a guise must NEVER apply anything in the
// class innate pool — HP / MP / IP, martial proficiencies, ritual access, or Projects.
// (The same block list the module enforces at runtime, in scripts/rippers-guise.mjs.)
// Fail the build if any starter uses a pool key, so an illegal guise can never ship.
const POOL_BLOCK = [
  /^system\.resources\.(hp|mp|ip)\b/i,
  /^system\.benefits\.martials\b/i,
  /\bmartials?\.(melee|ranged|armor|shields)\b/i,
  /^system\.benefits\.rituals\b/i,
  /\britual/i,
  /\bproject/i,
];
const isPoolKey = (key) => typeof key === 'string' && POOL_BLOCK.some((re) => re.test(key));
for (const g of GUISES) {
  for (const c of g.changes) {
    if (isPoolKey(c.key)) throw new Error(`[build-guises] ILLEGAL starter guise "${g.name}": change "${c.key}" is in the innate benefit pool. Guises may only modify things OUTSIDE the pool (attributes, accuracy/damage bonuses, defenses, affinities, initiative).`);
  }
}

rmSync(join(MODULE, 'src', 'packs', 'guises'), { recursive: true, force: true });
mkdirSync(join(MODULE, 'src', 'packs', 'guises'), { recursive: true });

let i = 0;
for (const g of GUISES) {
  i += 1;
  const _id = id16('RGgu', i);
  const effId = id16('RGae', i);
  const doc = {
    name: g.name,
    type: 'classFeature',
    _id,
    img: g.img,
    system: {
      fuid: g.fuid,
      summary: { value: g.summary },
      description: `<p><strong>${esc(g.role)}.</strong></p>${g.notes}<p><em>While bound: ${esc(g.effectLabel)}.</em></p>`,
      featureType: FEATURE_TYPE,
      data: { identity: g.identity, role: g.role, notes: g.notes },
    },
    effects: [
      {
        name: `${g.name} — guise`,
        img: g.img,
        _id: effId,
        type: 'base',
        changes: g.changes.map((c) => ({ key: c.key, mode: c.mode, value: c.value, priority: null })),
        disabled: false,
        transfer: true,   // Project FU gates the actual transfer on GuiseDataModel.transferEffects()
        statuses: [],
        description: `<p>Applies while <strong>${esc(g.name)}</strong> is your bound guise.</p>`,
        origin: `Compendium.${MODULE_ID}.guises.Item.${_id}`,
        duration: { rounds: null, startTime: null, combat: null },
        system: {
          duration: { event: 'none', interval: 1, tracking: 'self', remaining: 1 },
          type: 'default',
          predicate: { crisisInteraction: 'none' },
          rules: {
            elements: {},
            progress: { enabled: false, id: '', name: '', current: 0, max: 6, style: 'bar' },
            stacking: { progress: false, duration: false, increment: 1 },
          },
        },
        flags: {},
        sort: 0,
        tint: '#ffffff',
        _key: `!items.effects!${_id}.${effId}`,
      },
    ],
    folder: null,
    flags: { [MODULE_ID]: { fuid: g.fuid, sample: true } },
    sort: 0,
    ownership: { default: 0 },
    _stats: { systemId: 'projectfu', coreVersion: '13.0.0' },
    _key: `!items!${_id}`,
  };
  writeFileSync(join(MODULE, 'src', 'packs', 'guises', `guise_${g.fuid}.json`), JSON.stringify(doc, null, '\t'));
  console.log(`guise: ${g.name} (${g.effectLabel}) -> ${_id}`);
}
console.log(`\nTOTAL guise classFeature Items: ${i}`);
