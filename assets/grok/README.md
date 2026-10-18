# Grok 娘动画素材（5 个核心）

- `webm/`：**1280×720**，24fps，VP9 + alpha（yuva420p，alpha_mode=1），脚底线 y≈658，水平居中。
- `preview/`：220×124 / 12fps 透明 gif（pinyin 文件名）。

| 文件 | 分类 | 时长 | 循环 |
|---|---|---|---|
| 待机呼吸休闲.webm | idle | 4.0s / 96f | 是（末帧已去重） |
| 原地左转走路.webm | moves | 2.0s / 48f | 是 |
| 点击回应-开心害羞.webm | clicks | 3.04s / 73f | 否 |
| 被鼠标拖拽悬空反馈.webm | drag | 3.0s / 72f | 是 |
| 登场-星光现身.webm | events.登场 | 3.04s / 73f | 否 |

管线：Grok Imagine 绿幕 → `tools/key_to_webm.py --scale-factor 2`。中间文件在 `work/grok/`。
素材授权沿用 CC BY-NC-SA 4.0（ZipZipPipe / Apprentice-Geo AI-Fanworks），禁止商用。
