# TalkCut Desktop App

## What is included

- Electron desktop app wrapper for the existing TalkCut scripts.
- In-app settings for:
  - Volcengine API key
  - ASR engine switch (`volcengine` / `local whisper`)
  - Output folder
  - Silence threshold (default `0.2s`)
- Full workflow trigger:
  - Extract review audio
  - Transcribe (cloud or local)
  - Generate subtitles
  - Auto-select silence segments (`>= 0.2s`)
  - Generate review page
  - Start review server
  - Open review URL in a desktop window

## Start

```bash
npm install
npm run start
```

## Build Windows package

```bash
npm run dist:win
```

- Installer output location: `dist/`
- Debug unpacked app: `npm run pack:win`
- If network to GitHub is unstable, use local Electron binary mode:

```bash
npm run pack:win:local
npm run dist:win:local
```

## History & Resume

- The app stores recent completed projects under Electron user data.
- In the **History** panel you can:
  - Open project folder
  - Resume review server for a previous project

## Notes

- `ffmpeg` and `ffprobe` are required.
- Cloud mode requires `VOLCENGINE_API_KEY`.
- Local mode requires `python` + local whisper runtime (`whisper_transcribe.py` dependency).
- App writes `.env` in repository root to keep compatibility with existing scripts.
