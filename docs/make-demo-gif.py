from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

DOCS = Path(__file__).resolve().parent
W, H = 400, 900
BG = (15, 17, 23)
FG = (230, 233, 240)
MUTED = (139, 147, 167)
ACCENT = (108, 140, 255)

MSJH = r"C:\Windows\Fonts\msjh.ttc"
MSJHBD = r"C:\Windows\Fonts\msjhbd.ttc"


def font(path, size):
    return ImageFont.truetype(path, size)


def title_card():
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    # 頂部淡淡漸層
    for y in range(260):
        t = y / 260
        d.line([(0, y), (W, y)], fill=(int(15 + 18 * t), int(17 + 10 * t), int(23 + 28 * t)))

    d.rounded_rectangle([28, 40, 104, 116], radius=18, fill=ACCENT)
    d.text((40, 56), "DSH", font=font(MSJHBD, 30), fill="white")
    d.text((120, 50), "Edge 助手", font=font(MSJHBD, 26), fill=FG)

    d.text((28, 210), "把 Edge 交給", font=font(MSJHBD, 36), fill=FG)
    d.text((28, 264), "AI agent", font=font(MSJHBD, 52), fill=ACCENT)

    items = [
        "CDP 真實點擊 / 打字",
        "閱讀頁面・滾動全文",
        "元素截圖・無障礙樹",
        "自動匯出 cookie",
        "側邊欄直接對話",
    ]
    y = 380
    for it in items:
        d.ellipse([30, y + 7, 42, y + 19], fill=ACCENT)
        d.text((58, y), it, font=font(MSJH, 23), fill=FG)
        y += 50

    d.text((28, H - 82), "github.com/xingchenlingye-source/", font=font(MSJH, 15), fill=MUTED)
    d.text((28, H - 60), "dsh-edge-assistant", font=font(MSJH, 15), fill=MUTED)
    return im


def shot_card(path, caption):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    src = Image.open(path).convert("RGB")
    maxw, maxh = W - 30, H - 130
    r = min(maxw / src.width, maxh / src.height)
    src = src.resize((max(1, int(src.width * r)), max(1, int(src.height * r))), Image.LANCZOS)
    x = (W - src.width) // 2
    y = 24
    im.paste(src, (x, y))
    d.text((W // 2, H - 60), caption, font=font(MSJH, 17), fill=MUTED, anchor="mm")
    return im


def main():
    frames = [
        title_card(),
        shot_card(DOCS / "screenshot-popup.png", "popup：bridge 連線 · cookie 同步"),
        shot_card(DOCS / "screenshot-panel.png", "側邊欄：讀頁 / 截圖 / 收件匣 / DSH 對話"),
    ]
    frames = [f.quantize(colors=128) for f in frames]
    out = DOCS / "demo.gif"
    frames[0].save(
        out,
        save_all=True,
        append_images=frames[1:],
        duration=[2000, 2500, 3000],
        loop=0,
        optimize=True,
        disposal=2,
    )
    print("wrote", out, round(out.stat().st_size / 1024, 1), "KB", Image.open(out).size)


if __name__ == "__main__":
    main()
