from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
ICON_DIR = HERE / "extension" / "icons"
SIZE = 128

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圓角背景（漸層感：用兩層疊色）
d.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=28, fill=(92, 124, 250, 255))
d.rounded_rectangle([0, 0, SIZE - 1, SIZE // 2], radius=28, fill=(124, 108, 246, 90))


# bridge 意象：兩個節點 + 連線
def node(cx, cy, r=17):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 255))


d.line([(42, 64), (86, 64)], fill=(255, 255, 255, 230), width=9)
node(34, 64)
node(94, 64)

ICON_DIR.mkdir(parents=True, exist_ok=True)
img.save(ICON_DIR / "icon128.png")
for s in (48, 16):
    img.resize((s, s), Image.LANCZOS).save(ICON_DIR / ("icon%d.png" % s))
print("icons written to", ICON_DIR)
