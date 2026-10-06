# -*- coding: utf-8 -*-
"""生成 README 配图:1) 像素地牢素材拼图;2) 节点工作流示意图。"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = r'D:\haowan'
MAT = os.path.join(ROOT, 'docs', '像素地牢素材')
SHOTS = os.path.join(ROOT, 'screenshots')
os.makedirs(SHOTS, exist_ok=True)

# ---- 1) 素材拼图:4 + 3 两行 ----
files = sorted(f for f in os.listdir(MAT) if f.endswith('.png'))
CELL = 256
cols, rows = 4, 2
canvas = Image.new('RGB', (cols * CELL, rows * CELL), '#141019')
for i, f in enumerate(files[:8]):
    im = Image.open(os.path.join(MAT, f)).convert('RGB').resize((CELL, CELL))
    canvas.paste(im, ((i % cols) * CELL, (i // cols) * CELL))
canvas.save(os.path.join(SHOTS, 'dungeon-samples.png'))
print('dungeon-samples.png', canvas.size)

# ---- 2) 工作流示意图 ----
W, H = 1000, 340
img = Image.new('RGB', (W, H), '#17131d')
d = ImageDraw.Draw(img)
font_path = r'C:\Windows\Fonts\msyh.ttc'
try:
    f_title = ImageFont.truetype(font_path, 26)
    f_node = ImageFont.truetype(font_path, 18)
    f_sub = ImageFont.truetype(font_path, 14)
except Exception:
    f_title = f_node = f_sub = ImageFont.load_default()

d.text((20, 16), 'Node AI Development Tool · 一条完整流水线', fill='#ffd98a', font=f_title)

nodes = [
    ('项目', '#3a6ea5', '需求 + 项目文件夹'),
    ('功能', '#7a4aa5', 'AI 生成 Electron 应用'),
    ('审查', '#2f7f8f', '只读评审'),
    ('测试', '#7f8f2f', '跑测试命令'),
    ('输出', '#2f855a', '打包 exe / zip'),
]
x = 40
y0 = 90
box_w, box_h = 150, 96
for i, (name, color, sub) in enumerate(nodes):
    d.rounded_rectangle((x, y0, x + box_w, y0 + box_h), 12, fill=color)
    d.text((x + 16, y0 + 18), name, fill='white', font=f_node)
    d.text((x + 16, y0 + 52), sub, fill='#e8e8e8', font=f_sub)
    if i < len(nodes) - 1:
        ax = x + box_w
        d.line((ax + 6, y0 + box_h // 2, ax + 42, y0 + box_h // 2), fill='#9a8cb0', width=4)
        d.polygon([(ax + 42, y0 + box_h // 2), (ax + 34, y0 + box_h // 2 - 8), (ax + 34, y0 + box_h // 2 + 8)], fill='#9a8cb0')
    x += box_w + 48

# 生图支路(下方)
gx, gy = 40, 230
gw, gh = 200, 88
d.rounded_rectangle((gx, gy, gx + gw, gy + gh), 12, fill='#c98a2f')
d.text((gx + 14, gy + 16), '图像节点', fill='white', font=f_node)
d.text((gx + 14, gy + 50), '本地模型直出 UI/图标', fill='#f0f0f0', font=f_sub)
d.line((gx + gw, gy + gh // 2, gx + gw + 44, gy + gh // 2), fill='#9a8cb0', width=4)
d.polygon([(gx + gw + 44, gy + gh // 2), (gx + gw + 36, gy + gh // 2 - 8), (gx + gw + 36, gy + gh // 2 + 8)], fill='#9a8cb0')
gx += gw + 44
d.rounded_rectangle((gx, gy, gx + gw, gy + gh), 12, fill='#6a4aa5')
d.text((gx + 14, gy + 16), '交接节点', fill='white', font=f_node)
d.text((gx + 14, gy + 50), '素材清单 → 功能节点', fill='#f0f0f0', font=f_sub)
d.line((gx + gw, gy + gh // 2, gx + gw + 44, gy + gh // 2), fill='#9a8cb0', width=4)
d.polygon([(gx + gw + 44, gy + gh // 2), (gx + gw + 36, gy + gh // 2 - 8), (gx + gw + 36, gy + gh // 2 + 8)], fill='#9a8cb0')
gx += gw + 44
d.rounded_rectangle((gx, gy, gx + 190, gy + gh), 12, fill='#a56a2a')
d.text((gx + 14, gy + 16), '… → 打包 exe', fill='white', font=f_node)

img.save(os.path.join(SHOTS, 'workflow.png'))
print('workflow.png', img.size)
