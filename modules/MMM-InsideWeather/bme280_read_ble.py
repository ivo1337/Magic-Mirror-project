#!/usr/bin/env python3
"""Read BME280 sensor data from ESP32 over BLE. Drop-in replacement for bme280_read.py.
Outputs JSON to stdout: {"temperature": ..., "humidity": ..., "pressure": ...}
Requires: pip install bleak
"""

import asyncio
import json
import sys

from bleak import BleakClient, BleakScanner

DEVICE_NAME = "BME280-Sensor"
JSON_CHAR_UUID = "00002a00-0000-1000-8000-00805f9b34fc"


async def main():
    device = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=10)
    if device is None:
        print(json.dumps({"error": "BME280-Sensor not found"}), file=sys.stderr)
        sys.exit(1)

    async with BleakClient(device) as client:
        raw = await client.read_gatt_char(JSON_CHAR_UUID)
        data = json.loads(raw.decode("utf-8"))
        print(json.dumps({
            "temperature": round(data["temperature"], 1),
            "humidity": round(data["humidity"], 1),
            "pressure": round(data["pressure"], 2)
        }))


if __name__ == "__main__":
    asyncio.run(main())
