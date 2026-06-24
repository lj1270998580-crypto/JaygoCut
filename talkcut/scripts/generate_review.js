#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { normalizeSelectedIndices } = require('./auto_selected_utils');
const { analyzeTranscriptQuality } = require('./transcript_quality');
const { parseTermGlossary } = require('./term_glossary');

const REVIEW_TEMPLATE_VERSION = 'jaygo-review-template-20260622-compact-review-layout';

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
    .toolbar-card > .primary-actions,
    .toolbar-card > .toolbar-status-grid {
      grid-column: 1;
      min-width: 0;
    }
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
    .video-preview-frame {
      position: relative;
      background: #000;
      overflow: hidden;
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
    .composite-preview-overlay {
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      background: rgba(0, 0, 0, 0.02);
    }
    .composite-preview-overlay[hidden] {
      display: none;
    }
    .composite-preview-overlay img,
    .composite-preview-overlay video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transform-origin: center center;
    }
    #sourceVideo,
    .composite-preview-overlay video {
      transform: none !important;
    }
    .preview-action-stack {
      position: absolute;
      top: 8px;
      right: 8px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: flex-end;
      z-index: 2;
      pointer-events: auto;
    }
    .preview-action-stack button,
    .image-card-actions .secondary-action {
      border: 1px solid var(--border);
      border-radius: 999px;
      background: color-mix(in oklab, var(--card-bg) 82%, transparent);
      color: var(--text-main);
      padding: 5px 10px;
      font-size: 12px;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.18);
    }
    .media-card-controls {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 6px;
      color: var(--text-muted);
      font-size: 12px;
    }
    .media-card-controls input {
      width: 84px;
      min-width: 0;
      padding: 5px 7px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--input-bg);
      color: var(--text-main);
    }
    .preview-retry-button {
      pointer-events: auto;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: color-mix(in oklab, var(--btn-primary-bg) 82%, transparent);
      color: var(--btn-primary-text);
      padding: 6px 12px;
      font-size: 12px;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.24);
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
    body.review-focus-mode .wave-zoom-control,
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
      top: 72px;
      width: clamp(300px, 19vw, 380px);
      height: calc(100vh - 88px);
      max-height: calc(100vh - 88px);
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
      scrollbar-width: thin;
    }
    .floating-side.left {
      left: max(8px, calc((100vw - 1240px) / 2 - 410px));
      transform: translateX(-8px);
    }
    .floating-side.image-side {
      width: clamp(440px, 27vw, 540px);
      padding-right: 10px;
      overflow-y: scroll;
      scrollbar-gutter: stable both-edges;
      scrollbar-color: color-mix(in oklab, var(--text-muted) 62%, transparent) color-mix(in oklab, var(--log-bg) 64%, transparent);
    }
    .floating-side.left.image-side {
      left: max(10px, calc((100vw - 1240px) / 2 - 550px));
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
    .floating-toggle.right.log-toggle {
      top: calc(var(--floating-toggle-top) + 62px);
    }
    .floating-toggle.active {
      background: var(--btn-primary-bg);
      color: var(--btn-primary-text);
      border-color: color-mix(in oklab, var(--btn-primary-bg) 66%, var(--border));
    }
    .floating-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      margin-left: 6px;
      padding: 0 5px;
      border-radius: 999px;
      background: var(--btn-warn-bg);
      color: var(--btn-warn-text);
      font-size: 11px;
      line-height: 1;
    }
    .floating-badge[hidden] {
      display: none;
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
      flex-wrap: wrap;
      justify-content: flex-end;
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
    .media-mode-tabs {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin: 2px 0 8px;
      padding: 4px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: color-mix(in oklab, var(--log-bg) 72%, transparent);
    }
    .media-mode-tab {
      min-height: 34px;
      padding: 6px 10px;
      border-radius: 9px;
      font-size: 13px;
      background: transparent;
      color: var(--text-muted);
    }
    .media-mode-tab.active {
      background: var(--btn-primary-bg);
      color: var(--btn-primary-text);
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.18);
    }
    .media-mode-panel {
      display: flex;
      flex-direction: column;
      gap: 7px;
      min-height: 0;
    }
    .media-mode-panel[hidden] {
      display: none !important;
    }
    .media-panel-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
    }
    .media-panel-actions.single {
      grid-template-columns: 1fr;
    }
    .media-panel-actions button {
      width: 100%;
      min-height: 30px;
      padding: 4px 8px;
      font-size: 12px;
      border-radius: 8px;
    }
    .media-control-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px 8px;
    }
    .media-control-grid-4 {
      grid-template-columns: repeat(4, minmax(0, 1fr));
      align-items: end;
    }
    .media-control-grid-4 .media-field .meta {
      font-size: 11px;
    }
    .media-control-grid-4 select {
      height: 28px;
      padding: 3px 6px;
      font-size: 12px;
    }
    .visual-reference-box {
      border: 1px solid color-mix(in oklab, var(--accent) 34%, var(--border));
      border-radius: 12px;
      background: color-mix(in oklab, var(--card-bg) 86%, var(--accent) 7%);
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 7px;
    }
    .visual-reference-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 13px;
      font-weight: 700;
      color: var(--text-main);
    }
    .visual-reference-head label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      white-space: nowrap;
    }
    .visual-reference-preview {
      position: relative;
      min-height: 138px;
      aspect-ratio: 1 / 1;
      border: 1px dashed var(--border);
      border-radius: 10px;
      overflow: hidden;
      background: var(--log-bg);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      font-size: 12px;
      text-align: center;
    }
    .visual-reference-preview img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }
    .asset-reference-grid {
      min-height: 76px;
      max-height: 210px;
      overflow: auto;
      border: 1px dashed var(--border);
      border-radius: 10px;
      background: var(--log-bg);
      padding: 6px;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }
    .asset-reference-empty {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 62px;
      color: var(--text-muted);
      font-size: 12px;
      text-align: center;
    }
    .asset-reference-card {
      position: relative;
      border: 1px solid var(--border);
      border-radius: 9px;
      overflow: hidden;
      background: color-mix(in oklab, var(--card-bg) 86%, transparent);
      min-width: 0;
    }
    .asset-reference-thumb {
      position: relative;
      aspect-ratio: 4 / 3;
      background: var(--card-bg);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      font-size: 11px;
      text-align: center;
      overflow: hidden;
    }
    .asset-reference-thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .asset-reference-caption {
      padding: 5px 6px;
      font-size: 11px;
      line-height: 1.3;
      color: var(--text-main);
    }
    .asset-reference-kind {
      display: inline-block;
      margin-right: 4px;
      color: var(--text-muted);
      font-weight: 700;
    }
    .asset-reference-actions {
      position: absolute;
      top: 5px;
      right: 5px;
      display: flex;
      gap: 4px;
      z-index: 2;
      opacity: 0;
      transition: opacity 120ms ease;
    }
    .asset-reference-card:hover .asset-reference-actions,
    .asset-reference-card:focus-within .asset-reference-actions {
      opacity: 1;
    }
    .asset-reference-actions button {
      width: 24px;
      height: 24px;
      padding: 0;
      border-radius: 999px;
      border: 1px solid color-mix(in oklab, var(--border) 78%, transparent);
      background: color-mix(in oklab, #020617 76%, transparent);
      color: #fff;
      font-size: 11px;
      line-height: 1;
      box-shadow: 0 6px 14px rgba(0, 0, 0, 0.24);
    }
    .asset-preview-backdrop {
      position: fixed;
      inset: 0;
      z-index: 999;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(2, 6, 23, 0.72);
      backdrop-filter: blur(4px);
    }
    .asset-preview-dialog {
      width: min(760px, 92vw);
      max-height: 90vh;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: var(--card-bg);
      box-shadow: 0 22px 70px rgba(0, 0, 0, 0.42);
      overflow: hidden;
    }
    .asset-preview-dialog header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      color: var(--text-main);
      font-weight: 700;
    }
    .asset-preview-dialog img {
      display: block;
      width: 100%;
      max-height: calc(90vh - 62px);
      object-fit: contain;
      background: #020617;
    }
    .asset-preview-dialog button {
      padding: 4px 9px;
      border-radius: 999px;
    }
    .visual-reference-prompt,
    .media-prompt-editor {
      width: 100%;
      min-height: 68px;
      resize: vertical;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--input-bg);
      color: var(--text-main);
      padding: 7px 8px;
      font-size: 12px;
      line-height: 1.45;
    }
    .media-prompt-editor {
      min-height: 84px;
      max-height: 180px;
    }
    .media-prompt-label {
      display: block;
      margin-bottom: 4px;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 700;
    }
    .media-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    .media-field .meta {
      font-size: 12px;
      line-height: 1.15;
    }
    .media-field select,
    .image-side .compact-row select {
      width: 100%;
      min-width: 0;
    }
    .image-side .compact-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
    }
    .image-side select {
      width: 100%;
      min-width: 0;
    }
    .image-side > .panel-header {
      align-items: flex-start;
    }
    .image-side > .panel-header .panel-actions {
      flex: 1 1 auto;
      justify-content: flex-end;
      gap: 4px;
    }
    .image-side > .panel-header .panel-actions button {
      flex: 0 0 auto;
      padding: 4px 8px;
      min-height: 26px;
      min-width: 0;
      border-radius: 7px;
      font-size: 12px;
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
      overflow-y: visible;
      min-height: 0;
      padding-right: 2px;
      scrollbar-width: thin;
      overscroll-behavior: contain;
    }
    #imageCardList {
      margin-bottom: 14px;
    }
    .floating-side,
    #imageCardList,
    #videoAssetList,
    #publishTitlesList,
    #publishKeywords,
    #llmChatHistory {
      scrollbar-color: color-mix(in oklab, var(--text-muted) 38%, transparent) transparent;
    }
    .floating-side::-webkit-scrollbar,
    #imageCardList::-webkit-scrollbar,
    #videoAssetList::-webkit-scrollbar,
    #publishTitlesList::-webkit-scrollbar,
    #publishKeywords::-webkit-scrollbar,
    #llmChatHistory::-webkit-scrollbar {
      width: 7px;
      height: 7px;
    }
    .floating-side::-webkit-scrollbar-track,
    #imageCardList::-webkit-scrollbar-track,
    #videoAssetList::-webkit-scrollbar-track,
    #publishTitlesList::-webkit-scrollbar-track,
    #publishKeywords::-webkit-scrollbar-track,
    #llmChatHistory::-webkit-scrollbar-track {
      background: transparent;
    }
    .floating-side::-webkit-scrollbar-thumb,
    #imageCardList::-webkit-scrollbar-thumb,
    #videoAssetList::-webkit-scrollbar-thumb,
    #publishTitlesList::-webkit-scrollbar-thumb,
    #publishKeywords::-webkit-scrollbar-thumb,
    #llmChatHistory::-webkit-scrollbar-thumb {
      border-radius: 999px;
      background: color-mix(in oklab, var(--text-muted) 32%, transparent);
    }
    .media-video-section {
      border: 1px solid color-mix(in oklab, var(--accent) 32%, var(--border));
      border-radius: 12px;
      margin-top: 2px;
      margin-bottom: 8px;
      padding: 8px;
      clear: both;
      position: relative;
      background: color-mix(in oklab, var(--card-bg) 84%, var(--accent) 7%);
    }
    .image-card {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px;
      background: color-mix(in oklab, var(--card-bg) 88%, var(--token-gap-bg) 12%);
      display: flex;
      flex-direction: column;
      gap: 8px;
      overflow: visible;
      position: relative;
    }
    .video-asset-card {
      border-color: color-mix(in oklab, var(--accent) 42%, var(--border));
      background: color-mix(in oklab, var(--card-bg) 82%, var(--accent) 10%);
    }
    .video-asset-card .image-preview {
      aspect-ratio: 16 / 9;
    }
    .image-preview {
      position: relative;
      width: 100%;
      aspect-ratio: 1 / 1;
      height: clamp(220px, 30vh, 320px);
      max-height: none;
      min-height: 220px;
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
      padding: 6px;
    }
    .floating-side.image-side::-webkit-scrollbar {
      width: 10px;
    }
    .floating-side.image-side::-webkit-scrollbar-track {
      border-radius: 999px;
      background: color-mix(in oklab, var(--log-bg) 64%, transparent);
    }
    .floating-side.image-side::-webkit-scrollbar-thumb {
      border-radius: 999px;
      background: color-mix(in oklab, var(--text-muted) 58%, transparent);
    }
    .image-preview img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }
    .image-preview video {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }
    .media-dimension-badge {
      position: absolute;
      right: 8px;
      bottom: 8px;
      z-index: 1;
      border: 1px solid color-mix(in oklab, var(--border) 72%, transparent);
      border-radius: 999px;
      background: rgba(2, 6, 23, 0.72);
      color: #f8fafc;
      font-size: 11px;
      line-height: 1;
      padding: 5px 7px;
      backdrop-filter: blur(4px);
    }
    .image-card-title {
      font-weight: 700;
      font-size: 13px;
      line-height: 1.35;
      color: var(--text-main);
    }
    .media-card-meta-line {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 10px;
      color: var(--text-muted);
      font-size: 12px;
      line-height: 1.35;
    }
    .media-card-meta-line span {
      white-space: nowrap;
    }
    .image-card-prompt {
      font-size: 12px;
      line-height: 1.45;
      color: var(--text-muted);
      max-height: 54px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .media-details {
      border: 1px dashed color-mix(in oklab, var(--border) 78%, transparent);
      border-radius: 8px;
      background: color-mix(in oklab, var(--log-bg) 72%, transparent);
      overflow: hidden;
    }
    .media-details summary {
      cursor: pointer;
      list-style: none;
      padding: 6px 8px;
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
      user-select: none;
    }
    .media-details summary::-webkit-details-marker {
      display: none;
    }
    .media-details summary::before {
      content: "\\25B6";
      display: inline-block;
      margin-right: 5px;
      font-size: 10px;
      transform: translateY(-1px);
    }
    .media-details[open] summary::before {
      content: "\\25BE";
    }
    .media-details-body {
      border-top: 1px dashed color-mix(in oklab, var(--border) 65%, transparent);
      padding: 7px 8px;
      max-height: 150px;
      overflow-y: auto;
      color: var(--text-muted);
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .image-card-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
      align-items: stretch;
    }
    .image-card-actions button,
    .image-card-actions a {
      padding: 4px 7px;
      font-size: 12px;
      border-radius: 8px;
      min-height: 28px;
      min-width: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      white-space: nowrap;
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
    .log-side {
      height: min(62vh, 560px);
      max-height: calc(100vh - 168px);
      top: 150px;
    }
    .log-side #logs {
      max-height: none;
      min-height: 220px;
    }
    .fold-panel {
      border: 1px dashed var(--border);
      border-radius: 10px;
      padding: 6px 8px;
      background: color-mix(in oklab, var(--card-bg) 94%, var(--token-gap-bg) 6%);
    }
    .fold-panel summary {
      cursor: pointer;
      font-size: 12.5px;
      font-weight: 600;
      color: var(--text-main);
      user-select: none;
      outline: none;
      line-height: 1.35;
    }
    .fold-panel[open] summary {
      margin-bottom: 6px;
    }
    .tool-fold {
      margin-top: 6px;
      scrollbar-width: thin;
    }
    .tool-fold[open] {
      max-height: min(235px, 32vh);
      overflow-y: auto;
      scrollbar-gutter: stable;
    }
    .tool-actions {
      margin-bottom: 4px;
    }
    .filler-word-input {
      flex: 1 1 180px;
      min-width: 140px;
      height: 30px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--input-bg);
      color: var(--text-main);
      padding: 4px 7px;
      font-size: 12.5px;
    }
    .export-actions select,
    .export-actions input {
      height: 30px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--input-bg);
      color: var(--text-main);
      padding: 4px 7px;
      font-size: 12.5px;
    }
    .export-actions #jianyingDraftRoot,
    .export-actions #jianyingTemplatePath {
      flex: 1 1 245px;
      min-width: 210px;
    }
    .export-actions #jianyingExportMode {
      flex: 0 1 185px;
      min-width: 160px;
    }
    .replace-actions {
      align-items: stretch;
    }
    .replace-actions input {
      height: 30px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--input-bg);
      color: var(--text-main);
      padding: 4px 7px;
      font-size: 12.5px;
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
      margin-top: 8px;
      gap: 7px;
      align-items: center;
    }
    .primary-actions button {
      padding: 6px 9px;
      border-radius: 8px;
      font-size: 12.5px;
      white-space: nowrap;
    }
    .primary-actions .always-on-toggles {
      display: inline-flex;
      gap: 5px;
      align-items: center;
      padding-left: 4px;
      border-left: 1px solid var(--border);
    }
    .primary-actions .toggle-pill {
      min-width: 0;
      padding: 5px 8px;
      border-radius: 999px;
      font-size: 12px;
      color: var(--text-muted);
      background: color-mix(in oklab, var(--card-bg) 82%, var(--btn-bg) 18%);
      border: 1px solid var(--border);
    }
    .primary-actions .toggle-pill[aria-pressed="true"] {
      color: var(--btn-primary-text);
      background: var(--btn-primary-bg);
      border-color: color-mix(in oklab, var(--btn-primary-bg) 70%, var(--border));
    }
    .primary-actions .compact-select,
    .compact-select {
      height: 31px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--input-bg);
      color: var(--text-main);
      padding: 4px 7px;
      font-size: 12.5px;
    }
    .primary-actions .jianying-quick-target {
      flex: 0 1 170px;
      max-width: 220px;
    }
    .export-status-inline {
      min-height: 18px;
      margin-top: 4px;
      color: var(--text-muted);
      font-size: 12.5px;
      overflow-wrap: anywhere;
    }
    .export-status-inline:empty {
      display: none;
    }
    .primary-actions #status {
      flex: 1 1 140px;
      min-width: 120px;
      max-width: 260px;
      margin-top: 0;
      min-height: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      border-left: 1px solid var(--border);
      padding-left: 8px;
    }
    .toolbar-status-grid {
      display: flex;
      gap: 7px;
      align-items: center;
      flex-wrap: wrap;
      margin-top: -2px;
    }
    .status-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-height: 25px;
      padding: 3px 8px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: color-mix(in oklab, var(--card-bg) 88%, var(--token-gap-bg) 12%);
      color: var(--text-muted);
      font-size: 12px;
      line-height: 1.2;
    }
    .status-chip strong {
      color: var(--text-main);
      font-size: 12.5px;
      font-weight: 700;
    }
    .status-chip.status-chip-accent {
      border-color: color-mix(in oklab, var(--accent) 36%, var(--border));
      background: color-mix(in oklab, var(--accent) 12%, var(--card-bg));
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
    .tool-tabs {
      display: flex;
      gap: 5px;
      flex-wrap: wrap;
      margin: 0 0 7px;
      position: sticky;
      top: 0;
      z-index: 1;
      padding-bottom: 3px;
      background: color-mix(in oklab, var(--card-bg) 92%, var(--token-gap-bg) 8%);
    }
    .tool-tab {
      padding: 4px 8px;
      border: 1px solid var(--border);
      background: color-mix(in oklab, var(--card-bg) 88%, var(--btn-bg) 12%);
      color: var(--text-muted);
      font-size: 12px;
      border-radius: 999px;
    }
    .tool-tab.active {
      border-color: color-mix(in oklab, var(--accent) 54%, var(--border));
      background: color-mix(in oklab, var(--accent) 18%, var(--card-bg));
      color: var(--text-main);
    }
    .tool-panel {
      display: grid;
      gap: 5px;
    }
    .tool-panel[hidden] {
      display: none !important;
    }
    .tool-section-title {
      display: inline-flex;
      align-items: center;
      min-width: 56px;
      font-weight: 700;
      color: var(--text-main);
    }
    .utility-actions {
      align-items: center;
    }
    .tool-fold button {
      padding: 5px 8px;
      border-radius: 7px;
      font-size: 12px;
    }
    .tool-fold .meta,
    .tool-fold label {
      font-size: 12.5px;
      line-height: 1.35;
    }
    .tool-fold input[type="number"] {
      height: 30px;
      padding: 4px 7px;
      font-size: 12.5px;
    }
    .tool-fold .legend {
      gap: 8px;
      margin-top: 4px;
    }
    .tool-fold .legend-item {
      font-size: 11.5px;
    }
    .tool-fold .quality-warnings {
      margin-top: 4px;
      padding: 6px 8px;
      font-size: 12px;
    }
    .row {
      display: flex;
      gap: 6px;
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
      margin-top: 4px;
      gap: 6px;
      align-items: center;
    }
    .boundary-row label {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .boundary-row input[type="number"] {
      width: 64px;
      padding: 5px 6px;
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
      overflow: visible;
      z-index: 4;
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
    .wave-zoom-control {
      position: absolute;
      right: 10px;
      bottom: 8px;
      z-index: 30;
    }
    .wave-zoom-button {
      padding: 4px 8px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: color-mix(in oklab, var(--card-bg) 78%, transparent);
      color: var(--text-main);
      font-size: 11.5px;
      box-shadow: 0 8px 18px rgba(15, 23, 42, 0.16);
      backdrop-filter: blur(5px);
    }
    .wave-zoom-popover {
      position: absolute;
      right: 0;
      bottom: calc(100% + 8px);
      width: 230px;
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: color-mix(in oklab, var(--card-bg) 94%, var(--token-gap-bg) 6%);
      box-shadow: 0 16px 36px rgba(15, 23, 42, 0.26);
      cursor: default;
      z-index: 40;
    }
    .wave-zoom-popover[hidden] {
      display: none;
    }
    .wave-zoom-popover-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
      font-size: 12px;
      font-weight: 700;
    }
    .wave-zoom-popover-title button {
      min-width: 28px;
      padding: 3px 7px;
      border-radius: 999px;
      font-size: 12px;
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
        width: min(46vw, 500px);
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
      .floating-toggle.right.log-toggle {
        top: calc(var(--floating-toggle-top) + 62px);
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
        width: min(86vw, 520px);
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
      .floating-toggle.right.log-toggle {
        top: calc(var(--floating-toggle-top) + 62px);
      }
    }
  </style>
</head>
  <body>
  <input id="localImageUploadInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden />
  <input id="referenceImageUploadInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden />
  <div class="wrap">
    <div class="card toolbar-card">
        <div id="videoPreviewPanel" class="video-preview-panel" hidden>
          <div class="video-preview-frame">
            <video id="sourceVideo" preload="metadata" src="/source-video" playsinline muted disablepictureinpicture></video>
            <div id="compositePreviewOverlay" class="composite-preview-overlay" hidden></div>
          </div>
          <div class="video-preview-meta">
            <span>视频预览：画面跟随审核音频；如命中素材，会叠加显示合成预览。</span>
            <span id="videoPreviewStatus">未加载</span>
          </div>
        </div>
        <audio id="audio" controls preload="metadata" src="${audioName}" style="width: 100%"></audio>
        <div id="waveWrap" class="wave-wrap" title="点击波形可跳转播放位置">
          <canvas id="waveCanvas"></canvas>
          <div id="waveHint" class="wave-hint">波形加载中...</div>
          <div id="waveZoomControl" class="wave-zoom-control">
            <button id="btnWaveZoom" class="wave-zoom-button" type="button" title="点击展开波形缩放；也可以在波形上滚轮缩放">缩放 <span id="waveZoomText">1.0x</span></button>
            <div id="waveZoomPopover" class="wave-zoom-popover" hidden>
              <div class="wave-zoom-popover-title">
                <span>波形缩放</span>
                <button id="btnCloseWaveZoom" type="button" aria-label="收起波形缩放">×</button>
              </div>
              <input id="waveZoom" type="range" min="1" max="8" step="0.5" value="1" />
              <div class="meta">提示：鼠标滚轮也可以缩放波形。</div>
            </div>
          </div>
        </div>
      <div class="row primary-actions">
        <button id="btnPlay" class="primary">播放/暂停</button>
        <button id="btnClear">清空选择</button>
        <button id="btnCut" class="warn">执行裁剪</button>
        <select id="jianyingQuickTarget" class="compact-select jianying-quick-target" title="选择剪映导出位置或模板">
          <option value="auto" selected>默认剪映目录</option>
          <option value="project">当前项目目录</option>
        </select>
        <button id="btnExportJianyingDraft" type="button" class="warn">导出剪映</button>
        <select id="cutPrecisionMode" class="compact-select" title="只影响最终裁剪边界，不改变审核文本时间戳">
          <option value="conservative">保守</option>
          <option value="standard" selected>标准</option>
          <option value="clean">干净</option>
        </select>
        <span class="always-on-toggles" aria-label="常用显示开关">
          <button id="btnToggleVideoPreview" class="toggle-pill" type="button" aria-pressed="false" title="显示或隐藏右上角视频预览">视频</button>
          <button id="btnFocusReview" class="toggle-pill" type="button" aria-pressed="false" title="进入或退出专注审核模式">专注</button>
        </span>
        <span id="status" class="status">就绪</span>
      </div>
      <div id="selectionStats" class="toolbar-status-grid" aria-live="polite" aria-label="审核统计">
        <span class="status-chip status-chip-accent"><span>已删</span><strong id="statDeletedCount">0 段</strong></span>
        <span class="status-chip"><span>删除时长</span><strong id="statDeletedDuration">0.00 秒</strong></span>
        <span class="status-chip"><span>预计成片</span><strong id="statOutputDuration">0.00 秒</strong></span>
        <span class="status-chip"><span>原时长</span><strong id="statTotalDuration">0.00 秒</strong></span>
        <span class="status-chip"><span>模式</span><strong id="statCutMode">标准</strong></span>
      </div>
      <div id="exportStatus" class="meta export-status-inline"></div>
      <div id="deleteDiagnosticsPanel" class="delete-diagnostics" hidden></div>
      <details class="fold-panel tool-fold" id="reviewToolFold">
        <summary>审核工具面板（点击展开）</summary>
        <div class="tool-tabs" role="tablist" aria-label="审核工具分组">
          <button class="tool-tab active" type="button" data-tool-tab="marking" aria-selected="true">智能标记</button>
          <button class="tool-tab" type="button" data-tool-tab="correction" aria-selected="false">文本纠错</button>
          <button class="tool-tab" type="button" data-tool-tab="advanced" aria-selected="false">高级参数</button>
          <button class="tool-tab" type="button" data-tool-tab="more" aria-selected="false">更多状态</button>
        </div>
        <div class="tool-panel" data-tool-panel="marking">
          <div class="row tool-actions">
            <span class="meta tool-section-title">静音</span>
            <span class="meta">阈值(秒) &gt;=</span>
            <input id="silenceThreshold" type="number" min="0.2" step="0.05" value="0.2" />
            <button id="btnSelectSilence">按阈值选择静音</button>
            <label class="meta"><input id="toggleAutoFiller" type="checkbox" checked /> 自动标记语气词</label>
            <input id="fillerWordAllowList" class="filler-word-input" type="text" value="嗯,啊,呢,额,哦,呃,哎,哈哈" title="只自动标记这些语气词；删掉某个字后，该字不会被规则自动选中" />
            <label class="meta"><input id="toggleAutoRepeat" type="checkbox" checked /> 自动标记重复句</label>
          </div>
          <div class="row tool-actions">
            <span class="meta tool-section-title">LLM</span>
            <button id="btnLlmMark">LLM标记</button>
            <button id="btnApplyLlm">应用LLM建议</button>
            <button id="btnClearLlm">清除LLM标记</button>
          </div>
          <div id="qualityWarnings" class="quality-warnings" hidden></div>
        </div>
        <div class="tool-panel" data-tool-panel="correction" hidden>
          <div class="row tool-actions replace-actions">
            <span class="meta tool-section-title">纠错</span>
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
        </div>
        <div class="tool-panel" data-tool-panel="advanced" hidden>
          <div class="row compact-row boundary-row">
            <span class="meta tool-section-title">边界精修</span>
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
        </div>
        <div class="tool-panel" data-tool-panel="more" hidden>
          <div class="row tool-actions utility-actions">
            <span class="meta tool-section-title">工具</span>
            <button id="btnShowDeleteDiagnostics" type="button">删除诊断</button>
            <button id="btnCopyDiagnostics" type="button">复制诊断信息</button>
            <button id="btnShortcutHelp" type="button">快捷键指南</button>
          </div>
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
        </div>
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

  </div>

  <button id="btnToggleLeftPanel" class="floating-toggle left" type="button">发布建议</button>
  <button id="btnToggleImagePanel" class="floating-toggle left image-toggle" type="button">视频配图</button>
  <button id="btnToggleRightPanel" class="floating-toggle right" type="button">LLM对话</button>
  <button id="btnToggleLogPanel" class="floating-toggle right log-toggle" type="button">裁剪日志<span id="cutLogBadge" class="floating-badge" hidden></span></button>

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
      <span>\u63d2\u5165\u7d20\u6750</span>
      <div class="panel-actions">
        <button id="btnCloseImagePanel" class="panel-close" type="button">\u6536\u8d77</button>
      </div>
    </div>
    <div class="media-mode-tabs" role="tablist" aria-label="\u63d2\u5165\u7d20\u6750\u7c7b\u578b">
      <button id="btnMediaModeImage" class="media-mode-tab active" type="button" aria-selected="true">\u56fe\u7247\u914d\u56fe</button>
      <button id="btnMediaModeVideo" class="media-mode-tab" type="button" aria-selected="false">\u89c6\u9891\u7d20\u6750</button>
    </div>

    <section id="imageMediaPanel" class="media-mode-panel">
      <div class="media-control-grid media-control-grid-4">
        <label class="media-field">
          <span class="meta">\u6570\u91cf</span>
          <select id="imageCount">
            <option value="auto" selected>\u81ea\u52a8\u5339\u914d</option>
            <option value="6">6 \u5f20</option>
            <option value="8">8 \u5f20</option>
            <option value="10">10 \u5f20</option>
            <option value="12">12 \u5f20</option>
          </select>
        </label>
        <label class="media-field">
          <span class="meta">\u6bd4\u4f8b</span>
          <select id="imageAspect">
            <option value="1:1" selected>1:1 \u6b63\u65b9\u5f62\uff0c\u5934\u50cf</option>
            <option value="2:3">2:3 \u793e\u4ea4\u5a92\u4f53\uff0c\u81ea\u62cd</option>
            <option value="3:4">3:4 \u7ecf\u5178\u6bd4\u4f8b\uff0c\u62cd\u7167</option>
            <option value="4:3">4:3 \u6587\u7ae0\u914d\u56fe\uff0c\u63d2\u753b</option>
            <option value="9:16">9:16 \u624b\u673a\u58c1\u7eb8\uff0c\u4eba\u50cf</option>
            <option value="16:9">16:9 \u684c\u9762\u58c1\u7eb8\uff0c\u98ce\u666f</option>
          </select>
        </label>
        <label class="media-field">
          <span class="meta">\u98ce\u683c</span>
          <select id="imageStyle">
            <option value="portrait photography, realistic lens, premium lighting, consistent character clothing and scene texture">\u4eba\u50cf\u6444\u5f71</option>
            <option value="cinematic photo, film lighting, shallow depth of field, consistent character styling and atmosphere">\u7535\u5f71\u5199\u771f</option>
            <option value="Chinese aesthetic, oriental color palette, consistent costume and Chinese setting">\u4e2d\u56fd\u98ce</option>
            <option value="anime, clean line art, cel shading, consistent character design and storyboard rhythm">\u52a8\u6f2b</option>
            <option value="3D render, soft materials, refined character model, consistent scene and lighting">3D\u6e32\u67d3</option>
            <option value="cyberpunk, neon lighting, futuristic city, consistent high contrast color system">\u8d5b\u535a\u670b\u514b</option>
            <option value="CG animation, cinematic animation feel, consistent character design and clear action">CG \u52a8\u753b</option>
            <option value="ink wash painting, negative space composition, layered ink tones, oriental atmosphere">\u6c34\u58a8\u753b</option>
            <option value="oil painting, thick brush strokes, classical lighting, consistent tone and costume">\u6cb9\u753b</option>
            <option value="classical portrait and scene, soft light, vintage costume and space">\u53e4\u5178</option>
            <option value="watercolor painting, transparent watercolor, light paper texture, unified soft colors">\u6c34\u5f69\u753b</option>
            <option value="cartoon, bright shapes, consistent cute character, clean background">\u5361\u901a</option>
            <option value="flat illustration, clean geometry, unified palette, suitable for knowledge videos">\u5e73\u9762\u63d2\u753b</option>
            <option value="landscape, environmental storytelling, consistent natural light and atmosphere">\u98ce\u666f</option>
            <option value="Hong Kong style anime, retro film colors, manga line work, consistent character styling">\u6e2f\u98ce\u52a8\u6f2b</option>
            <option value="pixel art, retro pixel style, consistent palette and character silhouette">\u50cf\u7d20\u98ce\u683c</option>
            <option value="fluorescent painting, neon colors, glowing edges, consistent dark background">\u8367\u5149\u7ed8\u753b</option>
            <option value="colored pencil illustration, paper texture, warm restrained colors, consistent characters and clothing" selected>\u5f69\u94c5\u753b</option>
            <option value="designer toy figure, refined collectible texture, miniature scene, consistent character model">\u624b\u529e</option>
            <option value="children illustration, playful lines, soft colors, consistent simple scene">\u513f\u7ae5\u7ed8\u753b</option>
            <option value="abstract shapes and color blocks expressing the theme, unified visual symbols">\u62bd\u8c61</option>
            <option value="sharp pen illustration, crisp linework, premium composition, consistent character and scene">\u9510\u7b14\u63d2\u753b</option>
            <option value="Japanese anime style, delicate line art, consistent hair and clothing">\u4e8c\u6b21\u5143</option>
            <option value="ink print, coarse print texture, vintage colors, unified printmaking feel">\u6cb9\u58a8\u5370\u5237</option>
            <option value="woodcut print, high contrast black white or spot colors, unified texture">\u7248\u753b</option>
            <option value="Monet impressionist light, soft brushwork, unified atmospheric colors">\u83ab\u5948</option>
            <option value="Picasso cubist composition, unified geometric character and space">\u6bd5\u52a0\u7d22</option>
            <option value="Rembrandt classical chiaroscuro, dark background, unified portrait lighting">\u4f26\u52c3\u6717</option>
            <option value="Matisse bold color blocks, decorative composition, unified flat colors">\u9a6c\u8482\u65af</option>
            <option value="Baroque dramatic lighting, ornate costume, unified classical space">\u5df4\u6d1b\u514b</option>
            <option value="retro anime, film grain, old animation colors, consistent character design">\u590d\u53e4\u52a8\u6f2b</option>
            <option value="storybook illustration, warm narrative image, paper texture, consistent characters and scene">\u7ed8\u672c</option>
          </select>
        </label>
        <label class="media-field">
          <span class="meta">\u56fe\u7247\u52a8\u6548</span>
          <select id="imageMotionEffect">
            <option value="none" selected>\u65e0\u52a8\u6548</option>
            <option value="zoom-in">\u7f13\u6162\u63a8\u8fdb</option>
            <option value="zoom-out">\u7f13\u6162\u62c9\u8fdc</option>
            <option value="pan-left">\u7f13\u6162\u5de6\u79fb</option>
            <option value="pan-right">\u7f13\u6162\u53f3\u79fb</option>
            <option value="pan-up">\u7f13\u6162\u4e0a\u79fb</option>
            <option value="pan-down">\u7f13\u6162\u4e0b\u79fb</option>
          </select>
        </label>
      </div>
      <div class="media-panel-actions">
        <button id="btnGenerateImages" type="button">\u751f\u6210\u914d\u56fe</button>
        <button id="btnDownloadImages" type="button" disabled>\u6279\u91cf\u4e0b\u8f7d</button>
      </div>
      <div class="visual-reference-box">
        <div class="visual-reference-head">
          <span>\u8d44\u4ea7\u56fe\u53c2\u8003\u533a</span>
          <label><input id="useVisualReference" type="checkbox" checked /> \u751f\u6210\u65f6\u4f7f\u7528\u53c2\u8003</label>
        </div>
        <div class="media-panel-actions">
          <button id="btnGenerateVisualReference" type="button">\u89c4\u5212/\u751f\u6210\u8d44\u4ea7\u56fe</button>
          <button id="btnUploadVisualReference" type="button">\u4e0a\u4f20\u8d44\u4ea7\u56fe</button>
        </div>
        <div id="visualReferenceStatus" class="meta">\u70b9\u51fb\u201c\u751f\u6210\u914d\u56fe\u201d\u540e\uff0cLLM \u4f1a\u5148\u6309\u6545\u4e8b\u89c4\u5212\u4eba\u7269/\u573a\u666f\u8d44\u4ea7\u56fe\uff0c\u518d\u751f\u6210\u6b63\u5f0f\u914d\u56fe\u3002</div>
        <div id="visualReferencePreview" class="asset-reference-grid"><div class="asset-reference-empty">\u6682\u65e0\u8d44\u4ea7\u56fe\uff0c\u751f\u6210\u540e\u4ee5\u5c0f\u5361\u5c55\u793a\u3002</div></div>
        <textarea id="visualReferencePrompt" class="visual-reference-prompt" hidden></textarea>
      </div>
      <div id="imageStatus" class="meta">\u70b9\u51fb\u201c\u751f\u6210\u914d\u56fe\u201d\u540e\uff0c\u4f1a\u5148\u89c4\u5212\u914d\u56fe\u70b9\uff0c\u518d\u9010\u5f20\u8c03\u7528\u56fe\u7247 API \u751f\u6210\u9884\u89c8\u3002</div>
      <div id="imageCardList"></div>
    </section>

    <section id="videoMediaPanel" class="media-mode-panel media-video-section" hidden>
      <div class="panel-title">\u89c6\u9891\u7d20\u6750\uff08Agnes\uff09</div>
      <div class="media-control-grid">
        <label class="media-field">
          <span class="meta">\u6570\u91cf</span>
          <select id="videoAssetCount">
            <option value="1">1 \u6bb5</option>
            <option value="2">2 \u6bb5</option>
            <option value="3" selected>3 \u6bb5</option>
            <option value="4">4 \u6bb5</option>
          </select>
        </label>
        <label class="media-field">
          <span class="meta">\u6bd4\u4f8b</span>
          <select id="videoAssetAspect">
            <option value="16:9" selected>16:9 \u6a2a\u5c4f</option>
            <option value="9:16">9:16 \u7ad6\u5c4f</option>
            <option value="1:1">1:1 \u65b9\u5f62</option>
          </select>
        </label>
      </div>
      <div class="media-panel-actions single">
        <button id="btnGenerateVideos" type="button">\u751f\u6210\u89c6\u9891\u7d20\u6750</button>
      </div>
      <div id="videoAssetStatus" class="meta">\u70b9\u51fb\u540e\u4f1a\u5148\u7531 LLM \u89c4\u5212\u63d2\u5165\u4f4d\u7f6e\uff0c\u518d\u8c03\u7528 Agnes \u751f\u6210\u89c6\u9891\u7d20\u6750\u3002</div>
      <div id="videoAssetList"></div>
    </section>
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
    <textarea id="llmChatInput" placeholder="例如：保留开头铺垫，删除后半段重复表达；把第2张图换成漫画风格；把视频素材提前2秒；减少插图。"></textarea>
    <div class="row compact-row">
      <button id="btnLlmChatSend">发送并调整</button>
    </div>
    <div id="llmChatStatus" class="meta">可通过对话调整删除标记、插图和视频素材规划，不满意可撤回。</div>
  </aside>

  <aside class="side-panel floating-side right log-side">
    <div class="panel-header">
      <span>裁剪任务日志</span>
      <div class="panel-actions">
        <button id="btnCloseLogPanel" class="panel-close" type="button">收起</button>
      </div>
    </div>
    <div id="cutLogStatus" class="meta">暂无裁剪日志。执行裁剪后，这里会显示进度和错误详情。</div>
    <div id="logs"></div>
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
    const videoPreviewFrameEl = document.querySelector('.video-preview-frame');
    const compositePreviewOverlayEl = document.getElementById('compositePreviewOverlay');
    const videoPreviewStatusEl = document.getElementById('videoPreviewStatus');
    const content = document.getElementById('content');
    const contentViewportEl = document.getElementById('contentViewport');
    const statusEl = document.getElementById('status');
    const selectionStatsEl = document.getElementById('selectionStats');
    const statDeletedCountEl = document.getElementById('statDeletedCount');
    const statDeletedDurationEl = document.getElementById('statDeletedDuration');
    const statOutputDurationEl = document.getElementById('statOutputDuration');
    const statTotalDurationEl = document.getElementById('statTotalDuration');
    const statCutModeEl = document.getElementById('statCutMode');
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
    const btnWaveZoom = document.getElementById('btnWaveZoom');
    const btnCloseWaveZoom = document.getElementById('btnCloseWaveZoom');
    const waveZoomPopoverEl = document.getElementById('waveZoomPopover');
    const btnLlmMark = document.getElementById('btnLlmMark');
    const btnApplyLlm = document.getElementById('btnApplyLlm');
    const btnClearLlm = document.getElementById('btnClearLlm');
    const toggleAutoFillerEl = document.getElementById('toggleAutoFiller');
    const toggleAutoRepeatEl = document.getElementById('toggleAutoRepeat');
    const fillerWordAllowListEl = document.getElementById('fillerWordAllowList');
    const btnToggleVideoPreview = document.getElementById('btnToggleVideoPreview');
    const btnFocusReview = document.getElementById('btnFocusReview');
    const btnShowDeleteDiagnostics = document.getElementById('btnShowDeleteDiagnostics');
    const btnCopyDiagnostics = document.getElementById('btnCopyDiagnostics');
    const cutPrecisionModeEl = document.getElementById('cutPrecisionMode');
    const deleteDiagnosticsPanelEl = document.getElementById('deleteDiagnosticsPanel');
    const btnCut = document.getElementById('btnCut');
    const btnExportJianyingDraft = document.getElementById('btnExportJianyingDraft');
    const jianyingQuickTargetEl = document.getElementById('jianyingQuickTarget');
    const jianyingSubtitlePresetEl = document.getElementById('jianyingSubtitlePreset');
    const jianyingExportModeEl = document.getElementById('jianyingExportMode');
    const jianyingDraftRootEl = document.getElementById('jianyingDraftRoot');
    const jianyingDraftRootListEl = document.getElementById('jianyingDraftRootList');
    const jianyingTemplateDraftListEl = document.getElementById('jianyingTemplateDraftList');
    const jianyingTemplatePathEl = document.getElementById('jianyingTemplatePath');
    const btnDetectJianyingDraftRoot = document.getElementById('btnDetectJianyingDraftRoot');
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
    const toolTabEls = Array.from(document.querySelectorAll('[data-tool-tab]'));
    const toolPanelEls = Array.from(document.querySelectorAll('[data-tool-panel]'));
    const leftPanelEl = document.querySelector('.floating-side.left');
    const rightPanelEl = document.querySelector('.floating-side.right');
    const imagePanelEl = document.querySelector('.floating-side.image-side');
    const logPanelEl = document.querySelector('.floating-side.log-side');
    const btnToggleLeftPanel = document.getElementById('btnToggleLeftPanel');
    const btnToggleImagePanel = document.getElementById('btnToggleImagePanel');
    const btnToggleRightPanel = document.getElementById('btnToggleRightPanel');
    const btnToggleLogPanel = document.getElementById('btnToggleLogPanel');
    const btnCloseLeftPanel = document.getElementById('btnCloseLeftPanel');
    const btnCloseImagePanel = document.getElementById('btnCloseImagePanel');
    const btnCloseRightPanel = document.getElementById('btnCloseRightPanel');
    const btnCloseLogPanel = document.getElementById('btnCloseLogPanel');
    const cutLogBadgeEl = document.getElementById('cutLogBadge');
    const cutLogStatusEl = document.getElementById('cutLogStatus');
    const btnGeneratePublish = document.getElementById('btnGeneratePublish');
    const btnMediaModeImage = document.getElementById('btnMediaModeImage');
    const btnMediaModeVideo = document.getElementById('btnMediaModeVideo');
    const imageMediaPanelEl = document.getElementById('imageMediaPanel');
    const videoMediaPanelEl = document.getElementById('videoMediaPanel');
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
    const localImageUploadInputEl = document.getElementById('localImageUploadInput');
    const referenceImageUploadInputEl = document.getElementById('referenceImageUploadInput');
    const useVisualReferenceEl = document.getElementById('useVisualReference');
    const visualReferencePreviewEl = document.getElementById('visualReferencePreview');
    const visualReferencePromptEl = document.getElementById('visualReferencePrompt');
    const visualReferenceStatusEl = document.getElementById('visualReferenceStatus');
    const btnGenerateVisualReference = document.getElementById('btnGenerateVisualReference');
    const btnUploadVisualReference = document.getElementById('btnUploadVisualReference');
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

    function getEnabledFillerWords() {
      const raw = fillerWordAllowListEl ? String(fillerWordAllowListEl.value || '') : '';
      return new Set(raw
        .split(/[\s,，、;；|]+/)
        .map((item) => item.trim())
        .filter(Boolean));
    }

    function isAutoRuleCategoryEnabled(category, wordText) {
      if (category === 'filler' && toggleAutoFillerEl) {
        if (!toggleAutoFillerEl.checked) return false;
        const words = getEnabledFillerWords();
        if (!words.size) return false;
        const normalized = String(wordText || '').trim();
        return words.has(normalized);
      }
      if (category === 'repeat' && toggleAutoRepeatEl) return !!toggleAutoRepeatEl.checked;
      return true;
    }

    function applyAutoRulePreferences(addEnabledRules) {
      let changed = 0;
      autoSet.forEach((idx) => {
        const w = WORDS[idx] || {};
        const cat = reasonCategory(autoReasonByIndex.get(idx), !!w.isGap) || 'silence';
        const enabled = isAutoRuleCategoryEnabled(cat, w.text);
        if (!enabled) {
          if (selected.delete(idx)) changed += 1;
          return;
        }
        if (addEnabledRules && !selected.has(idx)) {
          selected.add(idx);
          changed += 1;
        }
      });
      if (changed) {
        autoSet.forEach((idx) => refreshToken(idx));
        refreshIdleStatus();
        scheduleReviewStateSave(180);
      }
      return changed;
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
    let skipFadeRaf = null;
    let skipFadeTimer = null;
    let skipFadeRestoreVolume = null;
    let latestCutLogTail = [];
    let runtimeInfoCache = null;
    let publishLoading = false;
    let llmChatSubmitting = false;
    let imageGenerating = false;
    let videoGenerating = false;
    let imageItems = [];
    let videoItems = [];
    let visualReference = {
      enabled: true,
      status: 'empty',
      prompt: '',
      negativePrompt: '',
      image: null,
      assets: [],
      source: '',
    };
    let activeCompositePreviewKey = '';
    let compositePreviewRaf = null;
    let lastVideoPreviewSeekAt = 0;
    const VIDEO_PREVIEW_PLAYING_SEEK_TOLERANCE = 1.25;
    const VIDEO_PREVIEW_FORCE_SEEK_INTERVAL_MS = 1400;
    const VIDEO_PREVIEW_SOFT_SYNC_TOLERANCE = 0.18;
    let pendingImageUploadIndex = -1;
    let imageAspectUserChanged = false;
    let videoAspectUserChanged = false;
    let sourceVideoMetaLabel = '';
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
    let logPanelOpen = false;

    function setStatus(msg) {
      statusEl.textContent = msg;
    }

    function setWaveZoomPopoverOpen(open) {
      if (!waveZoomPopoverEl) return;
      waveZoomPopoverEl.hidden = !open;
      if (btnWaveZoom) btnWaveZoom.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function setToolPanel(name) {
      const activeName = String(name || 'marking');
      toolTabEls.forEach((tab) => {
        const isActive = tab.dataset.toolTab === activeName;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      toolPanelEls.forEach((panel) => {
        panel.hidden = panel.dataset.toolPanel !== activeName;
      });
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
      const anyRightPanelOpen = rightPanelOpen || logPanelOpen;
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
        btnToggleRightPanel.classList.toggle('hidden', anyRightPanelOpen);
        btnToggleRightPanel.textContent = 'LLM对话';
      }
      if (btnToggleLogPanel) {
        btnToggleLogPanel.classList.toggle('active', logPanelOpen);
        btnToggleLogPanel.classList.toggle('hidden', anyRightPanelOpen);
      }
    }

    function setPanelOpen(side, open) {
      if (side === 'image') {
        imagePanelOpen = !!open;
        if (imagePanelOpen) {
          leftPanelOpen = false;
          rightPanelOpen = false;
          logPanelOpen = false;
        }
      } else if (side === 'left') {
        leftPanelOpen = !!open;
        if (leftPanelOpen) {
          imagePanelOpen = false;
          rightPanelOpen = false;
          logPanelOpen = false;
        }
      } else if (side === 'log') {
        logPanelOpen = !!open;
        if (logPanelOpen) {
          leftPanelOpen = false;
          imagePanelOpen = false;
          rightPanelOpen = false;
        }
      } else {
        rightPanelOpen = !!open;
        if (rightPanelOpen) {
          leftPanelOpen = false;
          imagePanelOpen = false;
          logPanelOpen = false;
        }
      }
      if (leftPanelEl) leftPanelEl.classList.toggle('open', leftPanelOpen);
      if (imagePanelEl) imagePanelEl.classList.toggle('open', imagePanelOpen);
      if (rightPanelEl) rightPanelEl.classList.toggle('open', rightPanelOpen);
      if (logPanelEl) logPanelEl.classList.toggle('open', logPanelOpen);
      syncFloatingToggles();
    }

    function closePanels() {
      setPanelOpen('left', false);
      setPanelOpen('image', false);
      setPanelOpen('right', false);
      setPanelOpen('log', false);
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

    function setVisualReferenceStatus(text) {
      if (!visualReferenceStatusEl) return;
      visualReferenceStatusEl.textContent = String(text || '');
    }

    function normalizeReferenceAsset(asset, index = 0) {
      const raw = asset && typeof asset === 'object' ? asset : {};
      const image = raw.image && typeof raw.image === 'object' ? JSON.parse(JSON.stringify(raw.image)) : null;
      return {
        id: String(raw.id || ('asset_' + (index + 1))).replace(/[^\w-]+/g, '_').slice(0, 40),
        type: ['character', 'scene', 'object', 'style'].includes(String(raw.type || '').toLowerCase())
          ? String(raw.type || '').toLowerCase()
          : (index === 0 ? 'character' : 'scene'),
        title: String(raw.title || raw.name || ('\u8d44\u4ea7\u56fe ' + (index + 1))).slice(0, 60),
        role: String(raw.role || raw.purpose || '').slice(0, 120),
        prompt: String(raw.prompt || '').slice(0, 1600),
        negativePrompt: String(raw.negativePrompt || raw.negative_prompt || '').slice(0, 500),
        aspectRatio: String(raw.aspectRatio || raw.aspect || '1:1').slice(0, 20),
        status: String(raw.status || (image?.url ? 'done' : (raw.prompt ? 'planned' : 'empty'))).slice(0, 24),
        source: String(raw.source || '').slice(0, 80),
        image,
        error: String(raw.error || '').slice(0, 500),
      };
    }

    function normalizeReferenceAssets(value) {
      const list = Array.isArray(value) ? value : [];
      return list.map((asset, index) => normalizeReferenceAsset(asset, index)).slice(0, 8);
    }

    function cloneVisualReference(value) {
      try {
        const raw = value && typeof value === 'object' ? value : {};
        const legacyImage = raw.image && typeof raw.image === 'object' ? JSON.parse(JSON.stringify(raw.image)) : null;
        const assets = normalizeReferenceAssets(raw.assets);
        if (!assets.length && legacyImage) {
          assets.push(normalizeReferenceAsset({
            id: 'asset_1',
            type: 'character',
            title: raw.title || '\u4eba\u7269\u573a\u666f\u53c2\u8003',
            prompt: raw.prompt || '',
            negativePrompt: raw.negativePrompt || '',
            status: 'done',
            source: raw.source || 'legacy',
            image: legacyImage,
          }, 0));
        }
        return {
          enabled: raw.enabled !== false,
          status: String(raw.status || (assets.some((asset) => asset.image?.url) ? 'done' : (raw.prompt ? 'planned' : 'empty'))).slice(0, 24),
          prompt: String(raw.prompt || '').slice(0, 1600),
          negativePrompt: String(raw.negativePrompt || '').slice(0, 500),
          image: legacyImage || (assets.find((asset) => asset.image?.url)?.image || null),
          assets,
          source: String(raw.source || '').slice(0, 80),
        };
      } catch {
        return { enabled: true, status: 'empty', prompt: '', negativePrompt: '', image: null, assets: [], source: '' };
      }
    }

    function renderVisualReference() {
      if (useVisualReferenceEl) useVisualReferenceEl.checked = visualReference.enabled !== false;
      const assets = normalizeReferenceAssets(visualReference.assets);
      visualReference.assets = assets;
      const promptText = String(visualReference.prompt || assets.map((asset) => asset.prompt).filter(Boolean).join('\\n\\n')).slice(0, 1600);
      if (visualReferencePromptEl && visualReferencePromptEl.value !== promptText) {
        visualReferencePromptEl.value = promptText;
      }
      if (visualReferencePreviewEl) {
        visualReferencePreviewEl.innerHTML = '';
        if (assets.length) {
          assets.forEach((asset, index) => {
            const card = document.createElement('div');
            card.className = 'asset-reference-card';
            card.dataset.refIndex = String(index);
            const thumb = document.createElement('div');
            thumb.className = 'asset-reference-thumb';
            if (asset.image?.url) {
              const img = document.createElement('img');
              img.src = asset.image.url;
              img.alt = asset.title || '\u8d44\u4ea7\u56fe\u53c2\u8003';
              thumb.appendChild(img);
              attachMediaDimensionBadge(thumb, img, 'image', asset.image);
            } else {
              thumb.textContent = asset.status === 'generating' ? '\u751f\u6210\u4e2d' : (asset.status === 'error' ? '\u5931\u8d25' : '\u5f85\u751f\u6210');
            }
            const caption = document.createElement('div');
            caption.className = 'asset-reference-caption';
            const actions = document.createElement('div');
            actions.className = 'asset-reference-actions';
            const previewBtn = document.createElement('button');
            previewBtn.type = 'button';
            previewBtn.dataset.refPreview = String(index);
            previewBtn.textContent = '看';
            previewBtn.title = '预览资产图';
            previewBtn.disabled = !asset.image?.url;
            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.dataset.refDelete = String(index);
            deleteBtn.textContent = '×';
            deleteBtn.title = '删除资产图';
            actions.appendChild(previewBtn);
            actions.appendChild(deleteBtn);
            const kind = document.createElement('span');
            kind.className = 'asset-reference-kind';
            kind.textContent = asset.type === 'character' ? '\u4eba\u7269' : (asset.type === 'scene' ? '\u573a\u666f' : '\u8d44\u4ea7');
            caption.appendChild(kind);
            caption.appendChild(document.createTextNode(asset.title || ('\u8d44\u4ea7\u56fe ' + (index + 1))));
            if (asset.status === 'error' && asset.error) {
              const err = document.createElement('div');
              err.className = 'meta';
              err.textContent = '\u5931\u8d25\uff1a' + asset.error;
              caption.appendChild(err);
            }
            card.appendChild(actions);
            card.appendChild(thumb);
            card.appendChild(caption);
            visualReferencePreviewEl.appendChild(card);
          });
        } else {
          const empty = document.createElement('div');
          empty.className = 'asset-reference-empty';
          empty.textContent = visualReference.status === 'generating'
            ? '\u6b63\u5728\u89c4\u5212/\u751f\u6210\u8d44\u4ea7\u56fe...'
            : '\u6682\u65e0\u8d44\u4ea7\u56fe\u3002\u70b9\u51fb\u201c\u751f\u6210\u914d\u56fe\u201d\u6216\u201c\u89c4\u5212/\u751f\u6210\u8d44\u4ea7\u56fe\u201d\u540e\uff0c\u4ee5\u4eba\u7269/\u573a\u666f\u5c0f\u5361\u7247\u5c55\u793a\u3002';
          visualReferencePreviewEl.appendChild(empty);
        }
      }
      if (btnGenerateVisualReference) {
        btnGenerateVisualReference.disabled = visualReference.status === 'generating' || imageGenerating;
        btnGenerateVisualReference.textContent = visualReference.status === 'generating' ? '\u751f\u6210\u4e2d...' : '\u89c4\u5212/\u751f\u6210\u8d44\u4ea7\u56fe';
      }
      if (btnUploadVisualReference) {
        btnUploadVisualReference.disabled = visualReference.status === 'generating' || imageGenerating;
      }
      const readyCount = assets.filter((asset) => asset.image?.url).length;
      if (readyCount) {
        setVisualReferenceStatus('\u8d44\u4ea7\u56fe\u5df2\u5c31\u7eea\uff1a' + readyCount + '/' + assets.length + ' \u5f20\u3002\u6b63\u5f0f\u914d\u56fe/\u89c6\u9891\u4f1a\u5c1d\u8bd5\u7528\u5b83\u4fdd\u6301\u4eba\u7269\u3001\u573a\u666f\u548c\u98ce\u683c\u4e00\u81f4\u3002');
      } else if (assets.length) {
        setVisualReferenceStatus('\u5df2\u89c4\u5212 ' + assets.length + ' \u5f20\u8d44\u4ea7\u56fe\uff0c\u53ef\u7ee7\u7eed\u751f\u6210\u6216\u4e0a\u4f20\u8865\u5145\u3002');
      } else if (visualReference.prompt) {
        setVisualReferenceStatus('\u53c2\u8003\u8bbe\u5b9a\u5df2\u751f\u6210\uff0c\u53ef\u7ee7\u7eed\u751f\u6210\u8d44\u4ea7\u56fe\u3002');
      }
    }

    function openAssetPreview(index) {
      const asset = normalizeReferenceAssets(visualReference.assets)[index];
      const imageUrl = asset?.image?.url;
      if (!imageUrl) return;
      let backdrop = document.getElementById('assetPreviewBackdrop');
      if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.id = 'assetPreviewBackdrop';
        backdrop.className = 'asset-preview-backdrop';
        backdrop.innerHTML = '<div class="asset-preview-dialog" role="dialog" aria-modal="true"><header><span></span><button type="button">关闭</button></header><img alt="资产图预览" /></div>';
        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', (event) => {
          if (event.target === backdrop || event.target.tagName === 'BUTTON') {
            backdrop.hidden = true;
          }
        });
      }
      const titleEl = backdrop.querySelector('header span');
      const imgEl = backdrop.querySelector('img');
      if (titleEl) titleEl.textContent = asset.title || ('资产图 ' + (index + 1));
      if (imgEl) imgEl.src = imageUrl;
      backdrop.hidden = false;
    }

    function deleteVisualReferenceAsset(index) {
      const assets = normalizeReferenceAssets(visualReference.assets);
      if (!Number.isInteger(index) || index < 0 || index >= assets.length) return;
      const removed = assets.splice(index, 1)[0];
      visualReference.assets = assets;
      visualReference.image = assets.find((asset) => asset.image?.url)?.image || null;
      visualReference.status = assets.some((asset) => asset.image?.url) ? 'done' : (assets.length ? 'planned' : 'empty');
      renderVisualReference();
      setVisualReferenceStatus('已删除资产图：' + (removed?.title || ('资产图 ' + (index + 1))));
      scheduleReviewStateSave(160);
    }

    function getActiveReferenceImages() {
      if (visualReference.enabled === false) return [];
      return normalizeReferenceAssets(visualReference.assets)
        .map((asset) => asset.image)
        .filter((image) => image && image.url)
        .slice(0, 4);
    }

    function getActiveReferenceAssets() {
      if (visualReference.enabled === false) return [];
      return normalizeReferenceAssets(visualReference.assets).filter((asset) => asset.image?.url);
    }

    function getStoryboardTextForItem(item) {
      return [
        item?.title,
        item?.purpose,
        item?.textBasis,
        item?.sceneStory,
        item?.visual,
        item?.camera,
        item?.prompt,
        item?.videoPrompt,
      ].map((value) => String(value || '')).join(' ');
    }

    function tokenOverlapScore(source, target) {
      const a = String(source || '').toLowerCase();
      const b = String(target || '').toLowerCase();
      if (!a || !b) return 0;
      const chunks = a
        .split(/[^\u4e00-\u9fa5a-z0-9]+/i)
        .map((part) => part.trim())
        .filter((part) => part.length >= 2)
        .slice(0, 60);
      let score = 0;
      chunks.forEach((part) => {
        if (b.includes(part)) score += Math.min(6, Math.max(1, part.length / 2));
      });
      return score;
    }

    function scoreReferenceAssetForItem(asset, item) {
      const text = getStoryboardTextForItem(item);
      const lower = text.toLowerCase();
      let score = asset.image?.url ? 2 : 0;
      if (asset.type === 'character' && /人物|主角|角色|人像|男|女|孩子|老人|青年|character|person|woman|man|girl|boy/i.test(text)) score += 8;
      if (asset.type === 'scene' && /场景|环境|空间|城市|房间|街道|窗边|室内|室外|scene|environment|street|room|city/i.test(text)) score += 8;
      if (/封面|表情|情绪|肖像|半身|脸|portrait/i.test(lower) && asset.type === 'character') score += 5;
      score += tokenOverlapScore([asset.title, asset.role, asset.prompt].join(' '), text);
      return score;
    }

    function getReferenceImagesForItem(item, limit = 2) {
      const assets = getActiveReferenceAssets();
      if (!assets.length) return [];
      return assets
        .map((asset, index) => ({ asset, index, score: scoreReferenceAssetForItem(asset, item) }))
        .sort((a, b) => (b.score - a.score) || (a.index - b.index))
        .slice(0, Math.max(1, limit))
        .map((entry) => entry.asset.image)
        .filter((image) => image && image.url);
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
      renderVisualReference();
    }

    function currentImageMotionEffect() {
      const value = String(imageMotionEffectEl ? imageMotionEffectEl.value : 'none');
      return sanitizeImageMotionEffect(value);
    }

    function sanitizeImageMotionEffect(value) {
      const next = String(value || 'none');
      return ['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down'].includes(next) ? next : 'none';
    }

    function clampDuration(value, min, max, fallback) {
      const parsed = Number(value);
      const next = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
      return Math.max(min, Math.min(max, next));
    }

    function aspectRatioToCss(value, fallback = '1:1') {
      const raw = String(value || fallback || '').trim();
      const match = raw.match(/(\\d+(?:\\.\\d+)?)\\s*(?::|\\/)\\s*(\\d+(?:\\.\\d+)?)/);
      if (match) {
        const width = Number(match[1]);
        const height = Number(match[2]);
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
          return width + ' / ' + height;
        }
      }
      const fallbackMatch = String(fallback || '1:1').match(/(\\d+(?:\\.\\d+)?)\\s*(?::|\\/)\\s*(\\d+(?:\\.\\d+)?)/);
      return fallbackMatch ? (fallbackMatch[1] + ' / ' + fallbackMatch[2]) : '1 / 1';
    }

    function setMediaMode(mode) {
      const next = mode === 'video' ? 'video' : 'image';
      if (imageMediaPanelEl) imageMediaPanelEl.hidden = next !== 'image';
      if (videoMediaPanelEl) videoMediaPanelEl.hidden = next !== 'video';
      if (btnMediaModeImage) {
        btnMediaModeImage.classList.toggle('active', next === 'image');
        btnMediaModeImage.setAttribute('aria-selected', next === 'image' ? 'true' : 'false');
      }
      if (btnMediaModeVideo) {
        btnMediaModeVideo.classList.toggle('active', next === 'video');
        btnMediaModeVideo.setAttribute('aria-selected', next === 'video' ? 'true' : 'false');
      }
    }

    function formatTimeRange(start, end) {
      const fmt = (sec) => {
        const n = Math.max(0, Number(sec) || 0);
        const m = Math.floor(n / 60);
        const s = Math.floor(n % 60);
        return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      };
      return fmt(start) + '-' + fmt(end);
    }

    function normalizeImageItemTiming(item) {
      if (!item) return item;
      const start = Math.max(0, Number(item.start) || 0);
      const durationSec = clampDuration(item.durationSec || item.duration || ((Number(item.end) || 0) - start), 5, 10, 7);
      item.start = start;
      item.durationSec = Number(durationSec.toFixed(2));
      item.end = Number((start + durationSec).toFixed(3));
      item.timeRange = formatTimeRange(item.start, item.end);
      item.motionEffect = sanitizeImageMotionEffect(item.motionEffect);
      return item;
    }

    function normalizeVideoItemTiming(item) {
      if (!item) return item;
      const start = Math.max(0, Number(item.start) || 0);
      const durationSec = clampDuration(item.durationSec || item.duration || ((Number(item.end) || 0) - start), 3, 8, 5);
      item.start = start;
      item.durationSec = Number(durationSec.toFixed(2));
      item.end = Number((start + durationSec).toFixed(3));
      item.timeRange = formatTimeRange(item.start, item.end);
      return item;
    }

    function normalizeMediaItemTiming() {
      imageItems.forEach(normalizeImageItemTiming);
      videoItems.forEach(normalizeVideoItemTiming);
    }

    function isValidMediaRange(item) {
      const start = Number(item?.start);
      const end = Number(item?.end);
      return Number.isFinite(start) && Number.isFinite(end) && end > start;
    }

    function collectMediaRanges(excludeType = '') {
      const ranges = [];
      if (excludeType !== 'image') {
        imageItems.forEach((item) => {
          normalizeImageItemTiming(item);
          if (isValidMediaRange(item)) ranges.push({ type: 'image', start: item.start, end: item.end, title: item.title || '' });
        });
      }
      if (excludeType !== 'video') {
        videoItems.forEach((item) => {
          normalizeVideoItemTiming(item);
          if (isValidMediaRange(item)) ranges.push({ type: 'video', start: item.start, end: item.end, title: item.title || '' });
        });
      }
      return ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    }

    function collectDeletedPlacementRanges() {
      return mergedSegmentsFromSelection().map((seg, index) => ({
        type: 'delete',
        start: Number(seg.start),
        end: Number(seg.end),
        title: '\u5df2\u6807\u8bb0\u5220\u9664\u7247\u6bb5 ' + (index + 1),
      })).filter(isValidMediaRange);
    }

    function collectPlacementBlockedRanges(excludeType = '') {
      return [
        ...collectMediaRanges(excludeType),
        ...collectDeletedPlacementRanges(),
      ].sort((a, b) => a.start - b.start || a.end - b.end);
    }

    function rangesOverlap(aStart, aEnd, bStart, bEnd, gap = 0.12) {
      return aStart < (bEnd + gap) && aEnd > (bStart - gap);
    }

    function findNonOverlappingStart(preferredStart, durationSec, blockedRanges, totalDuration) {
      const duration = Math.max(0.5, Number(durationSec) || 1);
      const total = Math.max(duration, Number(totalDuration) || getAudioTotalDuration() || duration + 1);
      const maxStart = Math.max(0, total - duration);
      const clampStart = (value) => Math.max(0, Math.min(maxStart, Number(value) || 0));
      const sorted = (Array.isArray(blockedRanges) ? blockedRanges : [])
        .filter(isValidMediaRange)
        .sort((a, b) => a.start - b.start || a.end - b.end);
      const fits = (start) => !sorted.some((range) => rangesOverlap(start, start + duration, range.start, range.end));
      const preferred = clampStart(preferredStart);
      if (fits(preferred)) return preferred;
      const candidates = [];
      sorted.forEach((range) => {
        candidates.push(clampStart((Number(range.end) || 0) + 0.18));
        candidates.push(clampStart((Number(range.start) || 0) - duration - 0.18));
      });
      candidates.push(0, maxStart);
      candidates.sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred));
      const found = candidates.find(fits);
      return Number.isFinite(found) ? found : preferred;
    }

    function collectMediaRangesExcept(kind, id) {
      const skipKind = String(kind || '');
      const skipId = String(id || '');
      const ranges = [];
      imageItems.forEach((item) => {
        normalizeImageItemTiming(item);
        if (skipKind === 'image' && String(item.id || '') === skipId) return;
        if (isValidMediaRange(item)) ranges.push({ type: 'image', start: item.start, end: item.end, title: item.title || '' });
      });
      videoItems.forEach((item) => {
        normalizeVideoItemTiming(item);
        if (skipKind === 'video' && String(item.id || '') === skipId) return;
        if (isValidMediaRange(item)) ranges.push({ type: 'video', start: item.start, end: item.end, title: item.title || '' });
      });
      ranges.push(...collectDeletedPlacementRanges());
      return ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    }

    function nextMediaId(kind) {
      const prefix = kind === 'video' ? 'vid_chat_' : 'img_chat_';
      const items = kind === 'video' ? videoItems : imageItems;
      const used = new Set(items.map((item) => String(item.id || '')));
      let index = items.length + 1;
      let id = prefix + String(index).padStart(2, '0');
      while (used.has(id)) {
        index += 1;
        id = prefix + String(index).padStart(2, '0');
      }
      return id;
    }

    function safeMediaText(value, maxLen) {
      return String(value || '').trim().slice(0, Number(maxLen) || 200);
    }

    function normalizeMediaActionType(rawType) {
      const value = String(rawType || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
      const aliases = {
        image_add: 'add_image',
        picture_add: 'add_image',
        add_picture: 'add_image',
        add_pic: 'add_image',
        add_photo: 'add_image',
        add_visual: 'add_image',
        image_update: 'update_image',
        edit_image: 'update_image',
        modify_image: 'update_image',
        change_image: 'update_image',
        replace_image: 'update_image',
        update_picture: 'update_image',
        replace_picture: 'update_image',
        image_move: 'move_image',
        shift_image: 'move_image',
        retime_image: 'move_image',
        image_delete: 'delete_image',
        remove_image: 'delete_image',
        delete_picture: 'delete_image',
        remove_picture: 'delete_image',
        image_regenerate: 'regenerate_image',
        retry_image: 'regenerate_image',
        reroll_image: 'regenerate_image',
        regenerate_picture: 'regenerate_image',
        video_add: 'add_video',
        add_broll: 'add_video',
        add_b_roll: 'add_video',
        video_update: 'update_video',
        edit_video: 'update_video',
        modify_video: 'update_video',
        change_video: 'update_video',
        replace_video: 'update_video',
        video_move: 'move_video',
        shift_video: 'move_video',
        retime_video: 'move_video',
        video_delete: 'delete_video',
        remove_video: 'delete_video',
        video_regenerate: 'regenerate_video',
        retry_video: 'regenerate_video',
        reroll_video: 'regenerate_video',
      };
      return aliases[value] || value;
    }

    function applyMediaTimingFromAction(item, action, kind) {
      const minDuration = kind === 'video' ? 3 : 5;
      const maxDuration = kind === 'video' ? 8 : 10;
      const fallbackDuration = kind === 'video' ? 5 : 7;
      const rawDuration = Number(action.durationSec || action.duration || ((Number(action.end) || 0) - (Number(action.start) || 0)));
      const durationSec = clampDuration(rawDuration, minDuration, maxDuration, item.durationSec || fallbackDuration);
      const hasStart = Number.isFinite(Number(action.start)) && Number(action.start) >= 0;
      if (hasStart || !isValidMediaRange(item)) {
        const preferredStart = hasStart ? Number(action.start) : Number(item.start || 0);
        const start = findNonOverlappingStart(preferredStart, durationSec, collectMediaRangesExcept(kind, item.id), getAudioTotalDuration());
        item.start = Number(start.toFixed(3));
        item.durationSec = Number(durationSec.toFixed(2));
        item.end = Number((item.start + durationSec).toFixed(3));
      } else if (Number.isFinite(durationSec) && durationSec > 0) {
        item.durationSec = Number(durationSec.toFixed(2));
        item.end = Number((Number(item.start) + durationSec).toFixed(3));
      }
      if (kind === 'video') normalizeVideoItemTiming(item);
      else normalizeImageItemTiming(item);
    }

    function applyMediaAction(action) {
      if (!action || typeof action !== 'object') return false;
      const type = normalizeMediaActionType(action.type || action.action || action.operation || action.op);
      const isVideo = type.includes('video');
      const kind = isVideo ? 'video' : 'image';
      const items = isVideo ? videoItems : imageItems;
      const id = safeMediaText(action.id || action.mediaId, 64).replace(/[^\w-]/g, '_');
      const isAdd = type === 'add_image' || type === 'add_video';
      const isDelete = type === 'delete_image' || type === 'delete_video';
      const isMove = type === 'move_image' || type === 'move_video';
      const isUpdate = type === 'update_image' || type === 'update_video';
      const isRegenerate = type === 'regenerate_image' || type === 'regenerate_video' || !!action.regenerate;
      if (!isAdd && !isDelete && !isMove && !isUpdate && !isRegenerate) return false;

      let item = id ? items.find((entry) => String(entry.id || '') === id) : null;
      if (!item && Number.isFinite(Number(action.index ?? action.ordinal ?? action.no))) {
        const index = Math.max(0, Math.floor(Number(action.index ?? action.ordinal ?? action.no)) - 1);
        item = items[index] || null;
      }
      if (isDelete) {
        if (!item) return false;
        const index = items.indexOf(item);
        if (index >= 0) items.splice(index, 1);
        return true;
      }

      if (!item && isAdd) {
        item = {
          id: id || nextMediaId(kind),
          title: kind === 'video' ? 'LLM video asset' : 'LLM image asset',
          purpose: '',
          textBasis: '',
          directorIntent: '',
          sceneStory: '',
          camera: '',
          prompt: '',
          videoPrompt: '',
          negativePrompt: '',
          aspectRatio: kind === 'video'
            ? String(videoAssetAspectEl?.value || '16:9')
            : String(imageAspectEl?.value || '1:1'),
          motionEffect: kind === 'image' ? currentImageMotionEffect() : 'none',
          status: 'queued',
        };
        items.push(item);
      }
      if (!item) return false;

      const beforePrompt = kind === 'video' ? String(item.videoPrompt || item.prompt || '') : String(item.prompt || '');
      const fields = [
        ['title', 80],
        ['purpose', 140],
        ['textBasis', 160],
        ['directorIntent', 240],
        ['sceneStory', 420],
        ['camera', 260],
        ['negativePrompt', 600],
        ['aspectRatio', 20],
        ['motionEffect', 20],
      ];
      fields.forEach(([field, maxLen]) => {
        if (action[field] !== undefined) item[field] = safeMediaText(action[field], maxLen);
      });
      if (kind === 'image') item.motionEffect = sanitizeImageMotionEffect(item.motionEffect);
      if (action.prompt !== undefined || action.imagePrompt !== undefined) {
        item.prompt = safeMediaText(action.prompt || action.imagePrompt, 1800);
      }
      if (action.videoPrompt !== undefined) {
        item.videoPrompt = safeMediaText(action.videoPrompt, 1800);
      }
      if (kind === 'video' && !item.videoPrompt && item.prompt) item.videoPrompt = item.prompt;
      if (kind === 'image' && !item.prompt && item.sceneStory) item.prompt = item.sceneStory;

      if (action.start !== undefined || action.end !== undefined || action.durationSec !== undefined || action.duration !== undefined || !isValidMediaRange(item)) {
        applyMediaTimingFromAction(item, action, kind);
      } else if (kind === 'video') {
        normalizeVideoItemTiming(item);
      } else {
        normalizeImageItemTiming(item);
      }

      const afterPrompt = kind === 'video' ? String(item.videoPrompt || item.prompt || '') : String(item.prompt || '');
      if (isRegenerate || beforePrompt !== afterPrompt || isAdd) {
        if (kind === 'video') delete item.video;
        else delete item.image;
        item.status = 'queued';
        item.error = '';
      }
      return true;
    }

    function applyMediaActions(actions) {
      if (!Array.isArray(actions) || !actions.length) return 0;
      let changed = 0;
      actions.forEach((action) => {
        if (applyMediaAction(action)) changed += 1;
      });
      if (changed) {
        normalizeMediaItemTiming();
        renderImageCards();
        renderVideoAssetCards();
        syncCompositePreviewOverlay();
        setImageStatus('LLM 已调整图片素材规划，可按需重新生成。');
        setVideoAssetStatus('LLM 已调整视频素材规划，可按需重新生成。');
      }
      return changed;
    }

    function applyNonOverlappingSchedule(items, type, extraBlockedRanges = []) {
      if (!Array.isArray(items) || !items.length) return items;
      const total = getAudioTotalDuration();
      const blocked = Array.isArray(extraBlockedRanges) ? [...extraBlockedRanges] : [];
      const normalize = type === 'video' ? normalizeVideoItemTiming : normalizeImageItemTiming;
      items.forEach((item) => {
        normalize(item);
        const duration = type === 'video'
          ? clampDuration(item.durationSec, 3, 8, 5)
          : clampDuration(item.durationSec, 5, 10, 7);
        const nextStart = findNonOverlappingStart(item.start, duration, blocked, total);
        item.start = Number(nextStart.toFixed(3));
        item.durationSec = Number(duration.toFixed(2));
        item.end = Number((item.start + duration).toFixed(3));
        item.timeRange = formatTimeRange(item.start, item.end);
        blocked.push({ type, start: item.start, end: item.end, title: item.title || '' });
      });
      return items;
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

    function cloneMediaItems(items) {
      try {
        return JSON.parse(JSON.stringify(Array.isArray(items) ? items : []));
      } catch (e) {
        return [];
      }
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
        mediaAssets: {
          images: cloneMediaItems(imageItems),
          videos: cloneMediaItems(videoItems),
          visualReference: cloneVisualReference(visualReference),
        },
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
      if (snapshot.mediaAssets && typeof snapshot.mediaAssets === 'object') {
        imageItems = cloneMediaItems(snapshot.mediaAssets.images);
        videoItems = cloneMediaItems(snapshot.mediaAssets.videos);
        visualReference = cloneVisualReference(snapshot.mediaAssets.visualReference || visualReference);
        normalizeMediaItemTiming();
      }
      render();
      renderVisualReference();
      renderImageCards();
      renderVideoAssetCards();
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

    function appendMediaDetails(card, label, blocks) {
      const content = (blocks || [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .join('\\n\\n');
      if (!content) return;
      const details = document.createElement('details');
      details.className = 'media-details';
      const summary = document.createElement('summary');
      summary.textContent = label || '\u63d0\u793a\u8bcd';
      const body = document.createElement('div');
      body.className = 'media-details-body';
      body.textContent = content;
      details.appendChild(summary);
      details.appendChild(body);
      card.appendChild(details);
    }

    function appendEditablePromptDetails(card, label, value, datasetName, index) {
      const details = document.createElement('details');
      details.className = 'media-details';
      const summary = document.createElement('summary');
      summary.textContent = label || '\u7f16\u8f91\u63d0\u793a\u8bcd';
      const body = document.createElement('div');
      body.className = 'media-details-body';
      const textarea = document.createElement('textarea');
      textarea.className = 'media-prompt-editor';
      textarea.value = String(value || '');
      textarea.dataset[datasetName] = String(index);
      body.appendChild(textarea);
      details.appendChild(summary);
      details.appendChild(body);
      card.appendChild(details);
    }

    function knownMediaSizeText(asset) {
      const parseSize = (value) => {
        const match = String(value || '').match(/(\\d+(?:\\.\\d+)?)\\D+(\\d+(?:\\.\\d+)?)/);
        if (!match) return '';
        const width = Number(match[1]);
        const height = Number(match[2]);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '';
        return Math.round(width) + '\u00d7' + Math.round(height);
      };
      const direct = parseSize(asset?.dimensions || asset?.resolution);
      if (direct) return direct;
      const size = parseSize(asset?.size);
      if (size) return size;
      const width = Number(asset?.width || asset?.w);
      const height = Number(asset?.height || asset?.h);
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        return Math.round(width) + '\u00d7' + Math.round(height);
      }
      return '';
    }

    function attachMediaDimensionBadge(preview, media, type, asset) {
      if (!preview || !media) return;
      const badge = document.createElement('span');
      badge.className = 'media-dimension-badge';
      badge.textContent = knownMediaSizeText(asset) || '\u8bfb\u53d6\u5c3a\u5bf8...';
      preview.appendChild(badge);
      const update = () => {
        const width = type === 'video' ? media.videoWidth : media.naturalWidth;
        const height = type === 'video' ? media.videoHeight : media.naturalHeight;
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
          badge.textContent = Math.round(width) + '\u00d7' + Math.round(height);
        }
      };
      media.addEventListener(type === 'video' ? 'loadedmetadata' : 'load', update, { once: true });
      update();
    }

    function appendMediaMetaLine(card, item, type, asset) {
      const line = document.createElement('div');
      line.className = 'media-card-meta-line';
      const parts = [
        ['\u65f6\u95f4\u8303\u56f4', item?.timeRange || formatTimeRange(item?.start, item?.end)],
        ['\u65f6\u957f', ((Number(item?.durationSec) || Math.max(0, (Number(item?.end) || 0) - (Number(item?.start) || 0))).toFixed(1) + 's')],
        ['\u6bd4\u4f8b', String(item?.aspectRatio || asset?.size || (type === 'video' ? videoAssetAspectEl?.value : imageAspectEl?.value) || '-').trim() || '-'],
        ['\u5c3a\u5bf8', knownMediaSizeText(asset) || '\u52a0\u8f7d\u540e\u663e\u793a'],
      ];
      parts.forEach(([label, value]) => {
        const span = document.createElement('span');
        span.textContent = label + '\uff1a' + value;
        line.appendChild(span);
      });
      card.appendChild(line);
    }

    function renderImageCards() {
      if (!imageCardListEl) return;
      imageCardListEl.innerHTML = '';
      const selectedPreviewRatio = aspectRatioToCss(imageAspectEl?.value || '1:1', '1:1');
      if (!imageItems.length) {
        const empty = document.createElement('div');
        empty.className = 'meta';
        empty.textContent = '暂无配图点。点击“生成配图”后会显示图片预览。';
        imageCardListEl.appendChild(empty);
      } else {
        imageItems.forEach((item, index) => {
          normalizeImageItemTiming(item);
          const card = document.createElement('div');
          card.className = 'image-card';
          const preview = document.createElement('div');
          preview.className = 'image-preview';
          preview.style.aspectRatio = aspectRatioToCss(item?.image?.aspectRatio || item?.aspectRatio, selectedPreviewRatio);
          if (item.image && item.image.url) {
            const img = document.createElement('img');
            img.src = item.image.url;
            img.alt = item.title || '视频配图';
            preview.appendChild(img);
            attachMediaDimensionBadge(preview, img, 'image', item.image);
          } else {
            const message = document.createElement('div');
            message.textContent = item.status === 'error'
              ? ('生成失败：' + (item.error || '未知错误'))
              : (item.status === 'generating' ? '正在生成图片...' : '等待生成');
            preview.appendChild(message);
          }


          const title = document.createElement('div');
          title.className = 'image-card-title';
          title.textContent = (index + 1) + '. [' + (item.timeRange || '-') + '] ' + (item.title || '视频配图');

          const purpose = document.createElement('div');
          purpose.className = 'meta';
          purpose.textContent = (item.purpose || '视频配图') + (item.textBasis ? (' | 依据：' + item.textBasis) : '');

          const controls = document.createElement('label');
          controls.className = 'media-card-controls';
          const controlText = document.createElement('span');
          controlText.textContent = '显示时长（5-10秒）';
          const durationInput = document.createElement('input');
          durationInput.type = 'number';
          durationInput.min = '5';
          durationInput.max = '10';
          durationInput.step = '0.5';
          durationInput.value = String(item.durationSec || 7);
          durationInput.dataset.imageDuration = String(index);
          controls.appendChild(controlText);
          controls.appendChild(durationInput);

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
          retryBtn.textContent = item.status === 'generating' ? '\u751f\u6210\u4e2d...' : '\u91cd\u65b0\u751f\u6210';
          retryBtn.disabled = item.status === 'generating' || imageGenerating;
          retryBtn.dataset.imageRetry = String(index);
          actions.appendChild(retryBtn);

          const uploadBtn = document.createElement('button');
          uploadBtn.type = 'button';
          uploadBtn.textContent = '\u4e0a\u4f20\u66ff\u6362';
          uploadBtn.disabled = item.status === 'generating' || imageGenerating;
          uploadBtn.dataset.imageUpload = String(index);
          actions.appendChild(uploadBtn);

          if (item.image && item.image.url) {
            const link = document.createElement('a');
            link.href = item.image.url;
            link.download = ((item.title || item.id || 'image') + '.png').replace(/[\\/:*?"<>|]+/g, '_');
            link.textContent = '下载';
            actions.appendChild(link);
          }

          card.appendChild(preview);
          card.appendChild(title);
          appendMediaMetaLine(card, item, 'image', item.image);
          card.appendChild(purpose);
          card.appendChild(controls);
          appendMediaDetails(card, '\u753b\u9762\u8bf4\u660e / \u63d0\u793a\u8bcd', [scene.textContent, prompt.textContent]);
          appendEditablePromptDetails(card, '\u7f16\u8f91\u56fe\u7247\u63d0\u793a\u8bcd', item.prompt || '', 'imagePrompt', index);
          card.appendChild(actions);
          imageCardListEl.appendChild(card);
        });
      }
      setImageGenerating(imageGenerating);
      syncCompositePreviewOverlay();
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
          normalizeVideoItemTiming(item);
          const card = document.createElement('div');
          card.className = 'image-card video-asset-card';
          const preview = document.createElement('div');
          preview.className = 'image-preview';
          preview.style.aspectRatio = aspectRatioToCss(item.aspectRatio || videoAssetAspectEl?.value, '16:9');
          if (item.video && item.video.url) {
            const video = document.createElement('video');
            video.src = item.video.url;
            video.controls = true;
            video.muted = true;
            video.playsInline = true;
            video.preload = 'metadata';
            video.style.width = '100%';
            video.style.height = '100%';
            video.style.objectFit = 'contain';
            preview.appendChild(video);
            attachMediaDimensionBadge(preview, video, 'video', item.video);
          } else {
            const message = document.createElement('div');
            message.textContent = item.status === 'error'
              ? ('生成失败：' + (item.error || '未知错误'))
              : (item.status === 'generating' ? '正在生成视频素材...' : '等待生成');
            preview.appendChild(message);
          }


          const title = document.createElement('div');
          title.className = 'image-card-title';
          title.textContent = (index + 1) + '. [' + (item.timeRange || '-') + '] ' + (item.title || '视频素材');

          const purpose = document.createElement('div');
          purpose.className = 'meta';
          purpose.textContent = (item.purpose || 'B-roll') + ' | 时长：' + (item.durationSec || 5) + ' 秒' + (item.textBasis ? (' | 依据：' + item.textBasis) : '');

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
          retryBtn.textContent = item.status === 'generating' ? '\u751f\u6210\u4e2d...' : '\u91cd\u65b0\u751f\u6210';
          retryBtn.disabled = item.status === 'generating' || videoGenerating;
          retryBtn.dataset.videoRetry = String(index);
          actions.appendChild(retryBtn);

          if (item.video && item.video.url) {
            const link = document.createElement('a');
            link.href = item.video.url;
            link.download = ((item.title || item.id || 'video') + '.mp4').replace(/[\\/:*?"<>|]+/g, '_');
            link.textContent = '下载';
            actions.appendChild(link);
          }

          card.appendChild(preview);
          card.appendChild(title);
          appendMediaMetaLine(card, item, 'video', item.video);
          card.appendChild(purpose);
          appendMediaDetails(card, '\u89c6\u9891\u5206\u955c / \u63d0\u793a\u8bcd', [scene.textContent, prompt.textContent]);
          appendEditablePromptDetails(card, '\u7f16\u8f91\u89c6\u9891\u63d0\u793a\u8bcd', item.videoPrompt || item.prompt || '', 'videoPrompt', index);
          card.appendChild(actions);
          videoAssetListEl.appendChild(card);
        });
      }
      setVideoGenerating(videoGenerating);
      syncCompositePreviewOverlay();
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

    function fillJianyingDraftOptions(targetEl, options, mapValue) {
      if (!targetEl) return;
      targetEl.innerHTML = '';
      (options || []).forEach((item) => {
        const option = document.createElement('option');
        option.value = mapValue(item);
        option.label = item.name ? (item.name + (item.modifiedText ? ' · ' + item.modifiedText : '')) : option.value;
        targetEl.appendChild(option);
      });
    }

    async function loadJianyingDraftTargets(showMessage) {
      try {
        const response = await fetch('/api/jianying-draft-targets');
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) {
          throw new Error(data.error || ('HTTP ' + response.status));
        }
        const roots = Array.isArray(data.roots) ? data.roots : [];
        const drafts = Array.isArray(data.drafts) ? data.drafts : [];
        fillJianyingDraftOptions(jianyingDraftRootListEl, roots, (item) => item.path || '');
        fillJianyingDraftOptions(jianyingTemplateDraftListEl, drafts, (item) => item.path || '');
        if (data.detectedRoot && jianyingDraftRootEl && !jianyingDraftRootEl.value.trim()) {
          jianyingDraftRootEl.value = data.detectedRoot;
        }
        if (jianyingQuickTargetEl) {
          const current = jianyingQuickTargetEl.value || 'auto';
          jianyingQuickTargetEl.innerHTML = '';
          const addOption = (value, label) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            jianyingQuickTargetEl.appendChild(option);
          };
          addOption('auto', data.detectedRoot ? '默认剪映目录' : '自动识别剪映目录');
          addOption('project', '当前项目目录');
          roots.forEach((root, index) => {
            if (!root?.path) return;
            addOption('root:' + root.path, (root.source === 'settings' ? '设置草稿目录' : '草稿目录' + (index + 1)) + '：' + root.path);
          });
          drafts.slice(0, 5).forEach((draft, index) => {
            if (!draft?.path) return;
            addOption('template:' + draft.path, '模板' + (index + 1) + '：' + (draft.name || draft.path));
          });
          if ([...jianyingQuickTargetEl.options].some((option) => option.value === current)) {
            jianyingQuickTargetEl.value = current;
          }
        }
        if (showMessage) {
          if (data.detectedRoot) {
            setExportStatus('已识别剪映草稿目录：' + data.detectedRoot + (drafts.length ? '，可选模板草稿 ' + drafts.length + ' 个。' : '。'));
          } else {
            setExportStatus('暂未自动识别到剪映草稿目录，可选择“当前项目目录”，或先到主页设置里配置剪映草稿目录。');
          }
        }
        return data;
      } catch (err) {
        if (showMessage) setExportStatus('识别剪映目录失败：' + (err.message || String(err)));
        return null;
      }
    }

    function getJianyingExportSelection() {
      const raw = jianyingQuickTargetEl ? String(jianyingQuickTargetEl.value || 'auto') : 'auto';
      if (raw === 'project') return { exportMode: 'project', targetRoot: '', templatePath: '' };
      if (raw.startsWith('root:')) return { exportMode: 'custom', targetRoot: raw.slice(5), templatePath: '' };
      if (raw.startsWith('template:')) return { exportMode: 'auto', targetRoot: '', templatePath: raw.slice(9) };
      return { exportMode: 'auto', targetRoot: '', templatePath: '' };
    }

    async function exportJianyingDraft() {
      setExportStatus('正在准备剪映导出目标...');
      await loadJianyingDraftTargets(false);
      const cues = buildExportCues();
      if (!cues.length) {
        setExportStatus('没有可导出的字幕，请检查是否全部内容都被标记删除。');
        alert('剪映草稿导出失败：没有可导出的字幕，请检查是否全部内容都被标记删除。');
        return;
      }
      const selection = getJianyingExportSelection();
      const templatePath = selection.templatePath;
      const exportMode = selection.exportMode;
      const targetRoot = selection.targetRoot;
      const preset = jianyingSubtitlePresetEl ? jianyingSubtitlePresetEl.value : 'clean';
      const deleteSegments = mergedSegmentsFromSelection();
      const sourceDurationSec = getAudioTotalDuration();
      const sourceVideoMeta = {
        width: sourceVideoEl ? (Number(sourceVideoEl.videoWidth) || 0) : 0,
        height: sourceVideoEl ? (Number(sourceVideoEl.videoHeight) || 0) : 0,
      };
      setExportStatus('正在生成完整剪映草稿（主视频轨 + 字幕轨 + 素材轨）...');
      if (btnExportJianyingDraft) btnExportJianyingDraft.disabled = true;
      try {
        await saveReviewState('force');
        const response = await fetch('/api/export-jianying-draft', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fullDraft: true,
            cues: cues.map((cue) => ({
              start: cue.start,
              end: Math.max(cue.end, cue.start + 0.35),
              text: String(cue.text || '').trim(),
            })),
            deleteSegments,
            sourceDurationSec,
            sourceVideoMeta,
            mediaAssets: {
              images: cloneMediaItems(imageItems),
              videos: cloneMediaItems(videoItems),
            },
            preset,
            templatePath,
            exportMode,
            targetRoot,
            draftName: 'JaygoCut_' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14),
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) {
          throw new Error(data.error || ('HTTP ' + response.status));
        }
        const draftKind = data.fullDraft ? '完整剪映草稿' : '字幕草稿';
        const mediaText = data.fullDraft
          ? ('，主视频片段 ' + (data.keepSegments || 0) + ' 段，图片 ' + (data.imageAssets || 0) + ' 张，视频素材 ' + (data.videoAssets || 0) + ' 段')
          : '';
        const fallbackText = data.fallbackUsed ? ('\\n\\n完整草稿生成失败，已自动导出字幕草稿。\\n原因：' + (data.fallbackReason || '未知')) : '';
        const placementText = data.autoPlaced
          ? '已放入剪映草稿目录，打开剪映即可看到'
          : '已导出到项目目录，需要时可手动复制到剪映草稿目录';
        const templateText = data.templateUsed ? '；已基于模板草稿生成新草稿，未覆盖原模板' : '';
        const message = placementText + '：' + data.draftDir + '（' + draftKind + '，字幕 ' + data.cues + ' 条' + mediaText + '）' + templateText;
        setExportStatus(message);
        alert(message + fallbackText + (data.autoPlaced ? '\\n\\n提示：如果剪映已经打开但没有出现新项目，请重启剪映刷新项目列表。' : '\\n\\n提示：若新版剪映无法识别完整草稿，可使用导出的 SRT 或字幕草稿兜底。'));
      } catch (err) {
        setExportStatus('剪映草稿导出失败：' + (err.message || String(err)));
        alert('剪映草稿导出失败：' + (err.message || String(err)));
      } finally {
        if (btnExportJianyingDraft) btnExportJianyingDraft.disabled = false;
      }
    }

    function fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('\u8bfb\u53d6\u56fe\u7247\u5931\u8d25'));
        reader.readAsDataURL(file);
      });
    }

    async function importLocalImageForItem(index, file) {
      const item = imageItems[index];
      if (!item || !file) return;
      if (!/^image\//i.test(file.type || '')) {
        throw new Error('\u8bf7\u9009\u62e9\u56fe\u7247\u6587\u4ef6');
      }
      if (file.size > 20 * 1024 * 1024) {
        throw new Error('\u56fe\u7247\u6587\u4ef6\u8fc7\u5927\uff0c\u8bf7\u9009\u62e9 20MB \u4ee5\u5185\u7684\u56fe\u7247');
      }
      item.status = 'generating';
      item.error = '';
      renderImageCards();
      const dataUrl = await fileToDataUrl(file);
      const response = await fetch('/api/import-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name || 'local-image',
          dataUrl,
          item,
          aspectRatio: imageAspectEl ? imageAspectEl.value : item.aspectRatio,
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
      normalizeImageItemTiming(imageItems[index]);
      renderImageCards();
      setImageStatus('\u5df2\u7528\u672c\u5730\u56fe\u7247\u66ff\u6362\u7b2c ' + (index + 1) + ' \u5f20');
      scheduleReviewStateSave(200);
    }

    function mergePlannedVisualReference(nextRef) {
      if (!nextRef || typeof nextRef !== 'object') return;
      const currentAssets = normalizeReferenceAssets(visualReference.assets);
      const nextAssets = normalizeReferenceAssets(nextRef.assets);
      visualReference = cloneVisualReference({
        ...visualReference,
        ...nextRef,
        enabled: visualReference.enabled !== false,
        assets: nextAssets.length ? nextAssets : currentAssets,
        status: currentAssets.some((asset) => asset.image?.url) ? 'done' : (nextAssets.length ? 'planned' : visualReference.status),
      });
    }

    async function planVisualReferencePrompt() {
      const response = await fetch('/api/llm-visual-reference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          words: WORDS,
          selectedIndices: Array.from(selected),
          style: imageStyleEl ? imageStyleEl.value : '',
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
      mergePlannedVisualReference(data.visualReference || data);
      const prompts = normalizeReferenceAssets(visualReference.assets).map((asset) => asset.prompt).filter(Boolean);
      visualReference.prompt = String(data.prompt || data.visualReference?.prompt || prompts.join('\\n\\n') || visualReference.prompt || '').slice(0, 1600);
      visualReference.negativePrompt = String(data.negativePrompt || data.visualReference?.negativePrompt || visualReference.negativePrompt || '').slice(0, 500);
      visualReference.source = 'llm-plan';
      visualReference.status = normalizeReferenceAssets(visualReference.assets).length ? 'planned' : (visualReference.prompt ? 'planned' : 'empty');
      renderVisualReference();
      return visualReference.prompt;
    }

    async function generateVisualReferenceAsset(index) {
      const assets = normalizeReferenceAssets(visualReference.assets);
      const asset = assets[index];
      if (!asset) return null;
      asset.status = 'generating';
      asset.error = '';
      visualReference.assets = assets;
      renderVisualReference();
      const response = await fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item: {
            id: asset.id || ('visual_reference_' + (index + 1)),
            title: asset.title || '\u8d44\u4ea7\u56fe\u53c2\u8003',
            purpose: asset.role || (asset.type === 'character' ? '\u7edf\u4e00\u4eba\u7269\u8bbe\u5b9a' : '\u7edf\u4e00\u573a\u666f\u8bbe\u5b9a'),
            prompt: asset.prompt || visualReference.prompt,
            negativePrompt: asset.negativePrompt || visualReference.negativePrompt,
            aspectRatio: asset.aspectRatio || '1:1',
          },
          imageSize: asset.aspectRatio || '1:1',
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        throw new Error(data.error || ('HTTP ' + response.status));
      }
      assets[index] = normalizeReferenceAsset({
        ...asset,
        ...(data.item || {}),
        prompt: data.item?.prompt || asset.prompt,
        negativePrompt: data.item?.negativePrompt || asset.negativePrompt,
        image: data.image,
        status: 'done',
        source: 'generated',
      }, index);
      visualReference.assets = assets;
      visualReference.image = assets.find((item) => item.image?.url)?.image || null;
      visualReference.status = 'done';
      renderVisualReference();
      return assets[index];
    }

    async function generateVisualReference() {
      visualReference.enabled = true;
      visualReference.status = 'generating';
      visualReference.error = '';
      renderVisualReference();
      setVisualReferenceStatus('\u6b63\u5728\u89c4\u5212\u4eba\u7269/\u573a\u666f\u8d44\u4ea7\u56fe...');
      if (!normalizeReferenceAssets(visualReference.assets).length) {
        await planVisualReferencePrompt();
      }
      const assets = normalizeReferenceAssets(visualReference.assets);
      if (!assets.length) throw new Error('\u8d44\u4ea7\u56fe\u89c4\u5212\u4e3a\u7a7a');
      let ok = 0;
      for (let i = 0; i < assets.length; i += 1) {
        try {
          setVisualReferenceStatus('\u6b63\u5728\u751f\u6210\u8d44\u4ea7\u56fe ' + (i + 1) + '/' + assets.length + '...');
          await generateVisualReferenceAsset(i);
          ok += 1;
        } catch (err) {
          const next = normalizeReferenceAssets(visualReference.assets);
          if (next[i]) {
            next[i].status = 'error';
            next[i].error = err.message || String(err);
          }
          visualReference.assets = next;
          renderVisualReference();
        }
      }
      visualReference.status = ok ? 'done' : 'error';
      renderVisualReference();
      scheduleReviewStateSave(200);
      if (!ok) throw new Error('\u8d44\u4ea7\u56fe\u5168\u90e8\u751f\u6210\u5931\u8d25');
    }

    async function importVisualReferenceImage(file) {
      if (!/^image\//i.test(file.type || '')) {
        throw new Error('\u8bf7\u9009\u62e9\u56fe\u7247\u6587\u4ef6');
      }
      if (file.size > 20 * 1024 * 1024) {
        throw new Error('\u56fe\u7247\u6587\u4ef6\u8fc7\u5927\uff0c\u8bf7\u9009\u62e9 20MB \u4ee5\u5185\u7684\u56fe\u7247');
      }
      visualReference.enabled = true;
      visualReference.status = 'generating';
      renderVisualReference();
      setVisualReferenceStatus('\u6b63\u5728\u5bfc\u5165\u8d44\u4ea7\u53c2\u8003\u56fe...');
      const dataUrl = await fileToDataUrl(file);
      const response = await fetch('/api/import-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name || 'visual-reference',
          dataUrl,
          item: {
            id: 'visual_reference_' + Date.now(),
            title: file.name || '\u672c\u5730\u8d44\u4ea7\u53c2\u8003',
            prompt: 'User uploaded visual reference: ' + (file.name || 'image'),
          },
          aspectRatio: '1:1',
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        throw new Error(data.error || ('HTTP ' + response.status));
      }
      const assets = normalizeReferenceAssets(visualReference.assets);
      assets.push(normalizeReferenceAsset({
        id: 'uploaded_' + Date.now(),
        type: assets.length ? 'scene' : 'character',
        title: file.name || '\u672c\u5730\u8d44\u4ea7\u53c2\u8003',
        prompt: String(data.item?.prompt || '').slice(0, 1600),
        image: data.image,
        status: 'done',
        source: 'local-upload',
      }, assets.length));
      visualReference = cloneVisualReference({
        ...visualReference,
        enabled: true,
        status: 'done',
        assets,
        image: assets.find((asset) => asset.image?.url)?.image || data.image,
        source: 'local-upload',
      });
      renderVisualReference();
      scheduleReviewStateSave(200);
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
          referenceImage: getReferenceImagesForItem(item, 2),
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
      normalizeImageItemTiming(imageItems[index]);
      renderImageCards();
      scheduleReviewStateSave(200);
    }

    async function generateVideoImages() {
      if (imageGenerating) return;
      setImageGenerating(true);
      try {
        setImageStatus('正在让 LLM 分析文本并规划配图点...');
        const existingRanges = collectPlacementBlockedRanges('image');
        imageItems = [];
        renderImageCards();
        const response = await fetch('/api/llm-image-plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            words: WORDS,
            selectedIndices: Array.from(selected),
            deleteSegments: mergedSegmentsFromSelection(),
            sourceDurationSec: getAudioTotalDuration(),
            count: imageCountEl ? String(imageCountEl.value || 'auto') : 'auto',
            style: imageStyleEl ? imageStyleEl.value : '',
            existingRanges,
            visualReference: cloneVisualReference(visualReference),
            analysis: {
              topic: llmTopic,
              outline: llmOutline,
              multiSpeaker: llmMultiSpeaker,
            },
            mediaAssets: {
              images: imageItems,
              videos: videoItems,
            },
          }),
        });
        const plan = await response.json().catch(() => ({}));
        if (!response.ok || !plan.success) {
          throw new Error(plan.error || ('HTTP ' + response.status));
        }
        if (plan.topic && !llmTopic) llmTopic = String(plan.topic).slice(0, 80);
        if (plan.outline && !llmOutline) llmOutline = String(plan.outline).slice(0, 120);
        if (plan.visualReference && typeof plan.visualReference === 'object') {
          const plannedRef = cloneVisualReference({
            ...visualReference,
            ...plan.visualReference,
            enabled: visualReference.enabled !== false,
            status: visualReference.image?.url ? 'done' : 'planned',
          });
          if (!visualReference.prompt || !visualReference.image?.url) visualReference = plannedRef;
          renderVisualReference();
        }
        imageItems = (Array.isArray(plan.items) ? plan.items : []).map((item) => ({
          ...item,
          motionEffect: sanitizeImageMotionEffect(item.motionEffect || currentImageMotionEffect()),
          status: 'queued',
          image: null,
          error: '',
        })).map(normalizeImageItemTiming);
        applyNonOverlappingSchedule(imageItems, 'image', existingRanges);
        renderImageCards();
        setImageStatus('已规划 ' + imageItems.length + ' 个配图点，开始逐张生成...');

        if (visualReference.enabled !== false && !getActiveReferenceImages().length) {
          try {
            await generateVisualReference();
          } catch (err) {
            setImageStatus('\u53c2\u8003\u56fe\u751f\u6210\u5931\u8d25\uff0c\u5c06\u5148\u6309\u666e\u901a\u63d0\u793a\u8bcd\u751f\u6210\uff1a' + (err.message || String(err)));
          }
        }

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
          durationSec: item.durationSec || 5,
          numFrames: item.numFrames,
          frameRate: item.frameRate,
          referenceImage: getReferenceImagesForItem(item, 1),
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
      normalizeVideoItemTiming(videoItems[index]);
      renderVideoAssetCards();
      scheduleReviewStateSave(200);
    }

    async function generateVideoAssets() {
      if (videoGenerating) return;
      setVideoGenerating(true);
      try {
        setVideoAssetStatus('正在让 LLM 规划视频素材插入点...');
        const existingRanges = collectPlacementBlockedRanges('video');
        videoItems = [];
        renderVideoAssetCards();
        const response = await fetch('/api/llm-video-plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            words: WORDS,
            selectedIndices: Array.from(selected),
            deleteSegments: mergedSegmentsFromSelection(),
            sourceDurationSec: getAudioTotalDuration(),
            count: Number(videoAssetCountEl ? videoAssetCountEl.value : 3) || 3,
            style: imageStyleEl ? imageStyleEl.value : '',
            aspectRatio: videoAssetAspectEl ? videoAssetAspectEl.value : '16:9',
            existingRanges,
            visualReference: cloneVisualReference(visualReference),
            analysis: {
              topic: llmTopic,
              outline: llmOutline,
              multiSpeaker: llmMultiSpeaker,
            },
            mediaAssets: {
              images: imageItems,
              videos: videoItems,
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
        })).map(normalizeVideoItemTiming);
        applyNonOverlappingSchedule(videoItems, 'video', existingRanges);
        renderVideoAssetCards();
        setVideoAssetStatus('已规划 ' + videoItems.length + ' 个视频素材点，开始逐段生成...');

        if (visualReference.enabled !== false && !getActiveReferenceImages().length) {
          try {
            await generateVisualReference();
          } catch (err) {
            setVideoAssetStatus('\u53c2\u8003\u56fe\u751f\u6210\u5931\u8d25\uff0c\u5c06\u5148\u6309\u666e\u901a\u63d0\u793a\u8bcd\u751f\u6210\u89c6\u9891\uff1a' + (err.message || String(err)));
          }
        }

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
        autoRulePreferences: {
          filler: toggleAutoFillerEl ? !!toggleAutoFillerEl.checked : true,
          fillerWords: fillerWordAllowListEl ? String(fillerWordAllowListEl.value || '') : '',
          repeat: toggleAutoRepeatEl ? !!toggleAutoRepeatEl.checked : true,
        },
        imageMotionEffect: currentImageMotionEffect(),
        currentTimeSec: Math.max(0, Number(audio.currentTime) || 0),
        mediaAssets: {
          images: imageItems,
          videos: videoItems,
          visualReference: cloneVisualReference(visualReference),
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
        visualReference = cloneVisualReference(restoredMedia.visualReference || visualReference);
        imageItems.forEach((item) => {
          normalizeImageItemTiming(item);
          if (item && item.image && item.status !== 'error') item.status = item.image.url ? 'done' : (item.status || 'queued');
        });
        videoItems.forEach((item) => {
          normalizeVideoItemTiming(item);
          if (item && item.video && item.status !== 'error') item.status = item.video.url ? 'done' : (item.status || 'queued');
        });
        renderVisualReference();
        renderImageCards();
        renderVideoAssetCards();

        const threshold = Number(state.threshold);
        if (Number.isFinite(threshold) && threshold >= 0.2) {
          thresholdEl.value = threshold.toFixed(2);
        }
        if (state.boundarySettings && typeof state.boundarySettings === 'object') {
          applyBoundarySettings(state.boundarySettings);
        }
        if (state.autoRulePreferences && typeof state.autoRulePreferences === 'object') {
          if (toggleAutoFillerEl) toggleAutoFillerEl.checked = state.autoRulePreferences.filler !== false;
          if (fillerWordAllowListEl && typeof state.autoRulePreferences.fillerWords === 'string') {
            fillerWordAllowListEl.value = state.autoRulePreferences.fillerWords;
          }
          if (toggleAutoRepeatEl) toggleAutoRepeatEl.checked = state.autoRulePreferences.repeat !== false;
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
        applyAutoRulePreferences(false);
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
      const safeLines = Array.isArray(lines) ? lines : [];
      if (logsEl) {
        logsEl.textContent = safeLines.join('\\n');
        logsEl.scrollTop = logsEl.scrollHeight;
      }
      if (cutLogStatusEl) {
        cutLogStatusEl.textContent = safeLines.length
          ? ('最近 ' + safeLines.length + ' 行日志，裁剪异常时可在这里复制排查。')
          : '暂无裁剪日志。执行裁剪后，这里会显示进度和错误详情。';
      }
      if (cutLogBadgeEl) {
        cutLogBadgeEl.hidden = safeLines.length === 0;
        cutLogBadgeEl.textContent = safeLines.length ? String(Math.min(99, safeLines.length)) : '';
      }
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

    function parseAspectRatioValue(value) {
      const match = String(value || '').match(/(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)/);
      if (!match) return 0;
      const w = Number(match[1]);
      const h = Number(match[2]);
      return Number.isFinite(w) && Number.isFinite(h) && h > 0 ? w / h : 0;
    }

    function findClosestAspectOption(selectEl, sourceRatio) {
      if (!selectEl || !(sourceRatio > 0)) return '';
      const options = Array.from(selectEl.options || []);
      let best = '';
      let bestDiff = Number.POSITIVE_INFINITY;
      options.forEach((option) => {
        const ratio = parseAspectRatioValue(option.value);
        if (!(ratio > 0)) return;
        const diff = Math.abs(Math.log(ratio / sourceRatio));
        if (diff < bestDiff) {
          bestDiff = diff;
          best = option.value;
        }
      });
      return best;
    }

    function syncMediaAspectToSourceVideo() {
      if (!sourceVideoEl) return;
      const width = Number(sourceVideoEl.videoWidth) || 0;
      const height = Number(sourceVideoEl.videoHeight) || 0;
      if (!(width > 0 && height > 0)) return;
      const ratio = width / height;
      sourceVideoMetaLabel = width + 'x' + height;
      if (videoPreviewFrameEl) {
        videoPreviewFrameEl.style.setProperty('--source-video-aspect', width + ' / ' + height);
      }
      const imageAspect = findClosestAspectOption(imageAspectEl, ratio);
      if (imageAspect && !imageAspectUserChanged && imageAspectEl.value !== imageAspect) {
        imageAspectEl.value = imageAspect;
        renderImageCards();
      }
      const videoAspect = findClosestAspectOption(videoAssetAspectEl, ratio);
      if (videoAspect && !videoAspectUserChanged && videoAssetAspectEl.value !== videoAspect) {
        videoAssetAspectEl.value = videoAspect;
        renderVideoAssetCards();
      }
    }

    function videoPreviewScaleLabel() {
      if (!sourceVideoEl) return '';
      const rect = getRenderedSourceVideoRect();
      const width = Number(sourceVideoEl.videoWidth) || 0;
      if (!rect || !(width > 0)) return sourceVideoMetaLabel;
      const scale = Math.max(1, Math.round((rect.width / width) * 100));
      return (sourceVideoMetaLabel || '') + (scale ? (' | 预览' + scale + '%') : '');
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

    function buildPreviewMediaOverlays() {
      const overlays = [];
      const pushOverlay = (type, item, asset) => {
        const url = String(asset?.url || '').trim();
        if (!url) return;
        const start = Math.max(0, Number(item?.start) || 0);
        const durationSec = type === 'image'
          ? clampDuration(item?.durationSec || ((Number(item?.end) || 0) - start), 5, 10, 7)
          : clampDuration(item?.durationSec || ((Number(item?.end) || 0) - start), 3, 8, 5);
        overlays.push({
          type,
          url,
          start,
          end: start + durationSec,
          durationSec,
          title: String(item?.title || (type === 'image' ? '图片素材' : '视频素材')),
          motionEffect: type === 'image' ? sanitizeImageMotionEffect(item?.motionEffect || currentImageMotionEffect()) : 'none',
        });
      };
      imageItems.forEach((item) => pushOverlay('image', item, item?.image));
      videoItems.forEach((item) => pushOverlay('video', item, item?.video));
      return overlays.sort((a, b) => a.start - b.start || (a.type === 'video' ? 1 : -1));
    }

    function applyImagePreviewMotion(el, overlay, currentTime) {
      if (!el || !overlay) return;
      const progress = Math.max(0, Math.min(1, (currentTime - overlay.start) / Math.max(0.2, overlay.durationSec || 1)));
      const effect = String(overlay.motionEffect || 'none');
      let scale = 1;
      let x = 0;
      let y = 0;
      if (effect === 'zoom-in') scale = 1 + progress * 0.06;
      if (effect === 'zoom-out') scale = 1.06 - progress * 0.06;
      if (effect === 'pan-left') x = (0.5 - progress) * 4;
      if (effect === 'pan-right') x = (progress - 0.5) * 4;
      if (effect === 'pan-up') y = (0.5 - progress) * 4;
      if (effect === 'pan-down') y = (progress - 0.5) * 4;
      el.style.transform = 'translate(' + x.toFixed(2) + '%, ' + y.toFixed(2) + '%) scale(' + scale.toFixed(4) + ')';
    }

    function getRenderedSourceVideoRect() {
      const frame = sourceVideoEl?.parentElement;
      if (!frame || !sourceVideoEl) return null;
      const frameRect = frame.getBoundingClientRect();
      const videoRect = sourceVideoEl.getBoundingClientRect();
      const videoWidth = Number(sourceVideoEl.videoWidth) || 0;
      const videoHeight = Number(sourceVideoEl.videoHeight) || 0;
      const boxWidth = videoRect.width || frameRect.width || 1;
      const boxHeight = videoRect.height || frameRect.height || 1;
      if (!videoWidth || !videoHeight || !boxWidth || !boxHeight) {
        return {
          left: Math.max(0, videoRect.left - frameRect.left),
          top: Math.max(0, videoRect.top - frameRect.top),
          width: Math.max(1, boxWidth),
          height: Math.max(1, boxHeight),
        };
      }
      const scale = Math.min(boxWidth / videoWidth, boxHeight / videoHeight);
      const renderedWidth = Math.max(1, videoWidth * scale);
      const renderedHeight = Math.max(1, videoHeight * scale);
      return {
        left: Math.max(0, videoRect.left - frameRect.left + (boxWidth - renderedWidth) / 2),
        top: Math.max(0, videoRect.top - frameRect.top + (boxHeight - renderedHeight) / 2),
        width: renderedWidth,
        height: renderedHeight,
      };
    }

    function syncCompositePreviewBounds() {
      if (!compositePreviewOverlayEl) return;
      const rect = getRenderedSourceVideoRect();
      if (!rect) return;
      compositePreviewOverlayEl.style.left = rect.left.toFixed(2) + 'px';
      compositePreviewOverlayEl.style.top = rect.top.toFixed(2) + 'px';
      compositePreviewOverlayEl.style.width = rect.width.toFixed(2) + 'px';
      compositePreviewOverlayEl.style.height = rect.height.toFixed(2) + 'px';
    }

    function syncCompositePreviewOverlay(currentTime = Number(audio.currentTime) || 0) {
      if (!compositePreviewOverlayEl) return '';
      if (!videoPreviewEnabled) {
        compositePreviewOverlayEl.hidden = true;
        compositePreviewOverlayEl.innerHTML = '';
        activeCompositePreviewKey = '';
        stopCompositePreviewLoop();
        return '';
      }
      const overlays = buildPreviewMediaOverlays();
      const active = overlays.filter((item) => currentTime >= item.start && currentTime < item.end).pop();
      if (!active) {
        compositePreviewOverlayEl.hidden = true;
        compositePreviewOverlayEl.innerHTML = '';
        activeCompositePreviewKey = '';
        return '';
      }
      syncCompositePreviewBounds();
      const key = [active.type, active.url, active.start.toFixed(2), active.end.toFixed(2), active.motionEffect].join('|');
      if (activeCompositePreviewKey !== key) {
        activeCompositePreviewKey = key;
        compositePreviewOverlayEl.innerHTML = '';
        const media = document.createElement(active.type === 'video' ? 'video' : 'img');
        media.dataset.compositePreviewMedia = '1';
        media.src = active.url;
        if (active.type === 'video') {
          media.muted = true;
          media.defaultMuted = true;
          media.volume = 0;
          media.loop = true;
          media.playsInline = true;
          media.preload = 'metadata';
        } else {
          media.alt = active.title || '合成预览素材';
        }
        compositePreviewOverlayEl.appendChild(media);
      }
      compositePreviewOverlayEl.hidden = false;
      const media = compositePreviewOverlayEl.querySelector('[data-composite-preview-media]');
      if (active.type === 'image') {
        applyImagePreviewMotion(media, active, currentTime);
      } else if (media) {
        const localTime = Math.max(0, currentTime - active.start);
        const duration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : active.durationSec;
        const target = duration > 0 ? (localTime % duration) : localTime;
        if (Math.abs((Number(media.currentTime) || 0) - target) > 0.45) {
          try { media.currentTime = target; } catch {}
        }
        if (audio.paused) {
          if (!media.paused) media.pause();
        } else if (media.paused) {
          media.play().catch(() => {});
        }
      }
      return active.title || (active.type === 'image' ? '图片素材' : '视频素材');
    }


    function startCompositePreviewLoop() {
      if (compositePreviewRaf !== null) return;
      const tick = () => {
        compositePreviewRaf = null;
        if (!videoPreviewEnabled || audio.paused || audio.ended) return;
        syncCompositePreviewOverlay(Number(audio.currentTime) || 0);
        compositePreviewRaf = requestAnimationFrame(tick);
      };
      compositePreviewRaf = requestAnimationFrame(tick);
    }

    function stopCompositePreviewLoop() {
      if (compositePreviewRaf === null) return;
      cancelAnimationFrame(compositePreviewRaf);
      compositePreviewRaf = null;
    }

    function syncVideoPreviewRate(driftSec) {
      if (!sourceVideoEl) return;
      const baseRate = Math.max(0.25, Math.min(4, Number(audio.playbackRate) || 1));
      let nextRate = baseRate;
      if (!audio.paused && Number.isFinite(driftSec)) {
        const absDrift = Math.abs(driftSec);
        if (absDrift > VIDEO_PREVIEW_SOFT_SYNC_TOLERANCE && absDrift <= VIDEO_PREVIEW_PLAYING_SEEK_TOLERANCE) {
          nextRate = Math.max(0.96, Math.min(1.04, baseRate + driftSec * 0.035));
        }
      }
      try {
        if (Math.abs((Number(sourceVideoEl.playbackRate) || 1) - nextRate) > 0.005) {
          sourceVideoEl.playbackRate = nextRate;
        }
      } catch {
        // Playback-rate adjustment is best-effort; seeking remains the fallback.
      }
    }

    function syncVideoPreview(force = false) {
      if (!videoPreviewEnabled || !hasUsableVideoPreview()) return;
      if (syncingAudioFromVideo && !force) return;
      silenceVideoPreview();
      const target = Math.max(0, Number(audio.currentTime) || 0);
      const current = Number(sourceVideoEl.currentTime) || 0;
      const now = performance.now();
      const drift = target - current;
      const seekTolerance = sourceVideoEl.paused || force ? 0.18 : VIDEO_PREVIEW_PLAYING_SEEK_TOLERANCE;
      const canSeek = force || (now - lastVideoPreviewSeekAt) > VIDEO_PREVIEW_FORCE_SEEK_INTERVAL_MS;
      if ((force || Math.abs(drift) > seekTolerance) && canSeek) {
        lastVideoPreviewSeekAt = now;
        syncingVideoFromAudio = true;
        try {
          const maxTime = Number.isFinite(sourceVideoEl.duration) && sourceVideoEl.duration > 0
            ? Math.max(0, sourceVideoEl.duration - 0.01)
            : target;
          sourceVideoEl.currentTime = Math.max(0, Math.min(maxTime, target));
          syncVideoPreviewRate(0);
        } catch {
          // Some codecs refuse seeking before metadata is ready; the next timeupdate will retry.
        }
        setTimeout(() => { syncingVideoFromAudio = false; }, 80);
      } else {
        syncVideoPreviewRate(drift);
      }
      if (audio.paused) {
        if (!sourceVideoEl.paused) sourceVideoEl.pause();
        syncVideoPreviewRate(0);
      } else if (sourceVideoEl.paused) {
        syncingVideoFromAudio = true;
        sourceVideoEl.play().catch(() => {
          setVideoPreviewStatus('视频等待手动播放');
        });
        setTimeout(() => { syncingVideoFromAudio = false; }, 80);
      }
      const compositeTitle = syncCompositePreviewOverlay(target);
      const scaleLabel = videoPreviewScaleLabel();
      setVideoPreviewStatus((scaleLabel ? (scaleLabel + ' | ') : '') + '跟随 ' + formatWaveClock(target) + (compositeTitle ? (' | 合成预览：' + compositeTitle) : ''));
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
      if (skipFadeRestoreVolume !== null) {
        audio.volume = Math.max(0, Math.min(1, Number(skipFadeRestoreVolume)));
        skipFadeRestoreVolume = null;
      }
    }

    function smoothSkipTo(targetTime) {
      const target = Math.max(0, Number(targetTime) || 0);
      const originalVolume = Math.max(0, Math.min(1, Number(audio.volume)));
      if (audio.paused || audio.muted || originalVolume <= 0.02) {
        return setPlaybackTime(target);
      }

      cancelSkipFade();
      skipFadeRestoreVolume = originalVolume;
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
            skipFadeRestoreVolume = null;
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
        btnToggleVideoPreview.textContent = videoPreviewEnabled ? '视频开' : '视频';
        btnToggleVideoPreview.setAttribute('aria-pressed', videoPreviewEnabled ? 'true' : 'false');
        btnToggleVideoPreview.disabled = runtimeInfoCache && runtimeInfoCache.videoExists === false;
      }
      try {
        localStorage.setItem(VIDEO_PREVIEW_STORAGE_KEY, videoPreviewEnabled ? '1' : '0');
      } catch {
        // Display preference only.
      }
      if (videoPreviewEnabled) {
        silenceVideoPreview();
        syncCompositePreviewBounds();
        syncVideoPreview(true);
      } else if (sourceVideoEl && !sourceVideoEl.paused) {
        sourceVideoEl.pause();
        syncCompositePreviewOverlay();
      } else {
        syncCompositePreviewOverlay();
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
      const modeLabel = cutPrecisionModeEl && cutPrecisionModeEl.selectedOptions && cutPrecisionModeEl.selectedOptions[0]
        ? cutPrecisionModeEl.selectedOptions[0].textContent.trim()
        : '标准';
      const summaryText =
        '已选删除: ' + mergedSelected.length + ' 段'
        + ' | 删除时长: ' + deletedSec.toFixed(2) + ' 秒'
        + ' | 预计成片: ' + outputSec.toFixed(2) + ' 秒'
        + ' | 原时长: ' + totalSec.toFixed(2) + ' 秒'
        + ' | 模式: ' + modeLabel;
      if (selectionStatsEl) {
        selectionStatsEl.dataset.summary = summaryText;
        selectionStatsEl.setAttribute('aria-label', summaryText);
      }
      if (statDeletedCountEl) statDeletedCountEl.textContent = mergedSelected.length + ' 段';
      if (statDeletedDurationEl) statDeletedDurationEl.textContent = deletedSec.toFixed(2) + ' 秒';
      if (statOutputDurationEl) statOutputDurationEl.textContent = outputSec.toFixed(2) + ' 秒';
      if (statTotalDurationEl) statTotalDurationEl.textContent = totalSec.toFixed(2) + ' 秒';
      if (statCutModeEl) statCutModeEl.textContent = modeLabel;
      if (!statDeletedCountEl && selectionStatsEl) selectionStatsEl.textContent = summaryText;
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
      const cat = reasonCategory(reason, !!w.isGap) || 'silence';
      return isAutoRuleCategoryEnabled(cat, w.text) ? cat : null;
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
      if (btnFocusReview) {
        btnFocusReview.textContent = next ? '退出专注' : '专注';
        btnFocusReview.setAttribute('aria-pressed', next ? 'true' : 'false');
      }
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
      const mediaActions = Array.isArray(data?.mediaActions)
        ? data.mediaActions
        : (Array.isArray(data?.media_actions) ? data.media_actions : []);
      let changed = 0;

      if (addIndices.length || removeIndices.length || mediaActions.length) {
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

      const mediaChanged = applyMediaActions(mediaActions);
      changed += mediaChanged;

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
            mediaAssets: {
              images: imageItems,
              videos: videoItems,
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
          '\u7d20\u6750\u52a8\u4f5c ' + Number((data.mediaActions || data.media_actions || []).length) + ' \u9879',
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
        if (type === 'image') normalizeImageItemTiming(item);
        if (type === 'video') normalizeVideoItemTiming(item);
        const start = Number(item?.start);
        const end = Number(item?.end);
        const filePath = String(asset?.filePath || '').trim();
        if (!filePath || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
        const durationSec = Math.max(0.2, end - start);
        overlays.push({
          type,
          filePath,
          url: String(asset?.url || ''),
          start,
          end,
          durationSec,
          title: String(item?.title || ''),
          fit: 'cover',
          motionEffect: type === 'image' ? sanitizeImageMotionEffect(item?.motionEffect || currentImageMotionEffect()) : 'none',
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
        let mediaOverlays = buildMediaOverlaysForCut();
        if (mediaOverlays.length) {
          const imageCount = mediaOverlays.filter((item) => item.type === 'image').length;
          const videoCount = mediaOverlays.filter((item) => item.type === 'video').length;
          const includeMedia = window.confirm(
            '检测到已生成的素材：图片 ' + imageCount + ' 张，视频 ' + videoCount + ' 段。\\n\\n是否将这些图片和视频素材一起合成到最终成片？\\n\\n确定：合成素材\\n取消：只裁剪主视频，不合成素材'
          );
          if (!includeMedia) {
            mediaOverlays = [];
            setStatus('用户选择不合成图片/视频素材，仅提交主视频裁剪...');
          }
        }
        setStatus('正在提交裁剪任务...');
        const r = await fetch('/api/cut', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            segments: segs,
            overlays: mediaOverlays,
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
        if (leftPanelOpen || imagePanelOpen || rightPanelOpen || logPanelOpen) {
          closePanels();
          e.preventDefault();
        }
        setWaveZoomPopoverOpen(false);
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
    [toggleAutoFillerEl, toggleAutoRepeatEl].forEach((el) => {
      if (!el) return;
      el.addEventListener('change', () => {
        pushSelectionUndo();
        const changed = applyAutoRulePreferences(el.checked);
        setStatus(changed ? '自动规则偏好已应用' : '自动规则偏好已保存');
        scheduleReviewStateSave(180);
      });
    });
    if (fillerWordAllowListEl) {
      fillerWordAllowListEl.addEventListener('change', () => {
        pushSelectionUndo();
        const changed = applyAutoRulePreferences(true);
        setStatus(changed ? '语气词标记范围已应用' : '语气词标记范围已保存');
        scheduleReviewStateSave(180);
      });
    }
    toolTabEls.forEach((tab) => {
      tab.addEventListener('click', () => setToolPanel(tab.dataset.toolTab || 'marking'));
    });
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
    if (btnToggleLogPanel) {
      btnToggleLogPanel.addEventListener('click', () => {
        setPanelOpen('log', !logPanelOpen);
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
    if (btnCloseLogPanel) {
      btnCloseLogPanel.addEventListener('click', () => {
        setPanelOpen('log', false);
      });
    }
    if (btnWaveZoom) {
      btnWaveZoom.addEventListener('click', (e) => {
        e.stopPropagation();
        setWaveZoomPopoverOpen(!waveZoomPopoverEl || waveZoomPopoverEl.hidden);
      });
    }
    if (btnCloseWaveZoom) {
      btnCloseWaveZoom.addEventListener('click', (e) => {
        e.stopPropagation();
        setWaveZoomPopoverOpen(false);
      });
    }
    if (waveZoomPopoverEl) {
      ['click', 'mousedown', 'wheel'].forEach((eventName) => {
        waveZoomPopoverEl.addEventListener(eventName, (e) => {
          e.stopPropagation();
        }, { passive: eventName === 'wheel' });
      });
    }
    if (btnMediaModeImage) {
      btnMediaModeImage.addEventListener('click', () => setMediaMode('image'));
    }
    if (btnMediaModeVideo) {
      btnMediaModeVideo.addEventListener('click', () => setMediaMode('video'));
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
    if (btnExportJianyingDraft) {
      btnExportJianyingDraft.addEventListener('click', exportJianyingDraft);
    }
    if (jianyingQuickTargetEl) {
      jianyingQuickTargetEl.addEventListener('focus', () => loadJianyingDraftTargets(false));
      jianyingQuickTargetEl.addEventListener('mousedown', () => loadJianyingDraftTargets(false));
      jianyingQuickTargetEl.addEventListener('change', () => {
        const label = jianyingQuickTargetEl.selectedOptions && jianyingQuickTargetEl.selectedOptions[0]
          ? jianyingQuickTargetEl.selectedOptions[0].textContent
          : jianyingQuickTargetEl.value;
        setExportStatus('已选择剪映导出目标：' + label);
      });
    }
    if (btnDetectJianyingDraftRoot) {
      btnDetectJianyingDraftRoot.addEventListener('click', () => loadJianyingDraftTargets(true));
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
      imageAspectEl.addEventListener('change', () => {
        imageAspectUserChanged = true;
        renderImageCards();
      });
    }
    if (videoAssetAspectEl) {
      videoAssetAspectEl.addEventListener('change', () => {
        videoAspectUserChanged = true;
        renderVideoAssetCards();
      });
    }
    if (imageMotionEffectEl) {
      imageMotionEffectEl.addEventListener('change', () => scheduleReviewStateSave(100));
    }
    if (useVisualReferenceEl) {
      useVisualReferenceEl.addEventListener('change', () => {
        visualReference.enabled = !!useVisualReferenceEl.checked;
        renderVisualReference();
        scheduleReviewStateSave(120);
      });
    }
    if (visualReferencePromptEl) {
      const syncVisualReferencePrompt = () => {
        visualReference.prompt = String(visualReferencePromptEl.value || '').slice(0, 1600);
        visualReference.status = visualReference.image?.url ? 'done' : (visualReference.prompt ? 'planned' : 'empty');
        renderVisualReference();
        scheduleReviewStateSave(120);
      };
      visualReferencePromptEl.addEventListener('input', syncVisualReferencePrompt);
      visualReferencePromptEl.addEventListener('change', syncVisualReferencePrompt);
    }
    if (visualReferencePreviewEl) {
      visualReferencePreviewEl.addEventListener('click', (event) => {
        const deleteBtn = event.target.closest('[data-ref-delete]');
        const previewBtn = event.target.closest('[data-ref-preview]');
        const card = event.target.closest('[data-ref-index]');
        if (deleteBtn) {
          const index = Number(deleteBtn.dataset.refDelete);
          deleteVisualReferenceAsset(index);
          return;
        }
        if (previewBtn) {
          const index = Number(previewBtn.dataset.refPreview);
          openAssetPreview(index);
          return;
        }
        if (card && event.target.closest('.asset-reference-thumb img')) {
          openAssetPreview(Number(card.dataset.refIndex));
        }
      });
    }
    if (btnGenerateVisualReference) {
      btnGenerateVisualReference.addEventListener('click', async () => {
        try {
          await generateVisualReference();
        } catch (err) {
          visualReference.status = 'error';
          renderVisualReference();
          setVisualReferenceStatus('\u53c2\u8003\u56fe\u751f\u6210\u5931\u8d25\uff1a' + (err.message || String(err)));
        }
      });
    }
    if (btnUploadVisualReference && referenceImageUploadInputEl) {
      btnUploadVisualReference.addEventListener('click', () => {
        referenceImageUploadInputEl.value = '';
        referenceImageUploadInputEl.click();
      });
      referenceImageUploadInputEl.addEventListener('change', async () => {
        const file = referenceImageUploadInputEl.files && referenceImageUploadInputEl.files[0];
        if (!file) return;
        try {
          await importVisualReferenceImage(file);
        } catch (err) {
          visualReference.status = 'error';
          renderVisualReference();
          setVisualReferenceStatus('\u53c2\u8003\u56fe\u5bfc\u5165\u5931\u8d25\uff1a' + (err.message || String(err)));
        }
      });
    }
    if (imageCardListEl) {
      const syncImagePromptInput = (target) => {
        const promptInput = target.closest('[data-image-prompt]');
        if (!promptInput) return false;
        const index = Number(promptInput.dataset.imagePrompt);
        if (!Number.isInteger(index) || !imageItems[index]) return true;
        imageItems[index].prompt = String(promptInput.value || '').slice(0, 1800);
        imageItems[index].promptEdited = true;
        scheduleReviewStateSave(180);
        return true;
      };
      imageCardListEl.addEventListener('input', (e) => {
        syncImagePromptInput(e.target);
      });
      imageCardListEl.addEventListener('change', (e) => {
        const durationInput = e.target.closest('[data-image-duration]');
        if (syncImagePromptInput(e.target)) {
          return;
        }
        if (durationInput) {
          const index = Number(durationInput.dataset.imageDuration);
          if (!Number.isInteger(index) || !imageItems[index]) return;
          const durationSec = clampDuration(durationInput.value, 5, 10, 7);
          imageItems[index].durationSec = durationSec;
          imageItems[index].end = Number((Math.max(0, Number(imageItems[index].start) || 0) + durationSec).toFixed(3));
          imageItems[index].timeRange = formatTimeRange(imageItems[index].start, imageItems[index].end);
          renderImageCards();
          scheduleReviewStateSave(120);
          syncCompositePreviewOverlay();
          return;
        }
      });
      imageCardListEl.addEventListener('click', async (e) => {
        const retryBtn = e.target.closest('[data-image-retry]');
        const uploadBtn = e.target.closest('[data-image-upload]');
        if (uploadBtn) {
          const index = Number(uploadBtn.dataset.imageUpload);
          if (!Number.isInteger(index) || !imageItems[index] || !localImageUploadInputEl) return;
          pendingImageUploadIndex = index;
          localImageUploadInputEl.value = '';
          localImageUploadInputEl.click();
          return;
        }
        if (retryBtn) {
          const index = Number(retryBtn.dataset.imageRetry);
          if (!Number.isInteger(index)) return;
          try {
            setImageStatus('正在重试第 ' + (index + 1) + ' 张，LLM 会先换一个提示词...');
            await generateOneImage(index, !imageItems[index]?.promptEdited);
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

      });
    }
    if (localImageUploadInputEl) {
      localImageUploadInputEl.addEventListener('change', async () => {
        const index = pendingImageUploadIndex;
        pendingImageUploadIndex = -1;
        const file = localImageUploadInputEl.files && localImageUploadInputEl.files[0];
        if (!file || !Number.isInteger(index) || !imageItems[index]) return;
        try {
          setImageStatus('\u6b63\u5728\u5bfc\u5165\u672c\u5730\u56fe\u7247...');
          await importLocalImageForItem(index, file);
        } catch (err) {
          if (imageItems[index]) {
            imageItems[index].status = 'error';
            imageItems[index].error = err.message || String(err);
            renderImageCards();
          }
          setImageStatus('\u5bfc\u5165\u672c\u5730\u56fe\u7247\u5931\u8d25: ' + (err.message || String(err)));
        }
      });
    }
    if (videoAssetListEl) {
      const syncVideoPromptInput = (target) => {
        const promptInput = target.closest('[data-video-prompt]');
        if (!promptInput) return false;
        const index = Number(promptInput.dataset.videoPrompt);
        if (!Number.isInteger(index) || !videoItems[index]) return true;
        const value = String(promptInput.value || '').slice(0, 1800);
        videoItems[index].videoPrompt = value;
        videoItems[index].prompt = value;
        videoItems[index].promptEdited = true;
        scheduleReviewStateSave(180);
        return true;
      };
      videoAssetListEl.addEventListener('input', (e) => {
        syncVideoPromptInput(e.target);
      });
      videoAssetListEl.addEventListener('change', (e) => {
        syncVideoPromptInput(e.target);
      });
      videoAssetListEl.addEventListener('click', async (e) => {
        const retryBtn = e.target.closest('[data-video-retry]');
        if (retryBtn) {
          const index = Number(retryBtn.dataset.videoRetry);
          if (!Number.isInteger(index)) return;
          try {
            setVideoAssetStatus('正在重试第 ' + (index + 1) + ' 段视频素材...');
            await generateOneVideoAsset(index, !videoItems[index]?.promptEdited);
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
      if (waveZoomPopoverEl && !waveZoomPopoverEl.hidden) {
        const insideWaveZoom = !!(waveZoomPopoverEl.contains(e.target) || (btnWaveZoom && btnWaveZoom.contains(e.target)));
        if (!insideWaveZoom) setWaveZoomPopoverOpen(false);
      }
      if (!leftPanelOpen && !imagePanelOpen && !rightPanelOpen && !logPanelOpen) return;
      const target = e.target;
      const insideLeft = !!(leftPanelEl && leftPanelEl.contains(target));
      const insideImage = !!(imagePanelEl && imagePanelEl.contains(target));
      const insideRight = !!(rightPanelEl && rightPanelEl.contains(target));
      const insideLog = !!(logPanelEl && logPanelEl.contains(target));
      const onLeftToggle = !!(btnToggleLeftPanel && btnToggleLeftPanel.contains(target));
      const onImageToggle = !!(btnToggleImagePanel && btnToggleImagePanel.contains(target));
      const onRightToggle = !!(btnToggleRightPanel && btnToggleRightPanel.contains(target));
      const onLogToggle = !!(btnToggleLogPanel && btnToggleLogPanel.contains(target));
      if (insideLeft || insideImage || insideRight || insideLog || onLeftToggle || onImageToggle || onRightToggle || onLogToggle) return;
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
        syncCompositePreviewBounds();
        syncCompositePreviewOverlay();
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
        syncMediaAspectToSourceVideo();
        setVideoPreviewStatus('已加载');
        syncCompositePreviewBounds();
        syncVideoPreview(true);
      });
      sourceVideoEl.addEventListener('resize', () => {
        syncCompositePreviewBounds();
        syncCompositePreviewOverlay();
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
        // The source video is a visual preview only. Let the review audio drive playback to avoid double audio or jitter.
      });
      sourceVideoEl.addEventListener('pause', () => {
        // Visual preview should never pause the review audio.
      });
      sourceVideoEl.addEventListener('seeked', () => {
        // Visual preview seeks are driven by audio timeupdate/syncVideoPreview.
      });
    }

    audio.addEventListener('timeupdate', () => {
      syncCurrentToken();
      syncVideoPreview(false);
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
      stopCompositePreviewLoop();
      if (videoPreviewEnabled && sourceVideoEl && !sourceVideoEl.paused) sourceVideoEl.pause();
      drawWaveform();
      scheduleReviewStateSave(200);
    });
    audio.addEventListener('ended', () => {
      stopSyncTimer();
      cancelSkipFade();
      stopCompositePreviewLoop();
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
      setMediaMode('image');
      setToolPanel('marking');
      setWaveZoom(1);
      applyBoundarySettings(DEFAULT_BOUNDARY);
      renderQualityWarnings();
      render();
      syncUndoButton();
      renderPublishSuggestions({ titles: [], descriptions: [], keywords: [] });
      renderVisualReference();
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
      await loadJianyingDraftTargets(false);
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
