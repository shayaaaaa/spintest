# Draws the Ai Agent app icon: a dark rounded tile with a glowing prompt chevron and a four-point spark.
import math, sys
from PIL import Image, ImageDraw, ImageFilter

def tile(size, maskable=False, fullbleed=False):
    S = size * 4  # supersample
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    # background gradient (deep indigo -> near black), diagonal
    bg = Image.new('RGBA', (S, S))
    px = bg.load()
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * S)
            r = int(30 * (1 - t) + 10 * t); g = int(26 * (1 - t) + 10 * t); b = int(72 * (1 - t) + 18 * t)
            px[x, y] = (r, g, b, 255)
    mask = Image.new('L', (S, S), 0)
    if maskable or fullbleed:
        mask.paste(255, (0, 0, S, S))
    else:
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.225), fill=255)
    img.paste(bg, (0, 0), mask)

    pad = 0.18 if maskable else 0.0  # keep glyph in the maskable safe zone
    def P(x, y): return (int(S * (pad + x * (1 - 2 * pad))), int(S * (pad + y * (1 - 2 * pad))))

    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    w = int(S * 0.085 * (1 - 2 * pad))
    chevron = [P(0.25, 0.30), P(0.47, 0.50), P(0.25, 0.70)]
    gd.line(chevron, fill=(139, 140, 255, 255), width=w, joint='curve')
    # underscore cursor
    gd.line([P(0.53, 0.70), P(0.72, 0.70)], fill=(139, 140, 255, 255), width=w)
    blur = glow.filter(ImageFilter.GaussianBlur(S * 0.03))
    img = Image.alpha_composite(img, blur)
    img = Image.alpha_composite(img, glow)

    # four-point spark (top right)
    d = ImageDraw.Draw(img)
    cx, cy = P(0.70, 0.31)
    R = S * 0.13 * (1 - 2 * pad); r = R * 0.22
    pts = []
    for i in range(8):
        ang = -math.pi / 2 + i * math.pi / 4
        rad = R if i % 2 == 0 else r
        pts.append((cx + rad * math.cos(ang), cy + rad * math.sin(ang)))
    spark = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(spark).polygon(pts, fill=(255, 214, 140, 255))
    img = Image.alpha_composite(img, spark.filter(ImageFilter.GaussianBlur(S * 0.02)))
    img = Image.alpha_composite(img, spark)
    if not maskable and not fullbleed:
        img.putalpha(Image.composite(img.getchannel('A'), Image.new('L', (S, S), 0), mask))
    return img.resize((size, size), Image.LANCZOS)

out = sys.argv[1]
tile(180, fullbleed=True).save(f'{out}/icon-180.png')
for s in (192, 512):
    tile(s).save(f'{out}/icon-{s}.png')
tile(512, maskable=True).save(f'{out}/icon-maskable-512.png')
print('icons written')
