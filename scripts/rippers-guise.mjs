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
	if (mod) mod.api = { setActiveGuise, getActiveGuise, clearActiveGuise, FLAG };
});
