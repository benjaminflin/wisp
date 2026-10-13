#!/usr/bin/env python3
"""Unit tests for the worker's trickiest logic.

Covers the two things that have actually gone wrong in practice: a CoreAudio
teardown that never returns, and non-speech reaching Whisper. Both are tested
with synthetic inputs so the results do not depend on the room or the hardware.

    python3 scripts/test_worker.py
"""
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))
import wisp_worker as ww  # noqa: E402

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, ok))
    print(f"  {'\033[32mPASS\033[0m' if ok else '\033[31mFAIL\033[0m'}  {name}{f' — {detail}' if detail else ''}")


class HangingStream:
    """Mimics the observed deadlock: stop() never returns."""

    def stop(self):
        time.sleep(600)

    def close(self):
        pass

    def abort(self):
        time.sleep(600)


class CleanStream:
    def __init__(self):
        self.stopped = False
        self.closed = False

    def stop(self):
        self.stopped = True

    def close(self):
        self.closed = True

    def abort(self):
        self.stopped = True


def test_close_stream():
    print("\nteardown watchdog")
    started = time.time()
    ok = ww._close_stream(HangingStream(), 0.5)
    elapsed = time.time() - started
    check(
        "a hanging teardown is abandoned rather than waited on",
        ok is False and elapsed < 2.0,
        f"returned {ok} after {elapsed:.2f}s",
    )

    stream = CleanStream()
    ok = ww._close_stream(stream, 2.0)
    check("a healthy teardown still closes the stream", ok is True and stream.closed)


def test_recorder_keeps_audio():
    print("\ncaptured audio survives a stuck teardown")
    recorder = ww.Recorder()
    recorder._active = True
    recorder._stream = HangingStream()
    recorder._device_rate = ww.SAMPLE_RATE
    recorder._started_at = time.monotonic() - 1.0

    tone = (np.random.RandomState(0).rand(16000).astype(np.float32) - 0.5) * 0.4
    with recorder._lock:
        recorder._chunks = [tone]
        recorder._peak = float(np.abs(tone).max())
        recorder._sumsq = float(np.square(tone).sum())
        recorder._count = int(tone.size)

    started = time.time()
    audio, _duration, _rms, _peak, teardown_ok = recorder.stop(timeout=0.5)
    elapsed = time.time() - started

    check(
        "the audio is still returned when the stream will not close",
        audio.size == tone.size and teardown_ok is False,
        f"kept {audio.size} samples in {elapsed:.2f}s, teardown_ok={teardown_ok}",
    )


def test_gates():
    print("\nnon-speech gates")
    silence = np.zeros(ww.SAMPLE_RATE * 2, dtype=np.float32)
    check(
        "digital silence never reaches the model",
        ww.speech_rejection_reason(silence, 0.005) == "silence",
    )

    noise = (np.random.RandomState(1).rand(ww.SAMPLE_RATE * 2).astype(np.float32) * 2 - 1) * 0.02
    reason = ww.speech_rejection_reason(noise, 0.005)
    check("broadband noise never reaches the model", reason == "non_speech", str(reason))

    # Speech must survive: a synthetic voiced-ish signal (bursty, low flatness).
    t = np.arange(ww.SAMPLE_RATE * 2) / ww.SAMPLE_RATE
    speech = (0.3 * np.sin(2 * np.pi * 140 * t) * (0.5 + 0.5 * np.sin(2 * np.pi * 4 * t))).astype(
        np.float32
    )
    reason = ww.speech_rejection_reason(speech, 0.005)
    check("a voiced, bursty signal is accepted", reason is None, str(reason))


def main():
    print("\n\x1b[1mWisp worker tests\x1b[0m")
    test_close_stream()
    test_recorder_keeps_audio()
    test_gates()

    failed = [name for name, ok in RESULTS if not ok]
    print(
        f"\n{'All checks passed' if not failed else f'{len(failed)} check(s) failed'} "
        f"({len(RESULTS) - len(failed)}/{len(RESULTS)})\n"
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
