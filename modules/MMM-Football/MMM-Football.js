Module.register("MMM-Football", {
	defaults: {
		apiKey: "",
		leagues: [],
		teams: [],
		timeZone: "UTC",
		logoSize: 26,
		showLeagueLogo: true,
	},

	leagueData: [],
	loaded: false,

	getStyles () {
		return ["MMM-Football.css"];
	},

	start () {
		if (!this.config.apiKey) {
			Log.error("[MMM-Football] No API key configured.");
			return;
		}
		this.sendSocketNotification("FOOTBALL_CONNECT", this.config);
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "FOOTBALL_UPDATE") {
			this.leagueData = payload;
			this.loaded = true;
			// Re-broadcast so other modules (MMM-Luigi) can narrate today's
			// fixtures without a second call against the free-tier quota.
			this.sendNotification("FOOTBALL_UPDATED", payload);
			this.updateDom(300);
		}
	},

	getDom () {
		const wrapper = document.createElement("div");
		wrapper.className = "MMM-Football";

		if (!this.config.apiKey) {
			const err = document.createElement("div");
			err.className = "dimmed small";
			err.textContent = "API key not configured";
			wrapper.appendChild(err);
			return wrapper;
		}

		if (this.leagueData.length === 0) {
			const msg = document.createElement("div");
			msg.className = "dimmed small";
			msg.textContent = this.loaded ? "No interesting matches today" : "Loading...";
			wrapper.appendChild(msg);
			return wrapper;
		}

		this.leagueData.forEach((league, index) => {
			if (index > 0) {
				const spacer = document.createElement("div");
				spacer.className = "league-spacer";
				wrapper.appendChild(spacer);
			}
			wrapper.appendChild(this.renderLeague(league));
		});

		return wrapper;
	},

	renderLeague (league) {
		const section = document.createElement("div");
		section.className = "football-league";

		const header = document.createElement("div");
		header.className = "league-header";

		if (this.config.showLeagueLogo && league.emblem) {
			const logo = this.renderLogo(league.emblem, 14);
			logo.className = "league-logo";
			header.appendChild(logo);
		}

		const nameEl = document.createElement("span");
		nameEl.className = "league-name dimmed xsmall";
		nameEl.textContent = (league.name || "").toUpperCase();
		header.appendChild(nameEl);

		section.appendChild(header);

		if (league.matches.length === 0) {
			const noMatch = document.createElement("div");
			noMatch.className = "no-matches dimmed xsmall";
			noMatch.textContent = "No matches today";
			section.appendChild(noMatch);
			return section;
		}

		league.matches.forEach((match, index) => {
			if (index > 0) {
				const divider = document.createElement("div");
				divider.className = "match-divider";
				section.appendChild(divider);
			}
			section.appendChild(this.renderMatch(match));
		});

		return section;
	},

	renderMatch (match) {
		const container = document.createElement("div");
		container.className = "match-container";

		const isLive = ["IN_PLAY", "PAUSED"].includes(match.status);
		const isFinished = match.status === "FINISHED";
		const showScore = isLive || isFinished;
		const textClass = (isLive || isFinished) ? "bright" : "dimmed";

		const statusLine = document.createElement("div");
		statusLine.className = "match-status-line xsmall";

		if (isLive) {
			statusLine.classList.add("match-status-live");
			statusLine.textContent = `● ${this.calcMinute(match.utcDate, match.status)}`;
		} else if (isFinished) {
			statusLine.classList.add("match-status-info");
			statusLine.textContent = "FT";
		} else {
			statusLine.classList.add("match-status-info");
			statusLine.textContent = this.formatTime(match.utcDate);
		}

		container.appendChild(statusLine);

		const homeRow = document.createElement("div");
		homeRow.className = "team-row";
		homeRow.appendChild(this.renderLogo(match.homeTeam.crest, this.config.logoSize));
		const homeName = document.createElement("span");
		homeName.className = `team-name ${textClass} small`;
		homeName.textContent = match.homeTeam.name;
		homeRow.appendChild(homeName);
		if (showScore) {
			const homeScore = document.createElement("span");
			homeScore.className = "team-score bright small";
			homeScore.textContent = match.homeScore != null ? match.homeScore : "–";
			homeRow.appendChild(homeScore);
		}
		container.appendChild(homeRow);

		const awayRow = document.createElement("div");
		awayRow.className = "team-row";
		awayRow.appendChild(this.renderLogo(match.awayTeam.crest, this.config.logoSize));
		const awayName = document.createElement("span");
		awayName.className = `team-name ${textClass} small`;
		awayName.textContent = match.awayTeam.name;
		awayRow.appendChild(awayName);
		if (showScore) {
			const awayScore = document.createElement("span");
			awayScore.className = "team-score bright small";
			awayScore.textContent = match.awayScore != null ? match.awayScore : "–";
			awayRow.appendChild(awayScore);
		}
		container.appendChild(awayRow);

		return container;
	},

	renderLogo (url, size) {
		if (!url) {
			const placeholder = document.createElement("div");
			placeholder.className = "team-logo-placeholder";
			placeholder.style.width = `${size}px`;
			placeholder.style.height = `${size}px`;
			return placeholder;
		}

		const img = document.createElement("img");
		img.className = "team-logo";
		img.src = url;
		img.width = size;
		img.height = size;
		img.alt = "";
		img.addEventListener("error", () => {
			const placeholder = document.createElement("div");
			placeholder.className = "team-logo-placeholder";
			placeholder.style.width = `${size}px`;
			placeholder.style.height = `${size}px`;
			img.parentNode.replaceChild(placeholder, img);
		});
		return img;
	},

	formatTime (utcDate) {
		return new Date(utcDate).toLocaleTimeString("en-GB", {
			hour: "2-digit",
			minute: "2-digit",
			timeZone: this.config.timeZone,
		});
	},

	calcMinute (utcDate, status) {
		if (status === "PAUSED") return "HT";
		const elapsed = Math.floor((Date.now() - new Date(utcDate).getTime()) / 60000);
		if (elapsed < 0) return "0'";
		if (elapsed <= 45) return `${elapsed}'`;
		// 45 min first half + ~15 min break before second half
		const secondHalfElapsed = elapsed - 60;
		if (secondHalfElapsed <= 0) return "45+'";
		return `${Math.min(45 + secondHalfElapsed, 90)}'`;
	},
});
