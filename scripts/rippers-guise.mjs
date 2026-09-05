/**
 * rippers-guise v0.2 (Stage A) — the Guise as a first-class Project FU classFeature
 * (Arcanum pattern). A guise = { narrative, classes[+skill allocation], equipment,
 * affinityModifiers }. Binding a guise makes exactly one guise active, materialises its
 * classes' SKILL Items (owned copies, at their ALLOCATED SL — never the class Item, so
 * ZERO innate pool), equips its equipment, and applies its affinity modifiers; dismissing
 * cleanly reverses all three. Built per lodge-docs/GUISE-v2-design.md §1–§8.
 *
 * DECISIONS (Austin, locked): D1 UUID references to the shipped compendium (not embed).
 * D2 delete-and-recreate owned skill Items on swap. D3 the guise carries its own equipment
 * loadout. D5 no generic-bonus escape hatch. Skills materialise at the ALLOCATED sl with the
 * three hard caps (per-class Σ ≤ 10, per-skill ≤ max_sl, total ≤ min(charLevel, 30)).
 *
 * Transport: affinities ride the proven transferEffects() gate (embedded ActiveEffect on the
 * guise, synced from affinityModifiers); skills + equipment are explicit CRUD tagged
 * flags['rippers-guise'].owned[guiseId], with an equip snapshot/restore.
 *
 * FDN-8 Stage 8a (v0.4.0-alpha.1) adds the HUNTER WEAPON: an isHunterWeapon mark + material/origin
 * fields on a transforming customWeapon, and a FREE once-per-turn two-form swap (no Equipment
 * Action). Stage 8b (alpha.2) adds HOPLOSPHERE SOCKETS: a level-derived socket capacity
 * (min(6, floor(lvl/5)); +1 at 40 and +1 at 50 for the Hunter Weapon) + a two-Immunity cap, an
 * audit (checkHoplosphereSockets) and a best-effort slotting guard. Stage 8c (alpha.3) adds HEROIC
 * SLOTS: the four canon slots (creation/level40/level50/earned) with level-gated 40/50, creation_banned
 * enforcement, and dormancy (the creation heroic sleeps while masked; 40/50/earned stay live).
 * HW1 (ratified) wires the Hunter Weapon material to its bane key (silver/cold_iron/consecrated/
 * wood; cursed = GM-authored) so the canon wpn_material engine resolves — data only. v0.4.1
 * retargets the 8b hoplosphere hard-guard from preCreateItem to a customWeapon preUpdateItem hook
 * (spheres slot into system.items, a PseudoDocumentCollectionField persisted via a weapon update)
 * and returns {ok,reason} from assignHeroicSlot so a UI can show why an assignment was refused.
 *
 * FDN-7 (v0.3.0/0.3.1) adds a player-facing GUISES PANEL in PFU's character-sheet Features tab: a
 * subsection listing the actor's owned guises, each with a Bind/Dismiss button and an ACTIVE
 * badge (one active at a time). Buttons call the EXISTING setActiveGuise — bind mechanics
 * unchanged. Injected via the renderFUStandardActorSheet / renderFUActorSheet hooks (idempotent).
 *
 * Stage B (v0.2.0) added: the two-pool DORMANCY switch (on bind, the character's own innate
 * skills are suppressed — level.value → 0, snapshot into flags for restore — so exactly one
 * 30-level set is live), the interactive sheet-authoring UI (class/skill/equipment drop targets +
 * per-skill SL picker with live enforcement of all three caps), and derived class level (Σ SL) on
 * the sheet. NOT yet: the §10 progression layer (lent vitals, IP satchel, hoplosphere, Hunter
 * Weapon, heroic slots) — a separate later track. The v0.1.1 innate-pool guard stays.
 *
 * FDN-9 (v0.6.0) adds MONSTROUS-FORM AFFINITIES as a general Guise capability: a guise may declare
 * one or more affinity-SETS (system.data.affinitySets, authored in the Builder) and/or COLLECT them in
 * play (flags.rippers-guise.affinityLibrary). While such a guise is worn, its ACTIVE set REPLACES the
 * wearer's entire affinity array — a nine-element true-OVERRIDE (AE mode 5) on system.affinities.<el>
 * .current (incl. 0=none, so a form can LOWER a native affinity), restored automatically on dismiss
 * because only .current (derived) is written, never .base. A free once-per-turn swapAffinitySet re-points
 * the active set and live-rebuilds the transferred effect. Legacy guises (no set / affinityMode!='replace')
 * keep the additive affinityModifiers MODIFY path unchanged — the two never mix. (This began as the cut
 * Diabolist "pact" mechanic; the pact-* API survives as thin back-compat aliases.)
 *
 * @see globalThis.projectfu.RollableClassFeatureDataModel
 */

const MODULE_ID = 'rippers-guise';
const FLAG = 'activeGuise';
const FEATURE_TYPE = `${MODULE_ID}.guise`;
// #4 (v0.7.9): the module-wide GM EDIT OVERRIDE. A guise's rules-fixed fields (its three classes, its
// affinity trio, its equipment/hands — "fixed at distillation", GCR:507/:329/:124) are read-only by
// default; turning this world setting ON lets a GM edit ANY normally-fixed field, with SOFT validation
// (warn, don't block) and a dismiss-before-edit bypass. Registered in the 'setup' hook.
const EDIT_OVERRIDE_SETTING = 'editOverride';
/** True iff the module-wide GM edit override is on. Guarded so the pure helpers stay headless-safe
 *  (game.settings does not exist under `node --test`). Runtime-only signal; validation stays pure. */
function editOverrideOn() {
	try { return game?.settings?.get(MODULE_ID, EDIT_OVERRIDE_SETTING) === true; }
	catch { return false; }
}
const AFFINITY_TYPES = ['air', 'bolt', 'dark', 'earth', 'fire', 'ice', 'light', 'physical', 'poison'];
const EQUIP_SLOTS = ['mainHand', 'offHand', 'armor', 'accessory'];
const ALL_SLOTS = ['mainHand', 'offHand', 'armor', 'accessory', 'phantom', 'arcanum'];
const SKILL_BUDGET_CAP = 30; // total guise SL budget ceiling (min(charLevel, 30))
const PER_CLASS_CAP = 10; // class mastery

// ---------------------------------------------------------------------------
// INNATE BENEFIT POOL guard (Austin canon, v0.1.1 — kept). A guise may never apply the
// class innate pool (HP/MP/IP, martial proficiencies, ritual access, Projects). Stripped at
// the document layer so it never persists — even for player-authored guises.
const POOL_BLOCK = [
	/^system\.resources\.(hp|mp|ip)\b/i,
	/^system\.benefits\.martials\b/i,
	/\bmartials?\.(melee|ranged|armor|shields)\b/i,
	/^system\.benefits\.rituals\b/i,
	/\britual/i,
	/\bproject/i,
];
const isPoolKey = (key) => typeof key === 'string' && POOL_BLOCK.some((re) => re.test(key));
const isGuiseItem = (item) => item?.type === 'classFeature' && item?.system?.featureType === FEATURE_TYPE;
function filterChanges(changes) {
	const kept = [];
	const stripped = [];
	for (const c of changes ?? []) (isPoolKey(c?.key) ? stripped : kept).push(c);
	return { kept, stripped };
}
function logStripped(where, stripped) {
	if (stripped.length) console.debug(`[rippers-guise] ${where}: stripped ${stripped.length} innate-pool change(s):`, stripped.map((c) => c.key));
}

// ---------------------------------------------------------------------------
// Affinity modifier → ActiveEffect change (the automation idiom; outside the pool).
function affinityChange(type, level) {
	if (!AFFINITY_TYPES.includes(type)) return null;
	const n = Number(level);
	if (n === 1) return { key: `system.affinities.${type}`, mode: 0, value: 'upgrade', priority: null };   // Resistance
	if (n === -1) return { key: `system.affinities.${type}`, mode: 0, value: 'downgrade', priority: null };  // Vulnerability
	if (n === 2) return { key: `system.affinities.${type}.current`, mode: 4, value: '2', priority: null };   // Immunity
	if (n === 3) return { key: `system.affinities.${type}.current`, mode: 4, value: '3', priority: null };   // Absorption
	return null;
}

// ---------------------------------------------------------------------------
// MONSTROUS-FORM AFFINITIES — affinity-set REPLACEMENT, a GENERAL Guise capability (FDN-9, v0.6.0).
// Austin: "adopting monstrous forms is what Guises are for." Any guise may OPTIONALLY carry an
// affinity-SET (or a small LIBRARY of them). While such a guise is worn, its ACTIVE affinity-set
// REPLACES the wearer's entire affinity array (not merely modifies it); the originals return on
// removal. The set lives in the MASK (transferable — a second wearer inherits it) and, where a guise
// holds several forms, exactly one is active, swapped as a free once-per-turn action. This is a
// REPLACE FORK of the legacy additive path (affinityModifiers); the two never mix — a guise is
// replace-mode iff it declares an affinity-set / library or system.data.affinityMode === 'replace' (C3).
//
//   C1: replacement writes a TRUE OVERRIDE (Foundry AE mode 5) to system.affinities.<el>.current for
//     ALL NINE elements at the set's ABSOLUTE value (incl. 0=none), so a form can LOWER a native
//     affinity, not only raise it (the legacy mode-4 UPGRADE cannot).
//   C2: only .current is ever written (derived, persisted:false) — never .base — so dropping the AE
//     restores the character's real affinities untouched, with no snapshot (mirrors dismiss-restore).
//
// (History: this began as the cut Diabolist "pact" mechanic; the pact-* API is retained as thin
//  back-compat aliases at the export site. It was never released, so no live data carries pact flags —
//  the old flag KEYS are still read as a fallback purely for safety.)
const AE_OVERRIDE = 5; // CONST.ACTIVE_EFFECT_MODES.OVERRIDE
const AFFINITY_LIBRARY_FLAG = 'affinityLibrary';       // sets COLLECTED in play (GM-gated); merges with authored
const ACTIVE_AFFINITY_SET_FLAG = 'activeAffinitySetId';
const AFFINITY_SWAP_TURN_FLAG = 'affinitySwapTurn';
const LEGACY_LIBRARY_FLAG = 'pactLibrary';             // pre-release name — read-only fallback
const LEGACY_ACTIVE_FLAG = 'activePactId';             // pre-release name — read-only fallback
const AFFINITY_VALUES = new Set([-1, 0, 1, 2, 3]);     // vulnerable / none / resistant / immune / absorb

/**
 * Build the full nine-element OVERRIDE change-set that REPLACES an actor's affinity array with an
 * affinity-set. Every element is written to its absolute value; elements the set omits become 0 (none),
 * which is what wipes the character's native affinities while the mask is worn. Pure.
 * @param {{type:string, level:number}[]} setAffinities
 */
function buildReplaceChanges(setAffinities) {
	const byType = new Map();
	for (const a of setAffinities ?? []) {
		if (!AFFINITY_TYPES.includes(a?.type)) continue;
		const n = Number(a.level);
		if (AFFINITY_VALUES.has(n)) byType.set(a.type, n); // last write wins on a duplicate type
	}
	return AFFINITY_TYPES.map((t) => ({
		key: `system.affinities.${t}.current`,
		mode: AE_OVERRIDE,
		value: String(byType.get(t) ?? 0),
		priority: null,
	}));
}

/** Validate one affinity-set: {id, name?, affinities:[{type,level}]}, known types, legal values, no dup type. Pure. */
function validateAffinitySet(set) {
	if (!set || typeof set !== 'object') return { ok: false, reason: 'affinity-set must be an object' };
	if (!set.id || typeof set.id !== 'string') return { ok: false, reason: 'affinity-set needs a string id' };
	if (!Array.isArray(set.affinities)) return { ok: false, reason: 'affinity-set.affinities must be an array' };
	const seen = new Set();
	for (const a of set.affinities) {
		if (!AFFINITY_TYPES.includes(a?.type)) return { ok: false, reason: `unknown affinity type "${a?.type}"` };
		if (!AFFINITY_VALUES.has(Number(a?.level))) return { ok: false, reason: `illegal affinity level "${a?.level}"` };
		if (seen.has(a.type)) return { ok: false, reason: `duplicate affinity type "${a.type}" in one set` };
		seen.add(a.type);
	}
	return { ok: true };
}

/** Validate a whole affinity library: array, unique ids, each valid, length ≤ cap. Pure. */
function validateAffinityLibrary(library, cap = Infinity) {
	if (!Array.isArray(library)) return { ok: false, reason: 'library must be an array' };
	const ids = new Set();
	for (const s of library) {
		const v = validateAffinitySet(s);
		if (!v.ok) return v;
		if (ids.has(s.id)) return { ok: false, reason: `duplicate affinity-set id "${s.id}"` };
		ids.add(s.id);
	}
	if (Number.isFinite(cap) && library.length > cap) {
		return { ok: false, reason: `guise holds ${library.length} affinity-set(s); the cap is ${cap}` };
	}
	return { ok: true };
}

/**
 * A guise's full affinity library = its AUTHORED sets (system.data.affinitySets, declared in the
 * Guise Builder / on the sheet) UNIONed with any COLLECTED in play (flags.affinityLibrary), deduped by
 * id (authored wins). The pre-release pact flag is read as a last-resort fallback. Never throws.
 */
function getAffinityLibrary(item) {
	const authored = Array.isArray(item?.system?.data?.affinitySets) ? item.system.data.affinitySets : [];
	const collected = item?.getFlag?.(MODULE_ID, AFFINITY_LIBRARY_FLAG);
	const legacy = item?.getFlag?.(MODULE_ID, LEGACY_LIBRARY_FLAG);
	const merged = [];
	const ids = new Set();
	for (const s of [...authored, ...(Array.isArray(collected) ? collected : []), ...(Array.isArray(legacy) ? legacy : [])]) {
		if (s && typeof s.id === 'string' && !ids.has(s.id)) { ids.add(s.id); merged.push(s); }
	}
	return merged;
}
const getActiveAffinitySetId = (item) => item?.getFlag?.(MODULE_ID, ACTIVE_AFFINITY_SET_FLAG) ?? item?.getFlag?.(MODULE_ID, LEGACY_ACTIVE_FLAG) ?? null;
function getActiveAffinitySet(item) {
	const lib = getAffinityLibrary(item);
	const id = getActiveAffinitySetId(item);
	if (id) { const hit = lib.find((s) => s.id === id); if (hit) return hit; }
	return lib[0] ?? null; // a single-form guise needs no explicit active pointer
}
/** A guise is REPLACE-mode iff it declares an affinity-set/library (authored or collected) or affinityMode='replace' (C3). */
const isReplaceModeGuise = (item) => isGuiseItem(item) && (getAffinityLibrary(item).length > 0 || item.system?.data?.affinityMode === 'replace');

/** A character's SL in a named skill (case-insensitive). A guise may govern its library cap by this. 0 if absent. */
function namedSkillSL(actor, name) {
	if (!actor || !name) return 0;
	const re = new RegExp(`^${String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
	const skill = actor.items?.find?.((i) => i?.type === 'skill' && re.test(i.name ?? ''));
	return Number(skill?.system?.level?.value ?? 0) || 0;
}
/** The cap on how many affinity-sets a guise may hold: an explicit numeric cap, else a governing-skill
 *  SL if the guise names one (system.data.affinityCapSkill), else unbounded. */
function affinitySetCapOf(actor, item) {
	const explicit = item?.system?.data?.affinitySetCap;
	if (Number.isFinite(explicit) && explicit >= 0) return explicit;
	const skillName = item?.system?.data?.affinityCapSkill;
	if (skillName) return namedSkillSL(actor, skillName);
	return Infinity;
}

/** The affinity AE change-set for a guise: REPLACE (active affinity-set, all nine) or legacy MODIFY (affinityModifiers). */
function buildGuiseAffinityChanges(item) {
	if (isReplaceModeGuise(item)) {
		const set = getActiveAffinitySet(item);
		return set ? buildReplaceChanges(set.affinities) : [];
	}
	const mods = item.system?.data?.affinityModifiers ?? [];
	return mods.map((m) => affinityChange(m.type, m.level)).filter(Boolean);
}

/**
 * Rebuild the guise Item's single embedded "Guise affinities" ActiveEffect from its affinity source
 * (the active affinity-set for a monstrous-form guise, else its affinityModifiers), so the
 * transferEffects() gate applies/removes it on bind/dismiss.
 */
async function syncAffinityEffect(item) {
	if (!isGuiseItem(item)) return;
	const changes = buildGuiseAffinityChanges(item);
	const existing = item.effects.find((e) => e.getFlag(MODULE_ID, 'affinityEffect'));
	if (!changes.length) {
		if (existing) await existing.delete();
		return;
	}
	if (existing) {
		await existing.update({ changes });
	} else {
		await item.createEmbeddedDocuments('ActiveEffect', [{
			name: 'Guise affinities',
			img: item.img ?? 'icons/svg/aura.svg',
			transfer: true,
			changes,
			flags: { [MODULE_ID]: { affinityEffect: true } },
		}]);
	}
}

// ---------------------------------------------------------------------------
// BIND / DISMISS / SWAP engine.
const charLevelOf = (actor) => Number(actor?.system?.level?.value ?? actor?.system?.level ?? 1) || 1;
const budgetOf = (actor) => (actor ? Math.min(charLevelOf(actor), SKILL_BUDGET_CAP) : SKILL_BUDGET_CAP);

// N1 (god, Stage A): bind/dismiss/setActive must accept an Item, but a sheet action may hand us
// an id string. Resolve leniently so a string can never write flags.owned['undefined'] and no-op.
function resolveItem(actor, ref) {
	if (ref && typeof ref === 'object') return ref;
	if (typeof ref === 'string' && actor?.items?.get) return actor.items.get(ref) ?? null;
	return null;
}

// ---------------------------------------------------------------------------
// DORMANCY (Stage B, D-DORM(i)). While a guise is bound, exactly one 30-level skill set is
// live: the guise's materialised skills. The character's OWN innate skill Items are suppressed
// by zeroing level.value (reversible, keeps the item + its history); their real SLs are snapshot
// into flags.rippers-guise.dormant so dismiss restores them untouched. Guise-created skills carry
// flags.rippers-guise.origin and are never touched here (they ARE the live set).
const DORMANT_FLAG = 'dormant';
const isInnateSkill = (i) => i?.type === 'skill' && !i?.getFlag?.(MODULE_ID, 'origin');

async function suppressInnateSkills(actor) {
	const innate = actor.items.filter(isInnateSkill);
	const snapshot = {};
	const updates = [];
	for (const skill of innate) {
		const sl = Number(skill.system?.level?.value ?? 0) || 0;
		snapshot[skill.id] = sl;
		if (sl !== 0) updates.push({ _id: skill.id, 'system.level.value': 0 });
	}
	await actor.setFlag(MODULE_ID, DORMANT_FLAG, snapshot);
	if (updates.length) await actor.updateEmbeddedDocuments('Item', updates);
	return updates.length;
}

async function restoreInnateSkills(actor) {
	const snapshot = actor.getFlag(MODULE_ID, DORMANT_FLAG) ?? {};
	const updates = [];
	for (const [id, sl] of Object.entries(snapshot)) {
		const skill = actor.items.get(id);
		if (skill && Number(skill.system?.level?.value ?? 0) !== Number(sl)) {
			updates.push({ _id: id, 'system.level.value': Number(sl) });
		}
	}
	if (updates.length) await actor.updateEmbeddedDocuments('Item', updates);
	await actor.unsetFlag(MODULE_ID, DORMANT_FLAG);
	return updates.length;
}

/** Materialise the guise's allocated skills as owned skill Items, honouring the three caps. */
async function materialiseSkills(actor, item) {
	const data = item.system?.data ?? {};
	const budget = Math.min(charLevelOf(actor), SKILL_BUDGET_CAP);
	let spent = 0;
	const perClass = {};
	const toCreate = [];
	for (const cls of data.classes ?? []) {
		const key = cls.classUuid || '_';
		perClass[key] = perClass[key] ?? 0;
		for (const s of cls.skills ?? []) {
			const src = await fromUuid(s.skillUuid);
			if (!src) { console.warn(`[rippers-guise] skill ref not found: ${s.skillUuid}`); continue; }
			let sl = Math.max(0, Math.floor(Number(s.sl ?? 0)));
			const maxSl = src.system?.level?.max ?? 10;
			sl = Math.min(sl, maxSl, PER_CLASS_CAP - perClass[key], budget - spent); // three caps
			if (sl <= 0) continue;
			perClass[key] += sl; spent += sl;
			const obj = src.toObject();
			delete obj._id;
			obj.system = obj.system ?? {};
			obj.system.level = { ...(obj.system.level ?? {}), value: sl };
			obj.flags = obj.flags ?? {};
			obj.flags[MODULE_ID] = { origin: item.id, kind: 'skill' };
			toCreate.push(obj);
		}
	}
	const created = toCreate.length ? await actor.createEmbeddedDocuments('Item', toCreate) : [];
	return created.map((d) => d.id);
}

/** v0.7.30 SPELL AUTO-MATERIALIZATION: materialise a worn guise's PICKED spells as guise-origin owned
 *  'spell' Items — mirrors materialiseSkills. The player picks spells at skill acquisition (guise editor);
 *  the picked UUIDs live on each spellcasting skill's `spellUuids`. On bind they become castable actor
 *  spell Items (the v0.7.16 Spells tab casts them via native item.roll()); on dismiss _dismissCore strips
 *  them with the rest of the guise-origin owned set. QUIRK-granted spells are NOT materialised here — they
 *  are character-level (attached via the Quirk, never flagged guise-origin) and persist across swaps.
 *  Defensive cap: never more picked spells than the skill's allocated SL (the picker enforces it too). */
async function materialiseSpells(actor, item) {
	const data = item.system?.data ?? {};
	const toCreate = [];
	const seen = new Set();
	for (const cls of data.classes ?? []) {
		for (const s of cls.skills ?? []) {
			const sl = Math.max(0, Math.floor(Number(s.sl ?? 0)));
			for (const spellUuid of (s.spellUuids ?? []).slice(0, sl)) {
				if (!spellUuid || seen.has(spellUuid)) continue; seen.add(spellUuid);
				const src = await fromUuid(spellUuid);
				if (!src) { console.warn(`[rippers-guise] spell ref not found: ${spellUuid}`); continue; }
				const obj = src.toObject();
				delete obj._id;
				obj.flags = obj.flags ?? {};
				obj.flags[MODULE_ID] = { origin: item.id, kind: 'spell' };
				toCreate.push(obj);
			}
		}
	}
	const created = toCreate.length ? await actor.createEmbeddedDocuments('Item', toCreate) : [];
	return created.map((d) => d.id);
}

/** #3 (v0.7.9): materialise a worn guise's attached ("signature") Heroic as an owned Item, flagged
 *  guise-origin. It carries its own ActiveEffect(s), so creating it on bind rides those onto the
 *  actor; _dismissCore removes it on dismiss (it is neither a guise nor the Hunter Weapon). Distinct
 *  from the character's own heroic slots — never seated via assignHeroicSlot. Returns created ids. */
async function materialiseAttachedHeroic(actor, item) {
	const uuid = item.system?.data?.attachedHeroicUuid;
	if (!uuid) return [];
	const src = await fromUuid(uuid);
	if (!src) { console.warn(`[rippers-guise] attached heroic ref not found: ${uuid}`); return []; }
	if (src.type !== 'heroic') { console.warn(`[rippers-guise] attached heroic is not a Heroic Skill: ${uuid}`); return []; }
	const obj = src.toObject();
	delete obj._id;
	obj.flags = obj.flags ?? {};
	obj.flags[MODULE_ID] = { origin: item.id, kind: 'heroic' };
	const created = await actor.createEmbeddedDocuments('Item', [obj]);
	return created.map((d) => d.id);
}

/** #5 (v0.7.9): materialise the guise's attached effects/abilities (e.g. Greater Akromorphosis) as
 *  guise-origin owned Items. They carry their own ActiveEffect(s), so creating them on bind rides those
 *  onto the actor; _dismissCore removes them on dismiss — the "effects travel with the guise, on while
 *  worn, off while stashed" behaviour, on the same machinery as skills / equipment / the signature
 *  Heroic. No type gate: any effect-bearing Item may ride; the GM authors which effects belong on a
 *  mask (body/standing per the GUISES sort test). Returns created ids. */
async function materialiseAttachedEffects(actor, item) {
	const list = item.system?.data?.attachedEffects ?? [];
	const toCreate = [];
	for (const e of list) {
		if (!e?.itemUuid) continue;
		const src = await fromUuid(e.itemUuid);
		if (!src) { console.warn(`[rippers-guise] attached effect ref not found: ${e.itemUuid}`); continue; }
		const obj = src.toObject();
		delete obj._id;
		obj.flags = obj.flags ?? {};
		obj.flags[MODULE_ID] = { origin: item.id, kind: 'effect' };
		toCreate.push(obj);
	}
	const created = toCreate.length ? await actor.createEmbeddedDocuments('Item', toCreate) : [];
	return created.map((d) => d.id);
}

/** Materialise + equip the guise's equipment; returns {ids, equipUpdate}. Handles two-hand (D3b). */
async function materialiseEquipment(actor, item) {
	const data = item.system?.data ?? {};
	const ids = [];
	const equipUpdate = {};
	for (const eq of data.equipment ?? []) {
		const src = await fromUuid(eq.itemUuid);
		if (!src) { console.warn(`[rippers-guise] equipment ref not found: ${eq.itemUuid}`); continue; }
		const obj = src.toObject();
		delete obj._id;
		obj.flags = obj.flags ?? {};
		obj.flags[MODULE_ID] = { origin: item.id, kind: 'equipment' };
		const [created] = await actor.createEmbeddedDocuments('Item', [obj]);
		if (!created) continue;
		ids.push(created.id);
		const slot = EQUIP_SLOTS.includes(eq.slot) ? eq.slot : 'mainHand';
		equipUpdate[`system.equipped.${slot}`] = created.id;
		// D3b: a two-handed weapon occupies mainHand + offHand; the mask's loadout wins.
		const twoHanded = /two/i.test(String(created.system?.hands?.value ?? created.system?.hands ?? ''));
		if (twoHanded && slot === 'mainHand') {
			if (equipUpdate['system.equipped.offHand'] && equipUpdate['system.equipped.offHand'] !== created.id) {
				console.warn(`[rippers-guise] two-handed weapon "${created.name}" displaces the guise's off-hand item.`);
			}
			equipUpdate['system.equipped.offHand'] = created.id;
		}
	}
	return { ids, equipUpdate };
}

// ── v0.7.33 / v0.7.34: editable EQUIPMENT pickers (guise editor) ───────────────────────────────────
// A worn guise's gear lives as equipment[] entries keyed by slot; materialiseEquipment already creates +
// equips them on bind and _dismissCore strips them on dismiss (the CORRECT, unchanged mechanic). The gap
// was that the CHOICES were not low-friction to edit. These helpers back a dropdown PER SLOT in the
// editor: collectEquipItems() enumerates every equip-eligible Item (world + Item compendia — source-
// agnostic, no pack name invented), and setDraftEquip atomically REPLACES a slot's single entry (no dup —
// the v0.7.23 discipline); '' = empty (none). v0.7.34 generalised armor → all four slots (Austin).
// Slot → allowed item types. offHand accepts a shield or an off-hand weapon; the hands accept weapons.
const EQUIP_SLOT_TYPES = { mainHand: ['weapon', 'customWeapon'], offHand: ['weapon', 'customWeapon', 'shield'], armor: ['armor'], accessory: ['accessory'] };
const EQUIP_ALL_TYPES = new Set(Object.values(EQUIP_SLOT_TYPES).flat());
async function collectEquipItems() {
	const out = []; const seen = new Set();
	const push = (uuid, name, type) => { if (uuid && type && !seen.has(uuid) && EQUIP_ALL_TYPES.has(type)) { seen.add(uuid); out.push({ uuid, name: name || `(${type})`, type }); } };
	try { for (const it of (globalThis.game?.items ?? [])) push(it?.uuid, it?.name, it?.type); } catch { /* no world items */ }
	try {
		for (const pack of (globalThis.game?.packs ?? [])) {
			if (pack?.documentName !== 'Item') continue;
			let idx = [];
			try { idx = [...(await pack.getIndex({ fields: ['type'] }))]; } catch { continue; }
			for (const e of idx) push(`Compendium.${pack.collection}.Item.${e._id}`, e.name, e.type);
		}
	} catch { /* no packs */ }
	return out.sort((a, b) => a.name.localeCompare(b.name));
}
/** Back-compat: armor-only enumeration (kept for existing callers/tests). */
async function collectArmorItems() { return (await collectEquipItems()).filter((i) => i.type === 'armor'); }
/** PURE: set/replace/clear one equipment SLOT's single entry. Removes ANY existing entry for that slot
 *  first (atomic replace, never doubles), then appends the new one; '' uuid = empty (none). */
function setDraftEquip(draft, slot, uuid, name = '') {
	const s = EQUIP_SLOTS.includes(slot) ? slot : 'mainHand';
	const rest = (draft.equipment ?? []).filter((e) => e?.slot !== s);
	draft.equipment = uuid ? [...rest, { itemUuid: uuid, slot: s, name }] : rest;
	return draft.equipment;
}
/** Back-compat wrapper: the armor slot. */
function setDraftArmor(draft, uuid, name = '') { return setDraftEquip(draft, 'armor', uuid, name); }

// FDN-7.1 re-entrancy lock. A stacked/duplicate click (or two rapid macro calls) must NOT run
// two binds for one actor — that would materialise a second skill set and overwrite the `owned`
// tracking, leaving orphans. Every PUBLIC entry point takes this lock synchronously (before any
// await) and drops if it's already held; the internal *Core functions do the work unlocked, so
// bind's own swap-dismiss can nest without deadlocking.
const _guiseBusy = new Set();

async function _bindCore(actor, item) {
	// Dismiss any currently-active (different) guise first — one guise at a time.
	const prev = actor.getFlag(MODULE_ID, FLAG);
	if (prev && prev !== item.id) {
		const prevItem = actor.items.get(prev);
		if (prevItem) await _dismissCore(actor, prevItem, { silent: true });
	}
	const preBindEquip = foundry.utils.deepClone(actor.system?.equipped ?? {});
	// Materialise the mask's live skill set FIRST (flagged guise-origin) …
	const skillIds = await materialiseSkills(actor, item);
	const { ids: equipIds, equipUpdate } = await materialiseEquipment(actor, item);
	// #3 (v0.7.9): the worn guise's signature Heroic rides on while worn (its effects apply);
	// removed on dismiss with the rest of the guise-origin owned set.
	const heroicIds = await materialiseAttachedHeroic(actor, item);
	// #5 (v0.7.9): effects/abilities that travel with the guise ride on the same way.
	const effectIds = await materialiseAttachedEffects(actor, item);
	// v0.7.30: the guise's PICKED spells materialise as castable actor spell Items (stripped on dismiss).
	const spellIds = await materialiseSpells(actor, item);
	const owned = [...skillIds, ...equipIds, ...heroicIds, ...effectIds, ...spellIds];
	await actor.update({
		[`flags.${MODULE_ID}.${FLAG}`]: item.id,
		[`flags.${MODULE_ID}.preBindEquip`]: preBindEquip,
		[`flags.${MODULE_ID}.owned.${item.id}`]: owned,
		...equipUpdate,
	});
	// … THEN suppress the character's own innate skills, so exactly one 30-level set is live (Stage B).
	const dormant = await suppressInnateSkills(actor);
	// … and sleep the creation heroic while masked (8c); 40/50/earned stay live.
	await suppressCreationHeroic(actor);
	// Affinities: the guise's embedded "Guise affinities" effect now transfers (transferEffects()=true).
	// H2 portrait: cosmetic — it must NEVER block or abort a swap. Fully decoupled: any failure here
	// (a bad face path, a rejected update, a FilePicker+ quirk) is swallowed so the bind always completes.
	try { await applyGuiseFace(actor, item); } catch (err) { console.warn('[rippers-guise] applyGuiseFace failed (swap unaffected):', err); }
	console.debug(`[rippers-guise] bound "${item.name}": ${skillIds.length} guise skill(s), ${equipIds.length} equipment; ${dormant} innate skill(s) dormant.`);
}

async function _dismissCore(actor, item, { silent = false } = {}) {
	const owned = actor.getFlag(MODULE_ID, 'owned')?.[item.id] ?? [];
	const preBindEquip = actor.getFlag(MODULE_ID, 'preBindEquip') ?? {};
	// ROS-29 guard: only guise-origin materialised items are removed on dismiss — NEVER the character's
	// Hunter Weapon (a plain owned weapon) or an Innate-Guise item, even if one were mis-tracked in
	// `owned`. Both must survive every swap. (Belt-and-suspenders: today neither is ever added to owned.)
	const existing = owned.filter((id) => {
		const it = actor.items.get(id);
		return it && !isHunterWeapon(it) && !isGuiseItem(it);
	});
	if (existing.length) await actor.deleteEmbeddedDocuments('Item', existing);
	// Wake the innate skill set back up (Stage B) + the creation heroic (8c) before clearing state.
	await restoreInnateSkills(actor);
	await restoreCreationHeroic(actor);
	const equipRestore = {};
	for (const slot of ALL_SLOTS) equipRestore[`system.equipped.${slot}`] = preBindEquip[slot] ?? null;
	await actor.update({
		[`flags.${MODULE_ID}.${FLAG}`]: null,
		[`flags.${MODULE_ID}.owned.-=${item.id}`]: null,
		...equipRestore,
	});
	// H2: on a true unmask restore the NORMAL face; the silent swap-dismiss leaves it to the new bind.
	if (!silent) { try { await restoreBaseFace(actor); } catch (err) { console.warn('[rippers-guise] restoreBaseFace failed (unmask unaffected):', err); } console.debug(`[rippers-guise] dismissed "${item.name}"; innate skills restored.`); }
}

async function bindGuise(actor, ref) {
	const item = resolveItem(actor, ref);
	if (!actor || !item) { console.warn('[rippers-guise] bindGuise: no actor/item (was an id string unresolvable?).'); return; }
	if (_guiseBusy.has(actor.id)) { console.debug('[rippers-guise] bind ignored — a guise op is already in flight for this actor.'); return; }
	_guiseBusy.add(actor.id);
	try {
		const r = await _bindCore(actor, item);
		await accountGuiseSwap(actor, item.id); // H3: cost an Action, or refund it via The Turn.
		return r;
	} finally { _guiseBusy.delete(actor.id); }
}

/** Bind a guise WITHOUT the H3 swap accounting — used for the default-guise-on-open (P4): the basic
 *  guise becoming active on open is not a turn action, so no Equipment-Action cost / Turn-refund. Same
 *  materialisation as bindGuise (skills/equipment/face), minus accountGuiseSwap. */
async function bindGuiseNoCost(actor, ref) {
	const item = resolveItem(actor, ref);
	if (!actor || !item) return;
	if (_guiseBusy.has(actor.id)) return;
	_guiseBusy.add(actor.id);
	try { return await _bindCore(actor, item); } finally { _guiseBusy.delete(actor.id); }
}
/** PURE-ish: the id of the character's BASIC guise (P4) — the Innate guise if present (their normal-shape
 *  starter self), else the first guise. null when they own no guise (stays Unmasked). */
function defaultActiveGuiseId(actor) {
	const guises = actor?.items?.filter ? actor.items.filter(isGuiseItem) : [];
	if (!guises.length) return null;
	const innate = guises.find((g) => !!g.getFlag?.(MODULE_ID, 'isInnate') || g.system?.data?.mode === 'innate');
	return (innate ?? guises[0]).id;
}

async function dismissGuise(actor, ref, opts = {}) {
	const item = resolveItem(actor, ref);
	if (!actor || !item) { console.warn('[rippers-guise] dismissGuise: no actor/item.'); return; }
	if (_guiseBusy.has(actor.id)) { console.debug('[rippers-guise] dismiss ignored — a guise op is already in flight for this actor.'); return; }
	_guiseBusy.add(actor.id);
	try { return await _dismissCore(actor, item, opts); } finally { _guiseBusy.delete(actor.id); }
}

// ---------------------------------------------------------------------------
// Public helpers (macros / other modules).
function getActiveGuise(actor) { return actor?.getFlag(MODULE_ID, FLAG) ?? null; }
async function setActiveGuise(actor, ref) {
	const item = resolveItem(actor, ref);
	if (!actor || !item) return;
	if (_guiseBusy.has(actor.id)) { console.debug('[rippers-guise] toggle ignored — a guise op is already in flight for this actor.'); return; }
	_guiseBusy.add(actor.id);
	try {
		if (getActiveGuise(actor) === item.id) return await _dismissCore(actor, item);
		const r = await _bindCore(actor, item);
		await accountGuiseSwap(actor, item.id); // H3: cost an Action, or refund it via The Turn.
		return r;
	} finally { _guiseBusy.delete(actor.id); }
}
async function clearActiveGuise(actor) {
	const id = getActiveGuise(actor);
	const item = id && actor.items.get(id);
	if (item) return dismissGuise(actor, item);
}

// ---------------------------------------------------------------------------
// H3 — THE TURN: guise-swap action economy (Austin 4 Sep 2026, DECISIONS-RESOLVED H3).
// A guise swap costs an ACTION — BUT "The Turn" (one EXTRA action per scene, not a second turn)
// REFUNDS that action the FIRST time per scene a character switches TO a guise they have NOT USED that
// scene. base/innate ARE selectable guises, so binding ANY guise runs through here; dismissing
// (unmasking to the bare native character) is not a switch-to-a-guise and is not accounted. Per-scene
// state lives on the ACTOR as two flags, cleared on a scene (canvasReady) or combat (combatStart/
// deleteCombat) boundary — The Turn is a once-per-scene resource. We do NOT deduct from a hard action
// pool (FU tracks the action economy on the turn tracker, narratively, not as a spent counter); we
// decide the cost and post a thin advisory (layout/UI is Austin's). On clear we SEED the used-set with
// the currently-worn guise: the guise you wear as the scene opens is already "in use", so switching
// back to it later is not a fresh guise and earns no refund.
const USED_GUISES_FLAG = 'usedGuisesThisScene';    // string[] of guise item ids used this scene
const TURN_REFUND_FLAG = 'turnRefundUsedThisScene'; // bool: has The Turn's refund fired this scene

/** PURE. The action cost of swapping TO targetId given scene state. The refund fires only the first
 *  time per scene (turnRefundUsed=false) AND only for a guise not yet used this scene. */
function guiseSwapActionDecision(usedGuises, turnRefundUsed, targetId) {
	const used = Array.isArray(usedGuises) ? usedGuises : [];
	const fresh = !!targetId && !used.includes(targetId);
	if (fresh && !turnRefundUsed) return { cost: 'free', refunded: true, reason: 'the-turn' };
	return { cost: 'action', refunded: false, reason: fresh ? 'turn-spent' : 'already-used' };
}

/** PURE. The used-guise set after swapping to targetId (dedup, order-preserving). */
function markGuiseUsed(usedGuises, targetId) {
	const used = Array.isArray(usedGuises) ? usedGuises.slice() : [];
	if (targetId && !used.includes(targetId)) used.push(targetId);
	return used;
}

/** Is the actor a combatant in the active combat? (Robust for GM + player; false when no combat.) */
function actorInActiveCombat(actor) {
	const c = globalThis.game?.combat;
	if (!c || !actor?.id) return false;
	try { return !!c.combatants?.some?.((cb) => cb?.actorId === actor.id); } catch { return false; }
}

/** Read the actor's per-scene swap state. */
function guiseSceneState(actor) {
	return {
		used: actor?.getFlag?.(MODULE_ID, USED_GUISES_FLAG) ?? [],
		turnRefundUsed: !!actor?.getFlag?.(MODULE_ID, TURN_REFUND_FLAG),
	};
}

/** Thin advisory (the table-log line only; the sheet's own hint is Austin's). */
function announceGuiseSwapCost(actor, targetId, decision) {
	const name = actor?.items?.get?.(targetId)?.name ?? 'the guise';
	const msg = decision.refunded
		? (game.i18n?.format?.('RIPPERS.Turn.Refunded', { name }) ?? `The Turn: swapping to "${name}" is FREE — the action is refunded (once per scene).`)
		: (game.i18n?.format?.('RIPPERS.Turn.CostsAction', { name }) ?? `Swapping to "${name}" costs an Action.`);
	ui.notifications?.info?.(msg);
	console.debug(`[rippers-guise] ${msg}`);
}

/** Account a swap TO targetId: decide the cost, persist the new scene state, post the advisory.
 *  Called AFTER a successful bind. Returns the decision (for callers/tests). */
async function accountGuiseSwap(actor, targetId) {
	if (!actor || !targetId) return null;
	// H3 refinement (Austin 4 Sep): a swap costs an Equipment Action ONLY in a combat scene. Outside an
	// active combat there is no action economy, so the swap is FREE — no advisory, no scene accounting.
	if (!actorInActiveCombat(actor)) return { cost: 'free', refunded: false, reason: 'no-combat' };
	const { used, turnRefundUsed } = guiseSceneState(actor);
	const decision = guiseSwapActionDecision(used, turnRefundUsed, targetId);
	const update = { [`flags.${MODULE_ID}.${USED_GUISES_FLAG}`]: markGuiseUsed(used, targetId) };
	if (decision.refunded) update[`flags.${MODULE_ID}.${TURN_REFUND_FLAG}`] = true;
	try { await actor.update(update); } catch (err) { console.warn('[rippers-guise] guise-swap accounting failed:', err); }
	announceGuiseSwapCost(actor, targetId, decision);
	return decision;
}

/** Clear one actor's per-scene swap state on a scene/combat boundary; SEED the used-set with the worn
 *  guise so switching back to it is not treated as fresh. GM-authoritative writer. */
async function clearGuiseSceneState(actor) {
	if (!actor?.update) return;
	const worn = getActiveGuise(actor);
	try {
		await actor.update({
			[`flags.${MODULE_ID}.${USED_GUISES_FLAG}`]: worn ? [worn] : [],
			[`flags.${MODULE_ID}.${TURN_REFUND_FLAG}`]: false,
		});
	} catch (err) { console.warn('[rippers-guise] clear guise scene-state failed:', err); }
}

/** Clear every guise-bearing actor's per-scene swap state — the GM runs it on the boundary hooks
 *  (single writer, to avoid permission errors and double-writes). */
async function clearAllGuiseSceneState() {
	if (!game.user?.isGM) return;
	const actors = game.actors?.filter?.((a) => a.type === 'character' || a.items?.some?.(isGuiseItem)) ?? [];
	for (const a of actors) await clearGuiseSceneState(a);
}

// ---------------------------------------------------------------------------
// UNIT 3 — PARTY VAULT (Austin 4 Sep 2026, DECISIONS-RESOLVED V1–V5 + X4; Joiner spec 800d8243).
// An EMBEDDED sheet TAB (V3, not a separate Application) showing the party's guises as a "field" of
// slots per member plus a shared "cabinet". Rulings:
//  • V1 — a member's field limit = party size + 2, COMPUTED + DISPLAYED, never enforced (no block).
//  • V2 — party size comes from a MODULE SETTING (world-scoped Number).
//  • V4 — the cabinet of owned-but-unslotted guises IS the module's compendium pack (packs/guises).
//  • V5 — an unfilled field slot renders as a dashed outline only (no "Draw" CTA).
//  • X4 — cross-owner hand-off is a GM drag-and-drop broker (the GM has write to both actors, so the
//    existing handOffDecision/sheetHandOffGuise clean path already serves it; a player dropping onto
//    another owner's field is still refused 'needs-gm-socket'). Wired to the tab in 3b.
const PARTY_SIZE_SETTING = 'partySize';
// V4 cabinet store. The module-shipped pack (rippers-guise.guises) is LOCKED read-only distributed
// content — you cannot create documents in it at runtime, and on hosted Forge the module dir is
// read-only (a module update would clobber writes anyway). So the WRITABLE cabinet is a WORLD-owned
// compendium the world creates + owns. The shipped pack is still read as a read-only guise LIBRARY.
const CABINET_PACK = `${MODULE_ID}.guises`;        // shipped, read-only (library)
const CABINET_WORLD_NAME = 'rippers-cabinet';
const CABINET_WORLD_PACK = `world.${CABINET_WORLD_NAME}`;  // writable, world-owned (stashes)

/** The world cabinet CompendiumCollection, creating it on first use (GM only). Null when absent and the
 *  current user can't create it (a player before any GM has opened the vault). Never throws. */
async function ensureCabinetPack() {
	const packs = globalThis.game?.packs;
	let pack = packs?.get?.(CABINET_WORLD_PACK);
	if (pack) return pack;
	const CC = globalThis.CompendiumCollection ?? foundry?.documents?.collections?.CompendiumCollection;
	if (!globalThis.game?.user?.isGM || !CC?.createCompendium) return null;
	try { pack = await CC.createCompendium({ type: 'Item', label: 'Rippers Cabinet', name: CABINET_WORLD_NAME }); }
	catch (err) { console.warn('[rippers-guise] could not create the world cabinet pack:', err); }
	return packs?.get?.(CABINET_WORLD_PACK) ?? pack ?? null;
}

/** The configured party size (world setting), clamped to a sane floor. */
function partySize() {
	const n = Number(globalThis.game?.settings?.get?.(MODULE_ID, PARTY_SIZE_SETTING));
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
}
/** PURE (V1). A member's field limit = party size + 2. */
const guiseFieldLimit = (size) => Math.max(1, (Number(size) || 0) + 2);

/** PURE (V1/V5). Field slots for a member: one filled slot per guise, then dashed empties padding up
 *  to the limit. Never truncates — over-limit fields keep every guise (limit is a guideline, not a
 *  cap) and set overLimit. Returns { slots:[{filled,guise?}], count, limit, overLimit, empties }. */
function fieldSlots(guises, limit) {
	const list = Array.isArray(guises) ? guises : [];
	const lim = Math.max(1, Number(limit) || 1); // limit = the already-computed field limit (partySize+2)
	const slots = list.map((g) => ({ filled: true, guise: g }));
	const empties = Math.max(0, lim - list.length);
	for (let i = 0; i < empties; i++) slots.push({ filled: false }); // V5 dashed placeholders
	return { slots, count: list.length, limit: lim, overLimit: list.length > lim, empties };
}

/** The party actors for the vault roster: player-owned characters for a GM (they broker every field),
 *  else the player's own characters + self. No FU "party" document is relied on — flagged heuristic. */
function partyActors(selfActor) {
	const all = globalThis.game?.actors?.filter?.((a) => a.type === 'character') ?? [];
	const isGM = !!globalThis.game?.user?.isGM;
	const members = all.filter((a) => isGM ? a.hasPlayerOwner : (a.isOwner || a.id === selfActor?.id));
	if (selfActor && !members.some((a) => a.id === selfActor.id)) members.unshift(selfActor);
	return members;
}

/** A compact guise card for the vault field/cabinet (lent layer carried per X1 — same shape as the
 *  Form-tab guise row so one rule renders everywhere). */
function vaultGuiseCard(actor, g) {
	const d = g.system?.data ?? {};
	const innate = !!g.getFlag?.(MODULE_ID, 'isInnate') || d.mode === 'innate';
	const v = guiseVitals(g);
	return {
		id: g.id, uuid: g.uuid, name: g.name ?? '', img: g.img, role: d.role ?? '',
		innate, tradable: !innate, worn: g.id === getActiveGuise(actor),
		lent: { hp: v.hp, mp: v.mp, ip: v.ip },
	};
}

/** Read the cabinet compendium index → entries the tab can list/drag. { packId, label, entries }. */
async function readPackEntries(packId, pack) {
	if (!pack) return [];
	try {
		const index = Array.from(await pack.getIndex());
		return index.map((e) => ({ id: e._id, uuid: `Compendium.${packId}.${e._id}`, name: e.name ?? '', img: e.img }));
	} catch (err) { console.warn(`[rippers-guise] cabinet index unavailable for ${packId}:`, err); return []; }
}
async function buildCabinetEntries() {
	const packs = globalThis.game?.packs;
	const worldPack = packs?.get?.(CABINET_WORLD_PACK);          // writable stashes
	const shippedPack = packs?.get?.(CABINET_PACK);              // read-only library
	const worldEntries = await readPackEntries(CABINET_WORLD_PACK, worldPack);
	const shippedEntries = await readPackEntries(CABINET_PACK, shippedPack);
	const entries = [...worldEntries, ...shippedEntries];
	// "missing" only when there is no store to read AND none to stash into yet (fresh world, no GM open).
	const missing = !worldPack && !shippedPack;
	return { packId: CABINET_WORLD_PACK, label: 'Cabinet', entries, missing };
}

/** Build the Party Vault embedded-tab VM (V1–V5). Async — reads the cabinet compendium index. */
async function buildVaultVM(selfActor) {
	const size = partySize();
	const limit = guiseFieldLimit(size);
	const isGM = !!globalThis.game?.user?.isGM;
	const members = partyActors(selfActor).map((a) => {
		const cards = (a.items?.filter?.(isGuiseItem) ?? []).map((g) => vaultGuiseCard(a, g));
		const field = fieldSlots(cards, limit);
		return {
			actorId: a.id, name: a.name ?? '', img: a.img,
			isSelf: a.id === selfActor?.id, canWrite: !!(isGM || a.isOwner),
			worn: cards.find((c) => c.worn)?.name ?? '',
			...field, // slots, count, limit, overLimit, empties
		};
	});
	const cabinet = await buildCabinetEntries();
	return { partySize: size, fieldLimit: limit, isGM, members, cabinet };
}

/** X4 — hand a guise from one party member to another (the vault drop handler calls this). Reuses the
 *  clean hand-off path; cross-owner requires GM write, refused 'needs-gm-socket' otherwise. */
async function vaultHandOff(sourceActor, guiseId, recipientActor) {
	return sheetHandOffGuise(sourceActor, guiseId, recipientActor);
}

/** V4 — stash a member's TRADABLE guise into the cabinet compendium (unwear first; innate refused). */
async function vaultStashToCabinet(actor, guiseId) {
	const item = actor?.items?.get?.(guiseId);
	if (!item || !isGuiseItem(item)) { ui.notifications?.warn('That is not a guise.'); return { ok: false, reason: 'no-guise' }; }
	const innate = !!item.getFlag?.(MODULE_ID, 'isInnate') || item.system?.data?.mode === 'innate';
	if (innate) { ui.notifications?.warn('The innate guise cannot be stashed.'); return { ok: false, reason: 'innate-untradable' }; }
	if (!(globalThis.game?.user?.isGM || actor.isOwner)) { ui.notifications?.warn('You cannot write that character.'); return { ok: false, reason: 'no-write' }; }
	// Writable target: the WORLD cabinet pack (never the locked module pack). Create on first use (GM),
	// unlock if needed, then write. A player before any GM has opened the vault gets a clear message.
	const pack = await ensureCabinetPack();
	if (!pack) { ui.notifications?.warn('The cabinet is not set up yet — ask your GM to open the Party Vault once.'); return { ok: false, reason: 'no-cabinet' }; }
	if (pack.locked && typeof pack.configure === 'function') { try { await pack.configure({ locked: false }); } catch (err) { console.warn('[rippers-guise] could not unlock the cabinet:', err); } }
	if (getActiveGuise(actor) === guiseId) await dismissGuise(actor, guiseId); // unwear first (bind resets)
	const obj = item.toObject(); delete obj._id;                              // heroic ref + lent layer + satchel ride in system.data
	try { await getDocumentClass('Item').create(obj, { pack: pack.collection ?? CABINET_WORLD_PACK }); }
	catch (err) { console.warn('[rippers-guise] stash-to-cabinet failed:', err); ui.notifications?.warn('Could not stash to the cabinet.'); return { ok: false, reason: 'pack-write-failed' }; }
	await item.delete();
	ui.notifications?.info(`Stashed "${item.name}" to the cabinet.`);
	return { ok: true, reason: 'ok' };
}

/** V4 — restore a guise FROM the cabinet onto a member. This is an atomic MOVE for a WORLD-cabinet stash
 *  (create on the actor, then DELETE the cabinet source — the mirror of vaultStashToCabinet), so a
 *  stash→restore cycle never duplicates. The SHIPPED library pack (read-only template guises) is instead
 *  COPIED — it is a library, its entries are not consumed. To avoid orphan-duplication the move is
 *  guarded: the source is deleted only after the actor create succeeds, and if the delete fails (e.g. a
 *  non-GM lacks compendium-delete rights on the world pack) the just-created actor copy is rolled back and
 *  the restore is refused cleanly — the guise is never lost and never doubled. */
async function vaultSlotFromCabinet(actor, uuid) {
	if (!(globalThis.game?.user?.isGM || actor?.isOwner)) { ui.notifications?.warn('You cannot write that character.'); return { ok: false, reason: 'no-write' }; }
	const doc = await safeFromUuid(uuid);
	if (!doc || !isGuiseItem(doc)) { ui.notifications?.warn('That cabinet entry is not a guise.'); return { ok: false, reason: 'no-guise' }; }
	const obj = doc.toObject(); delete obj._id;
	let created;
	try { created = await actor.createEmbeddedDocuments('Item', [obj]); }
	catch (err) { console.warn('[rippers-guise] restore-from-cabinet: actor create failed:', err); ui.notifications?.warn('Could not slot the guise onto the character.'); return { ok: false, reason: 'actor-create-failed' }; }
	const newId = created?.[0]?.id ?? created?.[0]?._id;
	if (!newId) { ui.notifications?.warn('Could not slot the guise onto the character.'); return { ok: false, reason: 'actor-create-failed' }; }
	// MOVE (world cabinet) vs COPY (shipped read-only library) — decided by the source pack.
	if (doc.pack === CABINET_WORLD_PACK) {
		const pack = globalThis.game?.packs?.get?.(CABINET_WORLD_PACK);
		if (pack?.locked && typeof pack.configure === 'function') { try { await pack.configure({ locked: false }); } catch (err) { console.warn('[rippers-guise] could not unlock the cabinet for restore:', err); } }
		try { await doc.delete(); }
		catch (err) {
			// Delete failed (typically a non-GM without world-compendium delete rights). Roll back the actor
			// copy so we never leave a duplicate, and route to the GM.
			console.warn('[rippers-guise] restore delete failed — rolling back actor copy to avoid duplication:', err);
			try { await actor.deleteEmbeddedDocuments('Item', [newId]); } catch (err2) { console.warn('[rippers-guise] rollback of actor copy failed:', err2); }
			ui.notifications?.warn('Restore needs a GM — the cabinet is world-owned. Ask your GM to restore this guise.');
			return { ok: false, reason: 'needs-gm-delete' };
		}
		ui.notifications?.info(`Restored "${doc.name}" from the cabinet.`);
		return { ok: true, reason: 'moved' };
	}
	// Shipped library template: leave it in place (it is not consumed).
	ui.notifications?.info(`Slotted "${doc.name}" from the cabinet library.`);
	return { ok: true, reason: 'copied' };
}

/** getDocumentClass shim (v13 global) — resolves the Item document class for a compendium write. */
function getDocumentClass(name) {
	return globalThis.getDocumentClass?.(name)
		?? globalThis.foundry?.documents?.[`Base${name}`]
		?? globalThis.CONFIG?.[name]?.documentClass
		?? globalThis.Item;
}


// ---------------------------------------------------------------------------
// FDN-8 STAGE 8a — HUNTER WEAPON (port of GUISE-v2-design §8 / PHASE2-STEP0 §4a).
// PFU's `customWeapon` already ships the two-form shape (system.isTransforming / activeForm /
// secondaryForm), and slots `hoplosphere` items natively. This layer adds only what PFU lacks:
//  • an isHunterWeapon MARK (+ campaign material/origin fields PFU has no home for),
//  • a FREE two-form swap that does NOT consume the Equipment Action, limited to ONCE PER TURN.
// Toggling system.activeForm via item.update is a plain edit — FU never auto-charges the Equipment
// action for it — so the swap is free by construction; we add only the once-per-turn guard.
// NOTE (HW1, BLOCKED): the material five-list (wood/cold iron/silver/consecrated/cursed) ↔ bane-key
// reconciliation is owed by Austin — material is stored as a free field here; bane interaction is
// deferred until that ruling. HW2 (shields on a Guise) is likewise owed.
const isHunterWeapon = (item) => !!item?.getFlag?.(MODULE_ID, 'isHunterWeapon');

// C3=A (RULED 4 Sep 2026, GUISE-v2-design.md:224 — SUPERSEDES HW1's material-as-bane-key of 20 Aug).
// The five-material list is DROPPED as a mechanical field. A Hunter Weapon simply carries a BANE flag
// or not (isBane: yes/no); the adversary Banes field is free-text flavour, NEVER string-matched. The
// material survives ONLY as optional flavour prose (free text) with no distinct mechanics — so the old
// baneKey / material-enum derivation (HW_MATERIAL_BANE, baneKeyForMaterial, normalizeMaterial) is gone.
// Nothing in the module consumes a bane KEY any more; the canon-engine predicate lived Lodge-side.
const hunterWeaponIsBane = (weapon) => !!weapon?.getFlag?.(MODULE_ID, 'hunter')?.isBane;

async function setHunterWeapon(weapon, { isHunter = true, material, origin, isBane } = {}) {
	if (!weapon) { console.warn('[rippers-guise] setHunterWeapon: no weapon.'); return; }
	await weapon.setFlag(MODULE_ID, 'isHunterWeapon', !!isHunter);
	const hunter = { ...(weapon.getFlag(MODULE_ID, 'hunter') ?? {}) };
	if (material !== undefined) hunter.material = material == null ? '' : String(material).trim(); // C3=A: free-text flavour only
	if (origin !== undefined) hunter.origin = origin;
	if (isBane !== undefined) hunter.isBane = !!isBane;   // C3=A: a single bane flag replaces the 5-material key
	await weapon.setFlag(MODULE_ID, 'hunter', hunter);
	return weapon;
}

/** A signature for the current combat turn (round:turn:combatant), or null outside combat. */
function combatTurnSig() {
	const c = game.combat;
	if (!c) return null;
	return `${c.round ?? 0}:${c.turn ?? 0}:${c.combatant?.id ?? ''}`;
}
/** The next form for a transforming weapon (pure). */
const nextForm = (activeForm) => (activeForm === 'secondaryForm' ? 'primaryForm' : 'secondaryForm');

/**
 * Free once-per-turn two-form swap on a transforming weapon (melee ⇄ ranged form, one sphere set).
 * Does NOT consume the Equipment Action (it is a plain data edit). In combat, refuses a second free
 * swap in the same turn; outside combat it is unrestricted.
 */
async function swapActiveForm(weapon) {
	if (!weapon || weapon.type !== 'customWeapon') { ui.notifications?.warn('Select a custom weapon to swap forms.'); return; }
	if (!weapon.system?.isTransforming) { ui.notifications?.warn(`"${weapon.name}" is not a transforming weapon.`); return; }
	const sig = combatTurnSig();
	if (sig && weapon.getFlag(MODULE_ID, 'formSwapTurn') === sig) {
		ui.notifications?.warn(`"${weapon.name}" already changed form this turn — the free swap is once per turn.`);
		return;
	}
	const to = nextForm(weapon.system.activeForm);
	await weapon.update({ 'system.activeForm': to, [`flags.${MODULE_ID}.formSwapTurn`]: sig });
	const formName = to === 'secondaryForm'
		? (weapon.system.secondaryForm?.name || 'secondary form')
		: (weapon.name || 'primary form');
	await ChatMessage.create({
		speaker: weapon.actor ? ChatMessage.implementation.getSpeaker({ actor: weapon.actor }) : undefined,
		content: `<div class="rippers-guise-card"><strong>${esc(weapon.name)}</strong> shifts to its <em>${esc(formName)}</em> — a free once-per-turn change.</div>`,
	});
	return to;
}

/** Convenience for a macro/button: swap the actor's equipped (or first) transforming Hunter Weapon. */
async function swapHunterWeaponForm(actor) {
	if (!actor) { ui.notifications?.warn('No actor.'); return; }
	const mainId = actor.system?.equipped?.mainHand;
	const equipped = mainId && actor.items.get(mainId);
	const hw = (equipped && isHunterWeapon(equipped) && equipped.system?.isTransforming)
		? equipped
		: actor.items.find((i) => isHunterWeapon(i) && i.type === 'customWeapon' && i.system?.isTransforming);
	if (!hw) { ui.notifications?.warn('No transforming Hunter Weapon found on this actor.'); return; }
	return swapActiveForm(hw);
}

// ---------------------------------------------------------------------------
// FDN-9 — AFFINITY-SET SWAP (a monstrous-form guise with several forms). Free once-per-turn: change
// which affinity-set is active on the worn guise. Because the mask's "Guise affinities" effect already
// transfers (the mask is bound), rebuilding it from the new active set LIVE-updates the actor's
// affinities via the normal prepareData cycle — no rebind, no re-materialising skills/equipment (only
// affinities change between forms). Guards mirror swapActiveForm: outside combat unrestricted; in
// combat, one free swap per turn.

/** Pure guard: outside combat (sig null) unrestricted; in combat, one free swap per turn. */
const affinitySwapAllowed = (lastSwapSig, currentSig) => currentSig == null || lastSwapSig !== currentSig;

/**
 * Set/replace a guise's COLLECTED affinity library (sets gained in play) and optionally the active set,
 * validated against the guise's cap (explicit or governing-skill SL) when an actor is supplied. Rebuilds
 * the affinity effect (a no-op transfer-wise unless the mask is worn). Note authored sets live in
 * system.data.affinitySets (the Builder); this writes the runtime-collected library flag. GM-facing —
 * collection triggers are narrative (Austin).
 */
async function setAffinityLibrary(actor, ref, library, { activeAffinitySetId } = {}) {
	const item = resolveItem(actor, ref);
	if (!item || !isGuiseItem(item)) { ui.notifications?.warn('Set an affinity library on a guise.'); return { ok: false, reason: 'no guise' }; }
	const cap = actor ? affinitySetCapOf(actor, item) : Infinity;
	const v = validateAffinityLibrary(library, cap);
	if (!v.ok) { ui.notifications?.warn(`Affinity library rejected: ${v.reason}`); return v; }
	await item.setFlag(MODULE_ID, AFFINITY_LIBRARY_FLAG, library);
	// Reconcile the active pointer against the FULL (authored + collected) library.
	let active = activeAffinitySetId ?? getActiveAffinitySetId(item);
	if (!getAffinityLibrary(item).some((s) => s.id === active)) active = getAffinityLibrary(item)[0]?.id ?? null;
	await item.setFlag(MODULE_ID, ACTIVE_AFFINITY_SET_FLAG, active);
	await syncAffinityEffect(item);
	return { ok: true, activeAffinitySetId: active };
}

/** Free once-per-turn swap of the worn guise's active affinity-set. */
async function swapAffinitySet(actor, ref, setId) {
	const item = resolveItem(actor, ref);
	if (!actor || !item || !isReplaceModeGuise(item)) { ui.notifications?.warn('Swap an affinity-set on a guise that carries a form library.'); return { ok: false, reason: 'not a replace-mode guise' }; }
	if (getActiveGuise(actor) !== item.id) { ui.notifications?.warn('You can only shift forms while wearing the mask.'); return { ok: false, reason: 'guise not worn' }; }
	const set = getAffinityLibrary(item).find((s) => s.id === setId);
	if (!set) { ui.notifications?.warn('That affinity-set is not in this guise.'); return { ok: false, reason: 'unknown affinity-set' }; }
	const sig = combatTurnSig();
	if (!affinitySwapAllowed(item.getFlag(MODULE_ID, AFFINITY_SWAP_TURN_FLAG), sig)) {
		ui.notifications?.warn(`"${item.name}" already shifted its form this turn — the free swap is once per turn.`);
		return { ok: false, reason: 'already swapped this turn' };
	}
	await item.update({ [`flags.${MODULE_ID}.${ACTIVE_AFFINITY_SET_FLAG}`]: setId, [`flags.${MODULE_ID}.${AFFINITY_SWAP_TURN_FLAG}`]: sig });
	await syncAffinityEffect(item);
	const words = set.affinities.map((a) => `${affinityWordOf(a.level)} ${a.type}`).join(' · ') || 'no affinities';
	await ChatMessage.create({
		speaker: ChatMessage.implementation.getSpeaker({ actor }),
		content: `<div class="rippers-guise-card"><strong>${esc(actor.name)}</strong> shifts form to <em>${esc(set.name || setId)}</em> — ${esc(words)}. A free once-per-turn change.</div>`,
	});
	return { ok: true, activeAffinitySetId: setId };
}

// Back-compat aliases (pre-release Diabolist "pact" names — the class was cut; no live data uses these).
const pactSwapAllowed = affinitySwapAllowed;
const getPactLibrary = getAffinityLibrary;
const getActivePactId = getActiveAffinitySetId;
const getActivePact = getActiveAffinitySet;
const miasmicFormsSL = (actor) => namedSkillSL(actor, 'Miasmic Forms');
const validatePactSet = validateAffinitySet;
const validatePactLibrary = validateAffinityLibrary;
const setPactLibrary = (actor, ref, library, opts = {}) => setAffinityLibrary(actor, ref, library, { activeAffinitySetId: opts.activePactId });
const swapPactSet = swapAffinitySet;

// ---------------------------------------------------------------------------
// FDN-8 STAGE 8b — HOPLOSPHERE SOCKETS (port of GUISE-v2-design §7 / lent-vitals §7).
// PFU ships hoplospheres as embedded pseudo-items on a customWeapon OR armor (system.slotted /
// system.items) with a quality-tier slot count. What PFU lacks is the CAMPAIGN socket-count-BY-LEVEL
// rule and the Immunity cap. Canon (Austin ruling, 2026-08-25 — RULE-hoplosphere-sockets):
//   • WEAPON sockets: 1 at level 1; +1 at 10/20/30 → cap 4 (= TFA published weapon limit).
//   • ARMOR  sockets: 0 at start;  +1 at 10/20/30 → cap 3 (= TFA published armor limit).
//   • PERSISTENT: 2 floating sockets for the CHARACTER — 1 at level 40, 1 at level 50 —
//     mask-independent, seatable on EITHER a weapon or an armor host. A given host's effective
//     capacity = its base + whatever of the 2-slot pool is not already spent as overflow on the
//     actor's OTHER hosts, so the pool can never be double-spent across weapon+armor.
//   • Two-Immunity cap: CHARACTER-WIDE — at most TWO hoplosphere-granted Immunities summed across
//     ALL of the actor's weapon + armor hosts (not per host).
// This deliberately REPLACES PFU's quality-tier capacity for our campaign, and supersedes 8b's
// original min(6,floor(lvl/5)) weapon rule + the Hunter-Weapon-exclusive 40/50 bonus (now floating).
// A hoplosphere costs its requiredSlots (1 or 2). D-SPHERE (Austin, approved): adopt PFU's native
// hoplosphere change-set as the sphere vocabulary.
// CLOT (Austin, 2026-08-25): "Clot" is the campaign-facing NAME for the sphere — a label/vocabulary
// rename only (display strings + our lang/en.json TYPES.Item.hoplosphere override). The base PFU
// item-type KEY stays 'hoplosphere' (vendored upstream, no fork), so every type:'hoplosphere' check
// and all code identifiers below keep the engine name; only what a player reads says "Clot".
const IMMUNITY_EFFECT_TYPES = new Set(['gainImmunity', 'gainStatusImmunity']);
const HOPLO_HOST_TYPES = new Set(['customWeapon', 'armor']);

/** 'weapon' | 'armor' | null — the campaign socket-cadence family a host belongs to. */
function hoplosphereHostKind(host) {
	if (host?.type === 'customWeapon') return 'weapon';
	if (host?.type === 'armor') return 'armor';
	return null;
}
function charLevelForHost(host, actor) {
	const a = actor ?? host?.actor;
	return Number(a?.system?.level?.value ?? a?.system?.level ?? 0) || 0;
}
/** Every one of an actor's hoplosphere-hosting items (customWeapon + armor). */
function hoplosphereHosts(actor) {
	return Array.from(actor?.items ?? []).filter((i) => HOPLO_HOST_TYPES.has(i?.type));
}
/** Base sockets from the level cadence, by host kind. WEAPON: 1 + (≥10)+(≥20)+(≥30) → cap 4.
 *  ARMOR: (≥10)+(≥20)+(≥30) → cap 3. Unknown host → 0. Excludes the floating persistent pool. */
function baseSocketCapacity(host, actor) {
	const lvl = charLevelForHost(host, actor);
	const steps = (lvl >= 10 ? 1 : 0) + (lvl >= 20 ? 1 : 0) + (lvl >= 30 ? 1 : 0);
	const kind = hoplosphereHostKind(host);
	if (kind === 'weapon') return 1 + steps; // 1/2/3/4
	if (kind === 'armor') return steps;      // 0/1/2/3
	return 0;
}
/** The character-wide floating persistent sockets: 1 at level 40, 1 at level 50 (0..2).
 *  Mask-independent; seatable on any weapon or armor host. */
function persistentSlotsUnlocked(actor) {
	const lvl = Number(actor?.system?.level?.value ?? actor?.system?.level ?? 0) || 0;
	return (lvl >= 40 ? 1 : 0) + (lvl >= 50 ? 1 : 0);
}
/** How many persistent (floating) slots are already spent as over-base overflow on the actor's
 *  OTHER hosts — so a host may only borrow what the pool still has free. */
function persistentUsedElsewhere(host, actor) {
	const a = actor ?? host?.actor;
	if (!a) return 0;
	return hoplosphereHosts(a)
		.filter((h) => h?.id !== host?.id)
		.reduce((sum, h) => sum + Math.max(0, seatedSlotsUsed(h) - baseSocketCapacity(h, a)), 0);
}
/** Effective socket capacity for a host = its level base + whatever of the 2-slot character-wide
 *  persistent pool is not already overflowing onto the actor's other hosts. */
function hoplosphereSocketCapacity(host, actor) {
	const a = actor ?? host?.actor;
	const base = baseSocketCapacity(host, a);
	const persistentAvail = Math.max(0, persistentSlotsUnlocked(a) - persistentUsedElsewhere(host, a));
	return base + persistentAvail;
}
function seatedHoplospheres(host) {
	const src = host?.system?.slotted;
	const arr = Array.isArray(src) ? src : (src ? Array.from(src) : Array.from(host?.items ?? []));
	return arr.filter((i) => i?.type === 'hoplosphere');
}
const requiredSlotsOf = (sphere) => Number(sphere?.system?.requiredSlots ?? 1) || 1;
const immunitiesOf = (sphere) => (sphere?.system?.effects ?? []).filter((e) => IMMUNITY_EFFECT_TYPES.has(e?.type)).length;
const seatedSlotsUsed = (host) => seatedHoplospheres(host).reduce((a, s) => a + requiredSlotsOf(s), 0);
const hoplosphereImmunityCount = (host) => seatedHoplospheres(host).reduce((a, s) => a + immunitiesOf(s), 0);
/** Character-wide hoplosphere Immunity total across every weapon + armor host (for the global cap). */
function characterHoplosphereImmunityCount(actor) {
	return hoplosphereHosts(actor).reduce((sum, h) => sum + hoplosphereImmunityCount(h), 0);
}
/** Immunities seated on the actor's hosts OTHER than this one — the fixed floor a pending host
 *  update must be added to when checking the two-Immunity character-wide cap. */
function otherHostsImmunityCount(host, actor) {
	const a = actor ?? host?.actor;
	if (!a) return 0;
	return hoplosphereHosts(a)
		.filter((h) => h?.id !== host?.id)
		.reduce((sum, h) => sum + hoplosphereImmunityCount(h), 0);
}

/** Audit a host's hoplosphere loadout against the level+persistent capacity and the CHARACTER-WIDE
 *  two-Immunity cap (UI/GM/macro). `immunities` stays this host's own count for back-compat;
 *  `immunitiesCharacterWide` and the overImmunityCap/ok verdicts are the character-wide totals. */
function checkHoplosphereSockets(host, actor) {
	const a = actor ?? host?.actor;
	const capacity = hoplosphereSocketCapacity(host, a);
	const used = seatedSlotsUsed(host);
	const immunities = hoplosphereImmunityCount(host);
	const immunitiesChar = a ? characterHoplosphereImmunityCount(a) : immunities;
	return {
		capacity,
		baseCapacity: baseSocketCapacity(host, a),
		persistentAvailable: Math.max(0, persistentSlotsUnlocked(a) - persistentUsedElsewhere(host, a)),
		used, free: Math.max(0, capacity - used), seated: seatedHoplospheres(host).length,
		overSockets: used > capacity,
		immunities, immunitiesCharacterWide: immunitiesChar, overImmunityCap: immunitiesChar > 2,
		ok: used <= capacity && immunitiesChar <= 2,
	};
}

/** Pure evaluator: given the FULL incoming hoplosphere set, does it exceed the level capacity or the
 * two-Immunity cap? Used by the weapon-update guard and unit tests. */
function evaluateSlotting(incomingItems, capacity) {
	const hoplos = (incomingItems ?? []).filter((o) => o?.type === 'hoplosphere');
	const usedAfter = hoplos.reduce((a, o) => a + requiredSlotsOf(o), 0);
	const immAfter = hoplos.reduce((a, o) => a + immunitiesOf(o), 0);
	return { usedAfter, immAfter, capacity, overSockets: usedAfter > capacity, overImmunityCap: immAfter > 2 };
}

// HARD enforcement (v0.4.1, retargeted; extended to armor + character-wide immunities 2026-08-25).
// Hoplospheres slot into system.items — a PFU PseudoDocumentCollectionField persisted via a HOST
// UPDATE (customWeapon OR armor), NOT actor.createEmbeddedDocuments (so preCreateItem never fired).
// Guard the host UPDATE: refuse the incoming system.items if it seats more hoplosphere slots than the
// host's effective (base + persistent) capacity, or if it would push the actor's TOTAL hoplosphere
// Immunities — this host's incoming set plus every other host's seated set — past two. The
// checkHoplosphereSockets audit remains the sheet/GM read either way.
Hooks.on('preUpdateItem', (item, changed) => {
	try {
		if (!HOPLO_HOST_TYPES.has(item?.type)) return;
		const incoming = changed?.system?.items;
		if (!Array.isArray(incoming)) return; // only the full-array update form (the slotting path)
		const capacity = hoplosphereSocketCapacity(item, item.actor);
		const ev = evaluateSlotting(incoming, capacity);
		if (item.actor && ev.overSockets) {
			// "Clot" is the campaign-facing name for the base PFU hoplosphere (label-only; type key unchanged).
			ui.notifications?.warn(game.i18n?.format?.('RIPPERS.Clot.OverSockets', { name: item.name, capacity, needed: ev.usedAfter })
				?? `"${item.name}" has ${capacity} Clot socket(s) at this level; that loadout needs ${ev.usedAfter}.`);
			return false;
		}
		// Character-wide two-Immunity cap: this host's incoming immunities + every OTHER host's seated.
		const immTotal = ev.immAfter + otherHostsImmunityCount(item, item.actor);
		if (immTotal > 2) {
			ui.notifications?.warn(game.i18n?.format?.('RIPPERS.Clot.OverImmunity', { total: immTotal })
				?? `A character may carry at most two Clot-granted Immunities across all weapons and armor; this loadout would make ${immTotal}.`);
			return false;
		}
	} catch (err) { console.error('[rippers-guise] hoplosphere socket guard failed:', err); }
});

/** Test/util: slot a hoplosphere pseudo-item onto a customWeapon or armor host via PFU's
 * nested-collection API, so 8b enforcement is exercisable without the drag UI. */
async function slotHoplosphere(host, sphereData = {}) {
	if (!host || !HOPLO_HOST_TYPES.has(host.type)) { ui.notifications?.warn(game.i18n?.localize?.('RIPPERS.Clot.SlotHost') ?? 'Slot a Clot onto a custom weapon or armor.'); return; }
	// Display name reads "Clot"; the base PFU item-type key stays 'hoplosphere' (vendored, no fork).
	const obj = foundry.utils.mergeObject({ name: (game.i18n?.localize?.('RIPPERS.Clot.DefaultName') ?? 'Clot'), type: 'hoplosphere', system: { requiredSlots: 1, effects: [] } }, sphereData, { inplace: false });
	return host.system.createEmbeddedDocuments('Item', [obj]);
}

// ---------------------------------------------------------------------------
// FDN-8 STAGE 8c — HEROIC SLOTS (port of PHASE2-STEP0 §1.4/§2 + GUISE-v2-design §4).
// PFU heroic Items have no slot/level accounting. This adds a character-owned record of the four
// canon slots — creation · level40 · level50 · earned[] — pointing at owned heroic Items, with:
//  • level40/level50 unlock only at character level 40/50,
//  • the creation slot refuses creation_banned heroics (the flag finally enforced),
//  • DORMANCY (Austin rulings): the CREATION heroic sleeps while a guise is worn; level40/level50
//    and EARNED stay always-live (character-owned). Suppression disables the creation heroic's
//    ActiveEffects while masked and restores them on dismiss (narrative heroics = a harmless no-op).
const HEROIC_SLOTS = ['creation', 'level40', 'level50', 'earned'];
const DORMANT_HEROIC_FLAG = 'dormantCreationHeroic';

function getHeroicSlots(actor) {
	const s = actor?.getFlag(MODULE_ID, 'heroicSlots') ?? {};
	return { creation: s.creation ?? null, level40: s.level40 ?? null, level50: s.level50 ?? null, earned: Array.isArray(s.earned) ? [...s.earned] : [] };
}
const heroicIsCreationBanned = (heroic) => !!(heroic?.getFlag?.('rippers-compendium', 'creationBanned') || heroic?.getFlag?.(MODULE_ID, 'creationBanned'));

// Returns {ok, reason?, slots?} so a UI can tell WHY an assignment was refused (god UX note, 8c).
// A warning is still surfaced for direct/macro callers.
async function assignHeroicSlot(actor, slot, heroicRef) {
	const refuse = (reason) => { ui.notifications?.warn(reason); return { ok: false, reason }; };
	if (!actor) return { ok: false, reason: 'No actor.' };
	if (!HEROIC_SLOTS.includes(slot)) return refuse(`Unknown heroic slot "${slot}".`);
	const heroic = resolveItem(actor, heroicRef);
	if (!heroic || heroic.type !== 'heroic') return refuse('Assign a heroic Item to the slot.');
	const lvl = charLevelOf(actor);
	if (slot === 'level40' && lvl < 40) return refuse('The level-40 heroic slot unlocks at character level 40.');
	if (slot === 'level50' && lvl < 50) return refuse('The level-50 heroic slot unlocks at character level 50.');
	if (slot === 'creation' && heroicIsCreationBanned(heroic)) return refuse(`"${heroic.name}" cannot be taken as a creation heroic.`);
	const slots = getHeroicSlots(actor);
	if (slot === 'earned') { if (!slots.earned.includes(heroic.id)) slots.earned.push(heroic.id); }
	else slots[slot] = heroic.id;
	await actor.setFlag(MODULE_ID, 'heroicSlots', slots);
	return { ok: true, slots };
}
async function clearHeroicSlot(actor, slot, heroicRef) {
	if (!actor || !HEROIC_SLOTS.includes(slot)) return;
	const slots = getHeroicSlots(actor);
	if (slot === 'earned') { const id = typeof heroicRef === 'string' ? heroicRef : heroicRef?.id; slots.earned = id ? slots.earned.filter((x) => x !== id) : []; }
	else slots[slot] = null;
	await actor.setFlag(MODULE_ID, 'heroicSlots', slots);
	return slots;
}

/** Dormancy: sleep the creation-slot heroic (disable its effects) while masked; 40/50/earned stay live. */
async function suppressCreationHeroic(actor) {
	const id = getHeroicSlots(actor).creation;
	const heroic = id && actor.items.get(id);
	if (!heroic) return 0;
	const toDisable = heroic.effects.filter((e) => !e.disabled);
	await actor.setFlag(MODULE_ID, DORMANT_HEROIC_FLAG, { id, effects: toDisable.map((e) => e.id) });
	if (toDisable.length) await heroic.updateEmbeddedDocuments('ActiveEffect', toDisable.map((e) => ({ _id: e.id, disabled: true })));
	return toDisable.length;
}
async function restoreCreationHeroic(actor) {
	const snap = actor.getFlag(MODULE_ID, DORMANT_HEROIC_FLAG);
	if (!snap) return 0;
	const heroic = actor.items.get(snap.id);
	if (heroic && snap.effects?.length) {
		const existing = snap.effects.filter((eid) => heroic.effects.get(eid));
		if (existing.length) await heroic.updateEmbeddedDocuments('ActiveEffect', existing.map((eid) => ({ _id: eid, disabled: false })));
	}
	await actor.unsetFlag(MODULE_ID, DORMANT_HEROIC_FLAG);
	return snap.effects?.length ?? 0;
}

// ---------------------------------------------------------------------------
// §10 — LENT VITALS + IP SATCHEL (canon: RULE-guise-lent-vitals.md; RULE-guise-derived-stats.md §2).
// A guise may carry a LENT layer of HP and MP — the mask's own padding, each with its own current +
// maximum, SPENT BEFORE the wearer's own pool and REFILLED AT A REST (healing does not, §4.1). It
// NEVER changes the wearer's maximum HP/MP: Crisis always reads the wearer's own numbers. The layer
// lives on the guise Item's system.data, so it RIDES the guise, FREEZES when the guise is stashed
// (nothing touches it), and TRANSFERS with the guise to the next wearer for free — no extra plumbing.
// Most guises carry no layer (0/0). The IP SATCHEL rides the same way but is CAPACITY, not vitals: a
// rest does NOT refill it; stock is bought back at 10z a point (Recharge Inventory, derived-stats §2).
// These fields are runtime state, NOT authored in the wizard (Austin owns that UI) — guiseDraftToData
// omits them and Foundry's recursive item.update merge preserves them across a builder edit.
const IP_UNIT_COST = 10; // zenit per IP point

/** Normalize a {current,maximum} lent layer: ints ≥0, current clamped to maximum. Pure. */
function normalizeLentLayer(layer) {
	const maximum = Math.max(0, Math.floor(Number(layer?.maximum) || 0));
	const current = Math.min(maximum, Math.max(0, Math.floor(Number(layer?.current) || 0)));
	return { current, maximum };
}
/** Normalize an IP satchel {stock,capacity}: ints ≥0, stock clamped to capacity. Pure. */
function normalizeIpSatchel(s) {
	const capacity = Math.max(0, Math.floor(Number(s?.capacity) || 0));
	const stock = Math.min(capacity, Math.max(0, Math.floor(Number(s?.stock) || 0)));
	return { stock, capacity };
}

/** Spend `amount` of a resource: the lent layer takes it FIRST, the remainder comes off the wearer's
 *  own pool. The own value is NOT clamped at 0 — dropping to/below 0 is the wearer's business (Crisis
 *  and defeat read their own numbers). Pure. Returns the split + the new values. */
function spendLentThenOwn(amount, lentCurrent, ownValue) {
	const amt = Math.max(0, Math.floor(Number(amount) || 0));
	const lent = Math.max(0, Math.floor(Number(lentCurrent) || 0));
	const own = Number(ownValue) || 0;
	const fromLent = Math.min(amt, lent);
	const fromOwn = amt - fromLent;
	return { fromLent, fromOwn, newLent: lent - fromLent, newOwn: own - fromOwn };
}
/** A rest refills a lent layer to its maximum. Pure. */
function restRefillLayer(layer) { const n = normalizeLentLayer(layer); return { current: n.maximum, maximum: n.maximum }; }
/** Restock the IP satchel: buy up to `points`, capped at remaining capacity. 10z a point; a rest never
 *  refills it. Pure. Returns the new satchel + how many were bought + the zenit cost. */
function restockIp(satchel, points) {
	const n = normalizeIpSatchel(satchel);
	const room = Math.max(0, n.capacity - n.stock);
	const bought = Math.min(room, Math.max(0, Math.floor(Number(points) || 0)));
	return { stock: n.stock + bought, capacity: n.capacity, bought, costZenit: bought * IP_UNIT_COST };
}
/** Spend IP from the satchel (capped at stock). Pure. */
function spendIp(satchel, points) {
	const n = normalizeIpSatchel(satchel);
	const spent = Math.min(n.stock, Math.max(0, Math.floor(Number(points) || 0)));
	return { stock: n.stock - spent, capacity: n.capacity, spent };
}

// ── imperative seams (thin: write the layer onto the guise Item so it rides/freezes/transfers) ──
const LENT_KEY = { hp: 'lentHp', mp: 'lentMp' };

/** The lent layers + IP satchel a guise Item carries (normalized). */
function guiseVitals(item) {
	const d = item?.system?.data ?? {};
	return { hp: normalizeLentLayer(d.lentHp), mp: normalizeLentLayer(d.lentMp), ip: normalizeIpSatchel(d.ipSatchel) };
}
/** Write one lent layer's current back onto the guise (rides/freezes/transfers with the Item). */
async function setGuiseLentCurrent(item, kind, current) {
	if (!item || !LENT_KEY[kind]) return;
	const layer = normalizeLentLayer(item.system?.data?.[LENT_KEY[kind]]);
	const next = Math.min(layer.maximum, Math.max(0, Math.floor(Number(current) || 0)));
	await item.update({ [`system.data.${LENT_KEY[kind]}.current`]: next });
}
/** The actor's currently-worn guise Item (null if none / unresolvable). */
function activeGuiseItem(actor) { const id = getActiveGuise(actor); return id ? (actor?.items?.get(id) ?? null) : null; }

/** Apply an HP or MP cost to the wearer: the WORN guise's lent layer takes it first, then the actor's
 *  own resource. Writes both. This is the seam a damage/cost integration calls; it does NOT itself
 *  hook the FU damage pipeline (that interception is a separate integration — see the ⚠ at the rest
 *  subscription). Returns { fromLent, fromOwn }. */
async function applyResourceCost(actor, kind, amount) {
	if (!actor || !LENT_KEY[kind]) return { fromLent: 0, fromOwn: 0 };
	const guise = activeGuiseItem(actor);
	const lentCurrent = guise ? normalizeLentLayer(guise.system?.data?.[LENT_KEY[kind]]).current : 0;
	const ownValue = Number(actor.system?.resources?.[kind]?.value) || 0;
	const split = spendLentThenOwn(amount, lentCurrent, ownValue);
	if (guise && split.fromLent > 0) await setGuiseLentCurrent(guise, kind, split.newLent);
	if (split.fromOwn > 0) await actor.update({ [`system.resources.${kind}.value`]: split.newOwn });
	return { fromLent: split.fromLent, fromOwn: split.fromOwn };
}

/** REST refill: every LIVE guise the actor owns refills its lent HP/MP to maximum (worn or in hand —
 *  only a SHELVED guise, owned by no actor, freezes; §1). The IP satchel is NOT refilled (bought back
 *  at 10z/pt). Returns the number of guises refilled. */
async function restRefillActorGuises(actor) {
	if (!actor?.items?.filter) return 0;
	let n = 0;
	for (const it of actor.items.filter(isGuiseItem)) {
		const d = it.system?.data ?? {};
		const hp = normalizeLentLayer(d.lentHp), mp = normalizeLentLayer(d.lentMp);
		if (hp.maximum === 0 && mp.maximum === 0) continue;              // no layer — nothing to refill
		if (hp.current === hp.maximum && mp.current === mp.maximum) continue; // already full
		await it.update({ 'system.data.lentHp.current': hp.maximum, 'system.data.lentMp.current': mp.maximum });
		n++;
	}
	return n;
}

// ── P3: lent-vitals AUTO-INTERCEPT on the FU damage pipeline (spent-before-own, no caller) ─────────
// Promotes the applyResourceCost seam onto FU's DAMAGE_PIPELINE_POST_CALCULATE. At POST the amount is
// final (post-affinity; any amount-modifier quirks — Crew/Revenant — ran at PRE and are already baked
// into context.result, per god's approved ordering), so the worn guise's lent-HP layer absorbs from
// context.result and we shrink it to the remainder — FU applies only that remainder to the wearer's own
// HP (it reads damageTaken straight off context.result). Fires ONCE PER TARGET with a fresh context
// (context.actor = that target), so no double-apply; the layer write is idempotent per event.
/** PURE: how a final damage amount splits across a lent-HP layer. absorb comes off the layer first, the
 *  remainder lands on the wearer's own HP. Returns { absorb, remainder, newLent }. */
function lentHpAbsorbPlan(resultAmount, lentCurrent) {
	const dmg = Math.max(0, Math.floor(Number(resultAmount) || 0));
	const lent = Math.max(0, Math.floor(Number(lentCurrent) || 0));
	const absorb = Math.min(dmg, lent);
	return { absorb, remainder: dmg - absorb, newLent: lent - absorb };
}
/** DAMAGE_PIPELINE_POST_CALCULATE handler: the worn guise's lent-HP layer takes the hit first. Mutates
 *  context.result SYNCHRONOUSLY (FU reads it right after this returns) and writes the decremented layer
 *  back on the guise (async — the item.update need not complete before FU applies the remainder). MP is
 *  out of scope (a separate MP-LAYER-ROUTING follow-on); this touches HP damage only. */
const MIND_POINT_LOSS_TRAIT = 'mind-point-loss'; // FU Traits.MindPointLoss — routes damage to MP, not HP
function onDamagePostLentSplit(context) {
	try {
		const actor = context?.actor;
		if (!actor) return;
		// This damage routes to MP (not HP) — the lent-HP layer must NOT absorb it. Lent-MP is a separate
		// follow-on (MP-LAYER-ROUTING); leave the amount alone here.
		if (context?.traits?.has?.(MIND_POINT_LOSS_TRAIT)) return;
		const guise = activeGuiseItem(actor);
		if (!guise) return;
		const layer = normalizeLentLayer(guise.system?.data?.lentHp);
		if (layer.current <= 0) return;
		const plan = lentHpAbsorbPlan(context.result, layer.current);
		if (plan.absorb <= 0) return;
		context.result = plan.remainder;                 // FU applies only the remainder to own HP (line 506)
		setGuiseLentCurrent(guise, 'hp', plan.newLent).catch((err) => console.warn('[rippers-guise] lent-HP write failed:', err));
	} catch (err) { console.error('[rippers-guise] lent-HP damage split failed:', err); }
}

// MP-LAYER-ROUTING: the lent-MP layer is spent before own MP for every spell/skill/feature MP cost —
// the CALCULATE_EXPENSE_EVENT is FU's clean pre-apply, mutable expense hook (event.expense.amount is
// read back at common-sections.mjs and only the remainder is debited from own MP). This mirrors the
// lent-HP damage split. Canon (RULE-guise-lent-vitals §1: "Damage and MP costs consume the layer
// first"): only MP COSTS draw the lent-MP layer here — HP-cost abilities are neither damage nor an MP
// cost, so they hit own HP directly (damage is covered by the pipeline split above). Uses the same
// kind-agnostic lentHpAbsorbPlan(amount, lentCurrent).
function onCalculateExpenseLentMp(event) {
	try {
		const expense = event?.expense;
		if (!expense || expense.resource !== 'mp') return;
		const actor = event?.source?.actor;
		if (!actor) return;
		const guise = activeGuiseItem(actor);
		if (!guise) return;
		const layer = normalizeLentLayer(guise.system?.data?.lentMp);
		if (layer.current <= 0) return;
		const plan = lentHpAbsorbPlan(expense.amount, layer.current); // absorb math is kind-agnostic
		if (plan.absorb <= 0) return;
		expense.amount = plan.remainder;                 // FU debits only the remainder from own MP
		setGuiseLentCurrent(guise, 'mp', plan.newLent).catch((err) => console.warn('[rippers-guise] lent-MP write failed:', err));
	} catch (err) { console.error('[rippers-guise] lent-MP expense split failed:', err); }
}

// ---------------------------------------------------------------------------
// BENEFIT-PICK POOL (Case B — god 2026-08-23; source: GUISES-core-rules.md §1 "Innate Benefits").
// Austin's ruleset: classes grant NO innate benefits (own OR guise-worn) — every benefit comes from
// the character's TWO creation picks (permanent, unbuyable). This SUPERSEDES the 2026-08-20 "benefits
// TRUE on class Items" ruling. The class-side reconciliation is a COMPILER delta (all benefit
// booleans → false, printed values kept as a display-only catalog) so PFU's HP/MP/IP calc
// (character-data-model.mjs) and AdvancementTracker read NOTHING from classes and the pool is the
// sole source. The engine can't neutralise a class Item's intrinsic system.benefits (they aren't
// ActiveEffect changes the POOL_BLOCK guard sees), so the fix belongs in the compendium generator;
// stripClassBenefits() below is only an opt-in repair for actors imported before that delta lands.
//
// PROFICIENCY NOTE (GUISES-core-rules.md §3, ruled 17 Aug 2026): martial proficiency does NOT exist
// in this ruleset — it is UNIVERSAL (everyone can equip anything; "martial" is only a tag on the
// item some skills read). So there are NO martial/armor/shield picks; the honor-system "martial
// display" the dispatch asked for is moot. The pool is the §1 list below and nothing else.
//
// The record is an actor-flag singleton — per-character, ALWAYS-LIVE, never a mask's, so dormancy
// never touches it. Only the four STAT picks are mechanically live; they land on
// system.resources.{hp,mp,ip}.bonus through ONE on-actor "Benefit Picks" ActiveEffect (the
// rippers-automation .bonus idiom). Capability picks (Projects/Rituals/…) are display-only.
const BENEFIT_FLAG = 'benefitPicks';
const BENEFIT_EFFECT_FLAG = 'benefitPickEffect';
const RESOURCE_KEYS = ['hp', 'mp', 'ip'];

// The §1 pool, verbatim. `stat` picks carry resource deltas (mechanically live); `capability` picks
// carry none (display/honor-system). `contested:true` = one character in the party (enforced at the
// table; surfaced here for the UI). Stat picks are uncontested. `both:true` = costs BOTH picks.
const BENEFIT_POOL = {
	hp10:  { label: '+10 HP',           kind: 'stat', delta: { hp: 10 },       contested: false },
	mp10:  { label: '+10 MP',           kind: 'stat', delta: { mp: 10 },       contested: false },
	hpmp5: { label: '+5 HP and +5 MP',  kind: 'stat', delta: { hp: 5, mp: 5 }, contested: false },
	ip4:   { label: '+4 IP',            kind: 'stat', delta: { ip: 4 },        contested: false },
	projects:         { label: 'Projects',            kind: 'capability', contested: true },
	rituals:          { label: 'Rituals',             kind: 'capability', contested: true, namedDiscipline: true },
	see_you_later:    { label: 'See You Later',       kind: 'capability', contested: true },
	unexpected_ally:  { label: 'Unexpected Ally',     kind: 'capability', contested: true },
	personal_vehicle: { label: 'Personal Vehicle',    kind: 'capability', contested: true },
	familiar:         { label: "Diabolist's familiar", kind: 'capability', contested: true, both: true },
};

/** Pure validator: enforce the 2-pick rule (familiar trades BOTH), known keys, no duplicates. */
function validateBenefitPicks(picks) {
	if (!Array.isArray(picks)) return { ok: false, reason: 'picks must be an array' };
	if (new Set(picks).size !== picks.length) return { ok: false, reason: 'duplicate pick' };
	for (const p of picks) if (!BENEFIT_POOL[p]) return { ok: false, reason: `unknown pick "${p}"` };
	if (picks.includes('familiar')) {
		return picks.length === 1 ? { ok: true } : { ok: false, reason: 'the familiar trades BOTH picks — it must be the only pick' };
	}
	if (picks.length > 2) return { ok: false, reason: 'at most two benefit picks' };
	return { ok: true };
}

/** Aggregate the resource-bonus deltas for a set of picks. Pure. */
function benefitResourceDeltas(picks) {
	const out = { hp: 0, mp: 0, ip: 0 };
	for (const p of picks ?? []) {
		const d = BENEFIT_POOL[p]?.delta;
		if (d) for (const k of RESOURCE_KEYS) if (d[k]) out[k] += d[k];
	}
	return out;
}

/** Build the ActiveEffect `changes` (system.resources.{k}.bonus ADD) for the stat picks. Pure. */
function benefitEffectChanges(picks) {
	const deltas = benefitResourceDeltas(picks);
	return RESOURCE_KEYS
		.filter((k) => deltas[k])
		.map((k) => ({ key: `system.resources.${k}.bonus`, mode: 2, value: String(deltas[k]), priority: null }));
}

function getBenefitPicks(actor) {
	const rec = actor?.getFlag?.(MODULE_ID, BENEFIT_FLAG);
	return { picks: rec?.picks ?? [], ritualDiscipline: rec?.ritualDiscipline ?? '' };
}

/** Rebuild the single on-actor "Benefit Picks" ActiveEffect from the record. Idempotent. */
async function rebuildBenefitEffect(actor) {
	if (!actor) return;
	const { picks } = getBenefitPicks(actor);
	const changes = benefitEffectChanges(picks);
	const existing = actor.effects.find((e) => e.getFlag(MODULE_ID, BENEFIT_EFFECT_FLAG));
	if (!changes.length) { if (existing) await existing.delete(); return; }
	if (existing) { await existing.update({ changes }); return; }
	await actor.createEmbeddedDocuments('ActiveEffect', [{
		name: 'Benefit Picks',
		img: 'icons/svg/upgrade.svg',
		changes,
		transfer: false,
		flags: { [MODULE_ID]: { [BENEFIT_EFFECT_FLAG]: true } },
	}]);
}

/** Set a character's creation benefit picks (validated), then rebuild the live effect. */
async function setBenefitPicks(actor, { picks = [], ritualDiscipline = '' } = {}) {
	if (!actor) return { ok: false, reason: 'no actor' };
	const v = validateBenefitPicks(picks);
	if (!v.ok) { console.warn(`[rippers-guise] setBenefitPicks: ${v.reason}`); return v; }
	const rec = { picks: [...new Set(picks)] };
	if (picks.includes('rituals') && ritualDiscipline) rec.ritualDiscipline = String(ritualDiscipline);
	await actor.setFlag(MODULE_ID, BENEFIT_FLAG, rec);
	await rebuildBenefitEffect(actor);
	return { ok: true, picks: rec.picks };
}

const capWord = (s) => (s ? String(s)[0].toUpperCase() + String(s).slice(1) : String(s ?? ''));

/**
 * The Rituals pick grants Ritualism (universal, always) PLUS one NAMED second discipline (contested).
 * Ritualism is never the named second — so a named discipline of 'ritualism' (or empty) collapses to
 * just "Rituals (Ritualism)" rather than the "Ritualism + Ritualism" dupe. (POLISH-picker-ritualism-dupe.)
 */
function ritualsLabel(disc) {
	const named = disc && String(disc).toLowerCase() !== 'ritualism' ? disc : '';
	return named ? `Rituals (Ritualism + ${capWord(named)})` : 'Rituals (Ritualism)';
}

/** Human summary of a character's picks (panel / sheet). Sync. */
function benefitPickSummary(actor) {
	const { picks, ritualDiscipline } = getBenefitPicks(actor);
	if (!picks.length) return 'No benefit picks chosen.';
	return picks.map((p) => {
		const b = BENEFIT_POOL[p];
		if (!b) return p;
		if (p === 'rituals') return ritualsLabel(ritualDiscipline);
		return b.label;
	}).join(' · ');
}

// ---------------------------------------------------------------------------
// RITUAL DISCIPLINES — the three canon routes, tracked for DISPLAY (not a mechanical gate).
// Verified in FU source: PFU does NOT gate ritual casting on any actor field — a ritual is a
// `ritual` Item and casting is a ritualCheck on it; nothing reads benefits.rituals/disciplines. So
// the class ritualism BOOLEAN is inert (safe for the compendium delta to neutralize uniformly), and
// ritual-granting is a display/contested-tracking concern, expressed at the SKILL / KEYSTONE level
// via `flags.<ns>.grantsRitual = <discipline | [disciplines]>` — NOT via a class boolean (inert, and
// the wrong doc: Keeper grants Ritualism through its Bind/Haunt skills, not the class itself).
// The three routes:
//   a) the benefit-pick pool — the 'rituals' pick grants Ritualism (universal) + the named 2nd discipline;
//   b) a ritual-granting CLASS SKILL carrying flags.<ns>.grantsRitual;
//   c) a granting KEYSTONE Item carrying the same flag.
const GRANTS_RITUAL_KEY = 'grantsRitual';
function normalizeDisciplines(v) {
	if (!v) return [];
	return (Array.isArray(v) ? v : [v]).map((d) => String(d).toLowerCase().trim()).filter(Boolean);
}
/** Aggregate a character's ritual disciplines across all three routes (display / Guise Builder). Sync. */
function characterRitualDisciplines(actor) {
	const out = new Set();
	const { picks, ritualDiscipline } = getBenefitPicks(actor);
	if (picks.includes('rituals')) { out.add('ritualism'); for (const d of normalizeDisciplines(ritualDiscipline)) out.add(d); }
	for (const it of actor?.items ?? []) {
		for (const ns of Object.keys(it?.flags ?? {})) {
			for (const d of normalizeDisciplines(it.flags[ns]?.[GRANTS_RITUAL_KEY])) out.add(d);
		}
	}
	return [...out];
}

// Projects — the parallel capability route (same three-route model). FU gates nothing on it either;
// this is display / Guise Builder tracking. Route a) the 'projects' benefit pick; route b/c) an Item
// carrying flags.<ns>.grantsProject === true (a project-granting class skill or keystone).
const GRANTS_PROJECT_KEY = 'grantsProject';
function characterCanInitiateProjects(actor) {
	if (getBenefitPicks(actor).picks.includes('projects')) return true;
	for (const it of actor?.items ?? []) {
		for (const ns of Object.keys(it?.flags ?? {})) if (it.flags[ns]?.[GRANTS_PROJECT_KEY] === true) return true;
	}
	return false;
}

/**
 * Opt-in GM repair (NOT automatic): neutralise benefit booleans on a character's OWN class Items —
 * for actors imported before the Case-B compendium delta — so PFU stops granting class HP/MP/IP and
 * double-counting against the pool. The compendium generator is the real fix; this patches live
 * actors. Idempotent (skips class Items that already grant nothing).
 */
async function stripClassBenefits(actor) {
	if (!actor) return 0;
	const updates = [];
	for (const cls of actor.items.filter((i) => i.type === 'class')) {
		const b = cls.system?.benefits ?? {};
		const anyTrue = RESOURCE_KEYS.some((k) => b.resources?.[k]?.value)
			|| ['melee', 'ranged', 'armor', 'shields'].some((k) => b.martials?.[k]?.value)
			|| Object.values(b.rituals ?? {}).some((r) => r?.value);
		if (!anyTrue) continue;
		const u = {
			_id: cls.id,
			'system.benefits.resources.hp.value': false,
			'system.benefits.resources.mp.value': false,
			'system.benefits.resources.ip.value': false,
			'system.benefits.martials.melee.value': false,
			'system.benefits.martials.ranged.value': false,
			'system.benefits.martials.armor.value': false,
			'system.benefits.martials.shields.value': false,
		};
		for (const rk of Object.keys(b.rituals ?? {})) u[`system.benefits.rituals.${rk}.value`] = false;
		updates.push(u);
	}
	if (updates.length) await actor.updateEmbeddedDocuments('Item', updates);
	return updates.length;
}

// ---------------------------------------------------------------------------
// FEATURES-TAB "GUISES" PANEL (FDN-7). Player-facing bind/dismiss controls injected into PFU's
// character-sheet Features tab. UI + wiring only — every button calls the EXISTING setActiveGuise
// (bind mechanics unchanged). One guise active at a time; the active mask is badged and, cheaply,
// summarised (allocated SL + affinity words — no async UUID resolution, so the panel renders sync).
const esc = (s) => (foundry.utils?.escapeHTML ? foundry.utils.escapeHTML(String(s ?? '')) : String(s ?? ''));

function guiseSummary(item) {
	const data = item.system?.data ?? {};
	const classes = data.classes ?? [];
	const totalSl = classes.reduce((a, c) => a + (c.skills ?? []).reduce((x, s) => x + (Number(s.sl) || 0), 0), 0);
	// REPLACE-mode guise: show its active form's affinities; else the legacy additive modifiers.
	const affSource = isReplaceModeGuise(item)
		? (getActiveAffinitySet(item)?.affinities ?? [])
		: (data.affinityModifiers ?? []);
	const affTxt = affSource.map((m) => `${affinityWordOf(m.level)} ${m.type}`).join(' · ');
	const bits = [];
	if (classes.length) bits.push(`${totalSl} SL across ${classes.length} class${classes.length === 1 ? '' : 'es'}`);
	const lib = getAffinityLibrary(item);
	if (lib.length > 1) bits.push(`${lib.length} forms`);
	if (affTxt) bits.push(affTxt);
	return bits.join(' — ');
}

function buildGuisePanel(actor) {
	const guises = actor.items.filter(isGuiseItem);
	const activeId = getActiveGuise(actor);
	// v0.7.3: the Specialty die-bump arm/disarm control — shown only when the character has Specialties
	// (authored on their Innate Guise). One click arms the next Open/skill Check (excl. magic/accuracy).
	const specialties = actorSpecialties(actor);
	const specialtyArmed = !!actor.getFlag?.(MODULE_ID, SPECIALTY_ARM_FLAG);
	const panel = document.createElement('div');
	panel.className = 'rippers-guise-panel';
	const rows = guises.map((g) => {
		const active = g.id === activeId;
		const sub = [g.system?.data?.identity, g.system?.data?.role].filter(Boolean).map(esc).join(' — ');
		const summary = active ? guiseSummary(g) : '';
		return `<div class="rippers-guise-entry${active ? ' active' : ''}" data-guise-id="${g.id}">
			<img class="guise-icon" src="${esc(g.img || 'icons/svg/mystery-man.svg')}" width="26" height="26" />
			<div class="guise-meta">
				<span class="guise-name">${esc(g.name)}${active ? ' <span class="guise-active-badge">' + game.i18n.localize('RIPPERS.Guise.Active') + '</span>' : ''}</span>
				${sub ? `<span class="guise-sub">${sub}</span>` : ''}
				${summary ? `<span class="guise-summary">${esc(summary)}</span>` : ''}
			</div>
			<button type="button" class="guise-edit" data-guise-id="${g.id}" title="${esc(game.i18n.localize('RIPPERS.Guise.Edit'))}">
				${game.i18n.localize('RIPPERS.Guise.Edit')}
			</button>
			<button type="button" class="guise-toggle${active ? ' is-active' : ''}" data-guise-id="${g.id}">
				${game.i18n.localize(active ? 'RIPPERS.Guise.Dismiss' : 'RIPPERS.Guise.Bind')}
			</button>
		</div>`;
	}).join('');
	const specialtyBtn = specialties.length
		? `<button type="button" class="guise-specialty-arm${specialtyArmed ? ' is-active' : ''}" title="${esc(specialties.join(' · '))}">${game.i18n.localize(specialtyArmed ? 'RIPPERS.Specialty.Disarm' : 'RIPPERS.Specialty.Arm')}</button>`
		: '';
	panel.innerHTML = `<header class="items-main-header rippers-guise-header">
			<span class="items-main"><label class="items-label">${game.i18n.localize('RIPPERS.Guise.PanelTitle')}</label></span>
			${specialtyBtn}
			<button type="button" class="guise-build">${game.i18n.localize('RIPPERS.Builder.Build')}</button>
		</header>
		<div class="rippers-guise-list">${rows || `<p class="rippers-guise-empty">${game.i18n.localize('RIPPERS.Guise.NoGuises')}</p>`}</div>`;
	// The Build button opens the player-facing Guise Builder wizard.
	panel.querySelector('.guise-build')?.addEventListener('click', (ev) => { ev.preventDefault(); openGuiseBuilder(actor); });
	// #4 (v0.7.9): the per-guise Edit button reopens the wizard seeded from that guise (edit mode).
	panel.querySelectorAll('.guise-edit').forEach((btn) => btn.addEventListener('click', (ev) => {
		ev.preventDefault();
		const g = actor.items.get(btn.dataset.guiseId);
		if (g) openGuiseBuilder(actor, g);
	}));
	// The Specialty button arms/disarms the die-bump for the next check (the flag change re-renders the sheet).
	panel.querySelector('.guise-specialty-arm')?.addEventListener('click', async (ev) => {
		ev.preventDefault(); ev.currentTarget.disabled = true;
		try {
			if (actor.getFlag(MODULE_ID, SPECIALTY_ARM_FLAG)) {
				await disarmSpecialtyDieBump(actor);
			} else {
				// Let the player nominate WHICH attribute's die the Specialty improves (v0.7.6).
				const attribute = await promptSpecialtyAttribute();
				if (!attribute) { ev.currentTarget.disabled = false; return; } // cancelled — leave disarmed
				await armSpecialtyDieBump(actor, { attribute });
			}
		} catch (err) { console.error('[rippers-guise] specialty arm toggle failed:', err); ev.currentTarget.disabled = false; }
	});
	// Wire each button to the EXISTING setActiveGuise (bind/dismiss/swap).
	panel.querySelectorAll('.guise-toggle').forEach((btn) => {
		btn.addEventListener('click', async (ev) => {
			ev.preventDefault();
			btn.disabled = true;
			try { await setActiveGuise(actor, btn.dataset.guiseId); }
			catch (err) { console.error('[rippers-guise] panel toggle failed:', err); btn.disabled = false; }
			// The actor update re-renders the sheet, which re-injects the panel with fresh state.
		});
	});
	return panel;
}

/** Inject (or refresh) the Benefit-Picks + Guises panels into a character sheet's Features tab. */
function injectGuisePanel(app) {
	try {
		const actor = app?.actor;
		const root = app?.element;
		if (!actor || !root || actor.type !== 'character') return;
		// Target the Features CONTENT pane — `<div class="tab" data-tab="features">` — NOT the nav
		// link `<a class="item button-style" data-action="tab" data-tab="features">`, which carries the
		// SAME data-tab. A bare [data-tab] match hits the nav <a> first, dropping the panels into the
		// tab strip where they inherit the orange tab-pill styling. The content pane has class "tab".
		const tab = root.querySelector('.tab[data-tab="features"]')
			|| root.querySelector('[data-tab="features"]:not(a):not([data-action="tab"])');
		if (!tab) return; // features part not rendered (limited sheet etc.)
		// Idempotent: sweep ANY prior panels anywhere in this sheet before re-injecting, so a stale
		// panel (and its click listeners) can never survive a re-render and stack. The panels + their
		// buttons are freshly created below, so listeners live only on the current DOM.
		root.querySelectorAll('.rippers-guise-panel, .rippers-benefit-panel').forEach((n) => n.remove());
		const benefit = buildBenefitPanel(actor);   // always present (picks exist even with no guises)
		const guise = buildGuisePanel(actor);       // null when the character holds no guises
		const fuHeader = tab.querySelector(':scope > header.items-main-header');
		if (fuHeader) { fuHeader.after(benefit); if (guise) benefit.after(guise); }
		else { tab.prepend(benefit); if (guise) benefit.after(guise); }
	} catch (err) {
		console.error('[rippers-guise] injectGuisePanel failed:', err);
	}
}

// ---------------------------------------------------------------------------
// BENEFIT-PICK PICKER UI (v0.4.3). A player-facing ApplicationV2 dialog over the verified engine
// api (BENEFIT_POOL / getBenefitPicks / setBenefitPicks) — replaces the console setBenefitPicks step.
// UI LAYER ONLY: no AE/engine changes. The pure helpers below are unit-tested headless; the
// Application is thin (context + form-submit + client max-2 enforcement) and QA'd live in Foundry.
const RITUAL_DISCIPLINES = ['ritualism', 'arcanism', 'chimerism', 'elementalism', 'entropism', 'spiritism'];
// The NAMED second discipline the Rituals pick lets you claim (contested). Ritualism is universal and
// always granted, so it's excluded here — it's implied, never the named second (POLISH-picker-ritualism-dupe).
const RITUAL_SECOND_DISCIPLINES = RITUAL_DISCIPLINES.filter((d) => d !== 'ritualism');

/** Live summary over a SELECTION (mirrors benefitPickSummary, which reads a saved actor). Pure. */
function benefitSelectionSummary(picks, ritualDiscipline) {
	if (!picks || !picks.length) return 'No benefit picks chosen.';
	return picks.map((p) => {
		const b = BENEFIT_POOL[p];
		if (!b) return p;
		if (p === 'rituals') return ritualsLabel(ritualDiscipline);
		return b.label;
	}).join(' · ');
}

/** Build the picker's render context from the actor's current picks + the pool. Pure (needs getFlag). */
function benefitPickerContext(actor) {
	const { picks, ritualDiscipline } = getBenefitPicks(actor);
	const sel = new Set(picks);
	// The named SECOND discipline (contested) — never ritualism, which is universal/implied. Default to
	// the first real second-discipline when nothing valid is saved.
	const saved = (ritualDiscipline || '').toLowerCase();
	const disc = RITUAL_SECOND_DISCIPLINES.includes(saved) ? saved : RITUAL_SECOND_DISCIPLINES[0];
	const toOpt = (key) => ({
		key, label: BENEFIT_POOL[key].label, checked: sel.has(key),
		contested: !!BENEFIT_POOL[key].contested, both: !!BENEFIT_POOL[key].both,
		namedDiscipline: !!BENEFIT_POOL[key].namedDiscipline,
	});
	const keys = (kind) => Object.keys(BENEFIT_POOL).filter((k) => BENEFIT_POOL[k].kind === kind);
	return {
		statOptions: keys('stat').map(toOpt),
		capOptions: keys('capability').map(toOpt),
		disciplines: RITUAL_SECOND_DISCIPLINES.map((d) => ({ key: d, label: capWord(d), selected: disc === d })),
		ritualDiscipline: disc,
		summary: benefitSelectionSummary(picks, ritualDiscipline),
		max: 2,
	};
}

/** Parse the submitted form object into a {picks, ritualDiscipline}. Pure. familiar is exclusive. */
function parseBenefitForm(obj) {
	let picks = obj?.picks ?? [];
	if (typeof picks === 'string') picks = picks ? [picks] : [];
	picks = [...new Set((Array.isArray(picks) ? picks : []).filter(Boolean))];
	if (picks.includes('familiar')) picks = ['familiar']; // trades both — the only pick
	// The named second discipline is whatever the (ritualism-excluded) selector sent; empty is fine
	// (just Ritualism). Never force 'ritualism' — it's the universal art, not the named second.
	const raw = picks.includes('rituals') ? String(obj?.ritualDiscipline || '').toLowerCase() : '';
	const ritualDiscipline = raw === 'ritualism' ? '' : raw;
	return { picks, ritualDiscipline };
}

// Lazily define the ApplicationV2 subclass — foundry.applications.api is only live at runtime.
let _BenefitPickerApp = null;
function getBenefitPickerApp() {
	if (_BenefitPickerApp) return _BenefitPickerApp;
	const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
	class BenefitPickerApp extends HandlebarsApplicationMixin(ApplicationV2) {
		constructor(actor, options = {}) {
			super({ ...options, id: `rippers-benefit-picker-${actor?.id ?? 'x'}` });
			this.actor = actor;
		}
		static DEFAULT_OPTIONS = {
			classes: ['rippers-guise', 'benefit-picker'],
			tag: 'form',
			window: { title: 'RIPPERS.Benefit.PickerTitle', icon: 'fas fa-star' },
			position: { width: 440, height: 'auto' },
			form: { handler: BenefitPickerApp.onSubmit, submitOnChange: false, closeOnSubmit: true },
		};
		static PARTS = { form: { template: `modules/${MODULE_ID}/templates/benefit-picker.hbs` } };
		get title() { return `${game.i18n.localize('RIPPERS.Benefit.PickerTitle')} — ${this.actor?.name ?? ''}`; }
		async _prepareContext() { return benefitPickerContext(this.actor); }
		_onRender() {
			const root = this.element;
			const checks = [...root.querySelectorAll('input[name="picks"]')];
			const disciplineSel = root.querySelector('select[name="ritualDiscipline"]');
			const summaryEl = root.querySelector('.benefit-summary-live');
			const refresh = () => {
				const familiar = checks.some((c) => c.value === 'familiar' && c.checked);
				if (familiar) checks.forEach((c) => { if (c.value !== 'familiar') c.checked = false; });
				const chosen = checks.filter((c) => c.checked).map((c) => c.value);
				const atMax = familiar || chosen.length >= 2;
				checks.forEach((c) => { c.disabled = (familiar && c.value !== 'familiar') || (atMax && !c.checked); });
				const ritualsOn = chosen.includes('rituals');
				if (disciplineSel) disciplineSel.disabled = !ritualsOn;
				if (summaryEl) summaryEl.textContent = benefitSelectionSummary(chosen, ritualsOn ? (disciplineSel?.value || 'ritualism') : '');
			};
			checks.forEach((c) => c.addEventListener('change', refresh));
			if (disciplineSel) disciplineSel.addEventListener('change', refresh);
			refresh();
		}
		static async onSubmit(event, form, formData) {
			const { picks, ritualDiscipline } = parseBenefitForm(formData.object);
			const res = await setBenefitPicks(this.actor, { picks, ritualDiscipline });
			if (!res?.ok) { ui.notifications?.warn(`Benefit picks not saved: ${res?.reason ?? 'invalid'}`); throw new Error(res?.reason ?? 'invalid'); }
			ui.notifications?.info(`Benefit picks saved: ${benefitSelectionSummary(res.picks, ritualDiscipline)}`);
		}
	}
	_BenefitPickerApp = BenefitPickerApp;
	return BenefitPickerApp;
}
/** Open the picker for an actor (panel button / macro). */
function openBenefitPicker(actor) {
	if (!actor) return;
	try { new (getBenefitPickerApp())(actor).render(true); }
	catch (err) { console.error('[rippers-guise] openBenefitPicker failed:', err); }
}

/** The always-present Benefit-Picks panel: current summary + an Edit button that opens the picker. */
function buildBenefitPanel(actor) {
	const panel = document.createElement('div');
	panel.className = 'rippers-benefit-panel';
	// ROS-30: the Benefit header must NOT wear `rippers-guise-header` — a `.rippers-guise-header`
	// selector then matches it too, so the Guise section header reads as duplicated (one in this
	// panel, one in the guise panel). Its own class keeps identical styling (see guise.css).
	panel.innerHTML = `<header class="items-main-header rippers-benefit-header">
			<span class="items-main"><label class="items-label">${game.i18n.localize('RIPPERS.Benefit.PanelTitle')}</label></span>
		</header>
		<div class="rippers-benefit-body">
			<span class="benefit-current">${esc(benefitPickSummary(actor))}</span>
			<button type="button" class="benefit-edit">${game.i18n.localize('RIPPERS.Benefit.Edit')}</button>
		</div>`;
	panel.querySelector('.benefit-edit').addEventListener('click', (ev) => { ev.preventDefault(); openBenefitPicker(actor); });
	return panel;
}

// ---------------------------------------------------------------------------
// GUISE BUILDER (v0.5.0). A player-facing ApplicationV2 wizard to ASSEMBLE a mask: up to 3 classes
// granting SKILLS only (no benefits — a guise never materialises the class Item), a theme, and
// create/bind. Reuses the verified engine (GuiseDataModel shape + the three SL caps + bindGuise +
// dormancy). NO benefit-picking (that's the character-level picker). Affinities / equipment / §10 gear
// are deferred to the authoring sheet / Builder v2. Pure helpers below are unit-tested; the app is thin.
const DRAFT_SEP = '␟'; // separates the sl-map key "classUuid␟skillUuid"
const draftKey = (classUuid, skillUuid) => `${classUuid}${DRAFT_SEP}${skillUuid}`;

// ---------------------------------------------------------------------------
// GUISE-BUILDER-FIX (v0.7.0). Canon vocabularies + guardrail helpers (all pure/testable).
// Austin's rulings (ROS-24, 2026-08-29): Q1 add an INNATE-GUISE mode; Q2 Bane = NARRATIVE;
// Q3 D-Bonus = a provisional +3 check-type taxonomy (below); Q4 enforce EXACTLY 3 classes;
// Q5 Nature = plain text; Q6 enforce only the per-guise ≤1 Immunity; Q7 affinities are a TRIO
// (1 Immunity + 1 Vulnerability + 1 Resistance, NEVER Absorption) — the monstrous "collect forms"
// controls are removed. Cites: GUISES-core-rules.md §2 (contents + backstop), §"Perk list",
// §"Innate Guise"/"Specialties"; GUISE-v2-design.md §9.
const GUISE_MODES = Object.freeze(['worn', 'innate']);
const REQUIRED_CLASS_COUNT = 3; // core §2: "Exactly three classes, no more, no less."

// PERK is FREE TEXT (v0.7.4, Austin): a plain narrative fill-in like Tell / Bane / flaw / Nature.
// The curated 21-perk list was dropped — the player writes the perk(s) in prose.

// The two Specialties the Innate Guise carries (core §"It does carry one thing the masks don't:
// Specialties"). Choose TWO; improve one die's size on an in-subject Check. Innate-mode only.
const SPECIALTY_LIST = Object.freeze([
	'Arts', 'Crafts', 'Administration & Bureaucracy', 'Criminal Activities', 'Domestic Arts',
	'General Sciences', 'Medicine', 'Military Weapons', 'Military Science', 'Physical Sciences',
	'Seamanship', 'Mechanics & Electrical Work', 'Wilderness Survival',
]);
const SPECIALTY_COUNT = 2;
const TALENTED_SPECIALTY_COUNT = 4;
// v0.7.9 (Austin, 3 Sep): the Talented keystone doubles the two Specialties to four ("the Talented
// carry four" — Lodge mig 0121 was the app's version of this canon rule). No keystone mechanic exists
// in this ecosystem, so Talented is a build-time boolean on the Innate Guise; isTalented() is the single
// seam — re-point it if Talented later becomes a holdable Item, with no change to the count logic.
/** How many Specialties the Innate Guise carries. Pure. */
const specialtyCapFor = (talented) => (talented ? TALENTED_SPECIALTY_COUNT : SPECIALTY_COUNT);
/** Talented predicate off a builder draft (today: the innate-guise boolean). Pure. */
const draftIsTalented = (draft) => !!draft?.talented;

// SPECIALTY die-bump (v0.7.1, Austin ROS-24 follow-up). Canon (core §"Specialties"): an in-subject
// Check improves the die size of ONE die. Austin's ruling: it must NOT apply to Magic or Accuracy
// checks — only Open/skill/exploration/social/etc. Subject-match is a human judgment, so the player
// ARMS the bump for their next check; the prepareCheck hook applies it iff the check type is eligible.
// FU check types: attribute · accuracy · magic · open · opposed · group · support · ritual · display.
const SPECIALTY_EXCLUDED_CHECKS = Object.freeze(['magic', 'accuracy', 'display']); // display isn't a real check

// ── Phase 2a: the generalized check-time BUMP seam ────────────────────────────
// ONE reusable check-time mechanism, two bump KINDS:
//   'die'  — improve one attribute die's size (the Specialty / Talented / Innate consumers, v0.7.1):
//            a transient raise of actor.system.attributes[attr].current, restored post-roll.
//   'flat' — add a flat +N to the check total via FU's check.modifiers. CONFIRMED API (FoundryVTT-
//            Fabula-Ultima-dev/module/checks/checks.mjs): the system does `check.modifiers ??= []`
//            then `check.modifiers.push({label, value})`, summed at :438 (`modifierTotal`). The check
//            object is per-roll and Object.seal()'d (arrays still push), so a flat modifier needs NO
//            restore — unlike the die path. Robot's "+2 to Checks involving machines/technology/
//            constructs" is the intended 'flat' consumer (a STANDING bonus, per god's dispatch).
// Eligibility differs by kind: a die-bump never touches Magic/Accuracy (Austin's Specialty ruling);
// a flat check bonus has no such carve-out — it excludes only 'display' (not a real check). WHICH
// checks a flat bonus applies to (its SUBJECT-scope) is the CONSUMER's predicate — for Robot that
// predicate (auto-on-target-species vs player-armed relevance) is ⚠ owed pending Austin's ruling
// (flagged to god 4 Sep 2026): FU checks carry no machines/tech/constructs subject tag, so it cannot
// be inferred here. This seam deliberately leaves the predicate to the consumer.
const CHECK_BUMP_KINDS = Object.freeze(['die', 'flat']);
/** Is a bump of `kind` allowed on a check of `checkType`? Pure. (Subject-scope is the consumer's job.) */
function checkBumpEligible(kind, checkType) {
	if (!checkType || checkType === 'display') return false; // display isn't a real check
	if (kind === 'die') return !SPECIALTY_EXCLUDED_CHECKS.includes(checkType);
	return true; // 'flat': any real check (incl. magic/accuracy) — the consumer's predicate scopes it
}
/** Build one FU check-modifier entry {label, value:int} for a 'flat' bump (checks.mjs shape), or null
 *  if it would add nothing. Pure. Applied at prepareCheck via check.modifiers.push (no restore). */
function flatCheckModifier(value, label) {
	const v = Math.trunc(Number(value) || 0);
	if (!v) return null;
	return { label: String(label ?? 'RIPPERS.Specialty.Arm'), value: v };
}
// The Specialty die-bump's eligibility is now the general seam's 'die' arm (one place for the rule).
const specialtyBumpEligible = (checkType) => checkBumpEligible('die', checkType);
const CHECK_DIE_SIZES = Object.freeze([6, 8, 10, 12]); // FU attribute dice (d20 = Apex, not a Specialty target)
/** Improve an attribute die one size, capped at d12. Unknown faces pass through. Pure. */
function improveDieSize(faces) {
	const i = CHECK_DIE_SIZES.indexOf(Number(faces));
	return i >= 0 && i < CHECK_DIE_SIZES.length - 1 ? CHECK_DIE_SIZES[i + 1] : Number(faces);
}
/** Which die (primary|secondary) the bump lands on: the preferred attribute if it's in the check, else primary. Pure. */
function chooseBumpSlot(check, preferred) {
	if (preferred) { if (check?.primary === preferred) return 'primary'; if (check?.secondary === preferred) return 'secondary'; }
	return 'primary';
}

// Hunter Weapon material FLAVOUR suggestions (C3=A, 4 Sep 2026). The five canon names survive only as
// datalist suggestions for the free-text material field — pure flavour prose, no mechanics. The bane
// interaction is now the single isBane flag (see setHunterWeapon), not the material.
const HW_MATERIALS = Object.freeze(['silver', 'cold_iron', 'consecrated', 'wood', 'cursed']);

// D-Bonus is a NARRATIVE scope, not a mechanical check type (v0.7.4, Austin: "it's not a mechanical
// type of check, it's a narrative type of check"). The player writes the circumstance the +3 applies to
// (e.g. "when acting to protect a child"); the GM applies it when a check fits. No mechanical-type gating,
// no ActiveEffect. This supersedes the v0.7.2 Open/Opposed/Group selector (which was D-Bonus only — the
// Specialty die-bump's magic/accuracy exclusion is unchanged).
const BONUS_VALUE = 3;

// --- Affinity TRIO (Q7) — replaces the un-canon nine-dropdown grid + monstrous library ------------
// A guise authors up to three affinity slots: one Immunity, one Vulnerability, one Resistance.
// ABSORPTION IS NEVER OFFERED (core §2: "A Guise never grants Absorption"). The whole trio may be
// empty (a plain guise), but an Immunity MUST be paired with a Vulnerability (core §2 backstop, Q6).
const TRIO_LEVEL = Object.freeze({ immunity: 2, vulnerability: -1, resistance: 1 });

/** {immunity,vulnerability,resistance} element picks (or '') → affinityModifiers [{type,level}]. Pure. */
function affinityTrioToModifiers(trio) {
	const out = [];
	for (const [slot, level] of Object.entries(TRIO_LEVEL)) {
		const type = trio?.[slot];
		if (AFFINITY_TYPES.includes(type)) out.push({ type, level });
	}
	return out;
}

/** Validate an affinity trio against the canon backstop (Q6/Q7). Pure. Returns {ok, reason?}. */
function validateAffinityTrio(trio) {
	const picks = { immunity: trio?.immunity || '', vulnerability: trio?.vulnerability || '', resistance: trio?.resistance || '' };
	for (const [slot, type] of Object.entries(picks)) {
		if (type && !AFFINITY_TYPES.includes(type)) return { ok: false, reason: `unknown affinity type "${type}" for ${slot}` };
	}
	// No element may fill two slots at once.
	const used = Object.values(picks).filter(Boolean);
	if (new Set(used).size !== used.length) return { ok: false, reason: 'one element cannot fill two affinity slots' };
	// Backstop: an Immunity must come with a Vulnerability.
	if (picks.immunity && !picks.vulnerability) return { ok: false, reason: 'an Immunity must be paired with a Vulnerability' };
	return { ok: true };
}

/**
 * Validate a whole guise draft against the construction guardrails (Q4/Q7). Pure. mode 'worn'|'innate'.
 * Returns {ok, errors:[]} so the wizard can gate Create and show why.
 */
/** Total SL a draft's raw allocations would spend, ignoring caps (for the budget guardrail). */
function draftRawSpent(draft) {
	let n = 0;
	for (const raw of Object.values(draft?.sl ?? {})) n += Math.max(0, Math.floor(Number(raw) || 0));
	return n;
}

/** Raw SL allocated to one class (by classUuid), summed across its skills. Pure. */
function draftClassSpent(draft, classUuid) {
	let n = 0;
	for (const [key, raw] of Object.entries(draft?.sl ?? {})) {
		if (String(key).split(DRAFT_SEP)[0] !== classUuid) continue;
		n += Math.max(0, Math.floor(Number(raw) || 0));
	}
	return n;
}

function validateGuiseDraft(draft, mode = 'worn', skillMax = {}, budget = SKILL_BUDGET_CAP, { override = false } = {}) {
	const errors = [];
	const classes = (draft?.classUuids ?? []).filter(Boolean);
	if (classes.length !== REQUIRED_CLASS_COUNT) errors.push(`A guise has exactly ${REQUIRED_CLASS_COUNT} classes (has ${classes.length}).`);
	if (new Set(classes).size !== classes.length) errors.push('The three classes must be distinct.');
	// v0.7.6: every class must carry at least one skill — no piling the whole budget into one class
	// while the other two sit empty (god's ROS-24 live finding). Only meaningful once 3 distinct
	// classes are chosen; otherwise the class-count error above already covers it.
	if (classes.length === REQUIRED_CLASS_COUNT && new Set(classes).size === REQUIRED_CLASS_COUNT) {
		if (classes.some((cU) => draftClassSpent(draft, cU) <= 0)) errors.push('Each class needs at least one skill.');
	}
	// v0.7.4: no individual skill may exceed its own max SL (the live-builder cap bug — Q3).
	for (const [key, raw] of Object.entries(draft?.sl ?? {})) {
		const skillUuid = String(key).split(DRAFT_SEP)[1];
		const cap = Number(skillMax[skillUuid] ?? PER_CLASS_CAP);
		if (Number(raw) > cap) { errors.push(`A skill is set to SL ${Math.floor(Number(raw))}, above its max of ${cap}.`); break; }
	}
	// v0.7.6: the TOTAL allocation must fit the SL budget. guiseDraftToData silently clamps to it,
	// so without this the wizard would look valid while quietly dropping SL on Create.
	const spent = draftRawSpent(draft);
	if (spent > budget) errors.push(`That allocation spends ${spent} SL, over the budget of ${budget}.`);
	if (mode === 'worn') {
		const t = validateAffinityTrio({ immunity: draft?.affinityImmunity, vulnerability: draft?.affinityVulnerability, resistance: draft?.affinityResistance });
		if (!t.ok) errors.push(t.reason);
		// #3 (v0.7.9): a worn guise always carries one attached Heroic (Austin). Soft-required — the
		// module-wide GM override (#4) can waive it; existing in-world guises are not re-validated.
		if (!draft?.attachedHeroicUuid) errors.push('A worn Guise carries one attached Heroic Skill.');
	} else { // innate
		const specs = (draft?.specialties ?? []).map((s) => (s ?? '').trim()).filter(Boolean);
		const cap = specialtyCapFor(draftIsTalented(draft));
		if (specs.length !== cap) errors.push(`The Innate Guise carries exactly ${cap} Specialties (has ${specs.length}).`);
	}
	// #4 (v0.7.9): with the module-wide GM override ON, validation is SOFT — the same findings are
	// returned as `warnings` and never block Create/Next (Austin: "modifiable with an override").
	if (override) return { ok: true, errors: [], warnings: errors };
	return { ok: errors.length === 0, errors, warnings: [] };
}

/** Per-step guardrail errors, so the wizard can gate the Next button and show inline errors on the
 *  step that owns each rule — without gating Next on the whole-draft validity (which would trap you
 *  on step 1, where a guise legitimately has <3 classes). Pure. Returns { ok, errors } for stepKey. */
function guiseStepErrors(draft, mode = 'worn', skillMax = {}, budget = SKILL_BUDGET_CAP, stepKey = 'review', { override = false } = {}) {
	// Under the GM override validation is soft: no step gates (errors come back as warnings, not errors).
	const all = validateGuiseDraft(draft, mode, skillMax, budget, { override }).errors;
	const has = (frag) => all.filter((e) => frag.test(e));
	switch (stepKey) {
		case 'identity': return { ok: true, errors: [] };
		case 'classes': return okFrom(has(/\bclasses\b|must be distinct/i));
		case 'skills': return okFrom(has(/at least one skill|above its max|over the budget/i));
		case 'loadout': return okFrom(mode === 'innate' ? has(/Specialties/i) : has(/attached Heroic/i));
		case 'affinities': return okFrom(mode === 'worn' ? has(/Immunity|Vulnerability|Resistance|Absorption|affinit/i) : []);
		case 'review': default: return { ok: all.length === 0, errors: all };
	}
	function okFrom(errs) { return { ok: errs.length === 0, errors: errs }; }
}

function emptyGuiseDraft() {
	return {
		mode: 'worn', // 'worn' (a mask) | 'innate' (the face under the masks, Q1)
		name: '', role: '', nature: '', notes: '', img: 'icons/svg/mystery-man.svg', color: '', classUuids: [], sl: {}, spells: {},
		// worn-guise fields (Q1: none of these belong on the Innate Guise)
		equipment: [], // [{itemUuid, slot}] — armor / two hands / accessory (was hardcoded [] — the P2 bug)
		perk: '', bonusDescriptor: '', tell: '', bane: '', flaw: '',
		// #3 (v0.7.9): every worn guise carries ONE guise-native ("signature") Heroic — its own,
		// distinct from the character's heroics; materialised on bind so its effect rides while worn.
		attachedHeroicUuid: '', attachedHeroicName: '',
		// #5 (v0.7.9): effects/abilities that TRAVEL with the guise — [{itemUuid, name}]. Effect-bearing
		// Items (e.g. Greater Akromorphosis) that switch ON when the guise is worn and OFF when it's not.
		attachedEffects: [],
		// affinity TRIO (Q7) — element keys or '' ; Absorption is never representable
		affinityImmunity: '', affinityVulnerability: '', affinityResistance: '',
		// innate-guise fields (Q1) + the Hunter Weapon (v0.7.1)
		specialties: [], talented: false, innateHeroicUuid: '',
		hunterWeaponUuid: '', hunterWeaponName: '', hunterMaterial: '', hunterOrigin: '', hunterIsBane: false,
		// innate armor + accessory (#2, v0.7.9): authored Item refs, materialised + equipped on the actor
		armorUuid: '', armorName: '', accessoryUuid: '', accessoryName: '',
	};
}

/** Parse a compendium class Item's description HTML into its skill list. Pure.
 *  Matches @UUID[...]{Name} optionally followed by a 【Max SL N】 badge. */
function parseClassSkills(descHtml) {
	const out = [];
	const re = /@UUID\[([^\]]+)\]\{([^}]+)\}(?:\s*<strong>【Max SL (\d+)】<\/strong>)?/g;
	let m;
	while ((m = re.exec(String(descHtml ?? '')))) {
		// No 【Max SL N】 badge ⇒ single-rank skill: the compendium generator
		// (build-compendium.mjs) omits the badge ONLY for max_sl=1 by documented
		// convention, so a missing badge means cap 1, not an unbounded 10.
		out.push({ uuid: m[1], name: m[2], maxSl: m[3] ? Math.max(1, parseInt(m[3], 10)) : 1 });
	}
	return out;
}

/** Resolve a class ref (uuid or doc) to its skills [{uuid,name,maxSl}]. Async. */
async function skillsForClass(classRef) {
	const doc = (classRef && typeof classRef === 'object') ? classRef : await safeFromUuid(classRef);
	if (!doc) return [];
	return parseClassSkills(doc.system?.description ?? '');
}

// ── v0.7.30 SPELL AUTO-MATERIALIZATION: compendium spell index (mirrors skillsForClass) ────────────
// The compendium's `spells` pack (built by rippers-compendium PACK 4) is the single source: each spell
// Item carries flags.rippers-compendium.{spellKey, discipline, classKey, grantingSkillKey, heroic}. We
// build a grantingSkillKey → [{uuid,name,...}] map ONCE (index-only load, cached) so the guise editor's
// spell picker and any "is this a caster skill?" check read from it synchronously. No spell values are
// duplicated in this module; everything is read from the compendium the guise is already coupled to.
const SPELL_PACK = 'rippers-compendium.spells';
const SPELL_FLAG_NS = 'rippers-compendium';
let _spellIndexCache = null;
async function loadSpellIndex() {
	if (_spellIndexCache) return _spellIndexCache;
	const pack = globalThis.game?.packs?.get?.(SPELL_PACK);
	if (!pack) return (_spellIndexCache = []);
	let idx = [];
	try { idx = [...(await pack.getIndex({ fields: [`flags.${SPELL_FLAG_NS}`] }))]; }
	catch (err) { console.warn('[rippers-guise] spell index load failed:', err); return (_spellIndexCache = []); }
	_spellIndexCache = idx.map((e) => {
		const f = e.flags?.[SPELL_FLAG_NS] ?? {};
		return { uuid: `Compendium.${SPELL_PACK}.Item.${e._id}`, name: e.name ?? '', spellKey: f.spellKey ?? '', discipline: f.discipline ?? '', grantingSkillKey: f.grantingSkillKey ?? '', heroic: !!f.heroic };
	});
	return _spellIndexCache;
}
/** The set of granting_skill_keys that have spells (i.e. which skill fuids are spellcasting). */
async function spellGrantingSkillKeys() {
	const idx = await loadSpellIndex();
	return new Set(idx.map((s) => s.grantingSkillKey).filter(Boolean));
}
/** Spells a given granting skill (by its fuid/skill_key) can pick from, sorted by name. Async. */
async function spellsForSkill(grantingSkillKey) {
	if (!grantingSkillKey) return [];
	const idx = await loadSpellIndex();
	return idx.filter((s) => s.grantingSkillKey === grantingSkillKey).sort((a, b) => a.name.localeCompare(b.name));
}

/** Build GuiseDataModel data from a builder draft, applying the three SL caps (per-skill maxSl,
 *  per-class <=10, total <= budget). Pure. skillMax: {skillUuid: maxSl}. Caps mirror materialiseSkills. */
function guiseDraftToData(draft, skillMax = {}, budget = SKILL_BUDGET_CAP) {
	const mode = GUISE_MODES.includes(draft?.mode) ? draft.mode : 'worn';
	const classes = [];
	let spent = 0;
	for (const classUuid of (draft.classUuids ?? []).filter(Boolean).slice(0, REQUIRED_CLASS_COUNT)) {
		let perClass = 0;
		const skills = [];
		for (const [key, rawSl] of Object.entries(draft.sl ?? {})) {
			const [cU, sU] = key.split(DRAFT_SEP);
			if (cU !== classUuid || !sU) continue;
			let sl = Math.max(0, Math.floor(Number(rawSl) || 0));
			if (sl <= 0) continue;
			sl = Math.min(sl, Number(skillMax[sU] ?? 10), PER_CLASS_CAP - perClass, budget - spent);
			if (sl <= 0) continue;
			perClass += sl; spent += sl;
			// v0.7.30: carry the picked spells for a spellcasting skill, capped at the (clamped) SL.
			const picked = (draft.spells?.[key] ?? []).filter(Boolean).slice(0, sl);
			skills.push(picked.length ? { skillUuid: sU, sl, spellUuids: picked } : { skillUuid: sU, sl });
		}
		classes.push({ classUuid, skills });
	}

	// The Innate Guise (Q1) carries NO affinities, NO armor/hands/accessory, NO Nature/Tell/flaw/bane/Perk
	// — only Specialties + the creation Heroic (heroic assigned actor-side in createGuiseFromDraft).
	if (mode === 'innate') {
		// v0.7.9: free text — no whitelist gate; trim, drop empties, cap at the Specialty count (4 if Talented).
		const talented = draftIsTalented(draft);
		const specialties = (draft.specialties ?? []).map((s) => (s ?? '').trim()).filter(Boolean).slice(0, specialtyCapFor(talented));
		const hunterMaterial = String(draft.hunterMaterial ?? '').trim(); // C3=A: free-text flavour, no enum gate
		return {
			mode, identity: draft.name ?? '', role: draft.role ?? '', nature: '', notes: draft.notes ?? '',
			classes, equipment: [], affinityModifiers: [],
			affinityMode: 'modify', affinitySets: [], affinitySetCap: null, affinityCapSkill: '',
			perk: '', bonus: null, tell: '', bane: '', flaw: '',
			specialties, talented, innateHeroicUuid: draft.innateHeroicUuid ?? '',
			// v0.7.36: the INNATE guise may carry attachable effects too (Austin). Same field + same
			// bind-time machinery as a worn guise — the innate guise is the active guise while unmasked, so
			// materialiseAttachedEffects rides them on at bind and _dismissCore strips them when a mask is
			// worn (displaced-while-masked / restored-on-unmask, consistent with innate gear + skills).
			attachedEffects: (draft.attachedEffects ?? []).filter((e) => e?.itemUuid).map((e) => ({ itemUuid: e.itemUuid })),
			// Hunter Weapon (v0.7.1): the weapon is materialised + marked in createGuiseFromDraft.
			hunterWeaponUuid: draft.hunterWeaponUuid ?? '', hunterMaterial, hunterOrigin: draft.hunterOrigin ?? '', hunterIsBane: !!draft.hunterIsBane,
			// #2 (v0.7.9): innate armor + accessory refs, materialised + equipped in createGuiseFromDraft.
			armorUuid: draft.armorUuid ?? '', accessoryUuid: draft.accessoryUuid ?? '',
		};
	}

	// A worn guise: equipment (was hardcoded [] — the P2 bug) + the affinity TRIO + narrative fields.
	const equipment = (draft.equipment ?? [])
		.filter((e) => e?.itemUuid)
		.map((e) => ({ itemUuid: e.itemUuid, slot: EQUIP_SLOTS.includes(e.slot) ? e.slot : 'mainHand' }));
	const affinityModifiers = affinityTrioToModifiers({
		immunity: draft.affinityImmunity, vulnerability: draft.affinityVulnerability, resistance: draft.affinityResistance,
	});
	const perk = (draft.perk ?? '').trim();
	const bonusDescriptor = (draft.bonusDescriptor ?? '').trim();
	const bonus = bonusDescriptor ? { descriptor: bonusDescriptor, value: BONUS_VALUE } : null;
	return {
		mode, identity: draft.name ?? '', role: draft.role ?? '', nature: draft.nature ?? '', notes: draft.notes ?? '',
		classes, equipment, affinityModifiers,
		// The monstrous "replace/collect forms" path is removed from the builder (Q7): always MODIFY, no sets.
		affinityMode: 'modify', affinitySets: [], affinitySetCap: null, affinityCapSkill: '',
		perk, bonus, tell: draft.tell ?? '', bane: draft.bane ?? '', flaw: draft.flaw ?? '',
		specialties: [], innateHeroicUuid: '',
		// #3 (v0.7.9): the guise-native attached Heroic (materialised on bind in _bindCore).
		attachedHeroicUuid: draft.attachedHeroicUuid ?? '',
		// #5 (v0.7.9): effects that ride the guise (materialised on bind, removed on dismiss).
		attachedEffects: (draft.attachedEffects ?? []).filter((e) => e?.itemUuid).map((e) => ({ itemUuid: e.itemUuid })),
	};
}

/** The INVERSE of guiseDraftToData (#4, v0.7.9): read a guise Item's system.data back into a builder
 *  draft, so an existing guise can be re-opened in the wizard and edited. Pure — it carries the UUIDs;
 *  display names / img are enriched async by draftFromGuiseItem. Round-trip stable: for any output D of
 *  guiseDraftToData, guiseDraftToData(guiseDataToDraft(D)) deep-equals D. */
function guiseDataToDraft(data = {}) {
	const mode = GUISE_MODES.includes(data.mode) ? data.mode : 'worn';
	const draft = emptyGuiseDraft();
	draft.mode = mode;
	draft.name = data.identity ?? '';
	draft.role = data.role ?? '';
	draft.nature = mode === 'innate' ? '' : (data.nature ?? '');
	draft.notes = data.notes ?? '';
	// classes + the sl-map (classUuid␟skillUuid -> sl), rebuilt in the same order guiseDraftToData emits.
	draft.classUuids = (data.classes ?? []).map((c) => c.classUuid).filter(Boolean);
	draft.sl = {};
	draft.spells = {};   // v0.7.30: rebuild the picked-spells map (draftKey -> [spellUuid]) for re-edit
	for (const cls of data.classes ?? []) {
		for (const sk of cls.skills ?? []) {
			if (cls.classUuid && sk.skillUuid && Number(sk.sl) > 0) {
				const k = draftKey(cls.classUuid, sk.skillUuid);
				draft.sl[k] = Number(sk.sl);
				if ((sk.spellUuids ?? []).length) draft.spells[k] = [...sk.spellUuids];
			}
		}
	}
	if (mode === 'innate') {
		draft.specialties = (data.specialties ?? []).map((s) => s ?? '');
		draft.talented = !!data.talented;
		draft.innateHeroicUuid = data.innateHeroicUuid ?? '';
		draft.hunterWeaponUuid = data.hunterWeaponUuid ?? '';
		draft.hunterMaterial = data.hunterMaterial ?? '';
		draft.hunterOrigin = data.hunterOrigin ?? '';
		draft.hunterIsBane = !!data.hunterIsBane;
		draft.armorUuid = data.armorUuid ?? '';
		draft.accessoryUuid = data.accessoryUuid ?? '';
		return draft;
	}
	// worn: equipment + the affinity trio + narrative + attached heroic/effects
	draft.equipment = (data.equipment ?? []).filter((e) => e?.itemUuid)
		.map((e) => ({ itemUuid: e.itemUuid, slot: EQUIP_SLOTS.includes(e.slot) ? e.slot : 'mainHand' }));
	for (const m of data.affinityModifiers ?? []) {
		if (!AFFINITY_TYPES.includes(m.type)) continue;
		if (Number(m.level) === TRIO_LEVEL.immunity) draft.affinityImmunity = m.type;
		else if (Number(m.level) === TRIO_LEVEL.vulnerability) draft.affinityVulnerability = m.type;
		else if (Number(m.level) === TRIO_LEVEL.resistance) draft.affinityResistance = m.type;
	}
	draft.perk = data.perk ?? '';
	draft.bonusDescriptor = data.bonus?.descriptor ?? '';
	draft.tell = data.tell ?? '';
	draft.bane = data.bane ?? '';
	draft.flaw = data.flaw ?? '';
	draft.attachedHeroicUuid = data.attachedHeroicUuid ?? '';
	draft.attachedEffects = (data.attachedEffects ?? []).filter((e) => e?.itemUuid).map((e) => ({ itemUuid: e.itemUuid }));
	return draft;
}

/** Enrich a pure guiseDataToDraft with an Item's display fields (img, colour, chip names). Async —
 *  resolves each authored UUID to a name for the builder chips. Used by openGuiseBuilder for edit. */
async function draftFromGuiseItem(item) {
	const draft = guiseDataToDraft(item?.system?.data ?? {});
	draft.img = item?.img || draft.img;
	const color = item?.getFlag?.(MODULE_ID, 'color');
	if (color) draft.color = color;
	const nameOf = async (uuid) => (uuid ? (await safeFromUuid(uuid))?.name ?? '' : '');
	if (draft.mode === 'innate') {
		draft.innateHeroicName = await nameOf(draft.innateHeroicUuid);
		draft.hunterWeaponName = await nameOf(draft.hunterWeaponUuid);
		draft.armorName = await nameOf(draft.armorUuid);
		draft.accessoryName = await nameOf(draft.accessoryUuid);
	} else {
		draft.attachedHeroicName = await nameOf(draft.attachedHeroicUuid);
		for (const e of draft.equipment) e.name = await nameOf(e.itemUuid);
		for (const e of draft.attachedEffects) e.name = await nameOf(e.itemUuid);
	}
	return draft;
}

// ── Innate-kit materialisation (shared by createGuiseFromDraft + reconcileInnateKit, #2 v0.7.9) ──
// The innate guise's char-side kit — creation heroic / Hunter Weapon / innate armour + accessory —
// belongs to the CHARACTER (the face under the masks), not the guise. These three helpers own the
// "make it real on the actor" step so create and the post-creation edit reconcile can never diverge.

/** Materialise the creation Heroic as an owned Item and seat it in the `creation` heroic slot
 *  (assignHeroicSlot refuses creation_banned heroics). A worn guise NEVER carries a heroic — "No
 *  Guise grants a Heroic Skill, ever" (core). Returns the heroic Item, or null. */
async function materialiseCreationHeroic(actor, uuid) {
	if (!actor || !uuid) return null;
	try {
		const src = await safeFromUuid(uuid);
		if (!src || src.type !== 'heroic') { ui.notifications?.warn('The creation Heroic must be a heroic Item.'); return null; }
		const obj = src.toObject(); delete obj._id;
		const [heroic] = await actor.createEmbeddedDocuments('Item', [obj]);
		if (!heroic) return null;
		const res = await assignHeroicSlot(actor, 'creation', heroic);
		if (!res?.ok) { await heroic.delete(); return null; } // banned/refused — don't leave an orphan
		return heroic;
	} catch (err) { console.warn('[rippers-guise] innate creation-heroic assignment failed:', err); return null; }
}

/** Materialise the Hunter Weapon as an owned Item and mark it (setHunterWeapon sets isHunterWeapon +
 *  material→bane key + origin). It belongs to the CHARACTER, so it is a plain owned weapon (not a
 *  guise-origin item). Returns the weapon Item, or null. */
async function materialiseHunterWeapon(actor, uuid, { material, origin, isBane } = {}) {
	if (!actor || !uuid) return null;
	try {
		const src = await safeFromUuid(uuid);
		if (!src || !(src.type === 'weapon' || src.type === 'customWeapon')) { ui.notifications?.warn('The Hunter Weapon must be a weapon Item.'); return null; }
		const obj = src.toObject(); delete obj._id;
		const [weapon] = await actor.createEmbeddedDocuments('Item', [obj]);
		if (weapon) await setHunterWeapon(weapon, { material: material || undefined, origin: origin || undefined, isBane });
		return weapon ?? null;
	} catch (err) { console.warn('[rippers-guise] Hunter Weapon materialisation failed:', err); return null; }
}

/** Materialise one innate equip slot (armor|accessory) as an owned Item flagged innateEquip and equip
 *  it. Like the Hunter Weapon these belong to the CHARACTER; a worn mask's own equipment displaces
 *  them on bind and preBindEquip restores them on dismiss (existing snapshot/restore machinery). */
async function materialiseInnateEquip(actor, slot, uuid, { equip = true } = {}) {
	if (!actor || !uuid || !EQUIP_INNATE_SLOTS.includes(slot)) return null;
	try {
		const src = await safeFromUuid(uuid);
		if (!src) { console.warn(`[rippers-guise] innate ${slot} ref not found: ${uuid}`); return null; }
		if (src.type !== slot) { ui.notifications?.warn(`The Innate Guise ${slot} must be ${slot === 'armor' ? 'an armor' : 'an accessory'} Item.`); return null; }
		const obj = src.toObject(); delete obj._id;
		obj.flags = obj.flags ?? {}; obj.flags[MODULE_ID] = { innateEquip: slot };
		const [created] = await actor.createEmbeddedDocuments('Item', [obj]);
		// `equip:false` when a mask is worn: the mask owns the slot right now, so don't displace it —
		// the caller repoints preBindEquip instead so this equips on dismiss (#3 fold-in fix).
		if (created && equip) await actor.update({ [`system.equipped.${slot}`]: created.id });
		return created ?? null;
	} catch (err) { console.warn(`[rippers-guise] innate ${slot} materialisation failed:`, err); return null; }
}
const EQUIP_INNATE_SLOTS = ['armor', 'accessory'];

/** Create the guise classFeature Item on the actor from a draft; optionally bind it. Async. */
async function createGuiseFromDraft(actor, draft, { skillMax = {}, bind = false } = {}) {
	if (!actor) return null;
	const data = guiseDraftToData(draft, skillMax, budgetOf(actor));
	const mode = data.mode ?? 'worn';
	const [item] = await actor.createEmbeddedDocuments('Item', [{
		type: 'classFeature',
		name: data.identity || (mode === 'innate' ? 'Innate Guise' : 'New Guise'),
		img: draft.img || 'icons/svg/mystery-man.svg',
		system: { featureType: FEATURE_TYPE, data },
		flags: { [MODULE_ID]: { schemaVersion: 2, isInnate: mode === 'innate', ...(draft.color ? { color: draft.color } : {}) } },
	}]);
	// Innate-Guise mode (Q1 / v0.7.1 / #2): materialise the char-side kit — creation heroic, Hunter
	// Weapon, innate armour + accessory. A worn guise never carries any of these.
	if (item && mode === 'innate') {
		if (data.innateHeroicUuid) await materialiseCreationHeroic(actor, data.innateHeroicUuid);
		if (data.hunterWeaponUuid) await materialiseHunterWeapon(actor, data.hunterWeaponUuid, { material: data.hunterMaterial, origin: data.hunterOrigin, isBane: data.hunterIsBane });
		for (const slot of EQUIP_INNATE_SLOTS) {
			const uuid = slot === 'armor' ? data.armorUuid : data.accessoryUuid;
			if (uuid) await materialiseInnateEquip(actor, slot, uuid);
		}
	}
	if (item && bind) await bindGuise(actor, item);
	return item;
}

/** The PURE reconcile decision (#2, v0.7.9): compare an innate guise's OLD vs NEW authored kit refs
 *  and report which char-side items must change. Kept pure + exported so the destructive reconcile's
 *  logic is unit-testable headless. A Hunter Weapon whose UUID is unchanged but whose material/origin
 *  moved is RETAGGED in place (op:'retag') — never delete+remade — so its slotted hoplospheres survive.
 *  Any ref that changed (added, cleared, or swapped) yields an entry; unchanged refs yield null. */
function innateKitReconcilePlan(oldData = {}, newData = {}) {
	const s = (v) => String(v ?? '');
	const plan = { heroic: null, hunterWeapon: null, armor: null, accessory: null };
	if (s(oldData.innateHeroicUuid) !== s(newData.innateHeroicUuid)) {
		plan.heroic = { from: s(oldData.innateHeroicUuid), to: s(newData.innateHeroicUuid) };
	}
	const owUuid = s(oldData.hunterWeaponUuid), nwUuid = s(newData.hunterWeaponUuid);
	if (owUuid !== nwUuid) {
		plan.hunterWeapon = { op: 'remake', from: owUuid, to: nwUuid, material: s(newData.hunterMaterial), origin: s(newData.hunterOrigin), isBane: !!newData.hunterIsBane };
	} else if (nwUuid && (s(oldData.hunterMaterial) !== s(newData.hunterMaterial) || s(oldData.hunterOrigin) !== s(newData.hunterOrigin) || !!oldData.hunterIsBane !== !!newData.hunterIsBane)) {
		plan.hunterWeapon = { op: 'retag', material: s(newData.hunterMaterial), origin: s(newData.hunterOrigin), isBane: !!newData.hunterIsBane };
	}
	for (const slot of EQUIP_INNATE_SLOTS) {
		const key = slot === 'armor' ? 'armorUuid' : 'accessoryUuid';
		if (s(oldData[key]) !== s(newData[key])) plan[slot] = { from: s(oldData[key]), to: s(newData[key]) };
	}
	return plan;
}
const innateKitPlanIsEmpty = (p) => !p.heroic && !p.hunterWeapon && !p.armor && !p.accessory;

/** Apply the reconcile plan destructively on the actor (#2, v0.7.9). Post-creation edits to an innate
 *  guise's kit delete the stale char-side Item and materialise the new one, EXACTLY as create does.
 *  THE CARE POINT: the creation heroic is dormant-while-masked (a worn mask sleeps it via
 *  suppressCreationHeroic → DORMANT_HEROIC_FLAG). A swap must NOT wake it: we capture whether the
 *  heroic is currently dormant, clear the stale snapshot before deleting (so a later dismiss never
 *  targets a deleted id), then RE-SLEEP the new heroic if it was dormant — preserving the invariant. */
async function reconcileInnateKit(actor, oldData = {}, newData = {}) {
	if (!actor) return { changed: [] };
	const plan = innateKitReconcilePlan(oldData, newData);
	if (innateKitPlanIsEmpty(plan)) return { changed: [] };
	const changed = [];

	// --- Creation heroic (dormancy-sensitive) ---
	if (plan.heroic) {
		const wasDormant = !!actor.getFlag(MODULE_ID, DORMANT_HEROIC_FLAG);
		const curId = getHeroicSlots(actor).creation;
		const cur = curId ? actor.items.get(curId) : null;
		if (cur) {
			// clear the dormancy snapshot FIRST so a later dismiss can't restore a deleted heroic
			if (wasDormant) await actor.unsetFlag(MODULE_ID, DORMANT_HEROIC_FLAG);
			await clearHeroicSlot(actor, 'creation');
			await cur.delete();
		}
		if (plan.heroic.to) {
			const heroic = await materialiseCreationHeroic(actor, plan.heroic.to);
			// preserve dormant-while-masked: if the old heroic slept under a worn mask, sleep the new one too
			if (heroic && wasDormant) await suppressCreationHeroic(actor);
		}
		changed.push('heroic');
	}

	// --- Hunter Weapon (retag in place, or remake) ---
	if (plan.hunterWeapon) {
		const existing = actor.items.find((i) => isHunterWeapon(i)) ?? null;
		if (plan.hunterWeapon.op === 'retag') {
			if (existing) await setHunterWeapon(existing, { material: plan.hunterWeapon.material || undefined, origin: plan.hunterWeapon.origin || undefined, isBane: plan.hunterWeapon.isBane });
		} else {
			if (existing) await existing.delete();
			if (plan.hunterWeapon.to) await materialiseHunterWeapon(actor, plan.hunterWeapon.to, { material: plan.hunterWeapon.material, origin: plan.hunterWeapon.origin, isBane: plan.hunterWeapon.isBane });
		}
		changed.push('hunterWeapon');
	}

	// --- Innate armour + accessory (unequip + delete the old, equip the new) ---
	// #3 fold-in fix: when a worn mask has DISPLACED the innate slot, its preBindEquip restore-snapshot
	// still names the now-deleted innate Item. While masked we don't re-equip (the mask owns the slot);
	// instead we REPOINT the snapshot to the new Item (or null), so dismiss restores the NEW innate kit.
	const masked = !!getActiveGuise(actor);
	for (const slot of EQUIP_INNATE_SLOTS) {
		if (!plan[slot]) continue;
		const oldIds = [];
		for (const it of actor.items.filter((i) => i?.getFlag?.(MODULE_ID, 'innateEquip') === slot)) {
			oldIds.push(it.id);
			if (actor.system?.equipped?.[slot] === it.id) await actor.update({ [`system.equipped.${slot}`]: null });
			await it.delete();
		}
		let newId = null;
		if (plan[slot].to) { const created = await materialiseInnateEquip(actor, slot, plan[slot].to, { equip: !masked }); newId = created?.id ?? null; }
		if (masked) {
			const snap = actor.getFlag(MODULE_ID, 'preBindEquip');
			if (snap && oldIds.includes(snap[slot])) await actor.update({ [`flags.${MODULE_ID}.preBindEquip.${slot}`]: newId });
		}
		changed.push(slot);
	}

	return { changed };
}

// ---------------------------------------------------------------------------
// Guise Builder WIZARD (Phase 2, GUISE-BUILDER-WIZARD). One concern per screen;
// only the active step scrolls, so no loadout can overflow the window. These
// pure helpers carry the step model + affinity-draft edits so they are unit-
// testable headless (the ApplicationV2 subclass below is runtime-only).
const WIZARD_STEPS = [
	{ key: 'identity',   label: 'Identity' },
	{ key: 'classes',    label: 'Classes' },
	{ key: 'skills',     label: 'Skills' },
	{ key: 'loadout',    label: 'Loadout' },     // worn: equipment + Perk/Bonus/Tell/Bane/Flaw; innate: Specialties + Heroic
	{ key: 'affinities', label: 'Affinities' },  // worn: the trio; innate: none (skipped in content)
	{ key: 'review',     label: 'Review' },
];
/** Clamp a step number into 1..WIZARD_STEPS.length. Pure. */
const clampWizardStep = (n) => Math.min(WIZARD_STEPS.length, Math.max(1, Math.floor(Number(n) || 1)));

/** Current level (-1..3, 0 = none) of `type` in an affinity set. Pure. */
function affinityLevelOf(set, type) {
	const a = (set?.affinities ?? []).find((x) => x?.type === type);
	return a ? Number(a.level) : 0;
}
/** Return a NEW affinities array with `type` set to `level`. level 0/none (or an illegal type/level)
 *  removes the entry, so the set stays valid per validateAffinitySet. Pure. */
function withAffinityLevel(affinities, type, level) {
	const lvl = Number(level);
	const rest = (Array.isArray(affinities) ? affinities : []).filter((a) => a?.type !== type);
	if (!AFFINITY_TYPES.includes(type) || !AFFINITY_VALUES.has(lvl) || lvl === 0) return rest;
	return [...rest, { type, level: lvl }];
}
/** A fresh, valid, empty affinity set with the given id (and optional name). Pure. */
function newAffinitySet(id, name = '') { return { id: String(id ?? ''), name: String(name ?? ''), affinities: [] }; }

// Lazily define the wizard — foundry.applications.api is only live at runtime.
let _GuiseBuilderApp = null;
function getGuiseBuilderApp() {
	if (_GuiseBuilderApp) return _GuiseBuilderApp;
	const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
	class GuiseBuilderApp extends HandlebarsApplicationMixin(ApplicationV2) {
		constructor(actor, options = {}) {
			super({ ...options, id: `rippers-guise-builder-${actor?.id ?? 'x'}` });
			this.actor = actor;
			this._draft = emptyGuiseDraft();
			this._classSkills = {}; // classUuid -> [{uuid,name,maxSl}]
			this._step = 1;         // active wizard step (1..WIZARD_STEPS.length)
			this._editingId = null; // #4: the id of the guise Item being edited (null = create a new one)
			this._gmOverride = false; // G2: TRANSIENT per-session GM override (right-click a fixed field);
			                          // never persisted, no stored mark — dies with the builder instance.
		}
		static DEFAULT_OPTIONS = {
			classes: ['rippers-guise', 'guise-builder'],
			tag: 'form',
			window: { title: 'RIPPERS.Builder.Title', icon: 'fas fa-mask' },
			position: { width: 540, height: 'auto' },
			actions: {
				create: GuiseBuilderApp.onCreate, createBind: GuiseBuilderApp.onCreateBind,
				back: GuiseBuilderApp.onBack, next: GuiseBuilderApp.onNext,
				pickImg: GuiseBuilderApp.onPickImg,
			},
		};
		static PARTS = { form: { template: `modules/${MODULE_ID}/templates/guise-builder.hbs` } };
		get title() { return `${game.i18n.localize('RIPPERS.Builder.Title')} — ${this.actor?.name ?? ''}`; }

		async _prepareContext() {
			const pack = game.packs?.get('rippers-compendium.classes');
			const index = pack ? [...(await pack.getIndex())] : [];
			const classOptions = index
				.map((e) => ({ uuid: `Compendium.rippers-compendium.classes.Item.${e._id}`, name: e.name }))
				.sort((a, b) => a.name.localeCompare(b.name));
			const chosen = this._draft.classUuids.filter(Boolean);
			for (const cU of chosen) if (!this._classSkills[cU]) this._classSkills[cU] = await skillsForClass(cU);
			// v0.7.30 SPELL AUTO-MATERIALIZATION: which of the chosen classes' skills are spellcasting
			// granting skills, and their pickable spells. Loaded ONCE, cached on the instance (skill fuids
			// + the caster-key set + spells per granting key). No spell values duplicated — read from the
			// compendium spells pack. Silently empty if the compendium/pack is absent (headless/tests).
			if (!this._casterKeys) this._casterKeys = await spellGrantingSkillKeys();
			this._skillFuid ??= {};
			this._spellsBySkillKey ??= {};
			for (const cU of chosen) {
				for (const s of (this._classSkills[cU] ?? [])) {
					if (this._skillFuid[s.uuid] === undefined) this._skillFuid[s.uuid] = (await safeFromUuid(s.uuid))?.system?.fuid ?? '';
					const gk = this._skillFuid[s.uuid];
					if (gk && this._casterKeys.has(gk) && !this._spellsBySkillKey[gk]) this._spellsBySkillKey[gk] = await spellsForSkill(gk);
				}
			}
			const budget = budgetOf(this.actor);
			const skillMax = this._skillMax();
			const data = guiseDraftToData(this._draft, skillMax, budget);
			const spent = data.classes.reduce((a, c) => a + c.skills.reduce((x, s) => x + s.sl, 0), 0);
			const none = game.i18n.localize('RIPPERS.Builder.NoClass');
			const slots = [0, 1, 2].map((i) => ({
				i,
				options: [{ uuid: '', name: none, selected: !chosen[i] }]
					.concat(classOptions.map((o) => ({ ...o, selected: o.uuid === (chosen[i] ?? '') }))),
			}));
			const classBlocks = chosen.map((cU) => ({
				name: classOptions.find((o) => o.uuid === cU)?.name ?? '(class)',
				skills: (this._classSkills[cU] ?? []).map((s) => {
					// Display clamp (belt-and-suspenders with the input handler): never show an over-max SL.
					const key = draftKey(cU, s.uuid);
					const sl = Math.min(Math.max(0, Math.floor(Number(this._draft.sl[key]) || 0)), Number(s.maxSl ?? PER_CLASS_CAP));
					const gk = this._skillFuid[s.uuid];
					const isCaster = !!(gk && this._casterKeys.has(gk));
					const picked = (this._draft.spells?.[key] ?? []).filter(Boolean);
					const spellOptions = isCaster ? (this._spellsBySkillKey[gk] ?? []).map((sp) => ({ uuid: sp.uuid, name: sp.name, picked: picked.includes(sp.uuid) })) : [];
					return { ...s, sl, key, checked: sl > 0, isCaster, spellCap: sl, pickedCount: Math.min(picked.length, sl), spellOptions };
				}),
			}));

			// ---- wizard step model (Phase 2) ------------------------------------
			const step = clampWizardStep(this._step);
			const stepKey = WIZARD_STEPS[step - 1].key;
			const steps = WIZARD_STEPS.map((s, i) => ({
				n: i + 1, label: s.label, key: s.key,
				active: i + 1 === step, done: i + 1 < step,
			}));

			// ---- mode (Q1: worn mask vs the Innate Guise) -----------------------
			const mode = GUISE_MODES.includes(this._draft.mode) ? this._draft.mode : 'worn';
			const isInnate = mode === 'innate';

			// ---- affinities step: the TRIO (Q7). Never Absorption; Immunity⇒Vulnerability. ----
			const capT = (t) => t.charAt(0).toUpperCase() + t.slice(1);
			const affElementOpts = (cur) => [{ value: '', label: game.i18n.localize('RIPPERS.Builder.AffNone') }]
				.concat(AFFINITY_TYPES.map((t) => ({ value: t, label: capT(t) })))
				.map((o) => ({ ...o, selected: o.value === (cur || '') }));
			const trio = {
				immunity: affElementOpts(this._draft.affinityImmunity),
				vulnerability: affElementOpts(this._draft.affinityVulnerability),
				resistance: affElementOpts(this._draft.affinityResistance),
			};
			const trioValid = validateAffinityTrio({
				immunity: this._draft.affinityImmunity, vulnerability: this._draft.affinityVulnerability, resistance: this._draft.affinityResistance,
			});

			// ---- loadout step view model ----------------------------------------
			const slotChoices = EQUIP_SLOTS.map((s) => ({ value: s, label: game.i18n.localize(`RIPPERS.Builder.Slot.${s}`) }));
			const equipment = (this._draft.equipment ?? []).map((eq, i) => ({
				i, uuid: eq.itemUuid, name: eq.name ?? eq.itemUuid,
				slots: slotChoices.map((c) => ({ ...c, selected: c.value === eq.slot })),
			}));
			// v0.7.34: an editable dropdown for EVERY equipment slot of a WORN guise (Austin — was armor-only).
			// Options come from every equip-eligible Item (world + compendia), filtered per slot to its allowed
			// types, the current pick pre-selected (and preserved if the enumeration misses it). Loaded once.
			const equipItems = isInnate ? [] : await this._loadEquipOptions();
			const equipByUuid = new Map(equipItems.map((i) => [i.uuid, i]));
			const equipSlots = isInnate ? [] : EQUIP_SLOTS.map((slot) => {
				const cur = (this._draft.equipment ?? []).find((e) => e?.slot === slot) ?? null;
				const curUuid = cur?.itemUuid ?? '';
				const allowed = EQUIP_SLOT_TYPES[slot] ?? [];
				const options = [{ uuid: '', name: game.i18n.localize('RIPPERS.Builder.SlotNone'), selected: !curUuid }]
					.concat(equipItems.filter((i) => allowed.includes(i.type)).map((i) => ({ uuid: i.uuid, name: i.name, selected: i.uuid === curUuid })));
				if (curUuid && !equipByUuid.has(curUuid)) options.push({ uuid: curUuid, name: cur?.name || curUuid, selected: true });
				return { slot, label: game.i18n.localize(`RIPPERS.Builder.Slot.${slot}`), options };
			});
			// v0.7.9 (Austin, 3 Sep): Specialties are FREE TEXT, not a picker. N inputs (N = SPECIALTY_COUNT),
			// the 13-name list demoted to a <datalist> of autocomplete hints. Padded to N so positions are stable.
			const specialtyDraft = this._draft.specialties ?? [];
			const specialtyMax = specialtyCapFor(draftIsTalented(this._draft)); // 2, or 4 with Talented
			const specialtyInputs = Array.from({ length: specialtyMax }, (_, i) => ({
				i,
				value: specialtyDraft[i] ?? '',
				label: `${game.i18n.localize('RIPPERS.Builder.Specialties')} ${i + 1}`,
			}));
			const specialtyCount = specialtyDraft.slice(0, specialtyMax).filter((s) => (s ?? '').trim()).length;
			const heroicName = this._draft.innateHeroicUuid ? (this._draft.innateHeroicName || this._draft.innateHeroicUuid) : '';
			const loadout = {
				equipment, equipSlots, bonusValue: BONUS_VALUE,
				perk: this._draft.perk ?? '', bonusDescriptor: this._draft.bonusDescriptor ?? '',
				tell: this._draft.tell ?? '', bane: this._draft.bane ?? '', flaw: this._draft.flaw ?? '',
				specialtyInputs, specialtyHints: SPECIALTY_LIST, specialtyPlaceholder: game.i18n.localize('RIPPERS.Builder.SpecialtyPlaceholder'),
				specialtyCount, specialtyMax, talented: draftIsTalented(this._draft), heroicName,
				hunterName: this._draft.hunterWeaponUuid ? (this._draft.hunterWeaponName || this._draft.hunterWeaponUuid) : '',
				// C3=A: material is now free-text flavour (the 5 names are datalist suggestions), plus a single bane flag.
				hwMaterialSuggestions: HW_MATERIALS, hunterMaterial: this._draft.hunterMaterial ?? '', hunterIsBane: !!this._draft.hunterIsBane,
				hunterOrigin: this._draft.hunterOrigin ?? '',
				// #2 (v0.7.9): innate armor + accessory chips
				armorName: this._draft.armorUuid ? (this._draft.armorName || this._draft.armorUuid) : '',
				accessoryName: this._draft.accessoryUuid ? (this._draft.accessoryName || this._draft.accessoryUuid) : '',
				// #3 (v0.7.9): the worn guise's attached ("signature") Heroic chip
				attachedHeroicName: this._draft.attachedHeroicUuid ? (this._draft.attachedHeroicName || this._draft.attachedHeroicUuid) : '',
				// #5 (v0.7.9): effects/abilities that ride the guise
				attachedEffects: (this._draft.attachedEffects ?? []).map((e, i) => ({ i, uuid: e.itemUuid, name: e.name ?? e.itemUuid })),
			};

			// ---- validation (guardrails: Q4 three classes, Q7 trio, Q1 innate specialties, min-per-class + budget) ----
			// #4 (v0.7.9): with the GM override ON, validation is soft (findings → warnings, never block).
			const override = editOverrideOn() || this._gmOverride; // G2: world setting OR the transient right-click override
			const validation = validateGuiseDraft(this._draft, mode, skillMax, budget, { override });
			// per-step errors so the CURRENT step gates its own Next button and shows its own errors
			// (v0.7.6 — the guardrails were computed but never consumed by the wizard chrome).
			const stepGate = guiseStepErrors(this._draft, mode, skillMax, budget, stepKey, { override });

			// ---- review step summary (read-only) --------------------------------
			const wordFor = (type, level) => `${capT(type)} ${affinityWordOf(level).toLowerCase()}`;
			const affSummary = isInnate ? [] : affinityTrioToModifiers({
				immunity: this._draft.affinityImmunity, vulnerability: this._draft.affinityVulnerability, resistance: this._draft.affinityResistance,
			}).map((m) => wordFor(m.type, m.level));
			const review = {
				name: this._draft.name || game.i18n.localize('RIPPERS.Builder.Unnamed'),
				role: this._draft.role || '', nature: isInnate ? '' : (this._draft.nature || ''),
				img: this._draft.img || '', notes: this._draft.notes || '',
				modeLabel: game.i18n.localize(isInnate ? 'RIPPERS.Builder.ModeInnate' : 'RIPPERS.Builder.ModeWorn'),
				classes: classBlocks.map((cb) => ({
					name: cb.name,
					skills: cb.skills.filter((s) => s.checked).map((s) => ({ name: s.name, sl: s.sl })),
				})),
				affinities: affSummary,
				equipment: isInnate ? [] : equipment.map((e) => ({ name: e.name, slot: e.slots.find((s) => s.selected)?.label ?? '' })),
				perk: isInnate ? '' : (this._draft.perk || ''),
				bonus: (!isInnate && (this._draft.bonusDescriptor || '').trim()) ? this._draft.bonusDescriptor.trim() : '',
				tell: isInnate ? '' : (this._draft.tell || ''), bane: isInnate ? '' : (this._draft.bane || ''), flaw: isInnate ? '' : (this._draft.flaw || ''),
				specialties: isInnate ? (this._draft.specialties ?? []) : [], heroic: isInnate ? heroicName : '',
				hunterWeapon: (isInnate && this._draft.hunterWeaponUuid)
					? { name: this._draft.hunterWeaponName || this._draft.hunterWeaponUuid, material: this._draft.hunterMaterial || '', origin: this._draft.hunterOrigin || '', isBane: !!this._draft.hunterIsBane }
					: null,
				errors: validation.errors, spent, budget,
			};

			// P5c (ruled per-CHARACTER, not per-guise): the character's Quirks — reachable/settable from the
			// editor (shown on the Review step). These are the same character-owned 'effect' Items as the
			// sheet's Quirk tab (v0.7.11); quirks stack (C4). No per-guise quirk model is invented.
			const quirks = (this.actor?.itemTypes?.effect ?? []).map((i) => ({ id: i.id, name: i.name ?? '' }));
			return {
				draft: this._draft, slots, classBlocks, budget, spent,
				mode, isInnate, isWorn: !isInnate, quirks,
				canCreate: validation.ok && spent > 0,
				step, stepKey, steps, stepTotal: WIZARD_STEPS.length,
				isFirst: step === 1, isLast: step === WIZARD_STEPS.length,
				stepIdentity: stepKey === 'identity', stepClasses: stepKey === 'classes',
				stepSkills: stepKey === 'skills', stepLoadout: stepKey === 'loadout',
				stepAffinities: stepKey === 'affinities', stepReview: stepKey === 'review',
				trio, trioValid: trioValid.ok, trioReason: trioValid.ok ? '' : trioValid.reason,
				loadout, review, validation,
				// v0.7.6 wizard chrome: gate Next on the current step, surface its errors inline
				stepValid: stepGate.ok, stepErrors: stepGate.errors,
				// #4 (v0.7.9): edit vs create; the GM override state + its warnings (soft validation)
				isEditing: !!this._editingId, editOverride: override,
				warnings: validation.warnings ?? [],
			};
		}

		_skillMax() { const m = {}; for (const arr of Object.values(this._classSkills)) for (const s of arr) m[s.uuid] = s.maxSl; return m; }
		// v0.7.34: enumerate equip-eligible Items once per builder open (dropdown source), cached.
		async _loadEquipOptions() { if (!this._equipOptions) this._equipOptions = await collectEquipItems(); return this._equipOptions; }

		_onRender() {
			const root = this.element;
			root.querySelectorAll('[data-draft]').forEach((el) =>
				el.addEventListener('change', () => {
					this._draft[el.dataset.draft] = el.value;
					// live preview: keep the sprite thumbnail in sync with a manually typed path
					if (el.dataset.draft === 'img') {
						const prev = root.querySelector('.gb-img-preview');
						if (prev) prev.src = el.value || 'icons/svg/mystery-man.svg';
					}
				}),
			);
			root.querySelectorAll('select.guise-class-slot').forEach((sel) => sel.addEventListener('change', () => {
				const arr = [...this._draft.classUuids];
				arr[Number(sel.dataset.slot)] = sel.value || undefined;
				this._draft.classUuids = arr.filter(Boolean);
				this.render();
			}));
			root.querySelectorAll('input.guise-skill-check').forEach((cb) => cb.addEventListener('change', () => {
				const key = cb.dataset.key;
				if (cb.checked) { if (!(Number(this._draft.sl[key]) > 0)) this._draft.sl[key] = 1; } else delete this._draft.sl[key];
				this.render();
			}));
			root.querySelectorAll('input.guise-skill-sl').forEach((inp) => inp.addEventListener('change', () => {
				// v0.7.4 bug fix: CLAMP the individual skill to its own max SL here. The HTML `max`
				// attribute does not block manual entry, so without this the draft (and the input) held
				// an over-max value — Austin saw "no limit on skill levels", even though compile capped it.
				const key = inp.dataset.key;
				const skillUuid = key.split(DRAFT_SEP)[1];
				const maxSl = Number(this._skillMax()[skillUuid] ?? PER_CLASS_CAP);
				const v = Math.min(Math.max(0, Math.floor(Number(inp.value) || 0)), maxSl);
				if (v > 0) this._draft.sl[key] = v; else delete this._draft.sl[key];
				this.render();
			}));
			// v0.7.30 SPELL AUTO-MATERIALIZATION: pick/unpick a spell for a caster skill (capped at its SL).
			root.querySelectorAll('input.guise-spell-pick').forEach((cb) => cb.addEventListener('change', () => {
				const key = cb.dataset.key, spell = cb.dataset.spell;
				this._draft.spells ??= {};
				const cur = new Set(this._draft.spells[key] ?? []);
				const cap = Math.max(0, Math.floor(Number(this._draft.sl[key]) || 0));
				if (cb.checked) { if (cur.size >= cap) { cb.checked = false; ui.notifications?.warn(game.i18n.format('RIPPERS.Builder.SpellPickCap', { n: cap })); return; } cur.add(spell); }
				else cur.delete(spell);
				this._draft.spells[key] = [...cur];
				this.render();
			}));

			// ---- mode toggle (Q1: worn mask ⇄ Innate Guise) ----
			root.querySelectorAll('input.guise-mode').forEach((r) => r.addEventListener('change', () => {
				if (r.checked && GUISE_MODES.includes(r.value)) { this._draft.mode = r.value; this.render(); }
			}));

			// ---- affinities step: the TRIO selects (worn only) ----
			root.querySelectorAll('select.guise-trio').forEach((sel) => sel.addEventListener('change', () => {
				const slot = sel.dataset.slot; // immunity | vulnerability | resistance
				const key = slot === 'immunity' ? 'affinityImmunity' : slot === 'vulnerability' ? 'affinityVulnerability' : 'affinityResistance';
				this._draft[key] = AFFINITY_TYPES.includes(sel.value) ? sel.value : '';
				this.render();
			}));

			// ---- loadout step: perks / bonus / specialties ----
			// Perk + Bonus descriptor are now free-text (data-draft="perk" / "bonusDescriptor") — handled
			// by the generic [data-draft] change listener above; no per-control handler needed (v0.7.4).
			// v0.7.9: free-text Specialty inputs. Write by index into a padded array so an empty middle
			// slot keeps its position; guiseDraftToData trims empties on Create.
			root.querySelectorAll('input.guise-specialty').forEach((inp) => inp.addEventListener('change', () => {
				const i = Number(inp.dataset.i);
				const cap = specialtyCapFor(draftIsTalented(this._draft));
				const arr = Array.from({ length: cap }, (_, k) => (this._draft.specialties ?? [])[k] ?? '');
				arr[i] = inp.value.trim();
				this._draft.specialties = arr;
				this.render();
			}));
			// v0.7.9: the Talented toggle re-sizes the Specialty count (2 <-> 4). Re-render redraws the inputs.
			root.querySelector('input.guise-talented')?.addEventListener('change', (ev) => {
				this._draft.talented = !!ev.currentTarget.checked;
				this.render();
			});
			// equipment slot change + remove
			root.querySelectorAll('select.guise-equip-slot').forEach((sel) => sel.addEventListener('change', () => {
				const i = Number(sel.dataset.i); const eq = (this._draft.equipment ?? [])[i];
				if (eq) { eq.slot = EQUIP_SLOTS.includes(sel.value) ? sel.value : 'mainHand'; }
			}));
			root.querySelectorAll('[data-action="removeEquip"]').forEach((a) => a.addEventListener('click', (ev) => {
				ev.preventDefault(); const i = Number(a.dataset.i);
				this._draft.equipment = (this._draft.equipment ?? []).filter((_, idx) => idx !== i); this.render();
			}));
			// v0.7.34: a dropdown PER equipment slot — set/replace/clear that slot (atomic, no dup). '' = empty.
			root.querySelectorAll('select.guise-equip-pick').forEach((sel) => sel.addEventListener('change', () => {
				const slot = sel.dataset.slot;
				const uuid = sel.value;
				const name = uuid ? (sel.selectedOptions?.[0]?.textContent?.trim() ?? '') : '';
				setDraftEquip(this._draft, slot, uuid, name);
				this.render();
			}));
			// #5 (v0.7.9): remove an attached effect/ability
			root.querySelectorAll('[data-action="removeAttachedEffect"]').forEach((a) => a.addEventListener('click', (ev) => {
				ev.preventDefault(); const i = Number(a.dataset.i);
				this._draft.attachedEffects = (this._draft.attachedEffects ?? []).filter((_, idx) => idx !== i); this.render();
			}));
			root.querySelectorAll('[data-action="clearHeroic"]').forEach((a) => a.addEventListener('click', (ev) => {
				ev.preventDefault(); this._draft.innateHeroicUuid = ''; this._draft.innateHeroicName = ''; this.render();
			}));
			// Hunter Weapon (innate mode): the free-text material + origin ride the generic [data-draft]
			// handler; the C3=A bane flag is a checkbox read by .checked, not .value.
			root.querySelectorAll('input.guise-hw-bane').forEach((cb) => cb.addEventListener('change', () => {
				this._draft.hunterIsBane = !!cb.checked; this.render();
			}));
			root.querySelectorAll('[data-action="clearHunter"]').forEach((a) => a.addEventListener('click', (ev) => {
				ev.preventDefault(); this._draft.hunterWeaponUuid = ''; this._draft.hunterWeaponName = ''; this.render();
			}));
			// #2 (v0.7.9): innate armor + accessory clear
			root.querySelectorAll('[data-action="clearArmor"]').forEach((a) => a.addEventListener('click', (ev) => {
				ev.preventDefault(); this._draft.armorUuid = ''; this._draft.armorName = ''; this.render();
			}));
			root.querySelectorAll('[data-action="clearAccessory"]').forEach((a) => a.addEventListener('click', (ev) => {
				ev.preventDefault(); this._draft.accessoryUuid = ''; this._draft.accessoryName = ''; this.render();
			}));
			// #3 (v0.7.9): worn guise attached-heroic clear
			root.querySelectorAll('[data-action="clearWornHeroic"]').forEach((a) => a.addEventListener('click', (ev) => {
				ev.preventDefault(); this._draft.attachedHeroicUuid = ''; this._draft.attachedHeroicName = ''; this.render();
			}));

			// ---- G2 (Austin 4 Sep): RIGHT-CLICK a fixed field to override its distillation fixity ----
			// The affordance is a contextmenu on a fixed fieldset (classes / affinities / loadout), GM-only.
			// It flips the TRANSIENT per-session override (soft validation) — never a persisted setting, and
			// no per-field "overridden" mark (only the session-wide override note shows). Dies with the app.
			root.querySelectorAll('[data-gb-fixed]').forEach((el) => el.addEventListener('contextmenu', (ev) => {
				if (!globalThis.game?.user?.isGM) return;      // players never override fixity
				ev.preventDefault();
				if (this._gmOverride) return;                  // already overriding this session
				this._gmOverride = true;
				ui.notifications?.info(game.i18n?.localize?.('RIPPERS.Builder.OverrideRightClick') ?? 'Fixed fields unlocked for this edit (GM override).');
				this.render();
			}));

			// ---- drop targets: equipment (worn) + creation heroic (innate) ----
			root.querySelectorAll('[data-guise-drop]').forEach((zone) => {
				zone.addEventListener('dragover', (ev) => { ev.preventDefault(); zone.classList.add('drop-hover'); });
				zone.addEventListener('dragleave', () => zone.classList.remove('drop-hover'));
				zone.addEventListener('drop', async (ev) => {
					ev.preventDefault(); zone.classList.remove('drop-hover');
					const data = readDropData(ev);
					if (!data || data.type !== 'Item') return;
					const doc = await safeFromUuid(data.uuid);
					if (!doc) { ui.notifications?.warn('Could not resolve the dropped item.'); return; }
					if (zone.dataset.guiseDrop === 'equipment') {
						this._draft.equipment = [...(this._draft.equipment ?? []), { itemUuid: data.uuid, slot: 'mainHand', name: doc.name }];
					} else if (zone.dataset.guiseDrop === 'heroic') {
						if (doc.type !== 'heroic') { ui.notifications?.warn('The Innate Guise heroic must be a Heroic Skill.'); return; }
						if (heroicIsCreationBanned(doc)) { ui.notifications?.warn(`"${doc.name}" cannot be taken as a creation heroic.`); return; }
						this._draft.innateHeroicUuid = data.uuid; this._draft.innateHeroicName = doc.name;
					} else if (zone.dataset.guiseDrop === 'hunter') {
						if (doc.type !== 'weapon' && doc.type !== 'customWeapon') { ui.notifications?.warn('The Hunter Weapon must be a weapon Item.'); return; }
						this._draft.hunterWeaponUuid = data.uuid; this._draft.hunterWeaponName = doc.name;
					} else if (zone.dataset.guiseDrop === 'armor') {
						if (doc.type !== 'armor') { ui.notifications?.warn('The Innate Guise armor must be an armor Item.'); return; }
						this._draft.armorUuid = data.uuid; this._draft.armorName = doc.name;
					} else if (zone.dataset.guiseDrop === 'accessory') {
						if (doc.type !== 'accessory') { ui.notifications?.warn('The Innate Guise accessory must be an accessory Item.'); return; }
						this._draft.accessoryUuid = data.uuid; this._draft.accessoryName = doc.name;
					} else if (zone.dataset.guiseDrop === 'wornHeroic') {
						if (doc.type !== 'heroic') { ui.notifications?.warn('The attached Heroic must be a Heroic Skill.'); return; }
						this._draft.attachedHeroicUuid = data.uuid; this._draft.attachedHeroicName = doc.name;
					} else if (zone.dataset.guiseDrop === 'attachedEffect') {
						// #5: any effect-bearing Item may ride the guise; the GM authors what belongs.
						this._draft.attachedEffects = [...(this._draft.attachedEffects ?? []), { itemUuid: data.uuid, name: doc.name }];
					}
					this.render();
				});
			});
			this._wireCharacterQuirks(root); // P5c: character-quirk controls on the Review step
		}

		// P5c: character Quirks, settable from the guise editor (Review step). Per-CHARACTER (ruled), reusing
		// the sheet's quirk CRUD on this.actor; quirks stack (C4). No per-guise quirk model is invented.
		_wireCharacterQuirks(root) {
			if (!root?.querySelector) return;
			root.querySelector('[data-action="quirkAddCh"]')?.addEventListener('click', async (ev) => { ev.preventDefault(); await sheetAddQuirk(this.actor); this.render(); });
			root.querySelectorAll('[data-action="quirkEditCh"]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); sheetEditQuirk(this.actor, ev.currentTarget.dataset.id); }));
			root.querySelectorAll('[data-action="quirkRemoveCh"]').forEach((a) => a.addEventListener('click', async (ev) => { ev.preventDefault(); await sheetRemoveQuirk(this.actor, ev.currentTarget.dataset.id); this.render(); }));
		}
		static async onCreate(event) { event.preventDefault(); await this._doCreate(false); }
		static async onCreateBind(event) { event.preventDefault(); await this._doCreate(true); }
		/** Open the Foundry image browser for the guise sprite; writes the chosen path back to draft.img. */
		static async onPickImg(event) {
			event.preventDefault();
			// Foundry v13 moved FilePicker to foundry.applications.apps.FilePicker; fall back for drift.
			const FP = foundry?.applications?.apps?.FilePicker?.implementation ?? foundry?.applications?.apps?.FilePicker ?? globalThis.FilePicker;
			if (!FP) { ui.notifications?.warn('FilePicker is unavailable in this Foundry build.'); return; }
			const picker = new FP({
				type: 'image',
				current: this._draft.img || '',
				callback: (path) => { this._draft.img = path; this.render(); },
			});
			return typeof picker.browse === 'function' ? picker.browse() : picker.render(true);
		}
		static onBack(event) { event.preventDefault(); this._step = clampWizardStep(this._step - 1); this.render(); }
		static onNext(event) { event.preventDefault(); this._step = clampWizardStep(this._step + 1); this.render(); }
		async _doCreate(bind) {
			const mode = GUISE_MODES.includes(this._draft.mode) ? this._draft.mode : 'worn';
			const override = editOverrideOn() || this._gmOverride; // G2: transient right-click override counts here too
			// Belt-and-suspenders gate: recompute the FULL guardrail set (incl. min-per-class + budget)
			// and refuse to commit an invalid guise even if a disabled button were somehow triggered.
			// With the GM override on, validation is SOFT — findings surface as warnings, never block.
			const v = validateGuiseDraft(this._draft, mode, this._skillMax(), budgetOf(this.actor), { override });
			if (!v.ok) { ui.notifications?.warn(v.errors[0]); return; }
			for (const w of v.warnings ?? []) ui.notifications?.warn(w);
			// #4 (v0.7.9): EDIT path — update the existing guise's record in place instead of creating a new one.
			if (this._editingId) {
				const item = this.actor?.items?.get(this._editingId);
				if (!item) { ui.notifications?.error('That guise no longer exists — reopen the builder.'); this.close(); return; }
				// Dismiss-before-edit guard: a BOUND guise has materialised its skills/equipment onto the
				// actor; its structural fields must not change underneath. Block unless the GM override is on.
				const isBound = this.actor.getFlag(MODULE_ID, FLAG) === item.id;
				if (isBound && !override) { ui.notifications?.warn(game.i18n.localize('RIPPERS.Builder.DismissFirst')); return; }
				if (isBound && override) ui.notifications?.warn(game.i18n.localize('RIPPERS.Builder.EditBoundWarn'));
				const oldData = item.system?.data ?? {};
				const data = guiseDraftToData(this._draft, this._skillMax(), budgetOf(this.actor));
				await item.update({ name: data.identity || item.name, img: this._draft.img || item.img, 'system.data': data });
				// #2 (v0.7.9): an INNATE guise's char-side kit is materialised on the actor, so a post-creation
				// edit must reconcile it — delete the stale creation heroic / Hunter Weapon / armour / accessory
				// and materialise the new refs, preserving the creation heroic's dormant-while-masked state. A
				// WORN guise carries no char-side kit (its loadout re-materialises on the next bind), so skip.
				if (data.mode === 'innate') {
					const { changed } = await reconcileInnateKit(this.actor, oldData, data);
					if (changed.length) ui.notifications?.info(`Reconciled innate kit: ${changed.join(', ')}.`);
				}
				ui.notifications?.info(`Guise "${item.name}" updated.`);
				this.close();
				return;
			}
			const item = await createGuiseFromDraft(this.actor, this._draft, { skillMax: this._skillMax(), bind });
			if (item) { ui.notifications?.info(`Guise "${item.name}" created${bind ? ' and bound' : ''}.`); this.close(); }
		}
	}
	_GuiseBuilderApp = GuiseBuilderApp;
	return GuiseBuilderApp;
}
/** Open the Guise Builder wizard for an actor (panel button / macro). With `existingGuise`, the wizard
 *  opens in EDIT mode (#4): its draft is seeded from that guise Item and Create becomes Save. */
function openGuiseBuilder(actor, existingGuise = null) {
	if (!actor) return;
	(async () => {
		try {
			const app = new (getGuiseBuilderApp())(actor);
			if (existingGuise?.system?.data) {
				app._draft = await draftFromGuiseItem(existingGuise);
				app._editingId = existingGuise.id;
			}
			app.render(true);
		} catch (err) { console.error('[rippers-guise] openGuiseBuilder failed:', err); }
	})();
}

// ---------------------------------------------------------------------------
// Author-time UI helpers (Stage B sheet). Names/caps resolved for display; all three caps are
// enforced live in the sheet (below) and again, authoritatively, at bind (materialiseSkills).
const AFFINITY_LEVELS = [
	{ value: -1, label: 'Vulnerability' },
	{ value: 1, label: 'Resistance' },
	{ value: 2, label: 'Immunity' },
	{ value: 3, label: 'Absorption' },
];
const affinityWordOf = (n) => (AFFINITY_LEVELS.find((l) => l.value === Number(n))?.label ?? '—');

async function safeFromUuid(uuid) {
	if (!uuid) return null;
	try { return await fromUuid(uuid); } catch { return null; }
}

/** Build the enriched view-model the guise sheet renders (async; names + caps resolved). */
async function enrichGuiseData(model) {
	const item = model?.item ?? null;
	const actor = model?.actor ?? null;
	const data = model ?? {};
	const activeId = actor?.getFlag(MODULE_ID, FLAG) ?? null;
	const budget = budgetOf(actor);

	let totalSl = 0;
	const classes = [];
	for (const [i, cls] of (data.classes ?? []).entries()) {
		const cdoc = await safeFromUuid(cls.classUuid);
		let sumSl = 0;
		const skills = [];
		for (const [j, sk] of (cls.skills ?? []).entries()) {
			const sdoc = await safeFromUuid(sk.skillUuid);
			const maxSl = sdoc?.system?.level?.max ?? 10;
			const sl = Math.max(0, Number(sk.sl ?? 0) || 0);
			sumSl += sl;
			skills.push({ j, uuid: sk.skillUuid, name: sdoc?.name ?? '(missing skill)', img: sdoc?.img ?? 'icons/svg/book.svg', sl, maxSl, missing: !sdoc });
		}
		totalSl += sumSl;
		classes.push({ i, uuid: cls.classUuid, name: cdoc?.name ?? '(missing class)', img: cdoc?.img ?? 'icons/svg/book.svg', missing: !cdoc, sumSl, mastery: sumSl >= PER_CLASS_CAP, over: sumSl > PER_CLASS_CAP, skills });
	}

	const equipment = [];
	for (const [i, eq] of (data.equipment ?? []).entries()) {
		const edoc = await safeFromUuid(eq.itemUuid);
		equipment.push({ i, uuid: eq.itemUuid, name: edoc?.name ?? '(missing item)', img: edoc?.img ?? 'icons/svg/item-bag.svg', slot: eq.slot ?? 'mainHand', missing: !edoc });
	}

	const affinities = (data.affinityModifiers ?? []).map((m, i) => ({ i, type: m.type, level: m.level, word: affinityWordOf(m.level) }));

	const slotChoices = Object.fromEntries(EQUIP_SLOTS.map((s) => [s, s]));
	const typeChoices = Object.fromEntries(AFFINITY_TYPES.map((t) => [t, t]));
	const levelChoices = Object.fromEntries(AFFINITY_LEVELS.map((l) => [String(l.value), l.label]));

	return {
		active: !!item && item.id === activeId,
		budget, totalSl, overBudget: totalSl > budget, perClassCap: PER_CLASS_CAP,
		classes, equipment, affinities,
		slotChoices, typeChoices, levelChoices,
		hasActor: !!actor,
		// #4 (v0.7.9): a guise's classes / equipment / affinities are fixed at distillation — read-only
		// on the sheet unless the module-wide GM edit override is on.
		canEditFixed: editOverrideOn(),
		// SL editable-with-toggle (Austin, 4 Sep 2026): SLs advance with XP, so they are NOT fixed at
		// distillation — a dedicated player-accessible toggle (flag slEditOpen) makes the SL inputs
		// editable in normal play, independent of the GM override (which still gates the class roster +
		// affinity trio). Under the GM override everything is already editable, so the toggle is moot.
		slEditable: !!item?.getFlag?.(MODULE_ID, 'slEditOpen'),
	};
}

/** Read a Foundry drag payload off a drop event. */
function readDropData(event) {
	try { return JSON.parse(event.dataTransfer.getData('text/plain')); } catch { return null; }
}

/** Live cap enforcement on the SL inputs (per-class ≤10, per-skill ≤max_sl, total ≤budget). */
function clampAllocationInputs(html, budget) {
	const inputs = Array.from(html.querySelectorAll('input.guise-sl'));
	// per-skill max
	for (const el of inputs) {
		const max = Number(el.dataset.maxsl ?? 10);
		if (Number(el.value) > max) el.value = String(max);
		if (Number(el.value) < 0) el.value = '0';
	}
	// per-class ≤ 10
	const byClass = {};
	for (const el of inputs) (byClass[el.dataset.cls] ??= []).push(el);
	for (const group of Object.values(byClass)) {
		let sum = 0;
		for (const el of group) { const v = Number(el.value) || 0; if (sum + v > PER_CLASS_CAP) el.value = String(Math.max(0, PER_CLASS_CAP - sum)); sum += Number(el.value) || 0; }
	}
	// total ≤ budget
	let total = 0;
	for (const el of inputs) { const v = Number(el.value) || 0; if (total + v > budget) el.value = String(Math.max(0, budget - total)); total += Number(el.value) || 0; }
}

// ---------------------------------------------------------------------------
// The GuiseDataModel (built at 'setup', when Project FU's base classes exist).
function defineGuiseModel() {
	const { RollableClassFeatureDataModel } = globalThis.projectfu ?? {};
	if (!RollableClassFeatureDataModel) {
		throw new Error('[rippers-guise] Project FU (globalThis.projectfu.RollableClassFeatureDataModel) not found — is the projectfu system active?');
	}
	const { StringField, HTMLField, ArrayField, SchemaField, NumberField, BooleanField } = foundry.data.fields;

	return class GuiseDataModel extends RollableClassFeatureDataModel {
		static defineSchema() {
			return {
				// mode (Q1): 'worn' mask vs the 'innate' Guise (the face under the masks)
				mode: new StringField({ initial: 'worn', choices: GUISE_MODES }),
				// narrative
				identity: new StringField({ initial: '' }),
				role: new StringField({ initial: '' }),
				nature: new StringField({ initial: '' }),        // Q5 — the Guise's Identity (plain text)
				notes: new HTMLField({ initial: '' }),
				// worn-guise grants (core §2): a Perk, a +3 Bonus, a Tell, a narrative Bane + flaw — all free text (v0.7.4)
				perk: new StringField({ initial: '' }),
				bonus: new SchemaField({
					descriptor: new StringField({ initial: '' }), // the narrative circumstance the +3 applies to (GM-applied)
					value: new NumberField({ initial: 3, integer: true }),
				}, { nullable: true, initial: null }),
				tell: new StringField({ initial: '' }),
				bane: new StringField({ initial: '' }),           // Q2 — NARRATIVE, not a mechanical effect
				flaw: new StringField({ initial: '' }),
				// innate-guise grants (Q1): two Specialties (four with Talented, v0.7.9) + the creation Heroic (assigned actor-side)
				specialties: new ArrayField(new StringField({ initial: '' })),
				talented: new BooleanField({ initial: false }), // v0.7.9: the Talented keystone => four Specialties
				innateHeroicUuid: new StringField({ initial: '' }),
				// #3 (v0.7.9): a worn guise's own ("signature") Heroic — materialised on bind, distinct
				// from the character's heroics. Innate guises leave this empty.
				attachedHeroicUuid: new StringField({ initial: '' }),
				// #5 (v0.7.9): effects/abilities that ride the guise — effect-bearing Item refs
				// materialised on bind (on while worn) and removed on dismiss. Body/standing effects
				// per the GUISES sort test (e.g. mutations); the GM authors which effects ride.
				attachedEffects: new ArrayField(new SchemaField({ itemUuid: new StringField({ initial: '' }) })),
				// Hunter Weapon record (v0.7.1); the weapon Item itself is materialised + flagged on the actor
				hunterWeaponUuid: new StringField({ initial: '' }),
				hunterMaterial: new StringField({ initial: '' }),  // C3=A: free-text flavour only
				hunterOrigin: new StringField({ initial: '' }),
				hunterIsBane: new BooleanField({ initial: false }), // C3=A: the single bane flag
				// innate armor + accessory (#2, v0.7.9): authored refs; the Items are materialised +
				// equipped on the actor at create (like the Hunter Weapon), so they are the character's
				// own kit. Kept here for re-edit / display.
				armorUuid: new StringField({ initial: '' }),
				accessoryUuid: new StringField({ initial: '' }),
				// §10 LENT VITALS + IP SATCHEL (v0.7.9; RULE-guise-lent-vitals.md). The mask's own padding:
				// each lent layer carries its own current + maximum, spent before the wearer's pool and
				// refilled at a rest; it NEVER changes the wearer's max HP/MP. The IP satchel is capacity
				// (10z/pt, no rest refill). Most guises: 0/0. Runtime state — not authored in the wizard.
				lentHp: new SchemaField({
					current: new NumberField({ initial: 0, min: 0, integer: true, nullable: false }),
					maximum: new NumberField({ initial: 0, min: 0, integer: true, nullable: false }),
				}),
				lentMp: new SchemaField({
					current: new NumberField({ initial: 0, min: 0, integer: true, nullable: false }),
					maximum: new NumberField({ initial: 0, min: 0, integer: true, nullable: false }),
				}),
				ipSatchel: new SchemaField({
					stock: new NumberField({ initial: 0, min: 0, integer: true, nullable: false }),
					capacity: new NumberField({ initial: 0, min: 0, integer: true, nullable: false }),
				}),
				// classes + per-skill allocation (D1: UUID refs to the compendium)
				classes: new ArrayField(new SchemaField({
					classUuid: new StringField({ initial: '' }),
					skills: new ArrayField(new SchemaField({
						skillUuid: new StringField({ initial: '' }),
						sl: new NumberField({ initial: 1, min: 0, integer: true, nullable: false }),
						// v0.7.30 SPELL AUTO-MATERIALIZATION: a spellcasting GRANTING skill (fuid in the compendium
						// granting_skill_keys) picks up to SL spells from its discipline list; the picked spell UUIDs
						// live here and auto-materialise on bind / strip on dismiss. Empty for a non-caster skill.
						spellUuids: new ArrayField(new StringField({ initial: '' })),
					})),
				})),
				// equipment (D3: guise carries its own loadout)
				equipment: new ArrayField(new SchemaField({
					itemUuid: new StringField({ initial: '' }),
					slot: new StringField({ initial: 'mainHand', choices: EQUIP_SLOTS }),
				})),
				// affinity modifiers (legacy MODIFY path — additive; via the transferEffects gate)
				affinityModifiers: new ArrayField(new SchemaField({
					type: new StringField({ initial: 'dark', choices: AFFINITY_TYPES }),
					level: new NumberField({ initial: 1, integer: true, nullable: false }),
				})),
				// FDN-9 monstrous-form affinities (REPLACE path). A guise may declare one or more
				// affinity-SETS; the active one REPLACES the wearer's affinities while worn. Empty for an
				// ordinary guise. affinityMode='replace' forces the fork even with no authored set (a guise
				// that only collects forms in play). affinitySetCap / affinityCapSkill bound the library.
				affinityMode: new StringField({ initial: 'modify', choices: ['modify', 'replace'] }),
				affinitySets: new ArrayField(new SchemaField({
					id: new StringField({ initial: '' }),
					name: new StringField({ initial: '' }),
					affinities: new ArrayField(new SchemaField({
						type: new StringField({ initial: 'dark', choices: AFFINITY_TYPES }),
						level: new NumberField({ initial: 1, integer: true, nullable: false }),
					})),
				})),
				affinitySetCap: new NumberField({ initial: null, nullable: true, integer: true, min: 0 }),
				affinityCapSkill: new StringField({ initial: '' }),
			};
		}

		static get template() { return `modules/${MODULE_ID}/templates/guise-sheet.hbs`; }
		static get translation() { return 'RIPPERS.Guise.Feature'; }

		static async getAdditionalData(model) {
			return enrichGuiseData(model);
		}

		/** Sync backstop clamp of the caps that need no async UUID lookup (per-class Σ≤10, total≤budget). */
		static processUpdateData(data, model) {
			const budget = budgetOf(model?.actor);
			let total = 0;
			for (const cls of data?.classes ?? []) {
				let sum = 0;
				for (const sk of cls.skills ?? []) {
					let sl = Math.max(0, Math.floor(Number(sk.sl ?? 0)) || 0);
					if (sum + sl > PER_CLASS_CAP) sl = Math.max(0, PER_CLASS_CAP - sum);
					if (total + sl > budget) sl = Math.max(0, budget - total);
					sk.sl = sl; sum += sl; total += sl;
				}
			}
			return data;
		}

		/** Author-time interactivity: drop targets, add/remove rows, live cap clamp. */
		static activateListeners(html, item, sheet) {
			if (!item) return;
			const cur = () => foundry.utils.deepClone(item.system?.data ?? {});
			const setData = (patch) => item.update({ 'system.data': { ...cur(), ...patch } });
			const budget = budgetOf(item.actor);
			// #4 (v0.7.9): classes / equipment / affinities are fixed at distillation. The template hides
			// their edit controls unless the GM override is on; this guard is defense-in-depth so a stale
			// control can't mutate a fixed field. Identity/role/notes stay freely editable (canon-clean).
			const canEdit = editOverrideOn();

			// --- SL edit toggle (player-accessible, NOT the GM override) -------------
			// SLs advance with XP, so a player may raise them in normal play behind a dedicated toggle
			// (Austin, 4 Sep 2026). Ungated on the override; flipping the flag re-renders the sheet.
			html.querySelectorAll('.guise-sl-toggle').forEach((btn) => btn.addEventListener('click', async (ev) => {
				ev.preventDefault();
				await item.setFlag(MODULE_ID, 'slEditOpen', !item.getFlag(MODULE_ID, 'slEditOpen'));
			}));

			// --- drop targets (class / per-class skill / equipment) -----------------
			if (canEdit) html.querySelectorAll('[data-guise-drop]').forEach((zone) => {
				zone.addEventListener('dragover', (ev) => { ev.preventDefault(); zone.classList.add('drop-hover'); });
				zone.addEventListener('dragleave', () => zone.classList.remove('drop-hover'));
				zone.addEventListener('drop', async (ev) => {
					ev.preventDefault(); zone.classList.remove('drop-hover');
					const payload = readDropData(ev);
					if (!payload || payload.type !== 'Item' || !payload.uuid) return;
					const doc = await safeFromUuid(payload.uuid);
					if (!doc) return ui.notifications?.warn('That item could not be resolved.');
					const kind = zone.dataset.guiseDrop;
					const data = cur();
					if (kind === 'class') {
						if (doc.type !== 'class') return ui.notifications?.warn('Drop a class Item here.');
						const classes = data.classes ?? [];
						if (classes.some((c) => c.classUuid === payload.uuid)) return;
						classes.push({ classUuid: payload.uuid, skills: [] });
						await setData({ classes });
					} else if (kind === 'skill') {
						if (doc.type !== 'skill') return ui.notifications?.warn('Drop a skill Item here.');
						const ci = Number(zone.dataset.cls);
						const classes = data.classes ?? [];
						if (!classes[ci]) return;
						classes[ci].skills = classes[ci].skills ?? [];
						if (classes[ci].skills.some((s) => s.skillUuid === payload.uuid)) return;
						classes[ci].skills.push({ skillUuid: payload.uuid, sl: 1 });
						await setData({ classes });
					} else if (kind === 'equipment') {
						const equipment = data.equipment ?? [];
						if (equipment.some((e) => e.itemUuid === payload.uuid)) return;
						equipment.push({ itemUuid: payload.uuid, slot: 'mainHand' });
						await setData({ equipment });
					}
				});
			});

			// --- remove buttons -----------------------------------------------------
			if (canEdit) html.querySelectorAll('[data-guise-action]').forEach((btn) => {
				btn.addEventListener('click', async (ev) => {
					ev.preventDefault();
					const action = btn.dataset.guiseAction;
					const data = cur();
					if (action === 'remove-class') {
						(data.classes ??= []).splice(Number(btn.dataset.cls), 1);
						await setData({ classes: data.classes });
					} else if (action === 'remove-skill') {
						const c = (data.classes ??= [])[Number(btn.dataset.cls)];
						if (c) { (c.skills ??= []).splice(Number(btn.dataset.skill), 1); await setData({ classes: data.classes }); }
					} else if (action === 'remove-equip') {
						(data.equipment ??= []).splice(Number(btn.dataset.equip), 1);
						await setData({ equipment: data.equipment });
					} else if (action === 'add-affinity') {
						(data.affinityModifiers ??= []).push({ type: 'dark', level: 1 });
						await setData({ affinityModifiers: data.affinityModifiers });
					} else if (action === 'remove-affinity') {
						(data.affinityModifiers ??= []).splice(Number(btn.dataset.aff), 1);
						await setData({ affinityModifiers: data.affinityModifiers });
					}
				});
			});

			// --- live cap clamp on SL inputs (before the form auto-submits) ---------
			html.querySelectorAll('input.guise-sl').forEach((el) => {
				el.addEventListener('change', () => clampAllocationInputs(html, budget));
			});
		}

		/** Project FU transfers this item's embedded effects only when true → gate on "active guise". */
		transferEffects() {
			const activeId = this.actor?.getFlag(MODULE_ID, FLAG) ?? null;
			return !!this.item && this.item.id === activeId && (this.item.isEmbedded ?? false);
		}

		/** Icon click on the character sheet = bind / dismiss (swap). */
		static async roll(model, item) {
			const actor = item?.actor;
			if (!actor) return;
			const wasActive = actor.getFlag(MODULE_ID, FLAG) === item.id;
			if (wasActive) await dismissGuise(actor, item);
			else await bindGuise(actor, item);
			const verb = wasActive ? 'dismisses' : 'binds';
			const who = model?.identity ? ` — <em>${foundry.utils.escapeHTML(model.identity)}</em>` : '';
			await ChatMessage.create({
				speaker: ChatMessage.implementation.getSpeaker({ actor }),
				content: `<div class="rippers-guise-card"><strong>${foundry.utils.escapeHTML(actor.name)}</strong> ${verb} the guise <strong>${foundry.utils.escapeHTML(item.name)}</strong>${who}.</div>`,
			});
		}
	};
}

// ---------------------------------------------------------------------------
// Innate-pool guard hooks (document layer) — kept from v0.1.1.
Hooks.on('preCreateActiveEffect', (effect) => {
	if (!isGuiseItem(effect.parent)) return;
	const { kept, stripped } = filterChanges(effect.changes ?? []);
	if (stripped.length) { logStripped('preCreateActiveEffect', stripped); effect.updateSource({ changes: kept }); }
});
Hooks.on('preUpdateActiveEffect', (effect, changed) => {
	if (!isGuiseItem(effect.parent) || !Array.isArray(changed.changes)) return;
	const { kept, stripped } = filterChanges(changed.changes);
	if (stripped.length) { logStripped('preUpdateActiveEffect', stripped); changed.changes = kept; }
});
function sanitizeItemData(item) {
	if (!isGuiseItem(item)) return;
	const obj = item.toObject();
	let changed = false;
	for (const e of obj.effects ?? []) {
		const { kept, stripped } = filterChanges(e.changes ?? []);
		if (stripped.length) { logStripped(`guise "${item.name}"`, stripped); e.changes = kept; changed = true; }
	}
	if (changed) item.updateSource({ effects: obj.effects });
}
Hooks.on('preCreateItem', (item) => sanitizeItemData(item));
Hooks.on('preUpdateItem', (item, changed) => {
	if (!isGuiseItem(item) || !Array.isArray(changed.effects)) return;
	for (const e of changed.effects) {
		const { kept, stripped } = filterChanges(e?.changes);
		if (stripped.length) { logStripped(`guise "${item.name}" update`, stripped); e.changes = kept; }
	}
});

/** Keep the guise's embedded affinity effect in sync when its affinityModifiers change. */
Hooks.on('updateItem', async (item, changed) => {
	if (!isGuiseItem(item)) return;
	if (foundry.utils.hasProperty(changed, 'system.data.affinityModifiers')) await syncAffinityEffect(item);
});
Hooks.on('createItem', async (item) => {
	if (!isGuiseItem(item)) return;
	if (item.system?.data?.affinityModifiers?.length || isReplaceModeGuise(item)) await syncAffinityEffect(item);
});

/**
 * §7 migration — bring a guise Item up to the v0.2 schema (narrative-only unless authored).
 * Drops the old MVP raw-delta effects (D5: guises express only classes/equipment/affinities);
 * the synced "Guise affinities" effect (flagged) is kept. Narrative + new data survive.
 */
async function migrateGuiseItem(item) {
	if (!isGuiseItem(item)) return false;
	if (item.getFlag(MODULE_ID, 'schemaVersion') >= 2) return false;
	const stale = item.effects.filter((e) => !e.getFlag(MODULE_ID, 'affinityEffect'));
	if (stale.length) await item.deleteEmbeddedDocuments('ActiveEffect', stale.map((e) => e.id));
	await item.setFlag(MODULE_ID, 'schemaVersion', 2);
	console.debug(`[rippers-guise] migrated guise "${item.name}" to v0.2 (dropped ${stale.length} raw-delta effect(s)).`);
	return true;
}
async function migrateWorldGuises() {
	let n = 0;
	for (const actor of game.actors ?? []) {
		for (const item of actor.items) if (await migrateGuiseItem(item)) n += 1;
	}
	return n;
}

/**
 * N2 (god, Stage A): the module NEVER auto-seeds guises onto actors — nothing in it re-creates a
 * guise on load, so it cannot itself accumulate copies across reloads. The duplicates god saw came
 * from repeated manual pack-imports. This is an OPT-IN GM tool (not run automatically — auto-deleting
 * player items would be destructive) that collapses guise Items sharing a fuid on one actor, keeping
 * the ACTIVE one (or the first), never touching the currently-bound guise. Idempotent.
 */
async function dedupeActorGuises(actor) {
	if (!actor) return 0;
	const activeId = actor.getFlag(MODULE_ID, FLAG) ?? null;
	const byFuid = new Map();
	for (const item of actor.items) {
		if (!isGuiseItem(item)) continue;
		const fuid = item.system?.fuid ?? item.getFlag(MODULE_ID, 'fuid') ?? `_id:${item.id}`;
		(byFuid.get(fuid) ?? byFuid.set(fuid, []).get(fuid)).push(item);
	}
	const toDelete = [];
	for (const group of byFuid.values()) {
		if (group.length < 2) continue;
		const keep = group.find((it) => it.id === activeId) ?? group[0];
		for (const it of group) if (it.id !== keep.id) toDelete.push(it.id);
	}
	if (toDelete.length) {
		await actor.deleteEmbeddedDocuments('Item', toDelete);
		console.log(`[rippers-guise] dedupeActorGuises("${actor.name}"): removed ${toDelete.length} duplicate guise(s).`);
	}
	return toDelete.length;
}
async function dedupeWorldGuises() {
	let n = 0;
	for (const actor of game.actors ?? []) n += await dedupeActorGuises(actor);
	return n;
}

/** One-shot cleanup for guises saved before the guard existed. */
async function sanitizeActorGuises(actor) {
	if (!actor) return 0;
	let total = 0;
	for (const item of actor.items) {
		if (!isGuiseItem(item)) continue;
		for (const effect of item.effects) {
			const { kept, stripped } = filterChanges(effect.changes ?? []);
			if (stripped.length) { await effect.update({ changes: kept }); total += stripped.length; }
		}
	}
	return total;
}

// ---------------------------------------------------------------------------
// FDN-7: inject the Guises panel whenever a character sheet renders. God's Forge verify confirmed
// ApplicationV2 fires renderFUStandardActorSheet for the PC sheet — a SINGLE hook (no parent hook,
// which could double-inject). Injection is idempotent (sweeps any prior panel first), and the
// re-entrancy lock in setActiveGuise makes even a stray double-fire a no-op.
Hooks.on('renderFUStandardActorSheet', (app) => injectGuisePanel(app));

// ---------------------------------------------------------------------------
// RIPPERS CHARACTER SHEET — custom Actor sheet, Architecture B (SHEET-SKIN-SPIKE.md, 4 Sep 2026).
// Our own ApplicationV2 ActorSheetV2 view over FU's stable engine data — NOT a subclass of FU's own
// sheet (FU is mid AppV1->AppV2 migration; a subclass would inherit that breaking rewrite; a parallel
// view over the DataModel layer is insulated). Registered user-selectable (makeDefault:false) so it
// never steals the default. PHASE 1 = READ-ONLY faithful render of real actor.system.* (no control
// wiring — that is Phase 2). All FU read paths verified against the projectfu dev checkout.
// Skin: the Rippers Design System language (blood/bone/violet, notch-clipped cards) — its exact 2a
// "Slash" Foundry-sheet canvas was not reachable this build, so the visual is grounded in the readable
// design-system tokens + hunters-ledger CharacterScreen, to be reconciled to 2a when the canvas lands.
const RS_ATTR_LABELS = { dex: 'Dexterity', ins: 'Insight', mig: 'Might', wlp: 'Willpower' };
const RS_AFFINITY_TYPES = ['physical', 'air', 'bolt', 'dark', 'earth', 'fire', 'ice', 'light', 'poison'];
// FU core bond emotions (BondDataModel): three pairs, each a StringField whose `choices` are exactly
// these. Strength is a DERIVED getter (count of set emotions + bonuses) — NOT a stored/writable field.
// A bond's fleeting/solid/eternal *tier* is owned by the rippers-deeper-bonds module (matched by name),
// defaulting to FLEETING for any bond without a record; there is no `fleeting` field on the FU bond, so
// adding a bond inline simply creates a (fleeting-by-default) bond — nothing is invented here.
const RS_BOND_EMOTIONS = Object.freeze({
	admInf: ['Admiration', 'Inferiority'],
	loyMis: ['Loyalty', 'Mistrust'],
	affHat: ['Affection', 'Hatred'],
});
/** PURE: option list for one bond-emotion select — a blank ("—") plus the two FU choices, with `sel`
 *  marking the current value. Used by the inline bonds editor VM. */
function bondEmotionOptions(field, current) {
	const cur = String(current ?? '');
	return [{ v: '', label: '—', sel: cur === '' }, ...(RS_BOND_EMOTIONS[field] ?? []).map((v) => ({ v, label: v, sel: cur === v }))];
}
/** PURE: derived bond strength = count of set emotions (FU's getter, sans actor bonuses which we can't
 *  see from raw source). Kept for the read-only display in the inline editor. */
function bondStrengthOf(bond) { return ['admInf', 'loyMis', 'affHat'].filter((k) => bond?.[k]).length; }
/** PURE: append one empty FU bond to a bonds array (immutably) — the inline "add bond" row. */
function withBondAppended(bonds) { return [...(bonds ?? []), { name: '', admInf: '', loyMis: '', affHat: '' }]; }
/** PURE: remove the bond at `idx` from a bonds array (immutably) — the inline "remove bond" control. */
function withBondRemoved(bonds, idx) { const out = [...(bonds ?? [])]; if (idx >= 0 && idx < out.length) out.splice(idx, 1); return out; }

// ── v0.7.15: full inventory + native Active Effects + equip (Tier-1 parity, all NATIVE FU/Foundry data) ──
// Non-weapon inventory types + the key display fields to read off each (paths verified against the FU
// dev checkout's data models — nothing invented). Weapons keep their own richer editing block in Kit.
const RS_INVENTORY_TYPES = [
	{ type: 'armor', label: 'Armor', fields: [['DEF', 'system.def.value'], ['MDEF', 'system.mdef.value'], ['INIT', 'system.init.value']], equip: true },
	{ type: 'shield', label: 'Shields', fields: [['DEF', 'system.def.value'], ['MDEF', 'system.mdef.value'], ['INIT', 'system.init.value']], equip: true },
	{ type: 'accessory', label: 'Accessories', fields: [['DEF', 'system.def.value'], ['MDEF', 'system.mdef.value'], ['INIT', 'system.init.value']], equip: true },
	{ type: 'consumable', label: 'Consumables', fields: [['IP', 'system.ipCost.value'], ['Type', 'system.subtype.value']], use: true },
	{ type: 'treasure', label: 'Treasures', fields: [['Value', 'system.cost.value'], ['Qty', 'system.quantity.value'], ['Type', 'system.subtype.value']] },
];
/** PURE: read a dot-path off an object, tolerating missing links. */
function rsDotGet(obj, path) { return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
/** PURE: is this item type one the actor equips into a native slot? */
function itemEquippable(type) { return ['armor', 'shield', 'accessory', 'weapon', 'customWeapon'].includes(type); }
/** PURE: two-handed test tolerant of both weapon shapes (weapon wraps hands in .value; customWeapon bare). */
function itemIsTwoHanded(item) { return (item?.system?.hands?.value ?? item?.system?.hands) === 'two-handed'; }
/** PURE: the next actor `system.equipped` record after toggling `item`'s slot, mirroring FU's equipment-
 *  handler logic (armor/accessory single slot; shield → offHand; weapon → mainHand, both hands if 2H;
 *  toggling an already-equipped item clears it). Blank string = empty slot (equipped slots are StringFields).
 *  Adapts PFU equipment-handler LOGIC (MIT); no rules VALUES invented. */
function equipToggleUpdate(equipped, item) {
	const e = { ...(equipped ?? {}) };
	const id = item?.id; if (!id) return e;
	const clear = (slot) => { if (e[slot] === id) e[slot] = ''; };
	switch (item.type) {
		case 'armor': e.armor = e.armor === id ? '' : id; break;
		case 'accessory': e.accessory = e.accessory === id ? '' : id; break;
		case 'shield': e.offHand = e.offHand === id ? '' : id; break;
		case 'weapon': case 'customWeapon':
			if (e.mainHand === id || e.offHand === id) { clear('mainHand'); clear('offHand'); }
			else { e.mainHand = id; if (itemIsTwoHanded(item)) e.offHand = id; }
			break;
	}
	return e;
}
/** PURE: which of the four AE panels an effect belongs to. `active`/`isTemporary` are Foundry AE members;
 *  we pass them in so this stays unit-testable without a live document. Mirrors the FU renderer's split. */
function effectBucket({ isTemporary, active }) { return isTemporary ? 'temporary' : (active ? 'passive' : 'inactive'); }
/** Gather the actor's Active Effects (incl. those transferred from owned items/guises) bucketed for the
 *  Effects tab. Read-only VM; tolerates a stubbed actor (tests / no-AE env). Passives showing as active
 *  IS the passive-verification surface (P5b). */
function buildEffectsVM(actor) {
	const groups = { temporary: [], passive: [], inactive: [] };
	let list = [];
	try {
		list = typeof actor?.allApplicableEffects === 'function'
			? [...actor.allApplicableEffects()]
			: [...(actor?.effects ?? [])];
	} catch { list = []; }
	for (const ef of list) {
		try {
			const bucket = effectBucket({ isTemporary: !!ef.isTemporary, active: ef.active ?? !ef.disabled });
			const srcName = ef.parent && ef.parent !== actor ? (ef.parent.name ?? '') : '';
			groups[bucket].push({ id: ef.id, name: ef.name ?? ef.label ?? '(effect)', img: ef.img ?? ef.icon ?? 'icons/svg/aura.svg', disabled: !!ef.disabled, source: srcName });
		} catch { /* skip a malformed effect */ }
	}
	const G = [
		{ key: 'temporary', label: 'Temporary', createType: 'temporary', effects: groups.temporary },
		{ key: 'passive', label: 'Passive', createType: 'passive', effects: groups.passive },
		{ key: 'inactive', label: 'Inactive', createType: 'inactive', effects: groups.inactive },
	];
	return { groups: G, any: G.some((g) => g.effects.length) };
}
/** Spells VM (Tier-1 #1): the actor's native 'spell' Items — list + cast. Spells are actor-owned (they
 *  persist across guise swaps, like the Hunter Weapon), NOT materialised from a guise's classes: our data
 *  has no class→spell mapping, so auto-materialisation is deferred (⚠ owed — see the report to god). This
 *  tab surfaces + casts whatever spell Items the actor holds, using native item.roll(). Fields verified
 *  against the FU spell data model (mpCost/target/duration/isOffensive); nothing invented. */
function buildSpellsVM(actor) {
	const spells = (actor?.itemTypes?.spell ?? []).map((s) => ({
		id: s.id, name: s.name ?? '', img: s.img,
		mp: rsDotGet(s, 'system.mpCost.value') ?? '',
		target: rsDotGet(s, 'system.target.value') ?? '',
		duration: rsDotGet(s, 'system.duration.value') ?? '',
		offensive: !!rsDotGet(s, 'system.isOffensive.value'),
	}));
	return { spells, any: spells.length > 0 };
}
/** Full non-weapon inventory VM (armor/shield/accessory/consumable/treasure) with the actor's native
 *  equipped-slot state. Read-only; weapons keep their own Kit block. */
function buildInventoryVM(actor) {
	let isEq = () => false;
	try { const rec = actor?.system?.equipped; if (rec && typeof rec.isEquipped === 'function') isEq = (it) => { try { return !!rec.isEquipped(it); } catch { return false; } }; } catch { /* no equip record */ }
	const sections = RS_INVENTORY_TYPES.map((spec) => {
		const items = (actor?.itemTypes?.[spec.type] ?? []).map((it) => ({
			id: it.id, name: it.name ?? '', img: it.img,
			fields: spec.fields.map(([label, path]) => ({ label, val: rsDotGet(it, path) ?? '—' })),
			equippable: !!spec.equip && itemEquippable(it.type), equipped: !!spec.equip && isEq(it),
			usable: !!spec.use,
		}));
		return { type: spec.type, label: spec.label, items, any: items.length > 0 };
	});
	return { sections, any: sections.some((s) => s.any) };
}
/** v0.7.25 — 'The Guise' PLAY SURFACE: a Persona-style at-a-glance readout of a guise. Async (resolves
 *  class/skill/heroic UUIDs + per-skill descriptions for the look-closer layer). v0.7.29 skins it to the
 *  Design mockup (GUISE-PLAY-SURFACE-DESIGN-SPEC.md, 2a "The Slash"): 9-element affinity grid, 3 heroic
 *  slots, WHAT-THIS-GUISE-CHANGES chips, die-shape attributes, PREVIEW of another guise, clot stub.
 *  HARD RULE: ⚠ is never silently filled — dashed = empty/unrecorded, green = live effect/immune, red =
 *  vulnerable/owed. Real data only; where a field isn't in our books it is rendered as the ⚠ hole exactly
 *  as the design draws it. ATTRIBUTES are CHARACTER-level (post-effect .current), NOT per-guise (Austin).
 *  `opts.previewId` renders ANOTHER owned guise's readout WITHOUT binding it (the character strip, which is
 *  character-level, is unaffected and stays on the root VM). */
async function buildGuisePlayVM(actor, opts = {}) {
	const activeItem = activeGuiseItem(actor);
	// PREVIEW (spec §3): show a different owned guise's readout — no Swap, no Turn, player-visible.
	let guise = activeItem, preview = false;
	if (opts.previewId) {
		const pv = actor?.items?.get?.(opts.previewId) ?? null;
		if (pv && isGuiseItem(pv) && pv.id !== activeItem?.id) { guise = pv; preview = true; }
	}
	// The preview MENU: every guise the actor owns; the worn one carries the BOUND marker.
	const guiseMenu = (actor?.items?.filter ? actor.items.filter(isGuiseItem) : []).map((g) => ({
		id: g.id, name: g.name ?? '(guise)', worn: g.id === activeItem?.id,
		previewing: preview && g.id === guise?.id, marker: g.id === activeItem?.id ? 'BOUND' : '',
	}));
	if (!guise) return { active: false, guiseMenu };
	const d = guise.system?.data ?? {};
	const innate = !!guise.getFlag?.(MODULE_ID, 'isInnate') || d.mode === 'innate';
	// Classes → skills (name + SL + max + look-closer description + source tag). An unresolvable class UUID
	// is an UNAUTHORED class slot (dashed ⚠), not an error — the design draws Carbolic Coat that way.
	const classes = [];
	for (const cls of d.classes ?? []) {
		const cdoc = await safeFromUuid(cls.classUuid);
		if (!cdoc) { classes.push({ name: '', unauthored: true, skills: [], hasSubNote: false }); continue; }
		const defs = await skillsForClass(cls.classUuid);          // [{uuid,name,maxSl}] parsed from the class ref
		const byUuid = new Map(defs.map((s) => [s.uuid, s]));
		const skills = [];
		for (const s of cls.skills ?? []) {
			const skDoc = await safeFromUuid(s.skillUuid);
			const desc = skDoc?.system?.description ?? '';
			// Source tag: from the skill Item where authored (a citation flag or system.source); else omitted.
			const source = String(skDoc?.getFlag?.(MODULE_ID, 'source') ?? skDoc?.system?.source?.value ?? '').trim();
			skills.push({
				name: byUuid.get(s.skillUuid)?.name ?? skDoc?.name ?? '(skill)',
				sl: Number(s.sl) || 0, maxSl: Number(byUuid.get(s.skillUuid)?.maxSl ?? 1),
				desc, hasDesc: !!String(desc).trim(), source, hasSource: !!source,
			});
		}
		// Sub-note line (therioform names etc.): NO structured selection dataset exists (flagged to god);
		// rendered only if authored on the class entry, never invented.
		const subNote = String(cls.subNote ?? '').trim();
		classes.push({ name: cdoc.name ?? '(class)', unauthored: false, skills, subNote, hasSubNote: !!subNote });
	}
	// Heroic row — THREE slots. Slot 0 = the guise's own (signature/innate) Heroic; 1 & 2 are drawn empty
	// (whether extra heroics attach to a bound guise is UNDECIDED — Austin; render dashed EMPTY, no invent).
	const heroicUuid = innate ? d.innateHeroicUuid : d.attachedHeroicUuid;
	const hDoc = heroicUuid ? await safeFromUuid(heroicUuid) : null;
	const heroicSlots = [0, 1, 2].map((i) => {
		if (i === 0 && hDoc) {
			const desc = hDoc.system?.description ?? '';
			const req = String(hDoc.system?.requirement?.value ?? hDoc.system?.requirements?.value ?? hDoc.system?.class?.value ?? '').trim();
			return { filled: true, name: hDoc.name ?? '(heroic)', desc, hasDesc: !!String(desc).trim(), req, hasReq: !!req };
		}
		return { filled: false };
	});
	const heroic = hDoc?.name ?? '';   // kept for back-compat / headless tests
	// Affinities — ALL NINE elements. Guise trio recorded via affinityModifiers; the rest neutral. IMMUNE
	// (green) = level ≥ 2, RESISTANT (tan) = 1, VULNERABLE (red) = ≤ −1, neutral (dashed) = 0.
	const recorded = new Map((d.affinityModifiers ?? []).map((m) => [m.type, Number(m.level) || 0]));
	const affinities = RS_AFFINITY_TYPES.map((t) => {
		const lvl = recorded.get(t) ?? 0;
		const state = lvl >= 2 ? 'immune' : lvl === 1 ? 'resistant' : lvl <= -1 ? 'vulnerable' : 'neutral';
		return { type: t, level: lvl, word: lvl === 0 ? '—' : affinityWordOf(lvl), state };
	});
	const affinityTrioOwed = (d.affinityModifiers ?? []).length === 0;   // unrecorded → all-neutral + red note
	// Attributes — CHARACTER-level, post-effect .current vs .base. An effect-moved die renders green ▲ and
	// keeps the base recoverable. Die SHAPES per the spec: d6 square, d8 diamond, d10 kite (else hex).
	const ABBR = { dex: 'DEX', ins: 'INS', mig: 'MIG', wlp: 'WLP' };
	const SHAPE = { 6: 'sq', 8: 'dia', 10: 'kite' };
	const attributes = ['mig', 'dex', 'ins', 'wlp'].map((k) => {
		const a = actor?.system?.attributes?.[k] ?? {};
		const die = Number(a.current ?? a.base ?? 6) || 6;
		const base = Number(a.base ?? die) || die;
		return { key: k, label: ABBR[k], die, base, shape: SHAPE[die] ?? 'hex', buffed: die > base, debuffed: die < base };
	});
	// WHAT THIS GUISE CHANGES — the WORN guise's modifiers, from REAL data only: its lent HP/MP layers +
	// IP satchel (system.data.lentHp/lentMp/ipSatchel — first-class guise state) and attribute die-bumps
	// (current > base). Skill-derived ACC/DMG mods are computed by the rules engine, not stored on a guise
	// → NOT emitted here (flagged to god). Die-bumps reflect ALL live character effects, not only this
	// guise's (precise per-guise attribution would need the effect's origin flag — a refinement, flagged).
	const changes = [];
	const gv = guiseVitals(guise);
	if (gv.hp.maximum > 0) changes.push({ label: `+${gv.hp.maximum} HP`, note: 'lent layer', kind: 'lent' });
	if (gv.mp.maximum > 0) changes.push({ label: `+${gv.mp.maximum} MP`, note: 'lent layer', kind: 'lent' });
	if (gv.ip.capacity > 0) changes.push({ label: `+${gv.ip.capacity} IP`, note: 'satchel', kind: 'ip' });
	for (const a of attributes) if (a.buffed) changes.push({ label: `▲ ${a.label} d${a.base}→d${a.die}`, note: 'effect', kind: 'die' });
	// Equipped gear (native system.equipped record → resolved items). Armor line + full equipped block.
	const eq = actor?.system?.equipped ?? {};
	const getItem = (id) => (id ? (actor?.items?.get?.(id) ?? null) : null);
	const armorItem = getItem(eq.armor);
	const armor = armorItem ? {
		name: armorItem.name ?? '',
		defFormula: `${(rsDotGet(armorItem, 'system.def.attribute') ?? 'dex').toUpperCase()}+${rsDotGet(armorItem, 'system.def.value') ?? 0}`,
		mdefFormula: `${(rsDotGet(armorItem, 'system.mdef.attribute') ?? 'ins').toUpperCase()}+${rsDotGet(armorItem, 'system.mdef.value') ?? 0}`,
		martial: !!rsDotGet(armorItem, 'system.isMartial.value'),
	} : null;
	const wornDef = Number(actor?.system?.derived?.def?.value ?? 0), wornMdef = Number(actor?.system?.derived?.mdef?.value ?? 0);
	const equippedSlots = [['mainHand', eq.mainHand], ['offHand', eq.offHand], ['armor', eq.armor], ['accessory', eq.accessory]];
	const seenEq = new Set();
	const equipment = equippedSlots.map(([slot, id]) => {
		if (!id || seenEq.has(id)) return null; seenEq.add(id);
		const it = getItem(id); if (!it) return null;
		return { slot, name: it.name ?? '', img: it.img, type: it.type };
	}).filter(Boolean);
	// Weapon / unarmed strike detail (reuse weaponStats). Prefer the equipped mainHand weapon, else first.
	const weaponItems = [...(actor?.itemTypes?.weapon ?? []), ...(actor?.itemTypes?.customWeapon ?? [])];
	const primaryWeapon = getItem(eq.mainHand) && weaponItems.some((w) => w.id === eq.mainHand) ? getItem(eq.mainHand) : weaponItems[0] ?? null;
	const weapon = primaryWeapon ? { name: primaryWeapon.name ?? '', ...weaponStats(primaryWeapon) } : null;
	// Clot pane: only the empty state is designed — a seated-Clot readout is UNSPECIFIED (spec §9, owed to
	// Austin). Stub the seated state; render the empty state faithfully. No invented seated readout.
	const clot = { seated: false };
	// Torment: character-level; authored on a flag if present, else the ⚠ hole (never invented).
	const torment = String(actor?.getFlag?.(MODULE_ID, 'torment') ?? '').trim();
	const bonusDescriptor = d.bonus?.descriptor ?? '';
	return {
		active: true, preview, previewName: preview ? (guise.name ?? '') : '', activeName: activeItem?.name ?? '',
		guiseMenu, guiseName: guise.name ?? '', innate, tradable: !innate, torment,
		classes, heroic, heroicSlots, affinities, affinityTrioOwed, attributes, changes,
		armor, wornDef, wornMdef, equipment, weapon, clot,
		bane: d.bane ?? '', tell: d.tell ?? '', perk: d.perk ?? '',
		bonus: bonusDescriptor ? { descriptor: bonusDescriptor, value: Number(d.bonus?.value ?? 3) } : null,
		fieldLimit: guiseFieldLimit(partySize()),
	};
}
// The six core FU statuses (exact ids, projectfu config.mjs FU.temporaryEffects) + the boons/banes tray.
const RS_STATUS_IDS = ['slow', 'dazed', 'weak', 'shaken', 'enraged', 'poisoned'];
const RS_COND_GROUPS = [
	{ label: 'ATTR UP', ids: ['dex-up', 'ins-up', 'mig-up', 'wlp-up'] },
	{ label: 'ATTR DOWN', ids: ['dex-down', 'ins-down', 'mig-down', 'wlp-down'] },
	{ label: 'BOONS/BANES', ids: ['guard', 'cover', 'aura', 'barrier', 'flying', 'provoked', 'focus', 'pressure', 'stagger'] },
];
const RS_TABS = [
	{ key: 'play', label: 'The Guise' },
	{ key: 'form', label: 'Form' }, { key: 'bonds', label: 'Bonds' }, { key: 'study', label: 'Study' },
	{ key: 'resources', label: 'Resources' }, { key: 'vault', label: 'Vault' },
	{ key: 'spells', label: 'Spells' }, { key: 'kit', label: 'Kit' }, { key: 'effects', label: 'Effects' },
	{ key: 'clots', label: 'Clots' }, { key: 'quirk', label: 'Quirk' }, { key: 'edit', label: 'Edit' },
];
const RS_TAB_STUBS = {
	clots: 'No Clot is seated. A seated Clot rides its gear, not the character.',
	quirk: 'The character\'s Quirk and Specialties are shown here.',
};
const rsAffFlags = (lvl) => ({ good: lvl >= 1, bad: lvl === -1 });

// ── Lent-vital DISPLAY (X1/G4/H5, Austin 4 Sep: OPTION A + parens) ────────────────────────────────
// A lent vital renders as a TEMPORARY (shield-style) segment overlaid on the HP/MP bar, the number in
// parens (e.g. `45 (+8)`); IP is the same but as DOTS (H5). ONE code path everywhere it shows — the
// HUD card, the guise edit tab and the vault roster reuse vitalBar/vitalDots (exported). Pure.
/** HP/MP bar model. base + lent share a track scaled to (max + lent), so the lent shield reads as extra
 *  capacity beyond the max. `display` is the parenthesised number Austin specified. */
function vitalBar(value, max, lent = 0) {
	const v = Math.max(0, Number(value) || 0);
	const m = Number.isFinite(Number(max)) && Number(max) > 0 ? Number(max) : null;
	const l = Math.max(0, Number(lent) || 0);
	const denom = (m ?? v) + l || 1;
	const basePct = Math.round((Math.min(v, m ?? v) / denom) * 100);
	const lentPct = l > 0 ? Math.round((l / denom) * 100) : 0;
	const fillPct = m ? Math.round((Math.min(v, m) / m) * 100) : (v > 0 ? 100 : 0);
	return { value: v, max: m, lent: l, basePct, lentPct, fillPct, display: l > 0 ? `${v} (+${l})` : `${v}` };
}
/** IP dot model (H5): `max` base dots, `value` filled; `lent` extra temporary dots; parenthesised number. */
function vitalDots(value, max, lent = 0) {
	const v = Math.max(0, Number(value) || 0);
	const m = Math.max(0, Number.isFinite(Number(max)) ? Number(max) : v);
	const l = Math.max(0, Number(lent) || 0);
	const dots = Array.from({ length: m }, (_, i) => ({ filled: i < Math.min(v, m) }));
	const lentDots = Array.from({ length: l }, () => ({ temp: true }));
	return { value: v, max: m, lent: l, dots, lentDots, display: l > 0 ? `${v} (+${l})` : `${v}` };
}

// ── G4 Resources tab — generic per-actor tracked resources (no invented class data) ───────────────
const TRACKED_RESOURCES_FLAG = 'trackedResources';
/** PURE: adjust a tracked resource's value by delta, clamped 0..max (if a max is set). Returns a new list. */
function adjustTrackedResource(list, key, delta) {
	return (list ?? []).map((r) => {
		if (r?.key !== key) return r;
		const max = Number.isFinite(Number(r.max)) ? Number(r.max) : null;
		let v = (Number(r.value) || 0) + Math.trunc(Number(delta) || 0);
		v = Math.max(0, max != null ? Math.min(max, v) : v);
		return { ...r, value: v };
	});
}

// ── Deeper Bonds native integration (SHEET-INJECTION-AUDIT.md, arch B) ────────────────────────────
// Exactly one module decorates the character sheet — rippers-deeper-bonds — via FU's
// renderFUStandardActorSheet hook, which does NOT fire on RippersSheet. So its per-bond controls vanish.
// We render the Bonds panel NATIVELY here, driving the module's published API (game.modules.get(
// 'rippers-deeper-bonds').api). Data lives in the module's flags + the FU bond `bonus`; we READ and
// RECONCILE through the API (getRecords / bondStrength / ladderAbilities) and never duplicate its state.
// Everything is GM-authoritative — the API no-ops non-GM callers; we also hide the controls off-GM.
const DEEPER_BONDS_ID = 'rippers-deeper-bonds';
const SOLID_BOND_CAP = 6; // DEFAULT_SOLID_CAP (canon; the API is the authority and refuses over-cap regardless).
/** The Deeper Bonds runtime API, or null when the module is absent/inactive (headless tests included). */
function deeperBondsApi() { return globalThis.game?.modules?.get?.(DEEPER_BONDS_ID)?.api ?? null; }

/** rippers-automation's runtime API (R1 Rival roller toggle + quirk detection), or null when absent. */
function rippersAutomationApi() { return globalThis.game?.modules?.get?.('rippers-automation')?.api ?? null; }
/** R1 VM: does this actor hold the Rival quirk, and is its cost-waiver toggle armed? (thin, api-driven). */
function rivalWaiverVM(actor) {
	const api = rippersAutomationApi();
	if (!api?.actorHasQuirk || !api.actorHasQuirk(actor, 'rival-prodigies')) return { has: false, armed: false };
	return { has: true, armed: !!api.isRivalWaiverArmed?.(actor) };
}

// ── 2a Slash guise identity: the 22 major arcana tiles ────────────────────────────────────────────
// Austin's art, LOCAL module assets ONLY (copyright: home-game rendering; NEVER push these to a remote
// or publish — our no-push norm covers it). A guise's arcana persists as a slug on the Item flag
// flags['rippers-guise'].arcana — the README's production mapping of the design's localStorage 'g:' key.
const ARCANA_FLAG = 'arcana';
// The arcana IMAGE base is a world SETTING (arcanaBasePath): a code-only module ships WITHOUT the art
// (copyright — assets/arcana is excised + gitignored), so the tiles/picker resolve to wherever the GM
// actually put the files. Default is the module-internal folder, so a LOCAL dev instance with the
// untracked art still renders. Austin sets it to his Forge data path, e.g. "Rippers/Arcana/Major Arcana".
// The filename convention is FIXED — each major is `<slug>.png` (the 22 slugs below). URL = base/<slug>.png.
const ARCANA_BASE_SETTING = 'arcanaBasePath';
const DEFAULT_ARCANA_BASE = `modules/${MODULE_ID}/assets/arcana`;
const ARCANA = Object.freeze([
	['00-the-fool', 'The Fool'], ['01-the-magician', 'The Magician'], ['02-the-high-priestess', 'The High Priestess'],
	['03-the-empress', 'The Empress'], ['04-the-emperor', 'The Emperor'], ['05-the-hierophant', 'The Hierophant'],
	['06-the-lovers', 'The Lovers'], ['07-the-chariot', 'The Chariot'], ['08-justice', 'Justice'],
	['09-the-hermit', 'The Hermit'], ['10-wheel-of-fortune', 'Wheel of Fortune'], ['11-strength', 'Strength'],
	['12-the-hanged-man', 'The Hanged Man'], ['13-death', 'Death'], ['14-temperance', 'Temperance'],
	['15-the-devil', 'The Devil'], ['16-the-tower', 'The Tower'], ['17-the-star', 'The Star'],
	['18-the-moon', 'The Moon'], ['19-the-sun', 'The Sun'], ['20-judgement', 'Judgement'], ['21-the-world', 'The World'],
].map(([slug, name]) => ({ slug, name, file: `${slug}.png` })));
const arcanaBySlug = (slug) => ARCANA.find((a) => a.slug === slug) ?? null;
/** The configured arcana image base folder (no trailing slash). Falls back to the module folder when
 *  the setting is unregistered (e.g. under `node --test`, or before init). Pure but for the game read. */
function arcanaBasePath() {
	const raw = globalThis.game?.settings?.get?.(MODULE_ID, ARCANA_BASE_SETTING);
	const base = (typeof raw === 'string' && raw.trim()) ? raw.trim() : DEFAULT_ARCANA_BASE;
	return base.replace(/\/+$/, '');
}
/** PURE join: the image URL for an arcana slug at a given base (base/<slug>.png), or null for unknown. */
function arcanaImgAt(base, slug) {
	const entry = arcanaBySlug(slug);
	return entry ? `${String(base).replace(/\/+$/, '')}/${entry.file}` : null;
}
/** The image URL for an arcana slug at the CONFIGURED base, or null for unknown. */
function arcanaImg(slug) { return arcanaImgAt(arcanaBasePath(), slug); }

// Austin wants NO renaming: the picker ENUMERATES whatever image files live in arcanaBasePath at
// runtime (FilePicker.browse) and the guise stores the CHOSEN FILE'S PATH — so any filenames work and
// the semantic 22-slug list is no longer the lookup key (it survives only as the local default art's
// actual filenames). A guise from the fixed-slug era stored a bare slug; that still resolves against
// the base as a fallback.
const ARCANA_IMAGE_EXTS = Object.freeze(['.png', '.webp', '.jpg', '.jpeg', '.gif', '.avif', '.svg']);
/** PURE. Is this path an image we'll show as an arcana card? */
function isArcanaImage(path) {
	const p = String(path ?? '').toLowerCase();
	return ARCANA_IMAGE_EXTS.some((e) => p.endsWith(e));
}
/** PURE. A human label from a file path: basename without extension, leading index stripped, tidied. */
function prettifyArcanaName(path) {
	const base = String(path ?? '').split('/').pop() ?? '';
	const stem = base.replace(/\.[^.]+$/, '');
	const cleaned = stem.replace(/^\s*\d+\s*[-_. ]+/, '').replace(/[-_]+/g, ' ').trim();
	return cleaned || stem || base;
}
/** PURE. From a FilePicker.browse files[] list → sorted arcana entries {path, name}, images only. */
function arcanaEntriesFromFiles(files) {
	return (Array.isArray(files) ? files : [])
		.filter(isArcanaImage)
		.slice()
		.sort((a, b) => String(a).localeCompare(String(b)))
		.map((path) => ({ path, name: prettifyArcanaName(path) }));
}
/** PURE. Resolve a guise's stored arcana value → {img, name}, or null when unset. A stored FULL PATH
 *  (has a slash or an image extension) is used directly; a legacy bare slug resolves against the base. */
function resolveArcana(stored) {
	if (!stored || typeof stored !== 'string') return null;
	if (stored.includes('/') || isArcanaImage(stored)) return { img: stored, name: prettifyArcanaName(stored) };
	const img = arcanaImg(stored);                       // legacy bare slug → base/<slug>.png
	if (!img) return null;
	return { img, name: arcanaBySlug(stored)?.name ?? prettifyArcanaName(stored) };
}
/** RUNTIME (FilePicker.browse is async, not available headless). Enumerate the image files in the
 *  configured folder → sorted {path, name} entries. Returns [] on a missing/empty folder, never throws. */
async function browseArcana(base) {
	const FP = foundry?.applications?.apps?.FilePicker?.implementation ?? foundry?.applications?.apps?.FilePicker ?? globalThis.FilePicker;
	if (!FP?.browse) return [];
	try {
		const res = await FP.browse('data', base);
		return arcanaEntriesFromFiles(res?.files);
	} catch (err) {
		console.warn('[rippers-guise] could not browse the arcana folder', base, err);
		return [];
	}
}
/** The arcana tile chosen for a guise (from its Item flag), with its resolved img, or null when unset. */
function guiseArcana(guise) { return resolveArcana(guise?.getFlag?.(MODULE_ID, ARCANA_FLAG)); }

// ── H2 two-portrait swap (Austin 4 Sep: NORMAL + OTHER-SHAPE only; our own minimal build, NOT Visage) ─
// Exactly two configurable face images per actor live on flags['rippers-guise'].faces = {normal, other}
// (local-only art, like the arcana). A worn guise ASSIGNS a face — 'normal' | 'other' | 'none' (none =
// the no-portrait well, e.g. the Carbolic Coat); guises do NOT each carry a portrait. Wearing a guise
// swaps actor.img to the matching face (the sheet masthead renders {{actor.img}} and the Stylish HUD
// card reads the actor portrait, so BOTH follow for free); a manual sheet toggle flips it independently.
// Non-destructive: the pre-swap portrait is cached ONCE (Visage's safe-revert PATTERN, MIT — borrowed,
// not vendored). PLAYER guise/shape only — adversary portraits are never touched.
const FACES_FLAG = 'faces';                                   // actor: { normal, other } image paths
const FACE_CACHE_FLAG = 'faceCache';                          // actor: original actor.img (cached once)
const GUISE_FACE_FLAG = 'face';                               // guise Item: 'normal' | 'other' | 'none'
const GUISE_FACE_KEYS = Object.freeze(['normal', 'other', 'none']);
const NO_PORTRAIT_WELL = 'icons/svg/mystery-man.svg';        // the "no-portrait well" (a core Foundry icon)

/** The face a guise assigns: 'normal'|'other'|'none', or null when unassigned (no swap). */
function faceForGuise(guise) {
	const f = guise?.getFlag?.(MODULE_ID, GUISE_FACE_FLAG);
	return GUISE_FACE_KEYS.includes(f) ? f : null;
}
/** PURE. Resolve a face key to an image path. normal/other → faces[key] (null if unset); none → the
 *  no-portrait well; an unknown/unassigned key → undefined (leave the portrait unchanged). */
function resolveFaceImg(faces, faceKey) {
	if (faceKey === 'none') return NO_PORTRAIT_WELL;
	if (faceKey === 'normal' || faceKey === 'other') return faces?.[faceKey] || null;
	return undefined;
}
/** PURE. The manual-toggle target: whichever configured face is NOT the current image (falls back to
 *  normal, then other). Returns null when neither face is set. */
function nextManualFace(faces, currentImg) {
	const n = faces?.normal || null, o = faces?.other || null;
	if (!n && !o) return null;
	if (currentImg === n && o) return o;
	if (currentImg === o && n) return n;
	return n || o;
}
/** The actor's two configured faces (empty strings when unset). */
function getFaces(actor) {
	const f = actor?.getFlag?.(MODULE_ID, FACES_FLAG) ?? {};
	return { normal: f.normal || '', other: f.other || '' };
}
async function setFace(actor, which, path) {
	if (which !== 'normal' && which !== 'other') return;
	const faces = getFaces(actor);
	faces[which] = path || '';
	await actor.setFlag(MODULE_ID, FACES_FLAG, faces);
}
/** Cache the actor's current portrait ONCE (safe-revert). Returns the cached value. */
async function cacheOriginalFace(actor) {
	let cached = actor.getFlag(MODULE_ID, FACE_CACHE_FLAG);
	if (cached == null) { cached = actor.img ?? ''; await actor.setFlag(MODULE_ID, FACE_CACHE_FLAG, cached); }
	return cached;
}
/** Set actor.img to the face a worn guise assigns. Non-destructive (caches first); a guise that assigns
 *  no face, or a normal/other face that isn't configured, leaves the portrait untouched. */
async function applyGuiseFace(actor, guise) {
	const key = faceForGuise(guise);
	if (key == null) return;
	const img = resolveFaceImg(getFaces(actor), key);
	if (img == null) return;                 // undefined (unassigned) or null (normal/other unset) → skip
	await cacheOriginalFace(actor);
	if (actor.img !== img) await actor.update({ img });
}
/** Restore the base (NORMAL) face on unmask — else the cached original. Non-destructive. */
async function restoreBaseFace(actor) {
	const faces = getFaces(actor);
	const target = faces.normal || actor.getFlag(MODULE_ID, FACE_CACHE_FLAG) || null;
	if (target && actor.img !== target) await actor.update({ img: target });
}
/** H2 VM: the two configured faces + which is currently shown + whether a manual toggle is possible. */
function guiseFacesVM(actor) {
	const faces = getFaces(actor);
	const cur = actor?.img ?? '';
	return { normal: faces.normal, other: faces.other, canToggle: !!(faces.normal || faces.other), onNormal: cur === faces.normal && !!faces.normal, onOther: cur === faces.other && !!faces.other };
}
/** Manual sheet toggle: flip actor.img between the two configured faces (independent of worn guise). */
async function sheetToggleFace(actor) {
	const next = nextManualFace(getFaces(actor), actor.img);
	if (!next) { ui.notifications?.info(game.i18n?.localize?.('RIPPERS.Sheet.NoFaces') ?? 'Set this character\'s two faces first.'); return; }
	await cacheOriginalFace(actor);
	if (actor.img !== next) await actor.update({ img: next });
}

/** PURE: a bond clock's four sections as fill flags (filled up to `clock`). */
function bondClockPips(clock, sections = 4) {
	const n = Math.max(0, Math.min(sections, Number(clock) || 0));
	return Array.from({ length: sections }, (_, i) => ({ filled: i < n }));
}
/** PURE: one Bonds-panel row VM from an FU bond + its Deeper record + strength + unlocked ladder. Only
 *  solid bonds carry a clock (fillClock refuses others); Solidify shows on fleeting and disables at cap. */
function bondPanelRow(fuBond, record, strength, ladder, { cap = SOLID_BOND_CAP, solidCount = 0 } = {}) {
	const tier = record?.tier ?? 'fleeting';
	const isFleeting = tier === 'fleeting', isSolid = tier === 'solid', isEternal = tier === 'eternal';
	const s = Number(strength) || 0;
	return {
		name: fuBond?.name ?? '',
		emotions: [fuBond?.admInf, fuBond?.loyMis, fuBond?.affHat].filter(Boolean),
		strength: s,
		tier, isFleeting, isSolid, isEternal,
		clock: Math.max(0, Math.min(4, Number(record?.clock) || 0)),
		clockPips: bondClockPips(record?.clock),
		showClock: isSolid,
		solidifyShow: isFleeting,
		solidifyDisabled: isFleeting && solidCount >= cap,
		canEternal: isSolid,
		// v0.7.27: party-member flag (Deeper record). Gates Status-recover + Shared Resolve in the template;
		// the die-size increase (attrDieUp) is emotional and NOT gated on it. cleanse/coverRegen ladder flags
		// stay strength-based here; the template ANDs them with partyMember.
		partyMember: !!record?.partyMember,
		ladder: {
			cleanse: !!ladder?.cleanse, coverRegen: !!ladder?.coverRegen,
			attrDieUp: !!ladder?.attrDieUp, skillGrant: !!ladder?.skillGrant,
		},
		grantedSkill: record?.grantedSkill?.skillName ?? '',
	};
}
/** PURE: assemble the native Bonds-panel rows from FU bonds + Deeper records + an api-shaped reader
 *  ({ strengthOf(name), ladderOf(strength, tier) }). Keeps the Foundry reads out of the row shaping so
 *  the panel VM is unit-testable. Filters out fully-empty bonds, mirroring the fallback grid. */
function buildBondPanelRows(fuBonds, records, api, { cap = SOLID_BOND_CAP } = {}) {
	const solidCount = (records ?? []).filter((r) => r?.tier === 'solid').length;
	return (fuBonds ?? []).map((b) => {
		const rec = (records ?? []).find((r) => r?.name === b?.name) ?? null;
		const strength = api.strengthOf(b?.name);
		const ladder = api.ladderOf(strength, rec?.tier ?? 'fleeting');
		return bondPanelRow(b, rec, strength, ladder, { cap, solidCount });
	}).filter((b) => b.name || b.emotions.length);
}

/** Build the read-only view-model for the Rippers character sheet from a live FU actor. Async (resolves
 *  each guise's heroic name). Binds ONLY real actor.system.* + our guise API — invents nothing. `ui`
 *  carries the sheet's own view state (activeTab / statusSelf / showConditions). Exported for headless
 *  testing of the pure shaping (given a plain actor-shaped object). */
async function buildRippersSheetVM(actor, ui = {}) {
	if (!actor) return null;
	const activeTab = RS_TABS.some((t) => t.key === ui.activeTab) ? ui.activeTab : 'form';
	const statusSelf = ui.statusSelf !== false;
	const showConditions = !!ui.showConditions;
	const sys = actor.system ?? {};
	const res = sys.resources ?? {};
	const pool = (r) => ({ value: Number(r?.value ?? 0), max: Number.isFinite(Number(r?.max)) ? Number(r.max) : null });
	const hp = pool(res.hp), mp = pool(res.mp), ip = pool(res.ip);
	// X1/G4/H5: the worn guise's lent layer overlays the bars as a temporary shield (parens number). One
	// code path (vitalBar/vitalDots) reused by the HUD card + vault roster. No worn guise → lent 0.
	const lentActive = guiseVitals(activeGuiseItem(actor));
	const vitals = {
		hp: { ...hp, bar: vitalBar(hp.value, hp.max, lentActive.hp.current) },
		mp: { ...mp, bar: vitalBar(mp.value, mp.max, lentActive.mp.current) },
		ip: { ...ip, dots: vitalDots(ip.value, ip.max, lentActive.ip.stock) },
		fp: Number(res.fp?.value ?? 0),                              // FP has no max on a PC
		exp: Number(res.exp?.value ?? 0), zenit: Number(res.zenit?.value ?? 0),
		crisis: { inCrisis: !!res.hp?.inCrisis, score: Number(res.hp?.crisisScore ?? Math.floor((hp.max ?? 0) / 2)) },
	};
	const derived = {
		def: Number(sys.derived?.def?.value ?? 0), mdef: Number(sys.derived?.mdef?.value ?? 0),
		init: Number(sys.derived?.init?.value ?? 0),
	};
	const attributes = ['dex', 'ins', 'mig', 'wlp'].map((k) => ({
		key: k, label: RS_ATTR_LABELS[k],
		die: `d${Number(sys.attributes?.[k]?.current ?? sys.attributes?.[k]?.base ?? 8)}`,
	}));
	const affinities = RS_AFFINITY_TYPES.map((t) => {
		const lvl = Number(sys.affinities?.[t]?.current ?? sys.affinities?.[t]?.base ?? 0);
		return { type: t, level: lvl, word: lvl === 0 ? '—' : affinityWordOf(lvl), normal: lvl === 0, ...rsAffFlags(lvl) };
	});
	const idn = (k) => String(res[k]?.name ?? '').trim();
	const masthead = {
		name: actor.name ?? '', identity: idn('identity'), pronouns: idn('pronouns'),
		theme: idn('theme'), origin: idn('origin'), level: Number(sys.level?.value ?? 0),
		classes: (actor.itemTypes?.class ?? []).map((c) => c.name).filter(Boolean),
		// 2a skin: the big background letter is the character's own initial (Austin), not a fixed 'V'.
		initial: (String(actor.name ?? '').trim().charAt(0) || '?').toUpperCase(),
	};
	const activeId = getActiveGuise(actor);
	const budget = budgetOf(actor);
	const guiseItems = actor.items?.filter ? actor.items.filter(isGuiseItem) : [];
	const guises = [];
	let wornName = '';
	// H3 "The Turn": scene-swap state, so the roster can hint which swap would be free this scene.
	const { used: sceneUsed, turnRefundUsed } = guiseSceneState(actor);
	// Perf (v0.7.14): resolve every class + heroic doc ONCE per render — deduped, in parallel — instead of
	// per-guise-per-class serial fromUuid pulls. A character with N guises × 3 classes was doing ~2×3N
	// AWAITED compendium lookups on every sheet render (the same class re-fetched for each guise that
	// carries it, and each class fetched twice: skillsForClass + a second safeFromUuid for the name). That
	// serial I/O is the "odd delay". We now gather the unique UUIDs, resolve them concurrently, and the
	// guise loop reads from the maps synchronously — no awaits inside the loop at all.
	const _classUuids = new Set(), _heroicUuids = new Set();
	for (const g of guiseItems) {
		const d = g.system?.data ?? {};
		const innate = !!g.getFlag?.(MODULE_ID, 'isInnate') || d.mode === 'innate';
		for (const cls of d.classes ?? []) if (cls?.classUuid) _classUuids.add(cls.classUuid);
		const hu = innate ? d.innateHeroicUuid : d.attachedHeroicUuid;
		if (hu) _heroicUuids.add(hu);
	}
	const _classDocs = new Map(), _heroicDocs = new Map();
	await Promise.all([
		...[..._classUuids].map(async (u) => { _classDocs.set(u, await safeFromUuid(u)); }),
		...[..._heroicUuids].map(async (u) => { _heroicDocs.set(u, await safeFromUuid(u)); }),
	]);
	const _classDefs = new Map();       // classUuid → parsed skill defs (parseClassSkills is sync)
	for (const [u, doc] of _classDocs) _classDefs.set(u, parseClassSkills(doc?.system?.description ?? ''));

	for (const g of guiseItems) {
		const d = g.system?.data ?? {};
		const innate = !!g.getFlag?.(MODULE_ID, 'isInnate') || d.mode === 'innate';
		const trio = (d.affinityModifiers ?? []).map((m) => ({ type: m.type, word: affinityWordOf(m.level), level: m.level, ...rsAffFlags(m.level) }));
		let skillCount = 0, slTotal = 0;
		for (const cls of d.classes ?? []) for (const sk of cls.skills ?? []) { skillCount++; slTotal += Number(sk.sl) || 0; }
		// Inline SL editing: resolve each class's skills to editable rows (name + maxSl from the class ref).
		const slEditable = guiseSlEditable(g);
		const skillGroups = [];
		for (const cls of d.classes ?? []) {
			const defs = _classDefs.get(cls.classUuid) ?? [];
			const byUuid = new Map(defs.map((s) => [s.uuid, s]));
			const cdoc = _classDocs.get(cls.classUuid);
			skillGroups.push({
				classUuid: cls.classUuid, className: cdoc?.name ?? '(class)',
				skills: (cls.skills ?? []).map((s) => ({
					skillUuid: s.skillUuid, classUuid: cls.classUuid,
					name: byUuid.get(s.skillUuid)?.name ?? '(skill)',
					sl: Number(s.sl) || 0, maxSl: Number(byUuid.get(s.skillUuid)?.maxSl ?? 1),
				})),
			});
		}
		const heroicUuid = innate ? d.innateHeroicUuid : d.attachedHeroicUuid;
		const heroicName = heroicUuid ? (_heroicDocs.get(heroicUuid)?.name ?? '(unresolved)') : null;
		const v = guiseVitals(g);
		const worn = g.id === activeId;
		if (worn) wornName = g.name ?? '';
		const usedThisScene = sceneUsed.includes(g.id);
		guises.push({
			id: g.id, name: g.name ?? '', img: g.img, role: d.role ?? '', identity: d.identity ?? '',
			worn, innate, tradable: !innate,
			trio, skillCount, slTotal, budget, heroicName,
			lent: { hp: v.hp, mp: v.mp, ip: v.ip },
			// H3: swapping TO this guise would be refunded by The Turn (free) this scene?
			usedThisScene, swapWouldRefund: !worn && !usedThisScene && !turnRefundUsed,
			slEditable, skillGroups,      // inline SL editing (lock-gated) + resolved skill rows
			arcana: guiseArcana(g), // 2a: the guise-identity tarot tile (null until picked)
			// H2: this guise's face assignment (normal/other/none/'') + booleans for the toggle chips.
			face: faceForGuise(g) ?? '', faceNormal: faceForGuise(g) === 'normal', faceOther: faceForGuise(g) === 'other', faceNone: faceForGuise(g) === 'none',
		});
	}
	guises.sort((a, b) => (Number(b.worn) - Number(a.worn)) || (Number(a.innate) - Number(b.innate)));
	// Bonds tab: render the Deeper Bonds panel NATIVELY when the module is active (per-bond tier/clock/
	// ladder + section controls, all GM-authoritative); otherwise fall back to the plain read-only grid.
	const dbApi = deeperBondsApi();
	let bonds, bondsNative = false, bondsIsGM = false;
	if (dbApi?.getRecords && dbApi?.bondStrength && dbApi?.ladderAbilities) {
		try {
			bondsNative = true;
			bondsIsGM = !!globalThis.game?.user?.isActiveGM;
			const records = dbApi.getRecords(actor) ?? [];
			bonds = buildBondPanelRows(sys.bonds ?? [], records, {
				strengthOf: (name) => dbApi.bondStrength(actor, name),
				ladderOf: (strength, tier) => dbApi.ladderAbilities(strength, tier),
			}, { cap: SOLID_BOND_CAP });
		} catch (err) {
			console.warn('[rippers-guise] Deeper Bonds panel unavailable — plain bond grid:', err);
			bondsNative = false;
		}
	}
	if (!bondsNative) {
		bonds = (sys.bonds ?? []).map((b) => ({
			name: b.name ?? '', strength: Number(b.strength ?? 0),
			emotions: [b.admInf, b.loyMis, b.affHat].filter(Boolean),
		})).filter((b) => b.name || b.emotions.length);
	}
	const activeStatuses = actor.statuses ? new Set([...actor.statuses]) : new Set();
	const statuses = [...activeStatuses];
	const statusChips = RS_STATUS_IDS.map((id) => ({ id, label: id, active: activeStatuses.has(id) }));
	const condGroups = RS_COND_GROUPS.map((grp) => ({ label: grp.label, items: grp.ids.map((id) => ({ id, label: id, active: activeStatuses.has(id) })) }));
	// Weapons for the Kit tab's attack rows (weapon + customWeapon; item.roll() drives the attack flow).
	const weaponItems = [...(actor.itemTypes?.weapon ?? []), ...(actor.itemTypes?.customWeapon ?? [])];
	const ATTR_KEYS = ['dex', 'ins', 'mig', 'wlp'];
	const optList = (list, cur) => list.map((v) => ({ v, sel: v === cur }));
	const weapons = weaponItems.map((w) => {
		const st = weaponStats(w);
		return {
			id: w.id, name: w.name ?? '', img: w.img, type: w.type, ...st,
			edit: {
				paths: st.paths,
				primaryOpts: optList(ATTR_KEYS, st.primKey), secondaryOpts: optList(ATTR_KEYS, st.secKey),
				dtypeOpts: optList(RS_AFFINITY_TYPES, st.dmgType), wtypeOpts: optList(['melee', 'ranged'], st.wtype),
			},
		};
	});
	// Item 3: the character's quirks (Project FU 'effect' Items carrying a rippers-automation fuid, per
	// the automation registry) — listed for add/remove/edit on the Quirk tab. Not the guise locks.
	const quirks = (actor.itemTypes?.effect ?? []).map((i) => ({
		id: i.id, name: i.name ?? '', img: i.img,
		fuid: i.getFlag?.('rippers-automation', 'fuid') ?? i.system?.fuid ?? '',
	}));
	// Editing (Austin: the whole sheet was read-only). Raw values for the Edit tab's two-way inputs —
	// the character's OWN fields (name/identity handled on Study; here: attributes, HP/MP/IP + maxes,
	// FP/EXP/Zenit, bonds). Guise class-skills stay fixed-at-distillation (separate lock). The template
	// binds each input with data-edit="<dot path>" (or bond index/field), written on change by the sheet.
	// Deeper-Bonds tier per bond name (fleeting by default) — read-only chip for the inline editor.
	const bondTierByName = new Map();
	const bondPartyByName = new Map();          // v0.7.27: Deeper party-member flag per bond name
	let bondsDeeperActive = false;
	try {
		const _api = deeperBondsApi();
		bondsDeeperActive = !!_api?.setBondPartyMember;   // party toggle only offered when Deeper Bonds ≥0.2.3 is present
		const _rec = _api?.getRecords?.(actor) ?? [];
		for (const r of _rec) if (r?.name) { bondTierByName.set(r.name, r.tier ?? 'fleeting'); bondPartyByName.set(r.name, !!r.partyMember); }
	} catch { /* module absent or read failed → all fleeting, no party toggle */ }
	const editable = {
		name: actor.name ?? '',
		attributes: ['dex', 'ins', 'mig', 'wlp'].map((k) => {
			const base = Number(sys.attributes?.[k]?.base ?? 8);
			return { key: k, label: RS_ATTR_LABELS[k], base, options: [6, 8, 10, 12].map((n) => ({ n, sel: n === base })) };
		}),
		hp: { value: hp.value, max: hp.max ?? 0 }, mp: { value: mp.value, max: mp.max ?? 0 }, ip: { value: ip.value, max: ip.max ?? 0 },
		fp: vitals.fp, exp: vitals.exp, zenit: vitals.zenit,
		level: Number(sys.level?.value ?? sys.level ?? 0) || 0, // v0.7.20: level display + Level Up (Tier-1 #4)
		// Inline bonds: name + the three FU emotion SELECTS (blank + two valid choices each). Strength is
		// read-only (derived from the emotions). `tier` is the Deeper-Bonds tier by name (fleeting by
		// default) — shown as a chip so a freshly-added bond visibly reads "Fleeting"; promotion to
		// solid/eternal stays on the Bonds tab (GM-gated, Deeper-owned). Add/remove rows below.
		bonds: (sys.bonds ?? []).map((b, i) => ({
			i, name: b.name ?? '',
			admInfOpts: bondEmotionOptions('admInf', b.admInf), loyMisOpts: bondEmotionOptions('loyMis', b.loyMis), affHatOpts: bondEmotionOptions('affHat', b.affHat),
			strength: Number(b.strength ?? bondStrengthOf(b)),
			tier: bondTierByName.get(b.name ?? '') ?? 'fleeting',
			partyMember: !!bondPartyByName.get(b.name ?? ''),
			deeperActive: bondsDeeperActive,   // per-row: show the party-member toggle only when Deeper Bonds ≥0.2.3
		})),
		bondsDeeperActive,
	};
	// Editor tab (P2c): the affordance targets the worn guise, else the innate, else the first. It only
	// OPENS the existing GuiseBuilderApp (which already enforces the fixed-at-distillation locks, the
	// dismiss-before-edit guard, the GM override and the player Edit-SL toggle) — nothing is rebuilt.
	const editorG = guises.find((g) => g.worn) ?? guises.find((g) => g.innate) ?? guises[0] ?? null;
	let overrideOn = false;
	try { overrideOn = editOverrideOn(); } catch { overrideOn = false; }
	const editor = {
		guiseId: editorG?.id ?? '', guiseName: editorG?.name ?? '',
		bound: !!editorG?.worn, overrideOn, has: !!editorG,
	};
	// G4 Resources tab: a GENERIC per-actor tracked-resource store (actor flag) — Reputation and the
	// class-specific resources (Sensitive Brainwave, Pugilist Combo Points, …) have NO FU data model, so
	// they are tracked here by name + value (+ optional cap). No canon values invented — the GM enters them.
	const trackedResources = (actor.getFlag?.(MODULE_ID, TRACKED_RESOURCES_FLAG) ?? []).map((r, i) => ({
		key: String(r?.key ?? `res${i}`), label: String(r?.label ?? '').trim(),
		value: Number(r?.value) || 0, max: Number.isFinite(Number(r?.max)) ? Number(r.max) : null,
	})).filter((r) => r.label);
	const tabs = RS_TABS.map((t) => ({ ...t, active: t.key === activeTab }));
	const tab = { play: activeTab === 'play', form: activeTab === 'form', bonds: activeTab === 'bonds', study: activeTab === 'study', resources: activeTab === 'resources', vault: activeTab === 'vault', kit: activeTab === 'kit', effects: activeTab === 'effects', spells: activeTab === 'spells', edit: activeTab === 'edit' };
	if (!tab.play && !tab.form && !tab.bonds && !tab.study && !tab.resources && !tab.vault && !tab.kit && !tab.effects && !tab.spells && !tab.edit) { tab.other = true; tab.otherNote = RS_TAB_STUBS[activeTab] ?? ''; }
	const play = tab.play ? await buildGuisePlayVM(actor, { previewId: ui.previewGuiseId }) : null; // v0.7.25/29: 'The Guise' play surface (active guise + preview)
	// v0.7.15: full inventory (Kit) + native Active Effects (Effects tab) — built only when their tab is open.
	const inventory = tab.kit ? buildInventoryVM(actor) : null;
	const effects = tab.effects ? buildEffectsVM(actor) : null;
	const spells = tab.spells ? buildSpellsVM(actor) : null; // v0.7.16: native 'spell' Items (list + cast)
	// V3: the Party Vault is an embedded tab — build its (party-wide, async) VM only when it is open.
	const vault = tab.vault ? await buildVaultVM(actor) : null;
	return {
		masthead, vitals, derived, attributes, affinities, guises, bonds, bondsNative, bondsIsGM,
		theTurn: { available: !turnRefundUsed }, // H3: is The Turn's swap-refund still available this scene?
		rivalWaiver: rivalWaiverVM(actor),       // R1: the Rival cost-waiver roller toggle (hidden unless the actor has it)
		faces: { ...guiseFacesVM(actor) },       // H2: the two-portrait config + toggle availability
		vault, trackedResources, isGM: !!globalThis.game?.user?.isGM,
		statuses, statusChips, condGroups,
		weapons, quirks, editable, editor, worn: !!activeId, wornName, tabs, tab, statusSelf, showConditions,
		inventory, effects, spells, play,
	};
}

// ── FU public-API adapter (P2a control wiring; SHEET-SKIN-SPIKE.md + signature recon) ────────────
// The pipelines / Effects / InlineSourceInfo are real FU exports but NOT on game.projectfu, so we
// dynamic-import them by served path and cache. Deep-import is the least-guaranteed API surface (pin
// FU's version); every call feature-detects and FALLS BACK so a path drift degrades, never throws to
// the user. system.json serves from the repo root, so the 'module/' segment is part of the path.
const FU_IMPORT = {
	resource: '/systems/projectfu/module/pipelines/resource-pipeline.mjs',
	effects: '/systems/projectfu/module/pipelines/effects.mjs',
	inline: '/systems/projectfu/module/helpers/inline-helper.mjs',
};
let _fuAdapter = null;
async function fuAdapter() {
	if (_fuAdapter) return _fuAdapter;
	const [rp, ef, ih] = await Promise.all([import(FU_IMPORT.resource), import(FU_IMPORT.effects), import(FU_IMPORT.inline)]);
	_fuAdapter = { ResourceRequest: rp.ResourceRequest, ResourcePipeline: rp.ResourcePipeline, Effects: ef.Effects, InlineSourceInfo: ih.InlineSourceInfo };
	return _fuAdapter;
}

/** HP/MP/IP damage (amount<0) or heal (amount>0) via FU's ResourcePipeline — ResourceRequest's amount
 *  sign is the loss/gain switch (recon-confirmed). Falls back to a clamped direct update on import drift. */
async function sheetAdjustResource(actor, resourceType, amount) {
	if (!actor || !['hp', 'mp', 'ip'].includes(resourceType) || !amount) return;
	// A manual SPEND of HP or MP (amount<0) draws the worn guise's lent layer FIRST, then own — via the
	// applyResourceCost seam (lent-then-own). This mirrors the automatic intercepts (lent-HP on the damage
	// pipeline P3, lent-MP on the expense event) so the sheet's manual steppers are symmetric and never
	// surprise (god ruling, 4 Sep 2026). IP has no lent layer here; heals/gains (amount>0) never touch the
	// lent layer — only a rest refills it.
	if ((resourceType === 'hp' || resourceType === 'mp') && amount < 0) { await applyResourceCost(actor, resourceType, -amount); return; }
	try {
		const { ResourceRequest, ResourcePipeline, InlineSourceInfo } = await fuAdapter();
		const req = new ResourceRequest(InlineSourceInfo.fromInstance(actor), [actor], resourceType, amount, false);
		return await ResourcePipeline.process(req);
	} catch (err) {
		console.warn('[rippers-guise] ResourcePipeline unavailable — clamped direct fallback:', err);
		const r = actor.system?.resources?.[resourceType] ?? {};
		const max = Number.isFinite(Number(r.max)) ? Number(r.max) : Infinity;
		const next = Math.max(0, Math.min(max, Number(r.value ?? 0) + amount));
		await actor.update({ [`system.resources.${resourceType}.value`]: next });
	}
}

/** Which actor a status control acts on: SELF = the sheet's actor; TARGET = the user's first targeted
 *  token's actor (null if none). Pure given (actor, self, targets-iterable). */
function statusTargetActor(actor, self, targets) {
	if (self) return actor ?? null;
	const first = (targets && targets[Symbol.iterator]) ? [...targets][0] : null;
	return first?.actor ?? null;
}
/** Toggle a FU status on an actor via Effects.toggleStatusEffect (falls back to core toggleStatusEffect). */
async function sheetToggleStatus(actor, statusId) {
	if (!actor || !statusId) return;
	try {
		const { Effects, InlineSourceInfo } = await fuAdapter();
		return await Effects.toggleStatusEffect(actor, statusId, InlineSourceInfo.fromInstance(actor));
	} catch (err) {
		console.warn('[rippers-guise] Effects.toggleStatusEffect unavailable — core fallback:', err);
		if (typeof actor.toggleStatusEffect === 'function') return actor.toggleStatusEffect(statusId);
	}
}
/** Open rippers-conditions' Affliction/Regeneration dialog on the actor (reuses its published api). */
function sheetOpenConditions(actor) {
	const api = globalThis.game?.modules?.get?.('rippers-conditions')?.api;
	if (typeof api?.openConditionDialog === 'function') return api.openConditionDialog(actor);
	ui.notifications?.info(game.i18n?.localize?.('RIPPERS.Sheet.NoConditionsModule') ?? 'rippers-conditions is not active.');
}
/** Guise swap from the roster: worn → dismiss (unmask); otherwise bind it. */
async function sheetGuiseWear(actor, guiseId) {
	if (!actor || !guiseId) return;
	return getActiveGuise(actor) === guiseId ? dismissGuise(actor, guiseId) : bindGuise(actor, guiseId);
}

/** 2a arcana picker: ENUMERATE the image files in arcanaBasePath (no rename needed — any names work)
 *  and show them as a visual grid; the chosen file's PATH persists to the guise Item flag
 *  flags['rippers-guise'].arcana. A "Clear" option removes it. Empty/missing folder → a graceful hint. */
async function sheetPickArcana(actor, guiseId) {
	const guise = actor?.items?.get?.(guiseId);
	if (!guise) return;
	const base = arcanaBasePath();
	const entries = await browseArcana(base);            // async, runtime; [] if the folder is empty/missing
	const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
	const clearLbl = game.i18n?.localize?.('RIPPERS.Sheet.ArcanaClear') ?? '— none —';
	const body = entries.length
		? `<div class="rs-arcana-grid">${entries.map((e) => `<button type="button" class="rs-arcana-opt" data-path="${esc(e.path)}" title="${esc(e.name)}"><img src="${esc(e.path)}" alt="${esc(e.name)}"><span class="rs-arcana-name">${esc(e.name)}</span></button>`).join('')}</div>`
		: `<p class="rs-arcana-empty-msg">${esc(game.i18n?.localize?.('RIPPERS.Sheet.ArcanaEmpty') ?? 'No images found in the arcana folder. Set the "Arcana art folder" setting to where your cards live.')}<br><code>${esc(base)}</code></p>`;
	// Wrapped in .rg-arcana-picker: the DialogV2 renders OUTSIDE .rippers-sheet, so the sheet's scoped
	// tokens don't reach it — the picker carries its own (unscoped) styling for contrast + scroll.
	const content = `<div class="rg-arcana-picker">${body}<p class="rg-arcana-clear"><button type="button" class="rs-arcana-opt rg-arcana-clearbtn" data-path="">${esc(clearLbl)}</button></p></div>`;
	const DV2 = foundry?.applications?.api?.DialogV2;
	const pick = await new Promise((resolve) => {
		const wire = (root) => root?.querySelectorAll?.('.rs-arcana-opt').forEach((b) => b.addEventListener('click', () => resolve(b.dataset.path ?? '')));
		if (DV2?.wait) {
			DV2.wait({ window: { title: game.i18n?.localize?.('RIPPERS.Sheet.PickArcana') ?? 'Choose an arcana' }, content, buttons: [{ action: 'cancel', label: game.i18n?.localize?.('RIPPERS.Sheet.Cancel') ?? 'Cancel' }], render: (_e, dlg) => wire(dlg.element ?? dlg), rejectClose: false })
				.then((r) => { if (r === 'cancel' || r == null) resolve(undefined); }).catch(() => resolve(undefined));
		} else { resolve(undefined); }
	});
	if (pick === undefined) return;                 // cancelled
	if (pick) await guise.setFlag(MODULE_ID, ARCANA_FLAG, pick);
	else if (guise.getFlag(MODULE_ID, ARCANA_FLAG)) await guise.unsetFlag(MODULE_ID, ARCANA_FLAG);
}
/** The Swap button: worn → unmask; else wear the first roster guise (the picker gives precise choice). */
async function sheetGuiseSwap(actor) {
	if (!actor) return;
	const cur = getActiveGuise(actor);
	if (cur) return dismissGuise(actor, cur);
	const first = actor.items?.filter ? actor.items.filter(isGuiseItem)[0] : null;
	if (first) return bindGuise(actor, first.id);
	ui.notifications?.warn(game.i18n?.localize?.('RIPPERS.Sheet.NoGuises') ?? 'No guise to wear.');
}

// ── P2b controls: attack / check / rest / fabula (FU signatures recon-verified — nothing invented) ──
/** Weapon attack — item.roll() (document method) posts the accuracy card whose buttons drive FU's
 *  damage pipeline; no separate DamagePipeline call is needed for the standard attack→damage flow. */
async function sheetRollWeapon(actor, itemId) {
	const item = actor?.items?.get?.(itemId);
	if (!item) return;
	if (typeof item.roll === 'function') return item.roll();
	ui.notifications?.warn(game.i18n?.localize?.('RIPPERS.Sheet.NotRollable') ?? 'That item cannot be rolled.');
}
/** One "Roll Check" button — CheckPrompt.openCheck prompts the user for the two attributes (deep import;
 *  NOT on game.projectfu). Warns if unavailable rather than invent an arbitrary attribute pair. */
async function sheetRollCheck(actor) {
	if (!actor) return;
	try {
		const m = await import('/systems/projectfu/module/checks/check-prompt.mjs');
		if (typeof m?.CheckPrompt?.openCheck === 'function') return m.CheckPrompt.openCheck(actor);
	} catch (err) { console.warn('[rippers-guise] CheckPrompt unavailable:', err); }
	ui.notifications?.warn(game.i18n?.localize?.('RIPPERS.Sheet.CheckUnavailable') ?? 'The check dialog is unavailable.');
}
/** Rest — actor.rest(true) restores HP/MP (+IP) and fires REST_EVENT → the lent-vitals refill I already
 *  subscribed at ready runs off the same event. Document method. */
async function sheetRest(actor) { if (typeof actor?.rest === 'function') return actor.rest(true); }
/** Heal-to-Crisis quick-set: put current HP at the Crisis threshold. FU Crisis = current HP at or below
 *  half the maximum, rounded down; we use FU's own crisisScore when the actor exposes it, else floor(max/2).
 *  A GM/play convenience — sets HP to that value (does not toggle the status; FU derives inCrisis itself). */
async function sheetHealToCrisis(actor) {
	const hpRes = actor?.system?.resources?.hp;
	if (!hpRes) return;
	const max = Number(hpRes.max ?? 0);
	const threshold = Number(hpRes.crisisScore ?? Math.floor(max / 2));
	if (Number.isFinite(threshold)) await actor.update({ 'system.resources.hp.value': threshold });
}
// ── v0.7.20 LEVEL UP (Tier-1 #4) ──────────────────────────────────────────────────────────────────
// Austin's SIMPLE model: increment system.level.value (which drives skill budget = min(level,30) AND
// the hoplosphere socket cadence, both DERIVED from level — see budgetOf / baseSocketCapacity /
// persistentSlotsUnlocked — so sockets auto-follow, no recompute wiring needed), plus the FU attribute
// milestone: at character levels 20 and 40, raise ONE attribute die a size (player's choice, cap d12).
// FU dice ladder is fixed (6/8/10/12; d20 Apex is a class feature, NOT a level milestone).
const RS_ATTR_DICE = Object.freeze([6, 8, 10, 12]);
/** PURE: next die size up the FU ladder, capped at d12. */
function raiseDieSize(base) { const i = RS_ATTR_DICE.indexOf(Number(base)); return i < 0 ? Number(base) || 6 : RS_ATTR_DICE[Math.min(i + 1, RS_ATTR_DICE.length - 1)]; }
/** PURE: does reaching `level` hit an FU attribute-increase milestone (levels 20 and 40)? */
function levelUpMilestone(level) { return level === 20 || level === 40; }
/** Small DEX/INS/MIG/WLP picker for the milestone attribute increase (DialogV2, classic-Dialog fallback). */
async function promptLevelUpAttribute() {
	const opts = SPECIALTY_ATTRIBUTES.map((a) => `<option value="${a.key}">${a.label}</option>`).join('');
	const title = game.i18n?.localize?.('RIPPERS.Sheet.LevelUpMilestone') ?? 'Milestone — raise an attribute';
	const content = `<p>${game.i18n?.localize?.('RIPPERS.Sheet.LevelUpPickAttr') ?? 'Milestone reached — raise one attribute die a size (max d12):'}</p>`
		+ `<div class="form-group"><label>${game.i18n?.localize?.('RIPPERS.Specialty.Attribute') ?? 'Attribute'} </label><select name="attr">${opts}</select></div>`;
	const okLabel = game.i18n?.localize?.('RIPPERS.Sheet.LevelUpRaise') ?? 'Raise';
	const DV2 = foundry?.applications?.api?.DialogV2;
	if (DV2?.prompt) return DV2.prompt({ window: { title }, content, ok: { label: okLabel, callback: (_e, b) => b.form?.elements?.attr?.value ?? null }, rejectClose: false }).catch(() => null);
	const Dlg = globalThis.Dialog; if (!Dlg) return null;
	return new Promise((resolve) => new Dlg({ title, content, buttons: { ok: { label: okLabel, callback: (h) => resolve((h[0] ?? h).querySelector('select[name=attr]')?.value ?? null) }, cancel: { label: 'Cancel', callback: () => resolve(null) } }, default: 'ok', close: () => resolve(null) }).render(true));
}
/** Level up one character level. Sets system.level.value (+1); on reaching a milestone (20/40) prompts to
 *  raise one attribute die a size (cap d12). Hoplosphere sockets + skill budget are derived from level, so
 *  they update on their own. No rules values invented — milestones + dice ladder are FU canon. */
async function sheetLevelUp(actor) {
	if (!actor?.update) return;
	const cur = Number(actor.system?.level?.value ?? actor.system?.level ?? 0) || 0;
	const next = cur + 1;
	await actor.update({ 'system.level.value': next });
	if (levelUpMilestone(next)) {
		const attr = await promptLevelUpAttribute();
		if (attr) {
			const base = Number(actor.system?.attributes?.[attr]?.base ?? 8) || 8;
			const raised = raiseDieSize(base);
			if (raised !== base) await actor.update({ [`system.attributes.${attr}.base`]: raised });
			ui.notifications?.info((game.i18n?.localize?.('RIPPERS.Sheet.LevelUpAttrRaised') ?? 'Milestone: attribute raised to d') + raised + '.');
		} else {
			ui.notifications?.info(game.i18n?.localize?.('RIPPERS.Sheet.LevelUpMilestoneReached') ?? 'Milestone reached — raise an attribute when ready.');
		}
	}
}

// Item 4: weapon attack stats for the Kit rows. Project FU stores the two item types differently —
// 'weapon' wraps everything in .value SchemaFields (attributes.primary.value, accuracy.value,
// damageType.value, type.value); 'customWeapon' delegates to its active form and exposes bare fields
// (attributes.primary, accuracy, damage.type). Both put the damage bonus at system.damage.value, and
// final damage is HR + damage.value (FU damage-data get total()). This normalizes both shapes. PURE.
const RS_ATTR_ABBR = Object.freeze({ dex: 'DEX', ins: 'INS', mig: 'MIG', wlp: 'WLP' });
function weaponStats(w) {
	const s = w?.system ?? {};
	const custom = w?.type === 'customWeapon';
	const primKey = custom ? s.attributes?.primary : s.attributes?.primary?.value;
	const secKey = custom ? s.attributes?.secondary : s.attributes?.secondary?.value;
	const abbr = (k) => RS_ATTR_ABBR[String(k ?? '').toLowerCase()] ?? (k ? String(k).toUpperCase() : '');
	const accBonus = Number(custom ? s.accuracy : s.accuracy?.value) || 0;
	const dmgBonus = Number(s.damage?.value ?? 0) || 0;
	const dmgType = custom
		? (s.damage?.type ?? (typeof s.getDamageType === 'function' ? s.getDamageType() : '') ?? '')
		: (s.damageType?.value ?? '');
	const wtype = custom ? s.type : s.type?.value;
	const traits = s.traits ? [...s.traits].filter(Boolean) : [];
	const accParts = [abbr(primKey), abbr(secKey)].filter(Boolean);
	const accLabel = (accParts.length ? accParts.join(' + ') : '—') + (accBonus ? ` (+${accBonus})` : '');
	const dmgLabel = dmgBonus ? `HR + ${dmgBonus}` : 'HR';
	return {
		accLabel, dmgLabel, dmgType: String(dmgType || ''), wtype: String(wtype || ''), traits,
		// raw values + the (schema-correct) write paths for inline editing (Austin 4 Sep). weapon wraps in
		// .value SchemaFields; customWeapon uses bare fields + damage.type. Both put the dmg bonus at damage.value.
		custom, primKey: String(primKey || ''), secKey: String(secKey || ''), accBonus, dmgBonus,
		paths: {
			primary: custom ? 'system.attributes.primary' : 'system.attributes.primary.value',
			secondary: custom ? 'system.attributes.secondary' : 'system.attributes.secondary.value',
			accuracy: custom ? 'system.accuracy' : 'system.accuracy.value',
			damage: 'system.damage.value',
			damageType: custom ? 'system.damage.type' : 'system.damageType.value',
			wtype: custom ? 'system.type' : 'system.type.value',
		},
	};
}

// Inline skill-level editing (Austin 4 Sep): SLs are editable on the character sheet, honoring the SAME
// gates as the guise editor — the per-guise slEditOpen toggle OR the GM edit override — and the SAME three
// caps (per-skill maxSl, per-class ≤10, total ≤ budget). Skills stay guise-bound; only their SL moves.
/** PURE. Clamp a wanted SL to the three caps. */
function clampSkillSL(want, { maxSl = 1, perClassOther = 0, budgetOther = 0, budget = SKILL_BUDGET_CAP } = {}) {
	let v = Math.max(0, Math.floor(Number(want) || 0));
	v = Math.min(v, Math.max(1, Number(maxSl) || 1), PER_CLASS_CAP - perClassOther, budget - budgetOther);
	return Math.max(0, v);
}
/** Is inline SL editing unlocked for this guise? (player slEditOpen toggle OR the GM override). */
function guiseSlEditable(guise) { return editOverrideOn() || !!guise?.getFlag?.(MODULE_ID, 'slEditOpen'); }
/** Set a guise skill's SL (clamped), honoring the lock. Writes back the guise's classes array. */
async function setGuiseSkillSL(guise, classUuid, skillUuid, want) {
	if (!guise?.update) return { ok: false, reason: 'no-guise' };
	if (!guiseSlEditable(guise)) { ui.notifications?.warn(game.i18n?.localize?.('RIPPERS.Sheet.SlLocked') ?? 'Unlock SL editing on this guise first.'); return { ok: false, reason: 'locked' }; }
	const data = foundry.utils.deepClone(guise.system?.data ?? {});
	const cls = (data.classes ?? []).find((c) => c.classUuid === classUuid);
	const sk = cls?.skills?.find((s) => s.skillUuid === skillUuid);
	if (!sk) return { ok: false, reason: 'no-skill' };
	const defs = await skillsForClass(classUuid);
	const maxSl = Number(defs.find((d) => d.uuid === skillUuid)?.maxSl ?? 1);
	const perClassOther = cls.skills.filter((s) => s.skillUuid !== skillUuid).reduce((a, s) => a + (Number(s.sl) || 0), 0);
	const budgetOther = (data.classes ?? []).reduce((a, c) => a + (c.skills || []).reduce((x, s) => x + ((c.classUuid === classUuid && s.skillUuid === skillUuid) ? 0 : (Number(s.sl) || 0)), 0), 0);
	sk.sl = clampSkillSL(want, { maxSl, perClassOther, budgetOther, budget: budgetOf(guise.actor) });
	try { await guise.update({ 'system.data': data }); } catch (err) { console.warn('[rippers-guise] SL edit failed:', err); return { ok: false, reason: 'write-failed' }; }
	return { ok: true, sl: sk.sl };
}
/** Toggle the per-guise player SL-edit unlock (slEditOpen). */
async function toggleGuiseSlLock(guise) {
	if (!guise?.setFlag) return;
	await guise.setFlag(MODULE_ID, 'slEditOpen', !guise.getFlag(MODULE_ID, 'slEditOpen'));
}

// Item 3: manage the character's quirks (Project FU 'effect' Items). Add creates a blank effect Item and
// opens its sheet; edit opens the existing one; remove deletes it. Runtime-only (Foundry document ops).
async function sheetAddQuirk(actor) {
	if (!actor?.createEmbeddedDocuments) return;
	const name = game.i18n?.localize?.('RIPPERS.Sheet.NewQuirk') ?? 'New Quirk';
	const created = await actor.createEmbeddedDocuments('Item', [{ name, type: 'effect' }]);
	created?.[0]?.sheet?.render?.(true);
}
async function sheetEditQuirk(actor, itemId) {
	const it = actor?.items?.get?.(itemId);
	it?.sheet?.render?.(true);
}
async function sheetRemoveQuirk(actor, itemId) {
	if (actor?.deleteEmbeddedDocuments && itemId) await actor.deleteEmbeddedDocuments('Item', [itemId]);
}
/** Spend a Fabula Point — spendMetaCurrency confirms + guards fp>0 (deep import). Direct −1 fallback. */
async function sheetSpendFabula(actor) {
	if (!actor) return;
	try {
		const m = await import('/systems/projectfu/module/helpers/player-list-enhancements.mjs');
		if (typeof m?.PlayerListEnhancements?.spendMetaCurrency === 'function') return m.PlayerListEnhancements.spendMetaCurrency(actor);
	} catch (err) { console.warn('[rippers-guise] spendMetaCurrency unavailable — direct fallback:', err); }
	const cur = Number(actor.system?.resources?.fp?.value ?? 0);
	if (cur > 0) await actor.update({ 'system.resources.fp.value': cur - 1 });
	else ui.notifications?.info(game.i18n?.localize?.('RIPPERS.Sheet.NoFabula') ?? 'No Fabula Points to spend.');
}

// ── P2c: Editor tab (opens the existing builder) + the trade / hand-off card ──────────────────────
/** Open the EXISTING GuiseBuilderApp for a guise on the actor (999191e). The builder itself enforces
 *  the fixed-at-distillation locks, the dismiss-before-edit guard, the GM override and the Edit-SL
 *  toggle — this only surfaces it; nothing is rebuilt. */
async function sheetOpenEditor(actor, guiseId) {
	const item = guiseId ? actor?.items?.get?.(guiseId) : null;
	if (!item || !isGuiseItem(item)) { ui.notifications?.warn(game.i18n?.localize?.('RIPPERS.Sheet.NoGuiseToEdit') ?? 'No guise to edit.'); return; }
	// G3 (Austin 4 Sep): dismiss-before-edit is a one-click "dismiss & edit", NOT a hard block — if the
	// guise is worn, dismiss it first (bind resets), then open the builder. The builder's own fixity locks
	// (G1) and the right-click GM override (G2) still apply inside.
	if (getActiveGuise(actor) === item.id) await dismissGuise(actor, item.id);
	return openGuiseBuilder(actor, item);
}
// ── G4 tracked-resource controls (thin; the generic Resources tab store) ──
async function sheetAdjustTrackedResource(actor, key, delta) {
	if (!actor || !key) return;
	const list = actor.getFlag?.(MODULE_ID, TRACKED_RESOURCES_FLAG) ?? [];
	await actor.setFlag(MODULE_ID, TRACKED_RESOURCES_FLAG, adjustTrackedResource(list, key, delta));
}
async function sheetAddTrackedResource(actor) {
	if (!actor) return;
	const label = await promptBondText(game.i18n?.localize?.('RIPPERS.Sheet.ResAdd') ?? 'Add a tracked resource', game.i18n?.localize?.('RIPPERS.Sheet.ResNamePrompt') ?? 'Name it (e.g. Reputation, Combo Points, Brainwave).');
	if (!label) return;
	const maxRaw = await promptBondText(game.i18n?.localize?.('RIPPERS.Sheet.ResCap') ?? 'Cap (optional)', game.i18n?.localize?.('RIPPERS.Sheet.ResCapPrompt') ?? 'Maximum (leave blank for no cap).');
	const max = Number.isFinite(Number(maxRaw)) && Number(maxRaw) > 0 ? Math.floor(Number(maxRaw)) : null;
	const list = actor.getFlag?.(MODULE_ID, TRACKED_RESOURCES_FLAG) ?? [];
	const key = `res-${globalThis.foundry?.utils?.randomID?.() ?? Date.now()}`;
	await actor.setFlag(MODULE_ID, TRACKED_RESOURCES_FLAG, [...list, { key, label, value: 0, max }]);
}
async function sheetRemoveTrackedResource(actor, key) {
	if (!actor || !key) return;
	const list = (actor.getFlag?.(MODULE_ID, TRACKED_RESOURCES_FLAG) ?? []).filter((r) => r?.key !== key);
	await actor.setFlag(MODULE_ID, TRACKED_RESOURCES_FLAG, list);
}
/** Stash a guise — unwear it (dismiss the active guise); a no-op if it is not currently worn. */
async function sheetStashGuise(actor, guiseId) {
	if (getActiveGuise(actor) === guiseId) return dismissGuise(actor, guiseId);
}
/** PURE hand-off gate. A guise Item may be handed off only if it is a real, non-innate (tradable) guise,
 *  there is a distinct recipient, and the current user can WRITE the recipient (canWrite = GM or the
 *  recipient is owned by this user). Cross-owner transfer without write access needs a GM-mediated
 *  socket — reported as reason 'needs-gm-socket', NOT half-built. Returns { ok, reason }. */
function handOffDecision(sourceActor, item, recipient, canWrite) {
	if (!item || !isGuiseItem(item)) return { ok: false, reason: 'no-guise' };
	const innate = !!item.getFlag?.(MODULE_ID, 'isInnate') || item.system?.data?.mode === 'innate';
	if (innate) return { ok: false, reason: 'innate-untradable' };
	if (!recipient) return { ok: false, reason: 'no-recipient' };
	if (recipient.id && sourceActor?.id && recipient.id === sourceActor.id) return { ok: false, reason: 'same-actor' };
	if (!canWrite) return { ok: false, reason: 'needs-gm-socket' };
	return { ok: true, reason: 'ok' };
}
/** Hand a TRADABLE guise Item whole to a recipient actor: its attached heroic ref, lent HP/MP layer and
 *  IP satchel all ride (they live on the Item's system.data), and bind RESETS — the guise is unworn on
 *  the source first, then moved, arriving unbound on the recipient. Clean path only (write access to the
 *  recipient); cross-owner without access is refused with 'needs-gm-socket' (a follow-on for god). */
async function sheetHandOffGuise(actor, guiseId, recipient) {
	const item = actor?.items?.get?.(guiseId);
	const canWrite = !!(globalThis.game?.user?.isGM || recipient?.isOwner);
	const d = handOffDecision(actor, item, recipient, canWrite);
	if (!d.ok) {
		const msg = {
			'no-guise': 'That is not a guise.', 'innate-untradable': 'The innate guise cannot be handed off.',
			'no-recipient': 'Target a recipient token first.', 'same-actor': 'Cannot hand a guise to its own bearer.',
			'needs-gm-socket': 'You cannot write that character — a GM must mediate this hand-off.',
		}[d.reason] ?? 'Hand-off refused.';
		ui.notifications?.warn(msg);
		return d;
	}
	if (getActiveGuise(actor) === guiseId) await dismissGuise(actor, guiseId); // unwear first (bind resets)
	const obj = item.toObject(); delete obj._id;                              // heroic ref + lent layer + satchel ride in system.data
	await recipient.createEmbeddedDocuments('Item', [obj]);
	await item.delete();
	ui.notifications?.info(`${game.i18n?.localize?.('RIPPERS.Sheet.HandedOff') ?? 'Handed off'} "${item.name}".`);
	return { ok: true, reason: 'ok' };
}

// ── Deeper Bonds native controls (thin wrappers over the module's API; GM-authoritative) ──────────
// Each is a thin wrapper over game.modules.get('rippers-deeper-bonds').api — the module owns all state.
// The API itself no-ops non-GM callers; these supply the DOM pickers the API expects the caller to gather.
const _bondNote = (msg) => ui.notifications?.info(msg);
const _bondWarn = (msg) => ui.notifications?.warn(msg);

/** Minimal text-input prompt (DialogV2 with a classic-Dialog fallback). Resolves to a trimmed string or null. */
async function promptBondText(title, prompt, { placeholder = '' } = {}) {
	const content = `<p>${prompt}</p><div class="form-group"><input type="text" name="val" placeholder="${placeholder}" autofocus></div>`;
	const DV2 = foundry?.applications?.api?.DialogV2;
	if (DV2?.prompt) {
		return DV2.prompt({ window: { title }, content, ok: { label: game.i18n?.localize?.('RIPPERS.Sheet.OK') ?? 'OK', callback: (_e, b) => (b.form?.elements?.val?.value ?? '').trim() || null }, rejectClose: false }).catch(() => null);
	}
	const Dlg = globalThis.Dialog;
	if (!Dlg) return null;
	return new Promise((resolve) => new Dlg({ title, content, buttons: { ok: { label: 'OK', callback: (h) => resolve(((h[0] ?? h).querySelector('input[name=val]')?.value ?? '').trim() || null) }, cancel: { label: 'Cancel', callback: () => resolve(null) } }, default: 'ok', close: () => resolve(null) }).render(true));
}
/** Pick one value from a list (radio). Resolves to the chosen value or null. */
async function promptBondPick(title, prompt, options) {
	if (!options?.length) return null;
	const rows = options.map((o, i) => `<label style="display:block"><input type="radio" name="pick" value="${o.value}"${i === 0 ? ' checked' : ''}> ${o.label}</label>`).join('');
	const content = `<p>${prompt}</p><div class="form-group">${rows}</div>`;
	const DV2 = foundry?.applications?.api?.DialogV2;
	if (DV2?.prompt) {
		return DV2.prompt({ window: { title }, content, ok: { label: game.i18n?.localize?.('RIPPERS.Sheet.OK') ?? 'OK', callback: (_e, b) => b.form?.querySelector('input[name=pick]:checked')?.value ?? null }, rejectClose: false }).catch(() => null);
	}
	const Dlg = globalThis.Dialog;
	if (!Dlg) return null;
	return new Promise((resolve) => new Dlg({ title, content, buttons: { ok: { label: 'OK', callback: (h) => resolve((h[0] ?? h).querySelector('input[name=pick]:checked')?.value ?? null) }, cancel: { label: 'Cancel', callback: () => resolve(null) } }, default: 'ok', close: () => resolve(null) }).render(true));
}
/** Pick many from a checklist. Resolves to an array of chosen values (possibly empty) or null on cancel. */
async function promptBondChecklist(title, prompt, options) {
	const rows = (options ?? []).map((o) => `<label style="display:block"><input type="checkbox" name="sel" value="${o.value}"> ${o.label}</label>`).join('');
	const content = `<p>${prompt}</p><div class="form-group">${rows || '<em>No fleeting bonds.</em>'}</div>`;
	const collect = (root) => Array.from(root.querySelectorAll('input[name=sel]:checked')).map((el) => el.value);
	const DV2 = foundry?.applications?.api?.DialogV2;
	if (DV2?.prompt) {
		return DV2.prompt({ window: { title }, content, ok: { label: game.i18n?.localize?.('RIPPERS.Sheet.BondSolidifyRest') ?? 'Solidify', callback: (_e, b) => collect(b.form) }, rejectClose: false }).catch(() => null);
	}
	const Dlg = globalThis.Dialog;
	if (!Dlg) return null;
	return new Promise((resolve) => new Dlg({ title, content, buttons: { ok: { label: 'Solidify', callback: (h) => resolve(collect(h[0] ?? h)) }, cancel: { label: 'Cancel', callback: () => resolve(null) } }, default: 'ok', close: () => resolve(null) }).render(true));
}

async function sheetBondCreate(actor) {
	const api = deeperBondsApi(); if (!api?.createFleetingBond) return;
	const name = await promptBondText(game.i18n?.localize?.('RIPPERS.Sheet.BondNew') ?? 'New fleeting bond', game.i18n?.localize?.('RIPPERS.Sheet.BondNamePrompt') ?? 'Name the bonded character.');
	if (!name) return;
	const ok = await api.createFleetingBond(actor, { name });
	if (!ok) _bondWarn(game.i18n?.localize?.('RIPPERS.Sheet.BondRefused') ?? 'Bond change refused (GM only).');
}
async function sheetBondSolidify(actor, name) {
	const api = deeperBondsApi(); if (!api?.solidifyBond || !name) return;
	const ok = await api.solidifyBond(actor, name);
	if (!ok) _bondWarn(game.i18n?.localize?.('RIPPERS.Sheet.BondSolidifyRefused') ?? 'Cannot solidify (cap reached, not fleeting, or GM only).');
}
async function sheetBondEternal(actor, name) {
	const api = deeperBondsApi(); if (!api?.promoteEternal || !name) return;
	const ok = await api.promoteEternal(actor, name);
	if (!ok) _bondWarn(game.i18n?.localize?.('RIPPERS.Sheet.BondEternalRefused') ?? 'Cannot promote to eternal (not solid, or GM only).');
}
async function sheetBondClockFill(actor, name) {
	const api = deeperBondsApi(); if (!api?.fillClock || !name) return;
	const res = await api.fillClock(actor, name, 1);
	if (!res) { _bondWarn(game.i18n?.localize?.('RIPPERS.Sheet.BondClockRefused') ?? 'Only solid bonds carry a clock (GM only).'); return; }
	if (res.emotionDelta) _bondNote(game.i18n?.localize?.('RIPPERS.Sheet.BondClockEmotion') ?? 'Clock filled — the player adds one emotion (their choice of axis).');
}
// v0.7.27: SHARED RESOLVE (was cover-regen). Per-bond, party-member only, once/scene, holder MP recovery.
async function sheetBondSharedResolve(actor, name) {
	const api = deeperBondsApi(); if (!api?.sharedResolve || !name) return;
	const res = await api.sharedResolve(actor, name);
	if (res && typeof res === 'object') { _bondNote(`${game.i18n?.localize?.('RIPPERS.Sheet.BondSharedResolve') ?? 'Shared Resolve'}: +${res.amount} MP — you & ${res.bond}.`); return; }
	const msg = {
		'not-party': game.i18n?.localize?.('RIPPERS.Sheet.BondNotParty') ?? 'Only a party-member bond can do that.',
		'too-weak': game.i18n?.localize?.('RIPPERS.Sheet.BondTooWeak') ?? 'Bond is too weak (needs strength 2).',
		'used-this-scene': game.i18n?.localize?.('RIPPERS.Sheet.BondUsedScene') ?? 'Already used this scene.',
	}[res] ?? (game.i18n?.localize?.('RIPPERS.Sheet.BondRefused') ?? 'Refused (GM only).');
	_bondWarn(msg);
}
/** v0.7.27: toggle a bond's party-member flag (owner-writable via the Deeper Bonds API). */
async function sheetBondPartyToggle(actor, name, isParty) {
	const api = deeperBondsApi(); if (!api?.setBondPartyMember || !name) return;
	await api.setBondPartyMember(actor, name, !!isParty);
}
async function sheetBondRaiseDie(actor, name) {
	const api = deeperBondsApi(); if (!api?.raiseAttributeDie || !name) return;
	const attr = await promptSpecialtyAttribute(); // reuse the DEX/INS/MIG/WLP picker
	if (!attr) return;
	const r = await api.raiseAttributeDie(actor, name, attr);
	const msg = { raised: game.i18n?.localize?.('RIPPERS.Sheet.BondDieRaised') ?? 'Attribute die raised for the scene.', 'too-weak': 'Bond is below strength 3.', 'used-this-scene': 'Already raised a die this scene.', noop: 'No change (unknown attribute or already d12).' }[r] ?? 'No change.';
	(r === 'raised' ? _bondNote : _bondWarn)(msg);
}
async function sheetBondSkillGrant(actor, name) {
	const api = deeperBondsApi(); if (!api?.setEternalSkillGrant || !name) return;
	const skillName = await promptBondText(game.i18n?.localize?.('RIPPERS.Sheet.BondSkillGrant') ?? 'Eternal skill grant', game.i18n?.localize?.('RIPPERS.Sheet.BondSkillPrompt') ?? 'Name the granted skill (apply it manually).');
	if (!skillName) return;
	const ok = await api.setEternalSkillGrant(actor, name, { skillName });
	if (!ok) _bondWarn(game.i18n?.localize?.('RIPPERS.Sheet.BondSkillRefused') ?? 'Only an eternal bond grants a skill (GM only).');
}
async function sheetBondCleanse(actor, name) {
	const api = deeperBondsApi(); if (!api?.cleanseWithBond || !name) return;
	let res = await api.cleanseWithBond(actor, name);
	if (res === 'ambiguous') {
		const target = globalThis.game?.actors?.getName?.(name) ?? actor;
		const statuses = target?.statuses ? [...target.statuses] : [];
		const pick = await promptBondPick(game.i18n?.localize?.('RIPPERS.Sheet.BondCleanse') ?? 'Cleanse a status', game.i18n?.localize?.('RIPPERS.Sheet.BondCleansePrompt') ?? 'Which status does the bond cleanse?', statuses.map((s) => ({ value: s, label: s })));
		if (!pick) return;
		res = await api.cleanseWithBond(actor, name, { statusId: pick });
	}
	const msg = { cleansed: game.i18n?.localize?.('RIPPERS.Sheet.BondCleansed') ?? 'Status cleansed.', 'too-weak': 'Bond is below strength 2.', exhausted: 'No cleanse uses left this rest.', noop: 'Nothing to cleanse.' }[res] ?? '';
	if (msg) (res === 'cleansed' ? _bondNote : _bondWarn)(msg);
}
async function sheetBondSolidifyRest(actor) {
	const api = deeperBondsApi(); if (!api?.getRecords || !api?.solidifyAtRest) return;
	const records = api.getRecords(actor) ?? [];
	const fleeting = records.filter((r) => r.tier === 'fleeting').map((r) => ({ value: r.name, label: r.name }));
	const sel = await promptBondChecklist(game.i18n?.localize?.('RIPPERS.Sheet.BondSolidifyRest') ?? 'Solidify at rest', game.i18n?.localize?.('RIPPERS.Sheet.BondSolidifyRestPrompt') ?? 'Choose fleeting bonds to solidify — the rest are erased.', fleeting);
	if (sel === null) return; // cancelled
	const ok = await api.solidifyAtRest(actor, sel);
	if (!ok) _bondWarn(game.i18n?.localize?.('RIPPERS.Sheet.BondRefused') ?? 'Bond change refused (GM only).');
}

/** v0.7.35 PURE: the sheet's data-edit change-writer coercion, extracted so it is testable. Given a
 *  document path, a raw control value and an optional dtype, returns the { [path]: value } update — or
 *  NULL to skip (an invalid/blank number is dropped, never written as a non-integer or ''). This is the
 *  guarantee that the sheet's save path round-trips valid data: a 'number' dtype yields a finite number
 *  (the attribute-base <select> options are die sizes → integers), and a string field is always a defined
 *  string (name is never undefined). Native form submission is disabled (DEFAULT_OPTIONS.form) so this is
 *  the ONLY writer. */
function editFieldUpdate(path, rawValue, dtype) {
	if (!path) return null;
	let val = rawValue;
	if (dtype === 'number') {
		if (String(rawValue ?? '').trim() === '') return null;   // blank numeric field → skip (never write 0/'' )
		val = Number(val);
		if (!Number.isFinite(val)) return null;
	} else val = String(val ?? '');
	return { [path]: val };
}

let _RippersActorSheet = null;
function getRippersActorSheetClass() {
	if (_RippersActorSheet) return _RippersActorSheet;
	const { HandlebarsApplicationMixin } = foundry.applications.api;
	const { ActorSheetV2 } = foundry.applications.sheets;
	class RippersActorSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
		_activeTab = 'play';       // sheet view-state (not persisted): opens on 'The Guise' play surface
		_previewGuiseId = null;    // v0.7.29: PREVIEW dropdown target (not persisted); null = show the worn guise
		_statusSelf = true;
		_showConditions = false;
		static DEFAULT_OPTIONS = {
			classes: ['rippers-guise', 'rippers-actor-sheet'],
			position: { width: 1000, height: 780 },
			window: { resizable: true, title: 'RIPPERS.Sheet.Title', icon: 'fas fa-mask' },
			// v0.7.35 SAVE-REGRESSION FIX: this sheet saves EXCLUSIVELY through its own data-edit /
			// data-idfield / data-bond-* change writers (each does document.update({[path]: coerced})).
			// Its editable controls carry NO name= attribute, so DocumentSheetV2's inherited native form
			// submission would serialise garbage — name:undefined (no name= field) and attributes.*.base
			// as a non-integer '' — and throw a DataModelValidationError. Turn native auto-submit OFF; the
			// custom writers are the sole save path. _onSubmitForm is also overridden to a no-op below so an
			// explicit submit (Enter in a text input) can never fire the default serialiser either.
			form: { submitOnChange: false, closeOnSubmit: false },
			actions: {
				resAdjust: RippersActorSheet.onResAdjust,
				toggleStatus: RippersActorSheet.onToggleStatus,
				statusMode: RippersActorSheet.onStatusMode,
				toggleConditions: RippersActorSheet.onToggleConditions,
				openConditions: RippersActorSheet.onOpenConditions,
				selectTab: RippersActorSheet.onSelectTab,
				guiseWear: RippersActorSheet.onGuiseWear,
				pickArcana: RippersActorSheet.onPickArcana,
				toggleFace: RippersActorSheet.onToggleFace,
				setFace: RippersActorSheet.onSetFace,
				setGuiseFace: RippersActorSheet.onSetGuiseFace,
				guiseSwap: RippersActorSheet.onGuiseSwap,
				rollWeapon: RippersActorSheet.onRollWeapon,
				itemSheet: RippersActorSheet.onItemSheet,
				effectCreate: RippersActorSheet.onEffectCreate,
				effectEdit: RippersActorSheet.onEffectEdit,
				effectToggle: RippersActorSheet.onEffectToggle,
				effectDelete: RippersActorSheet.onEffectDelete,
				itemEquip: RippersActorSheet.onItemEquip,
				itemUse: RippersActorSheet.onItemUse,
				itemDelete: RippersActorSheet.onItemDelete,
				spellAdd: RippersActorSheet.onSpellAdd,
				rollCheck: RippersActorSheet.onRollCheck,
				toggleRivalWaiver: RippersActorSheet.onToggleRivalWaiver,
				rest: RippersActorSheet.onRest,
				healToCrisis: RippersActorSheet.onHealToCrisis,
				levelUp: RippersActorSheet.onLevelUp,
				skillSlAdjust: RippersActorSheet.onSkillSlAdjust,
				toggleSlLock: RippersActorSheet.onToggleSlLock,
				quirkAdd: RippersActorSheet.onQuirkAdd,
				quirkEdit: RippersActorSheet.onQuirkEdit,
				quirkRemove: RippersActorSheet.onQuirkRemove,
				spendFabula: RippersActorSheet.onSpendFabula,
				openEditor: RippersActorSheet.onOpenEditor,
				resTrackAdjust: RippersActorSheet.onResTrackAdjust,
				resTrackAdd: RippersActorSheet.onResTrackAdd,
				resTrackRemove: RippersActorSheet.onResTrackRemove,
				stashGuise: RippersActorSheet.onStashGuise,
				handOffGuise: RippersActorSheet.onHandOffGuise,
				vaultStash: RippersActorSheet.onVaultStash,
				bondCreate: RippersActorSheet.onBondCreate,
				bondAddRow: RippersActorSheet.onBondAddRow,
				bondRemove: RippersActorSheet.onBondRemove,
				bondSolidify: RippersActorSheet.onBondSolidify,
				bondEternal: RippersActorSheet.onBondEternal,
				bondClockFill: RippersActorSheet.onBondClockFill,
				bondCleanse: RippersActorSheet.onBondCleanse,
				bondSharedResolve: RippersActorSheet.onBondSharedResolve,
				bondRaiseDie: RippersActorSheet.onBondRaiseDie,
				bondSkillGrant: RippersActorSheet.onBondSkillGrant,
				bondSolidifyRest: RippersActorSheet.onBondSolidifyRest,
			},
		};
		static PARTS = { body: { template: `modules/${MODULE_ID}/templates/rippers-actor-sheet.hbs` } };
		async _prepareContext(options) {
			const ctx = await super._prepareContext(options);
			const vm = await buildRippersSheetVM(this.document, { activeTab: this._activeTab, statusSelf: this._statusSelf, showConditions: this._showConditions, previewGuiseId: this._previewGuiseId });
			return { ...ctx, actor: this.document, vm };
		}
		// v0.7.35 SAVE-REGRESSION FIX: the sheet never saves through the native document-form path — all
		// edits go through the data-edit/data-idfield/data-bond change writers (see _wireEditableFields /
		// _wireIdentityFields). The editable controls have no name= attribute, so the default serialiser
		// would produce invalid data (name:undefined, attributes.*.base non-integer) and throw. Neutralise
		// the native submit entirely: an accidental submit (Enter key, a stray submit event) is a no-op.
		async _onSubmitForm() { /* intentionally does nothing — custom change writers are the sole save path */ }
		// Forward-compat hedge (SHEET-INJECTION-AUDIT.md): one class-independent post-render hook so a
		// FUTURE sheet-injecting module has a clean mount point. Deeper Bonds is NOT routed through it —
		// it renders natively in the Bonds tab. One line of insurance, nothing depends on it today.
		_onRender(context, options) {
			super._onRender?.(context, options);
			try { Hooks.callAll('rippers-sheet:rendered', this, this.element); } catch (err) { console.warn('[rippers-guise] rippers-sheet:rendered hook failed:', err); }
			try { this._wireVaultDnD(this.element); } catch (err) { console.warn('[rippers-guise] vault drag-drop wiring failed:', err); }
			try { this._wireIdentityFields(this.element); } catch (err) { console.warn('[rippers-guise] identity-field wiring failed:', err); }
			try { this._wireEditableFields(this.element); } catch (err) { console.warn('[rippers-guise] editable-field wiring failed:', err); }
			try { this._wireItemEdit(this.element); } catch (err) { console.warn('[rippers-guise] item-edit wiring failed:', err); }
			try { this._wireBondParty(this.element); } catch (err) { console.warn('[rippers-guise] bond party-toggle wiring failed:', err); }
			try { this._wirePreview(this.element); } catch (err) { console.warn('[rippers-guise] play-surface preview wiring failed:', err); }
			this._ensureDefaultGuise(); // P4: no active guise → wear the basic guise (fire-and-forget; re-renders)
		}
		// P4 (Austin: "Unmasked form doesn't make sense. It should default to his basic Guise."): when the
		// sheet opens with NO active guise, wear the basic/innate guise so the character shows real skills/
		// stats instead of the bare Unmasked shell. No swap cost (bindGuiseNoCost). Guarded against re-entry
		// and the in-flight lock; a character with no guise at all stays Unmasked. Owner-only (writes state).
		// v0.7.27: party-member checkbox on bonds (change → Deeper Bonds setBondPartyMember, owner-writable).
		_wireBondParty(root) {
			if (!root?.querySelectorAll) return;
			const self = this;
			for (const el of root.querySelectorAll('[data-bond-party]')) {
				el.addEventListener('change', async () => { await sheetBondPartyToggle(self.document, el.dataset.bondParty, !!el.checked); self.render(); });
			}
		}
		// v0.7.29: the play-surface PREVIEW dropdown — re-render the guise readout for another owned guise
		// WITHOUT binding it (no Swap, no Turn). Empty value clears the preview back to the worn guise.
		_wirePreview(root) {
			if (!root?.querySelector) return;
			const self = this;
			const sel = root.querySelector('[data-preview-guise]');
			if (sel) sel.addEventListener('change', () => { self._previewGuiseId = sel.value || null; self.render(); });
		}
		async _ensureDefaultGuise() {
			try {
				const actor = this.document;
				if (!actor?.isOwner || this._defaultingGuise) return;
				if (getActiveGuise(actor)) return;                 // already masked → leave it
				if (_guiseBusy.has(actor.id)) return;
				const id = defaultActiveGuiseId(actor);
				if (!id) return;                                    // no guise → Unmasked stands
				this._defaultingGuise = true;
				await bindGuiseNoCost(actor, id);
				this._defaultingGuise = false;
				this.render();
			} catch (err) { this._defaultingGuise = false; console.warn('[rippers-guise] default-guise on open failed:', err); }
		}
		// Inline INVENTORY editing: [data-item-edit] inputs/selects write a dot-path onto an owned Item
		// (data-item = item id, data-item-edit = path, data-dtype="number" coerces). Item name via path "name".
		_wireItemEdit(root) {
			if (!root?.querySelectorAll) return;
			const self = this;
			for (const el of root.querySelectorAll('[data-item-edit]')) {
				el.addEventListener('change', async () => {
					const it = self.document?.items?.get?.(el.dataset.item); const path = el.dataset.itemEdit;
					if (!it || !path) return;
					let val = el.value;
					if (el.dataset.dtype === 'number') { val = Number(val); if (!Number.isFinite(val)) return; }
					try { await it.update({ [path]: val }); } catch (err) { console.warn(`[rippers-guise] item edit ${path} failed:`, err); }
					self.render();
				});
			}
		}
		// Item 3 (the headline): generic two-way editing of the character's own fields. A [data-edit]
		// input/select writes its dot-path on change (data-dtype="number" coerces); bonds are an array, so
		// [data-bond-index]+[data-bond-field] rewrite the whole system.bonds array element.
		_wireEditableFields(root) {
			if (!root?.querySelectorAll) return;
			const self = this;
			for (const el of root.querySelectorAll('[data-edit]')) {
				el.addEventListener('change', async () => {
					const update = editFieldUpdate(el.dataset.edit, el.value, el.dataset.dtype);
					if (!update) return;   // invalid/blank number → skip (never write a non-integer base)
					try { await self.document.update(update); } catch (err) { console.warn(`[rippers-guise] edit ${el.dataset.edit} failed:`, err); }
				});
			}
			for (const el of root.querySelectorAll('[data-bond-index]')) {
				el.addEventListener('change', async () => {
					const idx = Number(el.dataset.bondIndex); const field = el.dataset.bondField;
					if (!Number.isFinite(idx) || !field) return;
					const bonds = foundry.utils.deepClone(self.document.system?.bonds ?? []);
					while (bonds.length <= idx) bonds.push({ name: '', admInf: '', loyMis: '', affHat: '', strength: 0 });
					bonds[idx][field] = field === 'strength' ? (Number(el.value) || 0) : el.value;
					try { await self.document.update({ 'system.bonds': bonds }); } catch (err) { console.warn('[rippers-guise] bond edit failed:', err); }
				});
			}
		}
		// Item 3: the character's own identity fields are editable inline. A [data-idfield] input writes on
		// change — 'name' → the actor name; anything else → system.resources.<field>.name (FU's identity
		// slots). The guise's fixed-at-distillation locks are separate and untouched.
		_wireIdentityFields(root) {
			if (!root?.querySelectorAll) return;
			const self = this;
			for (const input of root.querySelectorAll('[data-idfield]')) {
				input.addEventListener('change', async () => {
					const field = input.dataset.idfield;
					const val = String(input.value ?? '');
					if (field === 'name') await self.document.update({ name: val });
					else if (field) await self.document.update({ [`system.resources.${field}.name`]: val });
				});
			}
		}
		// V3/X4: native drag-and-drop for the Party Vault tab. A field guise dropped on another member's
		// field is a trade (GM-brokered cross-owner via vaultHandOff); on the cabinet it is a stash; a
		// cabinet entry dropped on a field slots a copy. Runtime-only surface (no headless coverage).
		_wireVaultDnD(root) {
			if (!root?.querySelectorAll) return;
			for (const card of root.querySelectorAll('[data-vault-guise][draggable="true"], [data-vault-cabinet]')) {
				card.addEventListener('dragstart', (ev) => {
					const p = card.dataset.vaultCabinet
						? { kind: 'cabinet', uuid: card.dataset.uuid }
						: { kind: 'field', guiseId: card.dataset.vaultGuise, actorId: card.dataset.actor, uuid: card.dataset.uuid };
					ev.dataTransfer?.setData('text/plain', JSON.stringify({ ripperVault: p }));
				});
			}
			const self = this;
			for (const zone of root.querySelectorAll('[data-vault-drop]')) {
				zone.addEventListener('dragover', (ev) => ev.preventDefault());
				zone.addEventListener('drop', async (ev) => {
					ev.preventDefault();
					let data; try { data = JSON.parse(ev.dataTransfer?.getData('text/plain') || '{}'); } catch { return; }
					const p = data?.ripperVault; if (!p) return;
					const dropKind = zone.dataset.vaultDrop; // 'field' | 'cabinet'
					const targetActor = zone.dataset.actor ? globalThis.game?.actors?.get?.(zone.dataset.actor) : null;
					if (p.kind === 'cabinet') {
						if (dropKind === 'field' && targetActor) { await vaultSlotFromCabinet(targetActor, p.uuid); self.render(); }
						return;
					}
					const sourceActor = globalThis.game?.actors?.get?.(p.actorId); if (!sourceActor) return;
					if (dropKind === 'cabinet') { await vaultStashToCabinet(sourceActor, p.guiseId); self.render(); return; }
					if (dropKind === 'field' && targetActor && targetActor.id !== sourceActor.id) { await vaultHandOff(sourceActor, p.guiseId, targetActor); self.render(); }
				});
			}
		}
		// ── actions (AppV2 binds `this` to the app instance) ──
		static async onResAdjust(event, target) {
			const res = target?.dataset?.res; const dir = Number(target?.dataset?.dir) || 0;
			if (res && dir) { await sheetAdjustResource(this.document, res, dir); this.render(); }
		}
		static async onToggleStatus(event, target) {
			const id = target?.dataset?.status;
			const act = statusTargetActor(this.document, this._statusSelf, globalThis.game?.user?.targets);
			if (!act) { ui.notifications?.warn(game.i18n?.localize?.('RIPPERS.Sheet.NoTarget') ?? 'No target selected.'); return; }
			if (id) { await sheetToggleStatus(act, id); this.render(); }
		}
		static onStatusMode(event, target) { this._statusSelf = target?.dataset?.mode !== 'target'; this.render(); }
		static onToggleConditions() { this._showConditions = !this._showConditions; this.render(); }
		static onOpenConditions() { sheetOpenConditions(statusTargetActor(this.document, this._statusSelf, globalThis.game?.user?.targets) ?? this.document); }
		static onSelectTab(event, target) { const t = target?.dataset?.tab; if (t) { this._activeTab = t; this._previewGuiseId = null; this.render(); } }
		static async onGuiseWear(event, target) { const id = target?.dataset?.guise; if (!id) return; this._previewGuiseId = null; try { await sheetGuiseWear(this.document, id); } catch (err) { console.warn('[rippers-guise] guise wear/swap failed:', err); } finally { this.render(); } }
		static async onPickArcana(event, target) { const id = target?.dataset?.guise; if (!id) return; try { await sheetPickArcana(this.document, id); } catch (err) { console.warn('[rippers-guise] arcana pick failed:', err); } finally { this.render(); } }
		static async onToggleFace() { await sheetToggleFace(this.document); this.render(); }
		static async onSetFace(event, target) {
			const which = target?.dataset?.face; if (which !== 'normal' && which !== 'other') return;
			const FP = foundry?.applications?.apps?.FilePicker?.implementation ?? foundry?.applications?.apps?.FilePicker ?? globalThis.FilePicker;
			if (!FP) { ui.notifications?.warn('FilePicker is unavailable in this Foundry build.'); return; }
			const self = this;
			const picker = new FP({ type: 'image', current: getFaces(this.document)[which] || '', callback: async (path) => { await setFace(self.document, which, path); self.render(); } });
			return typeof picker.browse === 'function' ? picker.browse() : picker.render(true);
		}
		static async onSetGuiseFace(event, target) {
			const id = target?.dataset?.guise; const val = target?.dataset?.value ?? '';
			const guise = id && this.document.items?.get?.(id); if (!guise) return;
			if (GUISE_FACE_KEYS.includes(val)) await guise.setFlag(MODULE_ID, GUISE_FACE_FLAG, val);
			else if (guise.getFlag(MODULE_ID, GUISE_FACE_FLAG)) await guise.unsetFlag(MODULE_ID, GUISE_FACE_FLAG);
			this.render();
		}
		static async onGuiseSwap() { try { await sheetGuiseSwap(this.document); } catch (err) { console.warn('[rippers-guise] guise swap failed:', err); } finally { this.render(); } }
		static async onRollWeapon(event, target) { const id = target?.dataset?.item; if (id) await sheetRollWeapon(this.document, id); }
		static async onRollCheck() { await sheetRollCheck(this.document); }
		static async onToggleRivalWaiver() {
			const api = rippersAutomationApi();
			if (api?.toggleRivalWaiver) { await api.toggleRivalWaiver(this.document); this.render(); }
		}
		static async onRest() { await sheetRest(this.document); this.render(); }
		static async onHealToCrisis() { await sheetHealToCrisis(this.document); this.render(); }
		static async onLevelUp() { await sheetLevelUp(this.document); this.render(); }
		static async onSkillSlAdjust(event, target) {
			const g = this.document?.items?.get?.(target?.dataset?.guise);
			const classUuid = target?.dataset?.class, skillUuid = target?.dataset?.skill, dir = Number(target?.dataset?.dir) || 0;
			if (!g || !classUuid || !skillUuid || !dir) return;
			const cur = ((g.system?.data?.classes ?? []).find((c) => c.classUuid === classUuid)?.skills ?? []).find((s) => s.skillUuid === skillUuid);
			await setGuiseSkillSL(g, classUuid, skillUuid, (Number(cur?.sl) || 0) + dir);
			this.render();
		}
		static async onToggleSlLock(event, target) { const g = this.document?.items?.get?.(target?.dataset?.guise); if (g) { await toggleGuiseSlLock(g); this.render(); } }
		static onItemSheet(event, target) { const it = this.document?.items?.get?.(target?.dataset?.item); it?.sheet?.render?.(true); }
		static async onQuirkAdd() { await sheetAddQuirk(this.document); this.render(); }
		static async onQuirkEdit(event, target) { const id = target?.dataset?.item; if (id) await sheetEditQuirk(this.document, id); }
		static async onQuirkRemove(event, target) { const id = target?.dataset?.item; if (id) { await sheetRemoveQuirk(this.document, id); this.render(); } }
		static async onSpendFabula() { await sheetSpendFabula(this.document); this.render(); }
		static async onOpenEditor(event, target) { await sheetOpenEditor(this.document, target?.dataset?.guise); this.render(); }
		static async onResTrackAdjust(event, target) { const k = target?.dataset?.key; const d = Number(target?.dataset?.dir) || 0; if (k && d) { await sheetAdjustTrackedResource(this.document, k, d); this.render(); } }
		static async onResTrackAdd() { await sheetAddTrackedResource(this.document); this.render(); }
		static async onResTrackRemove(event, target) { const k = target?.dataset?.key; if (k) { await sheetRemoveTrackedResource(this.document, k); this.render(); } }
		static async onStashGuise(event, target) { const id = target?.dataset?.guise; if (id) { await sheetStashGuise(this.document, id); this.render(); } }
		static async onVaultStash(event, target) {
			const id = target?.dataset?.guise; const aid = target?.dataset?.actor;
			const actor = aid ? (globalThis.game?.actors?.get?.(aid) ?? this.document) : this.document;
			if (id) { await vaultStashToCabinet(actor, id); this.render(); }
		}
		static async onHandOffGuise(event, target) {
			const id = target?.dataset?.guise; if (!id) return;
			const recipient = [...(globalThis.game?.user?.targets ?? [])][0]?.actor ?? null;
			await sheetHandOffGuise(this.document, id, recipient); this.render();
		}
		// ── Deeper Bonds native controls (data-bond = the bond name) ──
		static async onBondCreate() { await sheetBondCreate(this.document); this.render(); }
		static async onBondSolidify(event, target) { await sheetBondSolidify(this.document, target?.dataset?.bond); this.render(); }
		static async onBondEternal(event, target) { await sheetBondEternal(this.document, target?.dataset?.bond); this.render(); }
		static async onBondClockFill(event, target) { await sheetBondClockFill(this.document, target?.dataset?.bond); this.render(); }
		static async onBondCleanse(event, target) { await sheetBondCleanse(this.document, target?.dataset?.bond); this.render(); }
		static async onBondSharedResolve(event, target) { await sheetBondSharedResolve(this.document, target?.dataset?.bond); this.render(); }
		static async onBondRaiseDie(event, target) { await sheetBondRaiseDie(this.document, target?.dataset?.bond); this.render(); }
		static async onBondSkillGrant(event, target) { await sheetBondSkillGrant(this.document, target?.dataset?.bond); this.render(); }
		static async onBondSolidifyRest() { await sheetBondSolidifyRest(this.document); this.render(); }
		// Inline bonds (Edit tab): add/remove a plain FU bond on the character's own system.bonds array.
		// Owner-permitted (unlike the GM-gated Deeper createFleetingBond); a new bond is fleeting by default.
		static async onBondAddRow() {
			try { await this.document.update({ 'system.bonds': withBondAppended(this.document.system?.bonds ?? []) }); }
			catch (err) { console.warn('[rippers-guise] bond add failed:', err); }
			this.render();
		}
		static async onBondRemove(event, target) {
			const idx = Number(target?.dataset?.bondIndex); if (!Number.isFinite(idx)) return;
			try { await this.document.update({ 'system.bonds': withBondRemoved(this.document.system?.bonds ?? [], idx) }); }
			catch (err) { console.warn('[rippers-guise] bond remove failed:', err); }
			this.render();
		}
		// ── v0.7.15 Active Effects (native Foundry AE pipeline; no bespoke system) ──
		_findEffect(id) {
			if (!id) return null;
			try { if (typeof this.document.getEffect === 'function') return this.document.getEffect(id); } catch { /* fall through */ }
			return this.document.effects?.get?.(id) ?? null;
		}
		static async onEffectCreate(event, target) {
			const type = target?.dataset?.effectType ?? 'passive';
			try {
				const created = await this.document.createEmbeddedDocuments('ActiveEffect', [{
					name: game.i18n?.localize?.('RIPPERS.Sheet.NewEffect') ?? 'New Effect',
					img: 'icons/svg/aura.svg', origin: this.document.uuid,
					disabled: type === 'inactive',
					duration: type === 'temporary' ? { rounds: 1 } : {},
				}]);
				created?.[0]?.sheet?.render?.(true);
			} catch (err) { console.warn('[rippers-guise] effect create failed:', err); }
			this.render();
		}
		static onEffectEdit(event, target) { const ef = this._findEffect(target?.dataset?.effectId); ef?.sheet?.render?.(true, { editable: this.document === ef.parent }); }
		static async onEffectToggle(event, target) { const ef = this._findEffect(target?.dataset?.effectId); if (ef) { try { await ef.update({ disabled: !ef.disabled }); } catch (err) { console.warn('[rippers-guise] effect toggle failed:', err); } this.render(); } }
		static async onEffectDelete(event, target) { const ef = this._findEffect(target?.dataset?.effectId); if (ef) { try { await ef.delete(); } catch (err) { console.warn('[rippers-guise] effect delete failed:', err); } this.render(); } }
		// ── v0.7.15 inventory: equip/unequip loose gear (native system.equipped record) + use + delete ──
		static async onItemEquip(event, target) {
			const it = this.document.items?.get?.(target?.dataset?.item); if (!it) return;
			const cur = this.document.system?.equipped?.toObject?.() ?? { ...(this.document.system?.equipped ?? {}) };
			try { await this.document.update({ 'system.equipped': equipToggleUpdate(cur, it) }); }
			catch (err) { console.warn('[rippers-guise] equip toggle failed:', err); }
			this.render();
		}
		static async onItemUse(event, target) { const it = this.document.items?.get?.(target?.dataset?.item); if (it?.roll) { try { await it.roll(); } catch (err) { console.warn('[rippers-guise] item use failed:', err); } } }
		static async onItemDelete(event, target) {
			const id = target?.dataset?.item; if (!id) return;
			try { await this.document.deleteEmbeddedDocuments('Item', [id]); }
			catch (err) { console.warn('[rippers-guise] item delete failed:', err); }
			this.render();
		}
		// ── v0.7.16 spells: add a blank native 'spell' Item and open its sheet (cast reuses itemUse=item.roll) ──
		static async onSpellAdd() {
			try {
				const created = await this.document.createEmbeddedDocuments('Item', [{ name: game.i18n?.localize?.('RIPPERS.Sheet.NewSpell') ?? 'New Spell', type: 'spell' }]);
				created?.[0]?.sheet?.render?.(true);
			} catch (err) { console.warn('[rippers-guise] spell add failed:', err); }
			this.render();
		}
	}
	_RippersActorSheet = RippersActorSheet;
	return RippersActorSheet;
}
/** Register the Rippers character sheet as an ALTERNATIVE (user-selectable, never default). */
function registerRippersSheet() {
	try {
		const Actors = foundry.documents?.collections?.Actors ?? globalThis.Actors;
		if (!Actors?.registerSheet) { console.warn('[rippers-guise] Actors.registerSheet unavailable — Rippers sheet not registered.'); return; }
		Actors.registerSheet(MODULE_ID, getRippersActorSheetClass(), {
			types: ['character'], makeDefault: false, label: 'RIPPERS.Sheet.Label',
		});
		console.log(`[${MODULE_ID}] registered the Rippers character sheet (alternative, user-selectable, read-only P1).`);
	} catch (err) { console.error('[rippers-guise] Rippers sheet registration failed:', err); }
}
Hooks.once('setup', registerRippersSheet);

// ---------------------------------------------------------------------------
// Registration + template preload.
Hooks.once('setup', () => {
	// #4 (v0.7.9): register the module-wide GM edit override (world scope ⇒ GM-only to change).
	try {
		game.settings.register(MODULE_ID, EDIT_OVERRIDE_SETTING, {
			name: 'RIPPERS.Settings.EditOverride',
			hint: 'RIPPERS.Settings.EditOverrideHint',
			scope: 'world', config: true, type: Boolean, default: false,
		});
	} catch (err) { console.warn('[rippers-guise] could not register the edit-override setting:', err); }
	// V2 (Party Vault): party size drives the field limit (partySize + 2). World-scoped Number.
	try {
		game.settings.register(MODULE_ID, PARTY_SIZE_SETTING, {
			name: 'RIPPERS.Settings.PartySize',
			hint: 'RIPPERS.Settings.PartySizeHint',
			scope: 'world', config: true, type: Number, default: 4,
			range: { min: 1, max: 12, step: 1 },
		});
	} catch (err) { console.warn('[rippers-guise] could not register the party-size setting:', err); }
	// 2a arcana art base: a folder path the arcana tiles/picker resolve against. Code-only module ships
	// without the art, so on Forge the GM points this at their uploaded Major-Arcana folder. String +
	// folder FilePicker; default the module-internal folder so a local instance with the art still works.
	try {
		game.settings.register(MODULE_ID, ARCANA_BASE_SETTING, {
			name: 'RIPPERS.Settings.ArcanaBasePath',
			hint: 'RIPPERS.Settings.ArcanaBasePathHint',
			scope: 'world', config: true, type: String, default: DEFAULT_ARCANA_BASE,
			filePicker: 'folder',
		});
	} catch (err) { console.warn('[rippers-guise] could not register the arcana-base-path setting:', err); }
	const registry = CONFIG.FU?.classFeatureRegistry ?? globalThis.projectfu?.ClassFeatureRegistry;
	if (!registry?.register) {
		console.error('[rippers-guise] CONFIG.FU.classFeatureRegistry not available — projectfu must be active. Guise not registered.');
		return;
	}
	try {
		const GuiseDataModel = defineGuiseModel();
		CONFIG.FU.classFeatures ??= {};
		CONFIG.FU.classFeatures.guise = registry.register(MODULE_ID, 'guise', GuiseDataModel);
		console.log(`[rippers-guise] registered classFeature "${MODULE_ID}.guise" (v0.2 Stage B — dormancy + authoring UI).`);
	} catch (err) {
		console.error('[rippers-guise] failed to register the guise classFeature:', err);
	}
	const loader = foundry.applications?.handlebars?.loadTemplates ?? loadTemplates;
	loader([`modules/${MODULE_ID}/templates/guise-sheet.hbs`, `modules/${MODULE_ID}/templates/benefit-picker.hbs`, `modules/${MODULE_ID}/templates/guise-builder.hbs`]);
});

// ---------------------------------------------------------------------------
// SPECIALTY die-bump runtime (v0.7.1). The two Specialties live on the character's INNATE guise
// (system.data.specialties). The player ARMS the bump for their next check (a macro/API call —
// subject-match is their judgment); FU's prepareCheck hook applies it iff the check type is eligible
// (Austin: never Magic or Accuracy). Because FU builds the roll die from actor.system.attributes[attr]
// .current at roll time (checks/checks.mjs rollCheck), the bump is a TRANSIENT in-memory raise of that
// .current one size, recorded per check.id and restored in processCheck (post-roll; the follow-up
// unsetFlag re-derives .current from .base anyway). No persisted write happens before the roll.
const SPECIALTY_ARM_FLAG = 'specialtyBump';        // {attribute?} — armed for the actor's next check
const _specialtyBumped = new Map();                // check.id -> { actorId, attr, old }
// Phase 2a: the 'flat' consumer's arm flag. Robot's "+2 to Checks involving machines/technology/
// constructs" is PLAYER-ARMED like a Specialty (god's arm-model ruling (a), 4 Sep 2026 — FU exposes
// no subject tag and the scope covers targetless checks, so full-auto is impossible; the player judges
// relevance and arms it). One-shot, consumed post-roll, exactly like the die arm. {value, label}.
const CHECK_FLAT_ARM_FLAG = 'checkFlatBump';
// The four FU attributes whose die the player may nominate for the Specialty bump (v0.7.6 —
// Austin: "the specialty button works but doesn't let you pick which die size to increase").
const SPECIALTY_ATTRIBUTES = [
	{ key: 'dex', label: 'DEX' }, { key: 'ins', label: 'INS' },
	{ key: 'mig', label: 'MIG' }, { key: 'wlp', label: 'WLP' },
];

/** Prompt the player for which attribute's die the Specialty should improve. Resolves to a key
 *  ('dex'|'ins'|'mig'|'wlp') or null if cancelled. DialogV2 (v13) with a classic-Dialog fallback. */
async function promptSpecialtyAttribute() {
	const opts = SPECIALTY_ATTRIBUTES.map((a) => `<option value="${a.key}">${a.label}</option>`).join('');
	const content = `<p>${game.i18n?.localize?.('RIPPERS.Specialty.PickAttr') ?? "Which attribute's die does the Specialty improve on your next Check?"}</p>`
		+ `<div class="form-group"><label>${game.i18n?.localize?.('RIPPERS.Specialty.Attribute') ?? 'Attribute'} </label>`
		+ `<select name="attr">${opts}</select></div>`;
	const title = game.i18n?.localize?.('RIPPERS.Specialty.Arm') ?? 'Specialty';
	const armLabel = game.i18n?.localize?.('RIPPERS.Specialty.ArmAction') ?? 'Arm';
	const DV2 = foundry?.applications?.api?.DialogV2;
	if (DV2?.prompt) {
		return DV2.prompt({
			window: { title },
			content,
			ok: { label: armLabel, callback: (_ev, btn) => btn.form?.elements?.attr?.value ?? null },
			rejectClose: false,
		}).catch(() => null);
	}
	const Dlg = globalThis.Dialog;
	if (!Dlg) return null;
	return new Promise((resolve) => {
		new Dlg({
			title, content,
			buttons: {
				arm: { label: armLabel, callback: (html) => resolve((html[0] ?? html).querySelector('select[name=attr]')?.value ?? null) },
				cancel: { label: game.i18n?.localize?.('RIPPERS.Builder.Clear') ?? 'Cancel', callback: () => resolve(null) },
			},
			default: 'arm', close: () => resolve(null),
		}).render(true);
	});
}

/** The actor's Innate guise item (mode 'innate' / flag isInnate), or null. */
function actorInnateGuise(actor) {
	return Array.from(actor?.items ?? []).find((i) => isGuiseItem(i) && (i.getFlag?.(MODULE_ID, 'isInnate') || i.system?.data?.mode === 'innate')) ?? null;
}
/** The character's two Specialties (from the Innate guise). [] if none.
 *  ROS-29 invariant: this reads the innate-guise ITEM by mode, NOT the active-guise flag, so the
 *  Specialties are the same whichever worn mask is bound (or none). The swap machinery
 *  (bind/dismiss) never touches system.data.specialties, so they persist across guise changes. */
function actorSpecialties(actor) {
	const g = actorInnateGuise(actor);
	const s = g?.system?.data?.specialties;
	return Array.isArray(s) ? s.filter(Boolean) : [];
}
/** T4 — the runtime Talented seam (the one the 1566 comment promised, previously draft-only). Talented
 *  DOUBLES the two Specialties to four; the armed die-bump already serves those extra Specialties because
 *  they live in the same innate-guise store — this seam just makes "is this character Talented?" answerable
 *  at runtime, recognizing EITHER the innate-guise boolean OR a held Talented quirk Item (rippers-automation
 *  fuid 'talented'), so Talented can later be granted as a quirk with no change to the die-bump path. */
function isTalented(actor) {
	if (actorInnateGuise(actor)?.system?.data?.talented) return true;
	for (const it of actor?.items ?? []) {
		const f = it.getFlag?.('rippers-automation', 'fuid') ?? it.flags?.['rippers-automation']?.fuid ?? it.system?.fuid;
		if (f === 'talented') return true;
	}
	return false;
}
/** The character's runtime Specialty cap: 4 when Talented, else 2 (mirrors the builder's specialtyCapFor). */
function actorSpecialtyCap(actor) { return specialtyCapFor(isTalented(actor)); }
/** The character's Hunter Weapon Item (marked isHunterWeapon), or null. ROS-29 invariant: it is a
 *  plain CHARACTER-owned weapon (never a guise-origin `owned` item), so a worn-mask swap can never
 *  delete or rewrite it — it is found by its flag regardless of which guise is active. A mask may
 *  displace it from the character's HANDS while worn (the mask carries its own weapons); it returns
 *  to its slot on dismiss. The item and its flag are invariant throughout. */
function actorHunterWeapon(actor) {
	return Array.from(actor?.items ?? []).find((i) => isHunterWeapon(i)) ?? null;
}
/** Arm the Specialty die-bump for the actor's NEXT eligible check (macro/API). `attribute` optional. */
async function armSpecialtyDieBump(actor, { attribute } = {}) {
	if (!actor) { ui.notifications?.warn('No actor to arm the Specialty die-bump on.'); return { ok: false }; }
	if (!actorSpecialties(actor).length) { ui.notifications?.warn('This character has no Specialties (author them on the Innate Guise).'); return { ok: false, reason: 'no specialties' }; }
	await actor.setFlag(MODULE_ID, SPECIALTY_ARM_FLAG, { attribute: attribute ?? null });
	ui.notifications?.info(game.i18n?.localize?.('RIPPERS.Specialty.Armed') ?? 'Specialty armed: your next Open/skill Check improves one die (not Magic or Accuracy).');
	return { ok: true };
}
async function disarmSpecialtyDieBump(actor) { if (actor?.getFlag?.(MODULE_ID, SPECIALTY_ARM_FLAG)) await actor.unsetFlag(MODULE_ID, SPECIALTY_ARM_FLAG); }

// ── Phase 2a: the 'flat' check-bump runtime (player-armed, like the die bump) ──
/** Arm a flat +N check bonus for the actor's NEXT eligible check (macro/API/consumer). One-shot,
 *  consumed post-roll. `label` is an i18n key or string for the modifier line. The player judges
 *  whether the check qualifies (Robot's narrative subject-scope) — this seam does not infer it. */
async function armCheckFlatBump(actor, { value, label } = {}) {
	if (!actor) { ui.notifications?.warn('No actor to arm the check bonus on.'); return { ok: false }; }
	const v = Math.trunc(Number(value) || 0);
	if (!v) { ui.notifications?.warn('A flat check bonus needs a non-zero value.'); return { ok: false, reason: 'zero' }; }
	await actor.setFlag(MODULE_ID, CHECK_FLAT_ARM_FLAG, { value: v, label: label ? String(label) : null });
	ui.notifications?.info(`Check bonus armed: +${v} to your next eligible Check.`);
	return { ok: true };
}
async function disarmCheckFlatBump(actor) { if (actor?.getFlag?.(MODULE_ID, CHECK_FLAT_ARM_FLAG)) await actor.unsetFlag(MODULE_ID, CHECK_FLAT_ARM_FLAG); }
/** The FU check-modifier {label,value} to push for an actor's armed flat bump on a check of `checkType`,
 *  or null if none is armed / the check is ineligible. Pure (reads only the flag). Testable headless. */
function pendingFlatModifier(actor, checkType) {
	const armed = actor?.getFlag?.(MODULE_ID, CHECK_FLAT_ARM_FLAG);
	if (!armed) return null;
	if (!checkBumpEligible('flat', checkType)) return null;
	return flatCheckModifier(armed.value, armed.label ?? 'RIPPERS.Specialty.Arm');
}
/** The generalized check-bump API (god's {kind, amount, predicate}): dispatch a player-armed bump.
 *  kind 'die' improves one attribute die (Specialties/Talented/Innate); 'flat' adds +amount to the
 *  Check total (Robot). The "predicate" for player-armed bumps is the player's judgment (arming) plus
 *  checkBumpEligible(kind, type); no code subject-predicate is needed under arm-model (a). */
async function armCheckBump(actor, { kind = 'die', amount, attribute, label } = {}) {
	if (kind === 'flat') return armCheckFlatBump(actor, { value: amount, label });
	return armSpecialtyDieBump(actor, { attribute }); // 'die' (default)
}

/** prepareCheck handler: apply an armed, eligible Specialty die-bump by transiently raising the die. */
function onPrepareCheckSpecialty(check, actor) {
	try {
		if (!actor || !check) return;
		const armed = actor.getFlag?.(MODULE_ID, SPECIALTY_ARM_FLAG);
		if (!armed) return;
		if (!specialtyBumpEligible(check.type)) {
			ui.notifications?.warn(game.i18n?.localize?.('RIPPERS.Specialty.NotHere') ?? 'A Specialty does not improve Magic or Accuracy Checks. Die-bump not applied — still armed.');
			return; // leave it armed for a later eligible check
		}
		if (!actorSpecialties(actor).length) return;
		const slot = chooseBumpSlot(check, armed.attribute);
		const attr = check[slot];
		const node = actor.system?.attributes?.[attr];
		const cur = Number(node?.current);
		const up = improveDieSize(cur);
		if (node && up > cur) {
			node.current = up; // transient — rollCheck reads this next; restored in processCheck
			_specialtyBumped.set(check.id, { actorId: actor.id, attr, old: cur });
		}
	} catch (err) { console.error('[rippers-guise] specialty die-bump (prepareCheck) failed:', err); }
}
/** processCheck handler: restore the transient die and consume the arm (post-roll — a DB write is safe here). */
async function onProcessCheckSpecialty(result, actor) {
	try {
		const rec = _specialtyBumped.get(result?.id);
		if (!rec) return;
		_specialtyBumped.delete(result.id);
		const node = actor?.system?.attributes?.[rec.attr];
		if (node && Number(node.current) !== rec.old) node.current = rec.old;
		if (actor?.getFlag?.(MODULE_ID, SPECIALTY_ARM_FLAG)) {
			await actor.unsetFlag(MODULE_ID, SPECIALTY_ARM_FLAG); // consume — re-derives .current from .base
			await ChatMessage.create({
				speaker: ChatMessage.implementation.getSpeaker({ actor }),
				content: `<div class="rippers-guise-card"><strong>${esc(actor.name)}</strong> draws on a Specialty — one die improved for this ${esc(result?.type ?? 'check')}.</div>`,
			});
		}
	} catch (err) { console.error('[rippers-guise] specialty die-bump (processCheck) failed:', err); }
}
/** prepareCheck handler: apply an armed, eligible FLAT bump by pushing a check.modifiers entry.
 *  No transient record / restore — check.modifiers rides the per-roll check object (FU checks.mjs). */
function onPrepareCheckFlat(check, actor) {
	try {
		if (!actor || !check) return;
		if (!actor.getFlag?.(MODULE_ID, CHECK_FLAT_ARM_FLAG)) return;
		if (!checkBumpEligible('flat', check.type)) return; // leave armed for a later eligible check
		const mod = pendingFlatModifier(actor, check.type);
		if (mod) { (check.modifiers ??= []).push(mod); }
	} catch (err) { console.error('[rippers-guise] flat check-bump (prepareCheck) failed:', err); }
}
/** processCheck handler: consume the flat arm post-roll (one-shot, like the die bump). */
async function onProcessCheckFlat(result, actor) {
	try {
		if (!actor?.getFlag?.(MODULE_ID, CHECK_FLAT_ARM_FLAG)) return;
		await actor.unsetFlag(MODULE_ID, CHECK_FLAT_ARM_FLAG); // consume
	} catch (err) { console.error('[rippers-guise] flat check-bump (processCheck) failed:', err); }
}
/** Register the FU check hooks. Resolves CheckHooks at ready (FU is live), falls back to the string names. */
function registerSpecialtyBumpHooks() {
	const CH = globalThis.game?.projectfu?.CheckHooks ?? {};
	Hooks.on(CH.prepareCheck ?? 'projectfu.prepareCheck', onPrepareCheckSpecialty);
	Hooks.on(CH.processCheck ?? 'projectfu.processCheck', onProcessCheckSpecialty);
	// Phase 2a: the generalized 'flat' consumer rides the same prepareCheck/processCheck hooks.
	Hooks.on(CH.prepareCheck ?? 'projectfu.prepareCheck', onPrepareCheckFlat);
	Hooks.on(CH.processCheck ?? 'projectfu.processCheck', onProcessCheckFlat);
}

Hooks.once('ready', async () => {
	registerSpecialtyBumpHooks();
	// §10 lent vitals: a rest refills every LIVE guise's lent HP/MP to maximum (worn or in hand). The
	// IP satchel is NOT refilled (bought back at 10z/pt). FU dispatches REST_EVENT with { actor }.
	// ⚠ INTEGRATION FLAG: "lent layer spent before the wearer's own pool" is provided as the
	// applyResourceCost() seam (pure spendLentThenOwn + writes). Automatically intercepting FU's damage
	// pipeline (DAMAGE_PIPELINE_POST_CALCULATE / CALCULATE_RESOURCE_EVENT) to redirect through the layer
	// is a separate integration — deferred, because a wrong interception double-applies damage, and the
	// UI that shows/spends the layer is Austin's. The seam is unit-tested and ready to be wired.
	Hooks.on(globalThis.game?.projectfu?.FUHooks?.REST_EVENT ?? 'projectfu.events.rest', (event) => {
		const actor = event?.actor; if (!actor) return;
		restRefillActorGuises(actor).catch((err) => console.warn('[rippers-guise] rest refill failed:', err));
	});
	// P3: lent-vitals auto-intercept — the worn guise's lent-HP layer absorbs damage before own HP.
	// POST_CALCULATE (result is final/post-affinity; amount-modifier quirks ran at PRE). HP only.
	Hooks.on(globalThis.game?.projectfu?.FUHooks?.DAMAGE_PIPELINE_POST_CALCULATE ?? 'projectfu.pipelines.damage.postCalculate', onDamagePostLentSplit);
	// MP-LAYER-ROUTING: spend the lent-MP layer before own MP on every spell/skill/feature MP cost.
	Hooks.on(globalThis.game?.projectfu?.FUHooks?.CALCULATE_EXPENSE_EVENT ?? 'projectfu.events.calculateExpense', onCalculateExpenseLentMp);
	// H3 "The Turn": reset every guise-bearer's per-scene swap state on a combat boundary (a new
	// conflict is a new scene's Turn), and on a Foundry scene change while NO combat is running (a
	// mid-combat scene pan must not clobber the Turn). A narrative scene break with no scene change
	// is the GM's call — clearGuiseSceneState is on the api for a reset macro.
	const _resetTurns = () => clearAllGuiseSceneState().catch((err) => console.warn('[rippers-guise] Turn reset failed:', err));
	Hooks.on('combatStart', _resetTurns);
	Hooks.on('deleteCombat', _resetTurns);
	Hooks.on('canvasReady', () => { if (!game.combat?.started) _resetTurns(); });
	const mod = game.modules.get(MODULE_ID);
	if (mod) mod.api = { armSpecialtyDieBump, disarmSpecialtyDieBump, armCheckBump, armCheckFlatBump, disarmCheckFlatBump, actorSpecialties, isTalented, actorSpecialtyCap, actorHunterWeapon, bindGuise, dismissGuise, setActiveGuise, getActiveGuise, clearActiveGuise, guiseSwapActionDecision, accountGuiseSwap, actorInActiveCombat, guiseSceneState, clearGuiseSceneState, clearAllGuiseSceneState, partySize, guiseFieldLimit, fieldSlots, buildVaultVM, vaultHandOff, vaultStashToCabinet, vaultSlotFromCabinet, applyGuiseFace, restoreBaseFace, sheetToggleFace, setFace, getFaces, suppressInnateSkills, restoreInnateSkills, migrateWorldGuises, migrateGuiseItem, sanitizeActorGuises, dedupeActorGuises, dedupeWorldGuises, syncAffinityEffect, swapAffinitySet, setAffinityLibrary, getAffinityLibrary, getActiveAffinitySet, getActiveAffinitySetId, isReplaceModeGuise, affinitySetCapOf, namedSkillSL, swapPactSet, setPactLibrary, getPactLibrary, getActivePact, getActivePactId, miasmicFormsSL, isPoolKey, POOL_BLOCK, FLAG, isHunterWeapon, setHunterWeapon, hunterWeaponIsBane, swapActiveForm, swapHunterWeaponForm, hoplosphereSocketCapacity, checkHoplosphereSockets, seatedHoplospheres, slotHoplosphere, baseSocketCapacity, persistentSlotsUnlocked, hoplosphereHostKind, getHeroicSlots, assignHeroicSlot, clearHeroicSlot, suppressCreationHeroic, restoreCreationHeroic, BENEFIT_POOL, getBenefitPicks, setBenefitPicks, benefitPickSummary, rebuildBenefitEffect, stripClassBenefits, characterRitualDisciplines, characterCanInitiateProjects, openBenefitPicker, benefitPickerContext, openGuiseBuilder, createGuiseFromDraft, guiseVitals, applyResourceCost, restRefillActorGuises, restockIp, spendIp, IP_UNIT_COST };
	// §7 migration — GM only; idempotent (skips guises already at schemaVersion ≥ 2).
	if (game.user?.isGM) {
		try {
			const n = await migrateWorldGuises();
			if (n) console.log(`[rippers-guise] v0.2 migration: updated ${n} guise item(s).`);
		} catch (err) { console.warn('[rippers-guise] v0.2 migration skipped:', err); }
	}
});

// Test-only exports (Foundry ignores these on an esmodule entry point).
export { buildReplaceChanges, validateAffinitySet, validateAffinityLibrary, affinitySwapAllowed, buildGuiseAffinityChanges, getAffinityLibrary, getActiveAffinitySet, getActiveAffinitySetId, isReplaceModeGuise, affinitySetCapOf, namedSkillSL, setAffinityLibrary, swapAffinitySet, AFFINITY_TYPES, AFFINITY_VALUES, AE_OVERRIDE };
// Back-compat aliases (pre-release Diabolist "pact" names).
export { validatePactSet, validatePactLibrary, pactSwapAllowed, getPactLibrary, getActivePact, getActivePactId, miasmicFormsSL, setPactLibrary, swapPactSet };
export { isPoolKey, filterChanges, POOL_BLOCK, affinityChange, materialiseSkills, resolveItem, isInnateSkill, suppressInnateSkills, restoreInnateSkills, clampAllocationInputs, AFFINITY_LEVELS, budgetOf, guiseSummary, bindGuise, bindGuiseNoCost, defaultActiveGuiseId, dismissGuise, setActiveGuise, getActiveGuise, isHunterWeapon, nextForm, swapActiveForm, setHunterWeapon, hunterWeaponIsBane, hoplosphereSocketCapacity, checkHoplosphereSockets, seatedHoplospheres, evaluateSlotting, baseSocketCapacity, persistentSlotsUnlocked, hoplosphereHostKind, characterHoplosphereImmunityCount, hoplosphereHosts, slotHoplosphere, getHeroicSlots, assignHeroicSlot, clearHeroicSlot, heroicIsCreationBanned, suppressCreationHeroic, restoreCreationHeroic, BENEFIT_POOL, validateBenefitPicks, benefitResourceDeltas, benefitEffectChanges, getBenefitPicks, setBenefitPicks, benefitPickSummary, rebuildBenefitEffect, stripClassBenefits, characterRitualDisciplines, normalizeDisciplines, characterCanInitiateProjects, benefitSelectionSummary, benefitPickerContext, parseBenefitForm, RITUAL_DISCIPLINES, RITUAL_SECOND_DISCIPLINES, ritualsLabel, openBenefitPicker, emptyGuiseDraft, parseClassSkills, guiseDraftToData, guiseDataToDraft, createGuiseFromDraft, materialiseCreationHeroic, materialiseHunterWeapon, materialiseInnateEquip, EQUIP_INNATE_SLOTS, innateKitReconcilePlan, innateKitPlanIsEmpty, reconcileInnateKit, draftKey, DRAFT_SEP, openGuiseBuilder, WIZARD_STEPS, clampWizardStep, affinityLevelOf, withAffinityLevel, newAffinitySet };
// GUISE-BUILDER-FIX (v0.7.0) — canon vocabularies + guardrail validators (pure, unit-tested).
export { GUISE_MODES, REQUIRED_CLASS_COUNT, SPECIALTY_LIST, SPECIALTY_COUNT, TALENTED_SPECIALTY_COUNT, specialtyCapFor, draftIsTalented, BONUS_VALUE, TRIO_LEVEL, affinityTrioToModifiers, validateAffinityTrio, validateGuiseDraft };
// v0.7.6 — per-step guardrail errors (wizard chrome gating) + budget/min-per-class helpers.
export { guiseStepErrors, draftRawSpent, draftClassSpent, SPECIALTY_ATTRIBUTES };
// v0.7.1 follow-up — Specialty die-bump (excl. magic/accuracy) + Hunter-Weapon-in-Innate authoring.
export { SPECIALTY_EXCLUDED_CHECKS, specialtyBumpEligible, CHECK_DIE_SIZES, improveDieSize, chooseBumpSlot, HW_MATERIALS, actorInnateGuise, actorSpecialties };
export { isTalented, actorSpecialtyCap };
// Phase 2a: the generalized check-bump seam (die + flat).
export { CHECK_BUMP_KINDS, checkBumpEligible, flatCheckModifier };
// ROS-29 — character-invariant reads of the Specialty source (innate guise) + the Hunter Weapon.
export { actorHunterWeapon };
// v0.7.3 — Specialty arm/disarm (sheet button + macro/API).
export { armSpecialtyDieBump, disarmSpecialtyDieBump, SPECIALTY_ARM_FLAG };
// Phase 2a: the generalized check-bump API (die + flat) + the flat runtime pieces.
export { armCheckBump, armCheckFlatBump, disarmCheckFlatBump, pendingFlatModifier, CHECK_FLAT_ARM_FLAG };
export { normalizeLentLayer, normalizeIpSatchel, spendLentThenOwn, restRefillLayer, restockIp, spendIp, IP_UNIT_COST, guiseVitals, setGuiseLentCurrent, activeGuiseItem, applyResourceCost, restRefillActorGuises, lentHpAbsorbPlan, onDamagePostLentSplit, onCalculateExpenseLentMp };
export { buildRippersSheetVM, getRippersActorSheetClass, registerRippersSheet, RS_ATTR_LABELS, RS_AFFINITY_TYPES, RS_STATUS_IDS, RS_COND_GROUPS, RS_TABS, rsAffFlags, weaponStats, sheetHealToCrisis, clampSkillSL, guiseSlEditable, setGuiseSkillSL, toggleGuiseSlLock, raiseDieSize, levelUpMilestone, sheetLevelUp, RS_BOND_EMOTIONS, bondEmotionOptions, bondStrengthOf, withBondAppended, withBondRemoved, RS_INVENTORY_TYPES, itemEquippable, itemIsTwoHanded, equipToggleUpdate, effectBucket, buildInventoryVM, buildEffectsVM, buildSpellsVM, buildGuisePlayVM, materialiseSpells, spellsForSkill, spellGrantingSkillKeys, loadSpellIndex, collectArmorItems, setDraftArmor, collectEquipItems, setDraftEquip, EQUIP_SLOT_TYPES, editFieldUpdate };
export { statusTargetActor, sheetAdjustResource, sheetToggleStatus, sheetGuiseWear, sheetGuiseSwap, sheetOpenConditions };
// 2a guise-identity arcana tiles (local assets; picker persists to the guise Item flag).
export { ARCANA, ARCANA_FLAG, ARCANA_BASE_SETTING, DEFAULT_ARCANA_BASE, arcanaBySlug, arcanaBasePath, arcanaImg, arcanaImgAt, isArcanaImage, prettifyArcanaName, arcanaEntriesFromFiles, resolveArcana, browseArcana, guiseArcana, sheetPickArcana };
// H2 two-portrait swap (normal/other-shape; our own build, not Visage).
export { faceForGuise, resolveFaceImg, nextManualFace, getFaces, setFace, applyGuiseFace, restoreBaseFace, sheetToggleFace, guiseFacesVM, GUISE_FACE_KEYS, FACES_FLAG, GUISE_FACE_FLAG, NO_PORTRAIT_WELL };
// H3 "The Turn": guise-swap action economy (pure decision + scene state + boundary clear).
export { guiseSwapActionDecision, markGuiseUsed, guiseSceneState, accountGuiseSwap, clearGuiseSceneState, USED_GUISES_FLAG, TURN_REFUND_FLAG };
// Unit 3 Party Vault: field limit + slots (V1/V5), roster/cabinet VM (V2/V3/V4), cross-owner hand-off (X4).
export { partySize, guiseFieldLimit, fieldSlots, partyActors, vaultGuiseCard, buildCabinetEntries, buildVaultVM, vaultHandOff, vaultStashToCabinet, vaultSlotFromCabinet, ensureCabinetPack, PARTY_SIZE_SETTING, CABINET_PACK, CABINET_WORLD_PACK };
export { sheetRollWeapon, sheetRollCheck, sheetRest, sheetSpendFabula };
export { sheetOpenEditor, sheetStashGuise, handOffDecision, sheetHandOffGuise };
export { deeperBondsApi, bondClockPips, bondPanelRow, buildBondPanelRows, SOLID_BOND_CAP, DEEPER_BONDS_ID };
export { vitalBar, vitalDots, adjustTrackedResource, TRACKED_RESOURCES_FLAG, sheetAdjustTrackedResource, sheetAddTrackedResource, sheetRemoveTrackedResource };
