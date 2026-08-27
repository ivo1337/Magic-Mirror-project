Module.register("MMM-InsideWeather", {
	defaults: {
		updateInterval: 60000,
		i2cBusNo: 1,
		i2cAddress: 0x76,
		units: config.units || "metric",
		decimalSymbol: ".",
		showHumidity: true,
		showAltitude: true,
		seaLevelPressure: 1013.25
	},

	sensorData: null,

	getStyles () {
		return ["MMM-InsideWeather.css"];
	},

	getHeader () {
		return "Inside Temperature";
	},

	start () {
		this.sendSocketNotification("START_SENSOR", this.config);
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "SENSOR_DATA") {
			this.sensorData = payload;
			this.updateDom(300);
		}
	},

	getDom () {
		const wrapper = document.createElement("div");

		if (!this.sensorData) {
			wrapper.className = "dimmed light small";
			wrapper.textContent = "Sensor not detected";
			return wrapper;
		}

		// Main temperature row — matches weather module's large display
		const tempRow = document.createElement("div");
		tempRow.className = "flex large type-temp";

		const tempIcon = document.createElement("span");
		tempIcon.className = "light fas fa-thermometer-half sensor-icon";
		tempRow.appendChild(tempIcon);

		const tempValue = document.createElement("span");
		tempValue.className = "light bright";
		tempValue.textContent = this.formatTemperature(this.sensorData.temperature);
		tempRow.appendChild(tempValue);

		wrapper.appendChild(tempRow);

		// Secondary metrics row — matches weather module's "normal medium" style
		if (this.config.showHumidity || this.config.showAltitude) {
			const secondaryRow = document.createElement("div");
			secondaryRow.className = "normal medium secondary-row";

			if (this.config.showHumidity) {
				const humidityIcon = document.createElement("span");
				humidityIcon.className = "fas fa-tint dimmed sensor-icon";
				secondaryRow.appendChild(humidityIcon);

				const humidityText = document.createElement("span");
				humidityText.className = "dimmed";
				humidityText.innerHTML = `&nbsp;${this.formatDecimal(this.sensorData.humidity)}%`;
				secondaryRow.appendChild(humidityText);
			}

			if (this.config.showHumidity && this.config.showAltitude) {
				const sep = document.createElement("span");
				sep.className = "separator dimmed";
				sep.textContent = " ";
				secondaryRow.appendChild(sep);
			}

			if (this.config.showAltitude) {
				const altIcon = document.createElement("span");
				altIcon.className = "fas fa-mountain dimmed sensor-icon";
				secondaryRow.appendChild(altIcon);

				const altitude = this.calculateAltitude(this.sensorData.pressure);
				const altText = document.createElement("span");
				altText.className = "dimmed";
				altText.innerHTML = `&nbsp;${this.formatDecimal(altitude)}m`;
				secondaryRow.appendChild(altText);
			}

			wrapper.appendChild(secondaryRow);
		}

		return wrapper;
	},

	formatTemperature (temp) {
		if (this.config.units === "imperial") {
			const fahrenheit = Math.round(temp * 9 / 5 + 32);
			return `${fahrenheit}\u00B0F`;
		}
		return `${Math.round(temp)}\u00B0C`;
	},

	formatDecimal (value) {
		return String(Math.round(value * 10) / 10).replace(".", this.config.decimalSymbol);
	},

	calculateAltitude (pressureHpa) {
		// Barometric formula: altitude = 44330 * (1 - (P / P0)^0.1903)
		const ratio = pressureHpa / this.config.seaLevelPressure;
		return Math.round(44330 * (1 - Math.pow(ratio, 0.1903)));
	}
});
