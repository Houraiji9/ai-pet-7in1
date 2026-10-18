# Kimi 娘动画素材（5 个核心）

- `webm/`：**1280×720**，24fps，VP9 + alpha（yuva420p，alpha_mode=1），脚底线 y≈658，水平居中。
- `preview/`：220×124 / 12fps 透明 gif（pinyin 文件名）。

| 文件 | 分类 | 时长 | 循环 |
|---|---|---|---|
| 待机呼吸休闲.webm | idle | 4.0s / 96f | 是（末帧已去重） |
| 原地左转走路.webm | moves | 2.0s / 48f | 是 |
| 点击回应-开心害羞.webm | clicks | 3.04s / 73f | 否 |
| 被鼠标拖拽悬空反馈.webm | drag | 3.0s / 72f | 是 |
| 登场-星光现身.webm | events.登场 | 3.04s / 73f | 否 |

管线：Grok Imagine 绿幕 → `tools/key_to_webm.py --scale-factor 2`。中间文件在 `work/kimi/`。
素材授权沿用 CC BY-NC-SA 4.0（ZipZipPipe / Apprentice-Geo AI-Fanworks），禁止商用。

## 专属动作（201–206）
随机动作分类「专属」（categories），每个 3s / 73f，首尾都是待机姿势，不循环。来源：Grok Imagine 视频（首/末帧 = 058 待机定妆图，1.4s 关键帧 = Codex 出的 20X 专属定妆图），tools/key_to_webm.py --scale-factor 2 抠像。

| 文件 |
|---|
| 专属-兔子陪伴.webm |
| 专属-坐月亮.webm |
| 专属-摘星星.webm |
| 专属-月光下.webm |
| 专属-登月火箭.webm |
| 专属-超长文档.webm |

## 日常动作（与 DeepSeek 娘同名、同分组）
每个 3s / 73f，首尾 = 058 待机定妆图，1.4s 关键帧 = Codex 同编号定妆图；分组照抄 DeepSeek（东张西望 → turn，其余 → categories 同名分组）。

- 东张西望
- 写代码
- 原地小憩沉眠
- 哈欠连天
- 女仆屈膝礼仪
- 悠闲哼歌
- 打瞌睡被惊醒
- 照镜子
- 被吓一跳
- 超大伸懒腰
- 轻快记录
