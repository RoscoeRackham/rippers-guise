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
 * NOT in Stage A (later alphas): the two-pool DORMANCY switch (suppressing the character's own
 * innate skills while masked), the interactive sheet-authoring UI (drop targets + SL picker),
 * and the §10 progression layer (lent vitals, IP satchel, hoplosphere, Hunter Weapon, heroic
 * slots). The v0.1.1 innate-pool guard stays.
 *
 * @see globalThis.projectfu.RollableClassFeatureDataModel
 */

const MODULE_ID = 'rippers-guise';
const FLAG = 'activeGuise';
const FEATURE_TYPE = `${MODULE_ID}.guise`;
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

/**
 * Rebuild the guise Item's single embedded "Guise affinities" ActiveEffect from its
 * affinityModifiers, so the transferEffects() gate applies/removes it on bind/dismiss.
 */
async function syncAffinityEffect(item) {
	if (!isGuiseItem(item)) return;
	const mods = item.system?.data?.affinityModifiers ?? [];
	const changes = mods.map((m) => affinityChange(m.type, m.level)).filter(Boolean);
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

async function bindGuise(actor, item) {
	// Dismiss any currently-active (different) guise first — one guise at a time.
	const prev = actor.getFlag(MODULE_ID, FLAG);
	if (prev && prev !== item.id) {
		const prevItem = actor.items.get(prev);
		if (prevItem) await dismissGuise(actor, prevItem, { silent: true });
	}
	const preBindEquip = foundry.utils.deepClone(actor.system?.equipped ?? {});
	const skillIds = await materialiseSkills(actor, item);
	const { ids: equipIds, equipUpdate } = await materialiseEquipment(actor, item);
	const owned = [...skillIds, ...equipIds];
	await actor.update({
		[`flags.${MODULE_ID}.${FLAG}`]: item.id,
		[`flags.${MODULE_ID}.preBindEquip`]: preBindEquip,
		[`flags.${MODULE_ID}.owned.${item.id}`]: owned,
		...equipUpdate,
	});
	// Affinities: the guise's embedded "Guise affinities" effect now transfers (transferEffects()=true).
	console.debug(`[rippers-guise] bound "${item.name}": ${skillIds.length} skill(s), ${equipIds.length} equipment.`);
}

async function dismissGuise(actor, item, { silent = false } = {}) {
	const owned = actor.getFlag(MODULE_ID, 'owned')?.[item.id] ?? [];
	const preBindEquip = actor.getFlag(MODULE_ID, 'preBindEquip') ?? {};
	const existing = owned.filter((id) => actor.items.get(id));
	if (existing.length) await actor.deleteEmbeddedDocuments('Item', existing);
	const equipRestore = {};
	for (const slot of ALL_SLOTS) equipRestore[`system.equipped.${slot}`] = preBindEquip[slot] ?? null;
	await actor.update({
		[`flags.${MODULE_ID}.${FLAG}`]: null,
		[`flags.${MODULE_ID}.owned.-=${item.id}`]: null,
		...equipRestore,
	});
	if (!silent) console.debug(`[rippers-guise] dismissed "${item.name}".`);
}

// ---------------------------------------------------------------------------
// Public helpers (macros / other modules).
function getActiveGuise(actor) { return actor?.getFlag(MODULE_ID, FLAG) ?? null; }
async function setActiveGuise(actor, item) {
	if (!actor || !item) return;
	if (getActiveGuise(actor) === item.id) return dismissGuise(actor, item);
	return bindGuise(actor, item);
}
async function clearActiveGuise(actor) {
	const id = getActiveGuise(actor);
	const item = id && actor.items.get(id);
	if (item) return dismissGuise(actor, item);
}

// ---------------------------------------------------------------------------
// The GuiseDataModel (built at 'setup', when Project FU's base classes exist).
function defineGuiseModel() {
	const { RollableClassFeatureDataModel } = globalThis.projectfu ?? {};
	if (!RollableClassFeatureDataModel) {
		throw new Error('[rippers-guise] Project FU (globalThis.projectfu.RollableClassFeatureDataModel) not found — is the projectfu system active?');
	}
	const { StringField, HTMLField, ArrayField, SchemaField, NumberField } = foundry.data.fields;

	return class GuiseDataModel extends RollableClassFeatureDataModel {
		static defineSchema() {
			return {
				// narrative
				identity: new StringField({ initial: '' }),
				role: new StringField({ initial: '' }),
				notes: new HTMLField({ initial: '' }),
				// classes + per-skill allocation (D1: UUID refs to the compendium)
				classes: new ArrayField(new SchemaField({
					classUuid: new StringField({ initial: '' }),
					skills: new ArrayField(new SchemaField({
						skillUuid: new StringField({ initial: '' }),
						sl: new NumberField({ initial: 1, min: 0, integer: true, nullable: false }),
					})),
				})),
				// equipment (D3: guise carries its own loadout)
				equipment: new ArrayField(new SchemaField({
					itemUuid: new StringField({ initial: '' }),
					slot: new StringField({ initial: 'mainHand', choices: EQUIP_SLOTS }),
				})),
				// affinity modifiers (via the transferEffects gate)
				affinityModifiers: new ArrayField(new SchemaField({
					type: new StringField({ initial: 'dark', choices: AFFINITY_TYPES }),
					level: new NumberField({ initial: 1, integer: true, nullable: false }),
				})),
			};
		}

		static get template() { return `modules/${MODULE_ID}/templates/guise-sheet.hbs`; }
		static get translation() { return 'RIPPERS.Guise.Feature'; }

		static async getAdditionalData(model) {
			const activeId = model.actor?.getFlag(MODULE_ID, FLAG) ?? null;
			return { active: !!model.item && model.item.id === activeId };
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
	if (isGuiseItem(item) && (item.system?.data?.affinityModifiers?.length)) await syncAffinityEffect(item);
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
// Registration + template preload.
Hooks.once('setup', () => {
	const registry = CONFIG.FU?.classFeatureRegistry ?? globalThis.projectfu?.ClassFeatureRegistry;
	if (!registry?.register) {
		console.error('[rippers-guise] CONFIG.FU.classFeatureRegistry not available — projectfu must be active. Guise not registered.');
		return;
	}
	try {
		const GuiseDataModel = defineGuiseModel();
		CONFIG.FU.classFeatures ??= {};
		CONFIG.FU.classFeatures.guise = registry.register(MODULE_ID, 'guise', GuiseDataModel);
		console.log(`[rippers-guise] registered classFeature "${MODULE_ID}.guise" (v0.2 Stage A).`);
	} catch (err) {
		console.error('[rippers-guise] failed to register the guise classFeature:', err);
	}
	const loader = foundry.applications?.handlebars?.loadTemplates ?? loadTemplates;
	loader([`modules/${MODULE_ID}/templates/guise-sheet.hbs`]);
});

Hooks.once('ready', async () => {
	const mod = game.modules.get(MODULE_ID);
	if (mod) mod.api = { bindGuise, dismissGuise, setActiveGuise, getActiveGuise, clearActiveGuise, migrateWorldGuises, migrateGuiseItem, sanitizeActorGuises, syncAffinityEffect, isPoolKey, POOL_BLOCK, FLAG };
	// §7 migration — GM only; idempotent (skips guises already at schemaVersion ≥ 2).
	if (game.user?.isGM) {
		try {
			const n = await migrateWorldGuises();
			if (n) console.log(`[rippers-guise] v0.2 migration: updated ${n} guise item(s).`);
		} catch (err) { console.warn('[rippers-guise] v0.2 migration skipped:', err); }
	}
});

// Test-only exports (Foundry ignores these on an esmodule entry point).
export { isPoolKey, filterChanges, POOL_BLOCK, affinityChange, materialiseSkills };
