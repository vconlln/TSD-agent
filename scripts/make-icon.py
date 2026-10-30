#!/usr/bin/env python3
"""生成应用图标（1024 PNG + 多尺寸 ICO），无需外部素材。

设计：圆角方块 + 紫粉渐变 + 向上的双箭头（升级），与前端 Logo 一致。
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
SS = 4  # supersampling

OUT = Path(__file__).resolve().parent.parent / "build"


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def gradient(size: int, start: tuple[int, int, int], end: tuple[int, int, int]) -> Image.Image:
    img = Image.new("RGB", (size, size))
    pixels = img.load()
    for y in range(size):
        for x in range(size):
            t = (x / size * 0.45) + (y / size * 0.55)
            pixels[x, y] = (
                int(lerp(start[0], end[0], t)),
                int(lerp(start[1], end[1], t)),
                int(lerp(start[2], end[2], t)),
            )
    return img


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def build() -> Image.Image:
    size = SIZE * SS
    radius = int(size * 0.24)

    # base gradient (violet -> magenta)
    base = gradient(size, (124, 92, 255), (196, 80, 232))

    # soft highlight in the upper-left
    highlight = Image.new("L", (size, size), 0)
    hdraw = ImageDraw.Draw(highlight)
    hdraw.ellipse((-size * 0.25, -size * 0.45, size * 0.85, size * 0.55), fill=90)
    highlight = highlight.filter(ImageFilter.GaussianBlur(size * 0.06))
    white = Image.new("RGB", (size, size), (255, 255, 255))
    base = Image.composite(white, base, highlight.point(lambda v: int(v * 0.45)))

    # inner border
    border = Image.new("L", (size, size), 0)
    bdraw = ImageDraw.Draw(border)
    bdraw.rounded_rectangle((2, 2, size - 3, size - 3), radius=radius, outline=255, width=int(size * 0.008))
    border = border.point(lambda v: int(v * 0.35))
    base = Image.composite(white, base, border)

    mask = rounded_mask(size, radius)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(base, (0, 0), mask)

    # chevrons + dot
    draw = ImageDraw.Draw(canvas)
    stroke = int(size * 0.072)
    cx = size / 2

    def chevron(cy: float, half_w: float, opacity: int) -> None:
        points = [
            (cx - half_w, cy + half_w * 0.62),
            (cx, cy - half_w * 0.38),
            (cx + half_w, cy + half_w * 0.62),
        ]
        draw.line(points, fill=(255, 255, 255, opacity), width=stroke, joint="curve")

    chevron(size * 0.585, size * 0.185, 255)
    chevron(size * 0.745, size * 0.185, 120)
    dot_r = size * 0.052
    draw.ellipse((cx - dot_r, size * 0.245, cx + dot_r, size * 0.245 + dot_r * 2), fill=(255, 255, 255, 255))

    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    icon = build()
    icon.save(OUT / "icon.png")
    icon.save(
        OUT / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"icon written -> {OUT / 'icon.png'} , {OUT / 'icon.ico'}")


if __name__ == "__main__":
    main()
