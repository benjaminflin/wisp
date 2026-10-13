#!/usr/bin/env python3
"""Wisp capture worker.

Owns the two things Electron cannot do cleanly: talking to CoreAudio and
running Whisper on the Apple GPU via MLX.

Protocol: newline-delimited JSON on stdin/stdout.

  requests   {"id": 7, "cmd": "start", ...}   -> exactly one reply with that id
  replies    {"id": 7, "ok": true, ...}
  events     {"event": "level", "rms": 0.02}  -> unsolicited, no id

All human-readable logging goes to stderr so stdout stays a clean channel.
"""

from __future__ import annotations

import contextlib
import json
import queue
import sys
import threading
import time
import traceback

import numpy as np

SAMPLE_RATE = 16000
LEVEL_INTERVAL = 0.05  # seconds between level events

# Silence gating uses two independent signals, because either one alone leaks.
# Whisper's own no_speech_prob is not one of them: measured on quiet room tone
# it reported 0.000 while confidently emitting " um".
SPEECH_FRAME_SECONDS = 0.02
MIN_ACTIVE_FRAME_FRACTION = 0.01
# Steady noise can nudge a handful of frames over the floor, so one frame must
# also stand clearly above it. Speech always does; room tone does not. This
# matters for latency as much as accuracy: a clip that reaches Whisper with no
# speech burns the whole temperature-fallback schedule, about six passes.
PEAK_FRAME_MULTIPLE = 2.0
# Mean per-segment log probability. Measured: room tone lands near -2.4 and
# real speech near -0.2, so -1.0 separates them with a wide margin.
CONFIDENCE_FLOOR = -1.0

# ---------------------------------------------------------------- transport

_out: queue.Queue = queue.Queue()
# The protocol channel, captured once. The writer uses this handle rather than
# sys.stdout so that temporarily redirecting sys.stdout for library calls
# cannot steal a reply.
_STDOUT = sys.stdout


@contextlib.contextmanager
def quiet_stdout():
    """Route library chatter to stderr, keeping stdout a clean JSON channel.

    mlx_whisper prints "Detected language: ..." to stdout when it auto-detects,
    even with verbose=False: the guard is `if verbose is not None`, which a
    False value satisfies. Left alone that text interleaves with our replies,
    and because print() writes the message and the newline separately it can
    split a JSON line in half and hang the request that was waiting on it.
    """
    with contextlib.redirect_stdout(sys.stderr):
        yield


def emit(obj: dict) -> None:
    _out.put(obj)


def _writer_loop() -> None:
    while True:
        obj = _out.get()
        if obj is None:
            break
        try:
            _STDOUT.write(json.dumps(obj) + "\n")
            _STDOUT.flush()
        except (BrokenPipeError, ValueError):
            break


def reply(req_id, ok=True, **fields) -> None:
    emit({"id": req_id, "ok": ok, **fields})


def log(message: str) -> None:
    print(f"[wisp-worker] {message}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------- audio io


def list_input_devices() -> list[dict]:
    import sounddevice as sd

    devices = []
    try:
        default_in = sd.default.device[0]
    except Exception:
        default_in = None
    for index, dev in enumerate(sd.query_devices()):
        if dev.get("max_input_channels", 0) < 1:
            continue
        devices.append(
            {
                "index": index,
                "name": dev.get("name", f"Device {index}"),
                "channels": dev.get("max_input_channels", 1),
                "default_samplerate": dev.get("default_samplerate", SAMPLE_RATE),
                "is_default": index == default_in,
            }
        )
    return devices


def _to_mono(block: np.ndarray) -> np.ndarray:
    if block.ndim == 1:
        return block
    if block.shape[1] == 1:
        return block[:, 0]
    return block.mean(axis=1)


def _resample(audio: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    """Resample to Whisper's 16 kHz. scipy when available, linear otherwise."""
    if src_rate == dst_rate or audio.size == 0:
        return audio
    try:
        from math import gcd

        from scipy.signal import resample_poly

        g = gcd(int(src_rate), int(dst_rate))
        return resample_poly(audio, dst_rate // g, src_rate // g).astype(np.float32)
    except Exception:
        n_out = int(round(audio.size * dst_rate / src_rate))
        if n_out <= 0:
            return np.zeros(0, dtype=np.float32)
        src_x = np.linspace(0.0, 1.0, audio.size, endpoint=False)
        dst_x = np.linspace(0.0, 1.0, n_out, endpoint=False)
        return np.interp(dst_x, src_x, audio).astype(np.float32)


class Recorder:
    """Microphone capture that streams level events while it runs."""

    def __init__(self) -> None:
        self._stream = None
        self._chunks: list[np.ndarray] = []
        self._lock = threading.Lock()
        self._active = False
        self._device_rate = SAMPLE_RATE
        self._peak = 0.0
        self._sumsq = 0.0
        self._count = 0
        self._last_level_at = 0.0
        self._started_at = 0.0

    @property
    def active(self) -> bool:
        return self._active

    def _callback(self, indata, frames, time_info, status) -> None:  # noqa: ANN001
        block = _to_mono(np.asarray(indata, dtype=np.float32)).copy()
        with self._lock:
            self._chunks.append(block)
            if block.size:
                self._peak = max(self._peak, float(np.abs(block).max()))
                self._sumsq += float(np.square(block).sum())
                self._count += int(block.size)
        now = time.monotonic()
        if now - self._last_level_at >= LEVEL_INTERVAL:
            self._last_level_at = now
            rms = float(np.sqrt(np.mean(np.square(block)))) if block.size else 0.0
            emit({"event": "level", "rms": round(rms, 5), "elapsed": round(now - self._started_at, 2)})

    def start(self, device: int | None, max_seconds: float) -> None:
        import sounddevice as sd

        if self._active:
            raise RuntimeError("already recording")

        with self._lock:
            self._chunks = []
            self._peak = 0.0
            self._sumsq = 0.0
            self._count = 0

        info = sd.query_devices(device) if device is not None else sd.query_devices(kind="input")
        device_rate = int(info.get("default_samplerate") or SAMPLE_RATE)
        channels = 1
        rate = SAMPLE_RATE

        # Prefer 16 kHz mono; fall back to whatever the device natively speaks.
        try:
            sd.check_input_settings(device=device, samplerate=SAMPLE_RATE, channels=1, dtype="float32")
            self._device_rate = SAMPLE_RATE
        except Exception:
            rate = device_rate
            channels = max(1, min(2, int(info.get("max_input_channels", 1))))
            try:
                sd.check_input_settings(device=device, samplerate=rate, channels=channels, dtype="float32")
            except Exception:
                rate = device_rate
                channels = 1
            self._device_rate = rate
            log(f"16 kHz unsupported on '{info.get('name')}'; capturing at {rate} Hz, {channels}ch")

        self._stream = sd.InputStream(
            device=device,
            samplerate=rate,
            channels=channels,
            dtype="float32",
            callback=self._callback,
            blocksize=0,
        )
        self._started_at = time.monotonic()
        self._last_level_at = 0.0
        self._stream.start()
        self._active = True
        emit({"event": "recording", "state": "started", "device": info.get("name"), "rate": rate})

    def stop(self) -> tuple[np.ndarray, float, float, float]:
        """Returns (audio_16k_mono, duration_seconds, rms, peak)."""
        if not self._active or self._stream is None:
            return np.zeros(0, dtype=np.float32), 0.0, 0.0, 0.0
        self._active = False
        stream, self._stream = self._stream, None
        try:
            stream.stop()
            stream.close()
        except Exception as exc:  # pragma: no cover - device teardown races
            log(f"stream teardown: {exc}")

        duration = time.monotonic() - self._started_at
        with self._lock:
            chunks = self._chunks
            self._chunks = []
            peak = self._peak
            sumsq = self._sumsq
            count = self._count

        if not chunks:
            return np.zeros(0, dtype=np.float32), duration, 0.0, 0.0
        audio = np.concatenate(chunks).astype(np.float32)
        rms = float(np.sqrt(sumsq / count)) if count else 0.0
        audio = _resample(audio, self._device_rate, SAMPLE_RATE)
        return audio, duration, rms, peak

    def abort(self) -> None:
        if self._stream is not None:
            try:
                self._stream.abort()
                self._stream.close()
            except Exception:
                pass
        self._stream = None
        self._active = False
        with self._lock:
            self._chunks = []


# ---------------------------------------------------------------- whisper


def has_speech(audio: np.ndarray, floor: float) -> bool:
    """True when enough 20 ms frames carry real acoustic energy.

    A quiet room still has a measurable overall RMS, but every frame sits at
    roughly the same level. Speech is bursty, so a good share of frames rise
    well above the noise. Requiring only a small active fraction keeps quiet
    talkers while rejecting steady room tone, which is what makes Whisper
    invent words.
    """
    if audio.size < SAMPLE_RATE * 0.2:
        return False
    frame = int(SAMPLE_RATE * SPEECH_FRAME_SECONDS)
    count = audio.size // frame
    if count == 0:
        return False
    frames = audio[: count * frame].reshape(count, frame)
    rms = np.sqrt(np.mean(np.square(frames), axis=1))
    active = float((rms > floor).mean())
    loudest = float(rms.max())
    return active >= MIN_ACTIVE_FRAME_FRACTION and loudest >= floor * PEAK_FRAME_MULTIPLE


def load_wav(path: str) -> np.ndarray:
    """Reads a WAV file as 16 kHz mono float32.

    Only WAV is supported without ffmpeg, which Wisp does not depend on. The
    dictation path never needs this: it hands over raw float32 samples.
    """
    import wave

    with wave.open(path, "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())

    if width == 2:
        audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    elif width == 4:
        audio = np.frombuffer(frames, dtype=np.int32).astype(np.float32) / 2147483648.0
    elif width == 1:
        audio = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError(f"unsupported WAV sample width: {width} bytes")

    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return _resample(audio.astype(np.float32), rate, SAMPLE_RATE)


def transcribe(audio: np.ndarray, model: str, language: str | None, vocabulary: str) -> dict:
    import mlx_whisper

    started = time.monotonic()
    with quiet_stdout():
        result = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=model,
            language=language,
            initial_prompt=vocabulary or None,
            condition_on_previous_text=False,
            verbose=False,
            word_timestamps=False,
        )
    elapsed = time.monotonic() - started
    text = (result.get("text") or "").strip()
    segments = result.get("segments") or []
    avg_logprob = (
        float(np.mean([seg.get("avg_logprob", 0.0) for seg in segments])) if segments else 0.0
    )
    return {
        "text": text,
        "elapsed": round(elapsed, 3),
        "language": result.get("language"),
        "avg_logprob": round(avg_logprob, 3),
    }


# ---------------------------------------------------------------- session


class Session:
    def __init__(self) -> None:
        self.recorder = Recorder()
        self.state = "idle"  # idle | recording | transcribing
        self.lock = threading.Lock()
        self.model = "mlx-community/whisper-large-v3-turbo"
        self.language: str | None = None
        self.vocabulary = ""
        self.silence_floor = 0.005
        self.max_seconds = 300.0
        self._auto_stop: threading.Timer | None = None

    # -- helpers ---------------------------------------------------------
    def _cancel_auto_stop(self) -> None:
        if self._auto_stop is not None:
            self._auto_stop.cancel()
            self._auto_stop = None

    def warm(self, model: str) -> dict:
        """Load the model now so the first real dictation is not slow."""
        import mlx_whisper

        started = time.monotonic()
        self.model = model
        silence = np.zeros(SAMPLE_RATE, dtype=np.float32)
        with quiet_stdout():
            mlx_whisper.transcribe(
                silence,
                path_or_hf_repo=model,
                language=self.language,
                condition_on_previous_text=False,
                verbose=False,
                word_timestamps=False,
            )
        elapsed = time.monotonic() - started
        return {"model": model, "elapsed": round(elapsed, 3)}

    # -- commands --------------------------------------------------------
    def start(self, device: int | None, max_seconds: float, silence_floor: float) -> dict:
        with self.lock:
            if self.state != "idle":
                raise RuntimeError(f"cannot start while {self.state}")
            self.silence_floor = silence_floor
            self.max_seconds = max_seconds
            self.recorder.start(device, max_seconds)
            self.state = "recording"
            self._auto_stop = threading.Timer(max_seconds, self._auto_stop_fired)
            self._auto_stop.daemon = True
            self._auto_stop.start()
        return {"state": "recording"}

    def _auto_stop_fired(self) -> None:
        log(f"hit {self.max_seconds:.0f}s ceiling; stopping automatically")
        emit({"event": "autostop", "reason": "max_duration"})
        try:
            self.finish()
        except Exception as exc:
            emit({"event": "error", "message": f"auto-stop failed: {exc}"})

    def finish(self) -> dict:
        """Stop capture and transcribe. Safe to call from any thread."""
        with self.lock:
            if self.state != "recording":
                raise RuntimeError(f"cannot stop while {self.state}")
            self._cancel_auto_stop()
            self.state = "transcribing"
            audio, duration, rms, peak = self.recorder.stop()

        emit({"event": "transcribing", "duration": round(duration, 2)})
        try:
            if not has_speech(audio, self.silence_floor):
                log(
                    f"clip of {duration:.2f}s has no frames above {self.silence_floor}; "
                    f"skipping the model (rms {rms:.4f}, peak {peak:.4f})"
                )
                return {
                    "text": "",
                    "duration": round(duration, 2),
                    "rms": round(rms, 5),
                    "peak": round(peak, 5),
                    "elapsed": 0.0,
                    "skipped": "silence",
                }
            out = transcribe(audio, self.model, self.language, self.vocabulary)
            out["rms"] = round(rms, 5)
            out["peak"] = round(peak, 5)
            out["duration"] = round(duration, 2)
            if out["text"] and out["avg_logprob"] < CONFIDENCE_FLOOR:
                log(
                    f"discarding low-confidence transcript "
                    f"(avg_logprob {out['avg_logprob']}): {out['text']!r}"
                )
                out["text"] = ""
                out["skipped"] = "low_confidence"
            return out
        finally:
            with self.lock:
                self.state = "idle"

    def cancel(self) -> dict:
        with self.lock:
            self._cancel_auto_stop()
            self.recorder.abort()
            self.state = "idle"
        emit({"event": "recording", "state": "cancelled"})
        return {"state": "idle"}

    def shutdown(self) -> None:
        with self.lock:
            self._cancel_auto_stop()
            self.recorder.abort()
            self.state = "idle"


# ---------------------------------------------------------------- dispatch


def handle(session: Session, msg: dict) -> None:
    req_id = msg.get("id")
    cmd = msg.get("cmd")
    try:
        if cmd == "ping":
            reply(req_id, pong=True, state=session.state)
        elif cmd == "devices":
            reply(req_id, devices=list_input_devices())
        elif cmd == "warm":
            model = msg.get("model") or session.model
            session.language = msg.get("language") or None
            session.vocabulary = msg.get("vocabulary") or ""
            info = session.warm(model)
            reply(req_id, **info)
            emit({"event": "model", "state": "loaded", "model": model})
        elif cmd == "start":
            info = session.start(
                device=msg.get("device"),
                max_seconds=float(msg.get("max_seconds", 300)),
                silence_floor=float(msg.get("silence_floor", 0.005)),
            )
            reply(req_id, **info)
        elif cmd == "stop":
            threading.Thread(
                target=lambda: _finish_and_reply(session, req_id), daemon=True
            ).start()
        elif cmd == "cancel":
            reply(req_id, **session.cancel())
        elif cmd == "transcribe":
            path = msg.get("path")
            if not path:
                raise ValueError("transcribe requires a 'path'")
            audio = load_wav(path)
            model = msg.get("model") or session.model
            language = msg["language"] if "language" in msg else session.language
            vocabulary = msg.get("vocabulary", session.vocabulary)
            duration = round(audio.size / SAMPLE_RATE, 2)
            if not has_speech(audio, session.silence_floor):
                reply(req_id, text="", skipped="silence", duration=duration)
                return
            out = transcribe(audio, model, language, vocabulary)
            out["duration"] = duration
            if out["text"] and out["avg_logprob"] < CONFIDENCE_FLOOR:
                log(f"discarding low-confidence transcript: {out['text']!r}")
                out["text"] = ""
                out["skipped"] = "low_confidence"
            reply(req_id, **out)
        elif cmd == "config":
            if msg.get("model"):
                session.model = msg["model"]
            if "language" in msg:
                session.language = msg.get("language") or None
            if "vocabulary" in msg:
                session.vocabulary = msg.get("vocabulary") or ""
            if "silence_floor" in msg:
                session.silence_floor = float(msg["silence_floor"])
            reply(req_id, state=session.state, model=session.model)
        elif cmd == "shutdown":
            session.shutdown()
            reply(req_id, state="idle")
            emit(None)
        else:
            reply(req_id, ok=False, error=f"unknown command: {cmd!r}")
    except Exception as exc:
        log(traceback.format_exc())
        reply(req_id, ok=False, error=f"{type(exc).__name__}: {exc}")


def _finish_and_reply(session: Session, req_id) -> None:
    try:
        reply(req_id, **session.finish())
    except Exception as exc:
        log(traceback.format_exc())
        reply(req_id, ok=False, error=f"{type(exc).__name__}: {exc}")


def main() -> int:
    threading.Thread(target=_writer_loop, daemon=True).start()
    session = Session()
    emit(
        {
            "event": "ready",
            "pid": __import__("os").getpid(),
            "sample_rate": SAMPLE_RATE,
            "python": sys.version.split()[0],
        }
    )
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            log(f"bad json: {exc}")
            continue
        handle(session, msg)
        if msg.get("cmd") == "shutdown":
            break
    session.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
