#!/usr/bin/env python3
"""
HMMD mmWave Sensor (Waveshare, 24GHz, S3KM1110 family) live terminal monitor.

Shows presence, target distance and the per-gate energy map in report mode.

NOTE ON ANGLE: this module has a 1-transmit / 1-receive antenna. Angle-of-arrival
requires >=2 RX antennas to compare phase between them, so the hardware cannot
report bearing. What it does give is range: 16 distance gates of 70cm each.
This script renders that gate energy map, which shows how far away the energy is
along the beam, not which direction within it.

Protocol reference: https://www.waveshare.com/wiki/HMMD_mmWave_Sensor
"""

import argparse
import collections
import fcntl
import json
import os
import shutil
import struct
import sys
import time

import serial

# --- Protocol constants -----------------------------------------------------

CMD_HEAD = b"\xfd\xfc\xfb\xfa"
CMD_TAIL = b"\x04\x03\x02\x01"

# Report-mode data frames use their own framing.
REPORT_HEAD = b"\xf4\xf3\xf2\xf1"
REPORT_TAIL = b"\xf8\xf7\xf6\xf5"

# Debug-mode (RD-map) frames, recognised only so we can warn about them.
DEBUG_HEAD = b"\xaa\xbf\x10\x14"

# Mode-select command 0x0012, little-endian 32-bit value.
MODE_VALUES = {"normal": 0x64, "report": 0x04, "debug": 0x00}

# Config-mode gate. Undocumented in the Waveshare wiki but present in this chip
# family (same framing as the LD2410): the module ACKs both, and it stops
# emitting data frames while config mode is open.
CMD_ENABLE_CONFIG = 0x00FF
CMD_END_CONFIG = 0x00FE

NUM_GATES = 16
GATE_LENGTH_M = 0.70

# report payload: 1 byte presence + 2 byte distance + 16*2 byte energies
REPORT_PAYLOAD_LEN = 1 + 2 + NUM_GATES * 2


def build_command(cmd_word: int, value: bytes = b"") -> bytes:
    """Wrap a command word + value in the FD FC FB FA / 04 03 02 01 frame."""
    body = struct.pack("<H", cmd_word) + value
    return CMD_HEAD + struct.pack("<H", len(body)) + body + CMD_TAIL


def set_mode_command(mode: str) -> bytes:
    # 0x0012 takes a 2-byte sub-field (always 0x0000) ahead of the 4-byte value,
    # giving the in-frame length of 0x0008 shown in the datasheet examples.
    return build_command(0x0012, b"\x00\x00" + struct.pack("<I", MODE_VALUES[mode]))


class SensorBusy(RuntimeError):
    """The serial port is already held by another reader."""


def serial_holder_pid(port):
    """PID of a process holding `port` open, or None.

    flock() does not report the holder, so walk /proc. Used only to turn a
    confusing double-open into one clear line, so a best-effort answer is fine.
    """
    try:
        target = os.path.realpath(port)
    except OSError:
        return None
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        fd_dir = os.path.join("/proc", entry, "fd")
        try:
            for fd in os.listdir(fd_dir):
                try:
                    if os.readlink(os.path.join(fd_dir, fd)) == target:
                        return int(entry)
                except OSError:
                    # The fd closed under us, or is not ours to read.
                    continue
        except OSError:
            # Process exited between listdir and open, or is another user's.
            continue
    return None


def lock_serial(fd, port):
    """Take an exclusive, non-blocking lock on an open serial fd.

    Two readers on one UART steal each other's bytes and neither assembles a
    valid frame. The failure looks like a dying sensor rather than a conflict,
    so refuse it loudly at open time instead.
    """
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        pid = serial_holder_pid(port)
        who = f"PID {pid}" if pid is not None else "another process"
        raise SensorBusy(f"sensor busy: {port} is held by {who}") from None


# --- Frame parsing ----------------------------------------------------------


class ReportFrame:
    __slots__ = ("present", "distance_cm", "energies")

    def __init__(self, present, distance_cm, energies):
        self.present = present
        self.distance_cm = distance_cm
        self.energies = energies

    @property
    def distance_m(self):
        return self.distance_cm / 100.0

    @property
    def peak_gate(self):
        """Index of the strongest gate, or None if the map is flat/empty."""
        top = max(self.energies)
        return self.energies.index(top) if top > 0 else None

    def as_dict(self):
        return {
            "present": self.present,
            "distance_cm": self.distance_cm,
            "distance_m": round(self.distance_m, 2),
            "peak_gate": self.peak_gate,
            "energies": self.energies,
        }


def parse_report(payload: bytes):
    """Parse the 35-byte report-mode payload."""
    if len(payload) < REPORT_PAYLOAD_LEN:
        return None
    present = payload[0] == 0x01
    (distance_cm,) = struct.unpack_from("<H", payload, 1)
    energies = list(struct.unpack_from("<%dH" % NUM_GATES, payload, 3))
    return ReportFrame(present, distance_cm, energies)


class FrameReader:
    """Incremental byte-stream framer. Resyncs on garbage rather than dying."""

    def __init__(self):
        self.buf = bytearray()
        self.saw_debug = False

    def feed(self, data: bytes):
        self.buf.extend(data)
        # Bound the buffer so a silent/garbage link can't grow it forever.
        if len(self.buf) > 8192:
            del self.buf[:-4096]
        return list(self._drain())

    def _drain(self):
        while True:
            start = self.buf.find(REPORT_HEAD)
            if start < 0:
                if DEBUG_HEAD in self.buf:
                    self.saw_debug = True
                # Keep a short tail in case a header straddles two reads.
                if len(self.buf) > 4:
                    del self.buf[: -4]
                return
            if start:
                del self.buf[:start]

            if len(self.buf) < 6:
                return
            (length,) = struct.unpack_from("<H", self.buf, 4)
            if length > 512:  # implausible -> bad sync, skip this header
                del self.buf[:4]
                continue

            end = 6 + length
            if len(self.buf) < end + 4:
                return
            payload = bytes(self.buf[6:end])
            tail = bytes(self.buf[end : end + 4])
            if tail != REPORT_TAIL:
                del self.buf[:4]  # false header, resync
                continue

            del self.buf[: end + 4]
            frame = parse_report(payload)
            if frame is not None:
                yield frame


# --- Person detection -------------------------------------------------------

BASELINE_PATH = os.path.expanduser("~/.hmmd_baseline.json")

# Used when no calibration file exists. Measured noise floor sat around 10-80,
# so this is deliberately conservative.
DEFAULT_BASELINE = [80.0] * NUM_GATES

# (min_snr, min_energy, min_gates)
#
# min_gates is 1 by design. Measured against this module: a person at ~1 m puts
# essentially all of their energy into a single 0.70 m gate (median 3128 in
# gate 1, 338 in gate 2, ~65 beyond). Demanding 2+ contiguous gates detected
# nothing at all -- 0% of an 11 s capture with someone standing right there.
# Selectivity comes from the energy thresholds instead, which still reject small
# movers because those fail the absolute floor.
PRESETS = {
    "person": (8.0, 1500, 1),   # reject pets/curtains, accept an adult torso
    "strict": (15.0, 2500, 1),  # higher bar; ~96% duty on a real standing person
    "loose": (4.0, 300, 1),     # near raw sensitivity
}

# Received power falls off steeply with range, so the same person produces far
# less energy at 6 m than at 1 m. The absolute-energy test is applied to a
# range-compensated value; 2.0 is a practical exponent for an extended target
# (a point target would be 4.0, but the module already applies its own gain).
RANGE_EXPONENT = 2.0

# Dead zone immediately in front of the antenna, in centimetres. Anything the
# module reports closer than this is discarded outright.
#
# Caveat worth knowing: range gates are 70cm wide, so the energy map cannot tell
# 10cm from 60cm -- both land in gate 0. Only the module's own distance field has
# 1cm resolution, so that is what this vetoes on. Excluding gate 0 entirely
# (--min-range 0.7, the default) is the only way to blank the near field in the
# energy domain.
BLIND_ZONE_CM = 15


def gate_center_m(i):
    return (i + 0.5) * GATE_LENGTH_M


def gate_window(min_range, max_range):
    """
    Gate indices covering [min_range, max_range].

    Gates are 0.70 m wide, so a requested range rarely lands on a boundary. The
    window is taken inclusively at the near end and exclusively at the far end,
    so it never reaches beyond the distance the caller asked for.
    """
    lo = max(0, int(min_range / GATE_LENGTH_M))
    hi = min(NUM_GATES - 1, int(max_range / GATE_LENGTH_M) - 1)
    return lo, hi


def load_baseline(path=BASELINE_PATH):
    try:
        with open(path) as fh:
            data = json.load(fh)
        base = [float(x) for x in data["baseline"]]
        if len(base) == NUM_GATES:
            return base, data.get("captured")
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return list(DEFAULT_BASELINE), None


def save_baseline(baseline, path=BASELINE_PATH):
    with open(path, "w") as fh:
        json.dump({"baseline": baseline,
                   "captured": time.strftime("%Y-%m-%d %H:%M:%S")}, fh, indent=1)


def percentile(values, pct):
    if not values:
        return 0.0
    ordered = sorted(values)
    k = (len(ordered) - 1) * pct
    lo = int(k)
    hi = min(lo + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)


class Detection:
    """Result of applying the person filter to one frame."""

    __slots__ = ("present", "distance_m", "peak_gate", "span_gates", "snr",
                 "thresholds", "gate_lo_hi")

    def __init__(self, present, distance_m, peak_gate, span_gates, snr,
                 thresholds, gate_lo_hi):
        self.present = present
        self.distance_m = distance_m
        self.peak_gate = peak_gate
        self.span_gates = span_gates
        self.snr = snr
        self.thresholds = thresholds
        self.gate_lo_hi = gate_lo_hi

    @property
    def span_m(self):
        return self.span_gates * GATE_LENGTH_M

    def as_dict(self):
        return {
            "present": self.present,
            "distance_m": round(self.distance_m, 2) if self.distance_m is not None else None,
            "peak_gate": self.peak_gate,
            "span_gates": self.span_gates,
            "span_m": round(self.span_m, 2),
            "snr": round(self.snr, 1),
        }


class PersonDetector:
    """
    Size/strength filter over the gate energy map.

    A person is a large reflector: it puts a lot of energy into the map and
    spreads that energy over several adjacent 0.70 m gates. Small movers (a cat,
    a curtain, a fan) clear the noise floor but fail on absolute energy, on
    spatial span, or on both. Thresholds are per-gate multiples of a measured
    noise baseline, which keeps sensitivity roughly even with range -- radar
    return falls off steeply with distance, so a single flat threshold would
    only ever see the near field.
    """

    def __init__(self, baseline, min_snr, min_energy, min_gates,
                 gate_lo, gate_hi, confirm, hold_s, range_exp=RANGE_EXPONENT,
                 window=None, blind_cm=BLIND_ZONE_CM):
        self.baseline = baseline
        self.min_snr = min_snr
        self.min_energy = min_energy
        self.min_gates = min_gates
        self.gate_lo = gate_lo
        self.gate_hi = gate_hi
        self.confirm = confirm
        self.hold_s = hold_s
        self.blind_cm = blind_cm
        # A gate must clear both tests: stand clear of its own measured noise
        # (rejects far-field noise, which range compensation would otherwise
        # amplify), and be genuinely large once compensated for range (rejects
        # small near-field movers). Folded into one equivalent raw threshold.
        self.thresholds = []
        for i in range(NUM_GATES):
            comp = gate_center_m(i) ** range_exp
            self.thresholds.append(max(baseline[i] * min_snr, min_energy / max(comp, 1e-6)))
        # Micro-motion energy swings by more than an order of magnitude between
        # frames, so presence is asserted on N hits within a sliding window of M
        # rather than N in a row -- consecutive-only misses real people.
        self.window = window if window is not None else max(confirm * 3, 8)
        self._recent = collections.deque(maxlen=self.window)
        self._present = False
        self._last_hit = 0.0

    def update(self, frame: ReportFrame, now=None):
        now = time.monotonic() if now is None else now
        window = range(self.gate_lo, self.gate_hi + 1)

        # Hard blind zone. A reported distance of 0 means "no range fix" rather
        # than "at the antenna", so it is left alone; only a real, in-range
        # reading below the limit is vetoed.
        blinded = 0 < frame.distance_cm < self.blind_cm

        above = [] if blinded else [i for i in window
                                    if frame.energies[i] >= self.thresholds[i]]
        peak_gate = None
        span = 0
        snr = 0.0

        if above:
            peak_gate = max(above, key=lambda i: frame.energies[i] / max(self.baseline[i], 1.0))
            snr = frame.energies[peak_gate] / max(self.baseline[peak_gate], 1.0)
            # Length of the contiguous run of above-threshold gates around the peak.
            lo = hi = peak_gate
            while lo - 1 >= self.gate_lo and (lo - 1) in above:
                lo -= 1
            while hi + 1 <= self.gate_hi and (hi + 1) in above:
                hi += 1
            span = hi - lo + 1

        hit = peak_gate is not None and span >= self.min_gates

        # Temporal debounce: N consecutive hits to assert, then hold briefly so a
        # person who goes momentarily still does not flicker the output.
        self._recent.append(bool(hit))
        if hit:
            self._last_hit = now
        if sum(self._recent) >= self.confirm:
            self._present = True
        elif self._present and now - self._last_hit > self.hold_s:
            self._present = False

        distance = frame.distance_m if self._present else None
        return Detection(self._present, distance, peak_gate if self._present else None,
                         span, snr, self.thresholds, (self.gate_lo, self.gate_hi))


def safe_read(ser, size=256):
    """
    Read, tolerating the Pi UART's occasional 'ready but returned no data'.

    Raising there would kill a long-running session, so the port is reopened and
    put back into report mode instead.
    """
    try:
        return ser.read(size)
    except (serial.SerialException, OSError):
        try:
            ser.close()
        except Exception:
            pass
        time.sleep(0.5)
        try:
            ser.open()
            ser.write(build_command(CMD_END_CONFIG))
            ser.flush()
            time.sleep(0.2)
            ser.reset_input_buffer()
            ser.write(set_mode_command("report"))
            ser.flush()
            time.sleep(0.2)
            ser.reset_input_buffer()
        except (serial.SerialException, OSError):
            pass
        return b""


def calibrate(ser, seconds, reader):
    """Sample an empty room and derive a per-gate noise baseline."""
    print(f"Calibrating for {seconds:.0f}s — keep the area EMPTY (leave the room now)...",
          file=sys.stderr)
    samples = [[] for _ in range(NUM_GATES)]
    deadline = time.monotonic() + seconds
    n = 0
    while time.monotonic() < deadline:
        data = safe_read(ser)
        for frame in (reader.feed(data) if data else []):
            n += 1
            for i, e in enumerate(frame.energies):
                samples[i].append(e)
        remaining = deadline - time.monotonic()
        print(f"\r  {remaining:4.1f}s left, {n} frames ", end="", file=sys.stderr, flush=True)
    print(file=sys.stderr)
    if n < 10:
        sys.exit("error: too few frames captured to calibrate; is the sensor streaming?")
    # 95th percentile, so occasional noise spikes do not sit under the baseline.
    baseline = [max(percentile(s, 0.95), 1.0) for s in samples]
    save_baseline(baseline)
    print(f"Baseline from {n} frames written to {BASELINE_PATH}:", file=sys.stderr)
    print("  " + " ".join(f"{b:.0f}" for b in baseline), file=sys.stderr)
    return baseline


# --- Rendering --------------------------------------------------------------

RESET = "\x1b[0m"
BOLD = "\x1b[1m"
DIM = "\x1b[2m"
RED = "\x1b[31m"
GREEN = "\x1b[32m"
YELLOW = "\x1b[33m"
CYAN = "\x1b[36m"

BLOCKS = " ▁▂▃▄▅▆▇█"


def bar(value, vmax, width):
    if vmax <= 0:
        return " " * width
    filled = value / vmax * width
    full = int(filled)
    out = "█" * min(full, width)
    if full < width:
        frac = filled - full
        out += BLOCKS[int(frac * (len(BLOCKS) - 1))]
    return out.ljust(width)


def render(frame: ReportFrame, det: Detection, use_color: bool, scale_max):
    cols = shutil.get_terminal_size((80, 24)).columns
    c = (lambda s, code: f"{code}{s}{RESET}") if use_color else (lambda s, code: s)

    lines = []
    if det.present:
        status = c(" ● PERSON DETECTED ", BOLD + GREEN)
        dist = c(f"{det.distance_m:5.2f} m", BOLD + CYAN)
        detail = f"(span {det.span_m:3.1f} m over {det.span_gates} gates · SNR {det.snr:5.0f}x)"
    else:
        status = c(" ○ clear           ", DIM)
        dist = c("  --  m", DIM)
        # Show why a sub-threshold return was rejected, rather than hiding it.
        if frame.present:
            detail = c(f"(sensor sees motion, filtered out: span {det.span_gates}, "
                       f"SNR {det.snr:4.0f}x)", DIM)
        else:
            detail = ""

    lines.append(f"{status}  distance {dist}  {c(detail, DIM) if det.present else detail}")
    lines.append(f"  {c('bearing/angle: n/a (1T1R antenna — see --help)', DIM)}")
    lines.append("")

    bar_w = max(10, min(40, cols - 44))
    lines.append(c("  gate   range        energy                    thresh   state", DIM))
    for i, e in enumerate(frame.energies):
        near = i * GATE_LENGTH_M
        far = near + GATE_LENGTH_M
        thr = det.thresholds[i]
        over = e >= thr and det.gate_lo_hi[0] <= i <= det.gate_lo_hi[1]
        b = bar(e, scale_max, bar_w)
        mark = "◆" if (det.present and i == det.peak_gate) else ("▲" if over else " ")
        head = f"  {i:2d}  {near:4.1f}-{far:4.1f}m  "
        tail = f" {e:6d}  {thr:7.0f}   {mark}"
        if det.present and i == det.peak_gate:
            lines.append(c(head + b + tail, YELLOW))
        elif over:
            lines.append(head + c(b, GREEN) + c(tail, GREEN))
        else:
            lines.append(head + c(b, CYAN) + c(tail, DIM))
    return lines


def draw(lines, prev_count):
    if prev_count:
        sys.stdout.write(f"\x1b[{prev_count}A")
    for ln in lines:
        sys.stdout.write("\x1b[2K" + ln + "\n")
    sys.stdout.flush()
    return len(lines)


# --- Main -------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser(
        description="Live monitor for the Waveshare HMMD 24GHz mmWave sensor.",
        epilog=(
            "The sensor has one TX and one RX antenna, so it cannot measure angle "
            "or bearing — only presence and range. The gate map below shows energy "
            "at each 0.70 m range bin."
        ),
    )
    # UART2 (GPIO4 TX / GPIO5 RX) per the dtoverlay=uart2-pi5 line in config.txt.
    # /dev/serial0 is not usable here — it carries the login console.
    ap.add_argument("-p", "--port", default="/dev/ttyAMA2", help="serial port (default: %(default)s)")
    ap.add_argument("-b", "--baud", type=int, default=115200, help="baud rate (default: %(default)s)")
    ap.add_argument("--mode", choices=sorted(MODE_VALUES), default="report",
                    help="sensor output mode to request (default: %(default)s)")
    ap.add_argument("--json", action="store_true", help="emit one JSON object per frame instead of a live display")
    ap.add_argument("--raw", action="store_true", help="dump raw bytes as hex; no parsing")
    ap.add_argument("--no-color", action="store_true", help="disable ANSI color")
    ap.add_argument("--scale", type=int, default=0,
                    help="fixed energy scale for bars (default: auto-track observed peak)")

    g = ap.add_argument_group("person filter")
    g.add_argument("--preset", choices=sorted(PRESETS), default="person",
                   help="sensitivity preset (default: %(default)s)")
    g.add_argument("--min-snr", type=float, help="energy must exceed baseline x this (overrides preset)")
    g.add_argument("--min-energy", type=int, help="absolute energy floor (overrides preset)")
    g.add_argument("--min-gates", type=int,
                   help="contiguous gates required; a person spans 2+ (overrides preset)")
    g.add_argument("--min-range", type=float, default=0.7, metavar="M",
                   help="ignore returns closer than this; gate 0 holds TX/RX leakage (default: %(default)s)")
    g.add_argument("--blind-cm", type=int, default=BLIND_ZONE_CM, metavar="CM",
                   help="hard dead zone at the antenna; targets reported nearer are "
                        "discarded (default: %(default)s)")
    g.add_argument("--max-range", type=float, default=8.4, metavar="M",
                   help="ignore returns beyond this (default: %(default)s)")
    g.add_argument("--confirm", type=int, default=3, metavar="N",
                   help="consecutive frames required to assert presence (default: %(default)s)")
    g.add_argument("--hold", type=float, default=2.0, metavar="SEC",
                   help="keep presence this long after last hit (default: %(default)s)")
    g.add_argument("--calibrate", type=float, nargs="?", const=10.0, metavar="SEC",
                   help="sample an EMPTY room for SEC seconds and store the noise baseline")
    g.add_argument("--no-filter", action="store_true",
                   help="report the sensor's raw presence flag, unfiltered")
    args = ap.parse_args()

    snr, energy, gates = PRESETS[args.preset]
    if args.min_snr is not None:
        snr = args.min_snr
    if args.min_energy is not None:
        energy = args.min_energy
    if args.min_gates is not None:
        gates = args.min_gates
    if args.no_filter:
        snr, energy, gates, args.confirm, args.hold = 0.0, 0, 1, 1, 0.0

    use_color = not args.no_color and sys.stdout.isatty()

    try:
        ser = serial.Serial(args.port, args.baud, timeout=0.2)
    except serial.SerialException as e:
        sys.exit(f"error: cannot open {args.port}: {e}")

    try:
        lock_serial(ser.fileno(), args.port)
    except SensorBusy as e:
        ser.close()
        sys.exit(f"error: {e}")

    with ser:
        time.sleep(0.1)
        ser.reset_input_buffer()
        # Close any config session left open by a previous run, otherwise the
        # module stays silent and no amount of mode-setting brings it back.
        ser.write(build_command(CMD_END_CONFIG))
        ser.flush()
        time.sleep(0.2)
        ser.reset_input_buffer()
        ser.write(set_mode_command(args.mode))
        ser.flush()
        time.sleep(0.2)
        ser.reset_input_buffer()

        if args.raw:
            print(f"# raw dump from {args.port} @ {args.baud} (Ctrl-C to stop)", file=sys.stderr)
            try:
                while True:
                    data = ser.read(64)
                    if data:
                        sys.stdout.write(data.hex(" ") + "\n")
                        sys.stdout.flush()
            except KeyboardInterrupt:
                return

        if args.mode != "report":
            print(f"# mode '{args.mode}' does not emit parseable target frames; "
                  f"showing raw output. Use --mode report for the live display.",
                  file=sys.stderr)
            try:
                while True:
                    data = ser.read(256)
                    if data:
                        sys.stdout.write(data.decode("utf-8", "replace"))
                        sys.stdout.flush()
            except KeyboardInterrupt:
                return

        reader = FrameReader()

        if args.calibrate:
            baseline = calibrate(ser, args.calibrate, reader)
            captured = "just now"
        else:
            baseline, captured = load_baseline()

        gate_lo, gate_hi = gate_window(args.min_range, args.max_range)
        if gate_lo > gate_hi:
            sys.exit("error: --min-range must be below --max-range")

        detector = PersonDetector(baseline, snr, energy, gates,
                                  gate_lo, gate_hi, args.confirm, args.hold,
                                  blind_cm=args.blind_cm)

        prev_lines = 0
        scale_max = args.scale or 1
        last_frame_at = time.monotonic()
        warned_debug = False

        if not args.json:
            print(f"HMMD mmWave Sensor — {args.port} @ {args.baud}  (Ctrl-C to stop)")
            if args.no_filter:
                print("filter: OFF (raw sensor presence)")
            else:
                print(f"filter: {args.preset}  SNR>{snr:g}x  energy>{energy}  "
                      f"span>={gates} gates  range {args.min_range:g}-{args.max_range:g}m")
            if captured is None:
                print(f"{DIM}baseline: default (uncalibrated) — run --calibrate "
                      f"in an empty room for best rejection{RESET}")
            else:
                print(f"{DIM}baseline: {captured}{RESET}")
            print()

        try:
            while True:
                data = safe_read(ser)
                frames = reader.feed(data) if data else []

                if reader.saw_debug and not warned_debug and not args.json:
                    warned_debug = True
                    print("# note: debug-mode RD-map frames seen on the link", file=sys.stderr)

                now = time.monotonic()
                if not frames:
                    if now - last_frame_at > 3.0 and not args.json:
                        print("\n# no report frames for 3s — check wiring (TX↔RX crossed?) "
                              "and that the serial console is disabled on this port.",
                              file=sys.stderr)
                        last_frame_at = now
                    continue

                last_frame_at = now
                for frame in frames:
                    det = detector.update(frame, now)
                    if args.json:
                        out = det.as_dict()
                        out["raw_present"] = frame.present
                        out["energies"] = frame.energies
                        print(json.dumps(out), flush=True)
                        continue
                    if not args.scale:
                        peak = max(frame.energies)
                        if peak > scale_max:
                            scale_max = peak
                    prev_lines = draw(render(frame, det, use_color, scale_max), prev_lines)
        except KeyboardInterrupt:
            if not args.json:
                sys.stdout.write("\n")
            return


if __name__ == "__main__":
    main()
