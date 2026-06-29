# Jaygo Cut

Jaygo Cut 是一款面向中文口播视频创作者的 Windows 桌面端剪辑工具。它把“选择视频 -> 转录 -> 审核 -> 裁剪 -> 导出成片/剪映草稿”做成可视化流程，帮助用户更快处理静音、语气词、重复句、无效表达，并支持用 AI 生成发布建议、插入图片/视频素材。

## 核心功能

| 功能 | 说明 |
| --- | --- |
| 多引擎转录 | 支持火山引擎 ASR、阿里 DashScope Qwen ASR、本地 Whisper/ggml 模型等方案。 |
| 本地模型管理 | 安装包不内置大模型；应用可检测本机可用语音模型，并支持一键下载安装。 |
| 审核页联动 | 音频、波形、视频预览、逐字文本和删除标记联动，支持拖选、撤销、阈值重算、历史恢复。 |
| AI 分析 | 根据口播内容标记静音、语气词、重复句、无效句，并结合本地剪辑知识库逐步贴合用户习惯。 |
| 原文校对 | 支持粘贴口播原文，让 AI 只做短关键词级纠错，例如人名、地名、他/她/它等易错词。 |
| 插入素材 | 可规划并生成图片配图、视频素材、人物/场景参考图，支持替换、重试、下载和预览。 |
| 发布建议 | 生成 10 个 30 字内视频标题、5 个封面标题、简介和 #话题参考。 |
| 剪映草稿导出 | 可导出完整剪映草稿，包含主视频、字幕、图片和视频素材，打开剪映即可继续编辑。 |
| 精确裁剪 | 使用 FFmpeg 精确裁剪，默认极致画质，减少音画不同步和残音问题。 |
| 在线更新 | 基于 electron-updater generic provider，支持在线检查更新和更新内容展示。 |

## 下载安装

请在 [GitHub Releases](https://github.com/lj1270998580-crypto/JaygoCut/releases) 下载最新的 `JaygoCut-Setup-<version>.exe`，双击安装即可。

当前最新版本：`0.1.20`

## 0.1.20 更新重点

- AI 分析新增本地剪辑知识库：启动时自动学习历史审核草稿的删除习惯、纠错习惯和剪辑风格。
- 原文校对改为安全关键词纠错：只允许同等字数的短词替换，避免把一句话误替换成一个词。
- 插入图片和视频素材提示词升级为短中文分镜，更强调人物、场景、动作、镜头和情绪。
- Agnes 视频生成按免费额度限制为 1 分钟 1 次请求，失败素材可重试。
- 剪映草稿导出会跳过未完成或失败素材，降低导出超时与媒体丢失风险。
- 发布建议继续强化爆款标题结构，设置保存提示和审核页乱码标点规则同步修复。

## 源码运行

```bash
git clone https://github.com/lj1270998580-crypto/JaygoCut.git
cd JaygoCut
npm install
npm run dev
```

源码仓库不包含 FFmpeg 二进制和本地 ASR 大模型。开发机需要把 `ffmpeg.exe`、`ffprobe.exe` 放到 `electron/bin/`，本地模型可通过应用设置页安装，或手动放到用户模型目录。

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
- `release-notes.json`

`release-notes.json` 示例：

```json
{
  "version": "0.1.20",
  "notes": "- 更新内容第一条\n- 更新内容第二条"
}
```

## 重要注意

- 本地 Whisper 模型不随安装包内置，避免安装包过大。
- 新增目录和运行时输出目录尽量使用英文名，减少 Windows 中文路径编码问题。
- 精确裁剪会重新编码，不能直接用 `-c copy`，否则多段删除时容易音画不同步。
- 上传音频到公网失败时，优先检查 `server/jaygo-upload` 服务、Nginx 上传大小、HTTPS、临时文件权限和客户端重试日志。

## License

MIT License
