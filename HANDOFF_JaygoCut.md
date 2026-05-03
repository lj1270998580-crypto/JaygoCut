# Jaygo Cut Handoff Document

更新时间：2026-05-02
当前源码版本：`0.1.13`
项目目录：`C:\Users\15119\Documents\New project\repo`
本机测试安装目录：`D:\Jaygo Cut\JaygoCut`
在线更新地址：`https://ailabing.cn/downloads/jaygo/`
GitHub 仓库：`https://github.com/lj1270998580-crypto/JaygoCut`

## 1. 产品定位

Jaygo Cut 是 Windows 桌面端口播视频剪辑工具。核心流程：选择视频 -> 提取音频 -> 云端 ASR 或本地模型转录 -> 生成审核页 -> 自动标记静音/语气词/重复句/LLM 建议 -> 人工复核 -> FFmpeg 精确裁剪 -> 导出成片/字幕/文案。

## 2. 当前重点能力

- 转录引擎：火山引擎 ASR、阿里 DashScope `qwen3-asr-flash-filetrans` 异步识别、本地 Whisper/ggml 模型。
- 本地模型：安装包不内置大模型；设置页支持全机扫描可用语音模型和一键下载/安装。
- 审核页：音频播放、波形缩放、逐字文本、颜色标记、拖选、撤销、静音阈值重算、历史恢复、自动保存。
- 规则预标记：静音阈值默认 >= 0.2 秒；语气词、重复句、卡壳/重说会用不同颜色标注。
- LLM：多服务商兼容；支持语义标记、标点分段、发布建议、LLM 对话调标记。
- 视频配图：审核页悬浮入口，可生成配图点、分镜提示词、图片预览、单图重试和批量下载。
- 字幕：审核页支持导出 SRT（剪映可导入）、TXT 文案和剪映草稿目录；草稿可复用用户自己的字幕模板草稿目录。剪映 6.x+ 可能加密草稿，SRT 保留为兜底。
- 更新：electron-updater generic provider，支持应用内显示版本更新内容。

## 3. 关键目录

- `electron/`：Electron 主进程、预加载、主界面和资源。
- `talkcut/`：口播剪辑核心逻辑。
- `talkcut/scripts/`：转录、审核页、本地 review server、裁剪脚本。
- `talkcut/user_rules/`：静音、语气词、重复句等规则文档。
- `subtitles/`：字幕功能。
- `server/jaygo-upload/`：公网临时音频上传服务。
- `install/`：安装说明。
- `evolution/`：原项目演进资料。

## 4. 关键文件

- `electron/main.js`：任务编排、设置保存、ASR 连通检测、模型扫描/安装、在线更新。
- `electron/preload.js`：主进程 IPC API 暴露。
- `electron/renderer/index.html`：主界面 DOM。
- `electron/renderer/renderer.js`：主界面交互。
- `electron/renderer/styles.css`：主界面样式。
- `talkcut/scripts/generate_review.js`：生成审核页 HTML/CSS/JS，审核体验核心。
- `talkcut/scripts/review_server.js`：审核页本地服务、LLM、发布建议、视频配图、裁剪 API。
- `talkcut/scripts/cut_video.js`：FFmpeg 精确剪辑导出。
- `talkcut/scripts/generate_subtitles.js`：转录结果转审核字幕。
- `talkcut/scripts/qwen_asr_transcribe.js`：阿里 Qwen3-ASR 异步转录。
- `talkcut/scripts/volcengine_transcribe.js`：火山引擎转录。
- `talkcut/scripts/whisper_transcribe_local.js`：本地模型转录。
- `release-notes.json`：在线更新说明示例，上传服务器后供客户端展示。
- `CHANGELOG.md`：版本变更记录。

## 5. 2026-05-03 最新改动
- 主界面设置移除“图片比例”，比例选择统一放在审核页视频配图面板，减少设置区重复项。
- 审核页仍会把当前图片比例传给图片生成接口，功能不丢失。
- 版本升至 0.1.13，安装包和在线更新产物用于服务器/GitHub 发布。

## 5. 2026-05-02 最新改动
- 审核页新增快捷键指南按钮：Space 播放/暂停、Ctrl+Z 多步撤回、Ctrl+Y / Ctrl+Shift+Z 重做、Ctrl+F 聚焦搜索纠错、Ctrl+S 立即保存、Esc 关闭浮窗。
- 审核页新增文本搜索与替换：支持单处替换和全部替换，用于修正“他/她/它”、人名、品牌名等识别错误；修正会保存到 review-state，并进入 SRT/TXT/剪映草稿导出。

- 修复审核页非全屏时“发布建议”和“视频配图”悬浮按钮重叠：按钮改为 CSS 变量控制垂直栈，窄窗口保持固定间距。
- LLM 口播标记提示词重写为保守剪辑策略：先理解主题和文章结构，再保护主线，只删高确定性冗余。
- LLM 删除建议最低置信门槛从 `0.56` 提升到 `0.66`，语义删除要求更高，减少误删。
- LLM 候选数量上限从 30% 降到 16%，无高置信候选时的 fallback 从 35% 降到 18%。
- 在线更新状态增加 `releaseNotes`，客户端可从服务器 `release-notes.json` 显示本次更新内容。
- README、软件介绍、交接文档、CHANGELOG、release-notes 已同步。

## 6. 本地开发命令

```powershell
cd "C:\Users\15119\Documents\New project\repo"
npm run check
npm test
npm run pack:win:local
npm run dist:win:local
```

## 7. 本机安装版热替换

用于快速测试，不用于发给用户。

```powershell
Stop-Process -Name JaygoCut -Force -ErrorAction SilentlyContinue
Copy-Item "D:\Jaygo Cut\JaygoCut\resources\app.asar" "D:\Jaygo Cut\JaygoCut\resources\app.asar.bak_$(Get-Date -Format yyyyMMdd_HHmmss)" -Force
Copy-Item "dist\win-unpacked\resources\app.asar" "D:\Jaygo Cut\JaygoCut\resources\app.asar" -Force
```

## 8. 打包产物

NSIS 打包后 `dist/` 至少有：

- `JaygoCut-Setup-<version>.exe`
- `JaygoCut-Setup-<version>.exe.blockmap`
- `latest.yml`

桌面复制示例：

```powershell
$version = "0.1.13"
Copy-Item "dist\JaygoCut-Setup-$version.exe" "C:\Users\15119\Desktop\JaygoCut-Setup-$version.exe" -Force
Copy-Item "HANDOFF_JaygoCut.md" "C:\Users\15119\Desktop\HANDOFF_JaygoCut.md" -Force
```

## 9. 在线更新服务器配置

客户端配置：

- `package.json` -> `build.publish.url`
- `electron/main.js` -> `UPDATE_FEED_URL`

当前线上地址：

- 更新目录 URL：`https://ailabing.cn/downloads/jaygo/`
- 服务器 IP：`47.115.58.109`
- Web 服务：宝塔托管 Nginx
- HTTPS：已配置
- 服务器目录：`/www/wwwroot/ailabing.cn/downloads/jaygo`

服务器目录建议保留：

- `latest.yml`
- 当前安装包 `.exe`
- 当前 `.exe.blockmap`
- `release-notes.json`
- 可选：上一个版本安装包和 blockmap，方便差分失败时回退。

## 10. release-notes.json 格式

客户端会优先读取 `https://ailabing.cn/downloads/jaygo/release-notes.json`。

支持格式一：

```json
{
  "version": "0.1.12",
  "notes": "- 修复审核页按钮重叠\n- 优化 LLM 标记准确性"
}
```

支持格式二：

```json
{
  "versions": {
    "0.1.12": "- 修复审核页按钮重叠\n- 优化 LLM 标记准确性"
  }
}
```

## 11. 上传服务器流程

敏感信息不要写入仓库或文档。SSH 密码、宝塔密码由项目负责人单独保存。下面用 `<SSH_PASSWORD>` 占位。

```powershell
$version = "0.1.13"
$remote = "root@47.115.58.109:/www/wwwroot/ailabing.cn/downloads/jaygo/"
$tmp = Join-Path $env:TEMP 'jaygo_askpass.cmd'
$pw = '<SSH_PASSWORD>'
Set-Content -LiteralPath $tmp -Value "@echo off
echo $pw
" -Encoding ASCII
$env:SSH_ASKPASS = $tmp
$env:SSH_ASKPASS_REQUIRE = 'force'
$env:DISPLAY = 'none'
$known = "$env:TEMP\jaygo_known_hosts"
try {
  scp -o StrictHostKeyChecking=no -o UserKnownHostsFile="$known" -o PreferredAuthentications=password -o PubkeyAuthentication=no `
    "dist\JaygoCut-Setup-$version.exe" `
    "dist\JaygoCut-Setup-$version.exe.blockmap" `
    "dist\latest.yml" `
    "release-notes.json" `
    $remote

  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile="$known" -o PreferredAuthentications=password -o PubkeyAuthentication=no root@47.115.58.109 `
    "chown www:www /www/wwwroot/ailabing.cn/downloads/jaygo/JaygoCut-Setup-$version.exe /www/wwwroot/ailabing.cn/downloads/jaygo/JaygoCut-Setup-$version.exe.blockmap /www/wwwroot/ailabing.cn/downloads/jaygo/latest.yml /www/wwwroot/ailabing.cn/downloads/jaygo/release-notes.json; ls -lh /www/wwwroot/ailabing.cn/downloads/jaygo"
} finally {
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
}
```

## 12. 上传后验证

```powershell
$version = "0.1.13"
curl.exe -L --max-time 30 https://ailabing.cn/downloads/jaygo/latest.yml
curl.exe -L --max-time 30 https://ailabing.cn/downloads/jaygo/release-notes.json
curl.exe -I --max-time 30 "https://ailabing.cn/downloads/jaygo/JaygoCut-Setup-$version.exe"
```

检查点：

- `latest.yml` 的 `version` 和 `path` 是当前版本。
- 安装包 HEAD 请求返回 200。
- `release-notes.json` 能正常返回 UTF-8 中文。
- 客户端更新页能显示更新内容。

## 13. 清理服务器旧版本

确认新版本可下载后再清理。建议至少保留当前版本；若担心差分更新失败，可多保留上一个版本。

```powershell
ssh root@47.115.58.109 "cd /www/wwwroot/ailabing.cn/downloads/jaygo && ls -lh"
ssh root@47.115.58.109 "cd /www/wwwroot/ailabing.cn/downloads/jaygo && rm -f JaygoCut-Setup-0.1.6.exe JaygoCut-Setup-0.1.6.exe.blockmap JaygoCut-Setup-0.1.7.exe JaygoCut-Setup-0.1.7.exe.blockmap"
ssh root@47.115.58.109 "cd /www/wwwroot/ailabing.cn/downloads/jaygo && ls -lh"
```

## 14. GitHub 发布流程建议

优先使用 GitHub CLI 或网页创建 Release，不建议再使用旧 `publish.js`。旧 `publish.js` 若保留必须改成读取环境变量，不能写死 token。

```powershell
git status --short
git add .
git commit -m "chore: release 0.1.12"
git push

gh release create v0.1.12 `
  "dist\JaygoCut-Setup-0.1.12.exe" `
  "dist\JaygoCut-Setup-0.1.12.exe.blockmap" `
  "dist\latest.yml" `
  "release-notes.json" `
  --title "JaygoCut v0.1.12" `
  --notes-file CHANGELOG.md
```

## 15. 常见排查

### 审核页空白

1. 运行 `npm run check`。
2. 运行 `npm test`，测试会生成 `review.html` 并对内联脚本做 `node --check`。
3. 检查 `generate_review.js` 模板字符串中是否把 `\n` 写成了真实换行。

### LLM 标记不准

1. 先确认规则预标记是否正常。
2. 检查 `review_server.js` 的 `buildLlmPrompt`。
3. 不要把提示词改成“尽量多删”，口播剪辑应先保主线。
4. 检查模型是否返回 JSON；MiniMax/Claude 兼容网关有时会返回 thinking 块或空文本。

### 音频上传失败

1. 检查公网上传服务进程。
2. 检查 Nginx `client_max_body_size`。
3. 检查 HTTPS 证书和域名解析。
4. 检查上传目录权限。
5. 客户端会多端点/多次重试，但服务端不稳仍会失败。

### 本地模型不可用

1. 设置页点击“检查模型”。
2. 若未找到，点击“安装本地模型”。
3. 模型不应打入安装包，避免安装包过大。

## 16. 当前风险与待办

- 剪映草稿导出已生成 `draft_content.json` / `draft_meta_info.json` / `draft_virtual_store.json`，并支持自定义字幕模板；但剪映 6.x+ 草稿可能加密，无法保证所有版本直接打开。
- 视频配图依赖用户配置的图片生成模型，质量取决于模型能力和 prompt。
- LLM 标记已经更保守，但仍必须由用户在审核页确认后再执行裁剪。
- `publish.js` 已改为安全版本，只读取环境变量，不再写死 token。`DESKTOP_APP.md`、`install/README.md`、`evolution/README.md` 已清理；`install/SKILL.md` 保留。

## 17. 参考资料

- Electron updater generic provider：`https://www.electron.build/auto-update`
- 阿里 DashScope Qwen ASR：`https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference`
- qwen3-asr-flash-filetrans：项目负责人提供的 Bailian 控制台文档 URL。
