# Jaygo Cut 🎬

> AI 精准口播剪辑工具 —— 做自媒体最好用的口播剪辑助手！

Jaygo Cut 是一款 Windows 桌面端口播视频自动剪辑工具。核心流程：**选择视频 → 提取音频 → 语音转录 → 智能审核 → FFmpeg 精确裁剪**，帮助创作者快速删除静音、语气词、重复句和语义冗余内容。

---

## ✨ 核心功能

| 功能 | 说明 |
|------|------|
| 🎙️ **多引擎转录** | 支持火山引擎 ASR、阿里 Qwen3-ASR（云端）及本地 Whisper |
| 🤖 **AI 智能标记** | 自动识别静音、语气词、重复句；LLM 语义分析建议删除内容 |
| 📝 **可视化审核** | 文本与音频实时联动，精确到字的标记和编辑 |
| ✂️ **一键剪辑** | FFmpeg 精确裁剪，支持 filter_complex 重新编码 |
| 🎬 **字幕生成** | 火山转录结果自动生成字幕，支持自定义词典纠错 |
| 🚀 **自动更新** | 基于 electron-updater，支持在线差分更新 |

---

## 🚀 快速开始

### 方式一：下载安装包（推荐）

从 [GitHub Releases](https://github.com/lj1270998580-crypto/JaygoCut/releases) 下载最新版本的 `JaygoCut-Setup-<version>.exe`，双击安装即可。

### 方式二：从源码运行

```bash
# 克隆仓库
git clone https://github.com/lj1270998580-crypto/JaygoCut.git
cd JaygoCut

# 安装依赖
npm install

# 开发模式运行
npm run dev
```

> **注意**：源码仓库不包含 FFmpeg 二进制文件（超过 GitHub 100MB 限制）。你需要手动下载 [FFmpeg](https://www.gyan.dev/ffmpeg/builds/)，将 `ffmpeg.exe` 和 `ffprobe.exe` 放到 `electron/bin/` 目录下。

---

## 📁 项目结构

```
JaygoCut/
├── electron/              # Electron 主进程、渲染层、资源
│   ├── main.js            # 主进程：设置、任务编排、模型检查、自动更新
│   ├── preload.js         # IPC API 暴露
│   ├── renderer/          # 主界面（HTML / CSS / JS）
│   ├── assets/            # 应用图标
│   └── bin/               # FFmpeg / ffprobe（需手动放置）
├── talkcut/               # 口播剪辑核心逻辑
│   ├── scripts/           # 转录、审核页、裁剪脚本
│   └── user_rules/        # 语气词、重复句、静音段等规则文档
├── subtitles/             # 字幕相关功能
│   ├── dictionary.txt     # 字幕词典
│   └── scripts/           # 字幕服务
├── server/jaygo-upload/   # 服务器音频上传中转服务
├── install/               # 安装说明
└── evolution/             # 自进化资料
```

---

## 🔧 构建

```bash
# 语法检查
npm run check

# 打包未压缩版本（用于本地测试）
npm run pack:win:local

# 打包 NSIS 安装包
npm run dist:win:local
```

打包产物位于 `dist/` 目录：
- `JaygoCut-Setup-<version>.exe`
- `JaygoCut-Setup-<version>.exe.blockmap`
- `latest.yml`

---

## ⚙️ 配置说明

### 转录服务

| 服务商 | 类型 | 说明 |
|--------|------|------|
| 火山引擎 | 云端 | 速度快，识别准，需 API Key |
| 阿里 Qwen3-ASR | 云端 | DashScope 平台，需 API Key |
| Whisper 本地 | 本地 | 完全免费，速度取决于硬件 |

### LLM 服务商

支持 OpenAI 兼容接口的多种提供商：OpenAI、Claude、OpenRouter、xAI、Groq、DeepSeek、Qwen、Moonshot、SiliconFlow 等，以及自定义端点。

配置位置：应用设置页面。

---

## 📝 开发规范

- **Runtime**: Node.js >= 18（无转译，纯 CommonJS）
- **测试**: `node tests/run-all.js`
- **代码风格**: ESLint（flat config）
- **Markdown 检查**: `npx markdownlint-cli '**/*.md' --ignore node_modules`

---

## 📄 License

MIT License

---

> 做自媒体最好用的口播剪辑助手！
