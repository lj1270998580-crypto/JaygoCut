#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { normalizeSelectedIndices } = require('./auto_selected_utils');
const { analyzeTranscriptQuality } = require('./transcript_quality');
const { parseTermGlossary } = require('./term_glossary');

let subtitlesFile = process.argv[2] || 'subtitles_words.json';
const autoSelectedFile = process.argv[3] || 'auto_selected.json';
const inputAudio = process.argv[4] || 'audio.wav';
let packageVersion = 'unknown';
try {
  packageVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')).version || 'unknown';
} catch {
  packageVersion = 'unknown';
}

if (!fs.existsSync(subtitlesFile)) {
  const fallback = subtitlesFile.endsWith('subtitles_words.json')
    ? subtitlesFile.replace(/subtitles_words\.json$/i, 'subtitles_words.bad.json')
    : '';
  if (fallback && fs.existsSync(fallback)) {
    subtitlesFile = fallback;
    console.warn(`subtitles文件缺失，已回退到: ${path.basename(fallback)}`);
  } else {
    console.error(`未找到subtitles文件: ${subtitlesFile}`);
    process.exit(1);
  }
}

const rawSubtitles = JSON.parse(fs.readFileSync(subtitlesFile, 'utf8').replace(/^\uFEFF/, ''));
const sourceWords = Array.isArray(rawSubtitles)
  ? rawSubtitles
  : Array.isArray(rawSubtitles?.words)
    ? rawSubtitles.words
    : [];
if (!sourceWords.length) {
  console.error(`subtitles内容为空或格式不兼容: ${subtitlesFile}`);
  process.exit(1);
}

function roundTime(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function normalizeReviewWords(items) {
  let lastEnd = 0;
  return items.map((item) => {
    const next = { ...item };
    let startValue = Number(next.start);
    let endValue = Number(next.end);
    if (!Number.isFinite(startValue)) startValue = lastEnd;
    if (!Number.isFinite(endValue)) endValue = startValue;
    startValue = Math.max(0, startValue);
    endValue = Math.max(startValue + 0.001, endValue);
    if (endValue <= lastEnd && startValue < lastEnd) {
      startValue = lastEnd;
      endValue = startValue + 0.001;
    }
    next.start = roundTime(startValue);
    next.end = roundTime(Math.max(endValue, startValue + 0.001));
    next.text = String(next.text ?? '');
    next.isGap = Boolean(next.isGap);
    lastEnd = Math.max(lastEnd, next.end);
    return next;
  });
}

const words = normalizeReviewWords(sourceWords);
const liveQuality = analyzeTranscriptQuality(words);
const qualityFile = path.resolve(path.dirname(path.resolve(subtitlesFile)), 'transcript_quality.json');
let savedQuality = null;
if (fs.existsSync(qualityFile)) {
  try {
    savedQuality = JSON.parse(fs.readFileSync(qualityFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    savedQuality = { ok: false, warnings: [`质量报告读取失败: ${err.message}`] };
  }
}

let autoSelected = [];
let autoReasonByIndex = {};
let autoStats = null;
if (fs.existsSync(autoSelectedFile)) {
  const raw = JSON.parse(fs.readFileSync(autoSelectedFile, 'utf8').replace(/^\uFEFF/, ''));
  const indices = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.indices)
      ? raw.indices
      : [];
  autoSelected = normalizeSelectedIndices(words, indices).indices;
  autoReasonByIndex = raw && !Array.isArray(raw) && raw.reasons && typeof raw.reasons === 'object'
    ? raw.reasons
    : {};
  autoStats = raw && !Array.isArray(raw) && raw.stats && typeof raw.stats === 'object'
    ? raw.stats
    : null;
}

const audioExt = path.extname(inputAudio) || '.wav';
const audioName = `audio${audioExt}`;
if (fs.existsSync(inputAudio) && inputAudio !== audioName) {
  fs.copyFileSync(inputAudio, audioName);
}

const wordsJson = JSON.stringify(words).replace(/</g, '\\u003c');
const selectedJson = JSON.stringify(autoSelected).replace(/</g, '\\u003c');
const autoReasonsJson = JSON.stringify(autoReasonByIndex || {}).replace(/</g, '\\u003c');
const autoStatsJson = JSON.stringify(autoStats || {}).replace(/</g, '\\u003c');
const termGlossaryJson = JSON.stringify(parseTermGlossary(process.env.TERM_GLOSSARY || '')).replace(/</g, '\\u003c');
const qualityJson = JSON.stringify({
  generated: liveQuality,
  saved: savedQuality,
}).replace(/</g, '\\u003c');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>审核页面</title>
  <style>
    * { box-sizing: border-box; }
    :root {
      --page-bg: #f5f7fb;
      --card-bg: #ffffff;
      --text-main: #1f2937;
      --text-muted: #6b7280;
      --border: #e5e7eb;
      --btn-bg: #e5e7eb;
      --btn-text: #111827;
      --btn-primary-bg: #0f766e;
      --btn-primary-text: #ffffff;
      --btn-warn-bg: #111827;
      --btn-warn-text: #ffffff;
      --input-bg: #ffffff;
      --focus-border: #35b5ab;
      --focus-shadow: 0 0 0 3px rgba(20, 184, 166, 0.16);
      --token-hover: #eef2ff;
      --token-gap-bg: #f3f4f6;
      --token-gap-text: #6b7280;
      --token-gap-border: #cbd5e1;
      --token-sel-bg: #fee2e2;
      --token-sel-text: #991b1b;
      --token-llm-bg: #f5f3ff;
      --mark-silence-bg: #e2e8f0;
      --mark-silence-fg: #334155;
      --mark-filler-bg: #ffedd5;
      --mark-filler-fg: #9a3412;
      --mark-repeat-bg: #dcfce7;
      --mark-repeat-fg: #166534;
      --mark-llm-bg: #ede9fe;
      --mark-llm-fg: #5b21b6;
      --token-current-bg: #dbeafe;
      --token-current-text: #1d4ed8;
      --token-current-border: #93c5fd;
      --log-bg: #fbfdff;
    }
    :root[data-theme='blackgold'] {
      --page-bg: radial-gradient(circle at 15% 0%, #2a2416 0%, #121418 42%, #0a0c10 100%);
      --card-bg: #171a20;
      --text-main: #efe7d0;
      --text-muted: #bda97a;
      --border: #3c3421;
      --btn-bg: #252a33;
      --btn-text: #efe7d0;
      --btn-primary-bg: #c9a227;
      --btn-primary-text: #111111;
      --btn-warn-bg: #2f333d;
      --btn-warn-text: #f3d988;
      --input-bg: #11151b;
      --focus-border: #d7b34a;
      --focus-shadow: 0 0 0 3px rgba(201, 162, 39, 0.25);
      --token-hover: #2a2f39;
      --token-gap-bg: #1f252d;
      --token-gap-text: #c9b07a;
      --token-gap-border: #5e5030;
      --token-sel-bg: #4a1f1f;
      --token-sel-text: #ffb4b4;
      --token-llm-bg: #2f233d;
      --mark-silence-bg: #243040;
      --mark-silence-fg: #d4e2f5;
      --mark-filler-bg: #3f2c1e;
      --mark-filler-fg: #ffd9ad;
      --mark-repeat-bg: #1d3a2b;
      --mark-repeat-fg: #8af0b0;
      --mark-llm-bg: #3a2b4a;
      --mark-llm-fg: #dcc6ff;
      --token-current-bg: #1f3047;
      --token-current-text: #a9ccff;
      --token-current-border: #42638d;
      --log-bg: #12161d;
    }
    body {
      margin: 0;
      font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: var(--page-bg);
      color: var(--text-main);
      min-height: 100vh;
      overflow-y: auto;
    }
    body.dragging,
    body.dragging * {
      user-select: none !important;
      cursor: grabbing !important;
    }
    .wrap {
      max-width: 1240px;
      margin: 0 auto;
      padding: 12px;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px;
      margin-bottom: 0;
      min-height: 0;
    }
    .toolbar-card {
      flex: 0 0 auto;
      position: sticky;
      top: 8px;
      z-index: 40;
      box-shadow: 0 10px 26px rgba(15, 23, 42, 0.08);
      backdrop-filter: blur(3px);
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 10px;
      align-items: start;
    }
    .toolbar-card.video-preview-visible {
      grid-template-columns: minmax(0, 1fr) clamp(260px, 25vw, 430px);
    }
    .toolbar-card > #audio,
    .toolbar-card > .wave-wrap,
    .toolbar-card > .wave-toolbar,
    .toolbar-card > .primary-actions {
      grid-column: 1;
      min-width: 0;
    }
    .toolbar-card > #deletePreviewInfo,
    .toolbar-card > #deleteDiagnosticsPanel,
    .toolbar-card > .tool-fold {
      grid-column: 1 / -1;
    }
    .content-card {
      flex: 0 0 auto;
      min-height: 0;
      overflow: hidden;
      height: clamp(520px, 74vh, 980px);
    }
    .video-preview-panel {
      grid-column: 2;
      grid-row: 1 / span 4;
      justify-self: stretch;
      align-self: start;
      margin: 0;
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
      background: #020617;
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.26);
    }
    .video-preview-panel[hidden] {
      display: none;
    }
    .video-preview-panel video {
      display: block;
      width: 100%;
      height: clamp(146px, 16vw, 242px);
      max-height: 242px;
      object-fit: contain;
      background: #000;
    }
    .video-preview-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 12px;
      color: rgba(255, 255, 255, 0.78);
      font-size: 11px;
      background: rgba(15, 23, 42, 0.92);
    }
    .video-preview-meta span:first-child {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    body.review-focus-mode .wave-wrap,
    body.review-focus-mode .wave-toolbar,
    body.review-focus-mode .video-preview-panel,
    body.review-focus-mode .tool-fold,
    body.review-focus-mode .floating-toggle,
    body.review-focus-mode .floating-side {
      display: none !important;
    }
    body.review-focus-mode .toolbar-card {
      padding: 12px 16px;
    }
    body.review-focus-mode .content-card {
      height: calc(100vh - 178px);
    }
    body.review-focus-mode #content {
      font-size: 22px;
      line-height: 2.45;
      letter-spacing: 0.08em;
    }
    body.review-focus-mode .token {
      margin: 4px 3px;
      padding: 3px 7px;
      border-radius: 8px;
    }
    @media (max-width: 1180px) {
      .toolbar-card.video-preview-visible {
        grid-template-columns: minmax(0, 1fr);
      }
      .toolbar-card.video-preview-visible .video-preview-panel {
        grid-column: 1;
        grid-row: auto;
        justify-self: end;
        width: min(360px, 100%);
      }
    }
    .side-panel {
      min-width: 220px;
      min-height: 0;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: color-mix(in oklab, var(--card-bg) 94%, var(--token-gap-bg) 6%);
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px;
      overflow: hidden;
      box-shadow: 0 10px 28px rgba(15, 23, 42, 0.18);
    }
    .floating-side {
      position: fixed;
      top: 96px;
      width: clamp(300px, 19vw, 380px);
      max-height: calc(100vh - 116px);
      z-index: 1200;
      display: flex;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.18s ease, transform 0.18s ease;
      isolation: isolate;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
    }
    .floating-side.left {
      left: max(8px, calc((100vw - 1240px) / 2 - 410px));
      transform: translateX(-8px);
    }
    .floating-side.image-side {
      width: clamp(340px, 24vw, 460px);
      padding-right: 12px;
    }
    .floating-side.right {
      right: max(8px, calc((100vw - 1240px) / 2 - 410px));
      transform: translateX(8px);
    }
    .floating-side.open {
      opacity: 1;
      pointer-events: auto;
      transform: translateX(0);
    }
    .floating-toggle {
      position: fixed;
      --floating-toggle-top: 150px;
      top: var(--floating-toggle-top);
      z-index: 1201;
      border-radius: 999px;
      padding: 7px 12px;
      font-size: 13px;
      border: 1px solid var(--border);
      background: color-mix(in oklab, var(--card-bg) 86%, var(--token-gap-bg) 14%);
      color: var(--text-main);
      min-width: 92px;
      text-align: center;
      white-space: nowrap;
      box-shadow: 0 8px 18px rgba(15, 23, 42, 0.22);
      backdrop-filter: blur(4px);
    }
    .floating-toggle.left {
      left: max(8px, calc((100vw - 1240px) / 2 - 410px));
    }
    .floating-toggle.left.image-toggle {
      top: calc(var(--floating-toggle-top) + 62px);
    }
    .floating-toggle.right {
      right: max(8px, calc((100vw - 1240px) / 2 - 410px));
    }
    .floating-toggle.active {
      background: var(--btn-primary-bg);
      color: var(--btn-primary-text);
      border-color: color-mix(in oklab, var(--btn-primary-bg) 66%, var(--border));
    }
    .floating-toggle.hidden {
      opacity: 0;
      pointer-events: none;
      transform: scale(0.92);
    }
    .panel-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .panel-close {
      padding: 4px 8px;
      min-width: 34px;
      line-height: 1;
    }
    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-weight: 700;
    }
    .panel-section {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-height: 0;
    }
    .panel-title {
      font-size: 13px;
      font-weight: 700;
      color: var(--text-main);
    }
    .compact-row {
      gap: 6px;
    }
    .compact-row .meta {
      white-space: nowrap;
    }
    #publishStyle {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--input-bg);
      color: var(--text-main);
      padding: 6px 8px;
      width: 100%;
      min-width: 0;
    }
    #publishTitlesList {
      margin: 0;
      padding-left: 22px;
      line-height: 1.5;
      font-size: 14px;
      overflow-y: auto;
      min-height: 120px;
      max-height: 240px;
    }
    #publishTitlesList li {
      margin: 0 0 4px 0;
      word-break: break-word;
    }
    #publishDescription {
      width: 100%;
      resize: vertical;
      min-height: 90px;
      max-height: 180px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--input-bg);
      color: var(--text-main);
      padding: 8px;
      line-height: 1.45;
    }
    #publishKeywords {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      overflow-y: auto;
      max-height: 88px;
    }
    #imageCardList,
    #videoAssetList {
      display: flex;
      flex-direction: column;
      gap: 10px;
      overflow-y: auto;
      min-height: 260px;
      padding-right: 2px;
    }
    .media-video-section {
      border-top: 1px dashed var(--border);
      margin-top: 14px;
      padding-top: 12px;
    }
    .image-card {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 8px;
      background: color-mix(in oklab, var(--card-bg) 88%, var(--token-gap-bg) 12%);
      display: flex;
      flex-direction: column;
      gap: 7px;
    }
    .image-preview {
      width: 100%;
      aspect-ratio: 1 / 1;
      border-radius: 8px;
      border: 1px dashed var(--border);
      background: var(--log-bg);
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      color: var(--text-muted);
      font-size: 12px;
      text-align: center;
      padding: 8px;
    }
    .image-preview img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .image-card-title {
      font-weight: 700;
      font-size: 13px;
      line-height: 1.35;
      color: var(--text-main);
    }
    .image-card-prompt {
      font-size: 12px;
      line-height: 1.45;
      color: var(--text-muted);
      max-height: 72px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .image-card-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .image-card-actions button,
    .image-card-actions a {
      padding: 5px 8px;
      font-size: 12px;
      border-radius: 8px;
    }
    .keyword-chip {
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      background: color-mix(in oklab, var(--card-bg) 86%, var(--token-gap-bg) 14%);
      color: var(--text-muted);
    }
    #llmChatHistory {
      flex: 1 1 auto;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px;
      overflow-y: auto;
      background: var(--log-bg);
      font-size: 13px;
      line-height: 1.45;
      min-height: 180px;
    }
    .chat-row {
      margin-bottom: 8px;
      padding: 6px 8px;
      border-radius: 8px;
      border: 1px solid var(--border);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .chat-row.user {
      background: color-mix(in oklab, var(--card-bg) 90%, var(--token-current-bg) 10%);
    }
    .chat-row.assistant {
      background: color-mix(in oklab, var(--card-bg) 90%, var(--mark-llm-bg) 10%);
    }
    #llmChatInput {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--input-bg);
      color: var(--text-main);
      padding: 8px;
      min-height: 76px;
      resize: vertical;
    }
    #contentViewport {
      width: 100%;
      height: 100%;
      overflow-y: auto;
      overflow-x: hidden;
      padding-right: 4px;
      overscroll-behavior: contain;
    }
    .logs-card {
      flex: 0 0 auto;
    }
    .logs-card[open] {
      display: flex;
      flex-direction: column;
      min-height: 120px;
    }
    .fold-panel {
      border: 1px dashed var(--border);
      border-radius: 10px;
      padding: 8px 10px;
      background: color-mix(in oklab, var(--card-bg) 94%, var(--token-gap-bg) 6%);
    }
    .fold-panel summary {
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-main);
      user-select: none;
      outline: none;
    }
    .fold-panel[open] summary {
      margin-bottom: 8px;
    }
    .tool-fold {
      margin-top: 8px;
    }
    .tool-actions {
      margin-bottom: 8px;
    }
    .export-actions select,
    .export-actions input {
      height: 34px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--input-bg);
      color: var(--text-main);
      padding: 5px 8px;
      font-size: 13px;
    }
    .export-actions #jianyingTemplatePath {
      flex: 1 1 260px;
      min-width: 220px;
    }
    .replace-actions {
      align-items: stretch;
    }
    .replace-actions input {
      height: 34px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--input-bg);
      color: var(--text-main);
      padding: 5px 8px;
      font-size: 13px;
    }
    .replace-actions #replaceFindText,
    .replace-actions #replaceWithText {
      flex: 1 1 180px;
      min-width: 140px;
    }
    .replace-actions #glossarySummary {
      flex: 0 1 220px;
    }
    .replace-status {
      min-width: 160px;
      align-self: center;
    }
    .shortcut-help {
      position: fixed;
      inset: 0;
      z-index: 40;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(2, 6, 23, 0.45);
    }
    .shortcut-help[hidden] {
      display: none;
    }
    .shortcut-card {
      width: min(620px, 96vw);
      max-height: 86vh;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: var(--card-bg);
      color: var(--text-main);
      box-shadow: 0 24px 70px rgba(15, 23, 42, 0.28);
      padding: 18px;
    }
    .shortcut-card h3 {
      margin: 0 0 12px;
      font-size: 18px;
    }
    .shortcut-list {
      display: grid;
      gap: 8px;
      margin: 0 0 14px;
    }
    .shortcut-item {
      display: grid;
      grid-template-columns: 160px 1fr;
      gap: 12px;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid var(--border);
    }
    .shortcut-item kbd {
      justify-self: start;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 3px 8px;
      background: var(--token-gap-bg);
      color: var(--text-main);
      font-weight: 700;
      font-size: 12px;
    }
    .token.search-hit {
      outline: 2px solid rgba(59, 130, 246, 0.72);
      outline-offset: 1px;
    }
    .token.search-active {
      outline: 3px solid rgba(245, 158, 11, 0.92);
      outline-offset: 2px;
    }
    .token.text-empty {
      opacity: 0.35;
    }
    .primary-actions {
      margin-top: 10px;
    }
    .primary-actions #selectionStats {
      flex: 1 1 520px;
      min-width: 260px;
    }
    .primary-actions #status {
      flex: 0 1 auto;
      margin-top: 0;
      min-height: 0;
      white-space: nowrap;
    }
    .compact-status {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
      margin-top: 6px;
      min-height: 20px;
    }
    .compact-status .status {
      margin-top: 0;
      min-height: 0;
    }
    .row {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    button, input {
      font: inherit;
    }
    button {
      border: 0;
      border-radius: 8px;
      padding: 7px 10px;
      font-size: 13px;
      cursor: pointer;
      background: var(--btn-bg);
      color: var(--btn-text);
      font-weight: 600;
    }
    button:disabled {
      opacity: 0.65;
      cursor: not-allowed;
    }
    button.primary { background: var(--btn-primary-bg); color: var(--btn-primary-text); }
    button.warn { background: var(--btn-warn-bg); color: var(--btn-warn-text); }
    input[type="number"] {
      width: 84px;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 7px 8px;
      background: var(--input-bg);
      color: var(--text-main);
    }
    input[type="number"]:focus {
      border-color: var(--focus-border);
      box-shadow: var(--focus-shadow);
      outline: none;
    }
    .boundary-row {
      margin-top: 8px;
      gap: 8px;
      align-items: center;
    }
    .boundary-row label {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .boundary-row input[type="number"] {
      width: 72px;
      padding: 6px 7px;
    }
    .quality-warnings {
      margin-top: 8px;
      padding: 8px 10px;
      border: 1px solid color-mix(in oklab, #f59e0b 52%, var(--border));
      border-radius: 10px;
      background: color-mix(in oklab, #f59e0b 12%, var(--card-bg));
      color: var(--text-main);
      font-size: 13px;
      line-height: 1.55;
    }
    .meta {
      font-size: 13px;
      color: var(--text-muted);
    }
    .status {
      margin-top: 8px;
      min-height: 20px;
      font-size: 13px;
      color: #334155;
    }
    .wave-wrap {
      margin-top: 10px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: color-mix(in oklab, var(--card-bg) 86%, var(--token-gap-bg) 14%);
      padding: 8px;
      position: relative;
      cursor: pointer;
      overflow: hidden;
    }
    #waveCanvas {
      width: 100%;
      height: 64px;
      display: block;
    }
    .wave-hint {
      position: absolute;
      right: 10px;
      top: 8px;
      font-size: 12px;
      color: var(--text-muted);
      pointer-events: none;
      background: color-mix(in oklab, var(--card-bg) 80%, transparent);
      padding: 0 4px;
      border-radius: 4px;
    }
    .wave-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      flex-wrap: wrap;
    }
    #waveZoom {
      width: 180px;
    }
    #waveZoomText {
      min-width: 64px;
      font-size: 12px;
      color: var(--text-muted);
    }
    #content {
      line-height: 2.1;
      font-size: 16px;
      word-break: break-word;
    }
    .token {
      display: inline-block;
      margin: 2px;
      padding: 2px 5px;
      border-radius: 6px;
      cursor: pointer;
      user-select: none;
      transition: background-color 140ms ease, color 140ms ease, box-shadow 140ms ease, transform 140ms ease;
    }
    .token:hover {
      background: var(--token-hover);
    }
    .token.gap {
      background: var(--token-gap-bg);
      color: var(--token-gap-text);
      font-size: 12px;
      border: 1px dashed var(--token-gap-border);
    }
    .token.sel {
      background: var(--token-sel-bg);
      color: var(--token-sel-text);
      text-decoration: line-through;
      text-decoration-thickness: 1.5px;
    }
    .token.auto {
      box-shadow: inset 0 0 0 1px rgba(100, 116, 139, 0.28);
    }
    .token.auto-silence {
      background: color-mix(in oklab, var(--mark-silence-bg) 68%, transparent);
    }
    .token.auto-filler {
      background: color-mix(in oklab, var(--mark-filler-bg) 66%, transparent);
    }
    .token.auto-repeat {
      background: color-mix(in oklab, var(--mark-repeat-bg) 66%, transparent);
    }
    .token.llm {
      box-shadow: inset 0 0 0 1px rgba(124, 58, 237, 0.36);
      background: color-mix(in oklab, var(--mark-llm-bg) 64%, transparent);
    }
    .token.mark-silence { color: var(--mark-silence-fg); }
    .token.mark-filler { color: var(--mark-filler-fg); }
    .token.mark-repeat { color: var(--mark-repeat-fg); }
    .token.mark-llm { color: var(--mark-llm-fg); }
    .token.sel.mark-silence {
      background: var(--mark-silence-bg);
      color: var(--mark-silence-fg);
    }
    .token.sel.mark-filler {
      background: var(--mark-filler-bg);
      color: var(--mark-filler-fg);
    }
    .token.sel.mark-repeat {
      background: var(--mark-repeat-bg);
      color: var(--mark-repeat-fg);
    }
    .token.sel.mark-llm {
      background: var(--mark-llm-bg);
      color: var(--mark-llm-fg);
    }
    .token.current {
      background: var(--token-current-bg);
      color: var(--token-current-text);
      box-shadow: inset 0 0 0 1px var(--token-current-border);
    }
    .token.preview-delete {
      outline: 3px solid rgba(245, 158, 11, 0.92);
      outline-offset: 2px;
      box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.16);
    }
    .delete-preview-info,
    .delete-diagnostics {
      width: 100%;
      margin-top: 8px;
      padding: 10px 12px;
      border: 1px dashed var(--border);
      border-radius: 12px;
      background: color-mix(in oklab, var(--card-bg) 92%, var(--accent));
      color: var(--text-muted);
      font-size: 13px;
      line-height: 1.7;
    }
    .delete-diagnostics[hidden],
    .delete-preview-info[hidden] {
      display: none;
    }
    .diagnostic-risk {
      display: inline-flex;
      align-items: center;
      margin: 4px 6px 0 0;
      padding: 4px 8px;
      border: 1px solid rgba(245, 158, 11, 0.35);
      border-radius: 999px;
      background: rgba(245, 158, 11, 0.12);
      color: var(--text-main);
      cursor: pointer;
    }
    .diagnostic-risk:hover {
      border-color: rgba(245, 158, 11, 0.75);
    }
    .token .punct {
      color: var(--text-muted);
      opacity: 0.9;
      margin-left: 1px;
    }
    .paragraph-break {
      display: block;
      width: 100%;
      height: 10px;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 8px;
    }
    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: #475569;
    }
    .legend-dot {
      width: 12px;
      height: 12px;
      border-radius: 3px;
      border: 1px solid transparent;
    }
    .legend-dot.silence {
      background: var(--mark-silence-bg);
      border-color: color-mix(in oklab, var(--mark-silence-fg) 42%, transparent);
    }
    .legend-dot.filler {
      background: var(--mark-filler-bg);
      border-color: color-mix(in oklab, var(--mark-filler-fg) 40%, transparent);
    }
    .legend-dot.repeat {
      background: var(--mark-repeat-bg);
      border-color: color-mix(in oklab, var(--mark-repeat-fg) 40%, transparent);
    }
    .legend-dot.llm {
      background: var(--mark-llm-bg);
      border-color: color-mix(in oklab, var(--mark-llm-fg) 42%, transparent);
    }
    #logs {
      white-space: pre-wrap;
      font-family: Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--log-bg);
      padding: 10px;
      max-height: 280px;
      overflow-y: auto;
      flex: 1 1 auto;
    }
    @media (max-width: 1600px) {
      .floating-side {
        width: 300px;
      }
      .floating-side.image-side {
        width: 340px;
      }
      .floating-toggle.left {
        left: 10px;
      }
      .floating-toggle.left.image-toggle {
        top: calc(var(--floating-toggle-top) + 62px);
      }
      .floating-toggle.right {
        right: 10px;
      }
    }
    @media (max-width: 1320px) {
      .content-card {
        height: clamp(480px, 72vh, 900px);
      }
      .floating-side {
        width: min(56vw, 380px);
        max-height: 46vh;
        top: auto;
        bottom: 10px;
      }
      .floating-side.image-side {
        width: min(62vw, 430px);
      }
      .floating-side.left {
        left: 10px;
      }
      .floating-side.right {
        right: 10px;
      }
      .floating-toggle {
        --floating-toggle-top: 110px;
        top: var(--floating-toggle-top);
      }
      .floating-toggle.left.image-toggle {
        top: calc(var(--floating-toggle-top) + 62px);
      }
      .floating-toggle.left {
        left: 10px;
      }
      .floating-toggle.right {
        right: 10px;
      }
    }
  </style>
</head>
  <body>
  <div class="wrap">
    <div class="card toolbar-card">
        <div id="videoPreviewPanel" class="video-preview-panel" hidden>
          <video id="sourceVideo" preload="metadata" src="/source-video" playsinline muted disablepictureinpicture></video>
          <div class="video-preview-meta">
            <span>视频预览：画面跟随审核音频，默认静音避免双声道回音。</span>
            <span id="videoPreviewStatus">未加载</span>
          </div>
        </div>
        <audio id="audio" controls preload="metadata" src="${audioName}" style="width: 100%"></audio>
        <div id="waveWrap" class="wave-wrap" title="点击波形可跳转播放位置">
          <canvas id="waveCanvas"></canvas>
          <div id="waveHint" class="wave-hint">波形加载中...</div>
        </div>
        <div class="wave-toolbar">
          <span class="meta">波形缩放</span>
          <input id="waveZoom" type="range" min="1" max="8" step="0.5" value="1" />
          <span id="waveZoomText">1.0x</span>
        </div>
      <div class="row primary-actions">
        <button id="btnPlay" class="primary">播放/暂停</button>
        <button id="btnClear">清空选择</button>
        <button id="btnPreviewDelete" type="button">预听当前删除点</button>
        <button id="btnToggleVideoPreview" type="button">视频预览</button>
        <button id="btnCut" class="warn">执行裁剪</button>
        <button id="btnFocusReview" type="button">专注审核</button>
        <select id="cutPrecisionMode" title="只影响最终裁剪边界，不改变审核文本时间戳">
          <option value="conservative">保守</option>
          <option value="standard" selected>标准</option>
          <option value="clean">干净</option>
        </select>
        <button id="btnShowDeleteDiagnostics" type="button">删除诊断</button>
        <button id="btnCopyDiagnostics" type="button">复制诊断信息</button>
        <button id="btnShortcutHelp" type="button">快捷键指南</button>
        <span id="status" class="status">就绪</span>
        <span class="meta" id="selectionStats"></span>
      </div>
      <div id="deletePreviewInfo" class="delete-preview-info" hidden></div>
      <div id="deleteDiagnosticsPanel" class="delete-diagnostics" hidden></div>
      <details class="fold-panel tool-fold">
        <summary>审核工具与状态（点击展开）</summary>
        <div class="row tool-actions">
          <span class="meta">静音阈值(秒) >=</span>
          <input id="silenceThreshold" type="number" min="0.2" step="0.05" value="0.2" />
          <button id="btnSelectSilence">按阈值选择静音</button>
          <button id="btnLlmMark">LLM标记</button>
          <button id="btnApplyLlm">应用LLM建议</button>
          <button id="btnClearLlm">清除LLM标记</button>
        </div>
        <div class="row tool-actions export-actions">
          <span class="meta">导出字幕</span>
          <button id="btnExportSrt" type="button">导出 SRT（剪映）</button>
          <button id="btnExportTxt" type="button">导出 TXT 文案</button>
          <select id="jianyingSubtitlePreset" title="剪映草稿内置字幕样式">
            <option value="clean" selected>清爽白字</option>
            <option value="blackgold">黑金大字</option>
            <option value="variety">综艺描边</option>
            <option value="soft">柔和橙底</option>
          </select>
          <input id="jianyingTemplatePath" type="text" placeholder="自己的字幕模板草稿目录（可选）" title="填写一个剪映草稿文件夹路径，Jaygo Cut 会读取其中第一条字幕样式" />
          <button id="btnExportJianyingDraft" type="button">导出剪映草稿</button>
          <span id="exportStatus" class="meta"></span>
        </div>
        <div class="row tool-actions replace-actions">
          <span class="meta">文本纠错</span>
          <input id="replaceFindText" type="text" placeholder="搜索错词/人称，如 他" autocomplete="off" />
          <input id="replaceWithText" type="text" placeholder="替换为，如 她" autocomplete="off" />
          <button id="btnFindPrev" type="button">上一个</button>
          <button id="btnFindNext" type="button">下一个</button>
          <button id="btnReplaceOne" type="button">替换当前</button>
          <button id="btnReplaceAll" type="button">全部替换</button>
          <button id="btnApplyGlossary" type="button">应用词库纠错</button>
          <span id="glossarySummary" class="meta"></span>
          <span id="replaceStatus" class="meta replace-status"></span>
        </div>
        <div class="row compact-row boundary-row">
          <span class="meta">边界精修</span>
          <label class="meta">字头提前(ms)
            <input id="speechLeadMs" type="number" min="0" max="180" step="5" value="45" />
          </label>
          <label class="meta">字尾延后(ms)
            <input id="speechTailMs" type="number" min="0" max="220" step="5" value="90" />
          </label>
          <label class="meta">语气词加强(ms)
            <input id="fillerBoostMs" type="number" min="0" max="120" step="5" value="30" />
          </label>
          <label class="meta">静音保护(ms)
            <input id="silenceGuardMs" type="number" min="0" max="120" step="5" value="45" />
          </label>
          <button id="btnResetBoundary" type="button">恢复默认</button>
        </div>
        <div id="qualityWarnings" class="quality-warnings" hidden></div>
        <div class="legend" aria-label="标记颜色说明">
          <span class="legend-item"><span class="legend-dot silence"></span>停顿规则（自动）</span>
          <span class="legend-item"><span class="legend-dot filler"></span>语气词规则（自动）</span>
          <span class="legend-item"><span class="legend-dot repeat"></span>重复句规则（自动）</span>
          <span class="legend-item"><span class="legend-dot llm"></span>LLM建议</span>
        </div>
        <div class="meta">操作提示：单击定位播放点；双击切换删除/取消；拖过文本可连续标记；Ctrl+Z 撤回上一步标记；空格键播放/暂停；鼠标滚轮可缩放波形；播放时自动跳过已选段。</div>
        <div class="meta" id="llmSummary" style="margin-top:4px"></div>
        <div class="meta" id="runtime" style="margin-top:4px"></div>
        <div class="meta" id="draftState" style="margin-top:4px">草稿状态：未保存</div>
      </details>
    </div>

    <div id="shortcutHelp" class="shortcut-help" hidden>
      <div class="shortcut-card" role="dialog" aria-modal="true" aria-labelledby="shortcutHelpTitle">
        <h3 id="shortcutHelpTitle">快捷键指南</h3>
        <div class="shortcut-list">
          <div class="shortcut-item"><kbd>Space</kbd><span>播放 / 暂停</span></div>
          <div class="shortcut-item"><kbd>双击文字</kbd><span>标记删除 / 取消删除</span></div>
          <div class="shortcut-item"><kbd>拖动文字</kbd><span>连续标记或连续取消，适合处理整句</span></div>
          <div class="shortcut-item"><kbd>Ctrl + Z</kbd><span>撤回上一步，可连续撤回多步</span></div>
          <div class="shortcut-item"><kbd>Ctrl + Y</kbd><span>重做刚撤回的操作</span></div>
          <div class="shortcut-item"><kbd>Ctrl + Shift + Z</kbd><span>重做刚撤回的操作</span></div>
          <div class="shortcut-item"><kbd>S</kbd><span>预听当前或最近的删除点</span></div>
          <div class="shortcut-item"><kbd>Ctrl + F</kbd><span>聚焦文本纠错搜索框</span></div>
          <div class="shortcut-item"><kbd>Enter</kbd><span>在搜索框内跳到下一个匹配</span></div>
          <div class="shortcut-item"><kbd>Shift + Enter</kbd><span>在搜索框内跳到上一个匹配</span></div>
          <div class="shortcut-item"><kbd>Ctrl + S</kbd><span>立即保存审核草稿</span></div>
          <div class="shortcut-item"><kbd>Esc</kbd><span>关闭浮窗或快捷键指南</span></div>
          <div class="shortcut-item"><kbd>鼠标滚轮</kbd><span>在波形上滚动可缩放波形</span></div>
        </div>
        <button id="btnCloseShortcutHelp" type="button">我知道了</button>
      </div>
    </div>

    <div class="card content-card">
      <div id="contentViewport">
        <div id="content"></div>
      </div>
    </div>

    <details class="card logs-card">
      <summary class="meta" style="font-weight:700; cursor:pointer;">裁剪任务日志（点击展开）</summary>
      <div id="logs" style="margin-top:8px"></div>
    </details>
  </div>

  <button id="btnToggleLeftPanel" class="floating-toggle left" type="button">发布建议</button>
  <button id="btnToggleImagePanel" class="floating-toggle left image-toggle" type="button">视频配图</button>
  <button id="btnToggleRightPanel" class="floating-toggle right" type="button">LLM对话</button>

  <aside class="side-panel floating-side left">
    <div class="panel-header">
      <span>发布建议</span>
      <div class="panel-actions">
        <button id="btnGeneratePublish">生成建议</button>
        <button id="btnCloseLeftPanel" class="panel-close" type="button">收起</button>
      </div>
    </div>
    <div class="row compact-row">
      <span class="meta">风格</span>
      <select id="publishStyle">
        <option value="专业" selected>专业</option>
        <option value="保守">保守</option>
        <option value="吸睛">吸睛</option>
      </select>
    </div>
    <div id="publishStatus" class="meta">点击“生成建议”后会产出 10 个标题与简介。</div>
    <div class="panel-section">
      <div class="panel-title">标题建议（10个）</div>
      <ol id="publishTitlesList"></ol>
    </div>
    <div class="panel-section">
      <div class="panel-title">作品简介（可编辑）</div>
      <textarea id="publishDescription" placeholder="这里会生成简介建议"></textarea>
    </div>
    <div class="panel-section">
      <div class="panel-title">关键词</div>
      <div id="publishKeywords"></div>
    </div>
  </aside>

  <aside class="side-panel floating-side left image-side">
    <div class="panel-header">
      <span>插入素材</span>
      <div class="panel-actions">
        <button id="btnGenerateImages">生成配图</button>
        <button id="btnDownloadImages" disabled>批量下载</button>
        <button id="btnCloseImagePanel" class="panel-close" type="button">收起</button>
      </div>
    </div>
    <div class="row compact-row">
      <span class="meta">数量</span>
      <select id="imageCount">
        <option value="6">6 张</option>
        <option value="8" selected>8 张</option>
        <option value="10">10 张</option>
        <option value="12">12 张</option>
      </select>
    </div>
    <div class="row compact-row">
      <span class="meta">比例</span>
      <select id="imageAspect">
        <option value="1:1" selected>1:1 正方形，头像</option>
        <option value="2:3">2:3 社交媒体，自拍</option>
        <option value="3:4">3:4 经典比例，拍照</option>
        <option value="4:3">4:3 文章配图，插画</option>
        <option value="9:16">9:16 手机壁纸，人像</option>
        <option value="16:9">16:9 桌面壁纸，风景</option>
      </select>
    </div>
    <div class="row compact-row">
      <span class="meta">风格</span>
      <select id="imageStyle">
        <option value="人像摄影，真实镜头，高级布光，统一人物服饰和场景质感">人像摄影</option>
        <option value="电影写真，电影级光影，浅景深，统一角色造型和环境氛围">电影写真</option>
        <option value="中国风，东方审美，国风色彩，统一人物服饰与中式场景">中国风</option>
        <option value="动漫，清晰线稿，赛璐璐上色，统一角色设定和分镜节奏">动漫</option>
        <option value="3D渲染，柔和材质，精致角色模型，统一场景和光线">3D渲染</option>
        <option value="赛博朋克，霓虹光影，未来城市，统一高对比色彩系统">赛博朋克</option>
        <option value="CG 动画，电影动画质感，统一角色设计，清晰动作表演">CG 动画</option>
        <option value="水墨画，留白构图，墨色层次，东方场景和人物气韵">水墨画</option>
        <option value="油画，厚涂笔触，古典光影，统一色调和人物服饰">油画</option>
        <option value="古典，古典肖像与场景，柔和光线，复古服饰和空间">古典</option>
        <option value="水彩画，透明水彩，轻盈纸张肌理，统一柔和色彩">水彩画</option>
        <option value="卡通，明快造型，统一可爱角色，干净背景">卡通</option>
        <option value="平面插画，简洁几何，统一色板，适合知识视频">平面插画</option>
        <option value="风景，环境叙事，统一自然光线和场景气氛">风景</option>
        <option value="港风动漫，复古港片色彩，漫画线条，统一人物造型">港风动漫</option>
        <option value="像素风格，复古像素艺术，统一色板和人物轮廓">像素风格</option>
        <option value="荧光绘画，霓虹色彩，发光边缘，统一暗背景">荧光绘画</option>
        <option value="彩铅画，纸张纹理，温暖克制色彩，统一人物和服饰" selected>彩铅画</option>
        <option value="手办，精致玩具质感，微缩场景，统一角色模型">手办</option>
        <option value="儿童绘画，童趣线条，柔和色彩，统一简单场景">儿童绘画</option>
        <option value="抽象，形状与色块表达主题，统一视觉符号">抽象</option>
        <option value="锐笔插画，锋利线条，高级构图，统一角色与场景">锐笔插画</option>
        <option value="二次元，日系角色，细腻线条，统一发型服饰">二次元</option>
        <option value="油墨印刷，粗颗粒印刷肌理，复古色彩，统一版画感">油墨印刷</option>
        <option value="版画，木刻线条，高对比黑白或套色，统一纹理">版画</option>
        <option value="莫奈，印象派光影，柔和笔触，统一色彩空气感">莫奈</option>
        <option value="毕加索，立体主义构成，统一几何人物和空间">毕加索</option>
        <option value="伦勃朗，古典明暗对照，深色背景，统一肖像光线">伦勃朗</option>
        <option value="马蒂斯，鲜明色块，装饰性构图，统一平面色彩">马蒂斯</option>
        <option value="巴洛克，戏剧化光影，华丽服饰，统一古典空间">巴洛克</option>
        <option value="复古动漫，胶片颗粒，老动画色彩，统一角色造型">复古动漫</option>
        <option value="绘本，温暖故事插画，纸张肌理，统一人物和场景">绘本</option>
      </select>
    </div>
    <div class="row compact-row">
      <span class="meta">图片动效</span>
      <select id="imageMotionEffect">
        <option value="none" selected>无动效</option>
        <option value="zoom-in">缓慢推进</option>
        <option value="zoom-out">缓慢拉远</option>
        <option value="pan-left">缓慢左移</option>
        <option value="pan-right">缓慢右移</option>
        <option value="pan-up">缓慢上移</option>
        <option value="pan-down">缓慢下移</option>
      </select>
    </div>
    <div id="imageStatus" class="meta">点击“生成配图”后，会先规划配图点，再逐张调用图片 API 生成预览。</div>
    <div id="imageCardList"></div>
    <div class="panel-section media-video-section">
      <div class="panel-title">视频素材（Agnes）</div>
      <div class="row compact-row">
        <span class="meta">数量</span>
        <select id="videoAssetCount">
          <option value="1">1 段</option>
          <option value="2">2 段</option>
          <option value="3" selected>3 段</option>
          <option value="4">4 段</option>
        </select>
      </div>
      <div class="row compact-row">
        <span class="meta">比例</span>
        <select id="videoAssetAspect">
          <option value="16:9" selected>16:9 横屏</option>
          <option value="9:16">9:16 竖屏</option>
          <option value="1:1">1:1 方形</option>
        </select>
      </div>
      <div class="panel-actions">
        <button id="btnGenerateVideos" type="button">生成视频素材</button>
      </div>
      <div id="videoAssetStatus" class="meta">点击后会先由 LLM 规划插入位置，再调用 Agnes 生成视频素材。</div>
      <div id="videoAssetList"></div>
    </div>
  </aside>

  <aside class="side-panel floating-side right">
    <div class="panel-header">
      <span>LLM对话调标记</span>
      <div class="panel-actions">
        <button id="btnLlmChatUndo" disabled>撤回一步</button>
        <button id="btnCloseRightPanel" class="panel-close" type="button">收起</button>
      </div>
    </div>
    <div id="llmChatHistory"></div>
    <textarea id="llmChatInput" placeholder="例如：保留开头铺垫，删除后半段重复表达；把过度口头禅都标记出来。"></textarea>
    <div class="row compact-row">
      <button id="btnLlmChatSend">发送并调整</button>
    </div>
    <div id="llmChatStatus" class="meta">可通过对话追加或撤销标记，不满意可撤回。</div>
  </aside>

  <script>
    const WORDS = ${wordsJson};
    const AUTO = ${selectedJson};
    const AUTO_REASONS = ${autoReasonsJson};
    const AUTO_STATS = ${autoStatsJson};
    const TERM_GLOSSARY = ${termGlossaryJson};
    const QUALITY = ${qualityJson};

    const audio = document.getElementById('audio');
    const toolbarCardEl = document.querySelector('.toolbar-card');
    const videoPreviewPanelEl = document.getElementById('videoPreviewPanel');
    const sourceVideoEl = document.getElementById('sourceVideo');
    const videoPreviewStatusEl = document.getElementById('videoPreviewStatus');
    const content = document.getElementById('content');
    const contentViewportEl = document.getElementById('contentViewport');
    const statusEl = document.getElementById('status');
    const selectionStatsEl = document.getElementById('selectionStats');
    const runtimeEl = document.getElementById('runtime');
    const draftStateEl = document.getElementById('draftState');
    const logsEl = document.getElementById('logs');
    const thresholdEl = document.getElementById('silenceThreshold');
    const speechLeadMsEl = document.getElementById('speechLeadMs');
    const speechTailMsEl = document.getElementById('speechTailMs');
    const fillerBoostMsEl = document.getElementById('fillerBoostMs');
    const silenceGuardMsEl = document.getElementById('silenceGuardMs');
    const qualityWarningsEl = document.getElementById('qualityWarnings');
    const llmSummaryEl = document.getElementById('llmSummary');
    const waveWrapEl = document.getElementById('waveWrap');
    const waveCanvas = document.getElementById('waveCanvas');
    const waveHintEl = document.getElementById('waveHint');
    const waveZoomEl = document.getElementById('waveZoom');
    const waveZoomTextEl = document.getElementById('waveZoomText');
    const btnLlmMark = document.getElementById('btnLlmMark');
    const btnApplyLlm = document.getElementById('btnApplyLlm');
    const btnClearLlm = document.getElementById('btnClearLlm');
    const btnPreviewDelete = document.getElementById('btnPreviewDelete');
    const btnToggleVideoPreview = document.getElementById('btnToggleVideoPreview');
    const btnFocusReview = document.getElementById('btnFocusReview');
    const btnShowDeleteDiagnostics = document.getElementById('btnShowDeleteDiagnostics');
    const btnCopyDiagnostics = document.getElementById('btnCopyDiagnostics');
    const cutPrecisionModeEl = document.getElementById('cutPrecisionMode');
    const deletePreviewInfoEl = document.getElementById('deletePreviewInfo');
    const deleteDiagnosticsPanelEl = document.getElementById('deleteDiagnosticsPanel');
    const btnCut = document.getElementById('btnCut');
    const btnExportSrt = document.getElementById('btnExportSrt');
    const btnExportTxt = document.getElementById('btnExportTxt');
    const btnExportJianyingDraft = document.getElementById('btnExportJianyingDraft');
    const jianyingSubtitlePresetEl = document.getElementById('jianyingSubtitlePreset');
    const jianyingTemplatePathEl = document.getElementById('jianyingTemplatePath');
    const exportStatusEl = document.getElementById('exportStatus');
    const replaceFindTextEl = document.getElementById('replaceFindText');
    const replaceWithTextEl = document.getElementById('replaceWithText');
    const btnFindPrev = document.getElementById('btnFindPrev');
    const btnFindNext = document.getElementById('btnFindNext');
    const btnReplaceOne = document.getElementById('btnReplaceOne');
    const btnReplaceAll = document.getElementById('btnReplaceAll');
    const btnApplyGlossary = document.getElementById('btnApplyGlossary');
    const glossarySummaryEl = document.getElementById('glossarySummary');
    const replaceStatusEl = document.getElementById('replaceStatus');
    const btnShortcutHelp = document.getElementById('btnShortcutHelp');
    const shortcutHelpEl = document.getElementById('shortcutHelp');
    const btnCloseShortcutHelp = document.getElementById('btnCloseShortcutHelp');
    const leftPanelEl = document.querySelector('.floating-side.left');
    const rightPanelEl = document.querySelector('.floating-side.right');
    const imagePanelEl = document.querySelector('.floating-side.image-side');
    const btnToggleLeftPanel = document.getElementById('btnToggleLeftPanel');
    const btnToggleImagePanel = document.getElementById('btnToggleImagePanel');
    const btnToggleRightPanel = document.getElementById('btnToggleRightPanel');
    const btnCloseLeftPanel = document.getElementById('btnCloseLeftPanel');
    const btnCloseImagePanel = document.getElementById('btnCloseImagePanel');
    const btnCloseRightPanel = document.getElementById('btnCloseRightPanel');
    const btnGeneratePublish = document.getElementById('btnGeneratePublish');
    const btnGenerateImages = document.getElementById('btnGenerateImages');
    const btnGenerateVideos = document.getElementById('btnGenerateVideos');
    const btnDownloadImages = document.getElementById('btnDownloadImages');
    const publishStyleEl = document.getElementById('publishStyle');
    const publishStatusEl = document.getElementById('publishStatus');
    const publishTitlesListEl = document.getElementById('publishTitlesList');
    const publishDescriptionEl = document.getElementById('publishDescription');
    const publishKeywordsEl = document.getElementById('publishKeywords');
    const imageCountEl = document.getElementById('imageCount');
    const imageAspectEl = document.getElementById('imageAspect');
    const imageStyleEl = document.getElementById('imageStyle');
    const imageMotionEffectEl = document.getElementById('imageMotionEffect');
    const imageStatusEl = document.getElementById('imageStatus');
    const imageCardListEl = document.getElementById('imageCardList');
    const videoAssetCountEl = document.getElementById('videoAssetCount');
    const videoAssetAspectEl = document.getElementById('videoAssetAspect');
    const videoAssetStatusEl = document.getElementById('videoAssetStatus');
    const videoAssetListEl = document.getElementById('videoAssetList');
    const llmChatHistoryEl = document.getElementById('llmChatHistory');
    const llmChatInputEl = document.getElementById('llmChatInput');
    const btnLlmChatSend = document.getElementById('btnLlmChatSend');
    const btnLlmChatUndo = document.getElementById('btnLlmChatUndo');
    const llmChatStatusEl = document.getElementById('llmChatStatus');

    const selected = new Set(AUTO);
    const autoSet = new Set(AUTO);
    const originalTexts = WORDS.map((w) => String((w && !w.isGap ? w.text : '') || ''));
    const textOverrides = new Map();
    let searchMatches = [];
    let activeSearchMatch = -1;
    let searchHitIndices = new Set();
    let searchActiveIndices = new Set();
    const FOCUS_REVIEW_STORAGE_KEY = 'jaygo.review.focusMode';
    const VIDEO_PREVIEW_STORAGE_KEY = 'jaygo.review.videoPreview';
    let videoPreviewEnabled = false;
    let syncingVideoFromAudio = false;
    let syncingAudioFromVideo = false;
    const DEFAULT_BOUNDARY = {
      speechLeadMs: 45,
      speechTailMs: 90,
      fillerBoostMs: 30,
      silenceGuardMs: 45,
    };

    function clampNumber(value, min, max, fallback) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.max(min, Math.min(max, parsed));
    }

    function readBoundarySettings() {
      return {
        speechLeadMs: clampNumber(speechLeadMsEl?.value, 0, 180, DEFAULT_BOUNDARY.speechLeadMs),
        speechTailMs: clampNumber(speechTailMsEl?.value, 0, 220, DEFAULT_BOUNDARY.speechTailMs),
        fillerBoostMs: clampNumber(fillerBoostMsEl?.value, 0, 120, DEFAULT_BOUNDARY.fillerBoostMs),
        silenceGuardMs: clampNumber(silenceGuardMsEl?.value, 0, 120, DEFAULT_BOUNDARY.silenceGuardMs),
      };
    }

    function applyBoundarySettings(settings = {}) {
      const next = {
        speechLeadMs: clampNumber(settings.speechLeadMs, 0, 180, DEFAULT_BOUNDARY.speechLeadMs),
        speechTailMs: clampNumber(settings.speechTailMs, 0, 220, DEFAULT_BOUNDARY.speechTailMs),
        fillerBoostMs: clampNumber(settings.fillerBoostMs, 0, 120, DEFAULT_BOUNDARY.fillerBoostMs),
        silenceGuardMs: clampNumber(settings.silenceGuardMs, 0, 120, DEFAULT_BOUNDARY.silenceGuardMs),
      };
      if (speechLeadMsEl) speechLeadMsEl.value = String(next.speechLeadMs);
      if (speechTailMsEl) speechTailMsEl.value = String(next.speechTailMs);
      if (fillerBoostMsEl) fillerBoostMsEl.value = String(next.fillerBoostMs);
      if (silenceGuardMsEl) silenceGuardMsEl.value = String(next.silenceGuardMs);
    }

    function toZhReason(reason, fallback) {
      const raw = String(reason || '').trim();
      if (!raw) return fallback || '';
      const lower = raw.toLowerCase();
      const silenceMatch = lower.match(/silence\\s*>=\\s*([\\d.]+)s?/);
      if (silenceMatch) return '静音片段（>=' + silenceMatch[1] + '秒）';
      if (lower.includes('silence') || lower.includes('静音')) return '静音片段';
      if (lower.includes('filler-phrase')) return '语气词短句';
      if (lower.includes('filler-word')) return '语气词';
      if (lower.includes('filler') || lower.includes('语气') || lower.includes('口头')) return '语气词';
      if (lower.includes('repeated sentence')) return '重复句（后段）';
      if (lower.includes('repeat') || lower.includes('重复')) return '重复句';
      if (lower.includes('bridge') || lower.includes('gap')) return '衔接静音';
      if (lower.includes('rule pre-mark')) return '规则预标记';
      if (lower.includes('empty content')) return '返回内容为空';
      if (!/[\\u4e00-\\u9fff]/.test(raw) && /[a-zA-Z]/.test(raw)) return fallback || '语义可精简';
      return raw;
    }

    function reasonCategory(reason, isGap) {
      const lower = String(reason || '').toLowerCase();
      if (lower.includes('filler') || lower.includes('语气') || lower.includes('口头')) return 'filler';
      if (lower.includes('repeat') || lower.includes('重复')) return 'repeat';
      if (lower.includes('silence') || lower.includes('静音') || lower.includes('bridge') || lower.includes('gap')) return 'silence';
      return isGap ? 'silence' : null;
    }
    const autoReasonByIndex = new Map(
      Object.entries(AUTO_REASONS || {})
        .map(([k, v]) => [Number(k), toZhReason(v)])
        .filter(([k, v]) => Number.isInteger(k) && k >= 0 && k < WORDS.length && v),
    );
    const defaultThreshold = Number(AUTO_STATS?.thresholdSec);
    const thresholdText = Number.isFinite(defaultThreshold) ? defaultThreshold.toFixed(2) : '0.20';
    AUTO.forEach((idx) => {
      if (autoReasonByIndex.has(idx)) return;
      const w = WORDS[idx] || {};
      if (w.isGap) autoReasonByIndex.set(idx, '静音片段（>=' + thresholdText + '秒）');
      else autoReasonByIndex.set(idx, '规则预标记');
    });
    const llmSuggested = new Set();
    const llmReasonByIndex = new Map();
    const llmPunctByIndex = new Map();
    const llmParagraphAfterIndex = new Set();
    let llmTopic = '';
    let llmOutline = '';
    let llmMultiSpeaker = false;
    const starts = WORDS.map((w) => Number(w.start));
    const ends = WORDS.map((w) => Number(w.end));
    const gapDurations = WORDS
      .filter((w) => !!w && !!w.isGap)
      .map((w) => Number(w.end) - Number(w.start))
      .filter((d) => Number.isFinite(d) && d > 0);

    function percentile(sorted, p) {
      if (!Array.isArray(sorted) || !sorted.length) return 0;
      const n = sorted.length;
      const pos = Math.max(0, Math.min(1, Number(p) || 0)) * (n - 1);
      const lo = Math.floor(pos);
      const hi = Math.ceil(pos);
      if (lo === hi) return sorted[lo];
      const t = pos - lo;
      return sorted[lo] * (1 - t) + sorted[hi] * t;
    }

    function buildPunctuationProfile() {
      if (!gapDurations.length) {
        return { comma: 0.22, sentence: 0.34, paragraph: 0.52 };
      }
      const sorted = [...gapDurations].sort((a, b) => a - b);
      const maxGap = sorted[sorted.length - 1];
      let comma = Math.max(0.14, Math.min(0.30, percentile(sorted, 0.68)));
      let sentence = Math.max(comma + 0.04, Math.min(0.45, percentile(sorted, 0.88)));
      let paragraph = Math.max(sentence + 0.06, Math.min(0.70, percentile(sorted, 0.97) + 0.02));
      if (paragraph > maxGap) paragraph = Math.max(sentence + 0.04, maxGap - 0.01);
      if (paragraph <= sentence) paragraph = sentence + 0.05;
      return {
        comma: Number(comma.toFixed(2)),
        sentence: Number(sentence.toFixed(2)),
        paragraph: Number(paragraph.toFixed(2)),
      };
    }

    const punctProfile = buildPunctuationProfile();

    let tokenEls = [];
    let tokenRects = [];
    let currentIndex = -1;
    let isDragging = false;
    let dragMode = 'add';
    let dragVisited = new Set();
    let lastDragIdx = null;
    let dragBaseSelected = null;
    let dragPreviewStart = null;
    let dragPreviewEnd = null;
    let isPointerDown = false;
    let pointerDownIdx = null;
    let pointerDownX = 0;
    let pointerDownY = 0;
    let cutSubmitting = false;
    let isCutRunning = false;
    let llmMarking = false;
    let syncTimer = null;
    let lastAutoScrollAt = 0;
    let lastDragAutoScrollAt = 0;
    let mergedSelected = [];
    let lastSkipAt = 0;
    let lastSkipTarget = -1;
    let autosaveTimer = null;
    let isRestoringReviewState = false;
    let lastStateHash = '';
    let wavePeaks = null;
    let waveDurationSec = 0;
    let waveReady = false;
    let waveZoom = 1;
    let waveViewCenterSec = 0;
    let waveStaticCanvas = null;
    let waveStaticKey = '';
    let previewSegment = null;
    let previewStopTime = null;
    let skipFadeRaf = null;
    let skipFadeTimer = null;
    let latestCutLogTail = [];
    let runtimeInfoCache = null;
    let publishLoading = false;
    let llmChatSubmitting = false;
    let imageGenerating = false;
    let videoGenerating = false;
    let imageItems = [];
    let videoItems = [];
    let isProgrammaticScroll = false;
    let programmaticScrollTimer = null;
    let lastUserScrollAt = 0;
    let suppressAutoFollowUntil = 0;
    const chatMessages = [];
    const selectionUndoStack = [];
    const selectionRedoStack = [];
    let leftPanelOpen = false;
    let imagePanelOpen = false;
    let rightPanelOpen = false;

    function setStatus(msg) {
      statusEl.textContent = msg;
    }

    function renderQualityWarnings() {
      if (!qualityWarningsEl) return;
      const generated = QUALITY && QUALITY.generated ? QUALITY.generated : {};
      const saved = QUALITY && QUALITY.saved ? QUALITY.saved : {};
      const warnings = [
        ...new Set([
          ...(Array.isArray(saved.warnings) ? saved.warnings : []),
          ...(Array.isArray(generated.warnings) ? generated.warnings : []),
        ]),
      ];
      if (!warnings.length) {
        qualityWarningsEl.hidden = true;
        qualityWarningsEl.textContent = '';
        return;
      }
      qualityWarningsEl.hidden = false;
      qualityWarningsEl.textContent = '转录质量提醒：' + warnings.join('；');
    }

    function syncFloatingToggles() {
      const anyLeftPanelOpen = leftPanelOpen || imagePanelOpen;
      if (btnToggleLeftPanel) {
        btnToggleLeftPanel.classList.toggle('active', leftPanelOpen);
        btnToggleLeftPanel.classList.toggle('hidden', anyLeftPanelOpen);
        btnToggleLeftPanel.textContent = '发布建议';
      }
      if (btnToggleImagePanel) {
        btnToggleImagePanel.classList.toggle('active', imagePanelOpen);
        btnToggleImagePanel.classList.toggle('hidden', anyLeftPanelOpen);
        btnToggleImagePanel.textContent = '插入素材';
      }
      if (btnToggleRightPanel) {
        btnToggleRightPanel.classList.toggle('active', rightPanelOpen);
        btnToggleRightPanel.classList.toggle('hidden', rightPanelOpen);
        btnToggleRightPanel.textContent = 'LLM对话';
      }
    }

    function setPanelOpen(side, open) {
      if (side === 'image') {
        imagePanelOpen = !!open;
        if (imagePanelOpen) {
          leftPanelOpen = false;
          rightPanelOpen = false;
        }
      } else if (side === 'left') {
        leftPanelOpen = !!open;
        if (leftPanelOpen) {
          imagePanelOpen = false;
          rightPanelOpen = false;
        }
      } else {
        rightPanelOpen = !!open;
        if (rightPanelOpen) {
          leftPanelOpen = false;
          imagePanelOpen = false;
        }
      }
      if (leftPanelEl) leftPanelEl.classList.toggle('open', leftPanelOpen);
      if (imagePanelEl) imagePanelEl.classList.toggle('open', imagePanelOpen);
      if (rightPanelEl) rightPanelEl.classList.toggle('open', rightPanelOpen);
      syncFloatingToggles();
    }

    function closePanels() {
      setPanelOpen('left', false);
      setPanelOpen('image', false);
      setPanelOpen('right', false);
    }

    function setDraftState(msg) {
      draftStateEl.textContent = msg;
    }

    function normalizeThemeMode(mode) {
      const value = String(mode || '').trim().toLowerCase();
      if (value === 'blackgold' || value === 'system') return value;
      return 'light';
    }

    function resolveEffectiveTheme(mode) {
      const normalized = normalizeThemeMode(mode);
      if (normalized === 'system') {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
          return 'blackgold';
        }
        return 'light';
      }
      return normalized;
    }

    function applyTheme(mode) {
      const effective = resolveEffectiveTheme(mode);
      document.documentElement.setAttribute('data-theme', effective);
      document.documentElement.style.colorScheme = effective === 'blackgold' ? 'dark' : 'light';
    }

    function setPublishStatus(text) {
      if (!publishStatusEl) return;
      publishStatusEl.textContent = String(text || '');
    }

    function setLlmChatStatus(text) {
      if (!llmChatStatusEl) return;
      llmChatStatusEl.textContent = String(text || '');
    }

    function setPublishLoading(next) {
      publishLoading = !!next;
      if (btnGeneratePublish) {
        btnGeneratePublish.disabled = publishLoading;
        btnGeneratePublish.textContent = publishLoading ? '生成中...' : '生成建议';
      }
      if (publishStyleEl) publishStyleEl.disabled = publishLoading;
    }

    function setImageStatus(text) {
      if (!imageStatusEl) return;
      imageStatusEl.textContent = String(text || '');
    }

    function setImageGenerating(next) {
      imageGenerating = !!next;
      if (btnGenerateImages) {
        btnGenerateImages.disabled = imageGenerating;
        btnGenerateImages.textContent = imageGenerating ? '生成中...' : '生成配图';
      }
      if (btnDownloadImages) {
        btnDownloadImages.disabled = imageGenerating || !imageItems.some((item) => item?.image?.url);
      }
      if (imageCountEl) imageCountEl.disabled = imageGenerating;
      if (imageAspectEl) imageAspectEl.disabled = imageGenerating;
      if (imageStyleEl) imageStyleEl.disabled = imageGenerating;
    }

    function currentImageMotionEffect() {
      const value = String(imageMotionEffectEl ? imageMotionEffectEl.value : 'none');
      return ['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down'].includes(value) ? value : 'none';
    }

    function setVideoAssetStatus(text) {
      if (!videoAssetStatusEl) return;
      videoAssetStatusEl.textContent = String(text || '');
    }

    function setVideoGenerating(next) {
      videoGenerating = !!next;
      if (btnGenerateVideos) {
        btnGenerateVideos.disabled = videoGenerating;
        btnGenerateVideos.textContent = videoGenerating ? '生成中...' : '生成视频素材';
      }
      if (videoAssetCountEl) videoAssetCountEl.disabled = videoGenerating;
      if (videoAssetAspectEl) videoAssetAspectEl.disabled = videoGenerating;
    }

    function setLlmChatSubmitting(next) {
      llmChatSubmitting = !!next;
      if (btnLlmChatSend) {
        btnLlmChatSend.disabled = llmChatSubmitting;
        btnLlmChatSend.textContent = llmChatSubmitting ? '处理中...' : '发送并调整';
      }
      if (llmChatInputEl) llmChatInputEl.disabled = llmChatSubmitting;
    }

    function getWordText(index) {
      const idx = Number(index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= WORDS.length) return '';
      if (textOverrides.has(idx)) return textOverrides.get(idx);
      const w = WORDS[idx] || {};
      return w.isGap ? '' : String(w.text || '');
    }

    function setWordText(index, nextText) {
      const idx = Number(index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= WORDS.length) return false;
      const w = WORDS[idx];
      if (!w || w.isGap) return false;
      const value = String(nextText || '').slice(0, 80);
      w.text = value;
      if (value === originalTexts[idx]) textOverrides.delete(idx);
      else textOverrides.set(idx, value);
      return true;
    }

    function replaceTextOverrideEntries(entries) {
      textOverrides.clear();
      for (let i = 0; i < WORDS.length; i += 1) {
        if (WORDS[i] && !WORDS[i].isGap) WORDS[i].text = originalTexts[i] || '';
      }
      for (const pair of entries || []) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        const idx = Number(pair[0]);
        if (!Number.isInteger(idx) || idx < 0 || idx >= WORDS.length) continue;
        setWordText(idx, pair[1]);
      }
    }

    function syncUndoButton() {
      if (!btnLlmChatUndo) return;
      btnLlmChatUndo.disabled = selectionUndoStack.length === 0;
    }

    function snapshotSelectionState() {
      return {
        selected: Array.from(selected),
        llmSuggested: Array.from(llmSuggested),
        llmReasonEntries: Array.from(llmReasonByIndex.entries()),
        llmPunctEntries: Array.from(llmPunctByIndex.entries()),
        llmParagraphAfter: Array.from(llmParagraphAfterIndex),
        textOverrideEntries: Array.from(textOverrides.entries()),
        llmTopic,
        llmOutline,
        llmMultiSpeaker,
      };
    }

    function pushSelectionUndo() {
      selectionUndoStack.push(snapshotSelectionState());
      while (selectionUndoStack.length > 80) selectionUndoStack.shift();
      selectionRedoStack.length = 0;
      syncUndoButton();
    }

    function restoreSelectionState(snapshot) {
      if (!snapshot || !Array.isArray(snapshot.selected)) return;
      selected.clear();
      llmSuggested.clear();
      llmReasonByIndex.clear();
      llmPunctByIndex.clear();
      llmParagraphAfterIndex.clear();
      llmTopic = '';
      llmOutline = '';
      llmMultiSpeaker = false;
      replaceTextOverrideEntries(snapshot.textOverrideEntries || []);
      for (const i of snapshot.selected) {
        const idx = Number(i);
        if (Number.isInteger(idx) && idx >= 0 && idx < WORDS.length) selected.add(idx);
      }
      for (const i of snapshot.llmSuggested || []) {
        const idx = Number(i);
        if (Number.isInteger(idx) && idx >= 0 && idx < WORDS.length) llmSuggested.add(idx);
      }
      for (const pair of snapshot.llmReasonEntries || []) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        const idx = Number(pair[0]);
        const reason = String(pair[1] || '').trim();
        if (Number.isInteger(idx) && idx >= 0 && idx < WORDS.length && reason) {
          llmReasonByIndex.set(idx, reason);
        }
      }
      for (const pair of snapshot.llmPunctEntries || []) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        const idx = Number(pair[0]);
        const punct = String(pair[1] || '').trim();
        if (Number.isInteger(idx) && idx >= 0 && idx < WORDS.length && /[，。！？；：]/.test(punct)) {
          llmPunctByIndex.set(idx, punct[0]);
        }
      }
      for (const i of snapshot.llmParagraphAfter || []) {
        const idx = Number(i);
        if (Number.isInteger(idx) && idx >= 0 && idx < WORDS.length) llmParagraphAfterIndex.add(idx);
      }
      llmTopic = String(snapshot.llmTopic || '').trim().slice(0, 80);
      llmOutline = String(snapshot.llmOutline || '').trim().slice(0, 120);
      llmMultiSpeaker = !!snapshot.llmMultiSpeaker;
      render();
      syncCurrentToken();
      updateSelectionStats();
      refreshLlmSummary();
      scheduleReviewStateSave(200);
    }

    function undoLastSelectionChange(source) {
      if (!selectionUndoStack.length) return false;
      const snapshot = selectionUndoStack.pop();
      selectionRedoStack.push(snapshotSelectionState());
      while (selectionRedoStack.length > 80) selectionRedoStack.shift();
      restoreSelectionState(snapshot);
      syncUndoButton();
      if (source === 'chat') {
        pushChatMessage('assistant', '已撤回上一步对话调标记。');
        setLlmChatStatus('已撤回最近一次对话调整');
      } else {
        setStatus('已撤回上一步标记');
        setTimeout(refreshIdleStatus, 1000);
      }
      return true;
    }

    function redoLastSelectionChange() {
      if (!selectionRedoStack.length) return false;
      const snapshot = selectionRedoStack.pop();
      selectionUndoStack.push(snapshotSelectionState());
      while (selectionUndoStack.length > 80) selectionUndoStack.shift();
      restoreSelectionState(snapshot);
      syncUndoButton();
      setStatus('已重做上一步操作');
      setTimeout(refreshIdleStatus, 1000);
      return true;
    }

    function addChatRow(role, text) {
      if (!llmChatHistoryEl) return;
      const row = document.createElement('div');
      row.className = 'chat-row ' + (role === 'assistant' ? 'assistant' : 'user');
      row.textContent = String(text || '').trim();
      llmChatHistoryEl.appendChild(row);
      llmChatHistoryEl.scrollTop = llmChatHistoryEl.scrollHeight;
    }

    function pushChatMessage(role, text) {
      const msg = {
        role: role === 'assistant' ? 'assistant' : 'user',
        text: String(text || '').trim().slice(0, 600),
      };
      if (!msg.text) return;
      chatMessages.push(msg);
      while (chatMessages.length > 20) chatMessages.shift();
      addChatRow(msg.role, msg.text);
    }

    function setProgrammaticScroll(active) {
      isProgrammaticScroll = !!active;
      if (!active) return;
      if (programmaticScrollTimer) {
        clearTimeout(programmaticScrollTimer);
        programmaticScrollTimer = null;
      }
      programmaticScrollTimer = setTimeout(() => {
        isProgrammaticScroll = false;
      }, 260);
    }

    function markUserScrollIntent(holdMs) {
      const now = Date.now();
      lastUserScrollAt = now;
      suppressAutoFollowUntil = Math.max(suppressAutoFollowUntil, now + (Number(holdMs) || 1400));
    }

    function renderPublishSuggestions(data) {
      const titles = Array.isArray(data?.titles) ? data.titles : [];
      const descriptions = Array.isArray(data?.descriptions) ? data.descriptions : [];
      const keywords = Array.isArray(data?.keywords) ? data.keywords : [];

      if (publishTitlesListEl) {
        publishTitlesListEl.innerHTML = '';
        if (!titles.length) {
          const li = document.createElement('li');
          li.textContent = '暂无标题建议';
          publishTitlesListEl.appendChild(li);
        } else {
          titles.forEach((title) => {
            const li = document.createElement('li');
            li.textContent = String(title || '');
            publishTitlesListEl.appendChild(li);
          });
        }
      }

      if (publishDescriptionEl) {
        publishDescriptionEl.value = descriptions[0] || '';
      }
      if (publishKeywordsEl) {
        publishKeywordsEl.innerHTML = '';
        keywords.forEach((kw) => {
          const chip = document.createElement('span');
          chip.className = 'keyword-chip';
          chip.textContent = String(kw || '');
          publishKeywordsEl.appendChild(chip);
        });
      }
    }

    function renderImageCards() {
      if (!imageCardListEl) return;
      imageCardListEl.innerHTML = '';
      const previewRatio = String(imageAspectEl?.value || '1:1').replace(':', ' / ');
      if (!imageItems.length) {
        const empty = document.createElement('div');
        empty.className = 'meta';
        empty.textContent = '暂无配图点。点击“生成配图”后会显示图片预览。';
        imageCardListEl.appendChild(empty);
      } else {
        imageItems.forEach((item, index) => {
          const card = document.createElement('div');
          card.className = 'image-card';
          const preview = document.createElement('div');
          preview.className = 'image-preview';
          preview.style.aspectRatio = previewRatio;
          if (item.image && item.image.url) {
            const img = document.createElement('img');
            img.src = item.image.url;
            img.alt = item.title || '视频配图';
            preview.appendChild(img);
          } else {
            preview.textContent = item.status === 'error'
              ? ('生成失败：' + (item.error || '未知错误'))
              : (item.status === 'generating' ? '正在生成图片...' : '等待生成');
          }

          const title = document.createElement('div');
          title.className = 'image-card-title';
          title.textContent = (index + 1) + '. [' + (item.timeRange || '-') + '] ' + (item.title || '视频配图');

          const purpose = document.createElement('div');
          purpose.className = 'meta';
          purpose.textContent = (item.purpose || '视频配图') + (item.textBasis ? (' | 依据：' + item.textBasis) : '');

          const scene = document.createElement('div');
          scene.className = 'image-card-prompt';
          scene.textContent = [
            item.directorIntent ? ('导演意图：' + item.directorIntent) : '',
            item.sceneStory ? ('画面故事：' + item.sceneStory) : '',
            item.camera ? ('镜头构图：' + item.camera) : '',
          ].filter(Boolean).join('\\n');

          const prompt = document.createElement('div');
          prompt.className = 'image-card-prompt';
          prompt.textContent = item.prompt || '';

          const actions = document.createElement('div');
          actions.className = 'image-card-actions';
          const retryBtn = document.createElement('button');
          retryBtn.type = 'button';
          retryBtn.textContent = item.status === 'generating' ? '生成中...' : '重试';
          retryBtn.disabled = item.status === 'generating' || imageGenerating;
          retryBtn.dataset.imageRetry = String(index);
          actions.appendChild(retryBtn);

          const copyBtn = document.createElement('button');
          copyBtn.type = 'button';
          copyBtn.textContent = '复制提示词';
          copyBtn.dataset.imageCopy = String(index);
          actions.appendChild(copyBtn);

          if (item.image && item.image.url) {
            const link = document.createElement('a');
            link.href = item.image.url;
            link.download = ((item.title || item.id || 'image') + '.png').replace(/[\\/:*?"<>|]+/g, '_');
            link.textContent = '下载';
            actions.appendChild(link);
          }

          card.appendChild(preview);
          card.appendChild(title);
          card.appendChild(purpose);
          if (scene.textContent) card.appendChild(scene);
          card.appendChild(prompt);
          card.appendChild(actions);
          imageCardListEl.appendChild(card);
        });
      }
      setImageGenerating(imageGenerating);
    }

    function renderVideoAssetCards() {
      if (!videoAssetListEl) return;
      videoAssetListEl.innerHTML = '';
      if (!videoItems.length) {
        const empty = document.createElement('div');
        empty.className = 'meta';
        empty.textContent = '暂无视频素材点。点击“生成视频素材”后会显示预览。';
        videoAssetListEl.appendChild(empty);
      } else {
        videoItems.forEach((item, index) => {
          const card = document.createElement('div');
          card.className = 'image-card video-asset-card';
          const preview = document.createElement('div');
          preview.className = 'image-preview';
          preview.style.aspectRatio = String(item.aspectRatio || videoAssetAspectEl?.value || '16:9').replace(':', ' / ');
          if (item.video && item.video.url) {
            const video = document.createElement('video');
            video.src = item.video.url;
            video.controls = true;
            video.muted = true;
            video.playsInline = true;
            video.preload = 'metadata';
            video.style.width = '100%';
            video.style.height = '100%';
            video.style.objectFit = 'cover';
            preview.appendChild(video);
          } else {
            preview.textContent = item.status === 'error'
              ? ('生成失败：' + (item.error || '未知错误'))
              : (item.status === 'generating' ? '正在生成视频素材...' : '等待生成');
          }

          const title = document.createElement('div');
          title.className = 'image-card-title';
          title.textContent = (index + 1) + '. [' + (item.timeRange || '-') + '] ' + (item.title || '视频素材');

          const purpose = document.createElement('div');
          purpose.className = 'meta';
          purpose.textContent = (item.purpose || 'B-roll') + (item.textBasis ? (' | 依据：' + item.textBasis) : '');

          const scene = document.createElement('div');
          scene.className = 'image-card-prompt';
          scene.textContent = [
            item.directorIntent ? ('导演意图：' + item.directorIntent) : '',
            item.sceneStory ? ('画面故事：' + item.sceneStory) : '',
            item.camera ? ('镜头：' + item.camera) : '',
          ].filter(Boolean).join('\\n');

          const prompt = document.createElement('div');
          prompt.className = 'image-card-prompt';
          prompt.textContent = item.videoPrompt || item.prompt || '';

          const actions = document.createElement('div');
          actions.className = 'image-card-actions';
          const retryBtn = document.createElement('button');
          retryBtn.type = 'button';
          retryBtn.textContent = item.status === 'generating' ? '生成中...' : '重试';
          retryBtn.disabled = item.status === 'generating' || videoGenerating;
          retryBtn.dataset.videoRetry = String(index);
          actions.appendChild(retryBtn);

          const copyBtn = document.createElement('button');
          copyBtn.type = 'button';
          copyBtn.textContent = '复制提示词';
          copyBtn.dataset.videoCopy = String(index);
          actions.appendChild(copyBtn);

          if (item.video && item.video.url) {
            const link = document.createElement('a');
            link.href = item.video.url;
            link.download = ((item.title || item.id || 'video') + '.mp4').replace(/[\\/:*?"<>|]+/g, '_');
            link.textContent = '下载';
            actions.appendChild(link);
          }

          card.appendChild(preview);
          card.appendChild(title);
          card.appendChild(purpose);
          if (scene.textContent) card.appendChild(scene);
          card.appendChild(prompt);
          card.appendChild(actions);
          videoAssetListEl.appendChild(card);
        });
      }
      setVideoGenerating(videoGenerating);
    }

    function downloadGeneratedImages() {
      const files = imageItems.filter((item) => item?.image?.url);
      if (!files.length) {
        setImageStatus('暂无可下载图片');
        return;
      }
      files.forEach((item, index) => {
        setTimeout(() => {
          const a = document.createElement('a');
          a.href = item.image.url;
          a.download = ((item.title || item.id || ('image_' + (index + 1))) + '.png').replace(/[\\/:*?"<>|]+/g, '_');
          document.body.appendChild(a);
          a.click();
          a.remove();
        }, index * 180);
      });
      setImageStatus('已触发批量下载：' + files.length + ' 张');
    }

    function setExportStatus(text) {
      if (!exportStatusEl) return;
      exportStatusEl.textContent = String(text || '');
    }

    function formatSrtTime(seconds) {
      const msTotal = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
      const ms = msTotal % 1000;
      const totalSeconds = Math.floor(msTotal / 1000);
      const s = totalSeconds % 60;
      const totalMinutes = Math.floor(totalSeconds / 60);
      const m = totalMinutes % 60;
      const h = Math.floor(totalMinutes / 60);
      return String(h).padStart(2, '0') + ':'
        + String(m).padStart(2, '0') + ':'
        + String(s).padStart(2, '0') + ','
        + String(ms).padStart(3, '0');
    }

    function safeExportFileName(ext) {
      const now = new Date();
      const stamp = now.getFullYear()
        + String(now.getMonth() + 1).padStart(2, '0')
        + String(now.getDate()).padStart(2, '0') + '_'
        + String(now.getHours()).padStart(2, '0')
        + String(now.getMinutes()).padStart(2, '0');
      return 'jaygo_cut_subtitles_' + stamp + '.' + ext;
    }

    function downloadTextFile(filename, text) {
      const blob = new Blob(['\uFEFF' + String(text || '')], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    }

    function appendSubtitleToken(base, token) {
      const current = String(base || '');
      const text = String(token || '').trim();
      if (!text) return current;
      const prev = current.slice(-1);
      const first = text[0];
      if (/^[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9]$/.test(first)) {
        return current + ' ' + text;
      }
      return current + text;
    }

    function buildTimeMapper(deleteSegments) {
      const segments = Array.isArray(deleteSegments)
        ? deleteSegments
          .map((seg) => ({
            start: Number(seg.start),
            end: Number(seg.end),
          }))
          .filter((seg) => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start)
          .sort((a, b) => a.start - b.start)
        : [];
      return function mapTime(t) {
        const time = Math.max(0, Number(t) || 0);
        let removed = 0;
        for (const seg of segments) {
          if (seg.end <= time) {
            removed += seg.end - seg.start;
          } else if (seg.start < time) {
            removed += Math.max(0, time - seg.start);
            break;
          } else {
            break;
          }
        }
        return Math.max(0, time - removed);
      };
    }

    function shouldBreakSubtitleCue(lastIndex, currentText, cueStart, cueEnd, nextWord) {
      const len = compactTextLength(currentText);
      const duration = Math.max(0, cueEnd - cueStart);
      if (shouldParagraphBreakAfter(lastIndex)) return true;
      if (len >= 22) return true;
      if (duration >= 4.8 && len >= 10) return true;
      if (hasSentencePunctuation(currentText) && len >= 10) return true;
      if (nextWord) {
        const gap = Number(nextWord.start) - Number(WORDS[lastIndex]?.end);
        if (Number.isFinite(gap) && gap >= 0.9 && len >= 6) return true;
      }
      return false;
    }

    function compactTextLength(text) {
      return String(text || '').replace(/\s+/g, '').length;
    }

    function buildExportCues() {
      const deleteSegments = mergedSegmentsFromSelection();
      const mapTime = buildTimeMapper(deleteSegments);
      const kept = [];
      WORDS.forEach((w, i) => {
        if (!w || w.isGap || selected.has(i)) return;
        const start = Number(w.start);
        const end = Number(w.end);
        const text = getWordText(i).trim();
        if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
        kept.push({
          index: i,
          start,
          end,
          outStart: mapTime(start),
          outEnd: mapTime(end),
          text: text + (inferPunctuation(i) || ''),
        });
      });

      const cues = [];
      let current = null;
      for (let i = 0; i < kept.length; i += 1) {
        const item = kept[i];
        const next = kept[i + 1];
        if (!current) {
          current = {
            start: item.outStart,
            end: item.outEnd,
            text: '',
            lastIndex: item.index,
          };
        }
        current.text = appendSubtitleToken(current.text, item.text);
        current.end = Math.max(current.end, item.outEnd);
        current.lastIndex = item.index;
        if (shouldBreakSubtitleCue(item.index, current.text, current.start, current.end, next)) {
          if (current.text.trim()) {
            if (current.end <= current.start) current.end = current.start + 0.35;
            cues.push(current);
          }
          current = null;
        }
      }
      if (current && current.text.trim()) {
        if (current.end <= current.start) current.end = current.start + 0.35;
        cues.push(current);
      }
      return cues;
    }

    function buildSrtText(cues) {
      return cues.map((cue, index) => [
        String(index + 1),
        formatSrtTime(cue.start) + ' --> ' + formatSrtTime(Math.max(cue.end, cue.start + 0.35)),
        String(cue.text || '').trim(),
        '',
      ].join('\\n')).join('\\n');
    }

    function buildPlainText(cues) {
      const lines = [];
      for (const cue of cues) {
        const text = String(cue.text || '').trim();
        if (!text) continue;
        lines.push(text);
      }
      return lines.join('\\n');
    }

    function exportSubtitles(kind) {
      const cues = buildExportCues();
      if (!cues.length) {
        setExportStatus('没有可导出的字幕，请检查是否全部内容都被标记删除。');
        return;
      }
      if (kind === 'srt') {
        downloadTextFile(safeExportFileName('srt'), buildSrtText(cues));
        setExportStatus('已导出 SRT：' + cues.length + ' 条，可直接导入剪映。');
        return;
      }
      if (kind === 'txt') {
        downloadTextFile(safeExportFileName('txt'), buildPlainText(cues));
        setExportStatus('已导出 TXT 文案：' + cues.length + ' 段。');
      }
    }

    async function exportJianyingDraft() {
      const cues = buildExportCues();
      if (!cues.length) {
        setExportStatus('没有可导出的字幕，请检查是否全部内容都被标记删除。');
        return;
      }
      const templatePath = jianyingTemplatePathEl ? jianyingTemplatePathEl.value.trim() : '';
      const preset = jianyingSubtitlePresetEl ? jianyingSubtitlePresetEl.value : 'clean';
      setExportStatus('正在生成剪映草稿...');
      if (btnExportJianyingDraft) btnExportJianyingDraft.disabled = true;
      try {
        const response = await fetch('/api/export-jianying-draft', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cues: cues.map((cue) => ({
              start: cue.start,
              end: Math.max(cue.end, cue.start + 0.35),
              text: String(cue.text || '').trim(),
            })),
            preset,
            templatePath,
            draftName: 'JaygoCut_' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14),
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) {
          throw new Error(data.error || ('HTTP ' + response.status));
        }
        const message = '已导出剪映草稿：' + data.draftDir + '（字幕 ' + data.cues + ' 条' + (data.templateUsed ? '，已套用自定义模板' : '，内置样式') + '）';
        setExportStatus(message);
        alert(message + '\\n\\n提示：剪映 5.9 及以下通常可识别 JSON 草稿；剪映 6.x+ 可能因草稿加密无法直接打开。若无法打开，请使用 SRT 导入兜底。');
      } catch (err) {
        setExportStatus('剪映草稿导出失败：' + (err.message || String(err)));
        alert('剪映草稿导出失败：' + (err.message || String(err)));
      } finally {
        if (btnExportJianyingDraft) btnExportJianyingDraft.disabled = false;
      }
    }

    async function generateOneImage(index, retry = false) {
      const item = imageItems[index];
      if (!item) return;
      item.status = 'generating';
      item.error = '';
      renderImageCards();
      const response = await fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item,
          retry,
          imageSize: imageAspectEl ? imageAspectEl.value : '',
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        throw new Error(data.error || ('HTTP ' + response.status));
      }
      imageItems[index] = {
        ...item,
        ...(data.item || {}),
        image: data.image,
        status: 'done',
        error: '',
      };
      renderImageCards();
      scheduleReviewStateSave(200);
    }

    async function generateVideoImages() {
      if (imageGenerating) return;
      setImageGenerating(true);
      try {
        setImageStatus('正在让 LLM 分析文本并规划配图点...');
        imageItems = [];
        renderImageCards();
        const response = await fetch('/api/llm-image-plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            words: WORDS,
            selectedIndices: Array.from(selected),
            count: Number(imageCountEl ? imageCountEl.value : 8) || 8,
            style: imageStyleEl ? imageStyleEl.value : '',
            analysis: {
              topic: llmTopic,
              outline: llmOutline,
              multiSpeaker: llmMultiSpeaker,
            },
          }),
        });
        const plan = await response.json().catch(() => ({}));
        if (!response.ok || !plan.success) {
          throw new Error(plan.error || ('HTTP ' + response.status));
        }
        if (plan.topic && !llmTopic) llmTopic = String(plan.topic).slice(0, 80);
        if (plan.outline && !llmOutline) llmOutline = String(plan.outline).slice(0, 120);
        imageItems = (Array.isArray(plan.items) ? plan.items : []).map((item) => ({
          ...item,
          status: 'queued',
          image: null,
          error: '',
        }));
        renderImageCards();
        setImageStatus('已规划 ' + imageItems.length + ' 个配图点，开始逐张生成...');

        let ok = 0;
        for (let i = 0; i < imageItems.length; i += 1) {
          try {
            setImageStatus('正在生成第 ' + (i + 1) + '/' + imageItems.length + ' 张...');
            await generateOneImage(i, false);
            ok += 1;
          } catch (err) {
            imageItems[i].status = 'error';
            imageItems[i].error = err.message || String(err);
            renderImageCards();
          }
        }
        setImageStatus('配图生成完成：成功 ' + ok + ' 张，失败 ' + (imageItems.length - ok) + ' 张。失败项可单张重试。');
        scheduleReviewStateSave(200);
      } finally {
        setImageGenerating(false);
      }
    }

    async function generateOneVideoAsset(index, retry = false) {
      const item = videoItems[index];
      if (!item) return;
      item.status = 'generating';
      item.error = '';
      renderVideoAssetCards();
      const response = await fetch('/api/generate-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item,
          retry,
          aspectRatio: videoAssetAspectEl ? videoAssetAspectEl.value : item.aspectRatio,
          numFrames: 121,
          frameRate: 24,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        throw new Error(data.error || ('HTTP ' + response.status));
      }
      videoItems[index] = {
        ...item,
        ...(data.item || {}),
        video: data.video,
        status: 'done',
        error: '',
      };
      renderVideoAssetCards();
      scheduleReviewStateSave(200);
    }

    async function generateVideoAssets() {
      if (videoGenerating) return;
      setVideoGenerating(true);
      try {
        setVideoAssetStatus('正在让 LLM 规划视频素材插入点...');
        videoItems = [];
        renderVideoAssetCards();
        const response = await fetch('/api/llm-video-plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            words: WORDS,
            selectedIndices: Array.from(selected),
            count: Number(videoAssetCountEl ? videoAssetCountEl.value : 3) || 3,
            style: imageStyleEl ? imageStyleEl.value : '',
            aspectRatio: videoAssetAspectEl ? videoAssetAspectEl.value : '16:9',
            analysis: {
              topic: llmTopic,
              outline: llmOutline,
              multiSpeaker: llmMultiSpeaker,
            },
          }),
        });
        const plan = await response.json().catch(() => ({}));
        if (!response.ok || !plan.success) {
          throw new Error(plan.error || ('HTTP ' + response.status));
        }
        if (plan.topic && !llmTopic) llmTopic = String(plan.topic).slice(0, 80);
        if (plan.outline && !llmOutline) llmOutline = String(plan.outline).slice(0, 120);
        videoItems = (Array.isArray(plan.items) ? plan.items : []).map((item) => ({
          ...item,
          status: 'queued',
          video: null,
          error: '',
        }));
        renderVideoAssetCards();
        setVideoAssetStatus('已规划 ' + videoItems.length + ' 个视频素材点，开始逐段生成...');

        let ok = 0;
        for (let i = 0; i < videoItems.length; i += 1) {
          try {
            setVideoAssetStatus('正在生成第 ' + (i + 1) + '/' + videoItems.length + ' 段视频素材...');
            await generateOneVideoAsset(i, false);
            ok += 1;
          } catch (err) {
            videoItems[i].status = 'error';
            videoItems[i].error = err.message || String(err);
            renderVideoAssetCards();
          }
        }
        setVideoAssetStatus('视频素材生成完成：成功 ' + ok + ' 段，失败 ' + (videoItems.length - ok) + ' 段。失败项可单段重试。');
        scheduleReviewStateSave(200);
      } finally {
        setVideoGenerating(false);
      }
    }

    function formatClock(ts) {
      const d = ts ? new Date(ts) : new Date();
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      return hh + ':' + mm + ':' + ss;
    }

    function buildReviewStateCore() {
      const llmReasons = {};
      llmReasonByIndex.forEach((reason, idx) => {
        if (!llmSuggested.has(idx)) return;
        llmReasons[String(idx)] = String(reason || '').trim().slice(0, 200);
      });
      const llmPunctuation = {};
      llmPunctByIndex.forEach((punct, idx) => {
        if (!Number.isInteger(idx) || idx < 0 || idx >= WORDS.length) return;
        const value = String(punct || '').trim();
        if (/[，。！？；：]/.test(value)) {
          llmPunctuation[String(idx)] = value[0];
        }
      });

      return {
        version: 5,
        selectedIndices: Array.from(selected).sort((a, b) => a - b),
        llmSuggestedIndices: Array.from(llmSuggested).sort((a, b) => a - b),
        llmReasons,
        llmPunctuation,
        textOverrides: Object.fromEntries(Array.from(textOverrides.entries()).map(([idx, text]) => [String(idx), text])),
        llmParagraphAfterIndices: Array.from(llmParagraphAfterIndex)
          .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < WORDS.length)
          .sort((a, b) => a - b),
        llmTopic,
        llmOutline,
        llmMultiSpeaker,
        threshold: Math.max(0.2, Number(thresholdEl.value) || 0.2),
        boundarySettings: readBoundarySettings(),
        cutPrecisionMode: cutPrecisionModeEl ? String(cutPrecisionModeEl.value || 'standard') : 'standard',
        imageMotionEffect: currentImageMotionEffect(),
        currentTimeSec: Math.max(0, Number(audio.currentTime) || 0),
        mediaAssets: {
          images: imageItems,
          videos: videoItems,
        },
      };
    }

    async function saveReviewState(reason) {
      if (isRestoringReviewState) return;
      const core = buildReviewStateCore();
      const hash = JSON.stringify(core);
      if (reason !== 'force' && hash === lastStateHash) return;

      try {
        const r = await fetch('/api/review-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(core),
          keepalive: reason === 'unload',
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.success) {
          throw new Error(d.error || ('HTTP ' + r.status));
        }
        lastStateHash = hash;
        const savedAt = d.state && d.state.savedAt ? d.state.savedAt : new Date().toISOString();
        setDraftState('草稿状态：已保存（' + formatClock(savedAt) + '）');
      } catch (e) {
        setDraftState('草稿状态：保存失败（' + e.message + '）');
      }
    }

    function scheduleReviewStateSave(delayMs) {
      if (isRestoringReviewState) return;
      if (autosaveTimer) {
        clearTimeout(autosaveTimer);
        autosaveTimer = null;
      }
      autosaveTimer = setTimeout(() => {
        autosaveTimer = null;
        saveReviewState('auto').catch(() => {});
      }, Number.isFinite(Number(delayMs)) ? Number(delayMs) : 350);
    }

    async function restoreReviewState() {
      try {
        const r = await fetch('/api/review-state', { cache: 'no-store' });
        const d = await r.json().catch(() => ({}));
        const state = d && d.success ? d.state : null;
        if (!state) {
          setDraftState('草稿状态：暂无历史草稿');
          lastStateHash = JSON.stringify(buildReviewStateCore());
          return;
        }

        isRestoringReviewState = true;
        selected.clear();
        llmSuggested.clear();
        llmReasonByIndex.clear();
        llmPunctByIndex.clear();
        llmParagraphAfterIndex.clear();
        llmTopic = '';
        llmOutline = '';
        llmMultiSpeaker = false;
        replaceTextOverrideEntries([]);

        const stateVersion = Number(state.version) || 1;
        const isExplicitSelectionState = stateVersion >= 2;
        if (!isExplicitSelectionState) {
          // Backward-compat: legacy drafts may miss auto-rule defaults.
          AUTO.forEach((idxRaw) => {
            const idx = Number(idxRaw);
            if (Number.isInteger(idx) && idx >= 0 && idx < WORDS.length) {
              selected.add(idx);
            }
          });
        }

        const selectedIndices = Array.isArray(state.selectedIndices) ? state.selectedIndices : [];
        for (const idxRaw of selectedIndices) {
          const idx = Number(idxRaw);
          if (Number.isInteger(idx) && idx >= 0 && idx < WORDS.length) {
            selected.add(idx);
          }
        }

        const llmIndices = Array.isArray(state.llmSuggestedIndices) ? state.llmSuggestedIndices : [];
        for (const idxRaw of llmIndices) {
          const idx = Number(idxRaw);
          if (Number.isInteger(idx) && idx >= 0 && idx < WORDS.length) {
            llmSuggested.add(idx);
          }
        }

        if (state.llmReasons && typeof state.llmReasons === 'object') {
          for (const [k, v] of Object.entries(state.llmReasons)) {
            const idx = Number(k);
            if (!Number.isInteger(idx) || !llmSuggested.has(idx)) continue;
            const reason = toZhReason(v, '语义冗余，建议删除');
            llmReasonByIndex.set(idx, reason);
          }
        }
        if (state.llmPunctuation && typeof state.llmPunctuation === 'object') {
          for (const [k, v] of Object.entries(state.llmPunctuation)) {
            const idx = Number(k);
            const punct = String(v || '').trim();
            if (!Number.isInteger(idx) || idx < 0 || idx >= WORDS.length) continue;
            if (/[，。！？；：]/.test(punct)) {
              llmPunctByIndex.set(idx, punct[0]);
            }
          }
        }
        if (state.textOverrides && typeof state.textOverrides === 'object') {
          replaceTextOverrideEntries(Object.entries(state.textOverrides));
        }
        const paragraphAfter = Array.isArray(state.llmParagraphAfterIndices)
          ? state.llmParagraphAfterIndices
          : [];
        for (const idxRaw of paragraphAfter) {
          const idx = Number(idxRaw);
          if (Number.isInteger(idx) && idx >= 0 && idx < WORDS.length) {
            llmParagraphAfterIndex.add(idx);
          }
        }
        llmTopic = String(state.llmTopic || '').trim().slice(0, 80);
        llmOutline = String(state.llmOutline || '').trim().slice(0, 120);
        llmMultiSpeaker = !!state.llmMultiSpeaker;
        const restoredMedia = state.mediaAssets && typeof state.mediaAssets === 'object' ? state.mediaAssets : {};
        imageItems = Array.isArray(restoredMedia.images) ? restoredMedia.images : [];
        videoItems = Array.isArray(restoredMedia.videos) ? restoredMedia.videos : [];
        imageItems.forEach((item) => {
          if (item && item.image && item.status !== 'error') item.status = item.image.url ? 'done' : (item.status || 'queued');
        });
        videoItems.forEach((item) => {
          if (item && item.video && item.status !== 'error') item.status = item.video.url ? 'done' : (item.status || 'queued');
        });
        renderImageCards();
        renderVideoAssetCards();

        const threshold = Number(state.threshold);
        if (Number.isFinite(threshold) && threshold >= 0.2) {
          thresholdEl.value = threshold.toFixed(2);
        }
        if (state.boundarySettings && typeof state.boundarySettings === 'object') {
          applyBoundarySettings(state.boundarySettings);
        }
        if (cutPrecisionModeEl && ['conservative', 'standard', 'clean'].includes(String(state.cutPrecisionMode || ''))) {
          cutPrecisionModeEl.value = String(state.cutPrecisionMode);
        }
        if (imageMotionEffectEl && ['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down'].includes(String(state.imageMotionEffect || ''))) {
          imageMotionEffectEl.value = String(state.imageMotionEffect);
        }

        const resumeTime = Number(state.currentTimeSec);
        if (Number.isFinite(resumeTime) && resumeTime > 0) {
          if (Number.isFinite(audio.duration) && audio.duration > 0) {
            setPlaybackTime(Math.max(0, Math.min(audio.duration - 0.01, resumeTime)));
          } else {
            audio.addEventListener('loadedmetadata', () => {
              const maxT = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration - 0.01 : resumeTime;
              setPlaybackTime(Math.max(0, Math.min(maxT, resumeTime)));
            }, { once: true });
          }
        }

        render();
        updateSelectionStats();
        refreshLlmSummary();
        setStatus('已恢复上次审核草稿');
        setDraftState('草稿状态：已恢复（' + formatClock(state.savedAt) + '）');
        lastStateHash = JSON.stringify(buildReviewStateCore());
      } catch (e) {
        setDraftState('草稿状态：恢复失败（' + e.message + '）');
      } finally {
        isRestoringReviewState = false;
      }
    }

    function phaseLabel(phase) {
      const map = {
        idle: '空闲',
        queued: '排队中',
        preparing: '准备中',
        cutting: '执行中',
        finalizing: '收尾中',
        completed: '已完成',
        failed: '失败',
      };
      return map[phase] || String(phase || '-');
    }

    function formatElapsed(startedAt) {
      if (!startedAt) return '-';
      const diff = Math.max(0, Date.now() - new Date(startedAt).getTime());
      const sec = Math.floor(diff / 1000);
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return m > 0 ? (m + '分' + s + '秒') : (s + '秒');
    }

    function setLogs(lines) {
      latestCutLogTail = Array.isArray(lines) ? lines.slice(-40) : [];
      logsEl.textContent = (lines || []).join('\\n');
      logsEl.scrollTop = logsEl.scrollHeight;
    }

    function getAudioTotalDuration() {
      if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
      if (ends.length) return Math.max(...ends);
      return 0;
    }

    function setVideoPreviewStatus(text) {
      if (videoPreviewStatusEl) videoPreviewStatusEl.textContent = String(text || '');
    }

    function hasUsableVideoPreview() {
      return !!(sourceVideoEl && runtimeInfoCache && runtimeInfoCache.videoExists !== false);
    }

    function silenceVideoPreview() {
      if (!sourceVideoEl) return;
      try {
        sourceVideoEl.defaultMuted = true;
        sourceVideoEl.muted = true;
        if (sourceVideoEl.volume !== 0) sourceVideoEl.volume = 0;
      } catch {
        // Keep preview video visual-only; audio is always driven by the review audio element.
      }
    }

    function syncVideoPreview(force = false) {
      if (!videoPreviewEnabled || !hasUsableVideoPreview()) return;
      if (syncingAudioFromVideo && !force) return;
      silenceVideoPreview();
      const target = Math.max(0, Number(audio.currentTime) || 0);
      const current = Number(sourceVideoEl.currentTime) || 0;
      if (force || Math.abs(current - target) > 0.12) {
        syncingVideoFromAudio = true;
        try {
          const maxTime = Number.isFinite(sourceVideoEl.duration) && sourceVideoEl.duration > 0
            ? Math.max(0, sourceVideoEl.duration - 0.01)
            : target;
          sourceVideoEl.currentTime = Math.max(0, Math.min(maxTime, target));
        } catch {
          // Some codecs refuse seeking before metadata is ready; the next timeupdate will retry.
        }
        setTimeout(() => { syncingVideoFromAudio = false; }, 80);
      }
      if (audio.paused) {
        if (!sourceVideoEl.paused) sourceVideoEl.pause();
      } else if (sourceVideoEl.paused) {
        syncingVideoFromAudio = true;
        sourceVideoEl.play().catch(() => {
          setVideoPreviewStatus('视频等待手动播放');
        });
        setTimeout(() => { syncingVideoFromAudio = false; }, 80);
      }
      setVideoPreviewStatus('跟随 ' + formatWaveClock(target));
    }

    function setPlaybackTime(timeSec, options = {}) {
      const total = getAudioTotalDuration();
      const maxTarget = total > 0 ? Math.max(0, total - 0.01) : Number.POSITIVE_INFINITY;
      const target = Math.max(0, Math.min(maxTarget, Number(timeSec) || 0));
      audio.currentTime = target;
      syncVideoPreview(options.forceVideo !== false);
      return target;
    }

    function cancelSkipFade() {
      if (skipFadeRaf) {
        cancelAnimationFrame(skipFadeRaf);
        skipFadeRaf = null;
      }
      if (skipFadeTimer) {
        clearTimeout(skipFadeTimer);
        skipFadeTimer = null;
      }
    }

    function smoothSkipTo(targetTime) {
      const target = Math.max(0, Number(targetTime) || 0);
      const originalVolume = Math.max(0, Math.min(1, Number(audio.volume)));
      if (audio.paused || audio.muted || originalVolume <= 0.02) {
        return setPlaybackTime(target);
      }

      cancelSkipFade();
      audio.volume = Math.max(0, originalVolume * 0.16);
      skipFadeTimer = setTimeout(() => {
        skipFadeTimer = null;
        setPlaybackTime(target);
        const startVolume = Math.max(0, Math.min(1, Number(audio.volume)));
        const startedAt = performance.now();
        const fadeMs = 42;
        const step = (now) => {
          const ratio = Math.min(1, Math.max(0, (now - startedAt) / fadeMs));
          audio.volume = startVolume + (originalVolume - startVolume) * ratio;
          if (ratio < 1 && !audio.paused) {
            skipFadeRaf = requestAnimationFrame(step);
          } else {
            audio.volume = originalVolume;
            skipFadeRaf = null;
          }
        };
        skipFadeRaf = requestAnimationFrame(step);
      }, 18);
      return target;
    }

    function setVideoPreviewVisible(next) {
      videoPreviewEnabled = !!next && hasUsableVideoPreview();
      if (videoPreviewPanelEl) videoPreviewPanelEl.hidden = !videoPreviewEnabled;
      if (toolbarCardEl) toolbarCardEl.classList.toggle('video-preview-visible', videoPreviewEnabled);
      if (btnToggleVideoPreview) {
        btnToggleVideoPreview.textContent = videoPreviewEnabled ? '隐藏视频' : '视频预览';
        btnToggleVideoPreview.disabled = runtimeInfoCache && runtimeInfoCache.videoExists === false;
      }
      try {
        localStorage.setItem(VIDEO_PREVIEW_STORAGE_KEY, videoPreviewEnabled ? '1' : '0');
      } catch {
        // Display preference only.
      }
      if (videoPreviewEnabled) {
        silenceVideoPreview();
        syncVideoPreview(true);
      } else if (sourceVideoEl && !sourceVideoEl.paused) {
        sourceVideoEl.pause();
      }
    }

    function toggleVideoPreview() {
      if (runtimeInfoCache && runtimeInfoCache.videoExists === false) {
        setStatus(runtimeInfoCache.videoMissingMessage || '原视频缺失，无法预览视频');
        return;
      }
      setVideoPreviewVisible(!videoPreviewEnabled);
    }

    function formatSec(sec) {
      const n = Math.max(0, Number(sec) || 0);
      return n.toFixed(2) + 's';
    }

    function tokenOverlapsSegment(index, seg) {
      if (!seg) return false;
      const w = WORDS[index];
      if (!w) return false;
      const start = Number(w.start);
      const end = Number(w.end);
      return Number.isFinite(start) && Number.isFinite(end) && end > seg.start && start < seg.end;
    }

    function setWaveHint(text) {
      if (!waveHintEl) return;
      waveHintEl.textContent = String(text || '');
      waveHintEl.style.display = text ? 'block' : 'none';
    }

    function formatWaveClock(sec) {
      const t = Math.max(0, Number(sec) || 0);
      const m = Math.floor(t / 60);
      const s = Math.floor(t % 60);
      return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }

    function setWaveZoom(nextZoom, anchorTime) {
      const z = Math.max(1, Math.min(8, Number(nextZoom) || 1));
      waveZoom = z;
      const duration = getWaveDuration();
      const anchor = Number(anchorTime);
      if (Number.isFinite(anchor) && duration > 0) {
        waveViewCenterSec = Math.max(0, Math.min(duration, anchor));
      } else if (duration > 0) {
        waveViewCenterSec = Math.max(0, Math.min(duration, Number(audio.currentTime) || 0));
      }
      if (waveZoomEl) waveZoomEl.value = String(z);
      if (waveZoomTextEl) waveZoomTextEl.textContent = z.toFixed(1) + 'x';
      waveStaticKey = '';
      drawWaveform();
    }

    function getWaveDuration() {
      return (Number(waveDurationSec) > 0 ? Number(waveDurationSec) : getAudioTotalDuration());
    }

    function getWaveViewWindow() {
      const duration = getWaveDuration();
      if (!(duration > 0)) return { start: 0, end: 0, duration: 0 };
      const z = Math.max(1, Number(waveZoom) || 1);
      const span = Math.max(0.2, duration / z);
      if (span >= duration) return { start: 0, end: duration, duration };
      if (!Number.isFinite(waveViewCenterSec) || waveViewCenterSec <= 0) {
        waveViewCenterSec = Math.max(0, Math.min(duration, Number(audio.currentTime) || 0));
      }
      const playTime = Math.max(0, Math.min(duration, Number(audio.currentTime) || 0));
      let center = Math.max(0, Math.min(duration, waveViewCenterSec));
      let start = center - (span / 2);
      if (start < 0) start = 0;
      if (start + span > duration) start = duration - span;
      let end = Math.min(duration, start + span);

      if (!audio.paused) {
        const margin = Math.max(0.3, span * 0.18);
        if (playTime < start + margin) {
          center = playTime + (span * 0.32);
        } else if (playTime > end - margin) {
          center = playTime - (span * 0.32);
        }
        waveViewCenterSec = Math.max(0, Math.min(duration, center));
      }

      center = Math.max(0, Math.min(duration, waveViewCenterSec));
      start = center - (span / 2);
      if (start < 0) start = 0;
      if (start + span > duration) start = duration - span;
      end = Math.min(duration, start + span);
      return { start, end, duration };
    }

    function ensureWaveCanvasSize() {
      if (!waveCanvas) return;
      const ratio = Math.max(1, Number(window.devicePixelRatio) || 1);
      const rect = waveCanvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width * ratio));
      const height = Math.max(1, Math.floor(rect.height * ratio));
      if (waveCanvas.width !== width || waveCanvas.height !== height) {
        waveCanvas.width = width;
        waveCanvas.height = height;
        waveStaticKey = '';
      }
    }

    function buildWavePeaks(samples, count) {
      if (!samples || !samples.length || !Number.isFinite(count) || count <= 0) return [];
      const peaks = new Array(count);
      const step = Math.max(1, Math.floor(samples.length / count));
      for (let i = 0; i < count; i += 1) {
        const start = i * step;
        const end = Math.min(samples.length, start + step);
        let max = 0;
        let sumSq = 0;
        let n = 0;
        for (let j = start; j < end; j += 1) {
          const v = Math.abs(samples[j]);
          if (v > max) max = v;
          sumSq += v * v;
          n += 1;
        }
        const rms = n > 0 ? Math.sqrt(sumSq / n) : 0;
        peaks[i] = Math.min(1, max * 0.62 + rms * 0.38);
      }
      return peaks;
    }

    async function loadWaveform() {
      if (!waveCanvas) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        setWaveHint('当前环境不支持波形');
        return;
      }
      try {
        setWaveHint('波形加载中...');
        ensureWaveCanvasSize();
        const src = audio.currentSrc || audio.src;
        if (!src) {
          setWaveHint('未找到音频源');
          return;
        }
        const res = await fetch(src);
        if (!res.ok) throw new Error('音频读取失败');
        const arr = await res.arrayBuffer();
        const ac = new Ctx();
        const decoded = await ac.decodeAudioData(arr.slice(0));
        const channel = decoded.numberOfChannels > 0 ? decoded.getChannelData(0) : null;
        const seconds = Number(decoded.duration) || 0;
        const binsBase = Math.max(
          8192,
          Math.floor((waveCanvas.clientWidth || 900) * 10),
          Math.floor(seconds * 80),
        );
        const bins = Math.min(channel ? channel.length : binsBase, Math.min(65536, binsBase));
        wavePeaks = buildWavePeaks(channel, bins);
        waveDurationSec = Number(decoded.duration) || getAudioTotalDuration();
        waveReady = Array.isArray(wavePeaks) && wavePeaks.length > 0;
        setWaveHint(waveReady ? '' : '波形不可用');
        drawWaveform();
        if (typeof ac.close === 'function') {
          ac.close().catch(() => {});
        }
      } catch (e) {
        waveReady = false;
        setWaveHint('波形加载失败');
      }
    }

    function sampleWaveAmp(norm) {
      if (!wavePeaks || !wavePeaks.length) return 0;
      const n = wavePeaks.length;
      const t = Math.max(0, Math.min(1, norm || 0)) * (n - 1);
      const i0 = Math.floor(t);
      const i1 = Math.min(n - 1, i0 + 1);
      const frac = t - i0;
      return (wavePeaks[i0] * (1 - frac)) + (wavePeaks[i1] * frac);
    }

    function getWaveSelectionKey(view) {
      if (!(view.duration > 0) || !mergedSelected.length) return 'none';
      return mergedSelected
        .map((seg) => {
          const left = Math.max(seg.start, view.start);
          const right = Math.min(seg.end, view.end);
          if (right <= left) return '';
          return left.toFixed(3) + '-' + right.toFixed(3);
        })
        .filter(Boolean)
        .join('|') || 'none';
    }

    function drawWaveform() {
      if (!waveCanvas) return;
      ensureWaveCanvasSize();
      const ctx = waveCanvas.getContext('2d');
      if (!ctx) return;

      const w = waveCanvas.width;
      const h = waveCanvas.height;
      const styles = window.getComputedStyle(document.documentElement);
      const lineColor = (styles.getPropertyValue('--text-muted') || '#64748b').trim();
      const playheadColor = (styles.getPropertyValue('--btn-primary-bg') || '#0f766e').trim();
      const waveBarColor = (styles.getPropertyValue('--accent') || '#d6b45d').trim();
      const wavePeakColor = (styles.getPropertyValue('--btn-primary-bg') || '#0f766e').trim();
      const selectionColor = 'rgba(220, 38, 38, 0.22)';
      const view = getWaveViewWindow();
      const selectionKey = getWaveSelectionKey(view);
      const staticKey = [w, h, waveReady ? 'ready' : 'empty', waveZoom.toFixed(3), view.start.toFixed(3), view.end.toFixed(3), selectionKey].join(':');

      if (!waveStaticCanvas || waveStaticCanvas.width !== w || waveStaticCanvas.height !== h) {
        waveStaticCanvas = document.createElement('canvas');
        waveStaticCanvas.width = w;
        waveStaticCanvas.height = h;
        waveStaticKey = '';
      }

      if (waveStaticKey !== staticKey) {
        const sctx = waveStaticCanvas.getContext('2d');
        sctx.clearRect(0, 0, w, h);

        if (waveReady && wavePeaks && wavePeaks.length) {
          const mid = h / 2;
          const px = Math.max(1, Math.floor(w));
          const span = Math.max(0.001, view.end - view.start);
          const amps = new Array(px);
          const smoothStep = 0.35 / Math.max(1, px);
          for (let x = 0; x < px; x += 1) {
            const t = view.start + (x / px) * span;
            const norm = t / Math.max(0.001, view.duration);
            const amp =
              sampleWaveAmp(norm - smoothStep) * 0.25
              + sampleWaveAmp(norm) * 0.5
              + sampleWaveAmp(norm + smoothStep) * 0.25;
            amps[x] = Math.max(0.01, Math.min(1, amp));
          }

          const half = h * 0.42;
          const dpr = window.devicePixelRatio || 1;
          const barStep = Math.max(2, Math.floor(dpr * 2));
          sctx.strokeStyle = lineColor || '#64748b';
          sctx.globalAlpha = 0.28;
          sctx.lineWidth = Math.max(1, Math.floor(dpr));
          sctx.beginPath();
          sctx.moveTo(0, mid);
          sctx.lineTo(w, mid);
          sctx.stroke();
          sctx.globalAlpha = 1;

          sctx.lineCap = 'round';
          sctx.lineWidth = Math.max(1, barStep * 0.62);
          for (let x = 0; x < px; x += barStep) {
            let amp = 0;
            for (let k = 0; k < barStep && x + k < px; k += 1) {
              amp = Math.max(amp, amps[x + k]);
            }
            const y0 = mid - (amp * half);
            const y1 = mid + (amp * half);
            sctx.strokeStyle = amp > 0.55 ? (wavePeakColor || '#0f766e') : (waveBarColor || '#d6b45d');
            sctx.globalAlpha = amp > 0.55 ? 0.82 : 0.62;
            sctx.beginPath();
            sctx.moveTo(x + 0.5, y0);
            sctx.lineTo(x + 0.5, y1);
            sctx.stroke();
          }
          sctx.globalAlpha = 1;
          sctx.lineCap = 'butt';
        } else {
          sctx.fillStyle = 'rgba(100,116,139,0.35)';
          sctx.fillRect(0, Math.floor(h / 2) - 1, w, 2);
        }

        if (view.duration > 0 && mergedSelected.length) {
          for (const seg of mergedSelected) {
            const left = Math.max(seg.start, view.start);
            const right = Math.min(seg.end, view.end);
            if (right <= left) continue;
            const x0 = Math.max(0, Math.min(w, ((left - view.start) / (view.end - view.start)) * w));
            const x1 = Math.max(0, Math.min(w, ((right - view.start) / (view.end - view.start)) * w));
            if (x1 > x0) {
              sctx.fillStyle = selectionColor;
              sctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
            }
          }
        }
        waveStaticKey = staticKey;
      }

      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(waveStaticCanvas, 0, 0);

      if (view.duration > 0 && previewSegment) {
        const left = Math.max(previewSegment.start, view.start);
        const right = Math.min(previewSegment.end, view.end);
        if (right > left) {
          const x0 = Math.max(0, Math.min(w, ((left - view.start) / (view.end - view.start)) * w));
          const x1 = Math.max(0, Math.min(w, ((right - view.start) / (view.end - view.start)) * w));
          ctx.fillStyle = 'rgba(245, 158, 11, 0.28)';
          ctx.fillRect(x0, 0, Math.max(2, x1 - x0), h);
        }
      }

      if (view.duration > 0) {
        const t = Math.max(view.start, Math.min(view.end, Number(audio.currentTime) || 0));
        const x = ((t - view.start) / Math.max(0.001, view.end - view.start)) * w;
        ctx.strokeStyle = playheadColor || '#0f766e';
        ctx.lineWidth = Math.max(1.5, Math.floor((window.devicePixelRatio || 1)));
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      if (view.duration > 0) {
        setWaveHint(
          'Zoom ' + waveZoom.toFixed(1) + 'x'
          + ' | ' + formatWaveClock(view.start) + ' - ' + formatWaveClock(view.end),
        );
      } else {
        setWaveHint('Waveform loading...');
      }
    }

    function updateSelectionStats() {
      mergedSelected = mergedSegmentsFromSelection();
      const deletedSec = mergedSelected.reduce((sum, seg) => sum + Math.max(0, seg.end - seg.start), 0);
      const totalSec = getAudioTotalDuration();
      const outputSec = Math.max(0, totalSec - deletedSec);
      selectionStatsEl.textContent =
        '已选删除: ' + mergedSelected.length + ' 段'
        + ' | 删除时长: ' + deletedSec.toFixed(2) + ' 秒'
        + ' | 预计成片: ' + outputSec.toFixed(2) + ' 秒'
        + ' | 原时长: ' + totalSec.toFixed(2) + ' 秒';
      drawWaveform();
    }

    function refreshLlmSummary(extraText) {
      const ruleMarked = AUTO.length;
      const count = llmSuggested.size;
      if (extraText) {
        llmSummaryEl.textContent = extraText;
        return;
      }

      let selectedByRule = 0;
      AUTO.forEach((idx) => {
        if (selected.has(idx)) selectedByRule += 1;
      });

      let selectedByLlm = 0;
      llmSuggested.forEach((idx) => {
        if (selected.has(idx)) selectedByLlm += 1;
      });

      const parts = [
        '规则预标记: ' + ruleMarked + ' 项（已应用 ' + selectedByRule + ' 项）',
        'LLM建议: ' + count + ' 项（已应用 ' + selectedByLlm + ' 项）',
      ];
      if (llmTopic) {
        parts.push('主题: ' + llmTopic);
      }
      if (llmOutline) {
        parts.push('梗概: ' + llmOutline);
      }
      if (llmMultiSpeaker) {
        parts.push('检测到多人对话');
      }
      if (AUTO_STATS && Object.keys(AUTO_STATS).length) {
        parts.push(
          '规则明细: 停顿 ' + Number(AUTO_STATS.silenceCount || 0)
          + ' / 语气词 ' + Number(AUTO_STATS.fillerCount || 0)
          + ' / 重复句 ' + Number(AUTO_STATS.repeatCount || 0),
        );
      }
      llmSummaryEl.textContent = parts.join(' | ');
    }

    function hasSentencePunctuation(text) {
      return /[，。！？；：,.!?;:]$/.test(String(text || ''));
    }

    function getNextGapDuration(i) {
      const next = WORDS[i + 1];
      if (!next || !next.isGap) return 0;
      const d = Number(next.end) - Number(next.start);
      return Number.isFinite(d) && d > 0 ? d : 0;
    }

    function inferPunctuation(i) {
      const w = WORDS[i];
      if (!w || w.isGap) return '';
      const text = getWordText(i).trim();
      if (!text || hasSentencePunctuation(text)) return '';
      if (llmPunctByIndex.has(i)) {
        return llmPunctByIndex.get(i) || '';
      }
      const gap = getNextGapDuration(i);
      if (gap >= punctProfile.sentence) {
        if (/[吗么呢嘛]$/.test(text)) return '？';
        return '。';
      }
      if (gap >= punctProfile.comma) return '，';
      return '';
    }

    function shouldParagraphBreakAfter(i) {
      const w = WORDS[i];
      if (!w || w.isGap) return false;
      if (llmParagraphAfterIndex.has(i)) return true;
      return getNextGapDuration(i) >= punctProfile.paragraph;
    }

    function setTokenDisplay(el, i) {
      const w = WORDS[i] || {};
      if (w.isGap) {
        const d = Math.max(0, Number(w.end) - Number(w.start));
        el.textContent = '[' + d.toFixed(2) + 's]';
        return;
      }
      const word = document.createElement('span');
      word.textContent = getWordText(i);
      el.appendChild(word);
      const punct = inferPunctuation(i);
      if (!punct) return;
      const punctEl = document.createElement('span');
      punctEl.className = 'punct';
      punctEl.textContent = punct;
      el.appendChild(punctEl);
    }

    function tokenAutoCategory(i) {
      if (!autoSet.has(i)) return null;
      const reason = autoReasonByIndex.get(i);
      const w = WORDS[i] || {};
      return reasonCategory(reason, !!w.isGap) || 'silence';
    }

    function tokenAutoClass(i) {
      const cat = tokenAutoCategory(i);
      if (!cat) return '';
      if (cat === 'filler') return ' auto auto-filler';
      if (cat === 'repeat') return ' auto auto-repeat';
      return ' auto auto-silence';
    }

    function tokenMarkerClass(i) {
      const classes = [];
      const autoCat = tokenAutoCategory(i);
      if (autoCat) classes.push(' mark-' + autoCat);
      if (llmSuggested.has(i)) classes.push(' mark-llm');
      return classes.length ? (' ' + classes.join(' ')) : '';
    }

    function tokenClass(i) {
      const w = WORDS[i];
      return 'token'
        + (w.isGap ? ' gap' : '')
        + (selected.has(i) ? ' sel' : '')
        + (tokenOverlapsSegment(i, previewSegment) ? ' preview-delete' : '')
        + tokenAutoClass(i)
        + tokenMarkerClass(i)
        + (llmSuggested.has(i) ? ' llm' : '')
        + (searchHitIndices.has(i) ? ' search-hit' : '')
        + (searchActiveIndices.has(i) ? ' search-active' : '')
        + (!w.isGap && !getWordText(i) ? ' text-empty' : '')
        + (currentIndex === i ? ' current' : '');
    }

    function tokenTitle(i) {
      const w = WORDS[i] || {};
      const base = i + ' | ' + Number(w.start || 0).toFixed(3) + ' - ' + Number(w.end || 0).toFixed(3);
      const parts = [base];
      const autoReason = autoReasonByIndex.get(i);
      const llmReason = llmReasonByIndex.get(i);
      if (autoReason) parts.push('规则: ' + autoReason);
      if (llmReason) parts.push('LLM建议: ' + llmReason);
      return parts.join(' | ');
    }

    function refreshToken(i) {
      if (!Number.isInteger(i) || i < 0 || i >= tokenEls.length) return;
      const el = tokenEls[i];
      if (!el) return;
      el.className = tokenClass(i);
      el.title = tokenTitle(i);
      el.textContent = '';
      setTokenDisplay(el, i);
    }

    function refreshIdleStatus() {
      if (isCutRunning || cutSubmitting) return;
      setStatus('当前选择: ' + selected.size + ' 段');
      updateSelectionStats();
      refreshLlmSummary();
    }

    function render() {
      content.innerHTML = '';
      tokenEls = new Array(WORDS.length);
      WORDS.forEach((w, i) => {
        const el = document.createElement('span');
        el.dataset.idx = String(i);
        el.className = tokenClass(i);
        setTokenDisplay(el, i);
        el.title = tokenTitle(i);
        tokenEls[i] = el;
        content.appendChild(el);
        if (shouldParagraphBreakAfter(i)) {
          const br = document.createElement('span');
          br.className = 'paragraph-break';
          br.setAttribute('aria-hidden', 'true');
          content.appendChild(br);
        }
      });
      rebuildTokenRects();
      refreshIdleStatus();
    }

    function getTokenIndex(target) {
      const token = target && target.closest ? target.closest('.token[data-idx]') : null;
      if (!token) return null;
      const idx = Number(token.dataset.idx);
      return Number.isInteger(idx) ? idx : null;
    }

    function setCutSubmitting(next) {
      cutSubmitting = !!next;
      const videoMissing = runtimeInfoCache && runtimeInfoCache.videoExists === false;
      btnCut.disabled = cutSubmitting || videoMissing;
      btnCut.textContent = cutSubmitting ? '裁剪中...' : '执行裁剪';
    }

    function setLlmMarking(next) {
      llmMarking = !!next;
      btnLlmMark.disabled = llmMarking;
      btnLlmMark.textContent = llmMarking ? 'LLM分析中...' : 'LLM标记';
    }

    function rebuildTokenRects() {
      tokenRects = tokenEls.map((el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
        };
      });
    }

    function getNearestTokenIndexByPoint(clientX, clientY) {
      const x = Number(clientX) || 0;
      const y = Number(clientY) || 0;
      let bestIdx = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < tokenRects.length; i += 1) {
        const r = tokenRects[i];
        if (!r) continue;
        const dx = x < r.left ? (r.left - x) : (x > r.right ? (x - r.right) : 0);
        const dy = y < r.top ? (r.top - y) : (y > r.bottom ? (y - r.bottom) : 0);
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDist) {
          bestDist = d2;
          bestIdx = i;
          if (d2 <= 9) break;
        }
      }
      if (!Number.isFinite(bestDist) || bestIdx === null) return null;
      return bestDist <= 42 * 42 ? bestIdx : null;
    }

    function resolveTokenIndexFromPointer(clientX, clientY) {
      const hit = document.elementFromPoint(clientX, clientY);
      const direct = getTokenIndex(hit);
      if (direct !== null) return direct;
      return getNearestTokenIndexByPoint(clientX, clientY);
    }

    function beginDrag(mode, startIdx) {
      pushSelectionUndo();
      isDragging = true;
      dragMode = mode;
      dragVisited = new Set();
      lastDragIdx = startIdx;
      dragBaseSelected = new Set(selected);
      dragPreviewStart = null;
      dragPreviewEnd = null;
      document.body.classList.add('dragging');
      applyDragPreviewRange(startIdx, startIdx);
    }

    function refreshTokenRange(start, end) {
      if (!Number.isInteger(start) || !Number.isInteger(end)) return;
      const lo = Math.max(0, Math.min(start, end));
      const hi = Math.min(WORDS.length - 1, Math.max(start, end));
      for (let i = lo; i <= hi; i += 1) refreshToken(i);
    }

    function setReplaceStatus(text) {
      if (!replaceStatusEl) return;
      replaceStatusEl.textContent = String(text || '');
    }

    function buildSearchMatches(query) {
      const needle = String(query || '').trim();
      if (!needle) return [];
      let haystack = '';
      const charToIndex = [];
      for (let i = 0; i < WORDS.length; i += 1) {
        const w = WORDS[i];
        if (!w || w.isGap) continue;
        const text = getWordText(i);
        if (!text) continue;
        for (const ch of text) {
          haystack += ch;
          charToIndex.push(i);
        }
      }
      const matches = [];
      let pos = haystack.indexOf(needle);
      while (pos >= 0) {
        const startIdx = charToIndex[pos];
        const endIdx = charToIndex[pos + needle.length - 1];
        if (Number.isInteger(startIdx) && Number.isInteger(endIdx)) {
          matches.push({ start: Math.min(startIdx, endIdx), end: Math.max(startIdx, endIdx) });
        }
        pos = haystack.indexOf(needle, pos + Math.max(1, needle.length));
      }
      return matches;
    }

    function applySearchHighlights() {
      searchHitIndices = new Set();
      searchActiveIndices = new Set();
      searchMatches.forEach((match, matchIndex) => {
        const target = matchIndex === activeSearchMatch ? searchActiveIndices : searchHitIndices;
        for (let i = match.start; i <= match.end; i += 1) target.add(i);
      });
      render();
    }

    function refreshSearchMatches(keepActive) {
      const query = replaceFindTextEl ? replaceFindTextEl.value : '';
      const previousStart = searchMatches[activeSearchMatch]?.start;
      searchMatches = buildSearchMatches(query);
      if (!searchMatches.length) {
        activeSearchMatch = -1;
        applySearchHighlights();
        setReplaceStatus(query ? '未找到匹配项' : '');
        return;
      }
      if (keepActive && Number.isInteger(previousStart)) {
        const found = searchMatches.findIndex((match) => match.start >= previousStart);
        activeSearchMatch = found >= 0 ? found : 0;
      } else if (activeSearchMatch < 0 || activeSearchMatch >= searchMatches.length) {
        activeSearchMatch = 0;
      }
      applySearchHighlights();
      setReplaceStatus('找到 ' + searchMatches.length + ' 处，当前第 ' + (activeSearchMatch + 1) + ' 处');
    }

    function scrollActiveSearchMatch() {
      const match = searchMatches[activeSearchMatch];
      if (!match || !tokenEls[match.start]) return;
      tokenEls[match.start].scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }

    function jumpSearchMatch(delta) {
      refreshSearchMatches(true);
      if (!searchMatches.length) return false;
      const count = searchMatches.length;
      activeSearchMatch = (activeSearchMatch + delta + count) % count;
      applySearchHighlights();
      setReplaceStatus('找到 ' + count + ' 处，当前第 ' + (activeSearchMatch + 1) + ' 处');
      scrollActiveSearchMatch();
      return true;
    }

    function replacementCharacters(match, replacement) {
      const value = String(replacement || '');
      const chars = Array.from(value);
      const indices = [];
      for (let i = match.start; i <= match.end; i += 1) {
        if (WORDS[i] && !WORDS[i].isGap) indices.push(i);
      }
      return { chars, indices };
    }

    function applyReplacementToMatch(match, replacement) {
      if (!match) return 0;
      const { chars, indices } = replacementCharacters(match, replacement);
      if (!indices.length) return 0;
      if (chars.length <= indices.length) {
        indices.forEach((idx, offset) => setWordText(idx, chars[offset] || ''));
      } else {
        setWordText(indices[0], chars.join(''));
        for (let i = 1; i < indices.length; i += 1) setWordText(indices[i], '');
      }
      return 1;
    }

    function replaceActiveMatch() {
      refreshSearchMatches(true);
      const match = searchMatches[activeSearchMatch];
      if (!match) return false;
      pushSelectionUndo();
      const count = applyReplacementToMatch(match, replaceWithTextEl ? replaceWithTextEl.value : '');
      refreshSearchMatches(false);
      setReplaceStatus(count ? '已替换当前匹配项' : '没有可替换内容');
      scheduleReviewStateSave(150);
      return !!count;
    }

    function replaceAllMatches() {
      refreshSearchMatches(false);
      if (!searchMatches.length) return false;
      pushSelectionUndo();
      const replacement = replaceWithTextEl ? replaceWithTextEl.value : '';
      let count = 0;
      for (let i = searchMatches.length - 1; i >= 0; i -= 1) {
        count += applyReplacementToMatch(searchMatches[i], replacement);
      }
      refreshSearchMatches(false);
      setReplaceStatus('已替换 ' + count + ' 处');
      scheduleReviewStateSave(150);
      return count > 0;
    }

    function glossaryEntries() {
      return (Array.isArray(TERM_GLOSSARY) ? TERM_GLOSSARY : [])
        .filter((item) => item && item.from && item.to && item.from !== item.to);
    }

    function refreshGlossarySummary() {
      const count = glossaryEntries().length;
      if (glossarySummaryEl) {
        glossarySummaryEl.textContent = count ? ('词库 ' + count + ' 条') : '未配置词库';
      }
      if (btnApplyGlossary) btnApplyGlossary.disabled = count === 0;
    }

    function applyGlossaryCorrections() {
      const entries = glossaryEntries();
      if (!entries.length) {
        setReplaceStatus('请先在主界面设置专有名词词库');
        return false;
      }
      let count = 0;
      let pushedUndo = false;
      for (const entry of entries) {
        const matches = buildSearchMatches(entry.from);
        if (!matches.length) continue;
        if (!pushedUndo) {
          pushSelectionUndo();
          pushedUndo = true;
        }
        for (let i = matches.length - 1; i >= 0; i -= 1) {
          count += applyReplacementToMatch(matches[i], entry.to);
        }
      }
      refreshSearchMatches(false);
      if (count > 0) {
        setReplaceStatus('已按词库纠错 ' + count + ' 处');
        scheduleReviewStateSave(150);
      } else {
        setReplaceStatus('词库没有匹配到可纠错内容');
      }
      return count > 0;
    }

    function applyFocusReviewMode(enabled) {
      const next = !!enabled;
      document.body.classList.toggle('review-focus-mode', next);
      if (btnFocusReview) btnFocusReview.textContent = next ? '退出专注' : '专注审核';
      try {
        localStorage.setItem(FOCUS_REVIEW_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // Ignore localStorage failures; focus mode is a display preference only.
      }
    }

    function toggleFocusReviewMode() {
      applyFocusReviewMode(!document.body.classList.contains('review-focus-mode'));
    }

    function openShortcutHelp() {
      if (shortcutHelpEl) shortcutHelpEl.hidden = false;
    }

    function closeShortcutHelp() {
      if (shortcutHelpEl) shortcutHelpEl.hidden = true;
    }

    function restoreDragBaseSelection() {
      if (!dragBaseSelected) return;
      selected.clear();
      dragBaseSelected.forEach((idx) => selected.add(idx));
    }

    function applyDragPreviewRange(a, b) {
      if (!Number.isInteger(a) || !Number.isInteger(b) || !dragBaseSelected) return;
      const start = Math.max(0, Math.min(a, b));
      const end = Math.min(WORDS.length - 1, Math.max(a, b));
      const oldStart = dragPreviewStart;
      const oldEnd = dragPreviewEnd;

      restoreDragBaseSelection();
      for (let i = start; i <= end; i += 1) {
        if (dragMode === 'remove') selected.delete(i);
        else selected.add(i);
      }
      dragPreviewStart = start;
      dragPreviewEnd = end;

      if (Number.isInteger(oldStart) && Number.isInteger(oldEnd)) {
        refreshTokenRange(Math.min(oldStart, start), Math.max(oldEnd, end));
      } else {
        refreshTokenRange(start, end);
      }
      updateSelectionStats();
    }

    function applyDragToIndex(i) {
      if (!Number.isInteger(i) || i < 0 || i >= WORDS.length) return;
      applyDragPreviewRange(pointerDownIdx, i);
      lastDragIdx = i;
    }

    function maybeAutoScrollDuringDrag(clientY) {
      if (!contentViewportEl) return;
      const now = Date.now();
      if (now - lastDragAutoScrollAt < 70) return;
      const edge = 56;
      const vr = contentViewportEl.getBoundingClientRect();
      let delta = 0;
      if (clientY < vr.top + edge) {
        const intensity = Math.min(1, Math.max(0, (vr.top + edge - clientY) / edge));
        delta = -Math.max(3, Math.round(18 * intensity));
      } else if (clientY > vr.bottom - edge) {
        const intensity = Math.min(1, Math.max(0, (clientY - (vr.bottom - edge)) / edge));
        delta = Math.max(3, Math.round(18 * intensity));
      }
      if (!delta) return;
      contentViewportEl.scrollTop += delta;
      lastDragAutoScrollAt = now;
      rebuildTokenRects();
    }

    function clearPointerState() {
      isPointerDown = false;
      pointerDownIdx = null;
      pointerDownX = 0;
      pointerDownY = 0;
    }

    function endDrag() {
      if (!isDragging) return false;
      isDragging = false;
      dragVisited = new Set();
      lastDragIdx = null;
      dragBaseSelected = null;
      dragPreviewStart = null;
      dragPreviewEnd = null;
      document.body.classList.remove('dragging');
      refreshIdleStatus();
      scheduleReviewStateSave(250);
      return true;
    }

    function seekToToken(i) {
      if (!Number.isInteger(i) || i < 0 || i >= WORDS.length) return;
      const start = Number(WORDS[i]?.start);
      const end = Number(WORDS[i]?.end);
      if (Number.isFinite(start)) {
        let target = start;
        if (!WORDS[i]?.isGap && Number.isFinite(end) && end > start) {
          target = start + Math.min(0.08, Math.max(0.015, (end - start) / 2));
        }
        setPlaybackTime(Math.max(0, target));
        setCurrentIndex(i);
        drawWaveform();
        scheduleReviewStateSave(150);
      }
    }

    function toggleTokenSelection(i) {
      if (!Number.isInteger(i) || i < 0 || i >= WORDS.length) return;
      pushSelectionUndo();
      if (selected.has(i)) selected.delete(i);
      else selected.add(i);
      refreshToken(i);
      refreshIdleStatus();
      scheduleReviewStateSave(200);
    }

    function setCurrentIndex(next) {
      if (next === currentIndex) return;
      const prev = currentIndex;
      currentIndex = next;
      refreshToken(prev);
      refreshToken(currentIndex);
    }

    function findCurrentIndex(timeSec) {
      if (!Number.isFinite(timeSec)) return currentIndex;
      const prev = Number.isInteger(currentIndex) ? currentIndex : -1;
      if (prev >= 0 && prev < WORDS.length) {
        const ps = starts[prev];
        const pe = ends[prev];
        if (Number.isFinite(ps) && Number.isFinite(pe) && timeSec >= ps - 0.035 && timeSec <= pe + 0.035) {
          return prev;
        }
      }

      let left = 0;
      let right = starts.length - 1;
      let hit = -1;

      while (left <= right) {
        const mid = (left + right) >> 1;
        if (timeSec < starts[mid]) {
          right = mid - 1;
          continue;
        }
        if (timeSec > ends[mid]) {
          left = mid + 1;
          continue;
        }
        hit = mid;
        break;
      }

      if (hit >= 0) return hit;
      const near = Math.max(0, Math.min(starts.length - 1, left));
      if (near >= 0 && Math.abs(starts[near] - timeSec) <= 0.045) {
        return near;
      }
      return prev >= 0 ? prev : -1;
    }

    function ensureCurrentVisible() {
      if (currentIndex < 0 || !tokenEls[currentIndex] || !contentViewportEl) return;
      const now = Date.now();
      if (isDragging || isPointerDown) return;
      if (now < suppressAutoFollowUntil) return;
      if (now - lastUserScrollAt < 850) return;
      if (now - lastAutoScrollAt < 360) return;

      const tokenEl = tokenEls[currentIndex];
      const tokenRect = tokenEl.getBoundingClientRect();
      const viewportRect = contentViewportEl.getBoundingClientRect();
      const visibleTop = Math.max(viewportRect.top, 0);
      const visibleBottom = Math.min(viewportRect.bottom, window.innerHeight || document.documentElement.clientHeight || viewportRect.bottom);
      if (visibleBottom <= visibleTop + 40) return;
      const topSafe = visibleTop + 18;
      const bottomSafe = visibleBottom - 28;
      let delta = 0;
      if (tokenRect.top < topSafe) {
        delta = tokenRect.top - topSafe;
      } else if (tokenRect.bottom > bottomSafe) {
        delta = tokenRect.bottom - bottomSafe;
      }
      if (!delta) return;

      // Only nudge the independent text container. Large jumps during playback
      // make the current word disappear and are worse than a short catch-up.
      const maxStep = Math.max(72, contentViewportEl.clientHeight * 0.42);
      delta = Math.max(-maxStep, Math.min(maxStep, delta));
      setProgrammaticScroll(true);
      contentViewportEl.scrollBy({ top: delta, behavior: 'smooth' });
      lastAutoScrollAt = now;
    }

    function syncCurrentToken() {
      maybeSkipSelectedSegment();
      const prev = currentIndex;
      const idx = findCurrentIndex(Number(audio.currentTime) || 0);
      setCurrentIndex(idx);
      drawWaveform();
      if (!audio.paused) {
        ensureCurrentVisible();
      }
    }

    function maybeSkipSelectedSegment() {
      if (audio.paused) return;
      if (previewStopTime !== null) return;
      if (!mergedSelected.length) return;

      const t = Number(audio.currentTime) || 0;
      let hit = null;
      let left = 0;
      let right = mergedSelected.length - 1;

      while (left <= right) {
        const mid = (left + right) >> 1;
        const seg = mergedSelected[mid];
        if (t < seg.start) {
          right = mid - 1;
        } else if (t >= seg.end) {
          left = mid + 1;
        } else {
          hit = seg;
          break;
        }
      }

      if (!hit) return;
      const target = Math.min(getAudioTotalDuration(), hit.end + 0.02);
      if (!Number.isFinite(target) || target <= t + 0.005) return;
      const now = Date.now();
      if (Math.abs(target - lastSkipTarget) < 0.01 && now - lastSkipAt < 250) return;
      lastSkipTarget = target;
      lastSkipAt = now;
      smoothSkipTo(target);
    }

    function startSyncTimer() {
      stopSyncTimer();
      syncTimer = setInterval(syncCurrentToken, 120);
    }

    function stopSyncTimer() {
      if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
      }
    }

    function selectSilenceByThreshold() {
      const t = Math.max(0.2, Number(thresholdEl.value) || 0.2);
      pushSelectionUndo();
      let selectedCount = 0;
      let removedCount = 0;
      WORDS.forEach((w, i) => {
        if (!w.isGap) return;
        if (selected.delete(i)) removedCount += 1;
      });
      WORDS.forEach((w, i) => {
        if (!w.isGap) return;
        const d = Number(w.end) - Number(w.start);
        if (Number.isFinite(d) && d + 0.0005 >= t) {
          selected.add(i);
          selectedCount += 1;
        }
      });
      WORDS.forEach((w, i) => {
        if (w.isGap) refreshToken(i);
      });
      refreshIdleStatus();
      setStatus('\u9759\u97f3\u9608\u503c\u5df2\u5e94\u7528\uff1a\u9009\u62e9 ' + selectedCount + ' \u6bb5\uff0c\u79fb\u9664\u65e7\u9759\u97f3\u9009\u62e9 ' + removedCount + ' \u6bb5');
      setTimeout(refreshIdleStatus, 1500);
      scheduleReviewStateSave(250);
    }

    function clearLlmMarks(recordUndo = true) {
      if (!llmSuggested.size && !llmReasonByIndex.size && !llmPunctByIndex.size && !llmParagraphAfterIndex.size && !llmTopic && !llmOutline && !llmMultiSpeaker) return;
      if (recordUndo) pushSelectionUndo();
      llmSuggested.clear();
      llmReasonByIndex.clear();
      llmPunctByIndex.clear();
      llmParagraphAfterIndex.clear();
      llmTopic = '';
      llmOutline = '';
      llmMultiSpeaker = false;
      render();
      syncCurrentToken();
      updateSelectionStats();
      refreshLlmSummary('LLM 建议：已清空');
      scheduleReviewStateSave(250);
    }

    function applyLlmSuggestions() {
      if (!llmSuggested.size) {
        alert('暂无 LLM 建议可应用');
        return;
      }
      let added = 0;
      pushSelectionUndo();
      llmSuggested.forEach((idx) => {
        if (!selected.has(idx)) {
          selected.add(idx);
          added += 1;
          refreshToken(idx);
        }
      });
      updateSelectionStats();
      refreshIdleStatus();
      setStatus('已应用 LLM 建议，新增 ' + added + ' 项');
      setTimeout(refreshIdleStatus, 1200);
      scheduleReviewStateSave(250);
    }

    async function runLlmMark() {
      if (llmMarking) return;
      setLlmMarking(true);
      try {
        setStatus('LLM 正在分析文本，请稍候...');
        refreshLlmSummary('LLM 建议：分析中...');
        const response = await fetch('/api/llm-mark', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ words: WORDS }),
        });
        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error || 'LLM 标记失败');
        }

        pushSelectionUndo();
        clearLlmMarks(false);
        const indices = Array.isArray(data.indices) ? data.indices : [];
        const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
        const punctuationByIndex = (data && typeof data.punctuationByIndex === 'object' && data.punctuationByIndex) ? data.punctuationByIndex : {};
        const analysis = (data && typeof data.analysis === 'object' && data.analysis) ? data.analysis : {};

        for (const idx of indices) {
          if (!Number.isInteger(idx) || idx < 0 || idx >= WORDS.length) continue;
          llmSuggested.add(idx);
        }

        for (const s of suggestions) {
          const startIndex = Number(s.startIndex);
          const endIndex = Number(s.endIndex);
          const reason = toZhReason(s.reason, '语义冗余，建议删除');
          if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) continue;
          for (let i = startIndex; i <= endIndex; i += 1) {
            if (i >= 0 && i < WORDS.length && llmSuggested.has(i)) {
              llmReasonByIndex.set(i, reason);
            }
          }
        }

        for (const [k, v] of Object.entries(punctuationByIndex)) {
          const idx = Number(k);
          if (!Number.isInteger(idx) || idx < 0 || idx >= WORDS.length) continue;
          const punct = String(v && v.punct || '').trim();
          const paragraphAfter = !!(v && v.paragraphAfter);
          if (/[，。！？；：]/.test(punct)) {
            llmPunctByIndex.set(idx, punct[0]);
          }
          if (paragraphAfter) {
            llmParagraphAfterIndex.add(idx);
          }
        }

        llmTopic = String(analysis.topic || '').trim().slice(0, 80);
        llmOutline = String(analysis.outline || analysis.summary || '').trim().slice(0, 120);
        llmMultiSpeaker = !!analysis.multiSpeaker;

        render();
        syncCurrentToken();
        updateSelectionStats();

        const summary = String(data.summary || '').trim();
        const debug = (data && typeof data.debug === 'object' && data.debug) ? data.debug : {};
        const extra = [
          'LLM已标记 ' + llmSuggested.size + ' 项',
          data.selectedUnitCount ? ('候选句段 ' + data.selectedUnitCount + ' 个') : '',
          Number.isFinite(Number(data.successfulChunks))
            ? ('分块处理 ' + Number(data.successfulChunks) + '/' + Number(data.chunkCount || 0))
            : '',
          Number(data.failedChunks || 0) > 0
            ? ('失败分块 ' + Number(data.failedChunks))
            : '',
          Number.isFinite(Number(debug.rawCandidateCount))
            ? ('原始候选 ' + Number(debug.rawCandidateCount))
            : '',
          Number.isFinite(Number(debug.confidenceFilteredCount))
            ? ('置信度过滤 ' + Number(debug.confidenceFilteredCount))
            : '',
          Number.isFinite(Number(debug.selfCheckPrunedCount)) && Number(debug.selfCheckPrunedCount) > 0
            ? ('复核回收 ' + Number(debug.selfCheckPrunedCount))
            : '',
          debug.selfCheckIgnored ? '复核保护已触发' : '',
          debug.heuristicFallbackUsed ? ('兜底候选 ' + Number(debug.heuristicFallbackCount || 0)) : '',
          llmTopic ? ('主题: ' + llmTopic) : '',
          llmMultiSpeaker ? '多人对话: 是' : '',
          Object.keys(punctuationByIndex).length > 0 ? ('标点/分段优化 ' + Object.keys(punctuationByIndex).length + ' 处') : '',
          summary ? ('说明: ' + toZhReason(summary, '模型已给出删除建议')) : '',
        ].filter(Boolean).join(' | ');
        refreshLlmSummary(extra || 'LLM 建议：已更新');
        setStatus('LLM 标记完成，可点“应用LLM建议”加入删除列表');
        setTimeout(refreshIdleStatus, 1400);
        scheduleReviewStateSave(250);
      } finally {
        setLlmMarking(false);
      }
    }

    async function generatePublishSuggestions() {
      if (publishLoading) return;
      setPublishLoading(true);
      try {
        setPublishStatus('正在生成发布建议，请稍候...');
        const response = await fetch('/api/llm-publish-suggestions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            words: WORDS,
            style: publishStyleEl ? publishStyleEl.value : '专业',
            analysis: {
              topic: llmTopic,
              outline: llmOutline,
              multiSpeaker: llmMultiSpeaker,
            },
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) {
          throw new Error(data.error || ('HTTP ' + response.status));
        }
        renderPublishSuggestions(data);
        setPublishStatus('已生成：标题 ' + Number((data.titles || []).length) + ' 条，简介 ' + Number((data.descriptions || []).length) + ' 条');
      } finally {
        setPublishLoading(false);
      }
    }

    function applyChatAdjustResult(data) {
      const addIndices = Array.isArray(data?.addIndices) ? data.addIndices : [];
      const removeIndices = Array.isArray(data?.removeIndices) ? data.removeIndices : [];
      let changed = 0;

      if (addIndices.length || removeIndices.length) {
        pushSelectionUndo();
      }

      for (const raw of addIndices) {
        const idx = Number(raw);
        if (!Number.isInteger(idx) || idx < 0 || idx >= WORDS.length) continue;
        if (!selected.has(idx)) {
          selected.add(idx);
          changed += 1;
        }
        llmSuggested.add(idx);
        if (!llmReasonByIndex.has(idx)) {
          llmReasonByIndex.set(idx, 'LLM对话建议');
        }
        refreshToken(idx);
      }
      for (const raw of removeIndices) {
        const idx = Number(raw);
        if (!Number.isInteger(idx) || idx < 0 || idx >= WORDS.length) continue;
        if (selected.has(idx)) {
          selected.delete(idx);
          changed += 1;
        }
        llmSuggested.delete(idx);
        llmReasonByIndex.delete(idx);
        refreshToken(idx);
      }

      updateSelectionStats();
      refreshIdleStatus();
      scheduleReviewStateSave(200);
      syncUndoButton();
      return changed;
    }

    function undoLastChatAdjust() {
      undoLastSelectionChange('chat');
    }

    async function sendLlmChatAdjust() {
      if (llmChatSubmitting) return;
      const text = String(llmChatInputEl ? llmChatInputEl.value : '').trim();
      if (!text) {
        setLlmChatStatus('请输入调标记要求');
        return;
      }
      setLlmChatSubmitting(true);
      try {
        pushChatMessage('user', text);
        if (llmChatInputEl) llmChatInputEl.value = '';
        setLlmChatStatus('LLM 正在根据你的要求调整标记...');

        const response = await fetch('/api/llm-chat-adjust', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            words: WORDS,
            selectedIndices: Array.from(selected),
            message: text,
            history: chatMessages,
            analysis: {
              topic: llmTopic,
              outline: llmOutline,
              multiSpeaker: llmMultiSpeaker,
            },
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) {
          throw new Error(data.error || ('HTTP ' + response.status));
        }

        const analysis = (data && typeof data.analysis === 'object' && data.analysis) ? data.analysis : null;
        if (analysis) {
          llmTopic = String(analysis.topic || llmTopic || '').trim().slice(0, 80);
          llmOutline = String(analysis.outline || llmOutline || '').trim().slice(0, 120);
          llmMultiSpeaker = !!analysis.multiSpeaker;
        }
        const changed = applyChatAdjustResult(data);
        const reason = String(data.reason || '').trim();
        const summary = String(data.summary || '').trim();
        const msgParts = [
          '已完成调整',
          '新增 ' + Number((data.addIds || []).length) + ' 段',
          '取消 ' + Number((data.removeIds || []).length) + ' 段',
          '实际变更 ' + changed + ' 项',
          reason ? ('说明: ' + reason) : '',
          summary ? ('摘要: ' + summary) : '',
        ].filter(Boolean);
        pushChatMessage('assistant', msgParts.join(' | '));
        setLlmChatStatus('对话调标记完成');
      } finally {
        setLlmChatSubmitting(false);
      }
    }

    function mergedSegmentsFromSelection() {
      const residualGapSec = 0.18;
      const boundary = readBoundarySettings();
      const speechPadBeforeSec = boundary.speechLeadMs / 1000;
      const speechPadAfterSec = boundary.speechTailMs / 1000;
      const silenceEdgeGuardSec = boundary.silenceGuardMs / 1000;
      const fillerBoostSec = boundary.fillerBoostMs / 1000;
      const speechEntryOverlapSec = Math.max(0.025, Math.min(0.08, speechPadBeforeSec * 0.9));
      const fillerEntryOverlapSec = Math.max(speechEntryOverlapSec, Math.min(0.12, speechEntryOverlapSec + fillerBoostSec));
      const boundaryGuardSec = 0.005;
      const minDeleteSec = 0.05;
      const segs = Array.from(selected)
        .map((i) => ({ idx: Number(i), word: WORDS[i] }))
        .filter((item) => Number.isInteger(item.idx) && item.word)
        .map(({ idx, word: w }) => ({
          idx,
          start: Number(w.start),
          end: Number(w.end),
          hasSpeech: !w.isGap,
          hasFiller: tokenAutoCategory(idx) === 'filler',
        }))
        .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
        .sort((a, b) => a.idx - b.idx || a.start - b.start);

      const merged = [];
      function canBridgeSelectionGap(prevIdx, nextIdx) {
        for (let i = prevIdx + 1; i < nextIdx; i += 1) {
          if (selected.has(i)) continue;
          if (!WORDS[i]?.isGap) return false;
        }
        return true;
      }
      for (const s of segs) {
        if (!merged.length) {
          merged.push({ ...s, minIdx: s.idx, maxIdx: s.idx });
          continue;
        }

        const last = merged[merged.length - 1];
        const gapSec = s.start - last.end;
        const isContiguousSelection = s.idx <= last.maxIdx + 1;
        const canBridgeGap = gapSec <= residualGapSec && canBridgeSelectionGap(last.maxIdx, s.idx);
        if (s.start <= last.end + 0.05 || isContiguousSelection || canBridgeGap) {
          last.end = Math.max(last.end, s.end);
          last.hasSpeech = !!(last.hasSpeech || s.hasSpeech);
          last.hasFiller = !!(last.hasFiller || s.hasFiller);
          last.maxIdx = Math.max(last.maxIdx, s.idx);
        } else {
          merged.push({ ...s, minIdx: s.idx, maxIdx: s.idx });
        }
      }

      function getPrevSpeechEnd(idx) {
        for (let i = idx - 1; i >= 0; i -= 1) {
          const w = WORDS[i];
          if (!w || w.isGap) continue;
          const end = Number(w.end);
          return Number.isFinite(end) ? end : null;
        }
        return null;
      }

      function getNextSpeechStart(idx) {
        for (let i = idx + 1; i < WORDS.length; i += 1) {
          const w = WORDS[i];
          if (!w || w.isGap) continue;
          const start = Number(w.start);
          return Number.isFinite(start) ? start : null;
        }
        return null;
      }

      const adjusted = [];
      for (const s of merged) {
        let start = s.start;
        let end = s.end;
        if (s.hasSpeech) {
          const prevSpeechEnd = getPrevSpeechEnd(s.minIdx);
          const nextSpeechStart = getNextSpeechStart(s.maxIdx);
          const beforePad = s.hasFiller ? speechPadBeforeSec + fillerBoostSec : speechPadBeforeSec;
          const afterPad = s.hasFiller ? speechPadAfterSec + fillerBoostSec : speechPadAfterSec;
          const entryOverlap = s.hasFiller ? fillerEntryOverlapSec : speechEntryOverlapSec;
          if (Number.isFinite(prevSpeechEnd) && prevSpeechEnd < start) {
            // Whisper/ASR timestamps often start a deleted word slightly late.
            // Allow a tiny overlap into the previous kept word's tail so the
            // first deleted syllable does not leak into preview/export.
            start = Math.max(start - beforePad, prevSpeechEnd - entryOverlap);
          } else {
            start = Math.max(0, start - Math.min(0.022, beforePad));
          }
          if (Number.isFinite(nextSpeechStart) && nextSpeechStart > end) {
            end = Math.min(end + afterPad, nextSpeechStart - boundaryGuardSec);
          } else {
            end += Math.min(0.032, afterPad);
          }
        } else {
          const originalDuration = end - start;
          if (originalDuration > minDeleteSec + silenceEdgeGuardSec * 2) {
            const guard = Math.min(silenceEdgeGuardSec, Math.max(0, (originalDuration - minDeleteSec) / 2));
            start += guard;
            end -= guard;
          }
        }
        if (end - start >= minDeleteSec) {
          adjusted.push({
            start: Number(start.toFixed(3)),
            end: Number(end.toFixed(3)),
          });
        }
      }
      return adjusted;
    }

    function normalizeDeleteSegments(segments) {
      const duration = getAudioTotalDuration();
      const maxDuration = duration > 0 ? duration : Number.POSITIVE_INFINITY;
      return (Array.isArray(segments) ? segments : [])
        .map((seg) => ({
          start: Math.max(0, Number(seg.start)),
          end: Math.min(maxDuration, Number(seg.end)),
        }))
        .filter((seg) => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start)
        .sort((a, b) => a.start - b.start || a.end - b.end);
    }

    function mergeDeleteSegments(segments) {
      const merged = [];
      for (const seg of segments) {
        if (!merged.length || seg.start > merged[merged.length - 1].end) {
          merged.push({ ...seg });
          continue;
        }
        merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, seg.end);
      }
      return merged.map((seg) => ({
        start: Number(seg.start.toFixed(3)),
        end: Number(seg.end.toFixed(3)),
      }));
    }

    function applyCutPrecisionModeToSegments(segments) {
      const mode = cutPrecisionModeEl ? String(cutPrecisionModeEl.value || 'standard') : 'standard';
      const normalized = normalizeDeleteSegments(segments);
      if (mode === 'standard') return mergeDeleteSegments(normalized);
      const duration = getAudioTotalDuration();
      const maxDuration = duration > 0 ? duration : Number.POSITIVE_INFINITY;
      const adjusted = normalized.map((seg) => {
        const len = seg.end - seg.start;
        if (mode === 'clean') {
          const lead = len < 0.16 ? 0.025 : 0.04;
          const tail = len < 0.16 ? 0.035 : 0.06;
          return { start: Math.max(0, seg.start - lead), end: Math.min(maxDuration, seg.end + tail) };
        }
        const trim = Math.min(0.025, Math.max(0, (len - 0.06) / 2));
        return { start: seg.start + trim, end: seg.end - trim };
      }).filter((seg) => seg.end - seg.start >= 0.03);
      return mergeDeleteSegments(adjusted);
    }

    function currentOrNearestDeleteSegment() {
      const segs = normalizeDeleteSegments(mergedSegmentsFromSelection());
      if (!segs.length) return null;
      const currentTime = Number(audio.currentTime) || 0;
      const currentWord = WORDS[currentIndex] || null;
      const cursorTime = currentWord && Number.isFinite(Number(currentWord.start))
        ? ((Number(currentWord.start) + Number(currentWord.end)) / 2)
        : currentTime;
      const inside = segs.find((seg) => cursorTime >= seg.start && cursorTime <= seg.end)
        || segs.find((seg) => currentTime >= seg.start && currentTime <= seg.end);
      if (inside) return inside;
      let best = segs[0];
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const seg of segs) {
        const distance = cursorTime < seg.start ? seg.start - cursorTime : Math.max(0, cursorTime - seg.end);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = seg;
        }
      }
      return best;
    }

    function setPreviewSegment(seg) {
      const previous = previewSegment;
      previewSegment = seg ? { ...seg } : null;
      if (previous) {
        WORDS.forEach((_w, i) => {
          if (tokenOverlapsSegment(i, previous)) refreshToken(i);
        });
      }
      if (previewSegment) {
        WORDS.forEach((_w, i) => {
          if (tokenOverlapsSegment(i, previewSegment)) refreshToken(i);
        });
      }
      drawWaveform();
    }

    function previewCurrentDeletePoint() {
      updateSelectionStats();
      const seg = currentOrNearestDeleteSegment();
      if (!seg) {
        setStatus('没有可预听的删除片段');
        if (deletePreviewInfoEl) deletePreviewInfoEl.hidden = true;
        return;
      }
      const total = getAudioTotalDuration();
      const start = Math.max(0, seg.start - 2);
      const end = Math.min(total > 0 ? total : seg.end + 2, seg.end + 2);
      previewStopTime = end;
      setPreviewSegment(seg);
      if (deletePreviewInfoEl) {
        deletePreviewInfoEl.hidden = false;
        deletePreviewInfoEl.textContent =
          '预听范围：删除前 ' + formatSec(start) + '-' + formatSec(seg.start)
          + ' | 删除段 ' + formatSec(seg.start) + '-' + formatSec(seg.end)
          + ' | 删除后 ' + formatSec(seg.end) + '-' + formatSec(end);
      }
      setPlaybackTime(start);
      audio.play().catch(() => {});
      setStatus('正在预听删除点');
    }

    function nearestWordIndex(timeSec, direction) {
      let bestIdx = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      WORDS.forEach((word, idx) => {
        if (!word || word.isGap) return;
        const start = Number(word.start);
        const end = Number(word.end);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return;
        if (direction === 'prev' && end > timeSec) return;
        if (direction === 'next' && start < timeSec) return;
        const point = direction === 'prev' ? end : start;
        const distance = Math.abs(point - timeSec);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIdx = idx;
        }
      });
      return bestIdx;
    }

    function diagnoseDeleteSegmentsForPage(segments) {
      const normalized = normalizeDeleteSegments(segments);
      const risks = [];
      let denseCount = 0;
      const details = normalized.map((seg, index) => {
        const durationSec = seg.end - seg.start;
        const detail = {
          index,
          start: Number(seg.start.toFixed(3)),
          end: Number(seg.end.toFixed(3)),
          durationSec: Number(durationSec.toFixed(3)),
          prevWordIndex: nearestWordIndex(seg.start, 'prev'),
          nextWordIndex: nearestWordIndex(seg.end, 'next'),
          risks: [],
        };
        function pushRisk(type, message) {
          detail.risks.push(type);
          risks.push({ ...detail, type, message });
        }
        if (durationSec < 0.16) pushRisk('short', '过短，可能残留碎音');
        if (durationSec > 8) pushRisk('long', '较长，确认没有误删有效内容');
        const prevWord = WORDS[detail.prevWordIndex];
        const nextWord = WORDS[detail.nextWordIndex];
        const prevGap = prevWord ? seg.start - Number(prevWord.end) : Number.POSITIVE_INFINITY;
        const nextGap = nextWord ? Number(nextWord.start) - seg.end : Number.POSITIVE_INFINITY;
        if ((Number.isFinite(prevGap) && prevGap >= 0 && prevGap < 0.045)
          || (Number.isFinite(nextGap) && nextGap >= 0 && nextGap < 0.045)) {
          pushRisk('tight', '紧贴保留词，可能吞字或尾音');
        }
        const nextSeg = normalized[index + 1];
        if (nextSeg && nextSeg.start - seg.end >= 0 && nextSeg.start - seg.end < 0.25) {
          denseCount += 1;
          pushRisk('dense', '附近删除过密，建议预听');
        }
        return detail;
      });
      const totalDurationSec = normalized.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
      const sorted = [...details].sort((a, b) => a.durationSec - b.durationSec);
      return {
        count: normalized.length,
        totalDurationSec,
        shortest: sorted[0] || null,
        longest: sorted[sorted.length - 1] || null,
        denseCount,
        risks,
      };
    }

    function jumpToRiskSegment(risk) {
      const targetIdx = Number.isInteger(risk.prevWordIndex) && risk.prevWordIndex >= 0
        ? risk.prevWordIndex
        : risk.nextWordIndex;
      const targetTime = Math.max(0, Number(risk.start) - 0.35);
      setPlaybackTime(targetTime);
      if (Number.isInteger(targetIdx) && tokenEls[targetIdx]) {
        setCurrentIndex(targetIdx);
        tokenEls[targetIdx].scrollIntoView({ block: 'center', inline: 'nearest' });
      }
      setPreviewSegment({ start: Number(risk.start), end: Number(risk.end) });
      drawWaveform();
    }

    function renderDeleteDiagnostics() {
      updateSelectionStats();
      if (!deleteDiagnosticsPanelEl) return;
      const diag = diagnoseDeleteSegmentsForPage(mergedSelected);
      const parts = [
        '删除片段：' + diag.count + ' 段',
        '总删除时长：' + formatSec(diag.totalDurationSec),
        '最长：' + (diag.longest ? formatSec(diag.longest.durationSec) : '-'),
        '最短：' + (diag.shortest ? formatSec(diag.shortest.durationSec) : '-'),
        '连续密集：' + diag.denseCount + ' 处',
      ];
      deleteDiagnosticsPanelEl.innerHTML = '<div>' + parts.join(' | ') + '</div>';
      if (diag.risks.length) {
        const riskWrap = document.createElement('div');
        diag.risks.slice(0, 40).forEach((risk) => {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'diagnostic-risk';
          item.textContent = '#' + (risk.index + 1) + ' ' + risk.message + ' (' + formatSec(risk.start) + '-' + formatSec(risk.end) + ')';
          item.addEventListener('click', () => jumpToRiskSegment(risk));
          riskWrap.appendChild(item);
        });
        deleteDiagnosticsPanelEl.appendChild(riskWrap);
      } else {
        const ok = document.createElement('div');
        ok.textContent = '未发现明显风险片段。';
        deleteDiagnosticsPanelEl.appendChild(ok);
      }
      deleteDiagnosticsPanelEl.hidden = false;
    }

    function humanizeCutError(error) {
      const text = String(error && error.message ? error.message : error || '');
      if (/ENAMETOOLONG/i.test(text)) return '剪辑命令过长，系统已改用分批剪辑策略后仍失败，请查看日志。';
      if (/EACCES|EPERM|拒绝访问/i.test(text)) return '没有权限写入输出目录，请换一个输出文件夹或关闭占用文件的视频播放器。';
      if (/fetch failed|Failed to fetch/i.test(text)) return '本地审核服务暂时无响应，请重新打开审核窗口后再试。';
      if (/ffmpeg|exited with code 1|code 1/i.test(text)) return 'FFmpeg 执行失败，可能是源视频被占用、路径异常或磁盘空间不足。';
      return text || '未知错误，请复制诊断信息查看日志。';
    }

    function buildCutDiagnosticsText() {
      updateSelectionStats();
      const deletedSec = mergedSelected.reduce((sum, seg) => sum + Math.max(0, seg.end - seg.start), 0);
      const lines = [
        'Jaygo Cut 裁剪诊断信息',
        '视频路径: ' + (decodeURIComponent(new URL(audio.currentSrc || audio.src, window.location.href).pathname || '') || '-'),
        '删除片段数量: ' + mergedSelected.length,
        '删除总时长: ' + deletedSec.toFixed(2) + ' 秒',
        '剪辑模式: ' + (cutPrecisionModeEl ? cutPrecisionModeEl.value : 'standard'),
        '应用版本: ${packageVersion}',
        '最近裁剪日志:',
        ...(latestCutLogTail.length ? latestCutLogTail : ['-']),
      ];
      lines[1] = '视频路径: ' + (runtimeInfoCache && runtimeInfoCache.videoFile ? runtimeInfoCache.videoFile : '-');
      return lines.join('\\n');
    }

    async function copyCutDiagnostics() {
      const text = buildCutDiagnosticsText();
      try {
        await navigator.clipboard.writeText(text);
        setStatus('已复制诊断信息');
      } catch {
        setStatus('复制失败，请从裁剪日志中查看详细信息');
      }
    }

    async function forceBackupReviewState() {
      const core = buildReviewStateCore();
      const r = await fetch('/api/review-state/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(core),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.success) {
        throw new Error(d.error || ('HTTP ' + r.status));
      }
      setDraftState('草稿状态：裁剪前已备份（' + formatClock(d.state && d.state.savedAt) + '）');
      return d.state;
    }

    async function runCutPreflight(segments) {
      const r = await fetch('/api/cut-preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.success) {
        throw new Error(d.error || ('HTTP ' + r.status));
      }
      if (!d.ok) {
        const text = (d.issues || []).map((issue) => issue.message || issue.code).filter(Boolean).join('\\n');
        throw new Error(text || '裁剪前检查未通过');
      }
      return d;
    }

    function buildMediaOverlaysForCut() {
      const overlays = [];
      const pushOverlay = (type, item, asset) => {
        const start = Number(item?.start);
        const end = Number(item?.end);
        const filePath = String(asset?.filePath || '').trim();
        if (!filePath || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
        overlays.push({
          type,
          filePath,
          start,
          end,
          title: String(item?.title || ''),
          fit: 'cover',
          motionEffect: type === 'image' ? currentImageMotionEffect() : 'none',
        });
      };
      imageItems.forEach((item) => pushOverlay('image', item, item?.image));
      videoItems.forEach((item) => pushOverlay('video', item, item?.video));
      return overlays;
    }

    async function waitCut(jobId) {
      while (true) {
        const r = await fetch('/api/cut-status?jobId=' + encodeURIComponent(jobId));
        const d = await r.json();
        setLogs(d.logTail || []);

        if (d.state === 'running') {
          const elapsed = formatElapsed(d.startedAt);
          setStatus('裁剪中：' + phaseLabel(d.phase) + ' | 任务片段: ' + (d.segmentsCount || 0) + ' | 已耗时: ' + elapsed);
        }

        if (d.state === 'completed') return d;
        if (d.state === 'failed') throw new Error(d.error || 'cut failed');
        await new Promise((res) => setTimeout(res, 500));
      }
    }

    async function executeCut() {
      if (cutSubmitting) return;
      if (runtimeInfoCache && runtimeInfoCache.videoExists === false) {
        alert(runtimeInfoCache.videoMissingMessage || '原视频文件不存在，无法执行裁剪。');
        return;
      }
      const rawSegs = mergedSegmentsFromSelection();
      const segs = applyCutPrecisionModeToSegments(rawSegs);
      if (!segs.length) {
        alert('请先选择要删除的片段');
        return;
      }

      setCutSubmitting(true);
      isCutRunning = true;
      setLogs([]);

      try {
        await saveReviewState('force');
        await forceBackupReviewState();
        await runCutPreflight(segs);
        setStatus('正在提交裁剪任务...');
        const r = await fetch('/api/cut', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            segments: segs,
            overlays: buildMediaOverlaysForCut(),
          }),
        });

        const d = await r.json();
        if (!d.success) throw new Error(d.error || '提交失败');

        if (d.existingRunning) {
          setStatus('检测到已有裁剪任务，已接管并继续显示实时进度...');
        }

        const finalData = await waitCut(d.jobId || '');
        const result = finalData.result || {};
        setStatus('裁剪完成: ' + (result.output || ''));
        alert('裁剪完成\\n\\n输出: ' + (result.output || ''));
      } catch (err) {
        const friendly = humanizeCutError(err);
        setStatus('裁剪失败: ' + friendly);
        alert('裁剪失败: ' + friendly + '\\n\\n已保存 review-state.backup.json，可用于恢复审核草稿。');
        throw err;
      } finally {
        isCutRunning = false;
        setCutSubmitting(false);
        setTimeout(refreshIdleStatus, 1200);
      }
    }

    async function loadRuntime() {
      try {
        const r = await fetch('/api/runtime-info');
        const d = await r.json();
        if (d && d.success) {
          runtimeInfoCache = d;
          runtimeEl.textContent = '输出目录: ' + d.cutOutputDir;
          if (d.videoExists === false) {
            const message = d.videoMissingMessage || '原视频文件不存在，审核页可查看和调整草稿，但不能执行裁剪。';
            runtimeEl.textContent += ' | ' + message;
            btnCut.disabled = true;
            btnCut.title = message;
            setStatus('原视频缺失，仅可查看审核草稿');
          } else if (!cutSubmitting) {
            btnCut.disabled = false;
            btnCut.title = '';
          }
          if (btnToggleVideoPreview) {
            const hasSourceVideo = d.videoExists !== false;
            btnToggleVideoPreview.disabled = !hasSourceVideo;
            btnToggleVideoPreview.title = hasSourceVideo ? '' : (d.videoMissingMessage || '原视频缺失，无法预览视频');
            if (!hasSourceVideo) {
              setVideoPreviewVisible(false);
              setVideoPreviewStatus('原视频缺失');
            } else {
              setVideoPreviewStatus(videoPreviewEnabled ? '跟随中' : '可预览');
            }
          }
          applyTheme(d.themeMode || 'light');
          drawWaveform();
        } else {
          runtimeEl.textContent = '未读取到运行信息';
        }
        return d;
      } catch (e) {
        runtimeEl.textContent = '读取运行信息失败: ' + e.message;
        return null;
      }
    }

    document.getElementById('btnPlay').addEventListener('click', () => {
      if (audio.paused) audio.play();
      else audio.pause();
    });

    function shouldHandleGlobalHotkey(event) {
      if (!event || event.defaultPrevented) return false;
      const target = event.target;
      if (!target) return true;
      if (target.isContentEditable) return false;
      const tag = String(target.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
      return true;
    }

    document.addEventListener('keydown', (e) => {
      const key = String(e.key || '').toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && key === 'f') {
        if (replaceFindTextEl) {
          e.preventDefault();
          replaceFindTextEl.focus();
          replaceFindTextEl.select();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && key === 's') {
        e.preventDefault();
        saveReviewState('force').catch(() => {});
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (key === 'y' || (e.shiftKey && key === 'z'))) {
        if (!shouldHandleGlobalHotkey(e)) return;
        if (redoLastSelectionChange()) {
          e.preventDefault();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && String(e.key || '').toLowerCase() === 'z') {
        if (!shouldHandleGlobalHotkey(e)) return;
        if (undoLastSelectionChange('hotkey')) {
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'Escape') {
        if (shortcutHelpEl && !shortcutHelpEl.hidden) {
          closeShortcutHelp();
          e.preventDefault();
          return;
        }
        if (leftPanelOpen || imagePanelOpen || rightPanelOpen) {
          closePanels();
          e.preventDefault();
        }
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && key === 's') {
        if (!shouldHandleGlobalHotkey(e)) return;
        e.preventDefault();
        previewCurrentDeletePoint();
        return;
      }
      if (e.code !== 'Space') return;
      if (!shouldHandleGlobalHotkey(e)) return;
      e.preventDefault();
      if (audio.paused) audio.play();
      else audio.pause();
    });

    document.getElementById('btnClear').addEventListener('click', () => {
      if (selected.size) pushSelectionUndo();
      selected.clear();
      setPreviewSegment(null);
      WORDS.forEach((_w, i) => refreshToken(i));
      refreshIdleStatus();
      scheduleReviewStateSave(250);
    });

    document.getElementById('btnSelectSilence').addEventListener('click', selectSilenceByThreshold);
    if (btnPreviewDelete) btnPreviewDelete.addEventListener('click', previewCurrentDeletePoint);
    if (btnToggleVideoPreview) btnToggleVideoPreview.addEventListener('click', toggleVideoPreview);
    if (btnFocusReview) btnFocusReview.addEventListener('click', toggleFocusReviewMode);
    if (btnShowDeleteDiagnostics) btnShowDeleteDiagnostics.addEventListener('click', renderDeleteDiagnostics);
    if (btnCopyDiagnostics) btnCopyDiagnostics.addEventListener('click', copyCutDiagnostics);
    if (cutPrecisionModeEl) {
      cutPrecisionModeEl.addEventListener('change', () => {
        updateSelectionStats();
        scheduleReviewStateSave(250);
      });
    }
    thresholdEl.addEventListener('change', () => {
      selectSilenceByThreshold();
    });
    [speechLeadMsEl, speechTailMsEl, fillerBoostMsEl, silenceGuardMsEl].forEach((el) => {
      if (!el) return;
      el.addEventListener('change', () => {
        applyBoundarySettings(readBoundarySettings());
        refreshIdleStatus();
        scheduleReviewStateSave(250);
      });
    });
    const btnResetBoundary = document.getElementById('btnResetBoundary');
    if (btnResetBoundary) {
      btnResetBoundary.addEventListener('click', () => {
        applyBoundarySettings(DEFAULT_BOUNDARY);
        refreshIdleStatus();
        scheduleReviewStateSave(250);
      });
    }
    document.getElementById('btnLlmMark').addEventListener('click', async () => {
      try {
        await runLlmMark();
      } catch (e) {
        setStatus('LLM 标记失败: ' + e.message);
        refreshLlmSummary('LLM 建议：调用失败');
        alert('LLM 标记失败: ' + e.message);
      }
    });
    document.getElementById('btnApplyLlm').addEventListener('click', applyLlmSuggestions);
    if (btnClearLlm) {
      btnClearLlm.addEventListener('click', clearLlmMarks);
    }
    if (btnToggleLeftPanel) {
      btnToggleLeftPanel.addEventListener('click', () => {
        setPanelOpen('left', !leftPanelOpen);
      });
    }
    if (btnToggleImagePanel) {
      btnToggleImagePanel.addEventListener('click', () => {
        setPanelOpen('image', !imagePanelOpen);
      });
    }
    if (btnToggleRightPanel) {
      btnToggleRightPanel.addEventListener('click', () => {
        setPanelOpen('right', !rightPanelOpen);
      });
    }
    if (btnCloseLeftPanel) {
      btnCloseLeftPanel.addEventListener('click', () => {
        setPanelOpen('left', false);
      });
    }
    if (btnCloseImagePanel) {
      btnCloseImagePanel.addEventListener('click', () => {
        setPanelOpen('image', false);
      });
    }
    if (btnCloseRightPanel) {
      btnCloseRightPanel.addEventListener('click', () => {
        setPanelOpen('right', false);
      });
    }
    if (btnGeneratePublish) {
      btnGeneratePublish.addEventListener('click', async () => {
        try {
          await generatePublishSuggestions();
        } catch (e) {
          setPublishStatus('发布建议生成失败: ' + e.message);
          alert('发布建议生成失败: ' + e.message);
        }
      });
    }
    if (btnGenerateImages) {
      btnGenerateImages.addEventListener('click', async () => {
        try {
          await generateVideoImages();
        } catch (e) {
          setImageStatus('视频配图生成失败: ' + e.message);
          alert('视频配图生成失败: ' + e.message);
        }
      });
    }
    if (btnDownloadImages) {
      btnDownloadImages.addEventListener('click', downloadGeneratedImages);
    }
    if (btnGenerateVideos) {
      btnGenerateVideos.addEventListener('click', async () => {
        try {
          await generateVideoAssets();
        } catch (e) {
          setVideoAssetStatus('视频素材生成失败: ' + e.message);
          alert('视频素材生成失败: ' + e.message);
        }
      });
    }
    if (btnExportSrt) {
      btnExportSrt.addEventListener('click', () => exportSubtitles('srt'));
    }
    if (btnExportTxt) {
      btnExportTxt.addEventListener('click', () => exportSubtitles('txt'));
    }
    if (btnExportJianyingDraft) {
      btnExportJianyingDraft.addEventListener('click', exportJianyingDraft);
    }
    if (replaceFindTextEl) {
      replaceFindTextEl.addEventListener('input', () => refreshSearchMatches(false));
      replaceFindTextEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        jumpSearchMatch(e.shiftKey ? -1 : 1);
      });
    }
    if (replaceWithTextEl) {
      replaceWithTextEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) replaceAllMatches();
        else replaceActiveMatch();
      });
    }
    if (btnFindPrev) btnFindPrev.addEventListener('click', () => jumpSearchMatch(-1));
    if (btnFindNext) btnFindNext.addEventListener('click', () => jumpSearchMatch(1));
    if (btnReplaceOne) btnReplaceOne.addEventListener('click', replaceActiveMatch);
    if (btnReplaceAll) btnReplaceAll.addEventListener('click', replaceAllMatches);
    if (btnApplyGlossary) btnApplyGlossary.addEventListener('click', applyGlossaryCorrections);
    if (btnShortcutHelp) btnShortcutHelp.addEventListener('click', openShortcutHelp);
    if (btnCloseShortcutHelp) btnCloseShortcutHelp.addEventListener('click', closeShortcutHelp);
    if (shortcutHelpEl) {
      shortcutHelpEl.addEventListener('mousedown', (e) => {
        if (e.target === shortcutHelpEl) closeShortcutHelp();
      });
    }
    if (imageAspectEl) {
      imageAspectEl.addEventListener('change', renderImageCards);
    }
    if (imageMotionEffectEl) {
      imageMotionEffectEl.addEventListener('change', () => scheduleReviewStateSave(100));
    }
    if (imageCardListEl) {
      imageCardListEl.addEventListener('click', async (e) => {
        const retryBtn = e.target.closest('[data-image-retry]');
        const copyBtn = e.target.closest('[data-image-copy]');
        if (retryBtn) {
          const index = Number(retryBtn.dataset.imageRetry);
          if (!Number.isInteger(index)) return;
          try {
            setImageStatus('正在重试第 ' + (index + 1) + ' 张，LLM 会先换一个提示词...');
            await generateOneImage(index, true);
            setImageStatus('第 ' + (index + 1) + ' 张已重试完成');
          } catch (err) {
            if (imageItems[index]) {
              imageItems[index].status = 'error';
              imageItems[index].error = err.message || String(err);
              renderImageCards();
            }
            setImageStatus('重试失败: ' + (err.message || String(err)));
          }
          return;
        }
        if (copyBtn) {
          const index = Number(copyBtn.dataset.imageCopy);
          const text = imageItems[index]?.prompt || '';
          if (!text) return;
          navigator.clipboard?.writeText(text).then(() => {
            setImageStatus('已复制第 ' + (index + 1) + ' 张提示词');
          }).catch(() => {
            setImageStatus('复制失败，请手动选择提示词');
          });
        }
      });
    }
    if (videoAssetListEl) {
      videoAssetListEl.addEventListener('click', async (e) => {
        const retryBtn = e.target.closest('[data-video-retry]');
        const copyBtn = e.target.closest('[data-video-copy]');
        if (retryBtn) {
          const index = Number(retryBtn.dataset.videoRetry);
          if (!Number.isInteger(index)) return;
          try {
            setVideoAssetStatus('正在重试第 ' + (index + 1) + ' 段视频素材...');
            await generateOneVideoAsset(index, true);
            setVideoAssetStatus('第 ' + (index + 1) + ' 段视频素材已重试完成');
          } catch (err) {
            if (videoItems[index]) {
              videoItems[index].status = 'error';
              videoItems[index].error = err.message || String(err);
              renderVideoAssetCards();
            }
            setVideoAssetStatus('重试失败: ' + (err.message || String(err)));
          }
          return;
        }
        if (copyBtn) {
          const index = Number(copyBtn.dataset.videoCopy);
          const text = videoItems[index]?.videoPrompt || videoItems[index]?.prompt || '';
          if (!text) return;
          navigator.clipboard?.writeText(text).then(() => {
            setVideoAssetStatus('已复制第 ' + (index + 1) + ' 段视频提示词');
          }).catch(() => {
            setVideoAssetStatus('复制失败，请手动选择提示词');
          });
        }
      });
    }
    if (btnLlmChatSend) {
      btnLlmChatSend.addEventListener('click', async () => {
        try {
          await sendLlmChatAdjust();
        } catch (e) {
          setLlmChatStatus('LLM 对话调标记失败: ' + e.message);
          pushChatMessage('assistant', '处理失败: ' + e.message);
          alert('LLM 对话调标记失败: ' + e.message);
        }
      });
    }
    if (btnLlmChatUndo) {
      btnLlmChatUndo.addEventListener('click', () => {
        undoLastChatAdjust();
      });
    }
    if (llmChatInputEl) {
      llmChatInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendLlmChatAdjust().catch((err) => {
            setLlmChatStatus('LLM 对话调标记失败: ' + err.message);
            pushChatMessage('assistant', '处理失败: ' + err.message);
          });
        }
      });
    }
    document.addEventListener('mousedown', (e) => {
      if (!leftPanelOpen && !imagePanelOpen && !rightPanelOpen) return;
      const target = e.target;
      const insideLeft = !!(leftPanelEl && leftPanelEl.contains(target));
      const insideImage = !!(imagePanelEl && imagePanelEl.contains(target));
      const insideRight = !!(rightPanelEl && rightPanelEl.contains(target));
      const onLeftToggle = !!(btnToggleLeftPanel && btnToggleLeftPanel.contains(target));
      const onImageToggle = !!(btnToggleImagePanel && btnToggleImagePanel.contains(target));
      const onRightToggle = !!(btnToggleRightPanel && btnToggleRightPanel.contains(target));
      if (insideLeft || insideImage || insideRight || onLeftToggle || onImageToggle || onRightToggle) return;
      closePanels();
    });
    document.getElementById('btnCut').addEventListener('click', async () => {
      try {
        await executeCut();
      } catch (e) {
        isCutRunning = false;
        setStatus('裁剪失败: ' + humanizeCutError(e));
      }
    });

    content.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const idx = getTokenIndex(e.target);
      if (idx === null) return;
      e.preventDefault();
      markUserScrollIntent(1600);
      isPointerDown = true;
      pointerDownIdx = idx;
      pointerDownX = e.clientX;
      pointerDownY = e.clientY;
    });

    content.addEventListener('dblclick', (e) => {
      if (e.button !== 0) return;
      const idx = getTokenIndex(e.target);
      if (idx === null) return;
      e.preventDefault();
      toggleTokenSelection(idx);
      seekToToken(idx);
    });

    document.addEventListener('mousemove', (e) => {
      if (!isPointerDown) return;
      if ((e.buttons & 1) !== 1) {
        endDrag();
        clearPointerState();
        return;
      }
      const moved = Math.abs(e.clientX - pointerDownX) + Math.abs(e.clientY - pointerDownY);
      if (!isDragging && moved >= 24 && Number.isInteger(pointerDownIdx)) {
        beginDrag(selected.has(pointerDownIdx) ? 'remove' : 'add', pointerDownIdx);
      }
      if (!isDragging) return;
      maybeAutoScrollDuringDrag(e.clientY);
      const idx = resolveTokenIndexFromPointer(e.clientX, e.clientY);
      if (idx === null) return;
      applyDragToIndex(idx);
    });

    document.addEventListener('mouseup', (e) => {
      if (e.button !== 0) return;
      const wasDragging = endDrag();
      if (!wasDragging && isPointerDown && Number.isInteger(pointerDownIdx)) {
        seekToToken(pointerDownIdx);
      }
      clearPointerState();
    });

    if (waveCanvas && waveWrapEl) {
      waveWrapEl.addEventListener('click', (e) => {
        const view = getWaveViewWindow();
        if (!(view.duration > 0)) return;
        const rect = waveCanvas.getBoundingClientRect();
        if (rect.width <= 0) return;
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const nextTime = setPlaybackTime(view.start + ratio * Math.max(0.001, view.end - view.start));
        waveViewCenterSec = nextTime;
        syncCurrentToken();
        drawWaveform();
        scheduleReviewStateSave(120);
      });
      waveWrapEl.addEventListener('wheel', (e) => {
        const view = getWaveViewWindow();
        if (!(view.duration > 0)) return;
        e.preventDefault();
        const rect = waveCanvas.getBoundingClientRect();
        const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0.5;
        const anchor = view.start + ratio * Math.max(0.001, view.end - view.start);
        const direction = e.deltaY < 0 ? 1 : -1;
        const nextZoom = Math.round((waveZoom + direction * 0.5) * 2) / 2;
        setWaveZoom(nextZoom, anchor);
      }, { passive: false });
      window.addEventListener('resize', () => {
        rebuildTokenRects();
        drawWaveform();
      });
    }

    if (contentViewportEl) {
      contentViewportEl.addEventListener('wheel', () => {
        markUserScrollIntent(1600);
      }, { passive: true });
      contentViewportEl.addEventListener('scroll', () => {
        if (!isProgrammaticScroll) {
          markUserScrollIntent(1300);
        }
        rebuildTokenRects();
      }, { passive: true });
    }

    if (waveZoomEl) {
      waveZoomEl.addEventListener('input', () => {
        setWaveZoom(Number(waveZoomEl.value) || 1);
      });
      waveZoomEl.addEventListener('change', () => {
        setWaveZoom(Number(waveZoomEl.value) || 1);
      });
    }

    window.addEventListener('blur', () => {
      endDrag();
      clearPointerState();
      stopSyncTimer();
    });

    if (sourceVideoEl) {
      silenceVideoPreview();
      sourceVideoEl.addEventListener('loadedmetadata', () => {
        silenceVideoPreview();
        setVideoPreviewStatus('已加载');
        syncVideoPreview(true);
      });
      sourceVideoEl.addEventListener('volumechange', () => {
        if (!sourceVideoEl.muted || sourceVideoEl.volume !== 0) {
          silenceVideoPreview();
        }
      });
      sourceVideoEl.addEventListener('error', () => {
        setVideoPreviewStatus('视频无法预览，可能是编码不受 Chromium 支持');
      });
      sourceVideoEl.addEventListener('play', () => {
        silenceVideoPreview();
        if (!videoPreviewEnabled || syncingVideoFromAudio) return;
        syncingAudioFromVideo = true;
        setPlaybackTime(Number(sourceVideoEl.currentTime) || 0, { forceVideo: false });
        syncingAudioFromVideo = false;
        if (audio.paused) audio.play().catch(() => {});
      });
      sourceVideoEl.addEventListener('pause', () => {
        if (!videoPreviewEnabled || syncingVideoFromAudio) return;
        if (!audio.paused) audio.pause();
      });
      sourceVideoEl.addEventListener('seeked', () => {
        if (!videoPreviewEnabled || syncingVideoFromAudio) return;
        syncingAudioFromVideo = true;
        setPlaybackTime(Number(sourceVideoEl.currentTime) || 0, { forceVideo: false });
        syncingAudioFromVideo = false;
        syncCurrentToken();
        drawWaveform();
        scheduleReviewStateSave(120);
      });
    }

    audio.addEventListener('timeupdate', () => {
      syncCurrentToken();
      syncVideoPreview(false);
      if (previewStopTime !== null && Number(audio.currentTime) >= previewStopTime) {
        audio.pause();
        previewStopTime = null;
        setStatus('预听完成');
      }
    });
    audio.addEventListener('loadedmetadata', () => {
      updateSelectionStats();
      syncVideoPreview(true);
      drawWaveform();
    });
    audio.addEventListener('durationchange', () => {
      updateSelectionStats();
      drawWaveform();
    });
    audio.addEventListener('play', () => {
      syncCurrentToken();
      syncVideoPreview(true);
      startSyncTimer();
    });
    audio.addEventListener('pause', () => {
      stopSyncTimer();
      cancelSkipFade();
      if (videoPreviewEnabled && sourceVideoEl && !sourceVideoEl.paused) sourceVideoEl.pause();
      drawWaveform();
      scheduleReviewStateSave(200);
    });
    audio.addEventListener('ended', () => {
      stopSyncTimer();
      cancelSkipFade();
      previewStopTime = null;
      if (sourceVideoEl && !sourceVideoEl.paused) sourceVideoEl.pause();
      drawWaveform();
    });
    window.addEventListener('beforeunload', () => {
      saveReviewState('unload').catch(() => {});
    });
    window.addEventListener('pagehide', () => {
      saveReviewState('unload').catch(() => {});
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        saveReviewState('auto').catch(() => {});
      }
    });

    async function initPage() {
      closePanels();
      setWaveZoom(1);
      applyBoundarySettings(DEFAULT_BOUNDARY);
      renderQualityWarnings();
      render();
      syncUndoButton();
      renderPublishSuggestions({ titles: [], descriptions: [], keywords: [] });
      renderImageCards();
      renderVideoAssetCards();
      refreshGlossarySummary();
      try {
        applyFocusReviewMode(localStorage.getItem(FOCUS_REVIEW_STORAGE_KEY) === '1');
      } catch {
        applyFocusReviewMode(false);
      }
      await restoreReviewState();
      syncCurrentToken();
      updateSelectionStats();
      refreshLlmSummary();
      await loadRuntime();
      try {
        setVideoPreviewVisible(localStorage.getItem(VIDEO_PREVIEW_STORAGE_KEY) === '1');
      } catch {
        setVideoPreviewVisible(false);
      }
      await loadWaveform();
      drawWaveform();
      scheduleReviewStateSave(150);
    }

    initPage().catch((e) => {
      setStatus('页面初始化失败: ' + e.message);
    });
  </script>
</body>
</html>`;

fs.writeFileSync('review.html', html, 'utf8');
console.log('Generated review.html');
console.log('Use review_server.js to start the review server.');

