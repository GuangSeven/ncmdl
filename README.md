# ncmdl

网易云音乐终端版下载脚本。（原脚本：[![Greasy Fork](https://img.shields.io/badge/Greasy_Fork-网易云音乐歌曲下载-8a0000?logo=greasyfork&logoColor=white&style=flat)](https://greasyfork.org/scripts/459633)）

## 目标

这个仓库现在提供的是本地终端运行版，不再依赖篡改猴、页面注入和浏览器 DOM。核心思路是把原脚本里三类能力拆开：

1. 认证信息改为本地配置文件和环境变量，不再依赖浏览器里的 GM 存储。
2. 网络请求改为 Node.js 发起的 `fetch` 请求，继续使用网易云的加密请求方式。
3. 交互改为命令行参数和交互式提示，适合终端批量下载。

## 本地配置

脚本会把配置保存到 `~/.ncmdl/config.json`。

推荐准备这些信息：

- `cookie`：从已登录的浏览器中复制出来的网易云网页 Cookie，至少建议包含 `MUSIC_U` 和 `__csrf`。
- `userAgent`：桌面浏览器的 UA 字符串，默认已经内置了一个可用值。
- `downloadDir`：下载目录。
- `quality`：默认音质，例如 `jymaster`、`lossless`、`exhigh`、`standard`。

获取 Cookie 有两种方式：

1. **自动抓取（推荐）**：运行 `node src/cli.js cookie`，脚本会自动打开系统 Edge/Chrome 浏览器并跳转到网易云音乐，你登录后脚本自动提取 Cookie 并保存到本地配置。
2. **手动输入**：运行 `node src/cli.js setup`，按提示粘贴从浏览器开发者工具中复制的 Cookie。

## 使用

先安装 Node.js 18 或更高版本，然后在仓库根目录执行：

```bash
node src/cli.js                     # 进入交互式菜单
node src/cli.js setup               # 手动输入配置
node src/cli.js cookie              # 自动打开浏览器抓取 Cookie（推荐）
node src/cli.js download 123456
node src/cli.js download https://music.163.com/song?id=123456
node src/cli.js config show
```

## 交互式菜单

直接运行 `node src/cli.js` 进入交互式菜单，无需记忆命令行参数：

| 选项 | 功能 |
|------|------|
| 1 | 抓取 Cookie（自动打开浏览器登录） |
| 2 | 手动输入配置 |
| 3 | 下载歌曲 |
| 4 | 查看配置 |
| 5 | 重置配置（需确认） |
| 0 | 退出 |

菜单支持终端与脚本两种输入方式：

- 终端（TTY）下按提示操作即可，Cookie 输入支持直接粘贴（需为单行文本，多行粘贴会被拒绝并提示重新粘贴）。
- 脚本/管道/文件重定向输入时逐行喂入选项即可，例如 `printf "4\n0\n" | node src/cli.js` 或 `node src/cli.js < menu.txt`；此时下载不会再询问是否更换 Cookie，直接使用现有配置。

## 交互方式

终端版不会再弹出 SweetAlert 或依赖网页按钮。当前脚本采用这几种交互方式：

- 没有传歌曲参数时（`node src/cli.js download`），会直接在终端里提示你输入歌曲 ID 或链接。
- 没有配置 cookie 时，会在初始化或下载时提示你补录。
- `config show` 只会展示脱敏后的 Cookie，避免直接把敏感信息打印到屏幕上。

## 浏览器版到终端版的调整

原 userscript 里依赖的这些内容在终端版里不再存在：

- `GM_*` 系列 API
- 页面注入的按钮、表格和弹窗
- 对评论区、歌单页、云盘页的 DOM 监听和拦截

这些都替换成了命令行参数、配置文件和普通 HTTP 请求。这样更适合批量任务，也更容易在 Windows 终端里直接运行。

## 当前实现范围

目前先把最核心的本地下载链路做成终端版：配置管理、Cookie 处理、歌曲信息获取和文件下载。原脚本里那些强依赖网页界面的功能，后续可以再按同样思路继续拆成子命令。
