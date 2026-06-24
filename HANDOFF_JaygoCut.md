# Jaygo Cut Handoff Document

更新时间：2026-06-24
当前源码版本：`0.1.17`
项目目录：`C:\Users\15119\Documents\New project\repo`
本机测试安装目录：`D:\Jaygo Cut\JaygoCut`
在线更新地址：`https://ailabing.cn/downloads/jaygo/`
GitHub 仓库：`https://github.com/lj1270998580-crypto/JaygoCut`

## 1. 产品定位

Jaygo Cut 是 Windows 桌面端口播视频剪辑工具。核心流程是：选择视频 -> 提取音频 -> 云端 ASR 或本地模型转录 -> 生成审核页 -> 自动标记静音/语气词/重复句/LLM 建议 -> 人工复核 -> FFmpeg 精确裁剪 -> 导出成片或完整剪映草稿。

## 2. 当前核心能力

- 转录引擎：火山引擎 ASR、阿里 DashScope `qwen3-asr-flash-filetrans` 异步识别、本地 Whisper/ggml 模型。
- 本地模型：安装包不内置大模型，设置页支持检查本机可用语音模型，并支持一键下载安装。
- 审核页：音频播放、波形缩放、逐字文本、颜色标记、拖选、撤销/重做、静音阈值重算、历史恢复、自动保存。
- 审核页可信度：支持删除诊断、剪辑精度模式、裁剪前备份和复制诊断信息。
- 规则预标记：静音阈值默认 `>= 0.2` 秒；语气词、重复句、LLM 建议使用不同颜色标注。
- LLM：多服务商兼容，支持语义标记、标点分段、发布建议、LLM 对话调标记。
- 插入素材：审核页悬浮入口，支持配图点、视频素材点、分镜提示词、人物/场景资产图、图片动效、单图/单视频重试、批量下载和裁剪合成。
- 剪映导出：审核页支持导出完整剪映草稿，自动识别剪映/CapCut 草稿目录，也可基于用户选定模板草稿生成新草稿。
- 在线更新：electron-updater generic provider，应用内显示版本和更新说明。

## 3. 0.1.17 更新重点

- 修复审核页“导出剪映”点击后缺少反馈的问题，导出前会刷新剪映目录和模板候选，失败时弹窗提示原因。
- 人物/场景资产图支持预览和删除，正式图片/视频按分镜内容自动匹配参考资产，不再全量引用。
- 修复 Agnes 视频素材生成把本地参考图误传给视频接口导致 `Invalid image` 或 `fetch failed` 的问题。
- `review_server.js` 对 Agnes 视频创建和轮询增加网络重试；参考图被拒绝时会自动降级为文本生成。
- 清理审核页工具区空白占位，折叠工具面板更紧凑，给审核文本留出更多空间。
- 在线更新说明、CHANGELOG、安装包、GitHub Release 需保持同一版本号。

## 4. 关键目录

- `electron/`：Electron 主进程、预加载、主界面和资源。
- `electron/main.js`：任务编排、设置保存、ASR 连通检测、模型扫描/安装、在线更新、历史恢复。
- `electron/preload.js`：IPC API 暴露。
- `electron/renderer/renderer.js`：主界面交互。
- `electron/renderer/styles.css`：主界面样式。
- `electron/history_utils.js`：历史记录健康检查、缺失视频处理和重新定位逻辑。
- `talkcut/scripts/generate_review.js`：生成审核页 HTML/CSS/JS，是审核体验核心文件。
- `talkcut/scripts/review_server.js`：审核页本地服务、LLM、发布建议、视频配图、裁剪 API。
- `talkcut/scripts/review_segment_utils.js`：删除片段边界、诊断和备份相关工具函数。
- `talkcut/scripts/cut_video.js`：FFmpeg 精确剪辑导出。
- `talkcut/scripts/generate_subtitles.js`：转录结果转审核字幕。
- `talkcut/scripts/qwen_asr_transcribe.js`：阿里 Qwen3-ASR 异步转录。
- `talkcut/scripts/volcengine_transcribe.js`：火山引擎转录。
- `talkcut/scripts/whisper_transcribe_local.js`：本地模型转录。
- `tests/review_regression.test.js`：审核页和裁剪相关回归测试。
- `release-notes.json`：在线更新说明，上传服务器后供客户端展示。
- `CHANGELOG.md`：版本变更记录。

## 5. 本地开发命令

```powershell
cd "C:\Users\15119\Documents\New project\repo"
npm run check
npm test
npm run pack:win:local
npm run dist:win:local
```

## 6. 本机安装版热替换

用于快速测试，不用于发给用户。

```powershell
cd "C:\Users\15119\Documents\New project\repo"
Stop-Process -Name JaygoCut -Force -ErrorAction SilentlyContinue
Copy-Item "D:\Jaygo Cut\JaygoCut\resources\app.asar" "D:\Jaygo Cut\JaygoCut\resources\app.asar.bak_$(Get-Date -Format yyyyMMdd_HHmmss)" -Force
Copy-Item "dist\win-unpacked\resources\app.asar" "D:\Jaygo Cut\JaygoCut\resources\app.asar" -Force
```

## 7. 打包产物

NSIS 打包后 `dist/` 至少包含：

- `JaygoCut-Setup-<version>.exe`
- `JaygoCut-Setup-<version>.exe.blockmap`
- `latest.yml`

桌面复制示例：

```powershell
$version = "0.1.17"
Copy-Item "dist\JaygoCut-Setup-$version.exe" "C:\Users\15119\Desktop\JaygoCut-Setup-$version.exe" -Force
Copy-Item "HANDOFF_JaygoCut.md" "C:\Users\15119\Desktop\HANDOFF_JaygoCut.md" -Force
```

## 8. 在线更新服务器配置

客户端配置位置：

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
- 可选：上一版本安装包和 blockmap，方便差分失败时回退。

## 9. release-notes.json 格式

客户端会优先读取 `https://ailabing.cn/downloads/jaygo/release-notes.json`。

```json
{
  "version": "0.1.17",
  "notes": "- 更新内容第一条\n- 更新内容第二条"
}
```

也支持：

```json
{
  "versions": {
    "0.1.17": "- 更新内容第一条\n- 更新内容第二条"
  }
}
```

## 10. 上传服务器流程

敏感信息不要写入仓库或文档。SSH 密码、宝塔密码由项目负责人单独保存。下面用 `<SSH_PASSWORD>` 占位。

```powershell
cd "C:\Users\15119\Documents\New project\repo"
$version = "0.1.17"
$remote = "root@47.115.58.109:/www/wwwroot/ailabing.cn/downloads/jaygo/"
$tmp = Join-Path $env:TEMP 'jaygo_askpass.cmd'
$pw = '<SSH_PASSWORD>'
Set-Content -LiteralPath $tmp -Value "@echo off`necho $pw`n" -Encoding ASCII
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

## 11. 上传后验证

```powershell
$version = "0.1.17"
curl.exe -L --max-time 30 https://ailabing.cn/downloads/jaygo/latest.yml
curl.exe -L --max-time 30 https://ailabing.cn/downloads/jaygo/release-notes.json
curl.exe -I --max-time 30 "https://ailabing.cn/downloads/jaygo/JaygoCut-Setup-$version.exe"
```

检查点：

- `latest.yml` 的 `version` 和 `path` 是当前版本。
- 安装包 HEAD 请求返回 200。
- `release-notes.json` 正常返回 UTF-8 中文。
- 客户端更新页能显示更新内容。

## 12. GitHub 发布流程

优先使用 GitHub CLI 或网页创建 Release。不要把 token 写进仓库。

```powershell
cd "C:\Users\15119\Documents\New project\repo"
git status --short
git add electron/main.js electron/preload.js electron/renderer/renderer.js electron/renderer/styles.css electron/history_utils.js talkcut/scripts/generate_review.js talkcut/scripts/review_segment_utils.js talkcut/scripts/review_server.js tests/review_regression.test.js package.json package-lock.json release-notes.json CHANGELOG.md HANDOFF_JaygoCut.md
git commit -m "chore: release 0.1.17"
git tag v0.1.17
git push origin main
git push origin v0.1.17

gh release create v0.1.17 `
  "dist\JaygoCut-Setup-0.1.17.exe" `
  "dist\JaygoCut-Setup-0.1.17.exe.blockmap" `
  "dist\latest.yml" `
  "release-notes.json" `
  --title "JaygoCut v0.1.17" `
  --notes-file CHANGELOG.md
```

## 13. 常见排查

### 审核页空白

1. 运行 `npm run check`。
2. 运行 `npm test`，测试会生成 `review.html` 并对内联脚本做 `node --check`。
3. 检查 `generate_review.js` 模板字符串中是否把 `\n` 写成真实换行。
4. 检查 `review-state.json` 是否损坏；必要时使用 `review-state.backup.json` 恢复。

### 裁剪后残音或吞字

1. 打开“删除诊断”，优先处理短片段、紧贴保留词和密集删除区域。
2. 根据内容选择剪辑精度模式：保守减少吞字，干净减少残音。
3. 若问题集中在 ASR 时间戳错误，优先手动取消对应标记或扩大/缩小选择。
4. 必要时导出完整剪映草稿，在剪映里微调少数边界。

### 历史审核打不开

1. 历史记录会显示原视频是否缺失。
2. 原视频缺失时可打开只读审核页查看文本。
3. 使用“重新定位视频”选择新的原视频路径后再恢复完整裁剪能力。

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
5. 客户端有多端点/多次重试，但服务端不稳定仍会失败。

### 本地模型不可用

1. 设置页点击“检查模型”。
2. 若未找到，点击“安装本地模型”。
3. 模型不应打入安装包，避免安装包过大。

## 14. 当前风险与待办

- 剪映草稿导出已生成完整草稿目录并支持模板草稿，但剪映版本变化可能导致部分字段兼容性需要继续跟进。
- 插入素材依赖用户配置的图片/视频生成模型，质量取决于模型能力、prompt 和网络稳定性。
- LLM 标记必须由用户在审核页确认后再执行裁剪，不能完全自动删除。
- 免费代码签名目前没有适合普通 Windows 用户的稳定方案；未签名安装包仍可能被安全软件误报或隔离。

## 15. 发布前检查清单

- `npm run check` 通过。
- `npm test` 通过，输出包含 `review regression tests passed`。
- `npm run dist:win:local` 成功生成安装包、blockmap、latest.yml。
- 本机安装版或 `win-unpacked` 能打开主界面。
- 审核页能打开，文本和波形不为空。
- 更新服务器 `latest.yml`、安装包、blockmap、`release-notes.json` 可访问。
- GitHub Release 资产和服务器版本一致。

