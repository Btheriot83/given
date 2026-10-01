#!/usr/bin/env python3
"""Renders the "Named" neon title (img/named-neon.webp) the way the iOS app draws it:
Snell Roundhand Bold, a wide orange halo, a tight bloom and a hot cream core with a 1-3pt
orange edge. The page rotates it -5deg in CSS, so the bitmap is drawn level.
Usage: scripts/render-title.py [font_px]   (3x device pixels; default 290)"""
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

FONT = "/System/Library/Fonts/Supplemental/SnellRoundhand.ttc"
S = float(sys.argv[1]) if len(sys.argv) > 1 else 290.0
NEON = tuple(c / 255 for c in (255, 154, 60))            # Theme.Palette.neon
HOT = tuple(c / 255 for c in (255, 217, 160))            # Theme.Palette.neonHot

def load_font():
    for i in range(4):
        try:
            f = ImageFont.truetype(FONT, int(S), index=i)
        except Exception:
            break
        if f.getname()[1].lower() == "bold":
            return f
    raise SystemExit("Snell Roundhand Bold not found")

font = load_font()
l, t, r, b = font.getbbox("Named")
tw, th = r - l, b - t
pad = int(S * 0.2 * 3)
W, H = tw + 2 * pad, th + 2 * pad
mask = Image.new("L", (W, H), 0)
ImageDraw.Draw(mask).text((pad - l, pad - t), "Named", font=font, fill=255)

def blur(sigma):
    return np.asarray(mask.filter(ImageFilter.GaussianBlur(sigma)), dtype=np.float32) / 255.0

def over(base, rgb, alpha):
    ab = base[..., 3]
    ao = alpha + ab * (1 - alpha)
    safe = np.where(ao > 0, ao, 1)
    for c in range(3):
        base[..., c] = (rgb[c] * alpha + base[..., c] * ab * (1 - alpha)) / safe
    base[..., 3] = ao
    return base

canvas = np.zeros((H, W, 4), dtype=np.float32)
px = S / 74.0                                            # the app draws this at 74pt
canvas = over(canvas, NEON, 0.70 * blur(S * 0.20))       # wide halo
canvas = over(canvas, NEON, 0.95 * blur(S * 0.07))       # tight bloom
canvas = over(canvas, NEON, 0.90 * blur(3 * px / 2))     # 3pt edge glow
canvas = over(canvas, NEON, 1.00 * blur(1 * px / 2))     # 1pt edge glow
canvas = over(canvas, HOT, np.asarray(mask, dtype=np.float32) / 255.0)  # the lit core
out = Image.fromarray((np.clip(canvas, 0, 1) * 255).astype(np.uint8), "RGBA")
out.save("img/named-neon.webp", quality=92, method=6)
print(out.size, "text", (tw, th))
