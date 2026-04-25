# Jaygo Cut Handoff Document

更新时间：2026-04-25
当前版本：0.1.8
项目目录：`C:\Users\15119\Documents\New project\repo`
本机安装目录：`D:\Jaygo Cut\JaygoCut`
桌面安装包：`C:\Users\15119\Desktop\JaygoCut-Setup-0.1.10.exe`
在线更新地址：`https://ailabing.cn/downloads/jaygo/`

## 1. 项目定位

Jaygo Cut 是 Windows 桌面端口播视频剪辑工具。核心流程是：选择视频 -> 提取音频 -> 云端 ASR 或本地 Whisper 转录 -> 生成审核页 -> 自动标记静音、语气词、重复句、LLM 建议 -> 人工复核 -> FFmpeg 精确裁剪。

## 2. 当前目录结构

为减少 Windows/PowerShell/打包时的中文编码问题，0.1.8 已把所有项目目录和文件名改为英文。

- `talkcut/`：口播剪辑核心逻辑，原 `剪口播/`。
- `talkcut/scripts/`：转录、审核页、裁剪等脚本。
- `talkcut/user_rules/`：语气词、重复句、静音段等规则文档，原 `用户习惯/`。
- `subtitles/`：字幕相关功能，原 `字幕/`。
- `subtitles/dictionary.txt`：字幕词典，原 `词典.txt`。
- `install/`：安装相关说明，原 `安装/`。
- `evolution/`：自进化资料，原 `自进化/`。
- `electron/`：Electron 主进程、预加载、渲染层和资源。
- `server/jaygo-upload/`：服务器音频上传中转服务。
- `HANDOFF_JaygoCut.md`：当前交接文档，原 `交接文档_JaygoCut.md`。
- `PRODUCT_INTRO.md`：软件介绍，原 `软件介绍.md`。

## 3. 关键文件

- `electron/main.js`：主进程、设置、任务编排、模型检查、自动更新。
- `electron/preload.js`：IPC API 暴露。
- `electron/renderer/index.html`：主界面结构。
- `electron/renderer/renderer.js`：主界面交互逻辑。
- `electron/renderer/styles.css`：主界面样式。
- `talkcut/scripts/generate_review.js`：生成审核页 HTML/CSS/JS，是审核体验核心文件。
- `talkcut/scripts/review_server.js`：审核页本地服务、LLM、发布建议、裁剪 API。
- `talkcut/scripts/cut_video.js`：FFmpeg 精确剪辑导出。
- `talkcut/scripts/generate_subtitles.js`：火山转录结果转审核字幕。
- `talkcut/scripts/qwen_asr_transcribe.js`：阿里 Qwen3-ASR 云端转录。
- `talkcut/scripts/whisper_transcribe_local.js`：本地 Whisper 转录。
- `talkcut/scripts/volcengine_transcribe.js`：火山引擎转录。
- `subtitles/scripts/subtitle_server.js`：字幕服务。
- `server/jaygo-upload/server.js`：服务器音频上传服务。

## 4. 0.1.8 改动

- 将项目内所有中文目录和中文文件名改为英文，降低 PowerShell、Node、Electron Builder 和服务器上传时的编码风险。
- 运行时项目输出子目录也改为英文：`1_transcribe`、`2_analysis`、`3_review`。
- 修复审核文本单击某个字时偶发跳到隔壁字：点击定位改为进入该 token 的时间中点，并立即把当前高亮设为该 token。
- 修复波形缩放后播放时闪动：波形静态层会按尺寸、缩放、选区缓存，播放时只重绘播放线。
- 保留 0.1.7 的拖选优化：拖动选择只应用当前范围，不再把鼠标扫过后移走的区域永久标记。
- 保留 0.1.7 的静音阈值优化：阈值变化会立即重新计算静音选择。
- 重写交接文档，补齐服务器更新、上传、验证、清理旧版本流程。

## 5. 构建检查命令

```powershell
cd "C:\Users\15119\Documents\New project\repo"
npm run check
node --check "talkcut\scripts\generate_subtitles.js"
node --check "talkcut\scripts\qwen_asr_transcribe.js"
node --check "talkcut\scripts\whisper_transcribe_local.js"
node --check "talkcut\scripts\generate_review.js"
node --check "talkcut\scripts\review_server.js"
node --check "talkcut\scripts\cut_video.js"
node --check "talkcut\scripts\volcengine_transcribe.js"
node --check "subtitles\scripts\subtitle_server.js"
```

## 6. 打包命令

本地 unpacked 包：

```powershell
npm run pack:win:local
```

NSIS 安装包：

```powershell
npm run dist:win:local
```

打包产物：

- `dist\JaygoCut-Setup-<version>.exe`
- `dist\JaygoCut-Setup-<version>.exe.blockmap`
- `dist\latest.yml`

桌面复制命令：

```powershell
Copy-Item "dist\JaygoCut-Setup-<version>.exe" "C:\Users\15119\Desktop\JaygoCut-Setup-<version>.exe" -Force
Copy-Item "HANDOFF_JaygoCut.md" "C:\Users\15119\Desktop\HANDOFF_JaygoCut.md" -Force
```

## 7. 在线更新配置

客户端使用 `electron-updater` 的 generic provider。

- 更新域名：`https://ailabing.cn/downloads/jaygo/`
- 服务器 IP：`47.115.58.109`
- Web 服务：宝塔面板托管 Nginx。
- HTTPS：已配置。
- 服务器更新目录：`/www/wwwroot/ailabing.cn/downloads/jaygo`
- 客户端配置位置：`package.json` 的 `build.publish.url`，以及 `electron/main.js` 的 `UPDATE_FEED_URL`。

服务器目录必须至少保留：

- `latest.yml`
- 当前版本 `JaygoCut-Setup-<version>.exe`
- 当前版本 `JaygoCut-Setup-<version>.exe.blockmap`

## 8. 上传服务器流程

敏感信息不要写入仓库或文档。SSH 密码、宝塔密码由项目负责人单独保存。以下命令用 `<SSH_PASSWORD>` 占位。

```powershell
$version = "0.1.10"
$remote = "root@47.115.58.109:/www/wwwroot/ailabing.cn/downloads/jaygo/"
$tmp = Join-Path $env:TEMP 'jaygo_askpass.cmd'
$pw = '<SSH_PASSWORD>'
Set-Content -LiteralPath $tmp -Value "@echo off`r`necho $pw`r`n" -Encoding ASCII
$env:SSH_ASKPASS = $tmp
$env:SSH_ASKPASS_REQUIRE = 'force'
$env:DISPLAY = 'none'
$known = "$env:TEMP\jaygo_known_hosts"
try {
  scp -o StrictHostKeyChecking=no -o UserKnownHostsFile="$known" -o PreferredAuthentications=password -o PubkeyAuthentication=no `
    "dist\JaygoCut-Setup-$version.exe" `
    "dist\JaygoCut-Setup-$version.exe.blockmap" `
    "dist\latest.yml" `
    $remote

  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile="$known" -o PreferredAuthentications=password -o PubkeyAuthentication=no root@47.115.58.109 `
    "chown www:www /www/wwwroot/ailabing.cn/downloads/jaygo/JaygoCut-Setup-$version.exe /www/wwwroot/ailabing.cn/downloads/jaygo/JaygoCut-Setup-$version.exe.blockmap /www/wwwroot/ailabing.cn/downloads/jaygo/latest.yml; ls -lh /www/wwwroot/ailabing.cn/downloads/jaygo"
} finally {
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
}
```

## 9. 上传后验证

```powershell
curl.exe -L --max-time 30 https://ailabing.cn/downloads/jaygo/latest.yml
curl.exe -I --max-time 30 https://ailabing.cn/downloads/jaygo/JaygoCut-Setup-0.1.10.exe
```

`latest.yml` 里必须显示当前版本号，`path` 必须指向当前安装包。

## 10. 清理服务器旧版本

确认新版本已上传并能访问后，可以删除旧安装包和旧 blockmap，只保留当前版本和 `latest.yml`。

```powershell
ssh root@47.115.58.109 "cd /www/wwwroot/ailabing.cn/downloads/jaygo && ls -lh && rm -f JaygoCut-Setup-0.1.6.exe JaygoCut-Setup-0.1.6.exe.blockmap JaygoCut-Setup-0.1.7.exe JaygoCut-Setup-0.1.7.exe.blockmap && ls -lh"
```

如果需要兼容差分更新失败后的回退下载，可以临时多保留上一个版本。当前用户要求清理无用旧版本，所以 0.1.8 上传后会删除 0.1.6 和 0.1.7。

## 11. 本机安装版热替换

用于测试，不用于发给用户。

```powershell
Copy-Item "D:\Jaygo Cut\JaygoCut\resources\app.asar" "D:\Jaygo Cut\JaygoCut\resources\app.asar.bak_<timestamp>" -Force
Copy-Item "dist\win-unpacked\resources\app.asar" "D:\Jaygo Cut\JaygoCut\resources\app.asar" -Force
```

如果应用正在运行，先结束 `JaygoCut.exe`。

## 12. 重要注意事项

- 不要把 Whisper 模型内置进安装包，`package.json` 已排除 `!electron/models/*.bin`，否则安装包会超过 1.7GB。
- 以后新增目录和文件名优先使用英文，用户界面文案可以继续用中文。
- 如果 PowerShell 显示中文乱码，不一定代表文件损坏；但源码里出现连续问号占位通常是真乱码，需要修复。
- 精确剪辑使用 `filter_complex`，必须重新编码，不能直接 `-c copy`。
- 审核页状态保存字段不要随意删，包括选择项、LLM 标记、标点、分段、播放时间。
- 上传音频失败优先检查服务器上传服务、Nginx 上传大小限制、HTTPS、服务进程、客户端超时和重试日志。
- 旧项目目录可能仍包含历史中文子目录，新版本生成的新项目会使用英文子目录。

## 13. 服务器上传服务排查

常见检查：

```bash
# 在服务器上执行
ps aux | grep jaygo
ps aux | grep node
nginx -t
systemctl status nginx
ls -lh /www/wwwroot/ailabing.cn/downloads/jaygo
```

重点排查项：

- Nginx `client_max_body_size` 是否足够大。
- 上传服务是否运行。
- 上传目录权限是否归 `www:www` 或服务用户可写。
- HTTPS 证书是否过期。
- 客户端网络是否能访问 `ailabing.cn`。

## 14. 后续建议

1. 上传服务增加 `/health` 接口，客户端设置页展示公网服务连通状态。
2. 审核页增加“时间戳诊断”，统计倒序、重叠、零时长 token。
3. LLM 提示词和服务商配置抽到独立 JSON，便于迭代。
4. 增加 HDR/10bit 检测，避免强制转 `yuv420p` 造成色彩损失。

## 15. References

- Aliyun DashScope Qwen ASR API: `https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference`
- qwen3-asr-flash-filetrans console document: use the Bailian console document URL provided by the project owner.

