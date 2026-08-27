/* global moment, config */

Module.register("MMM-FlipClock", {
	defaults: {
		timeFormat: config.timeFormat,
		showDate: true,
		dateFormat: "dddd, LL",
		showSeconds: true,
		animationSpeed: 400,
		timezone: null,
	},

	getScripts () {
		return ["moment.js", "moment-timezone.js"];
	},

	getStyles () {
		return ["MMM-FlipClock.css"];
	},

	start () {
		moment.locale(config.language);
		this.prevDigits = [];
		this.digitEls = [];
		this.dateEl = null;
		this.built = false;
		this.scheduleTick();
	},

	scheduleTick () {
		const now = moment();
		const delay = this.config.showSeconds
			? 1000 - now.milliseconds() + 50
			: (60 - now.seconds()) * 1000 - now.milliseconds() + 50;

		setTimeout(() => {
			this.tick();
			this.scheduleTick();
		}, delay);
	},

	getNow () {
		const now = moment();
		if (this.config.timezone) {
			now.tz(this.config.timezone);
		}
		return now;
	},

	getTimeString (now) {
		const hourFmt = this.config.timeFormat === 24 ? "HH" : "hh";
		const fmt = this.config.showSeconds ? `${hourFmt}:mm:ss` : `${hourFmt}:mm`;
		return now.format(fmt);
	},

	// Extract only the digit characters (no colons)
	getDigits (timeStr) {
		return timeStr.replace(/:/g, "").split("");
	},

	tick () {
		const now = this.getNow();
		const timeStr = this.getTimeString(now);
		const digits = this.getDigits(timeStr);

		if (!this.built) {
			this.updateDom(0);
			return;
		}

		// Update date
		if (this.dateEl && this.config.showDate) {
			this.dateEl.textContent = now.format(this.config.dateFormat);
		}

		// Roll changed digits
		for (let i = 0; i < digits.length; i++) {
			if (digits[i] !== this.prevDigits[i] && this.digitEls[i]) {
				this.rollDigit(this.digitEls[i], digits[i]);
			}
		}

		this.prevDigits = digits;
	},

	rollDigit (el, newValue) {
		// If already rolling, finish immediately
		if (el.classList.contains("rolling")) {
			this.finishRoll(el);
		}

		const current = el.querySelector(".flip-digit-current");
		if (!current) return;

		const next = document.createElement("div");
		next.className = "flip-digit-next";
		next.textContent = newValue;
		el.appendChild(next);

		el.classList.add("rolling");

		const onEnd = () => {
			next.removeEventListener("animationend", onEnd);
			this.finishRoll(el);
		};
		next.addEventListener("animationend", onEnd);
	},

	finishRoll (el) {
		el.classList.remove("rolling");
		const current = el.querySelector(".flip-digit-current");
		const next = el.querySelector(".flip-digit-next");
		if (current && next) {
			current.textContent = next.textContent;
			current.style.transform = "";
			current.style.opacity = "";
			next.remove();
		}
	},

	getDom () {
		const wrapper = document.createElement("div");
		wrapper.className = "MMM-FlipClock";

		const now = this.getNow();

		// Date line
		if (this.config.showDate) {
			this.dateEl = document.createElement("div");
			this.dateEl.className = "flip-date normal medium";
			this.dateEl.textContent = now.format(this.config.dateFormat);
			wrapper.appendChild(this.dateEl);
		}

		// Time row
		const timeRow = document.createElement("div");
		timeRow.className = "flip-time large light";

		const timeStr = this.getTimeString(now);
		const digits = this.getDigits(timeStr);
		this.digitEls = [];
		this.prevDigits = digits;

		let digitIndex = 0;
		for (let i = 0; i < timeStr.length; i++) {
			if (timeStr[i] === ":") {
				const sep = document.createElement("div");
				sep.className = "flip-separator";
				sep.textContent = ":";
				timeRow.appendChild(sep);
			} else {
				const cell = document.createElement("div");
				cell.className = "flip-digit";

				const current = document.createElement("div");
				current.className = "flip-digit-current";
				current.textContent = digits[digitIndex];
				cell.appendChild(current);

				this.digitEls.push(cell);
				timeRow.appendChild(cell);
				digitIndex++;
			}
		}

		wrapper.appendChild(timeRow);
		this.built = true;

		return wrapper;
	},
});
