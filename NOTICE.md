# NOTICE — 第三方组件与来源

| 组件 | 来源 | 许可 |
| --- | --- | --- |
| 程序框架（独立模式、渲染器、动画播放） | [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) | MIT，见 `app/LICENSE-dsh-pet.txt` |
| 余额查询（Codex / Cursor / ZCode 读取解析） | [Javis603/token-monitor](https://github.com/Javis603/token-monitor) | MIT，见 `app/LICENSE-token-monitor.txt` |
| 气泡字体 站酷快乐体 `app/assets/fonts/ZCOOLKuaiLe-Regular.ttf` | [googlefonts/zcool-kuaile](https://github.com/googlefonts/zcool-kuaile)（取自 [google/fonts](https://github.com/google/fonts/tree/main/ofl/zcoolkuaile)） | SIL Open Font License 1.1，见 `app/assets/fonts/OFL-ZCOOLKuaiLe.txt` |
| DeepSeek 娘动画 `app/assets/deepseek/` | PC2005-cloud/dsh-pet | 禁止商用，见 `LICENSE-ASSETS.md` |
| 其他六个角色的形象与动画 | ZipZipPipe / ApprenTice（AI-Fanworks）设计的再创作 | CC BY-NC-SA 4.0，见 `LICENSE-ASSETS.md` |
| Electron、electron-updater、koffi 等 npm 依赖 | 各自仓库 | 各自许可证（安装包内 `LICENSES.chromium.html` 等） |

## 关于原字体「上首软糖体」

上游 dsh-pet 自带 `上首软糖体.ttf`，但上游没有附带该字体的授权说明。
字体版权方上首造字官网（<https://www.ssfonts.com/lists/24.html>）说明：网站提供的下载为
「个人非商用版本」，而嵌入软件/APP 属于需单独咨询授权的「嵌入式用途」。
本项目无法确认可以随程序再分发，因此自 v0.5.0 起已移除该字体，改用开源的站酷快乐体（OFL 1.1）。
