#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { normalizeSelectedIndices } = require('./auto_selected_utils');

let subtitlesFile = process.argv[2] || 'subtitles_words.json';
const autoSelectedFile = process.argv[3] || 'auto_selected.json';
const inputAudio = process.argv[4] || 'audio.wav';

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
    }
    .content-card {
      flex: 0 0 auto;
      min-height: 0;
      overflow: hidden;
      height: clamp(520px, 74vh, 980px);
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
      top: 118px;
      width: clamp(220px, 15vw, 280px);
      max-height: calc(100vh - 138px);
      z-index: 1200;
      display: flex;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.18s ease, transform 0.18s ease;
      isolation: isolate;
    }
    .floating-side.left {
      left: max(8px, calc((100vw - 1240px) / 2 - 294px));
      transform: translateX(-8px);
    }
    .floating-side.right {
      right: max(8px, calc((100vw - 1240px) / 2 - 294px));
      transform: translateX(8px);
    }
    .floating-side.open {
      opacity: 1;
      pointer-events: auto;
      transform: translateX(0);
    }
    .floating-toggle {
      position: fixed;
      top: 150px;
      z-index: 1201;
      border-radius: 999px;
      padding: 7px 12px;
      font-size: 13px;
      border: 1px solid var(--border);
      background: color-mix(in oklab, var(--card-bg) 86%, var(--token-gap-bg) 14%);
      color: var(--text-main);
      box-shadow: 0 8px 18px rgba(15, 23, 42, 0.22);
      backdrop-filter: blur(4px);
    }
    .floating-toggle.left {
      left: max(8px, calc((100vw - 1240px) / 2 - 294px));
    }
    .floating-toggle.right {
      right: max(8px, calc((100vw - 1240px) / 2 - 294px));
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
      transition: background-color 120ms ease;
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
        width: 240px;
      }
      .floating-toggle.left {
        left: 10px;
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
        width: min(46vw, 300px);
        max-height: 46vh;
        top: auto;
        bottom: 10px;
      }
      .floating-side.left {
        left: 10px;
      }
      .floating-side.right {
        right: 10px;
      }
      .floating-toggle {
        top: 110px;
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
      <div class="row" style="margin-top:10px">
        <button id="btnPlay" class="primary">播放/暂停</button>
        <button id="btnClear">清空选择</button>
        <span class="meta">静音阈值(秒) >=</span>
        <input id="silenceThreshold" type="number" min="0.2" step="0.05" value="0.2" />
        <button id="btnSelectSilence">按阈值选择静音</button>
        <button id="btnLlmMark">LLM标记</button>
        <button id="btnApplyLlm">应用LLM建议</button>
        <button id="btnCut" class="warn">执行裁剪</button>
      </div>
      <div id="status" class="status">就绪</div>
      <div class="meta" id="selectionStats" style="margin-top:4px"></div>
      <details class="fold-panel" style="margin-top:8px">
        <summary>说明与详细状态（点击展开）</summary>
        <div class="legend" aria-label="标记颜色说明">
          <span class="legend-item"><span class="legend-dot silence"></span>停顿规则（自动）</span>
          <span class="legend-item"><span class="legend-dot filler"></span>语气词规则（自动）</span>
          <span class="legend-item"><span class="legend-dot repeat"></span>重复句规则（自动）</span>
          <span class="legend-item"><span class="legend-dot llm"></span>LLM建议</span>
        </div>
        <div class="meta">操作提示：单击定位播放点；双击切换删除/取消；按住鼠标左键拖过文本可连续标记；空格键可播放/暂停；播放时文本会实时跟随并自动跳过已选段。</div>
        <div class="meta" id="llmSummary" style="margin-top:4px"></div>
        <div class="meta" id="runtime" style="margin-top:4px"></div>
        <div class="meta" id="draftState" style="margin-top:4px">草稿状态：未保存</div>
      </details>
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

    const audio = document.getElementById('audio');
    const content = document.getElementById('content');
    const contentViewportEl = document.getElementById('contentViewport');
    const statusEl = document.getElementById('status');
    const selectionStatsEl = document.getElementById('selectionStats');
    const runtimeEl = document.getElementById('runtime');
    const draftStateEl = document.getElementById('draftState');
    const logsEl = document.getElementById('logs');
    const thresholdEl = document.getElementById('silenceThreshold');
    const llmSummaryEl = document.getElementById('llmSummary');
    const waveWrapEl = document.getElementById('waveWrap');
    const waveCanvas = document.getElementById('waveCanvas');
    const waveHintEl = document.getElementById('waveHint');
    const waveZoomEl = document.getElementById('waveZoom');
    const waveZoomTextEl = document.getElementById('waveZoomText');
    const btnLlmMark = document.getElementById('btnLlmMark');
    const btnApplyLlm = document.getElementById('btnApplyLlm');
    const btnCut = document.getElementById('btnCut');
    const leftPanelEl = document.querySelector('.floating-side.left');
    const rightPanelEl = document.querySelector('.floating-side.right');
    const btnToggleLeftPanel = document.getElementById('btnToggleLeftPanel');
    const btnToggleRightPanel = document.getElementById('btnToggleRightPanel');
    const btnCloseLeftPanel = document.getElementById('btnCloseLeftPanel');
    const btnCloseRightPanel = document.getElementById('btnCloseRightPanel');
    const btnGeneratePublish = document.getElementById('btnGeneratePublish');
    const publishStyleEl = document.getElementById('publishStyle');
    const publishStatusEl = document.getElementById('publishStatus');
    const publishTitlesListEl = document.getElementById('publishTitlesList');
    const publishDescriptionEl = document.getElementById('publishDescription');
    const publishKeywordsEl = document.getElementById('publishKeywords');
    const llmChatHistoryEl = document.getElementById('llmChatHistory');
    const llmChatInputEl = document.getElementById('llmChatInput');
    const btnLlmChatSend = document.getElementById('btnLlmChatSend');
    const btnLlmChatUndo = document.getElementById('btnLlmChatUndo');
    const llmChatStatusEl = document.getElementById('llmChatStatus');

    const selected = new Set(AUTO);
    const autoSet = new Set(AUTO);

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
    let waveStaticCanvas = null;
    let waveStaticKey = '';
    let publishLoading = false;
    let llmChatSubmitting = false;
    let isProgrammaticScroll = false;
    let programmaticScrollTimer = null;
    let lastUserScrollAt = 0;
    let suppressAutoFollowUntil = 0;
    const chatMessages = [];
    const selectionUndoStack = [];
    let leftPanelOpen = false;
    let rightPanelOpen = false;

    function setStatus(msg) {
      statusEl.textContent = msg;
    }

    function setPanelOpen(side, open) {
      const isLeft = side === 'left';
      if (isLeft) {
        leftPanelOpen = !!open;
        if (leftPanelEl) leftPanelEl.classList.toggle('open', leftPanelOpen);
        if (btnToggleLeftPanel) {
          btnToggleLeftPanel.classList.toggle('active', leftPanelOpen);
          btnToggleLeftPanel.classList.toggle('hidden', leftPanelOpen);
          btnToggleLeftPanel.textContent = '发布建议';
        }
        if (leftPanelOpen) {
          rightPanelOpen = false;
          if (rightPanelEl) rightPanelEl.classList.remove('open');
          if (btnToggleRightPanel) {
            btnToggleRightPanel.classList.remove('active');
            btnToggleRightPanel.classList.remove('hidden');
            btnToggleRightPanel.textContent = 'LLM对话';
          }
        } else if (btnToggleLeftPanel) {
          btnToggleLeftPanel.classList.remove('hidden');
        }
      } else {
        rightPanelOpen = !!open;
        if (rightPanelEl) rightPanelEl.classList.toggle('open', rightPanelOpen);
        if (btnToggleRightPanel) {
          btnToggleRightPanel.classList.toggle('active', rightPanelOpen);
          btnToggleRightPanel.classList.toggle('hidden', rightPanelOpen);
          btnToggleRightPanel.textContent = 'LLM对话';
        }
        if (rightPanelOpen) {
          leftPanelOpen = false;
          if (leftPanelEl) leftPanelEl.classList.remove('open');
          if (btnToggleLeftPanel) {
            btnToggleLeftPanel.classList.remove('active');
            btnToggleLeftPanel.classList.remove('hidden');
            btnToggleLeftPanel.textContent = '发布建议';
          }
        } else if (btnToggleRightPanel) {
          btnToggleRightPanel.classList.remove('hidden');
        }
      }
    }

    function closePanels() {
      setPanelOpen('left', false);
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

    function setLlmChatSubmitting(next) {
      llmChatSubmitting = !!next;
      if (btnLlmChatSend) {
        btnLlmChatSend.disabled = llmChatSubmitting;
        btnLlmChatSend.textContent = llmChatSubmitting ? '处理中...' : '发送并调整';
      }
      if (llmChatInputEl) llmChatInputEl.disabled = llmChatSubmitting;
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
      };
    }

    function pushSelectionUndo() {
      selectionUndoStack.push(snapshotSelectionState());
      while (selectionUndoStack.length > 20) selectionUndoStack.shift();
      syncUndoButton();
    }

    function restoreSelectionState(snapshot) {
      if (!snapshot || !Array.isArray(snapshot.selected)) return;
      selected.clear();
      llmSuggested.clear();
      llmReasonByIndex.clear();
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
      render();
      syncCurrentToken();
      updateSelectionStats();
      refreshLlmSummary();
      scheduleReviewStateSave(200);
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
        version: 3,
        selectedIndices: Array.from(selected).sort((a, b) => a - b),
        llmSuggestedIndices: Array.from(llmSuggested).sort((a, b) => a - b),
        llmReasons,
        llmPunctuation,
        llmParagraphAfterIndices: Array.from(llmParagraphAfterIndex)
          .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < WORDS.length)
          .sort((a, b) => a - b),
        llmTopic,
        llmOutline,
        llmMultiSpeaker,
        threshold: Math.max(0.2, Number(thresholdEl.value) || 0.2),
        currentTimeSec: Math.max(0, Number(audio.currentTime) || 0),
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

        const threshold = Number(state.threshold);
        if (Number.isFinite(threshold) && threshold >= 0.2) {
          thresholdEl.value = threshold.toFixed(2);
        }

        const resumeTime = Number(state.currentTimeSec);
        if (Number.isFinite(resumeTime) && resumeTime > 0) {
          if (Number.isFinite(audio.duration) && audio.duration > 0) {
            audio.currentTime = Math.max(0, Math.min(audio.duration - 0.01, resumeTime));
          } else {
            audio.addEventListener('loadedmetadata', () => {
              const maxT = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration - 0.01 : resumeTime;
              audio.currentTime = Math.max(0, Math.min(maxT, resumeTime));
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
      logsEl.textContent = (lines || []).join('\\n');
      logsEl.scrollTop = logsEl.scrollHeight;
    }

    function getAudioTotalDuration() {
      if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
      if (ends.length) return Math.max(...ends);
      return 0;
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

    function setWaveZoom(nextZoom) {
      const z = Math.max(1, Math.min(8, Number(nextZoom) || 1));
      waveZoom = z;
      if (waveZoomEl) waveZoomEl.value = String(z);
      if (waveZoomTextEl) waveZoomTextEl.textContent = z.toFixed(1) + 'x';
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
      const center = Math.max(0, Math.min(duration, Number(audio.currentTime) || 0));
      let start = center - (span / 2);
      if (start < 0) start = 0;
      if (start + span > duration) start = duration - span;
      const end = Math.min(duration, start + span);
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
      const text = String(w.text || '').trim();
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
      word.textContent = String(w.text || '');
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
        + tokenAutoClass(i)
        + tokenMarkerClass(i)
        + (llmSuggested.has(i) ? ' llm' : '')
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
      btnCut.disabled = cutSubmitting;
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
      const edge = 70;
      if (!contentViewportEl) return;
      const vr = contentViewportEl.getBoundingClientRect();
      if (clientY < vr.top + edge) {
        contentViewportEl.scrollTop -= 24;
        return;
      }
      if (clientY > vr.bottom - edge) {
        contentViewportEl.scrollTop += 24;
      }
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
        audio.currentTime = Math.max(0, target);
        setCurrentIndex(i);
        drawWaveform();
        scheduleReviewStateSave(150);
      }
    }

    function toggleTokenSelection(i) {
      if (!Number.isInteger(i) || i < 0 || i >= WORDS.length) return;
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
      if (now - lastAutoScrollAt < 600) return;

      const tokenEl = tokenEls[currentIndex];
      const tokenTop = tokenEl.offsetTop;
      const tokenBottom = tokenTop + tokenEl.offsetHeight;
      const viewTop = contentViewportEl.scrollTop + 44;
      const viewBottom = contentViewportEl.scrollTop + contentViewportEl.clientHeight - 64;
      if (tokenTop < viewTop) {
        const nextTop = Math.max(0, tokenTop - 56);
        setProgrammaticScroll(true);
        contentViewportEl.scrollTo({ top: nextTop, behavior: 'smooth' });
        lastAutoScrollAt = now;
        return;
      }
      if (tokenBottom > viewBottom) {
        const nextTop = Math.max(0, tokenBottom - contentViewportEl.clientHeight + 74);
        setProgrammaticScroll(true);
        contentViewportEl.scrollTo({ top: nextTop, behavior: 'smooth' });
        lastAutoScrollAt = now;
      }
    }

    function syncCurrentToken() {
      maybeSkipSelectedSegment();
      const prev = currentIndex;
      const idx = findCurrentIndex(Number(audio.currentTime) || 0);
      setCurrentIndex(idx);
      drawWaveform();
      if (!audio.paused && idx !== prev) {
        ensureCurrentVisible();
      }
    }

    function maybeSkipSelectedSegment() {
      if (audio.paused) return;
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
      audio.currentTime = target;
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
      let selectedCount = 0;
      let removedCount = 0;
      WORDS.forEach((w, i) => {
        if (!w.isGap) return;
        if (selected.delete(i)) removedCount += 1;
      });
      WORDS.forEach((w, i) => {
        if (!w.isGap) return;
        const d = Number(w.end) - Number(w.start);
        if (Number.isFinite(d) && d >= t) {
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

    function clearLlmMarks() {
      if (!llmSuggested.size && !llmReasonByIndex.size && !llmPunctByIndex.size && !llmParagraphAfterIndex.size && !llmTopic && !llmOutline && !llmMultiSpeaker) return;
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

        clearLlmMarks();
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
      if (!selectionUndoStack.length) return;
      const snapshot = selectionUndoStack.pop();
      restoreSelectionState(snapshot);
      syncUndoButton();
      pushChatMessage('assistant', '已撤回上一步对话调标记。');
      setLlmChatStatus('已撤回最近一次对话调整');
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
      const segs = Array.from(selected)
        .map((i) => WORDS[i])
        .filter(Boolean)
        .map((w) => ({ start: Number(w.start), end: Number(w.end) }))
        .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
        .sort((a, b) => a.start - b.start);

      const merged = [];
      for (const s of segs) {
        if (!merged.length || s.start > merged[merged.length - 1].end + 0.05) {
          merged.push({ ...s });
        } else {
          merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, s.end);
        }
      }
      return merged;
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
      const segs = mergedSegmentsFromSelection();
      if (!segs.length) {
        alert('请先选择要删除的片段');
        return;
      }

      setCutSubmitting(true);
      isCutRunning = true;
      setLogs([]);

      try {
        await saveReviewState('force');
        setStatus('正在提交裁剪任务...');
        const r = await fetch('/api/cut', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(segs),
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
          runtimeEl.textContent = '输出目录: ' + d.cutOutputDir;
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
      if (e.key === 'Escape') {
        if (leftPanelOpen || rightPanelOpen) {
          closePanels();
          e.preventDefault();
        }
        return;
      }
      if (e.code !== 'Space') return;
      if (!shouldHandleGlobalHotkey(e)) return;
      e.preventDefault();
      if (audio.paused) audio.play();
      else audio.pause();
    });

    document.getElementById('btnClear').addEventListener('click', () => {
      selected.clear();
      WORDS.forEach((_w, i) => refreshToken(i));
      refreshIdleStatus();
      scheduleReviewStateSave(250);
    });

    document.getElementById('btnSelectSilence').addEventListener('click', selectSilenceByThreshold);
    thresholdEl.addEventListener('change', () => {
      selectSilenceByThreshold();
    });
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
    if (btnToggleLeftPanel) {
      btnToggleLeftPanel.addEventListener('click', () => {
        setPanelOpen('left', !leftPanelOpen);
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
      if (!leftPanelOpen && !rightPanelOpen) return;
      const target = e.target;
      const insideLeft = !!(leftPanelEl && leftPanelEl.contains(target));
      const insideRight = !!(rightPanelEl && rightPanelEl.contains(target));
      const onLeftToggle = !!(btnToggleLeftPanel && btnToggleLeftPanel.contains(target));
      const onRightToggle = !!(btnToggleRightPanel && btnToggleRightPanel.contains(target));
      if (insideLeft || insideRight || onLeftToggle || onRightToggle) return;
      closePanels();
    });
    document.getElementById('btnCut').addEventListener('click', async () => {
      try {
        await executeCut();
      } catch (e) {
        isCutRunning = false;
        setStatus('裁剪失败: ' + e.message);
        alert('裁剪失败: ' + e.message);
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
      if (!isDragging && moved >= 18 && Number.isInteger(pointerDownIdx)) {
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
        audio.currentTime = view.start + ratio * Math.max(0.001, view.end - view.start);
        syncCurrentToken();
        drawWaveform();
        scheduleReviewStateSave(120);
      });
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

    audio.addEventListener('timeupdate', syncCurrentToken);
    audio.addEventListener('loadedmetadata', () => {
      updateSelectionStats();
      drawWaveform();
    });
    audio.addEventListener('durationchange', () => {
      updateSelectionStats();
      drawWaveform();
    });
    audio.addEventListener('play', () => {
      syncCurrentToken();
      startSyncTimer();
    });
    audio.addEventListener('pause', () => {
      stopSyncTimer();
      drawWaveform();
      scheduleReviewStateSave(200);
    });
    audio.addEventListener('ended', () => {
      stopSyncTimer();
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
      render();
      syncUndoButton();
      renderPublishSuggestions({ titles: [], descriptions: [], keywords: [] });
      await restoreReviewState();
      syncCurrentToken();
      updateSelectionStats();
      refreshLlmSummary();
      await loadRuntime();
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

