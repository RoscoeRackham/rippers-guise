/**
 * §10 (v0.7.9) — headless tests for the LENT VITALS layer + IP SATCHEL (RULE-guise-lent-vitals.md,
 * RULE-guise-derived-stats.md §2): the pure arithmetic (spend lent-first, rest refill, IP restock/
 * spend, normalisation) and the thin imperative seams (applyResourceCost, restRefillActorGuises)
 * with compact Foundry stubs. The FU REST_EVENT subscription is a one-liner at 'ready' (integration).
 *
 * Globals shimmed BEFORE import (the module registers hooks + reads globals at import time).
 * Run: `npm test` (node --test test/*.test.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.Hooks = { on() {}, once() {} };
globalThis.CONFIG = { FU: {} };
globalThis.game = { modules: { get: () => null }, user: { isGM: false } };
globalThis.foundry = { utils: { hasProperty: () => false, escapeHTML: (s) => String(s ?? ''), mergeObject: (a, b) => ({ ...a, ...b }), deepClone: (o) => JSON.parse(JSON.stringify(o ?? null)), randomID: () => 'idFIXEDforTEST1' }, data: { fields: {} } };
globalThis.ui = { notifications: { warn() {}, info() {} } };

const mod = await import('../scripts/rippers-guise.mjs');
const {
	normalizeLentLayer, normalizeIpSatchel, spendLentThenOwn, restRefillLayer, restockIp, spendIp, IP_UNIT_COST,
	guiseVitals, applyResourceCost, restRefillActorGuises,
} = mod;

const FEATURE_TYPE = 'rippers-guise.guise';
const RGID = 'rippers-guise';

// --- pure: normalisation ------------------------------------------------------
test('normalizeLentLayer / normalizeIpSatchel: ints ≥0, current/stock clamped to max/capacity', () => {
	assert.deepEqual(normalizeLentLayer({ current: 9, maximum: 4 }), { current: 4, maximum: 4 });
	assert.deepEqual(normalizeLentLayer({ current: -3, maximum: 6 }), { current: 0, maximum: 6 });
	assert.deepEqual(normalizeLentLayer({ current: 2.9, maximum: 5.9 }), { current: 2, maximum: 5 });
	assert.deepEqual(normalizeLentLayer(undefined), { current: 0, maximum: 0 });
	assert.deepEqual(normalizeIpSatchel({ stock: 12, capacity: 8 }), { stock: 8, capacity: 8 });
	assert.deepEqual(normalizeIpSatchel({ stock: -1, capacity: 3 }), { stock: 0, capacity: 3 });
});

// --- pure: spend lent-first ---------------------------------------------------
test('spendLentThenOwn: the lent layer takes it first, the remainder comes off the own pool', () => {
	// mask lends 4/6; take 3 → all from the lent layer, own untouched
	assert.deepEqual(spendLentThenOwn(3, 4, 40), { fromLent: 3, fromOwn: 0, newLent: 1, newOwn: 40 });
	// take 6 with only 4 lent → 4 lent + 2 own
	assert.deepEqual(spendLentThenOwn(6, 4, 40), { fromLent: 4, fromOwn: 2, newLent: 0, newOwn: 38 });
	// no layer → straight off own
	assert.deepEqual(spendLentThenOwn(5, 0, 40), { fromLent: 0, fromOwn: 5, newLent: 0, newOwn: 35 });
	// overkill: own is NOT clamped at 0 (Crisis/defeat read the wearer's own numbers)
	assert.deepEqual(spendLentThenOwn(50, 4, 40), { fromLent: 4, fromOwn: 46, newLent: 0, newOwn: -6 });
	// zero/blank cost is a no-op
	assert.deepEqual(spendLentThenOwn(0, 4, 40), { fromLent: 0, fromOwn: 0, newLent: 4, newOwn: 40 });
});

// --- pure: rest refill + IP economy ------------------------------------------
test('restRefillLayer refills to maximum (a rest, not healing)', () => {
	assert.deepEqual(restRefillLayer({ current: 1, maximum: 6 }), { current: 6, maximum: 6 });
	assert.deepEqual(restRefillLayer({ current: 0, maximum: 0 }), { current: 0, maximum: 0 });
});
test('restockIp buys up to remaining capacity at 10z/pt; spendIp caps at stock', () => {
	assert.equal(IP_UNIT_COST, 10);
	assert.deepEqual(restockIp({ stock: 2, capacity: 8 }, 4), { stock: 6, capacity: 8, bought: 4, costZenit: 40 });
	// over-buy is capped at the room left (8-2=6), billed for 6 only
	assert.deepEqual(restockIp({ stock: 2, capacity: 8 }, 100), { stock: 8, capacity: 8, bought: 6, costZenit: 60 });
	assert.deepEqual(spendIp({ stock: 5, capacity: 8 }, 3), { stock: 2, capacity: 8, spent: 3 });
	assert.deepEqual(spendIp({ stock: 5, capacity: 8 }, 99), { stock: 0, capacity: 8, spent: 5 });
});

// --- compact Foundry stubs for the imperative seams ---------------------------
function foundrySet(obj, path, value) {
	const parts = path.split('.'); let o = obj;
	for (let i = 0; i < parts.length - 1; i++) o = (o[parts[i]] ??= {});
	o[parts[parts.length - 1]] = value;
}
function guiseItem(id, data = {}) {
	const doc = {
		id, type: 'classFeature',
		system: { featureType: FEATURE_TYPE, data: JSON.parse(JSON.stringify(data)) },
		update: async (patch) => { for (const [k, v] of Object.entries(patch)) foundrySet(doc, k, v); },
	};
	return doc;
}
function actorWith(guises, { active = null, hp = 40, mp = 20 } = {}) {
	const flags = { [RGID]: { activeGuise: active } };
	const docs = [...guises];
	const items = { get: (id) => docs.find((d) => d.id === id) ?? null, filter: (fn) => docs.filter(fn), find: (fn) => docs.find(fn) ?? null };
	const actor = {
		id: 'a1', system: { resources: { hp: { value: hp }, mp: { value: mp } } }, items,
		getFlag: (m, k) => (m === RGID ? flags[RGID][k] : undefined),
		update: async (patch) => { for (const [k, v] of Object.entries(patch)) foundrySet(actor, k, v); },
	};
	return actor;
}

test('guiseVitals reads the normalized layers + satchel off the guise Item', () => {
	const g = guiseItem('g1', { lentHp: { current: 4, maximum: 6 }, lentMp: { current: 9, maximum: 4 }, ipSatchel: { stock: 3, capacity: 8 } });
	assert.deepEqual(guiseVitals(g), { hp: { current: 4, maximum: 6 }, mp: { current: 4, maximum: 4 }, ip: { stock: 3, capacity: 8 } });
	assert.deepEqual(guiseVitals(guiseItem('g0')), { hp: { current: 0, maximum: 0 }, mp: { current: 0, maximum: 0 }, ip: { stock: 0, capacity: 0 } });
});

test('applyResourceCost: the WORN guise lends first, then the own pool; both are written', async () => {
	const g = guiseItem('g1', { lentHp: { current: 4, maximum: 6 } });
	const actor = actorWith([g], { active: 'g1', hp: 40 });
	// take 6: 4 off the lent layer, 2 off own HP
	const r = await applyResourceCost(actor, 'hp', 6);
	assert.deepEqual(r, { fromLent: 4, fromOwn: 2 });
	assert.equal(g.system.data.lentHp.current, 0);      // layer emptied
	assert.equal(actor.system.resources.hp.value, 38);  // own pool took the remainder
});

test('applyResourceCost: no worn guise → straight off the own pool (no lent layer to spend)', async () => {
	const actor = actorWith([], { active: null, mp: 20 });
	const r = await applyResourceCost(actor, 'mp', 5);
	assert.deepEqual(r, { fromLent: 0, fromOwn: 5 });
	assert.equal(actor.system.resources.mp.value, 15);
});

test('applyResourceCost: a fully-covered cost never touches the own pool', async () => {
	const g = guiseItem('g1', { lentHp: { current: 10, maximum: 10 } });
	const actor = actorWith([g], { active: 'g1', hp: 40 });
	const r = await applyResourceCost(actor, 'hp', 7);
	assert.deepEqual(r, { fromLent: 7, fromOwn: 0 });
	assert.equal(g.system.data.lentHp.current, 3);
	assert.equal(actor.system.resources.hp.value, 40); // untouched — Crisis reads the own maximum, unmoved
});

test('restRefillActorGuises: every LIVE guise refills lent HP/MP to max; IP satchel is NOT refilled', async () => {
	const worn = guiseItem('worn', { lentHp: { current: 1, maximum: 6 }, lentMp: { current: 0, maximum: 4 }, ipSatchel: { stock: 1, capacity: 8 } });
	const inHand = guiseItem('hand', { lentHp: { current: 2, maximum: 5 }, lentMp: { current: 5, maximum: 5 } });
	const noLayer = guiseItem('bare', {}); // 0/0 → skipped
	const actor = actorWith([worn, inHand, noLayer], { active: 'worn' });
	const n = await restRefillActorGuises(actor);
	assert.equal(n, 2);                                    // worn + inHand refilled; bare skipped
	assert.equal(worn.system.data.lentHp.current, 6);
	assert.equal(worn.system.data.lentMp.current, 4);
	assert.equal(inHand.system.data.lentHp.current, 5);
	assert.equal(worn.system.data.ipSatchel.current ?? worn.system.data.ipSatchel.stock, 1); // IP untouched by rest
});

// ── P3: lent-HP auto-intercept on the damage pipeline (POST_CALCULATE result split) ──
const { lentHpAbsorbPlan, onDamagePostLentSplit, onCalculateExpenseLentMp, sheetAdjustResource } = mod;

test('lentHpAbsorbPlan: the layer absorbs first, the remainder lands on own HP; debits exactly once', () => {
	assert.deepEqual(lentHpAbsorbPlan(6, 4), { absorb: 4, remainder: 2, newLent: 0 });   // partial: 4 lent + 2 own
	assert.deepEqual(lentHpAbsorbPlan(3, 4), { absorb: 3, remainder: 0, newLent: 1 });   // fully absorbed, 0 own
	assert.deepEqual(lentHpAbsorbPlan(5, 0), { absorb: 0, remainder: 5, newLent: 0 });   // no layer → all own
	assert.deepEqual(lentHpAbsorbPlan(0, 4), { absorb: 0, remainder: 0, newLent: 4 });   // no damage → no debit
});

test('onDamagePostLentSplit: worn guise lent-HP absorbs from context.result ONCE; remainder → own HP', async () => {
	const g = guiseItem('g1', { lentHp: { current: 4, maximum: 6 } });
	const actor = actorWith([g], { active: 'g1' });
	const ctx = { actor, result: 6 };
	onDamagePostLentSplit(ctx);
	assert.equal(ctx.result, 2);                          // FU then applies only 2 to own HP (line 506)
	await new Promise((r) => setTimeout(r, 0));           // let the async layer write land
	assert.equal(g.system.data.lentHp.current, 0);       // layer debited by 4, exactly once
});

test('onDamagePostLentSplit: no worn guise / empty layer / zero damage → context.result untouched', async () => {
	const g = guiseItem('g1', { lentHp: { current: 0, maximum: 6 } });
	const actorEmpty = actorWith([g], { active: 'g1' });
	const c1 = { actor: actorEmpty, result: 5 }; onDamagePostLentSplit(c1);
	assert.equal(c1.result, 5);                           // empty layer → no change
	const actorUnworn = actorWith([guiseItem('g2', { lentHp: { current: 4, maximum: 6 } })], { active: null });
	const c2 = { actor: actorUnworn, result: 5 }; onDamagePostLentSplit(c2);
	assert.equal(c2.result, 5);                           // no worn guise → no change
});

test('P3 composition: Crew/Revenant (PRE) then lent split (POST) — one event, each applied once', async () => {
	// Simulate the pipeline the way FU runs it: PRE modifiers baked into result, THEN the POST lent split.
	// base 40, target immune to dark but the attacker is a Revenant (affinity→1), Crew single-target (×0.5)
	let result = 40;
	const modifiers = new Map([['affinity', 1], ['crew-oneforall', 0.5]]); // as onDamagePreDispatch would set
	for (const v of modifiers.values()) result *= v; result = Math.floor(result); // = 20 (each once)
	const g = guiseItem('g1', { lentHp: { current: 8, maximum: 8 } });
	const actor = actorWith([g], { active: 'g1' });
	const ctx = { actor, result };
	onDamagePostLentSplit(ctx);
	assert.equal(ctx.result, 12);                         // 20 − 8 lent = 12 to own HP
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(g.system.data.lentHp.current, 0);        // 8 absorbed, once; no double-count anywhere
});

test('onDamagePostLentSplit: MP-loss damage (mind-point-loss trait) is NOT absorbed by the lent-HP layer', async () => {
	const g = guiseItem('g1', { lentHp: { current: 4, maximum: 6 } });
	const actor = actorWith([g], { active: 'g1' });
	const ctx = { actor, result: 6, traits: new Set(['mind-point-loss']) };
	onDamagePostLentSplit(ctx);
	assert.equal(ctx.result, 6);                          // untouched — this is MP damage, not HP
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(g.system.data.lentHp.current, 4);       // layer not debited
});

// ── MP-LAYER-ROUTING: lent-MP spent-before-own (expense hook + sheet stepper) ──
test('onCalculateExpenseLentMp: an MP cost draws the worn guise lent-MP layer first; FU debits the remainder', async () => {
	const g = guiseItem('g1', { lentMp: { current: 4, maximum: 6 } });
	const actor = actorWith([g], { active: 'g1' });
	const expense = { resource: 'mp', amount: 6 };
	onCalculateExpenseLentMp({ expense, source: { actor } });
	assert.equal(expense.amount, 2);                      // 4 off the lent layer, FU debits 2 from own MP
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(g.system.data.lentMp.current, 0);       // lent-MP debited once
});

test('onCalculateExpenseLentMp: non-MP expense, no worn guise, or empty layer → expense.amount untouched', async () => {
	const g = guiseItem('g1', { lentMp: { current: 4, maximum: 6 } });
	const actor = actorWith([g], { active: 'g1' });
	const hpCost = { resource: 'hp', amount: 5 };         // an HP cost is not MP → not lent-absorbed here
	onCalculateExpenseLentMp({ expense: hpCost, source: { actor } });
	assert.equal(hpCost.amount, 5);
	const empty = actorWith([guiseItem('g2', { lentMp: { current: 0, maximum: 6 } })], { active: 'g2' });
	const c2 = { resource: 'mp', amount: 5 }; onCalculateExpenseLentMp({ expense: c2, source: { actor: empty } });
	assert.equal(c2.amount, 5);                           // empty layer → no change
	const unworn = actorWith([guiseItem('g3', { lentMp: { current: 4, maximum: 6 } })], { active: null });
	const c3 = { resource: 'mp', amount: 5 }; onCalculateExpenseLentMp({ expense: c3, source: { actor: unworn } });
	assert.equal(c3.amount, 5);                           // no worn guise → no change
});

test('sheetAdjustResource: the MP stepper SPEND draws lent-MP first; a heal does not touch the layer', async () => {
	const g = guiseItem('g1', { lentMp: { current: 4, maximum: 6 } });
	const actor = actorWith([g], { active: 'g1', mp: 10 });
	await sheetAdjustResource(actor, 'mp', -6);           // spend 6 → 4 lent + 2 own
	assert.equal(g.system.data.lentMp.current, 0);
	assert.equal(actor.system.resources.mp.value, 8);    // 10 - 2 own
	// a heal (+2) is recovery — never refills the lent layer; in node the FU import fails → clamped own +2
	await sheetAdjustResource(actor, 'mp', 2);
	assert.equal(g.system.data.lentMp.current, 0);       // layer untouched by a heal
	assert.equal(actor.system.resources.mp.value, 10);   // own refilled to 10 (fallback clamp)
});

test('sheetAdjustResource: the manual HP stepper SPEND draws lent-HP first (symmetry with MP); heal does not', async () => {
	const g = guiseItem('g1', { lentHp: { current: 3, maximum: 6 } });
	const actor = actorWith([g], { active: 'g1', hp: 20 });
	await sheetAdjustResource(actor, 'hp', -5);           // spend 5 → 3 lent + 2 own
	assert.equal(g.system.data.lentHp.current, 0);
	assert.equal(actor.system.resources.hp.value, 18);   // 20 - 2 own
	await sheetAdjustResource(actor, 'hp', 4);            // heal → never touches the lent layer
	assert.equal(g.system.data.lentHp.current, 0);
});
