#!/usr/bin/env python3
"""
Presence-driven monitor brightness for the Waveshare HMMD mmWave sensor.

Fades the monitor smoothly up to full brightness when a person is detected
within range, and smoothly down to zero once the area has been clear for a
while. Brightness is driven over DDC/CI straight to the monitor's own backlight
control, so it dims the actual panel rather than washing out the framebuffer.

Fades are interruptible: walking back in during a fade-out reverses it from
wherever it had reached instead of snapping or waiting for it to finish.

Requires the sensor set up as per hmmd_monitor.py, and a DDC/CI-capable monitor.
"""

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.request

import serial
from smbus2 import SMBus, i2c_msg

from hmmd_monitor import (
    BLIND_ZONE_CM,
    CMD_END_CONFIG,
    GATE_LENGTH_M,
    NUM_GATES,
    PRESETS,
    FrameReader,
    PersonDetector,
    SensorBusy,
    build_command,
    gate_center_m,
    gate_window,
    load_baseline,
    lock_serial,
    set_mode_command,
)

DDC_ADDR = 0x37
VCP_BRIGHTNESS = 0x10

# Power mode. Brightness 0 is the *minimum backlight*, not darkness -- an LCD
# with its backlight at the floor still glows dim grey, so no value of VCP 0x10
# can ever make the panel black. Cutting the backlight outright needs DPMS.
VCP_POWER = 0xD6
DPMS_ON = 0x01
DPMS_OFF = 0x05

# The DDC spec asks for a gap between writes; 25ms is comfortably above what
# this panel needed in testing while still allowing ~40 steps/second.
MIN_WRITE_INTERVAL = 0.025

# Monitors take a moment to relight after DPMS wake; writing brightness into
# that window is ignored by some panels, so settle before fading up.
WAKE_SETTLE = 1.0


class Backlight:
    """Monitor backlight over DDC/CI."""

    def __init__(self, bus_no, addr=DDC_ADDR, vcp=VCP_BRIGHTNESS):
        self.bus_no = bus_no
        self.addr = addr
        self.vcp = vcp
        self._bus = None
        self._last_written = None
        self._last_write_at = 0.0
        self.errors = 0

    def open(self):
        self._bus = SMBus(self.bus_no)

    def close(self):
        if self._bus is not None:
            try:
                self._bus.close()
            finally:
                self._bus = None

    def _write(self, value, vcp=None):
        hi, lo = (value >> 8) & 0xFF, value & 0xFF
        frame = [0x51, 0x84, 0x03, self.vcp if vcp is None else vcp, hi, lo]
        chk = self.addr << 1
        for b in frame:
            chk ^= b
        self._bus.i2c_rdwr(i2c_msg.write(self.addr, frame + [chk]))

    def set_power(self, on):
        """Switch the panel on or off via DPMS. True black, unlike brightness 0."""
        try:
            self._write(DPMS_ON if on else DPMS_OFF, vcp=VCP_POWER)
        except OSError:
            self.errors += 1
            return False
        if on:
            # The panel relights with whatever brightness it pleases; forget the
            # cache so the next set() is actually transmitted.
            self._last_written = None
        return True

    def set(self, value, force=False):
        """Write a brightness value, rate-limited and de-duplicated."""
        value = max(0, min(100, int(round(value))))
        now = time.monotonic()
        if not force:
            if value == self._last_written:
                return False
            if now - self._last_write_at < MIN_WRITE_INTERVAL:
                return False
        try:
            self._write(value)
            self._last_written = value
            self._last_write_at = now
            return True
        except OSError:
            # Monitor asleep, unplugged, or briefly busy. Not fatal -- the next
            # tick retries, and forgetting the cached value forces a re-send.
            self.errors += 1
            self._last_written = None
            self._last_write_at = now
            return False

    def read(self):
        """Current brightness, or None if the monitor will not answer."""
        try:
            self._bus.i2c_rdwr(i2c_msg.write(self.addr, [0x51, 0x82, 0x01, self.vcp, 0x6E ^ 0x51 ^ 0x82 ^ 0x01 ^ self.vcp]))
            time.sleep(0.05)
            rd = i2c_msg.read(self.addr, 12)
            self._bus.i2c_rdwr(rd)
            data = list(bytes(rd))
            if len(data) >= 10 and data[2] == 0x02:
                return (data[8] << 8) | data[9]
        except OSError:
            pass
        return None


def detect_i2c_bus():
    """Ask ddcutil which i2c bus the monitor is on."""
    try:
        out = subprocess.run(["ddcutil", "detect", "--terse"],
                             capture_output=True, text=True, timeout=60).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"/dev/i2c-(\d+)", out)
    return int(m.group(1)) if m else None


def smoothstep(p):
    """Ease in and out, so the fade starts and stops gently."""
    p = max(0.0, min(1.0, p))
    return p * p * (3.0 - 2.0 * p)


def detected_distance(det):
    """Distance to the detection, in metres.

    The sensor's distance field sometimes reads 0 even on a solid detection,
    so fall back to the centre of whichever gate actually fired.
    """
    dist = det.distance_m
    if not dist and det.peak_gate is not None:
        dist = gate_center_m(det.peak_gate)
    return dist


def main():
    ap = argparse.ArgumentParser(
        description="Fade the monitor up when a person is near, down when the area is clear.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("-p", "--port", default="/dev/ttyAMA2", help="sensor serial port")
    ap.add_argument("-b", "--baud", type=int, default=115200, help="sensor baud rate")
    ap.add_argument("--i2c-bus", type=int, default=None,
                    help="monitor i2c bus (default: auto-detect via ddcutil)")

    d = ap.add_argument_group("detection")
    d.add_argument("--preset", choices=sorted(PRESETS), default="strict", help="sensitivity preset")
    d.add_argument("--max-range", type=float, default=3.0, metavar="M", help="ignore people beyond this")
    d.add_argument("--min-range", type=float, default=0.7, metavar="M", help="ignore returns closer than this")
    d.add_argument("--blind-cm", type=int, default=BLIND_ZONE_CM, metavar="CM",
                   help="hard dead zone at the antenna; nearer targets are discarded")
    d.add_argument("--min-snr", type=float, default=None, help="override preset SNR multiple")
    d.add_argument("--min-energy", type=int, default=None, help="override preset energy floor")
    d.add_argument("--min-gates", type=int, default=None, help="override preset contiguous-gate count")
    d.add_argument("--confirm", type=int, default=3, metavar="N",
                   help="hits required within the sliding window to assert presence")
    d.add_argument("--hold", type=float, default=2.0, metavar="SEC", help="detector presence hold")

    f = ap.add_argument_group("brightness")
    f.add_argument("--timeout", type=float, default=30.0, metavar="SEC",
                   help="clear time before fading down")
    f.add_argument("--fade-in", type=float, default=1.0, metavar="SEC", help="fade-up duration")
    f.add_argument("--fade-out", type=float, default=3.0, metavar="SEC", help="fade-down duration")
    f.add_argument("--max-brightness", type=int, default=100, metavar="N", help="brightness when present")
    f.add_argument("--min-brightness", type=int, default=0, metavar="N", help="brightness when clear")
    f.add_argument("--on-exit", type=int, default=None, metavar="N",
                   help="brightness to restore on exit (default: --max-brightness)")
    f.add_argument("--no-power-off", dest="power_off", action="store_false",
                   help="dim only; do not cut the panel with DPMS once faded out "
                        "(leaves it glowing dim grey rather than black)")
    f.set_defaults(power_off=True)
    f.add_argument("-q", "--quiet", action="store_true", help="no per-event logging")

    m = ap.add_argument_group("mirror")
    m.add_argument("--luigi-url", default="http://localhost:8080/MMM-Luigi/presence",
                   metavar="URL", help="post presence transitions here for MMM-Luigi")
    m.add_argument("--no-luigi", dest="luigi", action="store_false",
                   help="do not notify the mirror of presence at all")
    m.set_defaults(luigi=True)
    args = ap.parse_args()

    if args.min_brightness > args.max_brightness:
        sys.exit("error: --min-brightness must not exceed --max-brightness")

    bus_no = args.i2c_bus
    if bus_no is None:
        if not args.quiet:
            print("detecting monitor…", file=sys.stderr)
        bus_no = detect_i2c_bus()
        if bus_no is None:
            sys.exit("error: no DDC/CI monitor found. Pass --i2c-bus N explicitly "
                     "(find it with: ddcutil detect).")

    snr, energy, gates = PRESETS[args.preset]
    if args.min_snr is not None:
        snr = args.min_snr
    if args.min_energy is not None:
        energy = args.min_energy
    if args.min_gates is not None:
        gates = args.min_gates
    baseline, captured = load_baseline()
    gate_lo, gate_hi = gate_window(args.min_range, args.max_range)
    if gate_lo > gate_hi:
        sys.exit("error: --min-range must be below --max-range")

    detector = PersonDetector(baseline, snr, energy, gates,
                              gate_lo, gate_hi, args.confirm, args.hold,
                              blind_cm=args.blind_cm)

    def open_sensor():
        """Open the port and put the module into report mode."""
        s = serial.Serial(args.port, args.baud, timeout=0.02)
        try:
            lock_serial(s.fileno(), args.port)
        except SensorBusy:
            s.close()
            raise
        # Close any config session left open, otherwise the module stays silent.
        s.write(build_command(CMD_END_CONFIG))
        s.flush()
        time.sleep(0.2)
        s.reset_input_buffer()
        s.write(set_mode_command("report"))
        s.flush()
        time.sleep(0.2)
        s.reset_input_buffer()
        return s

    try:
        ser = open_sensor()
    except SensorBusy as e:
        sys.exit(f"error: {e}")
    except serial.SerialException as e:
        sys.exit(f"error: cannot open {args.port}: {e}")

    backlight = Backlight(bus_no)
    try:
        backlight.open()
    except OSError as e:
        ser.close()
        sys.exit(f"error: cannot open i2c bus {bus_no}: {e}")

    restore_to = args.on_exit if args.on_exit is not None else args.max_brightness

    # Without this, SIGTERM (systemctl stop, kill, timeout) skips the cleanup
    # below and leaves the panel dark -- indistinguishable from a dead monitor.
    def _term(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, _term)

    def log(msg):
        if not args.quiet:
            print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

    def notify(present, distance_m=None):
        """Tell the mirror about a presence transition.

        Fire-and-forget on a daemon thread with a short timeout, swallowing
        every error: the mirror being down, restarting or wedged must never
        stall or crash the brightness loop, which is the job that actually
        matters here.
        """
        if not args.luigi:
            return
        payload = json.dumps({"present": present, "distance_m": distance_m}).encode()

        def _post():
            try:
                req = urllib.request.Request(
                    args.luigi_url, data=payload,
                    headers={"Content-Type": "application/json"})
                urllib.request.urlopen(req, timeout=2.0).close()
            except Exception as e:
                # Logged, never raised: a silent integration is impossible to
                # diagnose, but a failing one must still not affect brightness.
                log(f"mirror notify failed ({e.__class__.__name__}): {e}")

        log(f"mirror ← present={present}")
        threading.Thread(target=_post, daemon=True).start()

    with backlight_closing(backlight):
        reader = FrameReader()
        span = max(1, args.max_brightness - args.min_brightness)

        # progress 0.0 = fully dim, 1.0 = fully bright
        progress = 0.0
        backlight.set(args.min_brightness, force=True)

        present = False
        # Tracked separately from `present`: this one follows the detector's
        # own hold rather than the fade timeout, and is what the mirror sees.
        detector_present = False
        panel_off = False
        last_seen = 0.0
        last_tick = time.monotonic()
        last_frame_at = last_tick
        warned_silent = False

        # Gates quantise to 0.70 m, so the window that actually gets scanned
        # rarely lands exactly on the requested metres. Report what it really is.
        eff_lo, eff_hi = gate_lo * GATE_LENGTH_M, (gate_hi + 1) * GATE_LENGTH_M
        log(f"monitor on i2c-{bus_no} · sensor {args.port} · preset {args.preset} "
            f"· gates {gate_lo}-{gate_hi} = {eff_lo:.1f}-{eff_hi:.1f}m "
            f"(requested {args.min_range:g}-{args.max_range:g}m)")
        log(f"baseline: {captured or 'default (uncalibrated)'} · "
            f"timeout {args.timeout:g}s · fade {args.fade_in:g}s up / {args.fade_out:g}s down")
        log(f"brightness {args.min_brightness} → {args.max_brightness}")

        try:
            while True:
                now = time.monotonic()
                dt = now - last_tick
                last_tick = now

                try:
                    data = ser.read(256)
                except (serial.SerialException, OSError) as e:
                    # The Pi UART occasionally reports readiness then returns
                    # nothing. Reopen rather than dying -- this runs for days.
                    log(f"serial error ({e}); reopening {args.port}")
                    try:
                        ser.close()
                    except Exception:
                        pass
                    time.sleep(1.0)
                    try:
                        ser = open_sensor()
                        reader = FrameReader()
                        log("sensor reconnected")
                    except SensorBusy as e2:
                        log(f"{e2}; retrying")
                    except (serial.SerialException, OSError) as e2:
                        log(f"reopen failed ({e2}); retrying")
                    continue

                if data:
                    for frame in reader.feed(data):
                        last_frame_at = now
                        warned_silent = False
                        det = detector.update(frame, now)

                        # The mirror follows the *detector*, not the fade. The
                        # detector clears after its ~2s hold, while the fade
                        # deliberately waits --timeout seconds, so waiting for
                        # the fade would have Luigi waving at an empty room.
                        if det.present != detector_present:
                            detector_present = det.present
                            notify(detector_present,
                                   detected_distance(det) if det.present else None)

                        if det.present:
                            last_seen = now
                            if not present:
                                present = True
                                dist = detected_distance(det)
                                where = f"{dist:.2f} m" if dist else "unknown range"
                                log(f"person at {where} → fading up")
                                if panel_off:
                                    backlight.set_power(True)
                                    panel_off = False
                                    # Relight at the floor so the fade starts
                                    # from black rather than snapping bright.
                                    time.sleep(WAKE_SETTLE)
                                    backlight.set(args.min_brightness, force=True)
                                    now = last_tick = time.monotonic()
                                    last_seen = now
                elif now - last_frame_at > 5.0 and not warned_silent:
                    warned_silent = True
                    log("warning: no sensor frames for 5s")
                    # A dead sensor should put Luigi to sleep rather than freeze
                    # it mid-sentence; det.present can no longer change here.
                    if detector_present:
                        detector_present = False
                        notify(False)

                if present and now - last_seen > args.timeout:
                    present = False
                    log(f"clear for {args.timeout:g}s → fading down")

                # Move progress toward the target; rate depends on direction, so
                # an interrupted fade resumes from where it actually is.
                target = 1.0 if present else 0.0
                duration = args.fade_in if target > progress else args.fade_out
                if duration <= 0:
                    progress = target
                elif progress != target:
                    step = dt / duration
                    if target > progress:
                        progress = min(target, progress + step)
                    else:
                        progress = max(target, progress - step)

                if not panel_off:
                    backlight.set(args.min_brightness + smoothstep(progress) * span)

                # Only cut power once the fade has actually reached the bottom,
                # so the dimming stays smooth and the blackout is the last step.
                if args.power_off and not panel_off and not present and progress <= 0.0:
                    backlight.set_power(False)
                    panel_off = True
                    log("panel off (DPMS)")

                time.sleep(0.005)
        except KeyboardInterrupt:
            pass
        finally:
            # Wake first -- exiting with the panel dark would look like a dead
            # monitor, and brightness writes are ignored while it is off.
            if panel_off:
                backlight.set_power(True)
                time.sleep(WAKE_SETTLE)
            backlight.set(restore_to, force=True)
            log(f"restored brightness to {restore_to}")
            try:
                ser.close()
            except Exception:
                pass


class backlight_closing:
    """Context manager that always closes the i2c bus."""

    def __init__(self, backlight):
        self.backlight = backlight

    def __enter__(self):
        return self.backlight

    def __exit__(self, *exc):
        self.backlight.close()
        return False


if __name__ == "__main__":
    main()
