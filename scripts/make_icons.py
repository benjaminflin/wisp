#!/usr/bin/env python3
"""Generates Wisp's icons with numpy so the repo needs no binary assets.

Menu-bar icons are "template" images: pure black plus an alpha channel, which
macOS recolours automatically for light and dark menu bars. Shapes are drawn as
signed distance fields and supersampled for clean edges at 16 px.
"""

from __future__ import annotations

import os
import struct
import sys
import zlib

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
BUILD = os.path.join(ROOT, "build")


def write_png(path: str, rgba: np.ndarray) -> None:
    """rgba: (h, w, 4) uint8."""
    h, w = rgba.shape[:2]
    raw = bytearray()
    for row in rgba:
        raw.append(0)  # filter: none
        raw.extend(row.tobytes())

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(png)


def grid(size: int, ss: int):
    n = size * ss
    ys, xs = np.mgrid[0:n, 0:n]
    return (xs + 0.5) / n, (ys + 0.5) / n


def downsample(mask: np.ndarray, size: int, ss: int) -> np.ndarray:
    n = size * ss
    return mask.reshape(size, ss, size, ss).mean(axis=(1, 3))


def disc(x, y, cx, cy, r):
    return np.hypot(x - cx, y - cy) <= r


def ring(x, y, cx, cy, r, thickness):
    return np.abs(np.hypot(x - cx, y - cy) - r) <= thickness / 2


def segment(x, y, x0, y0, x1, y1, thickness):
    dx, dy = x1 - x0, y1 - y0
    length_sq = dx * dx + dy * dy
    t = np.clip(((x - x0) * dx + (y - y0) * dy) / (length_sq or 1e-9), 0.0, 1.0)
    return np.hypot(x - (x0 + t * dx), y - (y0 + t * dy)) <= thickness / 2


def rounded_rect(x, y, cx, cy, hw, hh, r):
    qx = np.abs(x - cx) - (hw - r)
    qy = np.abs(y - cy) - (hh - r)
    outside = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0))
    inside = np.minimum(np.maximum(qx, qy), 0)
    return outside + inside - r <= 0


def arc(x, y, cx, cy, r, thickness, start, end):
    dx, dy = x - cx, y - cy
    dist = np.hypot(dx, dy)
    angle = np.arctan2(dy, dx) % (2 * np.pi)
    start %= 2 * np.pi
    end %= 2 * np.pi
    if start <= end:
        within = (angle >= start) & (angle <= end)
    else:
        within = (angle >= start) | (angle <= end)
    return (np.abs(dist - r) <= thickness / 2) & within


def render_template(size: int, draw, ss: int = 8) -> np.ndarray:
    """Black shape on transparent, anti-aliased. Template image convention."""
    x, y = grid(size, ss)
    coverage = downsample(draw(x, y).astype(np.float64), size, ss)
    rgba = np.zeros((size, size, 4), dtype=np.uint8)
    rgba[..., 3] = np.clip(coverage * 255.0 + 0.5, 0, 255).astype(np.uint8)
    return rgba


def main() -> int:
    # --- menu bar: idle ring, filled dot while recording, ring+dot while busy
    idle = lambda x, y: ring(x, y, 0.5, 0.5, 0.375, 0.145)
    recording = lambda x, y: disc(x, y, 0.5, 0.5, 0.355)
    busy = lambda x, y: ring(x, y, 0.5, 0.5, 0.40, 0.11) | disc(x, y, 0.5, 0.5, 0.145)

    for name, draw in (("trayIdle", idle), ("trayRecording", recording), ("trayBusy", busy)):
        for scale, suffix in ((1, ""), (2, "@2x")):
            size = 16 * scale
            write_png(os.path.join(ASSETS, f"{name}Template{suffix}.png"), render_template(size, draw))
    print(f"wrote menu bar icons to {ASSETS}")

    # --- app icon: warm rounded square with a microphone glyph
    size, ss = 1024, 2
    x, y = grid(size, ss)

    background = rounded_rect(x, y, 0.5, 0.5, 0.46, 0.46, 0.225)
    glyph = (
        rounded_rect(x, y, 0.5, 0.385, 0.098, 0.155, 0.098)
        | arc(x, y, 0.5, 0.425, 0.205, 0.055, 0.0, np.pi)
        | segment(x, y, 0.5, 0.63, 0.5, 0.745, 0.055)
        | segment(x, y, 0.365, 0.745, 0.635, 0.745, 0.055)
    )

    t = np.clip(((y - 0.02) / 0.96), 0, 1)
    top = np.array([1.00, 0.78, 0.36])   # amber
    bottom = np.array([0.93, 0.42, 0.18])  # deep orange
    colour = top[None, None, :] * (1 - t[..., None]) + bottom[None, None, :] * t[..., None]

    bg_cov = downsample(background.astype(np.float64), size, ss)
    glyph_cov = downsample(glyph.astype(np.float64), size, ss)
    colour = colour.reshape(size, ss, size, ss, 3).mean(axis=(1, 3))

    alpha = bg_cov
    rgb = colour * (1 - glyph_cov[..., None]) + np.array([1.0, 1.0, 1.0]) * glyph_cov[..., None]

    icon = np.zeros((size, size, 4), dtype=np.uint8)
    icon[..., :3] = np.clip(rgb * 255.0 + 0.5, 0, 255).astype(np.uint8)
    icon[..., 3] = np.clip(alpha * 255.0 + 0.5, 0, 255).astype(np.uint8)
    write_png(os.path.join(BUILD, "icon.png"), icon)
    print(f"wrote app icon to {os.path.join(BUILD, 'icon.png')}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ImportError as exc:
        print(f"numpy is required to generate icons: {exc}", file=sys.stderr)
        sys.exit(1)
