#!/usr/bin/env python3
"""绿幕 mp4 -> 640x360 / 24fps / VP9 alpha webm（对齐 dsh-pet 素材规格：脚底线 y=329，水平居中 x=320）。
用法: key_to_webm.py in.mp4 out.webm [--scale S] [--drop-last]
      [--scale-factor F]      画布/脚底线/中心/人物高 统一 ×F（F=2 → 1280x720，脚底线 y=658）
      [--frames-dir DIR]      改用 DIR 下的 PNG 序列（如 Real-ESRGAN 超分后的绿幕帧）代替 in.mp4 解码
      [--match WEBM]          首帧人物 bbox（高/底/中心）对齐已有 640 webm ×F，保证与旧版位置一致
超分（先超分再抠图，边缘更干净）见 tools/upscale_raw.sh。
抠图：alpha 由 g - max(r,b) 计算（软阈值），并做绿色溢色抑制 g=min(g,max(r,b))。"""
import sys, subprocess, json, argparse, numpy as np
from PIL import Image

W, H, FPS, FOOT, CX = 640, 360, 24, 329, 320

def probe(path):
    o = json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v','-show_entries','stream=width,height','-of','json',path]))
    s = o['streams'][0]; return s['width'], s['height']

def frames(path):
    w, h = probe(path)
    p = subprocess.Popen(['ffmpeg','-v','error','-i',path,'-vf',f'fps={FPS}','-f','rawvideo','-pix_fmt','rgb24','-'], stdout=subprocess.PIPE)
    out = []
    while True:
        b = p.stdout.read(w*h*3)
        if len(b) < w*h*3: break
        out.append(np.frombuffer(b, np.uint8).reshape(h, w, 3).astype(np.float32))
    p.wait(); return out

def frames_dir(d):
    import glob
    return [np.asarray(Image.open(f).convert('RGB')).astype(np.float32) for f in sorted(glob.glob(d+'/*.png'))]

def ref_bbox(webm):
    w, h = probe(webm)
    raw = subprocess.check_output(['ffmpeg','-v','error','-c:v','libvpx-vp9','-i',webm,'-frames:v','1','-f','rawvideo','-pix_fmt','rgba','-'])
    a = np.frombuffer(raw, np.uint8).reshape(h, w, 4)[...,3]
    return bbox(a)

def key(rgb, lo=18, hi=70):
    r, g, b = rgb[...,0], rgb[...,1], rgb[...,2]
    d = g - np.maximum(r, b)              # 绿色程度
    a = 1 - np.clip((d - lo) / (hi - lo), 0, 1)
    out = rgb.copy()
    out[...,1] = np.minimum(g, np.maximum(r, b) + 4)   # despill
    # 半透明边缘再压一点绿
    return np.dstack([out, a*255]).clip(0,255).astype(np.uint8)

def bbox(alpha, t=128):
    ys, xs = np.where(alpha > t)
    return xs.min(), xs.max(), ys.min(), ys.max()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('inp'); ap.add_argument('out')
    ap.add_argument('--height', type=float, default=268, help='首帧人物像素高度（含呆毛到鞋底）')
    ap.add_argument('--scale', type=float, default=None)
    ap.add_argument('--foot', type=float, default=FOOT, help='首帧 bbox 底部落在 y=?')
    ap.add_argument('--ref-frame', type=int, default=0, help='用哪一帧定位')
    ap.add_argument('--drop-last', action='store_true', help='循环动画去掉与首帧重复的末帧')
    ap.add_argument('--scale-factor', type=float, default=1.0)
    ap.add_argument('--frames-dir'); ap.add_argument('--match')
    ap.add_argument('--crf', type=int, default=30)
    a = ap.parse_args()
    global W, H, CX
    F = a.scale_factor
    W, H, CX = round(640*F), round(360*F), 320*F
    foot, tgt_h = a.foot*F, a.height*F
    if a.match:
        mx0, mx1, my0, my1 = ref_bbox(a.match)
        tgt_h, foot, CX = (my1-my0+1)*F, (my1+1)*F, (mx0+mx1+1)/2*F
    fr = frames_dir(a.frames_dir) if a.frames_dir else frames(a.inp)
    if a.drop_last: fr = fr[:-1]
    keyed = [key(f) for f in fr]
    x0, x1, y0, y1 = bbox(keyed[a.ref_frame][...,3])
    s = a.scale*F if a.scale else tgt_h / (y1 - y0 + 1)
    cx = (x0 + x1 + 1) / 2
    ox, oy = CX - cx*s, foot - (y1+1)*s
    h, w = keyed[0].shape[:2]
    nw, nh = round(w*s), round(h*s)
    enc = subprocess.Popen(['ffmpeg','-v','error','-y','-f','rawvideo','-pix_fmt','rgba','-s',f'{W}x{H}','-r',str(FPS),'-i','-',
        '-c:v','libvpx-vp9','-pix_fmt','yuva420p','-crf',str(a.crf),'-b:v','0','-auto-alt-ref','0','-row-mt','1','-metadata:s:v:0','alpha_mode=1',a.out], stdin=subprocess.PIPE)
    canv_frames = []
    for k in keyed:
        # 预乘缩放，避免边缘发黑/发绿
        f = k.astype(np.float32); al = f[...,3:4]/255
        pm = np.dstack([f[...,:3]*al, f[...,3]])
        im = Image.fromarray(pm.clip(0,255).astype(np.uint8), 'RGBA')
        im = Image.merge('RGBA', [Image.fromarray(pm[...,i].astype(np.uint8)).resize((nw,nh), Image.LANCZOS) for i in range(4)])
        c = Image.new('RGBA', (W, H), (0,0,0,0)); c.paste(im, (round(ox), round(oy)))
        arr = np.asarray(c).astype(np.float32); al = arr[...,3:4]/255
        rgb = np.where(al>0, arr[...,:3]/np.maximum(al,1e-6), 0)
        arr = np.dstack([rgb, arr[...,3]]).clip(0,255).astype(np.uint8)
        arr[arr[...,3] < 6] = 0
        enc.stdin.write(arr.tobytes())
    enc.stdin.close(); enc.wait()
    print(json.dumps({'out': a.out, 'frames': len(fr), 'sec': len(fr)/FPS, 'scale': s, 'offset': [ox, oy], 'ref_bbox': [int(x0),int(x1),int(y0),int(y1)]}))

main()
