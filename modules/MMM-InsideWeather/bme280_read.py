#!/usr/bin/env python3
"""Read BME280 sensor data and output as JSON. Used by MMM-InsideWeather node_helper."""

import json
import sys

import smbus2
import bme280


def main():
    bus_no = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    address = int(sys.argv[2], 0) if len(sys.argv) > 2 else 0x76

    bus = smbus2.SMBus(bus_no)
    try:
        calibration_params = bme280.load_calibration_params(bus, address)
        data = bme280.sample(bus, address, calibration_params)
        print(json.dumps({
            "temperature": round(data.temperature, 1),
            "humidity": round(data.humidity, 1),
            "pressure": round(data.pressure, 2)
        }))
    finally:
        bus.close()


if __name__ == "__main__":
    main()
