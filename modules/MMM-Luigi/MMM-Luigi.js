/* MMM-Luigi — front end
 *
 * Deliberately thin. Every decision lives elsewhere:
 *   luigi-fsm.js            when to change state
 *   content/waterfall.js  which cards have something to say
 *   content/phrases.js    how to word it
 *
 * This file only wires those to the DOM, and owns the animation beats the
 * machine does not care about (boot length, typing, hold between cards).
 */

Module.register("MMM-Luigi", {

	defaults: {
		// Presence timing. See the design spec for why these values.
		wakeDelayMs: 7000,        // after presence, before Luigi appears
		goodbyeDelayMs: 8000,     // after presence is lost, before the wave
		greetingCooldownMs: 60000,

		// Beat lengths owned by this file.
		bootDurationMs: 1200,
		goodbyeDurationMs: 3000,
		typingSpeedMs: 50,

		/*
		 * Total time each subtitle is on screen, typing included. Holding for a
		 * fixed period after typing would make short lines flash past and long
		 * ones linger, so the hold is derived from what the typing actually
		 * cost and the cycle stays even.
		 */
		cardCycleMs: 10000,
		minHoldMs: 1500,
		idleFidgetMs: 6000,

		cards: ["weather", "commute", "football", "news"],
		dayFlavor: true,

		/*
		 * News. Topics are deliberately empty here: the list has to agree with the
		 * newsfeed module's feed titles, so it lives in config.js next to them
		 * rather than being half-declared in two places.
		 *
		 * 90 minutes is not a taste decision — it is 4 topics x 1440 / 64, the
		 * shortest interval that fits a 64-call-a-day budget. Change the topic
		 * count and this should be recomputed, or the budget quietly moves.
		 */
		news: {
			enabled: true,
			// Model names get retired — gemini-1.5-flash already was. Overridable
			// in config.js so the next one is not a code change.
			model: "gemini-3.6-flash",
			refreshIntervalMs: 90 * 60 * 1000,
			maxHeadlinesPerTopic: 5,
			// Six lines at the usual 10s cycle would hold the mirror for a minute.
			newsLineCycleMs: 6000,
			topics: []
		},

		// Three weather modules broadcast on this mirror (Sofia current, Sofia
		// forecast, Varna current). These pick out the one Luigi should narrate.
		weatherLat: 42.6977,
		weatherLon: 23.3219,
		weatherType: "current_hourly"
	},

	getScripts () {
		/*
		 * this.file() is required, not optional: loadFileForModule treats any
		 * name containing a slash as a path from the web root rather than
		 * resolving it against the module directory.
		 */
		return [
			this.file("luigi-fsm.js"),
			this.file("content/waterfall.js"),
			this.file("content/phrases.js")
		];
	},

	getStyles () {
		return [this.file("MMM-Luigi.css")];
	},

	start () {
		this.cache = {};
		this.queue = [];
		this.beatTimers = [];
		this.typeTimer = null;

		// Lines still to speak for the card currently talking. Only the news card
		// ever puts more than one here.
		this.pendingLines = [];
		// Round-robin cursor over news topics, so all of them get airtime across
		// the day instead of the first one every time.
		this.newsTopicIndex = 0;
		this.warnedSources = [];

		this.fsm = new LuigiFsm.StateMachine({
			config: this.config,
			hasMoreCards: () => this.queue.length > 0,
			onTransition: (from, to) => this.onState(from, to)
		});
		this.fsm.start();

		// The mirror can restart with someone standing in front of it.
		this.sendSocketNotification("LUIGI_REQUEST_PRESENCE");
	},

	getDom () {
		if (this.wrapper) return this.wrapper;

		const wrapper = document.createElement("div");
		wrapper.className = `luigi ${this.stateClass(LuigiFsm.STATES.ASLEEP)} mood-default`;

		const face = document.createElement("div");
		face.className = "luigi-face";

		const eyes = document.createElement("div");
		eyes.className = "luigi-eyes";
		for (const side of ["left", "right"]) {
			const eye = document.createElement("span");
			eye.className = `luigi-eye ${side}`;
			eyes.appendChild(eye);
		}

		const mouth = document.createElement("div");
		mouth.className = "luigi-mouth";

		face.appendChild(eyes);
		face.appendChild(mouth);

		const subtitle = document.createElement("div");
		subtitle.className = "luigi-subtitle";

		wrapper.appendChild(face);
		wrapper.appendChild(subtitle);

		this.wrapper = wrapper;
		this.faceEl = face;
		this.subtitleEl = subtitle;
		return wrapper;
	},

	/* ---------- data in ---------- */

	notificationReceived (notification, payload, sender) {
		if (notification === "WEATHER_UPDATED") {
			if (this.isNarratedWeather(sender)) this.remember("weather", payload);
			return;
		}
		if (notification === "TRAFFIC_UPDATED") {
			this.remember("commute", payload);
			return;
		}
		if (notification === "FOOTBALL_UPDATED") {
			this.remember("football", payload);
			return;
		}
		if (notification === "NEWS_FEED") {
			this.onNewsFeed(payload);
		}
	},

	/**
	 * Sort a newsfeed broadcast into topics and hand it to the node helper.
	 *
	 * The helper cannot see this broadcast — it is frontend-only — so the
	 * headlines make a local socket hop to reach the summarizer.
	 * @param {object} payload the NEWS_FEED payload
	 */
	onNewsFeed (payload) {
		const news = this.config.news;
		if (!news?.enabled) return;

		if (!Array.isArray(news.topics) || news.topics.length === 0) {
			if (!this.warnedSources.includes("__no_topics__")) {
				this.warnedSources.push("__no_topics__");
				Log.warn("[MMM-Luigi] news is enabled but no topics are configured");
			}
			return;
		}

		const { buckets, unmatched } = LuigiWaterfall.groupHeadlines(
			payload?.items,
			news.topics,
			news.maxHeadlinesPerTopic
		);

		/*
		 * The feed titles and the topic sources are joined by string equality
		 * across two config blocks, so a typo would otherwise just make a topic
		 * quietly go missing. Warn once per publication — this broadcast repeats
		 * every five minutes.
		 */
		for (const source of unmatched) {
			if (this.warnedSources.includes(source)) continue;
			this.warnedSources.push(source);
			Log.warn(`[MMM-Luigi] news source '${source}' matches no topic in news.topics`);
		}

		this.sendSocketNotification("LUIGI_NEWS_HEADLINES", { config: news, buckets });
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "LUIGI_NEWS_SUMMARY") {
			this.remember("news", payload);
			return;
		}

		if (notification === "LUIGI_PRESENCE") {
			const present = payload?.present === true;

			/*
			 * Re-broadcast so other modules can react to someone arriving —
			 * MMM-Traffic refreshes the commute on this rather than waiting for
			 * its next scheduled poll. The sensor only posts on transitions, so
			 * these are edges, not a stream.
			 */
			this.sendNotification(present ? "PRESENCE_DETECTED" : "PRESENCE_LOST", payload);

			this.fsm.presence(present);
		}
	},

	/**
	 * Whether a weather broadcast is the one Luigi should talk about.
	 * @param {object} sender the broadcasting module
	 * @returns {boolean} true when it is the configured current-weather module
	 */
	isNarratedWeather (sender) {
		const cfg = sender?.config;
		if (!cfg) return false;
		const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 0.001;
		return near(cfg.lat, this.config.weatherLat)
			&& near(cfg.lon, this.config.weatherLon)
			&& cfg.type === this.config.weatherType;
	},

	/**
	 * Cache a payload with the time it arrived, for the freshness check.
	 * @param {string} cardId which card this feeds
	 * @param {*} value the broadcast payload
	 */
	remember (cardId, value) {
		this.cache[cardId] = { value, receivedAt: Date.now() };
	},

	/* ---------- state handling ---------- */

	/**
	 * CSS class for a state name. IDLE_FIDGET becomes state-idle-fidget, so the
	 * stylesheet stays kebab-case while the machine keeps its own naming.
	 * @param {string} state a STATES value
	 * @returns {string} the class name
	 */
	stateClass (state) {
		return `state-${String(state).toLowerCase().replace(/_/g, "-")}`;
	},

	onState (from, to) {
		this.clearBeats();
		if (this.wrapper) {
			this.wrapper.className = `luigi ${this.stateClass(to)} mood-${this.mood || "default"}`;
		}

		switch (to) {
			case LuigiFsm.STATES.WAKING:
				this.enterWaking();
				break;
			case LuigiFsm.STATES.GREETING:
				this.enterGreeting();
				break;
			case LuigiFsm.STATES.TALKING:
				this.enterTalking();
				break;
			case LuigiFsm.STATES.LEAVING:
				this.enterLeaving();
				break;
			case LuigiFsm.STATES.ASLEEP:
				this.setMood("default");
				this.say("");
				break;
			default:
				// IDLE_FIDGET is pure CSS off the state class.
				break;
		}
	},

	enterWaking () {
		// Snapshot the cards once per wake, so the cycle cannot change underfoot
		// if a broadcast lands mid-sentence.
		this.queue = LuigiWaterfall.availableCards(this.cache, Date.now(), this.config.cards);
		this.say("");
		// A re-greet inside the cooldown skips the boot beat entirely.
		const boot = this.fsm.shortGreet ? 0 : this.config.bootDurationMs;
		this.afterBeat(boot, () => this.fsm.advance());
	},

	enterGreeting () {
		const line = LuigiPhrases.greeting({
			shortGreet: this.fsm.shortGreet,
			dayFlavor: this.config.dayFlavor,
			day: new Date().getDay()
		});
		this.setMood("happy");
		this.speak(line, "happy", () => this.fsm.advance());
	},

	enterTalking () {
		const card = this.queue.shift();

		if (!card) {
			// Nothing had fresh data. Say so rather than freezing on a blank bar.
			this.setMood("default");
			this.speak(LuigiPhrases.fallback(), "default", this.config.cardCycleMs, () => this.fsm.advance());
			return;
		}

		const entry = this.cache[card.id];
		let mood = "default";
		let lines = [];
		try {
			mood = card.mood(entry.value);
			/*
			 * Multi-line cards return finished lines; single-line cards return
			 * template variables and let phrases.js word them. Only news is the
			 * former, because Gemini already did the wording.
			 */
			lines = card.lines
				? card.lines(entry.value, {
					topicIndex: this.newsTopicIndex,
					seeMore: LuigiPhrases.seeMore
				})
				: [LuigiPhrases.pick(card.id, mood, card.vars(entry.value))];
			lines = lines.filter(Boolean);
		} catch (err) {
			Log.warn(`[MMM-Luigi] card '${card.id}' failed to render:`, err);
			lines = [];
		}

		if (lines.length === 0) {
			// Skip a broken card instead of stalling the cycle on it.
			this.fsm.advance();
			return;
		}

		// Move the cursor on so the next wake gets the next topic, not this one.
		if (card.id === "news") this.newsTopicIndex += 1;

		this.setMood(mood);
		this.pendingLines = lines;
		this.speakNext(mood, this.cycleFor(card));
	},

	/**
	 * How long each line of a card stays up, typing included.
	 * @param {object} card the card being spoken
	 * @returns {number} milliseconds per line
	 */
	cycleFor (card) {
		return card.id === "news"
			? this.config.news.newsLineCycleMs
			: this.config.cardCycleMs;
	},

	/**
	 * Speak the next queued line, advancing the machine once they run out.
	 *
	 * The FSM still sees exactly one advance() per card; it just arrives six
	 * lines later for news.
	 * @param {string} mood drives typing speed
	 * @param {number} cycleMs time on screen per line
	 */
	speakNext (mood, cycleMs) {
		const line = this.pendingLines.shift();
		if (line === undefined) {
			this.fsm.advance();
			return;
		}
		this.speak(line, mood, cycleMs, () => this.speakNext(mood, cycleMs));
	},

	enterLeaving () {
		this.setMood("sleepy");
		this.speak(LuigiPhrases.goodbye(), "sleepy", this.config.cardCycleMs, () => {});
		this.afterBeat(this.config.goodbyeDurationMs, () => this.fsm.advance());
	},

	/* ---------- presentation ---------- */

	setMood (mood) {
		this.mood = mood;
		if (this.wrapper) {
			this.wrapper.className = `luigi ${this.stateClass(this.fsm.state)} mood-${mood}`;
		}
	},

	/**
	 * Type a line out, then hold it so the whole beat fills one cycle.
	 * @param {string} text the subtitle
	 * @param {string} mood drives typing speed
	 * @param {number} cycleMs total time on screen, typing included
	 * @param {Function} done called at the end of the cycle
	 */
	speak (text, mood, cycleMs, done) {
		const speed = this.speedFor(mood);
		// A long line eats into its own hold; the floor stops it vanishing the
		// instant the last character lands.
		const hold = Math.max(this.config.minHoldMs, cycleMs - (text.length * speed));
		this.type(text, speed, () => this.afterBeat(hold, done));
	},

	/**
	 * Typing speed for a mood. Excited Luigi talks faster, sleepy Luigi slower.
	 * @param {string} mood a MOODS value
	 * @returns {number} ms per character
	 */
	speedFor (mood) {
		const base = this.config.typingSpeedMs;
		if (mood === "excited") return Math.round(base * 0.75);
		if (mood === "sleepy") return Math.round(base * 1.5);
		return base;
	},

	/**
	 * Reveal text one character at a time.
	 * @param {string} text the subtitle
	 * @param {number} speedMs ms per character
	 * @param {Function} done called once fully revealed
	 */
	type (text, speedMs, done) {
		this.stopTyping();
		this.say("");
		if (!text) {
			done();
			return;
		}

		// The mouth animates only while characters are actually appearing, which
		// is what makes the face read as speaking rather than idling.
		this.faceEl?.classList.add("talking");

		let shown = 0;
		this.typeTimer = setInterval(() => {
			shown += 1;
			this.say(text.slice(0, shown));
			if (shown >= text.length) {
				this.stopTyping();
				done();
			}
		}, speedMs);
	},

	stopTyping () {
		if (this.typeTimer !== null) {
			clearInterval(this.typeTimer);
			this.typeTimer = null;
		}
		this.faceEl?.classList.remove("talking");
	},

	say (text) {
		if (this.subtitleEl) this.subtitleEl.textContent = text;
	},

	/**
	 * Schedule a beat, tracked so a state change can cancel it.
	 * @param {number} ms delay
	 * @param {Function} fn callback
	 */
	afterBeat (ms, fn) {
		this.beatTimers.push(setTimeout(fn, ms));
	},

	/** Cancel every pending beat. Called on every state change. */
	clearBeats () {
		this.stopTyping();
		for (const id of this.beatTimers) clearTimeout(id);
		this.beatTimers = [];
		/*
		 * Drop any unspoken lines too. Walking away mid-news should cut Luigi off
		 * mid-sentence, not leave three lines queued to resume in the next state.
		 */
		this.pendingLines = [];
	}
});
