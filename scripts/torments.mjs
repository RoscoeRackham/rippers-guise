/*
 * TORMENTS — the canonical eight, character-level (ride through every mask; no Guise covers a Torment).
 *
 * SOURCED, NOT AUTHORED: every label, description and question below is transcribed VERBATIM from
 * lodge-docs/COMPENDIUM-player-reference.md § "Torments" (the 1d8 table). The four third-questions that
 * were blanks — DEATH, FRUSTRATION, LOSS, SOLITUDE — are the owner-approved fills RATIFIED 6 September
 * 2026 (see lodge-docs/TORMENTS-audit.md §2), consistent across COMPENDIUM-player-reference.md,
 * UNMASKED-players-handbook.md and the player-reference journal pack. Nothing here is invented or
 * paraphrased; scope clarifications in Betrayal and Revelation are part of the canonical question text.
 *
 * This module is PURE (no Foundry globals) so a bare `node --test` import is inert.
 */

/** The canonical eight, in 1d8 order. keys are stable identifiers (NOT display text). */
export const TORMENTS = Object.freeze([
	{ key: 'amnesia', label: 'Amnesia',
		description: 'You recall very little beyond your name and abilities. Every new memory carries relief… and trepidation',
		questions: ['What happy or painful memory does this moment bring back?', 'Is there anyone here who remembers me, though I don’t remember them?', 'Are they in control of their own actions?'] },
	{ key: 'betrayal', label: 'Betrayal',
		description: 'When someone needed you most, you ran. The blame lies entirely on your shoulders',
		questions: ['Are they telling the truth? (reads deception, never error — the sincerely wrong ring true)', 'What is the best way out of here?', 'Who is the weakest target here?'] },
	{ key: 'death', label: 'Death',
		description: 'Your hands are stained with blood, and you can never make your peace with it',
		questions: ['What is the best way to hurt them?', 'What would make them lose control?', 'What here has killed before?'] },
	{ key: 'want', label: 'Want',
		description: 'You have been poor in the way that never leaves you',
		questions: ['What is this worth, and to whom?', 'What does it cost to belong here?', 'Who here has never gone without?'] },
	{ key: 'frustration', label: 'Frustration',
		description: 'Ambition and the fear of failure and judgment have turned you bitter and envious',
		questions: ['What do they want the most?', 'Who do they serve?', 'What do they have that I don’t?'] },
	{ key: 'loss', label: 'Loss',
		description: 'You lost the people dearest to you, because you could not protect them. The guilt is a shackle',
		questions: ['Who here is in the most danger?', 'What are we overlooking here?', 'What is most dangerous here?'] },
	{ key: 'revelation', label: 'Revelation',
		description: 'You glimpsed the true complexity of the world, and it shattered your values. You are painfully aware of your own ignorance',
		questions: ['Where can I find that information? (a source — a place, a person, a book — never the answer itself)', 'What are their true feelings?', 'What is strange about this place?'] },
	{ key: 'solitude', label: 'Solitude',
		description: 'A lifetime of betrayal and manipulation has convinced you nobody finds you worthy of loyalty. A tool, not a person',
		questions: ['What do they want from me?', 'How can I get them to do what I want?', 'What is the best place to hide?'] },
]);

const BY_KEY = new Map(TORMENTS.map((t) => [t.key, t]));
const BY_LABEL = new Map(TORMENTS.map((t) => [t.label.toLowerCase(), t]));

/**
 * Resolve a stored torment flag (which may be a canonical key, a canonical label in any case, or —
 * for pre-existing world data — free text) to a display shape. NON-DESTRUCTIVE migration by
 * resolution: a stored value that maps cleanly to one of the eight (by key or label, case-insensitive)
 * reads as that torment with its questions; a value that does NOT map is PRESERVED verbatim as a
 * `custom` entry (no questions) so nothing authored on a live actor is ever lost. Empty/unset → null.
 */
export function resolveTorment(stored) {
	const raw = String(stored ?? '').trim();
	if (!raw) return null;
	const hit = BY_KEY.get(raw.toLowerCase()) ?? BY_LABEL.get(raw.toLowerCase());
	if (hit) return { key: hit.key, label: hit.label, description: hit.description, questions: [...hit.questions], custom: false };
	// unmatched free text — preserve exactly as authored; no invented questions
	return { key: null, label: raw, description: '', questions: [], custom: true };
}
