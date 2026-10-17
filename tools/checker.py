#!/usr/bin/env python3
# 从 webm(VP9 alpha) 抽帧铺在棋盘格上: checker.py in.webm out.png [n帧]
import sys, subprocess, numpy as np
from PIL import Image
inp, out = sys.argv[1], sys.argv[2]; n = int(sys.argv[3]) if len(sys.argv) > 3 else 6
raw = subprocess.run(['ffmpeg','-v','error','-c:v','libvpx-vp9','-i',inp,'-f','rawvideo','-pix_fmt','rgba','-'], capture_output=True).stdout
a = np.frombuffer(raw, np.uint8).reshape(-1, 360, 640, 4)
idx = np.linspace(0, len(a)-1, n).astype(int)
yy, xx = np.mgrid[0:360, 0:640]; chk = np.where(((yy//16)+(xx//16))%2, 200, 245)[..., None].astype(np.float32)
tiles = []
for i in idx:
    f = a[i].astype(np.float32); al = f[..., 3:4]/255
    t = f[..., :3]*al + chk*(1-al); t[329, :] = [255, 0, 0]   # 红线 = 脚底线
    tiles.append(t.astype(np.uint8))
Image.fromarray(np.concatenate(tiles, 1)).save(out); print(len(a), 'frames', list(idx))
