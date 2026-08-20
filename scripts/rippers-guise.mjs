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
 * FDN-7 (v0.3.0) adds a player-facing GUISES PANEL in PFU's character-sheet Features tab: a
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
	const owned = [...skillIds, ...equipIds];
	await actor.update({
		[`flags.${MODULE_ID}.${FLAG}`]: item.id,
		[`flags.${MODULE_ID}.preBindEquip`]: preBindEquip,
		[`flags.${MODULE_ID}.owned.${item.id}`]: owned,
		...equipUpdate,
	});
	// … THEN suppress the character's own innate skills, so exactly one 30-level set is live (Stage B).
	const dormant = await suppressInnateSkills(actor);
	// Affinities: the guise's embedded "Guise affinities" effect now transfers (transferEffects()=true).
	console.debug(`[rippers-guise] bound "${item.name}": ${skillIds.length} guise skill(s), ${equipIds.length} equipment; ${dormant} innate skill(s) dormant.`);
}

async function _dismissCore(actor, item, { silent = false } = {}) {
	const owned = actor.getFlag(MODULE_ID, 'owned')?.[item.id] ?? [];
	const preBindEquip = actor.getFlag(MODULE_ID, 'preBindEquip') ?? {};
	const existing = owned.filter((id) => actor.items.get(id));
	if (existing.length) await actor.deleteEmbeddedDocuments('Item', existing);
	// Wake the innate skill set back up (Stage B) before clearing state.
	await restoreInnateSkills(actor);
	const equipRestore = {};
	for (const slot of ALL_SLOTS) equipRestore[`system.equipped.${slot}`] = preBindEquip[slot] ?? null;
	await actor.update({
		[`flags.${MODULE_ID}.${FLAG}`]: null,
		[`flags.${MODULE_ID}.owned.-=${item.id}`]: null,
		...equipRestore,
	});
	if (!silent) console.debug(`[rippers-guise] dismissed "${item.name}"; innate skills restored.`);
}

async function bindGuise(actor, ref) {
	const item = resolveItem(actor, ref);
	if (!actor || !item) { console.warn('[rippers-guise] bindGuise: no actor/item (was an id string unresolvable?).'); return; }
	if (_guiseBusy.has(actor.id)) { console.debug('[rippers-guise] bind ignored — a guise op is already in flight for this actor.'); return; }
	_guiseBusy.add(actor.id);
	try { return await _bindCore(actor, item); } finally { _guiseBusy.delete(actor.id); }
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
		return await _bindCore(actor, item);
	} finally { _guiseBusy.delete(actor.id); }
}
async function clearActiveGuise(actor) {
	const id = getActiveGuise(actor);
	const item = id && actor.items.get(id);
	if (item) return dismissGuise(actor, item);
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
	const affTxt = (data.affinityModifiers ?? []).map((m) => `${affinityWordOf(m.level)} ${m.type}`).join(' · ');
	const bits = [];
	if (classes.length) bits.push(`${totalSl} SL across ${classes.length} class${classes.length === 1 ? '' : 'es'}`);
	if (affTxt) bits.push(affTxt);
	return bits.join(' — ');
}

function buildGuisePanel(actor) {
	const guises = actor.items.filter(isGuiseItem);
	if (!guises.length) return null;
	const activeId = getActiveGuise(actor);
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
			<button type="button" class="guise-toggle${active ? ' is-active' : ''}" data-guise-id="${g.id}">
				${game.i18n.localize(active ? 'RIPPERS.Guise.Dismiss' : 'RIPPERS.Guise.Bind')}
			</button>
		</div>`;
	}).join('');
	panel.innerHTML = `<header class="items-main-header rippers-guise-header">
			<span class="items-main"><label class="items-label">${game.i18n.localize('RIPPERS.Guise.PanelTitle')}</label></span>
		</header>
		<div class="rippers-guise-list">${rows}</div>`;
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

/** Inject (or refresh) the Guises panel into a freshly-rendered character sheet's Features tab. */
function injectGuisePanel(app) {
	try {
		const actor = app?.actor;
		const root = app?.element;
		if (!actor || !root || actor.type !== 'character') return;
		const tab = root.querySelector('[data-tab="features"]');
		if (!tab) return; // features part not rendered (limited sheet etc.)
		// Idempotent: sweep ANY prior panel anywhere in this sheet before re-injecting, so a stale
		// panel (and its click listeners) can never survive a re-render and stack. The panel + its
		// buttons are freshly created below, so listeners live only on the current DOM.
		root.querySelectorAll('.rippers-guise-panel').forEach((n) => n.remove());
		const panel = buildGuisePanel(actor);
		if (!panel) return;
		const fuHeader = tab.querySelector(':scope > header.items-main-header');
		if (fuHeader) fuHeader.after(panel); else tab.prepend(panel);
	} catch (err) {
		console.error('[rippers-guise] injectGuisePanel failed:', err);
	}
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

			// --- drop targets (class / per-class skill / equipment) -----------------
			html.querySelectorAll('[data-guise-drop]').forEach((zone) => {
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
			html.querySelectorAll('[data-guise-action]').forEach((btn) => {
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
		console.log(`[rippers-guise] registered classFeature "${MODULE_ID}.guise" (v0.2 Stage B — dormancy + authoring UI).`);
	} catch (err) {
		console.error('[rippers-guise] failed to register the guise classFeature:', err);
	}
	const loader = foundry.applications?.handlebars?.loadTemplates ?? loadTemplates;
	loader([`modules/${MODULE_ID}/templates/guise-sheet.hbs`]);
});

Hooks.once('ready', async () => {
	const mod = game.modules.get(MODULE_ID);
	if (mod) mod.api = { bindGuise, dismissGuise, setActiveGuise, getActiveGuise, clearActiveGuise, suppressInnateSkills, restoreInnateSkills, migrateWorldGuises, migrateGuiseItem, sanitizeActorGuises, dedupeActorGuises, dedupeWorldGuises, syncAffinityEffect, isPoolKey, POOL_BLOCK, FLAG };
	// §7 migration — GM only; idempotent (skips guises already at schemaVersion ≥ 2).
	if (game.user?.isGM) {
		try {
			const n = await migrateWorldGuises();
			if (n) console.log(`[rippers-guise] v0.2 migration: updated ${n} guise item(s).`);
		} catch (err) { console.warn('[rippers-guise] v0.2 migration skipped:', err); }
	}
});

// Test-only exports (Foundry ignores these on an esmodule entry point).
export { isPoolKey, filterChanges, POOL_BLOCK, affinityChange, materialiseSkills, resolveItem, isInnateSkill, clampAllocationInputs, AFFINITY_LEVELS, budgetOf, guiseSummary, bindGuise, dismissGuise, setActiveGuise, getActiveGuise };
