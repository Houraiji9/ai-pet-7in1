#!/usr/bin/env bash
# 绿幕原片 -> 24fps PNG -> Real-ESRGAN realesr-animevideov3 x2（CPU 上用 Mesa lavapipe 跑 Vulkan）
# 用法: tools/upscale_raw.sh raw.mp4 outdir   （需 realesrgan-ncnn-vulkan，RESR=二进制目录）
set -e; RESR=${RESR:-$HOME/resr}; mkdir -p "$2/in" "$2/out"
ffmpeg -v error -y -i "$1" -vf fps=24 "$2/in/%04d.png"
VK_ICD_FILENAMES=${VK_ICD_FILENAMES:-/usr/share/vulkan/icd.d/lvp_icd.json} \
  "$RESR/realesrgan-ncnn-vulkan" -i "$2/in" -o "$2/out" -n realesr-animevideov3 -s 2 -m "$RESR/models" -f png
