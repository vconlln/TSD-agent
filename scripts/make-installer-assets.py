#!/usr/bin/env python3
"""生成 NSIS 安装向导的品牌图（Windows 安装器美化）。

产物（electron-builder 通过 nsis.installerSidebar / installerHeader 引用）：
- build/installerSidebar.bmp  164x314  欢迎页 / 完成页左侧竖图
- build/installerHeader.bmp   150x57   目录页 / 安装过程页顶部横图
- build/installerIcon.ico    32x32     向导标题栏小图标

设计沿用应用图标：紫粉极光渐变 + 向上的双箭头。
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"

GRAD_A = (124, 92, 255)
GRAD_B = (196, 80, 232)

FONT_CANDIDATES = [
    "/usr/share/fonts/pingFang/pingFangSC/PingFangSC-Semibold.otf",
    "/usr/share/fonts/adobe-source-han-sans/SourceHanSansCN-Bold.otf",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
]


def load_font(size: int, index: int = 0) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in FONT_CANDIDATES:
        path = Path(candidate)
        if path.exists():
            try:
                return ImageFont.truetype(str(path), size=size, index=index)
            except Exception:
                continue
    return ImageFont.load_default()


def vertical_gradient(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    width, height = size
    image = Image.new("RGB", size)
    pixels = image.load()
    for y in range(height):
        t = y / max(1, height - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(width):
            pixels[x, y] = color
    return image


def glow(size: tuple[int, int], center: tuple[float, float], radius: float, color: tuple[int, int, int], alpha: int) -> Image.Image:
    layer = Image.new("L", size, 0)
    draw = ImageDraw.Draw(layer)
    cx, cy = center
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=alpha)
    layer = layer.filter(ImageFilter.GaussianBlur(radius * 0.55))
    colored = Image.new("RGB", size, color)
    return colored, layer


def chevrons(draw: ImageDraw.ImageDraw, cx: float, cy: float, half: float, width: int, opacity: tuple[int, int, int]) -> None:
    points = [(cx - half, cy + half * 0.6), (cx, cy - half * 0.4), (cx + half, cy + half * 0.6)]
    draw.line(points, fill=opacity, width=width, joint="curve")


def sidebar() -> Image.Image:
    size = (164, 314)
    scale = 4
    big = (size[0] * scale, size[1] * scale)
    image = vertical_gradient(big, (18, 16, 42), (58, 22, 84)).convert("RGB")

    for color, center, radius, alpha in [
        (GRAD_A, (big[0] * 0.2, big[1] * 0.16), big[0] * 0.9, 150),
        (GRAD_B, (big[0] * 0.95, big[1] * 0.72), big[0] * 0.85, 120),
    ]:
        colored, mask = glow(big, center, radius, color, alpha)
        image = Image.composite(colored, image, mask)

    draw = ImageDraw.Draw(image)
    # 细网格
    for x in range(0, big[0], 24 * scale):
        draw.line([(x, 0), (x, big[1])], fill=(255, 255, 255, 10), width=1)
    for y in range(0, big[1], 24 * scale):
        draw.line([(0, y), (big[0], y)], fill=(255, 255, 255, 10), width=1)

    # 图标
    box = int(big[0] * 0.30)
    x0 = int((big[0] - box) / 2)
    y0 = int(big[1] * 0.16)
    draw.rounded_rectangle((x0, y0, x0 + box, y0 + box), radius=int(box * 0.25), fill=(255, 255, 255, 26))
    cx = x0 + box / 2
    chevrons(draw, cx, y0 + box * 0.60, box * 0.26, max(3, int(box * 0.075)), (255, 255, 255))
    chevrons(draw, cx, y0 + box * 0.78, box * 0.26, max(3, int(box * 0.075)), (255, 255, 255))
    dot = box * 0.06
    draw.ellipse((cx - dot, y0 + box * 0.26, cx + dot, y0 + box * 0.26 + dot * 2), fill=(255, 255, 255))

    # 文字
    title_font = load_font(int(23 * scale))
    sub_font = load_font(int(10.5 * scale))
    tag_font = load_font(int(8.5 * scale))
    _text_center(draw, "TSD Agent", big[0] / 2, big[1] * 0.42, title_font, (255, 255, 255))
    _text_center(draw, "项目方案升级智能体", big[0] / 2, big[1] * 0.50, sub_font, (236, 228, 255))
    draw.line(
        [(big[0] * 0.22, big[1] * 0.545), (big[0] * 0.78, big[1] * 0.545)],
        fill=(255, 255, 255, 70),
        width=max(1, scale),
    )
    _text_center(draw, "解析方案 · 下载代码", big[0] / 2, big[1] * 0.60, tag_font, (226, 214, 255))
    _text_center(draw, "升级代码 · 可视化差异", big[0] / 2, big[1] * 0.655, tag_font, (226, 214, 255))
    _text_center(draw, "Windows 安装向导", big[0] / 2, big[1] * 0.90, tag_font, (214, 200, 245))

    return image.resize(size, Image.LANCZOS)


def header() -> Image.Image:
    size = (150, 57)
    scale = 4
    big = (size[0] * scale, size[1] * scale)
    image = Image.new("RGB", big, (255, 255, 255))
    band = vertical_gradient((big[0], int(big[1] * 0.22)), GRAD_A, GRAD_B)
    image.paste(band, (0, 0))

    draw = ImageDraw.Draw(image)
    icon = int(big[1] * 0.42)
    ix, iy = int(big[0] * 0.05), int(big[1] * 0.36)
    draw.rounded_rectangle((ix, iy, ix + icon, iy + icon), radius=int(icon * 0.26), fill=(124, 92, 255))
    cx, cy = ix + icon / 2, iy + icon / 2
    chevrons(draw, cx, cy + icon * 0.10, icon * 0.22, max(2, int(icon * 0.10)), (255, 255, 255))
    chevrons(draw, cx, cy + icon * 0.30, icon * 0.22, max(2, int(icon * 0.10)), (255, 255, 255))

    title_font = load_font(int(15 * scale))
    sub_font = load_font(int(7.5 * scale))
    draw.text((ix + icon + int(big[0] * 0.04), int(big[1] * 0.30)), "TSD Agent", font=title_font, fill=(28, 24, 46))
    draw.text(
        (ix + icon + int(big[0] * 0.045), int(big[1] * 0.58)),
        "PROJECT UPGRADER",
        font=sub_font,
        fill=(120, 106, 160),
    )
    return image.resize(size, Image.LANCZOS)


def _text_center(draw: ImageDraw.ImageDraw, text: str, cx: float, cy: float, font, fill) -> None:
    box = draw.textbbox((0, 0), text, font=font)
    width = box[2] - box[0]
    height = box[3] - box[1]
    draw.text((cx - width / 2 - box[0], cy - height / 2 - box[1]), text, font=font, fill=fill)


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    sidebar().save(BUILD / "installerSidebar.bmp", "BMP")
    header().save(BUILD / "installerHeader.bmp", "BMP")

    source_icon = BUILD / "icon.png"
    if source_icon.exists():
        icon_image = Image.open(source_icon).convert("RGBA")
        icon_image.save(BUILD / "installerIcon.ico", sizes=[(16, 16), (32, 32), (48, 48), (256, 256)])
    print("installer assets ->", BUILD / "installerSidebar.bmp", BUILD / "installerHeader.bmp")


if __name__ == "__main__":
    main()
