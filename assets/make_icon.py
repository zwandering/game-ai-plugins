"""Draws the 128x128 extension icon (a board corner with a black and a white stone)."""
import sys
from PIL import Image, ImageDraw

S = 128
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([4, 4, S - 5, S - 5], radius=22, fill=(214, 170, 104, 255))
for i in range(5):
    x = 24 + i * 20
    d.line([(x, 24), (x, 104)], fill=(92, 62, 30, 255), width=2)
    d.line([(24, x), (104, x)], fill=(92, 62, 30, 255), width=2)
d.ellipse([46, 46, 82, 82], fill=(20, 20, 24, 255))
d.ellipse([66, 66, 102, 102], fill=(245, 245, 245, 255), outline=(120, 120, 120, 255), width=2)
d.ellipse([24, 24, 46, 46], outline=(229, 56, 59, 255), width=4)
img.save(sys.argv[1])
