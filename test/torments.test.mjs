// TORMENTS — headless coverage of the canonical data + the non-destructive resolver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TORMENTS, resolveTorment } from '../scripts/torments.mjs';

test('TORMENTS: the canonical eight, each with exactly three questions', () => {
	assert.equal(TORMENTS.length, 8);
	const keys = TORMENTS.map((t) => t.key);
	assert.deepEqual(keys, ['amnesia', 'betrayal', 'death', 'want', 'frustration', 'loss', 'revelation', 'solitude']);
	for (const t of TORMENTS) {
		assert.equal(t.questions.length, 3, `${t.key} has three questions`);
		assert.ok(t.label && t.description, `${t.key} has label + description`);
		for (const q of t.questions) assert.ok(q.trim().length > 0);
	}
});

test('TORMENTS: the four ratified fills are present verbatim (6 Sep 2026)', () => {
	const q = (k) => TORMENTS.find((t) => t.key === k).questions;
	assert.ok(q('death').includes('What here has killed before?'));
	assert.ok(q('frustration').includes('What do they have that I don’t?'));
	assert.ok(q('loss').includes('Who here is in the most danger?'));
	assert.ok(q('solitude').includes('What do they want from me?'));
});

test('resolveTorment: matches a canonical key', () => {
	const r = resolveTorment('amnesia');
	assert.equal(r.key, 'amnesia'); assert.equal(r.custom, false); assert.equal(r.questions.length, 3);
});

test('resolveTorment: matches a canonical label case-insensitively (existing typed data)', () => {
	for (const s of ['Betrayal', 'BETRAYAL', '  betrayal  ']) {
		const r = resolveTorment(s);
		assert.equal(r.key, 'betrayal', `"${s}" maps to betrayal`);
		assert.equal(r.custom, false);
	}
});

test('resolveTorment: PRESERVES unmatched free text verbatim (no data loss, no invented questions)', () => {
	const r = resolveTorment('The Whispering Debt');
	assert.equal(r.key, null);
	assert.equal(r.custom, true);
	assert.equal(r.label, 'The Whispering Debt');   // exact original text kept
	assert.deepEqual(r.questions, []);              // never fabricated
});

test('resolveTorment: empty / unset → null (drives the ⚠ warning)', () => {
	assert.equal(resolveTorment(''), null);
	assert.equal(resolveTorment('   '), null);
	assert.equal(resolveTorment(undefined), null);
	assert.equal(resolveTorment(null), null);
});
