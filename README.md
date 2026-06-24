# Jaygo Cut

Jaygo Cut 是一款面向中文口播视频创作者的 Windows 桌面端自动剪辑工具。它把“选择视频 -> 转录 -> 审核 -> 裁剪 -> 导出”做成一条可视化流程，帮助用户更快删除静音、语气词、重复句和语义冗余内容。

## 核心功能

| 功能 | 说明 |
| --- | --- |
| 多引擎转录 | 支持火山引擎 ASR、阿里 DashScope Qwen3-ASR 异步识别、本地 Whisper/ggml 模型。 |
| 本地模型管理 | 安装包不内置大模型；应用可检查全机可用语音模型，并支持一键后台下载安装。 |
| 审核页联动 | 音频、波形、逐字文本和删除标记联动，支持拖选、撤销、阈值重算和恢复历史审核。 |
| 自动规则 | 静音阈值默认 >= 0.2 秒，语气词、重复句、停顿规则自动预标记。 |
| LLM 辅助 | 支持多服务商 LLM，对口播内容做保守语义标记、标点分段、发布建议、对话调标记。 |
| 插入素材 | 审核页可用 LLM 分析内容生成配图点、视频素材点、人物/场景资产图和分镜提示词，支持参考图预览、删除、重试、替换和合成预览。 |
| 剪映导出 | 审核页可导出完整剪映草稿；完整草稿会自动识别剪映/CapCut 草稿目录并直接写入，打开剪映即可看到。也支持基于用户选定的模板草稿生成新草稿，原模板不会被覆盖。 |
| 精确裁剪 | 使用 FFmpeg filter_complex 精确裁剪，导出质量默认极致画质。 |
| 在线更新 | 基于 electron-updater generic provider，支持服务器更新说明展示。 |

## 快速开始

### 下载安装包

从 [GitHub Releases](https://github.com/lj1270998580-crypto/JaygoCut/releases) 下载最新的 `JaygoCut-Setup-<version>.exe`，双击安装即可。

### 源码运行

```bash
git clone https://github.com/lj1270998580-crypto/JaygoCut.git
cd JaygoCut
npm install
npm run dev
```

源码仓库不包含 FFmpeg 二进制和本地 ASR 大模型。开发机需要把 `ffmpeg.exe`、`ffprobe.exe` 放到 `electron/bin/`，本地模型可通过应用设置页安装或手动放到用户模型目录。

## 项目结构

```text
JaygoCut/
├── electron/              # Electron 主进程、渲染层、资源
│   ├── main.js            # 设置、任务编排、模型检查、在线更新
│   ├── preload.js         # IPC API
│   ├── renderer/          # 主界面 HTML/CSS/JS
│   ├── assets/            # 应用图标
│   └── bin/               # FFmpeg / ffprobe
├── talkcut/               # 口播剪辑核心逻辑
│   ├── scripts/           # 转录、审核页、本地服务、裁剪脚本
│   └── user_rules/        # 语气词、重复句、静音等规则
├── subtitles/             # 字幕功能
├── server/jaygo-upload/   # 公网临时音频上传服务
├── install/               # 安装说明
└── evolution/             # 原项目演进资料
```

## 构建与检查

```bash
npm run check
npm test
npm run pack:win:local
npm run dist:win:local
```

打包产物在 `dist/`：

- `JaygoCut-Setup-<version>.exe`
- `JaygoCut-Setup-<version>.exe.blockmap`
- `latest.yml`

## 在线更新发布文件

服务器目录为 `https://ailabing.cn/downloads/jaygo/`，至少需要：

- `latest.yml`
- `JaygoCut-Setup-<version>.exe`
- `JaygoCut-Setup-<version>.exe.blockmap`
- `release-notes.json`，用于在软件更新页显示本次更新内容

`release-notes.json` 示例：

```json
{
  "version": "0.1.17",
  "notes": "- 修复剪映草稿/模板导出反馈\n- 资产图支持预览和删除\n- Agnes 视频素材生成增加参考图安全降级和网络重试"
}
```

## 重要注意

- 本地 Whisper 模型不随安装包内置，避免安装包过大。
- 新增目录和运行时输出目录使用英文名，减少 Windows 中文路径编码问题。
- 精确裁剪会重新编码，不能用 `-c copy`，否则多段删除容易音画不同步。
- 上传音频到公网失败时优先检查 `server/jaygo-upload` 服务、Nginx 上传大小、HTTPS、临时文件权限和客户端重试日志。

## License

MIT License
