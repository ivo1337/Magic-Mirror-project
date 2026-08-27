Module.register("MMM-Traffic", {
	defaults: {
		origin: "",
		destination: "",
		apiKey: "",
		mode: "driving",
		rushStart: "07:50",       // rush hour start (HH:MM)
		rushEnd: "09:30",         // rush hour end (HH:MM)
		rushInterval: 5 * 60000,  // 5 min during rush
		idleInterval: 120 * 60000, // 2 hours otherwise
		label: "Work",

		// Refresh when someone walks up, so the figure on screen is current
		// rather than however old the last scheduled poll left it.
		refreshOnPresence: true,

		/*
		 * Keep refreshing on each wall-clock minute for as long as someone is
		 * still standing there, so the ETA does not drift while it is being
		 * read. Costs one billed call per minute of standing in front of the
		 * mirror; set false to refresh only on arrival.
		 */
		refreshEachMinuteWhilePresent: true,

		/*
		 * Floor between presence-triggered fetches. Every fetch is a billed
		 * Distance Matrix call, so without this, walking in and out of range
		 * repeatedly would cost one request per pass.
		 */
		presenceMinIntervalMs: 60000
	},

	trafficData: null,

	getStyles () {
		return ["MMM-Traffic.css"];
	},

	start () {
		this.present = false;
		this.scheduleCheck();
		this.scheduleMinuteTick();
	},

	scheduleCheck () {
		this.checkAndFetch();
		// Re-evaluate every minute whether to show/hide and which interval to use
		setInterval(() => this.checkAndFetch(), 60000);
	},

	/**
	 * Fire on each wall-clock minute boundary.
	 * Aligned to the clock rather than a plain 60s interval, because the point
	 * is to track the minute the user can see on the mirror, not 60s from
	 * whenever this module happened to start. Re-armed each tick so it cannot
	 * drift.
	 */
	scheduleMinuteTick () {
		const now = new Date();
		const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
		clearTimeout(this._minuteTimer);
		this._minuteTimer = setTimeout(() => {
			if (this.present && this.config.refreshEachMinuteWhilePresent) {
				this.fetchOnPresence();
			}
			this.scheduleMinuteTick();
		}, msToNextMinute + 50); // just past the boundary, never a hair before
	},

	checkAndFetch () {
		const now = new Date();
		const day = now.getDay();

		// Weekend: hide widget, don't fetch
		if (day === 0 || day === 6) {
			if (!this.hidden) this.hide(300);
			return;
		}

		// Weekday: show widget
		if (this.hidden) this.show(300);

		const hhmm = now.getHours() * 60 + now.getMinutes();
		const [rsh, rsm] = this.config.rushStart.split(":").map(Number);
		const [reh, rem] = this.config.rushEnd.split(":").map(Number);
		const rushStart = rsh * 60 + rsm;
		const rushEnd = reh * 60 + rem;
		const isRush = hhmm >= rushStart && hhmm <= rushEnd;
		const interval = isRush ? this.config.rushInterval : this.config.idleInterval;

		// Only send fetch request if enough time has passed since last fetch
		if (!this._lastFetch || Date.now() - this._lastFetch >= interval) {
			this._lastFetch = Date.now();
			this.sendSocketNotification("TRAFFIC_FETCH", this.config);
		}
	},

	notificationReceived (notification) {
		if (notification === "PRESENCE_DETECTED") {
			this.present = true;
			this.fetchOnPresence();
		} else if (notification === "PRESENCE_LOST") {
			this.present = false;
		}
	},

	/**
	 * Refresh the commute because someone just walked up.
	 * Skipped on weekends (the widget is hidden and not fetching anyway) and
	 * throttled so repeated detections cannot run up the API bill.
	 */
	fetchOnPresence () {
		if (!this.config.refreshOnPresence) return;

		const day = new Date().getDay();
		if (day === 0 || day === 6) return;

		if (this._lastFetch
			&& Date.now() - this._lastFetch < this.config.presenceMinIntervalMs) {
			return;
		}

		this._lastFetch = Date.now();
		this.sendSocketNotification("TRAFFIC_FETCH", this.config);
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "TRAFFIC_DATA") {
			this.trafficData = payload;
			// Re-broadcast so other modules (MMM-Luigi) can narrate the commute
			// without paying for a second Distance Matrix call.
			this.sendNotification("TRAFFIC_UPDATED", payload);
			this.updateDom(300);
		}
	},

	getDom () {
		const wrapper = document.createElement("div");
		wrapper.className = "mmm-traffic";

		if (!this.trafficData) {
			wrapper.className += " dimmed light small";
			wrapper.textContent = "No planned travel for today";
			return wrapper;
		}

		const { durationText, condition } = this.trafficData;

		// ETA = now + duration
		const eta = new Date(Date.now() + this.trafficData.durationSec * 1000);
		const etaStr = eta.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

		// Main row:  🚗  25 min  ·  ETA 08:45
		const row = document.createElement("div");
		row.className = `traffic-row traffic-${condition}`;

		const car = document.createElement("span");
		car.className = "traffic-icon fas fa-car-side";
		row.appendChild(car);

		const duration = document.createElement("span");
		duration.className = "traffic-duration bright";
		duration.textContent = durationText;
		row.appendChild(duration);

		const sep = document.createElement("span");
		sep.className = "traffic-sep dimmed";
		sep.textContent = "·";
		row.appendChild(sep);

		const etaEl = document.createElement("span");
		etaEl.className = "traffic-eta dimmed";
		etaEl.textContent = `ETA ${etaStr}`;
		row.appendChild(etaEl);

		wrapper.appendChild(row);

		// Label row
		const labelRow = document.createElement("div");
		labelRow.className = "traffic-label dimmed small";
		labelRow.textContent = this.config.label;
		wrapper.appendChild(labelRow);

		return wrapper;
	}
});
