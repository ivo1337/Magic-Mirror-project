Module.register("MMM-SpotifyPlaying", {
	defaults: {
		clientId: "",
		clientSecret: "",
		refreshToken: "",
		updateInterval: 4000,
		showProgressBar: true,
		albumArtSize: 80,
		albumArtPosition: "left",  // "left" or "right"
		grayscale: false,
		hideWhenPaused: false
	},

	trackData: null,
	lastTrackId: null,
	progressMs: 0,
	animationFrame: null,
	lastFrameTime: 0,

	getStyles () {
		return ["MMM-SpotifyPlaying.css"];
	},

	getHeader () {
		return "Now Playing";
	},

	start () {
		this.sendSocketNotification("SPOTIFY_CONNECT", this.config);
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "SPOTIFY_UPDATE") return;

		if (!payload) {
			const wasPlaying = this.trackData !== null;
			this.trackData = null;
			this.lastTrackId = null;
			this.stopAnimation();
			if (wasPlaying) {
				if (this.config.hideWhenPaused) {
					this.hide(300);
				} else {
					this.updateDom(300);
				}
			}
			return;
		}

		if (this.hidden) {
			this.show(300);
		}

		const trackChanged = payload.trackId !== this.lastTrackId;
		const wasNull = this.trackData === null;

		this.trackData = payload;
		this.lastTrackId = payload.trackId;
		this.progressMs = payload.progressMs;
		this.lastFrameTime = Date.now();

		// Only rebuild DOM when track changes or first load
		if (trackChanged || wasNull) {
			this.updateDom(300);
		} else {
			// Just update text elements in-place
			this.updateInPlace();
		}

		if (payload.isPlaying) {
			this.startAnimation();
		} else {
			this.stopAnimation();
		}
	},

	updateInPlace () {
		const wrapper = document.querySelector(".MMM-SpotifyPlaying");
		if (!wrapper) return;

		const trackEl = wrapper.querySelector(".track-name");
		if (trackEl) trackEl.textContent = this.trackData.trackName;

		const artistEl = wrapper.querySelector(".artist-name");
		if (artistEl) artistEl.textContent = this.trackData.artistName;

		this.updateProgressBar();
	},

	startAnimation () {
		this.stopAnimation();
		this.lastFrameTime = Date.now();

		const tick = () => {
			const now = Date.now();
			const delta = now - this.lastFrameTime;
			this.lastFrameTime = now;

			if (this.trackData && this.trackData.isPlaying) {
				this.progressMs = Math.min(this.progressMs + delta, this.trackData.durationMs);
				this.updateProgressBar();
			}

			this.animationFrame = requestAnimationFrame(tick);
		};

		this.animationFrame = requestAnimationFrame(tick);
	},

	stopAnimation () {
		if (this.animationFrame) {
			cancelAnimationFrame(this.animationFrame);
			this.animationFrame = null;
		}
	},

	updateProgressBar () {
		const bar = document.getElementById("SPOTIFY_PROGRESS_BAR");
		if (!bar || !this.trackData) return;
		const pct = Math.min((this.progressMs / this.trackData.durationMs) * 100, 100);
		bar.style.width = `${pct}%`;
	},

	getDom () {
		const wrapper = document.createElement("div");

		// No data yet — loading
		if (this.trackData === undefined || (this.trackData === null && !this.config.hideWhenPaused)) {
			// Nothing is playing — show paused state or loading
			if (this.trackData === null) {
				const paused = document.createElement("div");
				paused.className = "paused-state dimmed light small";
				const icon = document.createElement("span");
				icon.className = "fas fa-pause";
				paused.appendChild(icon);
				const text = document.createElement("span");
				text.textContent = " Spotify Paused";
				paused.appendChild(text);
				wrapper.appendChild(paused);
			}
			return wrapper;
		}

		const data = this.trackData;

		// Main container
		const container = document.createElement("div");
		container.className = "spotify-container";
		if (this.config.albumArtPosition === "right") {
			container.classList.add("art-right");
		}

		// Album art
		if (data.albumArt) {
			const art = document.createElement("img");
			art.className = "album-art";
			if (this.config.grayscale) {
				art.classList.add("grayscale");
			}
			art.src = data.albumArt;
			art.width = this.config.albumArtSize;
			art.height = this.config.albumArtSize;
			art.alt = data.albumName || "Album Art";
			container.appendChild(art);
		}

		// Track info column
		const info = document.createElement("div");
		info.className = "track-info";

		const trackName = document.createElement("div");
		trackName.className = "track-name bright medium";
		trackName.textContent = data.trackName;
		info.appendChild(trackName);

		const artistName = document.createElement("div");
		artistName.className = "artist-name dimmed small";
		artistName.textContent = data.artistName;
		info.appendChild(artistName);

		// Progress bar
		if (this.config.showProgressBar) {
			const progressContainer = document.createElement("div");
			progressContainer.className = "progress-container";

			const progressBar = document.createElement("div");
			progressBar.className = "progress-bar";
			progressBar.id = "SPOTIFY_PROGRESS_BAR";
			const pct = Math.min((this.progressMs / data.durationMs) * 100, 100);
			progressBar.style.width = `${pct}%`;

			progressContainer.appendChild(progressBar);
			info.appendChild(progressContainer);
		}

		container.appendChild(info);
		wrapper.appendChild(container);

		return wrapper;
	},

	suspend () {
		this.stopAnimation();
	},

	resume () {
		if (this.trackData && this.trackData.isPlaying) {
			this.startAnimation();
		}
	}
});
