// GUISE TRADING — THE VAULT (Austin 5 Sep: player-driven, no GM gate; PHIAL-TRADE-SPEC + ADDENDUM).
// Headless coverage of the pure gates + the consign/draw move semantics against document stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.Hooks = { on() {}, once() {} };
globalThis.CONFIG = { FU: {} };
globalThis.game = { modules: { get: () => null }, user: { isGM: false } };
globalThis.foundry = { utils: { hasProperty: () => false, escapeHTML: (s) => String(s ?? ''), mergeObject: (a, b) => ({ ...a, ...b }), deepClone: (o) => JSON.parse(JSON.stringify(o ?? null)), randomID: () => 'idFIXEDforTEST1' }, data: { fields: {} } };
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.fromUuid = async () => null;
const mod = await import('../scripts/rippers-guise.mjs');
const { tradePayload, drawDecision, vaultDraw, handOffDecision, handOffRefusalText, sheetHandOffGuise } = mod;

const MOD = 'rippers-guise';
const FEATURE_TYPE = 'rippers-guise.guise';
function guiseItem(id, { innate = false, flags = {}, used = false } = {}) {
	let deleted = false;
	const f = { [MOD]: { ...(innate ? { isInnate: true } : {}), ...flags } };
	return {
		id, name: `G${id}`, type: 'classFeature',
		system: { featureType: FEATURE_TYPE, data: { mode: innate ? 'innate' : 'worn', lent: { hp: 7 } } },
		flags: f,
		getFlag: (m, k) => f[m]?.[k],
		toObject: () => ({ type: 'classFeature', name: `G${id}`, system: { featureType: FEATURE_TYPE, data: { mode: innate ? 'innate' : 'worn', lent: { hp: 7 } } }, flags: JSON.parse(JSON.stringify(f)) }),
		delete: async () => { deleted = true; }, get _deleted() { return deleted; },
	};
}

test('tradePayload: strips _id, addresses the recipient, carries the Q3 used marker, keeps system.data whole', () => {
	const item = guiseItem('g1');
	item.toObject = () => ({ _id: 'g1', type: 'classFeature', system: { data: { lent: { hp: 7 } } }, flags: {} });
	const src = { id: 'A', name: 'Vin' }; const rec = { id: 'B', name: 'Morrax' };
	const p = tradePayload(item, src, rec, ['g1', 'other']);
	assert.equal(p._id, undefined);
	assert.equal(p.flags[MOD].consignedTo, 'B');
	assert.equal(p.flags[MOD].consignedToName, 'Morrax');
	assert.equal(p.flags[MOD].consignedBy, 'A');
	assert.equal(p.flags[MOD].usedThisSceneAtTrade, true);         // was in the source used-list
	assert.equal(p.system.data.lent.hp, 7);                        // lent CURRENT values ride, no refill
	// not used this scene → marker false; no recipient (direct leg) → unaddressed
	const p2 = tradePayload(item, src, null, []);
	assert.equal(p2.flags[MOD].usedThisSceneAtTrade, false);
	assert.equal(p2.flags[MOD].consignedTo, '');
});

test('drawDecision: addressee-only for players, GM may always, target must be writable', () => {
	const toB = guiseItem('v1', { flags: { consignedTo: 'B' } });
	const unaddressed = guiseItem('v2');
	const bOwned = { id: 'B', isOwner: true }; const bUnowned = { id: 'B', isOwner: false };
	const cOwned = { id: 'C', isOwner: true };
	assert.deepEqual(drawDecision(null, bOwned, false), { ok: false, reason: 'no-guise' });
	assert.deepEqual(drawDecision(toB, null, false), { ok: false, reason: 'no-recipient' });
	assert.deepEqual(drawDecision(toB, cOwned, false), { ok: false, reason: 'not-addressee' }); // consigned elsewhere
	assert.deepEqual(drawDecision(toB, cOwned, true), { ok: true, reason: 'ok' });              // GM may redirect
	assert.deepEqual(drawDecision(toB, bUnowned, false), { ok: false, reason: 'no-write' });    // right actor, no write
	assert.deepEqual(drawDecision(toB, bOwned, false), { ok: true, reason: 'ok' });             // the addressee
	assert.deepEqual(drawDecision(unaddressed, bOwned, false), { ok: true, reason: 'ok' });     // unaddressed: any writable
});

test('handOffRefusalText: every refusal reason has player wording, unknown falls back', () => {
	for (const r of ['no-guise', 'innate-untradable', 'no-recipient', 'same-actor', 'no-vault']) {
		assert.equal(typeof handOffRefusalText(r), 'string');
		assert.ok(handOffRefusalText(r).length > 5, r);
	}
	assert.equal(handOffRefusalText('???'), 'Hand-off refused.');
});

function vaultStub(items) {
	return { id: 'VAULT', name: 'The Guise Vault',
		getFlag: (m, k) => (k === 'isVaultActor' ? true : undefined),
		isOwner: true,
		items: { get: (id) => items.find((i) => i.id === id) ?? null, filter: (fn) => items.filter(fn) },
		createEmbeddedDocuments: async (_t, d) => { const created = d.map((o, i) => ({ ...o, id: `nv${i}` })); items.push(...created); return created; } };
}

test('vaultDraw: create-then-delete move, address stripped on arrival, rollback when the vault delete fails', async () => {
	const vItem = guiseItem('v1', { flags: { consignedTo: 'B', consignedToName: 'Morrax', consignedBy: 'A', usedThisSceneAtTrade: true } });
	const vault = vaultStub([vItem]);
	globalThis.game = { user: { isGM: false }, actors: { find: (fn) => [vault].find(fn), get: () => null, filter: () => [] } };
	const created = []; const removed = [];
	const dest = { id: 'B', isOwner: true,
		createEmbeddedDocuments: async (_t, d) => { created.push(...d); return d.map((o, i) => ({ ...o, id: `n${i}` })); },
		deleteEmbeddedDocuments: async (_t, ids) => removed.push(...ids) };
	const r = await mod.vaultDraw(dest, 'v1');
	assert.equal(r.ok, true); assert.equal(r.reason, 'drawn');
	assert.equal(created.length, 1);
	assert.equal(created[0].flags[MOD].consignedTo, undefined);          // address stripped
	assert.equal(created[0].flags[MOD].usedThisSceneAtTrade, true);      // Q3 marker kept (informational)
	assert.equal(vItem._deleted, true);
	// delete failure → rollback: the created copy is removed and the draw refused
	const vItem2 = guiseItem('v2', { flags: { consignedTo: 'B' } });
	vItem2.delete = async () => { throw new Error('locked'); };
	globalThis.game = { user: { isGM: false }, actors: { find: (fn) => [vaultStub([vItem2])].find(fn), get: () => null, filter: () => [] } };
	const r2 = await mod.vaultDraw(dest, 'v2');
	assert.equal(r2.ok, false); assert.equal(r2.reason, 'vault-delete-failed');
	assert.deepEqual(removed, ['n0']);                                   // rolled back — never doubled
	globalThis.game = { modules: { get: () => null }, user: { isGM: false } };
});

test('sheetHandOffGuise: cross-owner with a vault CONSIGNS (item moves to the vault, addressed); source deleted only after create', async () => {
	const item = guiseItem('g1');
	const src = { id: 'A', name: 'Vin', getFlag: () => null, items: { get: (id) => (id === 'g1' ? item : null) } };
	const vaultItems = [];
	const vault = vaultStub(vaultItems);
	globalThis.game = { user: { isGM: false }, actors: { find: (fn) => [vault].find(fn), get: () => null, filter: () => [] } };
	const rec = { id: 'B', name: 'Morrax', isOwner: false, createEmbeddedDocuments: async () => { throw new Error('must not write the recipient'); } };
	const r = await sheetHandOffGuise(src, 'g1', rec);
	assert.equal(r.ok, true); assert.equal(r.reason, 'consigned');
	assert.equal(vaultItems.length, 1);
	assert.equal(vaultItems[0].flags[MOD].consignedTo, 'B');
	assert.equal(item._deleted, true);
	// vault write failure → source NOT deleted (never lost)
	const item2 = guiseItem('g2');
	const src2 = { id: 'A', name: 'Vin', getFlag: () => null, items: { get: (id) => (id === 'g2' ? item2 : null) } };
	const badVault = vaultStub([]); badVault.createEmbeddedDocuments = async () => { throw new Error('nope'); };
	globalThis.game = { user: { isGM: false }, actors: { find: (fn) => [badVault].find(fn), get: () => null, filter: () => [] } };
	const r2 = await sheetHandOffGuise(src2, 'g2', rec);
	assert.equal(r2.ok, false); assert.equal(r2.reason, 'vault-write-failed');
	assert.equal(item2._deleted, false);
	globalThis.game = { modules: { get: () => null }, user: { isGM: false } };
});
