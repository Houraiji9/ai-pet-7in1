#!/usr/bin/env bash
# webm（带 alpha）-> 220x124 / 12fps 透明 gif 预览（pinyin 文件名，同参考项目 assets/preview）
# 用法: tools/make_previews.sh <角色id>   例: tools/make_previews.sh gpt
set -e; C=${1:-gpt}; D=assets/$C; mkdir -p $D/preview
declare -A P=([待机呼吸休闲]=daiji-huxi-xiuxian [原地左转走路]=yuandi-zuozhuan-zoulu [点击回应-开心害羞]=dianji-huiying-kaixin-haixiu
  [被鼠标拖拽悬空反馈]=beishubiao-tuozhuai-xuankong-fankui [登场-星光现身]=dengchang-xingguang-xianshen)
for f in $D/webm/*.webm; do n=$(basename "$f" .webm); o=${P[$n]:-$n}
  ffmpeg -v error -y -c:v libvpx-vp9 -i "$f" -vf "fps=12,scale=220:124:flags=lanczos,split[a][b];[a]palettegen=reserve_transparent=1:stats_mode=full[p];[b][p]paletteuse=dither=none:alpha_threshold=128" -loop 0 "$D/preview/$o.gif"
  echo "$o.gif"; done
