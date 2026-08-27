/* MMM-Luigi — news summarizer
 *
 * Turns a topic's headlines into five short lines in Luigi's voice.
 *
 * The HTTP call is deliberately the only impure part: prompt construction and
 * reply parsing are exported separately so both can be tested without a network
 * or an API key. `fetchImpl` is injected for the same reason.
 *
 * This file never sees which publication a story came from, and never asks the
 * model for one. Asked for a source or a link, a model will confidently supply a
 * plausible wrong one — so the "see more at" line is assembled downstream from
 * the real item data instead.
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/*
 * Model names expire. gemini-1.5-flash was in the original design and is gone;
 * gemini-2.5-flash still lists but answers "no longer available to new users".
 * Hence configurable rather than baked into the URL: the next retirement should
 * be a config edit, not a code change. Note ListModels lies — it returns models
 * a given key cannot actually call, so verify with a real generateContent.
 * `curl "$GEMINI_BASE?key=..."` lists what the key can currently reach.
 */
const DEFAULT_MODEL = "gemini-3.6-flash";

const MAX_LINES = 5;
const DEFAULT_TIMEOUT_MS = 15000;

/* Models ignore "no markdown" often enough to be worth undoing here — an
 * unstripped "- " would be typed out onto the mirror one character at a time. */
const BULLET = /^(?:[-*+]|\d+[.)])\s+/;

/**
 * The prompt for one topic.
 * @param {string} topicLabel the topic's display name, e.g. "Tech"
 * @param {Array} headlines objects with title and snippet
 * @returns {string} the prompt
 */
function buildPrompt (topicLabel, headlines) {
	const headlineText = headlines
		.map((h, i) => `${i + 1}. ${h.title} — ${h.snippet || ""}`)
		.join("\n");

	return `You are Luigi, a cheerful robot assistant on a smart mirror.
Summarize today's "${topicLabel}" news below into exactly 5 short lines,
in Luigi's warm, simple, slightly playful voice. No preamble, no markdown,
just 5 plain lines, each a distinct point. Keep each line under 15 words.

Headlines:
${headlineText}`;
}

/**
 * Split a model reply into speakable lines.
 * @param {string} text the reply
 * @returns {Array} up to MAX_LINES trimmed, non-empty lines
 */
function parseLines (text) {
	if (typeof text !== "string") return [];
	return text
		.split("\n")
		.map((line) => line.trim().replace(BULLET, "").trim())
		.filter(Boolean)
		.slice(0, MAX_LINES);
}

/**
 * Summarize one topic.
 *
 * Never throws: every failure returns null so the caller can keep the previous
 * cache entry rather than blanking a topic on one bad afternoon.
 * @param {string} topicLabel the topic's display name
 * @param {Array} headlines objects with title and snippet
 * @param {object} options call options
 * @param {string} options.apiKey Gemini API key
 * @param {string} options.model model name, e.g. gemini-2.5-flash
 * @param {Function} options.fetchImpl fetch implementation, for tests
 * @param {number} options.timeoutMs abort after this long
 * @returns {Promise<Array|null>} the lines, or null if nothing usable came back
 */
async function summarizeTopic (topicLabel, headlines, options = {}) {
	const {
		apiKey,
		model = DEFAULT_MODEL,
		fetchImpl = globalThis.fetch,
		timeoutMs = DEFAULT_TIMEOUT_MS
	} = options;

	if (!apiKey) return null;
	if (!Array.isArray(headlines) || headlines.length === 0) return null;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const res = await fetchImpl(`${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{ parts: [{ text: buildPrompt(topicLabel, headlines) }] }]
			}),
			signal: controller.signal
		});

		if (!res.ok) return null;

		const data = await res.json();
		const lines = parseLines(data?.candidates?.[0]?.content?.parts?.[0]?.text);
		return lines.length > 0 ? lines : null;
	} catch {
		// Network error, abort, or malformed JSON. The caller keeps its last good
		// entry; one failed refresh must not cost the topic.
		return null;
	} finally {
		clearTimeout(timer);
	}
}

module.exports = { buildPrompt, parseLines, summarizeTopic, GEMINI_BASE, DEFAULT_MODEL, MAX_LINES };
