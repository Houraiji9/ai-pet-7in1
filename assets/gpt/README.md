# GPT 龙娘动画素材（v2 高清，5 个）
- `webm/`（主用）：**1280x720**，24fps，VP9 + alpha（yuva420p，alpha_mode=1），布局 = 640 版 ×2：脚底线 y≈658，人物水平居中 x≈640，待机人物高 ≈536px。
- `webm-640/`：旧 v1 640x360 版（dsh-pet 原规格，脚底线 y=329，居中 x≈320），备用。
桌宠按窗口宽度等比缩放视频，两套在屏幕上大小、位置完全一致；1280 版在高 DPI（150%/200%）屏或放大显示时更清晰。
v2 做法：绿幕原片逐帧 Real-ESRGAN（realesr-animevideov3，×2）超分后再抠像导出（tools/upscale_raw.sh → tools/key_to_webm.py --frames-dir --scale-factor 2 --match 旧版webm）。前后对比：work/gpt/compare-sharpness.png（未入库，可用 tools/compare_sharpness.py 重新生成）。
预览 gif：220x124，12fps，透明底，pinyin 文件名（同参考项目 assets/preview），由 1280 版生成：tools/make_previews.sh gpt。
| 文件 | 分类 | 时长 | 循环 |
|---|---|---|---|
| 待机呼吸休闲.webm | idle | 4.0s / 96f | 是（首尾同姿势，末帧已去重） |
| 原地左转走路.webm | moves（朝左，原地走，位移由程序做） | 2.0s / 48f | 是 |
| 点击回应-开心害羞.webm | clicks | 3.04s / 73f | 否，首尾都是待机姿势 |
| 被鼠标拖拽悬空反馈.webm | drag | 3.0s / 72f | 是 |
| 登场-星光现身.webm | 新增（参考项目无此分类） | 3.04s / 73f | 否，结尾 = 待机首帧 |
来源：Grok Imagine 视频（首/末帧锚定定妆图）；走路、拖拽的关键帧由 Codex CLI 生图。
管线：tools/key_to_webm.py（g-max(r,b) 软阈值抠像 + 去溢色 + 预乘缩放 + 脚底对齐）。中间文件在 work/gpt/。
素材授权沿用 CC BY-NC-SA 4.0（ZipZipPipe / Apprentice-Geo AI-Fanworks），禁止商用。
