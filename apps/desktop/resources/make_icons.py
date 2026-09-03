"""生成 Anchor 托盘/应用图标（16/32/256 px），仅写入本项目 resources/。"""
from PIL import Image, ImageDraw

OUT = r"E:\AI_projects\Anchor\apps\desktop\resources"


def draw_anchor(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = size / 32.0
    color = (127, 166, 184, 255)   # calm 青蓝
    ring = (201, 207, 218, 255)    # mist

    # 顶部圆环
    r = 5.2 * s
    cx, cy = 16 * s, 8.2 * s
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=ring, width=max(1, int(2.2 * s)))

    # 竖杆
    d.line([16 * s, 13.4 * s, 16 * s, 25.5 * s], fill=ring, width=max(1, int(2.2 * s)))

    # 底部弧（锚爪）: 圆弧近似
    arc_r = 8.4 * s
    d.arc([16 * s - arc_r, 17.1 * s, 16 * s + arc_r, 17.1 * s + arc_r * 1.35],
          start=15, end=165, fill=ring, width=max(1, int(2.2 * s)))

    # 左右横杆
    d.line([9.5 * s, 16.4 * s, 22.5 * s, 16.4 * s], fill=color, width=max(1, int(2.6 * s)))

    # 底部两个小爪尖
    d.ellipse([7.1 * s, 24.2 * s, 11.1 * s, 28.2 * s], fill=color)
    d.ellipse([20.9 * s, 24.2 * s, 24.9 * s, 28.2 * s], fill=color)
    return img


for px in (16, 24, 32, 48, 256):
    draw_anchor(px).save(f"{OUT}\\tray-{px}.png")

# Electron Tray 推荐：同时含 16@1x 与 32（2x）；Windows 下直接用 32 也清晰
draw_anchor(32).save(f"{OUT}\\tray.png")
print("icons written to", OUT)
