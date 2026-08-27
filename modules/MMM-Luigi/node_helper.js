/* MMM-Luigi — node helper
 *
 * Owns two things:
 *
 *   1. the HTTP endpoint that hmmd_display.py posts presence transitions to,
 *      forwarded to the front end as a socket notification;
 *   2. the news summarization job — a timer that turns headlines into five
 *      Luigi-voiced lines per topic and caches them.
 *
 * Luigi still fetches no data of its own. Weather, commute, football and now the
 * raw news headlines all arrive in the browser as module-to-module broadcasts;
 * the front end forwards the headlines down here because a Gemini call and a
 * cache file need Node, not because Luigi wants to be a fetcher.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const NodeHelper = require("node_helper");
const Log = require("logger");

const { summarizeTopic } = require("./news/summarizer");
const { refreshTopics, missingTopics } = require("./news/job");

const LOOPBACK = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

const CACHE_PATH = path.join(__dirname, "news", "news_cache.json");

module.exports = NodeHelper.create({
	start () {
		this.lastPresence = null;

		this.newsConfig = null;
		this.newsBuckets = {};
		this.newsCache = this.loadNewsCache();
		this.newsTimer = null;
		this.newsKeyWarned = false;

		/*
		 * setExpressApp() has already run by this point, so this.expressApp is
		 * live. It mounts /MMM-Luigi as a static directory, but static only
		 * answers GET/HEAD, so this POST route is reached normally.
		 */
		this.expressApp.post("/MMM-Luigi/presence", express.json({ limit: "4kb" }), (req, res) => {
			const remote = req.ip || req.socket?.remoteAddress || "";
			if (!LOOPBACK.includes(remote)) {
				Log.warn(`[MMM-Luigi] rejected presence POST from ${remote}`);
				return res.sendStatus(403);
			}

			const { present, distance_m: distance } = req.body ?? {};
			if (typeof present !== "boolean") {
				Log.warn("[MMM-Luigi] rejected presence POST with a non-boolean 'present'");
				return res.sendStatus(400);
			}

			this.lastPresence = {
				present,
				distance: typeof distance === "number" ? distance : null
			};
			this.sendSocketNotification("LUIGI_PRESENCE", this.lastPresence);
			return res.sendStatus(204);
		});

		Log.info("[MMM-Luigi] presence endpoint listening on /MMM-Luigi/presence");
	},

	socketNotificationReceived (notification, payload) {
		/*
		 * The mirror can restart while someone is standing in front of it, and a
		 * POST can land before the front end has connected. Without this replay
		 * Luigi would stay asleep until the user walked away and came back.
		 */
		if (notification === "LUIGI_REQUEST_PRESENCE" && this.lastPresence) {
			this.sendSocketNotification("LUIGI_PRESENCE", this.lastPresence);
		}

		if (notification === "LUIGI_NEWS_HEADLINES") {
			this.onHeadlines(payload);
		}
	},

	/* ---------- news ---------- */

	/**
	 * Take this round's headline buckets, and start the job if it is not running.
	 * @param {object} payload the news config block and the grouped buckets
	 */
	onHeadlines (payload) {
		this.newsBuckets = payload?.buckets || {};

		if (this.newsTimer !== null) {
			/*
			 * Already running, so the clock is not restarted — but newsfeed
			 * broadcasts as soon as it has any items, and the first broadcast after
			 * a restart usually carries one feed rather than all five. Fill in
			 * topics that still have no summary; the ones that do are left for the
			 * next tick.
			 */
			this.refreshNews(true);
			return;
		}

		this.newsConfig = payload?.config || null;
		if (!this.newsConfig) return;

		/*
		 * Summarize now rather than at the end of the first interval — otherwise a
		 * restart leaves Luigi with nothing to say about the news for 90 minutes.
		 */
		this.refreshNews();
		this.newsTimer = setInterval(() => this.refreshNews(), this.newsConfig.refreshIntervalMs);

		Log.info(`[MMM-Luigi] news job started, refreshing every ${Math.round(this.newsConfig.refreshIntervalMs / 60000)} min`);
	},

	/**
	 * Summarize topics, then cache and broadcast.
	 * @param {boolean} onlyMissing summarize just the topics with no summary yet
	 * @returns {Promise<void>} resolves once the cache is written
	 */
	async refreshNews (onlyMissing = false) {
		/*
		 * config/config.env is loaded into process.env by js/utils.js before any
		 * module starts, so there is nothing to parse here — MagicMirror already
		 * owns that, and the key never reaches the browser.
		 */
		const apiKey = process.env.GEMINI_API_KEY || "";

		if (!apiKey) {
			// Once, not every 90 minutes: an unconfigured mirror should say so and
			// then be quiet about it.
			if (!this.newsKeyWarned) {
				this.newsKeyWarned = true;
				Log.warn("[MMM-Luigi] no GEMINI_API_KEY in config/config.env or the environment — news is switched off");
			}
			return;
		}

		const buckets = onlyMissing
			? missingTopics(this.newsBuckets, this.newsCache)
			: this.newsBuckets;

		// Nothing to fill in — replay what we have so a reloaded front end still
		// gets the cache, and spend no API calls.
		if (Object.keys(buckets).length === 0) {
			this.replayNewsCache();
			return;
		}

		this.newsCache = await refreshTopics(buckets, this.newsCache, {
			summarize: summarizeTopic,
			now: Date.now,
			apiKey,
			model: this.newsConfig.model
		});

		this.saveNewsCache();
		this.replayNewsCache();
	},

	/**
	 * Send the cache to the front end, if there is anything in it.
	 */
	replayNewsCache () {
		if (Object.keys(this.newsCache).length > 0) {
			this.sendSocketNotification("LUIGI_NEWS_SUMMARY", this.newsCache);
		}
	},

	/**
	 * The cache from disk, so a restart does not cost the last good summaries.
	 * @returns {object} the cache, empty when absent or unreadable
	 */
	loadNewsCache () {
		try {
			return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
		} catch {
			// No cache yet on a fresh install, which is normal.
			return {};
		}
	},

	saveNewsCache () {
		try {
			fs.writeFileSync(CACHE_PATH, JSON.stringify(this.newsCache, null, 2));
		} catch (err) {
			// Losing the cache costs a restart's worth of freshness, nothing more.
			Log.warn("[MMM-Luigi] could not write the news cache:", err.message);
		}
	},

	stop () {
		if (this.newsTimer !== null) {
			clearInterval(this.newsTimer);
			this.newsTimer = null;
		}
	}
});
