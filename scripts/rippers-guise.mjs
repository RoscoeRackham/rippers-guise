/**
 * rippers-guise — the Guise (mask / identity swap) as a FIRST-CLASS Project FU
 * classFeature, mirroring the Arcanist's Arcanum: one guise active at a time, and
 * "binding" a guise dismisses whichever was active. The active guise's deltas are
 * driven by the guise Item's embedded ActiveEffects, which Project FU transfers to
 * the actor only while `transferEffects()` is true — so a swap moves the deltas.
 *
 * Design (locked by the Technosphere spike, FOUNDRY-pivot-plan.md): Technosphere is a
 * multi-slot socket container — wrong shape. The Arcanum (one-active, bind/dismiss) is
 * the right analog. FU's classFeature registry is module-open, so we register 'guise'
 * with NO system fork.
 *
 * ONE DIFFERENCE FROM ARCANUM: Arcanum stores the active id in `actor.system.equipped.arcanum`,
 * a Project FU ACTOR schema field a module cannot add for 'guise'. We therefore store the
 * active-guise id in a MODULE FLAG on the actor: actor.flags['rippers-guise'].activeGuise.
 * setFlag issues an actor update -> prepareData -> FU re-evaluates transferEffects() for each
 * item's effects (actor.mjs applies an item's effects only when transferEffects() is true).
 *
 * @see globalThis.projectfu.RollableClassFeatureDataModel (Project FU public API)
 */

const MODULE_ID = 'rippers-guise';
const FLAG = 'activeGuise';
const FEATURE_TYPE = `${MODULE_ID}.guise`;

/**
 * INNATE BENEFIT POOL guard (Austin canon). A guise must NEVER apply anything in the
 * class innate pool — those come from CLASSES (the compendium's TRUE-with-note benefits):
 *   • HP / MP / IP (system.resources.{hp,mp,ip}.*)
 *   • martial proficiencies (melee / ranged / armor / shields)
 *   • ritual access
 *   • Projects
 * Guises may only modify things OUTSIDE the pool (attributes, accuracy/magic/damage
 * bonuses, defenses, affinities, initiative, …). We enforce this at the document layer:
 * any innate-pool change on a guise effect is STRIPPED on create/update, so it never
 * persists and therefore never applies — even for player-authored guises. (FU applies
 * effects via native `changes` with no per-change hook for standard modes, so stripping
 * at the data layer is the robust guard, not a per-apply filter.)
 */
const POOL_BLOCK = [
	/^system\.resources\.(hp|mp|ip)\b/i, // HP / MP / IP (max, bonus, value, attribute, min)
	/^system\.benefits\.martials\b/i, // martial proficiency booleans (class pool)
	/\bmartials?\.(melee|ranged|armor|shields)\b/i, // any martial-proficiency key
	/^system\.benefits\.rituals\b/i, // ritual access (class pool)
	/\britual/i, // any ritual-access key
	/\bproject/i, // Projects
];
const isPoolKey = (key) => typeof key === 'string' && POOL_BLOCK.some((re) => re.test(key));
const isGuiseItem = (item) => item?.type === 'classFeature' && item?.system?.featureType === FEATURE_TYPE;

/** Split a changes array into {kept, stripped} by the innate-pool block list. */
function filterChanges(changes) {
	const kept = [];
	const stripped = [];
	for (const c of changes ?? []) (isPoolKey(c?.key) ? stripped : kept).push(c);
	return { kept, stripped };
}
function logStripped(where, stripped) {
	if (stripped.length) {
		console.debug(`[rippers-guise] ${where}: stripped ${stripped.length} innate-pool change(s) a guise may not apply:`, stripped.map((c) => c.key));
	}
}

/** Build the GuiseDataModel once Project FU's base classes exist (at 'setup'). */
function defineGuiseModel() {
	const { RollableClassFeatureDataModel } = globalThis.projectfu ?? {};
	if (!RollableClassFeatureDataModel) {
		throw new Error('[rippers-guise] Project FU (globalThis.projectfu.RollableClassFeatureDataModel) not found — is the projectfu system active?');
	}

	return class GuiseDataModel extends RollableClassFeatureDataModel {
		static defineSchema() {
			const { StringField, HTMLField } = foundry.data.fields;
			return {
				identity: new StringField({ initial: '' }),   // the persona's name behind the mask
				role: new StringField({ initial: '' }),        // one-line role/cover
				notes: new HTMLField({ initial: '' }),          // what the mask is / how it reads
			};
		}

		// The edit sheet is ours; preview/expand fall back to Project FU's basic templates
		// (ClassFeatureDataModel provides those defaults), so we ship only one .hbs.
		static get template() {
			return `modules/${MODULE_ID}/templates/guise-sheet.hbs`;
		}

		static get translation() {
			return 'RIPPERS.Guise.Feature';
		}

		/** Passed to the sheet templates: is THIS guise the actor's active one? */
		static async getAdditionalData(model) {
			const activeId = model.actor?.getFlag(MODULE_ID, FLAG) ?? null;
			return { active: !!model.item && model.item.id === activeId };
		}

		/**
		 * Project FU applies an item's embedded effects to the actor only when this
		 * returns true (actor effect pipeline). Gate on "am I the active guise?".
		 */
		transferEffects() {
			const activeId = this.actor?.getFlag(MODULE_ID, FLAG) ?? null;
			return !!this.item && this.item.id === activeId && (this.item.isEmbedded ?? false);
		}

		/**
		 * Icon click on the character sheet = BIND / DISMISS. Binding this guise makes it
		 * the one active guise (dismissing any other); clicking the active guise dismisses it.
		 * Exactly one guise is active at a time — the arcanum swap, on a module flag.
		 * @param {GuiseDataModel} model
		 * @param {Item} item
		 */
		static async roll(model, item) {
			const actor = item?.actor;
			if (!actor) return;
			const current = actor.getFlag(MODULE_ID, FLAG) ?? null;
			const isActive = current === item.id;
			const newId = isActive ? null : item.id;
			await actor.setFlag(MODULE_ID, FLAG, newId);

			const verb = isActive ? 'dismisses' : 'binds';
			const who = model?.identity ? ` — <em>${foundry.utils.escapeHTML(model.identity)}</em>` : '';
			await ChatMessage.create({
				speaker: ChatMessage.implementation.getSpeaker({ actor }),
				content: `<div class="rippers-guise-card"><strong>${foundry.utils.escapeHTML(actor.name)}</strong> ${verb} the guise <strong>${foundry.utils.escapeHTML(item.name)}</strong>${who}.</div>`,
			});
		}
	};
}

/** Public helpers so a macro or another module can drive the swap. */
function setActiveGuise(actor, itemId) {
	if (!actor) return Promise.resolve();
	return actor.setFlag(MODULE_ID, FLAG, itemId ?? null);
}
function getActiveGuise(actor) {
	return actor?.getFlag(MODULE_ID, FLAG) ?? null;
}
function clearActiveGuise(actor) {
	return setActiveGuise(actor, null);
}

// ---- innate-pool guard hooks (document layer) ------------------------------------------
// A standalone ActiveEffect created/edited on a guise item.
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
// A guise item created (e.g. dropped from a compendium onto an actor) or updated: clean
// every embedded effect's changes.
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

/** One-shot cleanup for guises that were saved before this guard existed. */
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
	if (total) console.debug(`[rippers-guise] sanitizeActorGuises(${actor.name}): stripped ${total} innate-pool change(s).`);
	return total;
}

Hooks.once('setup', () => {
	const registry = CONFIG.FU?.classFeatureRegistry ?? globalThis.projectfu?.ClassFeatureRegistry;
	if (!registry?.register) {
		console.error('[rippers-guise] CONFIG.FU.classFeatureRegistry not available — the projectfu system must be active. Guise not registered.');
		return;
	}
	try {
		const GuiseDataModel = defineGuiseModel();
		CONFIG.FU.classFeatures ??= {};
		CONFIG.FU.classFeatures.guise = registry.register(MODULE_ID, 'guise', GuiseDataModel);
		console.log(`[rippers-guise] registered classFeature "${MODULE_ID}.guise" (Arcanum pattern; active id in actor.flags.${MODULE_ID}.${FLAG}).`);
	} catch (err) {
		console.error('[rippers-guise] failed to register the guise classFeature:', err);
	}

	// Preload our one edit-sheet template.
	const loader = foundry.applications?.handlebars?.loadTemplates ?? loadTemplates;
	loader([`modules/${MODULE_ID}/templates/guise-sheet.hbs`]);
});

Hooks.once('ready', () => {
	const mod = game.modules.get(MODULE_ID);
	if (mod) mod.api = { setActiveGuise, getActiveGuise, clearActiveGuise, sanitizeActorGuises, isPoolKey, POOL_BLOCK, FLAG };
});

// Test-only exports (Foundry ignores these on an esmodule entry point).
export { isPoolKey, filterChanges, POOL_BLOCK };
