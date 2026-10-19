# AI 七合一桌宠（ai-pet-7in1）

主人在用哪个 AI 程序，桌面上就站着哪个角色：
切到 Codex 就换成 GPT 龙娘，切到 Gemini / Antigravity 就换成 Gemini 娘……
换角色时会先播一段「登场」动画，然后回到待机。切到微信、资源管理器这类和 AI 无关的程序时，角色保持不变。

七个角色都有动画了：

| 角色 | 对应的程序 |
|---|---|
| GPT 龙娘 | Codex / ChatGPT |
| Gemini 娘 | Gemini / Antigravity |
| GLM 狐娘 | 智谱 / ZCode |
| Claude 娘 | Claude |
| Kimi 娘 | Kimi |
| DeepSeek 娘（原项目自带） | DeepSeek / WorkBuddy |
| Grok 娘 | Grok / Cursor |

每个角色有登场、待机、走路、点击、拖拽、6 个专属动作，以及几十个日常小动作（哼歌、伸懒腰、打哈欠、小睡……）。

---

## 1. 下载安装（推荐）

1. 打开 [Releases 下载页](https://github.com/Houraiji9/ai-pet-7in1/releases/latest)，下载 `AI-Pet-7in1-Setup-版本号.exe`。
   - 安装包只带程序、六个角色的核心动画，以及 DeepSeek 的全套动画（原项目自带），大约 200 MB；其余角色的专属 / 日常动作第一次启动再下。
2. 双击安装包，会自动装好，并在桌面和开始菜单放一个「七合一AI桌宠」快捷方式，装完自动启动。
   - 装在当前用户目录下，不需要管理员权限。卸载：Windows 设置 → 应用 → 找到 AI-Pet-7in1 → 卸载。
3. **第一次启动会自动下载其余动画**（专属动作、日常小动作等，高清原画质，不压缩）。右下角会弹出进度条，关掉窗口也会在后台继续；断网了下次接着下。当前正在用的角色优先下载。托盘菜单里有「动画资源」一项可以手动检查 / 重试。
4. **程序本身也会自动更新**：桌宠启动后会去 GitHub 检查新版本，在后台下载，下好后弹窗问「新版本已下好，重启安装？」。点「稍后」的话，下次退出桌宠时会自动装上。托盘菜单里也有「检查更新」。
5. 以前用**便携版**（`...-portable.exe`）的：装一次这个安装版就行，之后都会自动更新，旧的便携版 exe 可以删掉。设置（大小、开机自启）会保留。

### Windows 弹出蓝色「已保护你的电脑」怎么办

安装包没有数字签名（个人项目买不起证书），所以第一次运行 Windows SmartScreen 会拦一下：
点「**更多信息**」→「**仍要运行**」就行。
担心文件被篡改的话，可以核对 SHA-256：每个版本的值都写在 Releases 页的说明里。
在 PowerShell 里运行 `Get-FileHash .\AI-Pet-7in1-Setup-0.5.1.exe` 就能算出来对照。

### 从源码运行 / 自己打包（给会用命令行的人）

1. 安装 [Node.js LTS](https://nodejs.org) 和 [Git LFS](https://git-lfs.com)（动画素材用 Git LFS 存）。
2. `git clone https://github.com/Houraiji9/ai-pet-7in1.git`，然后在仓库里运行 `git lfs pull`。
3. 进入 `app` 文件夹：`npm install`，`npm start` 运行。
4. 打安装包：`npm run build:win`，产物在 `app\dist\`（`AI-Pet-7in1-Setup-<版本>.exe`、`.blockmap`、`latest.yml`）。
   发布新版时这三个文件都要上传到 GitHub Release，自动更新才能用。
   还想要便携版可以用 `npm run build:win-portable`（便携版不会自动更新）。

### 怎么操作

- **拖动**：按住角色拖到任意位置。松手后它会掉到屏幕底边（有重力）。
- **点击**：角色会有反应。
- **调大小**：右键角色或托盘图标 →「桌宠大小」；或者鼠标放在角色身上，按住 Ctrl 滚滚轮。
- **开机自动启动**：托盘图标右键菜单里的「开机自动启动」，默认关闭。
- **检查更新**：托盘图标右键菜单里的「检查更新」。
- **动画资源**：托盘图标右键菜单里会显示下载进度；点一下可以手动检查 / 重试。关掉进度窗也会在后台继续下。
- **右键角色**：查看余额 / 碎碎念 / 回到初始位置 / 切换角色（自动或锁定）/ 重载配置。
- **托盘图标（左键或右键都行）**：
  - 自动切换：跟着前台程序换角色（默认）。
  - 锁定角色：固定成某一个角色，不管主人在用什么程序。没有素材的角色是灰的。
  - 查看余额（当前角色）/ 余额设置（API Key）…（见下面「查看余额」）
  - 调试：查看前台窗口…（见第 2 节）
  - 最近的前台程序：点一下就把那个程序的完整路径复制到剪贴板。
  - 把前台窗口变化记到日志 / 打开日志文件 / 打开配置文件夹 / 重新加载配置 / 退出

### 查看余额

右键角色 →「查看余额」（或托盘 →「查看余额」），查的是**当前这个角色**对应的账号。先冒一个「正在查询余额…」，几秒内换成结果。

| 角色 | 查的是什么 | 要不要填东西 |
|---|---|---|
| GPT 龙娘 | Codex 的 5 小时 / 每周额度（ChatGPT 账号） | 不用。读本机 Codex（桌面版或 CLI）的登录：先问 Codex 自己（`codex app-server`），不行再读 `%USERPROFILE%\.codex\auth.json` |
| Grok | Cursor 账号额度，含 Grok Bot 那一行（新版合并套餐显示「共用额度（含 Grok Bot）」和预付余额） | 不用。只读打开 Cursor 桌面版的 `state.vscdb` 拿登录 |
| GLM | GLM 编程套餐 5 小时 / 周 / MCP 额度 | 登录了 ZCode 就不用；没装 ZCode 或想看智谱账户现金余额，再填 GLM API Key |
| DeepSeek 娘 | DeepSeek 开放平台账户余额（带峰谷时段，余额档位会换动作） | **要填** DeepSeek API Key |
| Gemini / Claude / Kimi | —— | 暂未接入，会说「…的余额查询暂未接入」 |

- **填 Key**：托盘 →「余额设置（API Key）…」。Key 用 Windows 系统加密（DPAPI，Electron safeStorage）存在用户目录的 `balance-keys.json` 里，只有桌宠能解开；保存后窗口里也看不到原文。每一项都有「查一次」可以马上试。
- **也可以用环境变量**（不想存 Key 时）：`DEEPSEEK_API_KEY`；GLM 用 `ZAI_API_KEY` / `Z_AI_API_KEY` / `GLM_API_KEY` / `ZHIPU_API_KEY`。
- **隐私**：从 Codex / Cursor / ZCode 读到的登录信息只在内存里用来发这一次请求，不写盘、不写日志、不显示，也不会交给画面那边；日志里只记「哪个来源、成功没有、花了多久」。
- **调试窗口**里有一张「查看余额」表：每个来源最近一次的状态、时间、数据来源（没有任何 Key）。
- 注意：Codex / Cursor / ZCode 的额度接口都是**非官方**的（照着开源项目 token-monitor 的做法），这些软件更新后可能会失效，届时会显示「查询失败」而不会崩。
- 5 秒内连点只查一次。

---

## 2. 修改「哪个程序对应哪个角色」

这份映射规则是从**主人之前那个 C# 桌宠（old-codex-pet）**搬过来的，那边在真机上验证过的写法都保留了。

| 角色 | 认哪个程序 | 状态 |
|---|---|---|
| GPT | `ChatGPT.exe`，而且是商店版 Codex（包身份或安装路径以 `OpenAI.Codex_` 开头） | ✅ 已验证 |
| GLM | `ZCode.exe` | ✅ 已验证 |
| Kimi | `Kimi.exe` | ✅ 已验证 |
| Gemini | `Gemini.exe`，而且路径里有 `Google\Gemini` | ✅ 已验证 |
| DeepSeek | `DeepSeek Harness.exe` | ✅ 已验证 |
| Grok | `Grok Bot.exe` | ✅ 已验证 |
| Grok | Grok Build（预留，默认关闭） | — |
| Claude | `Claude.exe` | ❓ 猜的，待确认 |
| Gemini | `Antigravity.exe` | ❓ 猜的，待确认 |
| DeepSeek | `WorkBuddy.exe` | ❓ 猜的，待确认 |
| Grok | `Cursor.exe` | ❓ 猜的，待确认 |

桌宠只看「前台窗口属于哪个 exe」，默认**不看**窗口标题。
每 0.1 秒看一次，同一个结果要稳定 0.3 秒才会真的换角色，所以 Alt+Tab 快速划过时不会乱闪。这和旧桌宠的做法一样。

### 确认「猜的」exe 名对不对

1. 托盘菜单 → **调试：查看前台窗口…**，会弹出一个一直置顶的小窗口。
2. 点一下想识别的程序（比如 Claude），小窗口里会显示：
   - **exe 文件名**（大字），例如 `Claude.exe`
   - **完整路径**，例如 `C:\Users\…\AppData\Local\AnthropicClaude\app-1.2.3\Claude.exe`
   - **识别结果**：绿色 = 已验证规则命中；橙色 = 未验证规则命中；灰色 = 没命中
3. 如果 exe 名和表里写的不一样，就按下面的步骤改。

### 改配置文件

1. 托盘菜单 → **打开配置文件夹**。
2. 用记事本打开 `agents.jsonc`。里面每一项都有中文注释。
3. 比如 Claude 的真实 exe 名是 `claude-desktop.exe`，就把
   ```
   "executables": ["Claude.exe"],
   ```
   改成
   ```
   "executables": ["claude-desktop.exe"],
   ```
   确认能用以后，顺手把 `"verified": false` 改成 `true`。
4. 存盘，然后托盘菜单 → **重新加载配置**。

几个注意点：

- 只写文件名，不用写路径，大小写无所谓。一个角色可以写好几个 exe：`["A.exe", "B.exe"]`。
- 规则从上往下找，第一条命中的生效。
- 不想要某一条规则，把 `"enabled"` 改成 `false`。
- 文件写坏了（比如少了引号）也不会崩：托盘菜单顶部会出现一行⚠提示，桌宠会继续用自带的默认规则。
- **按网页标题识别**（比如在浏览器里开 chatgpt.com）：文件最下面有 `browserTitleRules`，默认关闭。想用的话，把 `"enabled": false` 改成 `true`。
- 配置文件夹的位置：`%APPDATA%\ai-pet-7in1\`。第一次启动时，桌宠会把自带的配置复制到这里。以后更新程序也不会覆盖主人改过的文件；想恢复默认，删掉这个文件再重启就行。

### 其他可改的东西（`species.jsonc`）

同一个文件夹里还有 `species.jsonc`，可以改：

- 角色名字
- 碎碎念台词 `whisperLines`
- 角色大小 `size`（默认 400）
- 初始位置
- 每个动作出现的概率

---

## 3. 加入其他角色的动画素材

每个角色需要这 5 个视频文件，**文件名必须完全一样**：

| 文件名 | 什么时候播 |
|---|---|
| `待机呼吸休闲.webm` | 平时待机（必须有，没有它这个角色就算「没有素材」） |
| `原地左转走路.webm` | 偶尔走两步 |
| `点击回应-开心害羞.webm` | 被点击 |
| `被鼠标拖拽悬空反馈.webm` | 被拖着的时候 |
| `登场-星光现身.webm` | 切换成这个角色时先播一次 |

视频格式和 GPT 那一套一样：

- 640×360，VP9 编码，**带透明通道**的 webm；
- 角色脚底大约在画面 y=330 的位置；
- 角色主体在画面中间一块，大约 x 200–440、y 50–335（这块是鼠标能点到的区域）。

放的位置（任选一个，从上往下优先）：

1. `%APPDATA%\ai-pet-7in1\species\<角色>\` ← **推荐**，exe 版也能直接用。文件夹已经自动建好了。
2. 项目里的 `ai-pet-7in1\assets\<角色>\webm\`（`npm start` 时直接读；`npm run build:win` 会把它打包进 exe）。

`<角色>` 是这几个英文名之一：`gpt` `gemini` `glm` `claude` `kimi` `deepseek` `grok`。

放好后，托盘菜单 → **重新加载配置**。这个角色在「锁定角色」里就不再是灰色，自动切换也会生效。
想换动作名字、多加几个动作，可以改 `species.jsonc` 里这个角色的 `animations`，写法照抄 DeepSeek 那一段。

---

## 4. 和原项目（dsh-pet）比，改了什么

原项目：<https://github.com/PC2005-cloud/dsh-pet>（DeepSeek 娘桌宠，是 Koishi 插件，也有独立模式）。

- **保留**：
  - 透明窗口、置顶守护、高分屏（DPI）处理、点击穿透；
  - 拖拽 + 重力 + 落地、随机走动、点击反应、右键菜单的样子；
  - 动画播放器和全部 DeepSeek 娘素材。
- **新增**：
  - 七个角色，以及「跟着前台程序换角色」（规则来自主人的旧 C# 桌宠）；
  - 换角色时播登场动画；
  - 托盘菜单（自动 / 锁定 / 调试 / 日志 / 配置 / 退出）；
  - 调试窗口；
  - 右键「查看余额」：按角色查 Codex / Cursor（Grok Bot）/ GLM / DeepSeek 的余额额度（读取方式移植自 token-monitor）；
  - 可以用记事本改的配置文件；
  - 每个角色的人设提示词草稿（`species.jsonc` 里的 `whisperPrompt`，现在还没用上）。
- **简化**：
  - 原项目要先启动一个 Node 主程序，再拉起一个 Electron 窗口；现在只有一个程序，双击就能跑。
- **去掉 / 暂时关闭**：
  - 工作状态、通知、打开 DeepSeek 网站这几个按钮，原项目独立模式下本来就用不了（余额显示已经重新接上，见上面「查看余额」）；
  - 和 AI 聊天：要联网和 API Key，本版先关闭；
  - 碎碎念目前是从每个角色的台词里随机挑一句（默认 5 分钟一次，右键「碎碎念」也能立刻说）。
- 原项目的文件一个字都没改，新代码都在 `app\` 里。

---

## 5. 版权说明（请务必看）

这个项目里**代码和素材是两套许可**：

- **程序代码**：MIT 许可证，见根目录 [`LICENSE`](LICENSE)。代码基于 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT），余额查询部分移植自 [Javis603/token-monitor](https://github.com/Javis603/token-monitor)（MIT）。
- **角色形象和动画**：**CC BY-NC-SA 4.0**，**禁止商用**，见 [`LICENSE-ASSETS.md`](LICENSE-ASSETS.md)。
  形象来自 [ZipZipPipe](https://space.bilibili.com/4168597) 的《大 AI 与小 AI 们》和 [ApprenTice](https://space.bilibili.com/634972797) 的 [AI-Fanworks](https://github.com/Apprentice-Geo/AI-Fanworks)。
  转发或二次创作要保留署名，并用同样的许可证发布。
- **DeepSeek 娘动画**：来自原项目 dsh-pet，作者声明禁止商用；衍生作品需注明 <https://github.com/PC2005-cloud/dsh-pet>。
- **气泡字体**：站酷快乐体，SIL Open Font License 1.1。原项目里的「上首软糖体」只允许个人非商用、嵌入软件需另外授权，所以已经换掉。
- 完整的第三方清单见 [`NOTICE.md`](NOTICE.md)。

所以这个桌宠只能自己用或者免费分享，不能卖、不能拿来收费。

---

## 6. 文件夹里都是什么

```
ai-pet-7in1\
├─ README.md            ← 就是这份说明
├─ assets\gpt\webm\     ← 各角色的动画（安装包只带核心；其余第一次启动从 GitHub 按需下载）
├─ old-codex-pet\       ← 主人之前的 C# 桌宠（只参考了它的识别规则，没有改它）
└─ app\                 ← 新桌宠
   ├─ config\agents.jsonc    程序→角色 映射（默认版）
   ├─ config\species.jsonc   角色、动作、台词（默认版）
   ├─ assets\                DeepSeek 素材、字体、鼠标图标
   ├─ main\                  后台：前台窗口识别、切换、托盘
   ├─ main\balance\          查看余额（Codex / Cursor / ZCode / DeepSeek）
   ├─ renderer\              桌宠画面、调试窗口、余额设置窗口
   ├─ test\ tools\           自动测试
   └─ dist\                  打包好的 exe
```

出问题时：托盘菜单 → **打开日志文件**，把里面最后几十行发给帮主人修的人就行。
