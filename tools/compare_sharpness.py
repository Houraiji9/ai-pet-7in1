#!/usr/bin/env python3
"""旧 640 vs 新 1280 同一帧对比（脸部裁切，均放大到同一显示尺寸，棋盘/浅灰底）。
用法: compare_sharpness.py old.webm new.webm out.png [--t 秒]"""
import sys, subprocess, argparse, numpy as np
from PIL import Image, ImageDraw, ImageFont
def frame(p, t):
    w, h = map(int, subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','csv=p=0',p]).decode().strip().split(','))
    b = subprocess.check_output(['ffmpeg','-v','error','-c:v','libvpx-vp9','-ss',str(t),'-i',p,'-frames:v','1','-f','rawvideo','-pix_fmt','rgba','-'])
    return Image.fromarray(np.frombuffer(b, np.uint8).reshape(h, w, 4))
ap = argparse.ArgumentParser(); ap.add_argument('old'); ap.add_argument('new'); ap.add_argument('out'); ap.add_argument('--t', type=float, default=1.0)
a = ap.parse_args()
o, n = frame(a.old, a.t), frame(a.new, a.t)
al = np.asarray(o)[..., 3]; ys, xs = np.nonzero(al > 20)
top, cx = ys.min(), (xs.min() + xs.max()) / 2
fh = int((ys.max() - top) * 0.55)              # 头+脸约占上 55%
box = (int(cx - fh*0.5), max(0, top - 6), int(cx + fh*0.5), top - 6 + fh)
D = 560
def tile(img, f, label):
    c = img.crop(tuple(int(v*f) for v in box))
    bg = Image.new('RGBA', c.size, (236, 238, 242, 255)); bg.alpha_composite(c)
    t = bg.convert('RGB').resize((int(D*c.width/c.height), D), Image.NEAREST if f == 1 else Image.LANCZOS)
    d = ImageDraw.Draw(t)
    try: ft = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 26)
    except Exception: ft = None
    d.rectangle((0, 0, t.width, 40), fill=(30, 30, 30)); d.text((12, 6), label, fill='white', font=ft)
    return t
L, R = tile(o, 1, 'OLD 640x360'), tile(n, n.width/640, f'NEW {n.width}x{n.height} (Real-ESRGAN)')
out = Image.new('RGB', (L.width + R.width + 12, D), 'white'); out.paste(L, (0, 0)); out.paste(R, (L.width + 12, 0)); out.save(a.out)
print(a.out, out.size)
