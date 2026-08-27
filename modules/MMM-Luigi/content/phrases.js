/* MMM-Luigi — phrase templates
 *
 * Pure strings and selection: no DOM, no MagicMirror globals, no knowledge of
 * where the data came from. Cards hand over template variables; this file
 * decides the wording.
 *
 * Tone rules, applied throughout:
 *   - short lines, one idea each — these are read at a glance, from across a room
 *   - playful and literal, generous with exclamation marks
 *   - third person "Luigi" used sparingly, never in every line
 */
(function (root, factory) {
	const api = factory();
	if (typeof module !== "undefined" && module.exports) {
		module.exports = api;
	} else {
		root.LuigiPhrases = api;
	}
}(typeof self !== "undefined" ? self : this, function () {
	"use strict";

	/**
	 * Fill {placeholders} from a variables object.
	 * Unknown keys are deliberately left intact so tests can spot a phrase that has
	 * drifted away from the variables its card actually supplies.
	 * @param {string} template the phrase template
	 * @param {object} vars template variables
	 * @returns {string} the rendered line
	 */
	function render (template, vars) {
		return String(template).replace(/\{(\w+)\}/g, (match, key) => {
			const has = vars !== null && vars !== undefined
				&& Object.prototype.hasOwnProperty.call(vars, key)
				&& vars[key] !== undefined && vars[key] !== null;
			return has ? String(vars[key]) : match;
		});
	}

	/**
	 * Choose one entry using an injected rng.
	 * @param {Array} variants candidate templates
	 * @param {Function} rng returns a float in [0, 1)
	 * @returns {string} the chosen template
	 */
	function choose (variants, rng) {
		const roll = typeof rng === "function" ? rng() : Math.random();
		const index = Math.min(variants.length - 1, Math.floor(roll * variants.length));
		return variants[Math.max(0, index)];
	}

	/*
	 * Per card, per mood. A card only needs a `default` list; any mood without its
	 * own variants falls back to it, so adding a mood never means writing lines for
	 * every card at once.
	 */
	const LINES = {
		weather: {
			happy: [
				"It's {temp} degrees outside! That's {advice} weather, maybe.",
				"Ooo, {temp} degrees and lovely! Luigi recommends: {advice}."
			],
			concerned: [
				"It's {temp} degrees and wet out there. Take the {advice}!",
				"Uh oh, soggy skies! {temp} degrees. {advice} time."
			],
			default: [
				"It's {temp} degrees outside! {advice} weather, probably.",
				"The outside is {temp} degrees today. Luigi says: {advice}."
			]
		},

		commute: {
			happy: [
				"The road to work looks clear — about {mins}!",
				"Nice! Only {mins} to work today."
			],
			concerned: [
				"Uh oh, cars everywhere. {mins} today!",
				"The road is very full. {mins}. Bring a good song!"
			],
			default: [
				"The drive to work is about {mins} right now.",
				"Work is {mins} away today."
			]
		},

		football: {
			excited: [
				"{teamA} vs {teamB} at {time}! Wanna watch?",
				"Football today! {teamA} against {teamB}, {time}."
			],
			default: [
				"There's football today — {teamA} vs {teamB} at {time}.",
				"{teamA} play {teamB} at {time} today."
			]
		}
	};

	const FULL_GREETS = [
		"Oooo! Hello there!",
		"Hi hi hi! You're here!",
		"Hello! Luigi was waiting."
	];

	const SHORT_GREETS = [
		"Oh, you're back!",
		"Hello again!",
		"That was quick!"
	];

	/* Indexed by Date#getDay(): 0 is Sunday. */
	const DAY_LINES = [
		["It's Sunday. Luigi is being lazy too."],
		["It's Monday... Luigi believes in you!"],
		["Happy Tuesday! Nothing suspicious about Tuesdays."],
		["It's Wednesday! Halfway to the good days."],
		["It's Thursday. Almost, almost, almost!"],
		["It's Friday! Luigi is excited!"],
		["It's Saturday! No work! Luigi approves."]
	];

	const GOODBYES = [
		"Okay, bye bye!",
		"See you later! Luigi will wait here.",
		"Bye! Come back soon!"
	];

	const FALLBACKS = [
		"Luigi doesn't know anything yet!",
		"Hmm. Luigi's brain is still loading.",
		"No news today. Just us!"
	];

	/*
	 * Deliberately not a variant list. Every other line varies to keep Luigi from
	 * sounding like a recording, but this one closes the news card and names a
	 * real publication — a stable closing beat reads as punctuation rather than as
	 * another thing to read.
	 */
	const SEE_MORE = "See more at {source}!";

	/**
	 * A subtitle line for a card.
	 * @param {string} cardId the card's id
	 * @param {string} mood a MOODS value
	 * @param {object} vars template variables from the card
	 * @param {Function} rng returns a float in [0, 1)
	 * @returns {string|null} the line, or null if the card has no phrases
	 */
	function pick (cardId, mood, vars, rng) {
		const card = LINES[cardId];
		if (!card) return null;
		const variants = card[mood] || card.default;
		if (!Array.isArray(variants) || variants.length === 0) return null;
		return render(choose(variants, rng), vars);
	}

	/**
	 * The opening line.
	 * @param {object} options greeting options
	 * @param {boolean} options.shortGreet skip the full greeting after a quick return
	 * @param {boolean} options.dayFlavor allow day-of-week flavored lines
	 * @param {number} options.day Date#getDay() value
	 * @param {Function} rng returns a float in [0, 1)
	 * @returns {string} the greeting line
	 */
	function greeting ({ shortGreet = false, dayFlavor = false, day = 0 } = {}, rng) {
		if (shortGreet) return choose(SHORT_GREETS, rng);
		if (dayFlavor && DAY_LINES[day]) return choose(DAY_LINES[day], rng);
		return choose(FULL_GREETS, rng);
	}

	/**
	 * The farewell line.
	 * @param {Function} rng returns a float in [0, 1)
	 * @returns {string} the goodbye line
	 */
	function goodbye (rng) {
		return choose(GOODBYES, rng);
	}

	/**
	 * Said when no card has anything to offer.
	 * @param {Function} rng returns a float in [0, 1)
	 * @returns {string} the fallback line
	 */
	function fallback (rng) {
		return choose(FALLBACKS, rng);
	}

	/**
	 * The closing line of the news card, naming where the top story came from.
	 * @param {string} source the publication, e.g. "The Verge"
	 * @returns {string|null} the line, or null when there is no source to name
	 */
	function seeMore (source) {
		if (typeof source !== "string" || source.length === 0) return null;
		return render(SEE_MORE, { source });
	}

	return { render, pick, greeting, goodbye, fallback, seeMore, LINES };
}));
