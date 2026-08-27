/* MMM-Luigi — character state machine
 *
 * Pure logic: no DOM, no MagicMirror globals, no timers of its own. The clock
 * and timer functions are injected so the whole machine can be driven
 * deterministically in tests.
 *
 * The host drives *beats* (boot animation finished, subtitle finished typing)
 * by calling advance(). The machine owns only the two presence-derived delays,
 * which is what keeps it free of animation timing.
 */
(function (root, factory) {
	const api = factory();
	if (typeof module !== "undefined" && module.exports) {
		module.exports = api;
	} else {
		root.LuigiFsm = api;
	}
}(typeof self !== "undefined" ? self : this, function () {
	"use strict";

	const STATES = {
		ASLEEP: "ASLEEP",
		WAKING: "WAKING",
		GREETING: "GREETING",
		TALKING: "TALKING",
		IDLE_FIDGET: "IDLE_FIDGET",
		LEAVING: "LEAVING"
	};

	/** States in which Luigi is awake and should react to the user walking off. */
	const AWAKE_STATES = [STATES.WAKING, STATES.GREETING, STATES.TALKING, STATES.IDLE_FIDGET];

	class StateMachine {
		constructor ({ config, now, setTimer, clearTimer, hasMoreCards, onTransition } = {}) {
			this.config = config;
			this._now = now || (() => Date.now());
			this._setTimer = setTimer || ((fn, ms) => setTimeout(fn, ms));
			this._clearTimer = clearTimer || ((id) => clearTimeout(id));
			this._hasMoreCards = hasMoreCards || (() => false);
			this._onTransition = onTransition || (() => {});

			this.state = STATES.ASLEEP;
			this.shortGreet = false;

			// Exactly one presence-scoped timer may be outstanding at a time: either
			// the pending wake or the pending goodbye, never both. Funnelling every
			// schedule through one slot is what makes stacked timers impossible.
			this._timerId = null;
			this._pending = null;

			this._lastAsleepAt = null;
			this._interrupted = null;
		}

		/** Active timer ids. Exposed so tests can assert nothing is left running. */
		get timers () {
			return this._timerId === null ? [] : [this._timerId];
		}

		start () {
			this.state = STATES.ASLEEP;
			// Deliberately null rather than now(): the first wake of the session is
			// a full greeting, not a re-greet.
			this._lastAsleepAt = null;
			this._onTransition(null, STATES.ASLEEP);
		}

		presence (isPresent) {
			if (isPresent) {
				this._onPresent();
			} else {
				this._onAbsent();
			}
		}

		advance () {
			switch (this.state) {
				case STATES.WAKING:
					this._transitionTo(STATES.GREETING);
					break;
				case STATES.GREETING:
					this._transitionTo(STATES.TALKING);
					break;
				case STATES.TALKING:
					this._transitionTo(this._hasMoreCards() ? STATES.TALKING : STATES.IDLE_FIDGET);
					break;
				case STATES.LEAVING:
					this._transitionTo(STATES.ASLEEP);
					break;
				default:
					// ASLEEP and IDLE_FIDGET have no next beat to advance to.
					break;
			}
		}

		_onPresent () {
			if (this.state === STATES.LEAVING) {
				// Walked back in mid-wave. Pick up where the goodbye interrupted.
				this._transitionTo(this._interrupted || STATES.TALKING);
				return;
			}

			if (this._pending === "goodbye") {
				// Still awake and on screen, so simply call off the goodbye.
				this._cancelTimer();
				return;
			}

			if (this.state !== STATES.ASLEEP || this._pending === "wake") {
				// Already awake, or already counting down to it. Repeated presence
				// pings must not restart the wake delay, or a user standing still
				// would postpone the boot indefinitely.
				return;
			}

			this._startTimer("wake", () => {
				this.shortGreet = this._lastAsleepAt !== null
					&& (this._now() - this._lastAsleepAt) < this.config.greetingCooldownMs;
				this._transitionTo(STATES.WAKING);
			}, this.config.wakeDelayMs);
		}

		_onAbsent () {
			if (this.state === STATES.ASLEEP) {
				if (this._pending === "wake") this._cancelTimer();
				return;
			}

			if (this.state === STATES.LEAVING || this._pending === "goodbye") return;

			this._interrupted = this.state;
			this._startTimer("goodbye", () => {
				this._transitionTo(STATES.LEAVING);
			}, this.config.goodbyeDelayMs);
		}

		_startTimer (kind, fn, ms) {
			this._cancelTimer();
			this._pending = kind;
			this._timerId = this._setTimer(() => {
				this._timerId = null;
				this._pending = null;
				fn();
			}, ms);
		}

		_cancelTimer () {
			if (this._timerId !== null) this._clearTimer(this._timerId);
			this._timerId = null;
			this._pending = null;
		}

		_transitionTo (next) {
			const from = this.state;
			this.state = next;
			if (next === STATES.ASLEEP) {
				this._lastAsleepAt = this._now();
				this.shortGreet = false;
			}
			this._onTransition(from, next);
		}
	}

	return { StateMachine, STATES, AWAKE_STATES };
}));
