/* MMM-Luigi — content waterfall
 *
 * Pure data and predicates: no DOM, no MagicMirror globals, no phrase text.
 * Cards report *what* they know (mood + template variables); phrases.js decides
 * how to say it. Keeping those apart means either can be tested alone.
 *
 * News is the one card that returns finished lines rather than variables, since
 * a model wrote them. Even there the wording of the closing line is injected
 * through ctx rather than imported, so this file still depends on nothing.
 *
 * Adding a card later — calendar, trash day, air quality — is a single entry in
 * CARDS. The runner needs no changes.
 */
(function (root, factory) {
	const api = factory();
	if (typeof module !== "undefined" && module.exports) {
		module.exports = api;
	} else {
		root.LuigiWaterfall = api;
	}
}(typeof self !== "undefined" ? self : this, function () {
	"use strict";

	const MOODS = {
		HAPPY: "happy",
		CONCERNED: "concerned",
		EXCITED: "excited",
		SLEEPY: "sleepy",
		DEFAULT: "default"
	};

	const MINUTE = 60 * 1000;
	const HOUR = 60 * MINUTE;

	/*
	 * MagicMirror weather types are icon names ("day-sunny", "rain-showers-slight",
	 * "thunderstorm-heavy-hail"), so match on substrings rather than an exact list —
	 * open-meteo alone emits well over thirty variants.
	 */
	const WET = ["rain", "sprinkle", "shower", "storm", "thunder", "snow", "hail", "sleet"];
	const BRIGHT = ["sunny", "clear"];

	/**
	 * Map a MagicMirror weather type to one of Luigi's moods.
	 * @param {string} weatherType icon name from the weather module
	 * @returns {string} a MOODS value
	 */
	function moodForWeather (weatherType) {
		const type = String(weatherType || "").toLowerCase();
		if (!type) return MOODS.DEFAULT;
		if (WET.some((w) => type.includes(w))) return MOODS.CONCERNED;
		if (BRIGHT.some((w) => type.includes(w))) return MOODS.HAPPY;
		return MOODS.DEFAULT;
	}

	/**
	 * What Luigi reckons you should wear.
	 * @param {number} temp temperature in configured units
	 * @param {string} weatherType icon name
	 * @returns {string} a short noun phrase
	 */
	function dressAdvice (temp, weatherType) {
		if (moodForWeather(weatherType) === MOODS.CONCERNED) return "umbrella";
		if (temp <= 5) return "big coat";
		if (temp <= 12) return "jacket";
		if (temp >= 25) return "shorts";
		return "just-right";
	}

	/**
	 * First match across all leagues, or null.
	 * @param {Array} leagues football payload
	 * @returns {object|null} the match and the league it belongs to
	 */
	function firstMatch (leagues) {
		if (!Array.isArray(leagues)) return null;
		for (const league of leagues) {
			if (Array.isArray(league?.matches) && league.matches.length > 0) {
				return { match: league.matches[0], league };
			}
		}
		return null;
	}

	/**
	 * Local kick-off time as HH:MM.
	 * @param {string} utcDate ISO timestamp
	 * @returns {string} formatted time, or empty string if unparseable
	 */
	function kickOffTime (utcDate) {
		const date = new Date(utcDate);
		if (Number.isNaN(date.getTime())) return "";
		return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
	}

	/**
	 * Topics that actually have something to say, in cache order.
	 * The cache is built from the configured topic list, so insertion order is
	 * config order, and rotation follows the order you wrote them in.
	 * @param {object} news the news cache payload
	 * @returns {Array} topic entries with at least one line
	 */
	function usableTopics (news) {
		if (news === null || typeof news !== "object") return [];
		return Object.values(news).filter(
			(topic) => Array.isArray(topic?.lines) && topic.lines.length > 0
		);
	}

	const CARDS = {
		weather: {
			id: "weather",
			// The weather module polls hourly; two hours tolerates one missed poll
			// but stops a genuinely dead feed being narrated as current.
			maxAgeMs: 2 * HOUR,
			available: (v) => Number.isFinite(v?.currentWeather?.temperature),
			mood: (v) => moodForWeather(v?.currentWeather?.weatherType),
			vars: (v) => {
				const temp = Math.round(v.currentWeather.temperature);
				return {
					temp,
					advice: dressAdvice(temp, v.currentWeather.weatherType),
					location: v.locationName || ""
				};
			}
		},

		commute: {
			id: "commute",
			// Polls every 5 min in rush hour, every 2 h otherwise. 90 min keeps rush
			// figures honest without dropping the card all afternoon.
			maxAgeMs: 90 * MINUTE,
			available: (v) => typeof v?.durationText === "string" && v.durationText.length > 0,
			mood: (v) => {
				if (v?.condition === "good") return MOODS.HAPPY;
				if (v?.condition === "heavy") return MOODS.CONCERNED;
				return MOODS.DEFAULT;
			},
			vars: (v) => ({
				mins: v.durationText,
				summary: v.summary || "",
				condition: v.condition || "moderate"
			})
		},

		football: {
			id: "football",
			// The module already filters to today's fixtures, so anything present is
			// today's. Polls every 10 min, or every minute when a match is live.
			maxAgeMs: 1 * HOUR,
			available: (v) => firstMatch(v) !== null,
			mood: () => MOODS.EXCITED,
			vars: (v) => {
				const { match, league } = firstMatch(v);
				return {
					teamA: match.homeTeam?.name || "someone",
					teamB: match.awayTeam?.name || "someone else",
					time: kickOffTime(match.utcDate),
					league: league.name || ""
				};
			}
		},

		/*
		 * The only multi-line card. Where every other card returns `vars` for a
		 * single templated line, this one returns finished lines: five written by
		 * Gemini plus a closing line naming where the top story came from.
		 *
		 * Twelve hours is long enough to ride out a failed refresh — eight of them,
		 * at the 90 minute cadence — and short enough that a dead API key stops
		 * Luigi reading yesterday's news rather than letting him do it forever.
		 */
		news: {
			id: "news",
			maxAgeMs: 12 * HOUR,
			available: (v) => usableTopics(v).length > 0,
			mood: () => MOODS.DEFAULT,
			/**
			 * The lines to speak this pass.
			 * @param {object} v the news cache payload
			 * @param {object} ctx topicIndex for rotation, seeMore to word the last line
			 * @returns {Array} spoken lines, five or six of them
			 */
			lines: (v, ctx) => {
				const usable = usableTopics(v);
				if (usable.length === 0) return [];

				/*
				 * Rotating over the usable topics rather than all configured ones
				 * means a topic whose feed died costs nothing: the others simply
				 * take their turns sooner, instead of the cycle landing on silence.
				 */
				const index = Math.trunc(Math.abs(Number(ctx?.topicIndex) || 0)) % usable.length;
				const topic = usable[index];

				// Wording lives in phrases.js; it is injected so this file keeps
				// depending on nothing.
				const closing = topic.topSource && typeof ctx?.seeMore === "function"
					? ctx.seeMore(topic.topSource)
					: null;

				return closing ? [...topic.lines, closing] : [...topic.lines];
			}
		}
	};

	/* Enough of an article for the model to tell two stories apart, without
	 * spending the prompt on one verbose feed. */
	const SNIPPET_CHARS = 300;

	/**
	 * Sort newsfeed broadcast items into topic buckets.
	 *
	 * Publications are matched to topics by exact string equality against
	 * `topics[].sources`. Exact is deliberate: the two lists live in different
	 * config blocks, so a typo should surface as an unmatched publication rather
	 * than half-working.
	 * @param {Array} items newsfeed items, each carrying a sourceTitle
	 * @param {Array} topics configured topics with id, label and sources
	 * @param {number} maxPerTopic how many headlines a topic may contribute
	 * @returns {object} buckets keyed by topic id, and the unmatched publications
	 */
	function groupHeadlines (items, topics, maxPerTopic) {
		const buckets = {};
		const unmatched = [];
		if (!Array.isArray(items)) return { buckets, unmatched };

		const topicOf = new Map();
		for (const topic of topics || []) {
			for (const source of topic?.sources || []) topicOf.set(source, topic);
		}

		for (const item of items) {
			const source = item?.sourceTitle;
			const topic = topicOf.get(source);

			if (!topic) {
				// Once per publication, not once per item: a misconfigured feed
				// would otherwise fill the log with the same line every refresh.
				if (!unmatched.includes(source)) unmatched.push(source);
				continue;
			}

			const bucket = buckets[topic.id] || (buckets[topic.id] = {
				label: topic.label,
				topSource: source,
				headlines: []
			});

			if (bucket.headlines.length >= maxPerTopic) continue;

			bucket.headlines.push({
				title: item.title,
				snippet: String(item.description || "").slice(0, SNIPPET_CHARS),
				source
			});
		}

		return { buckets, unmatched };
	}

	/**
	 * Cards that have fresh, usable data, in the configured order.
	 * @param {object} data cache of { cardId: { value, receivedAt } }
	 * @param {number} now current epoch ms
	 * @param {Array} order card ids, in the order Luigi should talk about them
	 * @returns {Array} card definitions that survived filtering
	 */
	function availableCards (data, now, order) {
		return (order || [])
			.map((id) => CARDS[id])
			.filter(Boolean)
			.filter((card) => {
				const entry = data?.[card.id];
				if (entry === null || entry === undefined) return false;
				if (entry.value === null || entry.value === undefined) return false;
				if (!Number.isFinite(entry.receivedAt)) return false;
				if (now - entry.receivedAt > card.maxAgeMs) return false;
				try {
					return card.available(entry.value) === true;
				} catch {
					// An upstream shape change must cost us one card, not the cycle.
					return false;
				}
			});
	}

	return { CARDS, MOODS, moodForWeather, availableCards, groupHeadlines };
}));
