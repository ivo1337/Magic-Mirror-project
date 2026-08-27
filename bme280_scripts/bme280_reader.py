#!/usr/bin/env python3
"""Read temperature, pressure, and humidity from a BME280 sensor every 30 seconds."""

import time
from datetime import datetime

import smbus2
import bme280

# I2C bus 1, default BME280 address is 0x76 (use 0x77 if SDO pin is high)
I2C_PORT = 1
BME280_ADDRESS = 0x77
INTERVAL_SECONDS = 30

def main():
    bus = smbus2.SMBus(I2C_PORT)
    calibration_params = bme280.load_calibration_params(bus, BME280_ADDRESS)

    print(f"{'Timestamp':<22} {'Temp (°C)':>10} {'Humidity (%)':>13} {'Pressure (hPa)':>15}")
    print("-" * 65)

    try:
        while True:
            data = bme280.sample(bus, BME280_ADDRESS, calibration_params)
            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            print(f"{now:<22} {data.temperature:>10.2f} {data.humidity:>13.2f} {data.pressure:>15.2f}")
            time.sleep(INTERVAL_SECONDS)
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        bus.close()

if __name__ == "__main__":
    main()
