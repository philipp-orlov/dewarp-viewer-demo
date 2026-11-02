#!/usr/bin/env python3
"""Generates the synthetic fisheye sample clips in public/samples.

A cube "room" (straight grid lines, asymmetric face labels so mirroring is
visible) is rendered as an equirectangular video with a moving marker, then
projected to a 180 degree equidistant fisheye with ffmpeg's v360 filter.

    python3 scripts/make-samples.py [outdir]

Needs numpy, Pillow and ffmpeg. Also exports the room (room.py:render_room)
so the test harness can draw the ground-truth rectilinear view.
"""
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

FACE = 1024
FPS = 25
SECONDS = 8
EQ_W, EQ_H = 2048, 1024

# face id -> (label, background rgb)
FACES = {
    "+z": ("FRONT", (200, 215, 235)),
    "-z": ("BACK", (235, 215, 200)),
    "+x": ("RIGHT", (205, 235, 205)),
    "-x": ("LEFT", (235, 205, 235)),
    "+y": ("UP", (245, 245, 200)),
    "-y": ("DOWN", (190, 190, 190)),
}


def _font(size):
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            pass
    return ImageFont.load_default()


def face_texture(label, bg):
    img = Image.new("RGB", (FACE, FACE), bg)
    d = ImageDraw.Draw(img)
    step = FACE // 10
    for i in range(0, FACE + 1, step):
        w = 6 if i in (0, FACE // 2, FACE) else 2
        d.line([(i, 0), (i, FACE)], fill=(40, 40, 60), width=w)
        d.line([(0, i), (FACE, i)], fill=(40, 40, 60), width=w)
    d.text((FACE // 2, FACE // 2), label, fill=(20, 20, 20), font=_font(150), anchor="mm")
    # An "R"-shaped corner mark in the top-left makes mirroring obvious.
    d.text((70, 60), "R", fill=(200, 30, 30), font=_font(90), anchor="mm")
    return np.asarray(img, dtype=np.uint8)


TEXTURES = {k: face_texture(*v) for k, v in FACES.items()}


def render_room(dirs):
    """dirs: (...,3) unit-ish ray directions (x right, y up, z fwd) -> (...,3) uint8."""
    d = dirs.astype(np.float64)
    ax, ay, az = np.abs(d[..., 0]), np.abs(d[..., 1]), np.abs(d[..., 2])
    m = np.maximum(np.maximum(ax, ay), az)
    out = np.zeros(d.shape, dtype=np.uint8)
    p = d / np.maximum(m, 1e-12)[..., None]
    x, y, z = p[..., 0], p[..., 1], p[..., 2]

    def put(mask, key, u, v):
        col = np.clip(((u + 1) * 0.5 * (FACE - 1)).astype(np.int32), 0, FACE - 1)
        row = np.clip(((1 - v) * 0.5 * (FACE - 1)).astype(np.int32), 0, FACE - 1)
        out[mask] = TEXTURES[key][row[mask], col[mask]]

    fz = (az >= ax) & (az >= ay)
    fx = (ax > az) & (ax >= ay)
    fy = ~(fz | fx)
    put(fz & (d[..., 2] > 0), "+z", x, y)
    put(fz & (d[..., 2] <= 0), "-z", -x, y)
    put(fx & (d[..., 0] > 0), "+x", -z, y)
    put(fx & (d[..., 0] <= 0), "-x", z, y)
    put(fy & (d[..., 1] > 0), "+y", x, -z)
    put(fy & (d[..., 1] <= 0), "-y", x, z)
    return out


def equirect_dirs():
    lon = (np.arange(EQ_W) + 0.5) / EQ_W * 2 * np.pi - np.pi
    lat = np.pi / 2 - (np.arange(EQ_H) + 0.5) / EQ_H * np.pi
    lon, lat = np.meshgrid(lon, lat)
    return np.stack(
        [np.sin(lon) * np.cos(lat), np.sin(lat), np.cos(lon) * np.cos(lat)], axis=-1
    )


def encode(outpath, pitch):
    dirs = equirect_dirs()
    base = render_room(dirs)
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{EQ_W}x{EQ_H}", "-r", str(FPS),
        "-i", "-",
        "-vf",
        f"v360=input=e:output=fisheye:h_fov=180:v_fov=180:pitch={pitch}:w=1024:h=1024:interp=cubic,"
        "format=yuv420p",
        "-c:v", "libvpx-vp9", "-b:v", "900k", "-deadline", "realtime", "-cpu-used", "6", "-an",
        outpath,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    cos_r = np.cos(np.radians(4.0))
    for i in range(FPS * SECONDS):
        t = i / (FPS * SECONDS)
        lon = t * 2 * np.pi - np.pi
        lat = np.radians(-35.0 if pitch < 0 else 10.0)
        c = np.array([np.sin(lon) * np.cos(lat), np.sin(lat), np.cos(lon) * np.cos(lat)])
        frame = base.copy()
        frame[(dirs @ c) > cos_r] = (230, 30, 30)
        proc.stdin.write(frame.tobytes())
    proc.stdin.close()
    if proc.wait() != 0:
        sys.exit("ffmpeg failed")


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "public/samples"
    encode(f"{out}/fisheye-ceiling.webm", -90)
    encode(f"{out}/fisheye-wall.webm", 0)
    print("done")
