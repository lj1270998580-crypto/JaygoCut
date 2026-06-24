#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execSync } = require('child_process');
const { normalizeSelectedIndices } = require('./auto_selected_utils');
const { normalizeBoundarySettings } = require('./review_segment_utils');

const PORT = Number(process.argv[2]) || 8899;
const VIDEO_FILE = process.argv[3] || findVideoFile(process.cwd());
const OUTPUT_ROOT_ARG = String(process.argv[4] || '').trim();
const FFPROBE_BIN = process.env.FFPROBE_BIN || 'ffprobe';
const LLM_MIN_CONFIDENCE = 0.72;
const LLM_SEMANTIC_MIN_CONFIDENCE = 0.78;
const LLM_MAX_DELETE_RATIO = 0.10;
const LLM_PROVIDER_KEYS = new Set([
  'openai',
  'anthropic',
  'openrouter',
  'openclaw',
  'xai',
  'groq',
  'together',
  'deepseek',
  'qwen',
  'moonshot',
  'zhipu',
  'volcengine_ark',
  'siliconflow',
  'custom',
]);
const OPENAI_COMPATIBLE_PROVIDERS = new Set(
  Array.from(LLM_PROVIDER_KEYS).filter((key) => key !== 'anthropic'),
);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};
const REVIEW_STATE_FILE = path.resolve(process.cwd(), 'review_state.json');
const REVIEW_STATE_BACKUP_FILE = path.resolve(process.cwd(), 'review-state.backup.json');
const IMAGE_ASSET_DIR = path.resolve(process.cwd(), 'image_assets');
const VIDEO_ASSET_DIR = path.resolve(process.cwd(), 'video_assets');
const AGNES_API_BASE_URL = 'https://apihub.agnes-ai.com/v1';
const AGNES_IMAGE_MODEL = 'agnes-image-2.1-flash';
const AGNES_VIDEO_MODEL = 'agnes-video-v2.0';
const AGNES_MIN_REQUEST_INTERVAL_MS = 3200;
const JIANYING_DRAFT_EXPORT_DIR_NAME = 'jianying_drafts';

let lastAgnesRequestAt = 0;

let currentCutJob = {
  jobId: null,
  state: 'idle',
  phase: 'idle',
  startedAt: null,
  finishedAt: null,
  segmentsCount: 0,
  logTail: [],
  result: null,
  error: '',
};

function fileArg(p) {
  return process.platform === 'win32' ? p : `file:${p}`;
}

function shellQuote(v) {
  return `"${String(v).replace(/"/g, '\\"')}"`;
}

function findVideoFile(dir) {
  const candidates = fs.readdirSync(dir).filter((name) => {
    const ext = path.extname(name).toLowerCase();
    return ext === '.mp4' || ext === '.mov' || ext === '.m4v' || ext === '.mkv';
  });
  return candidates[0] || 'source.mp4';
}

function parseDotEnv(content) {
  const out = {};
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).replace(/\s+#.*$/, '').trim();
    out[key] = value;
  }
  return out;
}

function loadEnvFileConfig() {
  const candidates = [
    process.env.JAYGO_ENV_FILE,
    path.join(__dirname, '..', '..', '.env'),
    path.join(process.cwd(), '.env'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = parseDotEnv(fs.readFileSync(candidate, 'utf8'));
      return { env: parsed, envFile: candidate };
    } catch (err) {
      console.warn(`Failed to read env file ${candidate}: ${err.message}`);
    }
  }

  return { env: {}, envFile: '' };
}

function envValue(fileEnv, name, fallback = '') {
  if (fileEnv && Object.prototype.hasOwnProperty.call(fileEnv, name)) {
    return fileEnv[name];
  }
  if (Object.prototype.hasOwnProperty.call(process.env, name)) {
    return process.env[name];
  }
  return fallback;
}

function getRuntimeInfo() {
  const { env: fileEnv, envFile } = loadEnvFileConfig();
  const resolvedVideo = path.resolve(VIDEO_FILE);
  const themeMode = String(process.env.JAYGO_THEME_MODE || fileEnv.JAYGO_THEME_MODE || 'light').trim().toLowerCase();
  const normalizedTheme = themeMode === 'blackgold' || themeMode === 'system' ? themeMode : 'light';
  const videoExists = !!(resolvedVideo && fs.existsSync(resolvedVideo));
  const videoMissingMessage = String(process.env.JAYGO_REVIEW_VIDEO_MISSING_MESSAGE || '').trim();

  const configuredOutput = [
    OUTPUT_ROOT_ARG,
    String(process.env.DEFAULT_OUTPUT_DIR || '').trim(),
    String(fileEnv.DEFAULT_OUTPUT_DIR || '').trim(),
  ].find((v) => v && String(v).trim());

  if (configuredOutput) {
    const cutOutputDir = path.resolve(configuredOutput);
    let source = 'DEFAULT_OUTPUT_DIR';
    if (OUTPUT_ROOT_ARG) source = 'command argument';
    else if (process.env.DEFAULT_OUTPUT_DIR) source = 'process env';
    else if (fileEnv.DEFAULT_OUTPUT_DIR) source = `env file (${envFile})`;

    return {
      cutOutputDir,
      videoFile: resolvedVideo,
      videoExists,
      videoMissingMessage,
      envFile,
      themeMode: normalizedTheme,
      usesConfiguredOutputDir: true,
      outputSourceText: `Using ${source}: ${cutOutputDir}`,
    };
  }

  const fallback = path.join(path.dirname(resolvedVideo), 'output');
  return {
    cutOutputDir: fallback,
    videoFile: resolvedVideo,
    videoExists,
    videoMissingMessage,
    envFile,
    themeMode: normalizedTheme,
    usesConfiguredOutputDir: false,
    outputSourceText: 'DEFAULT_OUTPUT_DIR is empty; fallback to sibling output/ directory.',
  };
}

function normalizeLlmBaseUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  return value.replace(/\/+$/, '');
}

function normalizeLlmProviderKey(value) {
  const key = String(value || '').trim();
  return LLM_PROVIDER_KEYS.has(key) ? key : 'custom';
}

function buildOpenAiCompletionsEndpoint(baseUrl) {
  const clean = normalizeLlmBaseUrl(baseUrl);
  if (/\/chat\/completions$/i.test(clean)) return clean;
  return `${clean}/chat/completions`;
}

function buildAnthropicMessagesEndpoint(baseUrl) {
  const clean = normalizeLlmBaseUrl(baseUrl || 'https://api.anthropic.com');
  if (/\/v1$/i.test(clean)) return `${clean}/messages`;
  return `${clean}/v1/messages`;
}

function parseLlmTemperature(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0.2;
  return Math.max(0, Math.min(1.5, num));
}

function getLlmConfig() {
  const { env: fileEnv } = loadEnvFileConfig();
  const provider = normalizeLlmProviderKey(
    envValue(fileEnv, 'LLM_PROVIDER', 'openai'),
  );
  const defaultBaseUrl = provider === 'anthropic'
    ? 'https://api.anthropic.com'
    : 'https://api.openai.com/v1';
  const baseUrl = normalizeLlmBaseUrl(
    envValue(fileEnv, 'LLM_API_BASE_URL', defaultBaseUrl),
  );
  const apiKey = String(envValue(fileEnv, 'LLM_API_KEY', '') || '').trim();
  const model = String(envValue(fileEnv, 'LLM_MODEL', '') || '').trim();
  const temperature = parseLlmTemperature(envValue(fileEnv, 'LLM_TEMPERATURE', '0.2'));

  const missing = [];
  if (!baseUrl) missing.push('LLM_API_BASE_URL');
  if (!apiKey) missing.push('LLM_API_KEY');
  if (!model) missing.push('LLM_MODEL');

  return {
    provider,
    baseUrl,
    apiKey,
    model,
    temperature,
    ready: missing.length === 0,
    missing,
  };
}

function normalizeImageSize(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (/^\d{1,2}:\d{1,2}$/.test(raw)) return raw;
  if (/^\d{3,4}x\d{3,4}$/.test(raw)) return raw;
  if (['1024x1024', '1024x1792', '1792x1024', '1536x1024', '1024x1536'].includes(raw)) return raw;
  return '1024x1024';
}

function buildImageEndpoint(baseUrl) {
  const clean = normalizeLlmBaseUrl(baseUrl);
  if (/minimaxi\.com/i.test(clean)) return 'https://api.minimaxi.com/v1/image_generation';
  if (/\/image_generation$/i.test(clean)) return clean;
  if (/\/images\/generations$/i.test(clean)) return clean;
  return `${clean}/images/generations`;
}

function isMiniMaxImageEndpoint(endpoint) {
  return /minimaxi\.com\/v1\/image_generation/i.test(String(endpoint || ''));
}

function imageSizeToMiniMaxAspectRatio(size) {
  const raw = String(size || '').trim().toLowerCase();
  if (/^\d{1,2}:\d{1,2}$/.test(raw)) return raw;
  const match = raw.match(/^(\d{3,4})x(\d{3,4})$/);
  if (!match) return '1:1';
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return '1:1';
  const ratio = w / h;
  if (ratio > 1.55) return '16:9';
  if (ratio < 0.75) return '9:16';
  if (ratio > 1.25) return '4:3';
  if (ratio < 0.9) return '3:4';
  return '1:1';
}

function imageSizeToOpenAiSize(size) {
  const raw = String(size || '').trim().toLowerCase();
  if (/^\d{3,4}x\d{3,4}$/.test(raw)) return raw;
  if (raw === '16:9' || raw === '4:3') return '1536x1024';
  if (raw === '9:16' || raw === '2:3' || raw === '3:4') return '1024x1536';
  return '1024x1024';
}

function imageSizeToAgnesSize(size) {
  const raw = String(size || '').trim().toLowerCase();
  if (/^\d{3,4}x\d{3,4}$/.test(raw)) {
    const [w, h] = raw.split('x').map((v) => Number(v));
    if (w === h) return '1024x1024';
    return w > h ? '1024x768' : '768x1024';
  }
  if (raw === '16:9' || raw === '4:3') return '1024x768';
  if (raw === '9:16' || raw === '2:3' || raw === '3:4') return '768x1024';
  return '1024x1024';
}

function getImageConfig() {
  const { env: fileEnv } = loadEnvFileConfig();
  const llm = getLlmConfig();
  const rawBaseUrl = normalizeLlmBaseUrl(
    envValue(fileEnv, 'IMAGE_API_BASE_URL', AGNES_API_BASE_URL),
  );
  const endpoint = buildImageEndpoint(rawBaseUrl);
  const minimax = isMiniMaxImageEndpoint(endpoint);
  const canReuseLlmKey = !/agnes/i.test(rawBaseUrl) || /agnes/i.test(llm.baseUrl);
  const apiKey = String(
    envValue(fileEnv, 'IMAGE_API_KEY', '')
    || (canReuseLlmKey ? llm.apiKey : '')
    || '',
  ).trim();
  const model = String(
    envValue(fileEnv, 'IMAGE_MODEL', minimax ? 'image-01' : AGNES_IMAGE_MODEL),
  ).trim();
  const size = normalizeImageSize(envValue(fileEnv, 'IMAGE_SIZE', '1024x1024'));
  const missing = [];
  if (!rawBaseUrl) missing.push('IMAGE_API_BASE_URL');
  if (!apiKey) missing.push('IMAGE_API_KEY');
  if (!model) missing.push('IMAGE_MODEL');
  return {
    baseUrl: rawBaseUrl,
    apiKey,
    model,
    size,
    ready: missing.length === 0,
    missing,
    endpoint,
    provider: minimax ? 'minimax' : (/agnes/i.test(rawBaseUrl) ? 'agnes' : 'openai_compatible'),
  };
}

function buildVideoEndpoint(baseUrl) {
  const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!clean) return '';
  if (/\/videos$/i.test(clean)) return clean;
  if (/\/v1$/i.test(clean)) return `${clean}/videos`;
  return `${clean}/v1/videos`;
}

function buildAgnesVideoQueryEndpoint(baseUrl, videoId) {
  const clean = String(baseUrl || AGNES_API_BASE_URL).trim();
  let origin = 'https://apihub.agnes-ai.com';
  try {
    origin = new URL(clean).origin;
  } catch {
    origin = 'https://apihub.agnes-ai.com';
  }
  return `${origin}/agnesapi?video_id=${encodeURIComponent(videoId)}`;
}

function buildAgnesVideoStatusEndpoint(baseUrl, videoId) {
  const clean = String(baseUrl || AGNES_API_BASE_URL).trim().replace(/\/+$/, '');
  const base = /\/v1$/i.test(clean) ? clean : `${clean}/v1`;
  return `${base}/videos/${encodeURIComponent(videoId)}`;
}

function buildAgnesVideoQueryEndpoints(baseUrl, videoId) {
  return [
    buildAgnesVideoQueryEndpoint(baseUrl, videoId),
    buildAgnesVideoStatusEndpoint(baseUrl, videoId),
  ];
}

function normalizeVideoFrameCount(value, fallback = 121) {
  const allowed = [81, 121, 161, 241, 441];
  const n = Number(value);
  if (allowed.includes(n)) return n;
  return fallback;
}

function clampDurationSec(value, min, max, fallback) {
  const parsed = Number(value);
  const next = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.max(min, Math.min(max, next));
}

function videoDurationToGenerationParams(durationSec) {
  const target = clampDurationSec(durationSec, 3, 8, 5);
  if (target <= 3.9) return { numFrames: 81, frameRate: 24, generationDurationSec: 81 / 24 };
  if (target <= 5.6) return { numFrames: 121, frameRate: 24, generationDurationSec: 121 / 24 };
  if (target <= 7.2) return { numFrames: 161, frameRate: 24, generationDurationSec: 161 / 24 };
  return { numFrames: 241, frameRate: 30, generationDurationSec: 241 / 30 };
}

function aspectToVideoSize(aspect) {
  const raw = String(aspect || '').trim();
  if (raw === '9:16' || raw === '2:3' || raw === '3:4') return { width: 768, height: 1152 };
  if (raw === '1:1') return { width: 1024, height: 1024 };
  return { width: 1152, height: 768 };
}

function getVideoConfig() {
  const { env: fileEnv } = loadEnvFileConfig();
  const llm = getLlmConfig();
  const imageBaseUrl = envValue(fileEnv, 'IMAGE_API_BASE_URL', '');
  const rawBaseUrl = normalizeLlmBaseUrl(
    envValue(fileEnv, 'VIDEO_API_BASE_URL', '')
    || imageBaseUrl
    || AGNES_API_BASE_URL,
  );
  const canReuseLlmKey = !/agnes/i.test(rawBaseUrl) || /agnes/i.test(llm.baseUrl);
  const apiKey = String(
    envValue(fileEnv, 'VIDEO_API_KEY', '')
    || envValue(fileEnv, 'IMAGE_API_KEY', '')
    || (canReuseLlmKey ? llm.apiKey : '')
    || '',
  ).trim();
  const model = String(
    envValue(fileEnv, 'VIDEO_MODEL', AGNES_VIDEO_MODEL),
  ).trim();
  const endpoint = buildVideoEndpoint(rawBaseUrl);
  const missing = [];
  if (!rawBaseUrl) missing.push('VIDEO_API_BASE_URL');
  if (!apiKey) missing.push('VIDEO_API_KEY');
  if (!model) missing.push('VIDEO_MODEL');
  return {
    baseUrl: rawBaseUrl,
    apiKey,
    model,
    endpoint,
    ready: missing.length === 0,
    missing,
    provider: /agnes/i.test(rawBaseUrl) ? 'agnes' : 'openai_compatible',
  };
}

function joinWordTokens(tokens) {
  let out = '';
  const isAsciiWord = (text) => /^[A-Za-z0-9]+$/.test(text);
  for (const tokenRaw of tokens) {
    const token = String(tokenRaw || '').trim();
    if (!token) continue;
    if (!out) {
      out = token;
      continue;
    }
    const prev = out.slice(-1);
    if (isAsciiWord(prev) && isAsciiWord(token)) {
      out += ` ${token}`;
    } else {
      out += token;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

function buildTranscriptUnits(words) {
  const units = [];
  let startIndex = -1;
  let startTime = 0;
  let endTime = 0;
  let tokens = [];

  const flush = () => {
    if (startIndex < 0 || !tokens.length) {
      startIndex = -1;
      tokens = [];
      return;
    }

    const text = joinWordTokens(tokens);
    if (text) {
      units.push({
        id: units.length + 1,
        start: Number(startTime) || 0,
        end: Number(endTime) || Number(startTime) || 0,
        text: text.slice(0, 260),
        startIndex,
        endIndex: startIndex + tokens.length - 1,
      });
    }

    startIndex = -1;
    tokens = [];
  };

  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] || {};
    const isGap = !!w.isGap;
    const text = String(w.text || '').trim();
    const start = Number(w.start);
    const end = Number(w.end);

    if (isGap) {
      flush();
      continue;
    }
    if (!text) continue;

    if (startIndex < 0) {
      startIndex = i;
      startTime = Number.isFinite(start) ? start : 0;
      endTime = Number.isFinite(end) ? end : startTime;
      tokens = [text];
      continue;
    }

    endTime = Number.isFinite(end) ? end : endTime;
    tokens.push(text);

    if (
      tokens.length >= 36
      || (Number.isFinite(startTime) && Number.isFinite(endTime) && (endTime - startTime) >= 12)
      || /[\u3002\uFF01\uFF1F!?\uFF1B;]/.test(text)
    ) {
      flush();
    }
  }
  flush();
  return units;
}

function chunkTranscriptUnits(units, maxUnits = 120, maxChars = 7000) {
  const chunks = [];
  let current = [];
  let chars = 0;

  for (const unit of units) {
    const lineLen = unit.text.length + 48;
    if (current.length && (current.length >= maxUnits || chars + lineLen > maxChars)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(unit);
    chars += lineLen;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function buildTopicProbePrompt(units) {
  const list = units
    .slice(0, 220)
    .map((u) => `${u.id}|${u.start.toFixed(2)}-${u.end.toFixed(2)}|${u.text}`)
    .join('\n');

  return [
    '你是中文口播剪辑大师（脚本理解阶段）。',
    '任务1：先理解文本，不做删除。',
    '输出 JSON（只返回 JSON，不要 markdown）：',
    '{"analysis":{"topic":"", "outline":"", "multiSpeaker":false, "mainSpeakerHint":"", "style":"口播/访谈/聊天"}}',
    '规则：topic 不超过 18 字；outline 不超过 60 字；若无法确定则给最保守结论。',
    '文本单元（id|start-end|text）：',
    list,
  ].join('\n');
}

function buildStructurePrompt(units, analysis) {
  const list = units
    .slice(0, 260)
    .map((u) => `${u.id}|${u.start.toFixed(2)}-${u.end.toFixed(2)}|${u.text}`)
    .join('\n');
  return [
    '你是口播脚本结构分析器（短视频版）。',
    `主题参考: ${String(analysis?.topic || '').trim() || '未知'}`,
    `梗概参考: ${String(analysis?.outline || '').trim() || '未知'}`,
    '请按 Hook-Value-Proof-Close 识别结构段落，并标出必须保留的句段 id（不要过多，优先关键事实/结论/数字/因果）。',
    '输出 JSON（只返回 JSON）：',
    '{"structure":{"sections":[{"start_id":1,"end_id":30,"role":"Hook|Value|Proof|Close"}],"must_keep_ids":[1,2,5],"risk_notes":["..."]}}',
    '文本单元（id|start-end|text）：',
    list,
  ].join('\n');
}

function buildPublishSuggestionPrompt(units, analysis, style) {
  const list = units
    .slice(0, 220)
    .map((u) => `${u.id}|${u.text}`)
    .join('\n');
  const mode = ['保守', '吸睛', '专业'].includes(style) ? style : '专业';
  return [
    '你是中文自媒体标题与简介编辑器。',
    `主题: ${String(analysis?.topic || '').trim() || '未知'}`,
    `梗概: ${String(analysis?.outline || '').trim() || '未知'}`,
    `风格: ${mode}`,
    '请生成 10 个标题（每个不超过30字）和 3 个作品简介（每个不超过140字）。',
    '要求：不夸张、不造假、避免敏感违规词。',
    '输出 JSON（只返回 JSON）：',
    '{"titles":["..."],"descriptions":["..."],"keywords":["..."]}',
    '文本素材（id|text）：',
    list,
  ].join('\n');
}

function pickUnitsForChatAdjust(units, selectedUnitIds, userMessage, maxUnits = 420) {
  if (!Array.isArray(units) || !units.length) return [];
  if (units.length <= maxUnits) return units;
  const selectedSet = new Set(Array.isArray(selectedUnitIds) ? selectedUnitIds : []);
  const picked = new Set();
  const addRange = (start, end) => {
    for (let i = Math.max(0, start); i <= Math.min(units.length - 1, end); i += 1) {
      picked.add(i);
      if (picked.size >= maxUnits) return;
    }
  };

  const msg = String(userMessage || '');
  const wantsHead = /(开头|前半|前面|前段)/.test(msg);
  const wantsTail = /(结尾|后半|后面|后段)/.test(msg);

  addRange(0, wantsHead ? 210 : 70);
  addRange(units.length - (wantsTail ? 210 : 70), units.length - 1);

  if (selectedSet.size) {
    for (let i = 0; i < units.length; i += 1) {
      if (!selectedSet.has(units[i].id)) continue;
      addRange(i - 14, i + 14);
      if (picked.size >= maxUnits) break;
    }
  }

  if (picked.size < maxUnits) {
    const step = Math.max(1, Math.floor(units.length / Math.max(1, maxUnits - picked.size)));
    for (let i = 0; i < units.length && picked.size < maxUnits; i += step) {
      picked.add(i);
    }
  }

  return Array.from(picked)
    .sort((a, b) => a - b)
    .slice(0, maxUnits)
    .map((i) => units[i]);
}


function formatMediaItemsForChat(mediaAssets) {
  const images = Array.isArray(mediaAssets?.images) ? mediaAssets.images : [];
  const videos = Array.isArray(mediaAssets?.videos) ? mediaAssets.videos : [];
  const rows = [];
  const append = (kind, item, index) => {
    if (!item) return;
    const id = String(item.id || (kind + '_' + (index + 1))).replace(/[^\w-]/g, '_').slice(0, 48);
    const start = Number.isFinite(Number(item.start)) ? Number(item.start) : 0;
    const end = Number.isFinite(Number(item.end)) ? Number(item.end) : start + (kind === 'video' ? 5 : 7);
    const promptText = kind === 'video' ? (item.videoPrompt || item.prompt || '') : (item.prompt || '');
    rows.push([
      kind + '#' + (index + 1),
      id,
      start.toFixed(2) + '-' + end.toFixed(2),
      String(item.status || 'queued').slice(0, 20),
      String(item.title || '').replace(/\s+/g, ' ').slice(0, 80),
      String(item.purpose || '').replace(/\s+/g, ' ').slice(0, 100),
      String(promptText || '').replace(/\s+/g, ' ').slice(0, 260),
    ].join('|'));
  };
  images.slice(0, 40).forEach((item, index) => append('image', item, index));
  videos.slice(0, 40).forEach((item, index) => append('video', item, index));
  return rows.length ? rows.join('\n') : 'none';
}

function buildChatAdjustPrompt(units, selectedUnitIds, userMessage, history, analysis, mediaAssets = {}) {
  const scopedUnits = pickUnitsForChatAdjust(units, selectedUnitIds, userMessage);
  const list = scopedUnits
    .map((u) => `${u.id}|${u.start.toFixed(2)}-${u.end.toFixed(2)}|${u.text}`)
    .join('\n');
  const mediaList = formatMediaItemsForChat(mediaAssets);
  const selectedText = selectedUnitIds.slice(0, 240).join(',');
  const hist = Array.isArray(history)
    ? history.slice(-10).map((it) => `${it.role || 'user'}: ${String(it.text || '').slice(0, 180)}`).join('\n')
    : '';
  return [
    'Role: You are Jaygo Cut AI Butler, an operations assistant with permission to plan safe edits, media cards, and draft-export actions for the review page.',
    'When the user asks for an operation, translate it into precise JSON changes instead of generic advice. Prefer reversible, conservative edits.',
    '你是口播短视频剪辑师，正在根据用户反馈二次调整删除标记。',
    `主题: ${String(analysis?.topic || '').trim() || '未知'}`,
    `梗概: ${String(analysis?.outline || '').trim() || '未知'}`,
    '',
    '任务：只返回需要新增删除或取消删除的文本单元 id，不改原文。',
    '硬规则：不删除事实、数字、人名/地名、因果关系、转折、结论、关键情绪点；不确定就不要动。',
    '优先删除：孤立语气词、明显重说/改口、同一句重复表达、入题前闲聊、离题闲聊、非主讲人的干扰话。',
    '如果用户要求“更狠一点”，也必须保留主线完整；如果用户要求“更保守”，优先取消低置信标记。',
    `当前已选 id: ${selectedText || '无'}`,
    `用户要求: ${String(userMessage || '').trim()}`,
    hist ? `最近对话:\n${hist}` : '最近对话: 无',
    '',
    '',
    'Media adjustment rules:',
    'You may also adjust planned images/videos when the user asks about illustration, picture, image, video, B-roll, material, timing, duration, prompt, retry, or regeneration.',
    'Return media_actions only as a plan. Do not claim files are generated. Do not call external tools.',
    'Allowed action types: add_image, update_image, move_image, delete_image, regenerate_image, add_video, update_video, move_video, delete_video, regenerate_video.',
    'Image duration must be 5-10 seconds. Video duration must be 3-8 seconds. Avoid overlapping media ranges whenever possible.',
    'For add/update/regenerate, write concrete visual prompts with scene, subject, action, setting, mood, lens, and style. Do not merely repeat transcript text.',
    'If changing an existing card, use its exact id. If adding a new card, provide a new readable id.',
    'If the user says "第2张图", "第二张图片", "第1段视频", or similar ordinal wording, map it to the Existing media items ordinal and return either the exact id or index.',
    '',
    `Existing media items (kind#index|id|start-end|status|title|purpose|prompt):\n${mediaList}`,
    '',
    '输出 JSON（只返回 JSON）：',
    '{"add_ids":[12,13],"remove_ids":[2,3],"media_actions":[{"type":"update_image","id":"img_01","start":12.5,"durationSec":7,"title":"scene title","purpose":"why this visual helps","prompt":"concrete visual prompt","negativePrompt":"optional","regenerate":true}],"reason":"Chinese, <=60 chars","summary":"Chinese, <=80 chars","scope":"head|middle|tail|full"}',
    '',
    `文本单元（本次可用 ${scopedUnits.length} 条，id|start-end|text）：`,
    list,
  ].join('\n');
}
function buildLlmPrompt(chunkUnits, context = {}) {
  const list = chunkUnits
    .map((u) => `${u.id}|${u.start.toFixed(2)}-${u.end.toFixed(2)}|${u.text}`)
    .join('\n');
  const topic = String(context.topic || '').trim();
  const outline = String(context.outline || '').trim();
  const multiSpeaker = context.multiSpeaker ? 'true' : 'false';
  const mainSpeakerHint = String(context.mainSpeakerHint || '').trim();
  const precisionRules = [
    'You are a senior short-form talking-head editor. Improve rhythm, but protect meaning first.',
    'Before marking anything, infer the role of this chunk in the whole script: hook, setup, point, proof, example, contrast, conclusion, or off-topic chat.',
    'Only mark text that can be removed while the sentence before and after still reads naturally and the argument remains complete.',
    'For repeated ideas, keep the clearer and more complete version; delete only the weaker duplicate or abandoned restart.',
    'For filler words, delete only standalone or consecutive fillers. Keep fillers that carry emotion, transition, hesitation, or speaker personality.',
    'Never delete facts, numbers, names, places, causal links, contrast words, key nouns, conclusions, or necessary setup unless confidence >= 0.88.',
  ];

  return [
    ...precisionRules,
    '你是资深口播短视频剪辑师，目标是提升节奏和信息密度，但绝不能破坏观点完整性。',
    '你必须先理解主题和结构，再决定是否标记删除。删除是高风险操作：宁可少删，也不要误删。',
    '',
    '分步执行：',
    '1) 理解主题：识别本段在全片中的作用，是开场钩子、观点、论据、案例、转折、总结，还是闲聊。',
    '2) 保护主线：凡是承载观点、事实、数字、因果、转折、对象、结论、关键情绪或叙事推进的内容，一律保留。',
    '硬规则：不删除事实、数字、人名地名、因果链、转折句、观点句和结论句。',
    '3) 规则删除优先级：只标记可独立移除且移除后前后仍自然的内容。',
    '   - filler：孤立或连续的嗯、呃、啊、这个、那个、就是、然后等口头禅；如果它连接逻辑或承载语气，不删。',
    '   - repeat：同一意思重复表达、重说、改口、卡壳；保留更完整、更清楚、离后文更顺的一版。',
    '   - opening_offtopic：真正入题前的测试、寒暄、设备/衣服/环境闲聊。',
    '   - off_topic：与主题无关且不作为案例/铺垫/反差钩子的闲聊。',
    '   - other_speaker：多人对话中非主讲人的干扰内容；若推动提问、反问或补充信息则保留。',
    '   - ending_offtopic：结论后继续发散、感谢闲聊、无关收尾。',
    '4) 不要“见词就删”：少量自然停顿、语气词、重复强调可能是人物风格或情绪节奏，保留。',
    '5) 标点与分段：根据语义补标点；只在话题推进、观点切换、案例切换、结论收束处 paragraph_after=true；不要按固定字数分段。',
    '6) 置信度：语义删除 confidence 必须 >=0.72；纯语气词/明显重复可 >=0.66；低于阈值不要输出。',
    '7) 数量控制：除非文本大面积跑题，否则 mark_delete 不要超过本批文本单元的 12%。',
    '',
    '必须保留示例：否定词、转折词、因果词、数字、人名地名、核心名词、观点句、结论句、包袱/反差点。',
    '可以删除示例：单独的“嗯/啊/就是”、马上被完整重说的一半句、连续两遍同义句里的弱版本、入题前“测试一下能不能听到”。',
    '',
    `全局主题参考: ${topic || '未知'}`,
    `全局梗概参考: ${outline || '未知'}`,
    `是否多人对话(预判): ${multiSpeaker}`,
    `主讲人线索(预判): ${mainSpeakerHint || '未知'}`,
    '',
    '输出 JSON（只返回 JSON，不要 markdown）：',
    '{"analysis":{"topic":"","outline":"","multiSpeaker":false,"mainSpeakerHint":""},',
    '"mark_delete":[{"id":12,"reason_type":"filler|repeat|off_topic|other_speaker|opening_offtopic|ending_offtopic|nonsense","reason":"中文简短说明","confidence":0.82}],',
    '"punctuation_plan":[{"id":12,"punct":"，|。|？|！|；|：|","paragraph_after":false}]}',
    '',
    '文本单元（id|start-end|text）：',
    list,
  ].join('\n');
}
function collectTextFragments(raw, out = []) {
  if (raw === null || raw === undefined) return out;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text) out.push(text);
    return out;
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    out.push(String(raw));
    return out;
  }
  if (Array.isArray(raw)) {
    raw.forEach((item) => collectTextFragments(item, out));
    return out;
  }
  if (typeof raw === 'object') {
    if (typeof raw.text === 'string') collectTextFragments(raw.text, out);
    if (typeof raw.content === 'string') collectTextFragments(raw.content, out);
    if (Array.isArray(raw.content)) collectTextFragments(raw.content, out);
    if (typeof raw.output_text === 'string') collectTextFragments(raw.output_text, out);
    if (typeof raw.completion === 'string') collectTextFragments(raw.completion, out);
    if (typeof raw.result === 'string') collectTextFragments(raw.result, out);
    if (raw.delta && typeof raw.delta.text === 'string') collectTextFragments(raw.delta.text, out);
    if (raw.message) collectTextFragments(raw.message, out);
  }
  return out;
}

function parseAssistantContent(raw) {
  return collectTextFragments(raw, []).join('\n').trim();
}

function extractLlmResponseText(provider, json) {
  const candidates = provider === 'anthropic'
    ? [
      json?.content,
      json?.output_text,
      json?.completion,
      json?.choices?.[0]?.message?.content,
      json?.message?.content,
      json?.result,
    ]
    : [
      json?.choices?.[0]?.message?.content,
      json?.choices?.[0]?.text,
      json?.output_text,
      json?.completion,
      json?.message?.content,
      json?.result,
      json?.content,
    ];

  for (const candidate of candidates) {
    const text = parseAssistantContent(candidate);
    if (text) return text;
  }
  return '';
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;

  try {
    return JSON.parse(candidate);
  } catch {
    // ignore
  }

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

async function callOpenAiCompatible(config, prompt) {
  if (!OPENAI_COMPATIBLE_PROVIDERS.has(config.provider)) {
    throw new Error(`Unsupported OpenAI-compatible provider: ${config.provider}`);
  }

  const endpoint = buildOpenAiCompletionsEndpoint(config.baseUrl);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature,
      messages: [
        {
          role: 'system',
          content: 'You are a short-video editing assistant. Return strict JSON only.',
        },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM request failed: ${res.status} ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  const text = extractLlmResponseText(config.provider, json);
  if (!text) throw new Error('LLM returned empty content');
  return text;
}

async function callAnthropicMessages(config, prompt) {
  const endpoint = buildAnthropicMessagesEndpoint(config.baseUrl);
  const makeBody = (maxTokens, strict = false) => ({
    model: config.model,
    max_tokens: maxTokens,
    temperature: strict ? 0 : config.temperature,
    system: strict
      ? 'Return strict JSON only. Do not output thinking.'
      : 'You are a short-video editing assistant. Return strict JSON only.',
    messages: [{ role: 'user', content: prompt }],
  });

  const requestOnce = async (maxTokens, strict = false) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': process.env.ANTHROPIC_API_VERSION || '2023-06-01',
      },
      body: JSON.stringify(makeBody(maxTokens, strict)),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic request failed: ${res.status} ${body.slice(0, 300)}`);
    }

    const json = await res.json();
    const text = extractLlmResponseText('anthropic', json);

    return { text, json };
  };

  const first = await requestOnce(1400, false);
  if (first.text) return first.text;

  // Some anthropic-compatible gateways can occasionally return thinking-only blocks.
  const second = await requestOnce(2200, true);
  if (second.text) return second.text;

  const types = Array.isArray(second.json?.content)
    ? second.json.content.map((item) => item?.type || 'unknown').join(',')
    : 'none';
  throw new Error(
    `Anthropic returned empty content after retry (stop_reason=${second.json?.stop_reason || 'unknown'}, content_types=${types})`,
  );
}

async function callLlmProvider(config, prompt) {
  if (config.provider === 'anthropic') {
    return callAnthropicMessages(config, prompt);
  }
  return callOpenAiCompatible(config, prompt);
}

function normalizeReasonType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'nonsense';
  if (raw.includes('filler') || raw.includes('语气')) return 'filler';
  if (raw.includes('repeat') || raw.includes('重复')) return 'repeat';
  if (raw.includes('other') || raw.includes('speaker') || raw.includes('他人')) return 'other_speaker';
  if (raw.includes('opening') || raw.includes('开头')) return 'opening_offtopic';
  if (raw.includes('ending') || raw.includes('结尾')) return 'ending_offtopic';
  if (raw.includes('off') || raw.includes('闲聊') || raw.includes('离题')) return 'off_topic';
  if (raw.includes('nonsense') || raw.includes('废话')) return 'nonsense';
  return 'nonsense';
}

function reasonTypeToZh(type) {
  switch (normalizeReasonType(type)) {
    case 'filler':
      return '语气词/口头禅';
    case 'repeat':
      return '重复句';
    case 'other_speaker':
      return '非主讲人内容';
    case 'opening_offtopic':
      return '开头离题';
    case 'ending_offtopic':
      return '结尾离题';
    case 'off_topic':
      return '与主题无关';
    default:
      return '无效废话';
  }
}

function parseLlmDeleteItems(parsed, validIds) {
  const list = Array.isArray(parsed?.mark_delete)
    ? parsed.mark_delete
    : Array.isArray(parsed?.delete_ids)
      ? parsed.delete_ids
      : Array.isArray(parsed?.deleteIds)
        ? parsed.deleteIds
        : Array.isArray(parsed?.marks)
          ? parsed.marks
          : Array.isArray(parsed?.markDelete)
            ? parsed.markDelete
          : [];

  const out = [];
  for (const item of list) {
    const id = Number(
      typeof item === 'number' ? item
        : (item?.id ?? item?.unit_id ?? item?.unitId),
    );
    if (!Number.isInteger(id) || !validIds.has(id)) continue;
    const confidence = Number.isFinite(Number(item?.confidence))
      ? Math.max(0, Math.min(1, Number(item.confidence)))
      : 0.72;
    const reasonType = normalizeReasonType(item?.reason_type || item?.type || item?.reasonType);
    const reasonText = String(item?.reason || '').trim().slice(0, 80);
    out.push({
      id,
      reasonType,
      reason: reasonText || reasonTypeToZh(reasonType),
      confidence,
    });
  }
  return out;
}

function requiredConfidenceForDelete(item) {
  const type = normalizeReasonType(item?.reasonType || item?.reason_type || item?.type);
  if (type === 'filler' || type === 'repeat') return LLM_MIN_CONFIDENCE;
  return LLM_SEMANTIC_MIN_CONFIDENCE;
}

function isProtectedSemanticText(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (isInfoDenseTextForFallback(raw)) return true;
  if (raw.length >= 42) return true;
  return /(因为|所以|但是|不过|如果|只要|除非|结果|结论|核心|重点|原因|证明|意味着|反而|其实不是|真正|必须|不要|应该|可以|不能|不是|没有)/.test(raw);
}

function shouldKeepLlmDeleteCandidate(unit, item) {
  if (!unit || !item) return false;
  const confidence = Number(item.confidence) || 0;
  const type = normalizeReasonType(item.reasonType);
  if (confidence < requiredConfidenceForDelete(item)) return false;
  if (isProtectedSemanticText(unit.text) && confidence < 0.88) return false;
  const duration = Math.max(0, Number(unit.end) - Number(unit.start));
  if (duration >= 7 && !['off_topic', 'opening_offtopic', 'ending_offtopic', 'other_speaker'].includes(type) && confidence < 0.9) {
    return false;
  }
  return true;
}

function parseLlmDeleteItemsFromText(rawText, validIds) {
  const text = String(rawText || '');
  if (!text.trim()) return [];

  const idSet = new Set();

  const regexes = [
    /"id"\s*:\s*(\d+)/g,
    /\bid\s*[:：]\s*(\d+)/gi,
    /"unit_id"\s*:\s*(\d+)/g,
    /\bunit[_\s-]?id\s*[:：]\s*(\d+)/gi,
  ];

  for (const re of regexes) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const id = Number(m[1]);
      if (Number.isInteger(id) && validIds.has(id)) {
        idSet.add(id);
      }
    }
  }

  const listMatch = text.match(/delete[_\s-]?ids?\s*[:：]\s*\[([^\]]+)\]/i);
  if (listMatch && listMatch[1]) {
    const nums = listMatch[1].match(/\d+/g) || [];
    for (const n of nums) {
      const id = Number(n);
      if (Number.isInteger(id) && validIds.has(id)) {
        idSet.add(id);
      }
    }
  }

  return Array.from(idSet).map((id) => ({
    id,
    reasonType: 'nonsense',
    reason: 'LLM文本回退解析',
    confidence: 0.58,
  }));
}

function normalizeUnitTextForCompare(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[，。！？；：,.!?;:\s"'“”‘’（）()【】\[\]{}<>]/g, '')
    .trim();
}

function isInfoDenseTextForFallback(text) {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  if (/\d/.test(raw)) return true;
  if (/[A-Z]{2,}/.test(raw)) return true;
  if (/(元|岁|%|公里|分钟|小时|日期|时间|第[一二三四五六七八九十\d])/u.test(raw)) return true;
  return false;
}

function diceSimilarityForUnits(a, b) {
  const s1 = normalizeUnitTextForCompare(a);
  const s2 = normalizeUnitTextForCompare(b);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return 0;

  const grams = (s) => {
    const map = new Map();
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2);
      map.set(g, (map.get(g) || 0) + 1);
    }
    return map;
  };
  const g1 = grams(s1);
  const g2 = grams(s2);
  let overlap = 0;
  for (const [k, c1] of g1.entries()) {
    const c2 = g2.get(k) || 0;
    overlap += Math.min(c1, c2);
  }
  const total = (s1.length - 1) + (s2.length - 1);
  return total > 0 ? (2 * overlap) / total : 0;
}

function fillerScoreForUnit(text) {
  const raw = String(text || '').trim();
  if (!raw) return 0;
  const compact = normalizeUnitTextForCompare(raw);
  if (!compact) return 0;

  const fillerWords = [
    '就是', '然后', '那个', '这个', '其实', '你知道', '怎么说', '对吧', '好吧',
    '嗯', '呃', '额', '啊', '哎', '哈', '嘛', '啦',
  ];
  let hits = 0;
  for (const w of fillerWords) {
    if (!w) continue;
    if (compact.includes(w)) hits += w.length;
  }
  return Math.max(0, Math.min(1, hits / Math.max(6, compact.length)));
}

function buildHeuristicFallbackItems(units, maxAllowed) {
  const picked = new Map();
  const pick = (id, reasonType, reason, confidence) => {
    if (!Number.isInteger(id)) return;
    const prev = picked.get(id);
    const next = {
      id,
      reasonType,
      reason,
      confidence: Math.max(0.5, Math.min(0.75, Number(confidence) || 0.6)),
    };
    if (!prev || next.confidence > prev.confidence) {
      picked.set(id, next);
    }
  };

  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    if (!u) continue;
    const text = String(u.text || '');
    if (!text.trim()) continue;
    if (isInfoDenseTextForFallback(text)) continue;

    const fScore = fillerScoreForUnit(text);
    if (fScore >= 0.35 && text.length <= 64) {
      pick(u.id, 'filler', '语气词密度较高', 0.58 + (Math.min(0.18, fScore * 0.2)));
    }
  }

  for (let i = 1; i < units.length; i += 1) {
    const cur = units[i];
    if (!cur || isInfoDenseTextForFallback(cur.text)) continue;
    const curNorm = normalizeUnitTextForCompare(cur.text);
    if (curNorm.length < 4) continue;
    for (let back = 1; back <= 3; back += 1) {
      const j = i - back;
      if (j < 0) break;
      const prev = units[j];
      if (!prev || isInfoDenseTextForFallback(prev.text)) continue;
      const sim = diceSimilarityForUnits(cur.text, prev.text);
      const lenRatio = curNorm.length / Math.max(1, normalizeUnitTextForCompare(prev.text).length);
      if (sim >= 0.84 && lenRatio <= 1.4) {
        pick(cur.id, 'repeat', '与前文重复度高', 0.64);
        break;
      }
    }
  }

  const list = Array.from(picked.values()).sort((a, b) => b.confidence - a.confidence);
  if (!list.length) return [];
  const cap = Math.min(maxAllowed, Math.max(4, Math.ceil(units.length * 0.08)));
  return list.slice(0, cap);
}

function parseLlmPunctuationPlan(parsed, validIds) {
  const list = Array.isArray(parsed?.punctuation_plan)
    ? parsed.punctuation_plan
    : Array.isArray(parsed?.punctuationPlan)
      ? parsed.punctuationPlan
      : Array.isArray(parsed?.punctuation)
        ? parsed.punctuation
        : [];

  const out = [];
  for (const item of list) {
    const id = Number(item?.id);
    if (!Number.isInteger(id) || !validIds.has(id)) continue;
    const punctRaw = String(item?.punct || item?.punctuation || '').trim();
    const punct = /[，。！？；：]/.test(punctRaw) ? punctRaw[0] : '';
    const paragraphAfter = !!(item?.paragraph_after ?? item?.paragraphAfter);
    if (!punct && !paragraphAfter) continue;
    out.push({ id, punct, paragraphAfter });
  }
  return out;
}

function parseLlmAnalysis(parsed) {
  const analysis = parsed?.analysis && typeof parsed.analysis === 'object'
    ? parsed.analysis
    : {};
  return {
    topic: String(analysis.topic || '').trim().slice(0, 80),
    outline: String(analysis.outline || analysis.summary || parsed?.summary || '').trim().slice(0, 120),
    multiSpeaker: !!analysis.multiSpeaker,
    mainSpeakerHint: String(analysis.mainSpeakerHint || '').trim().slice(0, 80),
  };
}

function parseLlmStructure(parsed, validIds) {
  const structure = parsed?.structure && typeof parsed.structure === 'object'
    ? parsed.structure
    : {};
  const sectionsRaw = Array.isArray(structure.sections) ? structure.sections : [];
  const sections = sectionsRaw
    .map((s) => ({
      startId: Number(s?.start_id ?? s?.startId),
      endId: Number(s?.end_id ?? s?.endId),
      role: String(s?.role || '').trim().slice(0, 24),
    }))
    .filter((s) => Number.isInteger(s.startId) && Number.isInteger(s.endId) && s.startId > 0 && s.endId >= s.startId);
  const mustKeepIds = parseIdArray(structure.must_keep_ids || structure.mustKeepIds, validIds);
  const riskNotes = Array.isArray(structure.risk_notes)
    ? structure.risk_notes.map((v) => String(v || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  return {
    sections,
    mustKeepIds,
    riskNotes,
  };
}

function textByUnitIds(units, ids) {
  const set = new Set(ids || []);
  return units
    .filter((u) => set.has(u.id))
    .map((u) => u.text)
    .join(' ');
}

function trimByChars(input, maxChars) {
  const chars = Array.from(String(input || '').trim());
  if (chars.length <= maxChars) return chars.join('');
  return chars.slice(0, maxChars).join('');
}

function sanitizeTitles(rawTitles = []) {
  const out = [];
  const seen = new Set();
  for (const t of rawTitles) {
    const title = trimByChars(String(t || '').replace(/\s+/g, ' '), 30);
    if (!title) continue;
    if (seen.has(title)) continue;
    seen.add(title);
    out.push(title);
    if (out.length >= 10) break;
  }
  return out;
}

function sanitizeDescriptions(rawDescriptions = []) {
  const out = [];
  const seen = new Set();
  for (const d of rawDescriptions) {
    const text = trimByChars(String(d || '').replace(/\s+/g, ' '), 140);
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= 3) break;
  }
  return out;
}

function sanitizeKeywords(rawKeywords = []) {
  const out = [];
  const seen = new Set();
  for (const kw of rawKeywords) {
    const text = trimByChars(String(kw || '').replace(/\s+/g, ' '), 18);
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= 12) break;
  }
  return out;
}

function sanitizeAnalysisInput(raw) {
  const input = (raw && typeof raw === 'object') ? raw : {};
  return {
    topic: trimByChars(String(input.topic || '').trim(), 80),
    outline: trimByChars(String(input.outline || input.summary || '').trim(), 120),
    multiSpeaker: !!input.multiSpeaker,
    mainSpeakerHint: trimByChars(String(input.mainSpeakerHint || '').trim(), 80),
  };
}

async function resolveAnalysis(units, config, inputAnalysis = {}) {
  let analysis = {
    topic: '',
    outline: '',
    multiSpeaker: false,
    mainSpeakerHint: '',
    ...sanitizeAnalysisInput(inputAnalysis),
  };
  if (analysis.topic && analysis.outline) {
    return analysis;
  }
  try {
    const probeRaw = await callLlmProvider(config, buildTopicProbePrompt(units));
    const probeParsed = extractJsonObject(probeRaw);
    if (probeParsed) {
      analysis = {
        ...analysis,
        ...parseLlmAnalysis(probeParsed),
      };
    }
  } catch {
    // keep fallback analysis
  }
  return analysis;
}

function buildFallbackPublishTitles(units, analysis) {
  const topic = trimByChars(String(analysis?.topic || '').trim(), 18);
  const seed = topic || trimByChars(String(units[0]?.text || '').trim(), 16) || '本期内容重点';
  const tails = [
    '：核心观点速看',
    '：这点最值得注意',
    '，一条视频讲清楚',
    '，关键逻辑一次说透',
    '：先看结论',
    '，避免踩坑',
    '：高效理解版',
    '，重点都在这',
    '：建议收藏',
    '，完整版梳理',
  ];
  return tails.map((tail) => trimByChars(`${seed}${tail}`, 30));
}

function buildFallbackPublishDescriptions(units, analysis) {
  const outline = trimByChars(String(analysis?.outline || '').trim(), 70);
  const material = trimByChars(
    units.slice(0, 8).map((u) => String(u.text || '').trim()).filter(Boolean).join('，'),
    120,
  );
  return sanitizeDescriptions([
    outline ? `本期围绕“${outline}”展开，已整理关键观点与结论，方便快速理解。` : '',
    material ? `本视频重点：${material}` : '',
    '内容已完成结构化梳理，可按标题与简介直接用于发布。',
  ]);
}

async function runLlmPublishSuggestions(words, config, style, inputAnalysis) {
  const units = buildTranscriptUnits(words);
  if (!units.length) {
    throw new Error('转录内容为空，无法生成发布建议');
  }
  const analysis = await resolveAnalysis(units, config, inputAnalysis);
  const raw = await callLlmProvider(config, buildPublishSuggestionPrompt(units, analysis, style));
  const parsed = extractJsonObject(raw) || {};

  const titlesRaw = []
    .concat(Array.isArray(parsed.titles) ? parsed.titles : [])
    .concat(Array.isArray(parsed.headlines) ? parsed.headlines : [])
    .concat(Array.isArray(parsed.title_list) ? parsed.title_list : []);
  const descriptionsRaw = []
    .concat(Array.isArray(parsed.descriptions) ? parsed.descriptions : [])
    .concat(Array.isArray(parsed.summary_list) ? parsed.summary_list : [])
    .concat(Array.isArray(parsed.intros) ? parsed.intros : []);
  const keywordsRaw = []
    .concat(Array.isArray(parsed.keywords) ? parsed.keywords : [])
    .concat(Array.isArray(parsed.tags) ? parsed.tags : []);

  let titles = sanitizeTitles(titlesRaw);
  let descriptions = sanitizeDescriptions(descriptionsRaw);
  const keywords = sanitizeKeywords(keywordsRaw);

  if (!titles.length) {
    titles = sanitizeTitles(buildFallbackPublishTitles(units, analysis));
  }
  if (!descriptions.length) {
    descriptions = buildFallbackPublishDescriptions(units, analysis);
  }

  return {
    titles: titles.slice(0, 10),
    descriptions: descriptions.slice(0, 3),
    keywords,
    analysis,
  };
}

function pickWordsForVisualPlan(words, selectedIndices = [], deleteSegments = []) {
  const selectedSet = new Set(
    Array.isArray(selectedIndices)
      ? selectedIndices.map((v) => Number(v)).filter((v) => Number.isInteger(v))
      : [],
  );
  const deletes = Array.isArray(deleteSegments)
    ? deleteSegments
      .map((seg) => ({ start: Number(seg?.start), end: Number(seg?.end) }))
      .filter((seg) => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start)
    : [];
  return (Array.isArray(words) ? words : []).filter((w, i) => {
    if (!w || w.isGap) return false;
    if (selectedSet.has(i)) return false;
    const start = Number(w.start);
    const end = Number(w.end);
    const mid = Number.isFinite(start) && Number.isFinite(end) ? (start + end) / 2 : NaN;
    if (Number.isFinite(mid) && deletes.some((seg) => mid >= seg.start && mid <= seg.end)) {
      return false;
    }
    return String(w.text || '').trim();
  });
}

function formatExistingRangesForPrompt(existingRanges) {
  const ranges = Array.isArray(existingRanges) ? existingRanges : [];
  const list = ranges
    .map((range) => ({
      type: String(range?.type || 'media').slice(0, 16),
      start: Number(range?.start),
      end: Number(range?.end),
      title: trimByChars(String(range?.title || '').replace(/\s+/g, ' '), 30),
    }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .slice(0, 30)
    .map((range) => `${range.type}|${range.start.toFixed(2)}-${range.end.toFixed(2)}|${range.title}`);
  return list.length ? list.join('\n') : 'none';
}

function buildImagePlanPrompt(units, analysis, style, count, existingRanges = []) {
  const list = units
    .slice(0, 260)
    .map((u) => `${u.id}|${u.start.toFixed(2)}-${u.end.toFixed(2)}|${u.text}`)
    .join('\n');
  const targetCount = Math.max(4, Math.min(12, Number(count) || 8));
  const visualStyle = String(style || '').trim() || '彩铅故事插画，温暖纸张纹理，统一人物设定';
  const blockedRangesText = formatExistingRangesForPrompt(existingRanges);
  return [
    '你是短视频口播内容的导演、分镜师和 AI 图片提示词专家。',
    '任务：把口播文本翻译成一组能插入视频的配图分镜。你不是摘抄字幕的人，而是把抽象观点导演成具体画面的人。',
    'If there are multiple independent stories/cases/time periods/visual worlds, every media item must include storyId and storyTitle matching the visual reference asset story group.',
    '必须按这个思考流程执行，但最终只输出 JSON：',
    'A. 先读完整文本，判断主题、情绪、文化地域、是否有人物故事。',
    'B. 选择真正适合配图的节点：开头钩子、观点冲突、人物行动、案例画面、情绪转折、结尾记忆点；不要机械平均取句。',
    'C. 给每个节点做导演转译：把原文含义转成可拍/可画的场景，不要直接把原句写进提示词。',
    'D. 最后自检：每个 prompt 必须包含人物/主体、地点、动作、道具或环境、情绪、镜头构图、光线/色彩、统一画风。',
    '硬性要求：',
    `1. 生成 ${targetCount} 个配图点，配图点要服务视频理解和节奏，不要只因为某句话出现就配图。`,
    '2. 每个配图点必须对应文本中的时间范围，不能脱离原文编造事实；展示时长必须控制在 5-10 秒之间，优先 6-8 秒。',
    '3. 先判断故事发生的文化语境：中国人物/中国社会/中文生活场景用中国人物与中国空间；海外案例/欧美历史匹配对应地域的人物、建筑、服饰和光线。',
    '4. 如果文本有具体人物，建立统一主角设定；如果没有，建立统一的叙事代表，例如同一位创作者、职场人、学习者或观察者。',
    '5. 画风必须严格统一，用户选择的画风优先级最高；每张图只能换镜头、动作、空间细节，不能混风格。',
    '6. 严禁把 textBasis 或原文句子直接塞进 prompt；prompt 必须是画面故事描述。',
    '7. sceneStory 必须回答：谁/什么主体，在什么地点，正在做什么，画面里有哪些道具或背景，情绪是什么。',
    '8. camera 必须回答：远景/中景/近景/特写、俯拍/平视/侧逆光、主体位置、留白。',
    '9. prompt 用中文为主，可夹带必要英文风格词；不要出现字幕、文字排版、水印、logo。',
    '10. negativePrompt 用于排除：低清、变形、文字乱码、多余手指、水印、logo、畸形脸、人物服饰不一致、角色身份漂移、风格不统一。',
    `视觉风格：${visualStyle}`,
    `主题参考：${String(analysis?.topic || '').trim() || '未知'}`,
    `梗概参考：${String(analysis?.outline || '').trim() || '未知'}`,
    'Existing image/video media ranges. Avoid all listed ranges and never overlap with them. If value is none, ignore:',
    'delete|... 是最终视频不会出现的时间段，不能把这些内容作为配图依据，也不能把配图放进这些时间范围。',
    blockedRangesText,
    '输出 JSON（只返回 JSON，不要 markdown）：',
    '{"topic":"...","style":"用户选择画风，必须贯穿所有图","visualBible":{"culturalContext":"中国/欧美/日本/其他/抽象","mainCharacter":"统一主角设定，年龄、发型、脸型、气质","outfit":"统一服饰和道具","sceneWorld":"统一时代、地点、空间基调","colorAndStyle":"统一色彩、笔触、构图风格，必须包含用户选择画风"},"items":[{"id":"img_01","timeRange":"00:10-00:17","start":10.0,"end":17.0,"durationSec":7,"title":"这一张图解决什么表达问题","purpose":"封面/观点说明/B-roll/转场/结尾","textBasis":"对应原文依据，不超过40字","directorIntent":"导演意图：为什么这里需要配图","sceneStory":"具体画面故事：人物、地点、动作、情绪、道具、前景背景","camera":"景别/角度/构图","visual":"画面描述，不超过120字","prompt":"完整图片生成提示词：画面场景 + 统一风格 + 镜头，不得复述原文","negativePrompt":"负面提示词","keywords":["..."]}]}',
    '文本单元（id|start-end|text）：',
    list,
  ].join('\n');
}

function formatSecondsRange(start, end) {
  const fmt = (sec) => {
    const n = Math.max(0, Number(sec) || 0);
    const m = Math.floor(n / 60);
    const s = Math.floor(n % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  return `${fmt(start)}-${fmt(end)}`;
}

function buildVisualBibleText(parsed, analysis, fallbackStyle) {
  const bible = parsed?.visualBible || parsed?.styleBible || parsed?.visual_bible || {};
  const parts = [];
  const push = (label, value) => {
    const text = trimByChars(String(value || '').replace(/\s+/g, ' ').trim(), 120);
    if (text) parts.push(`${label}：${text}`);
  };
  push('文化语境', bible.culturalContext || bible.culture || parsed?.culturalContext);
  push('统一主角', bible.mainCharacter || bible.character || bible.protagonist);
  push('统一服饰道具', bible.outfit || bible.clothing || bible.props);
  push('统一场景世界', bible.sceneWorld || bible.setting || bible.environment);
  push('统一色彩画风', bible.colorAndStyle || bible.style || fallbackStyle);
  if (!parts.length) {
    push('主题', analysis?.topic || '口播内容');
    push('统一色彩画风', fallbackStyle || '自媒体视频配图，统一人物和画风');
  }
  return trimByChars(parts.join('；'), 520);
}

function normalizeVisualReferenceAssetType(value, fallback = 'scene') {
  const raw = String(value || '').toLowerCase();
  if (/character|person|role|人物|角色|主角/.test(raw)) return 'character';
  if (/scene|setting|environment|space|场景|环境|空间/.test(raw)) return 'scene';
  return fallback;
}

function normalizeVisualReferenceAsset(asset, index = 0, style = '', analysis = {}) {
  const type = normalizeVisualReferenceAssetType(asset?.type || asset?.kind || asset?.assetType, index === 0 ? 'character' : 'scene');
  const titleFallback = type === 'character' ? `Character asset ${index + 1}` : `Scene asset ${index + 1}`;
  const title = trimByChars(String(asset?.title || asset?.name || titleFallback).replace(/\s+/g, ' '), 48);
  const storyId = String(asset?.storyId || asset?.story_id || asset?.storyGroup || asset?.group || 'story_01').replace(/[^\w-]/g, '_').slice(0, 48) || 'story_01';
  const storyTitle = trimByChars(String(asset?.storyTitle || asset?.story_title || asset?.groupTitle || asset?.storyName || 'Story 1').replace(/\s+/g, ' '), 60);
  const topic = trimByChars(String(analysis?.topic || 'short-form story').replace(/\s+/g, ' '), 80);
  const outline = trimByChars(String(analysis?.outline || '').replace(/\s+/g, ' '), 160);
  const styleText = trimByChars(String(style || asset?.style || 'consistent editorial illustration').replace(/\s+/g, ' '), 120);
  const rawPrompt = trimByChars(String(asset?.prompt || asset?.visualPrompt || asset?.description || '').replace(/\s+/g, ' '), 900);
  const promptPrefix = type === 'character'
    ? 'Create a clean white-background character reference sheet, front view, side view, three-quarter view, consistent face, hair, age, outfit, accessories, full body and bust details.'
    : 'Create an environment-only scene reference image with no people, no characters, no readable text, showing the location, lighting, props, color palette, era, weather, and spatial layout.';
  const prompt = trimByChars([
    promptPrefix,
    rawPrompt || `Topic: ${topic}. Outline: ${outline || topic}.`,
    `Style: ${styleText}.`,
    'This is a visual reference asset for later image and video shots; keep it clear, reusable, consistent, no subtitles, no watermark, no logo.',
  ].filter(Boolean).join(' '), 1200);
  const negativePrompt = trimByChars(String(
    asset?.negativePrompt
    || asset?.negative_prompt
    || (type === 'scene'
      ? 'people, character, portrait, text, watermark, logo, low quality, distorted geometry'
      : 'text, watermark, logo, extra fingers, distorted face, inconsistent outfit, low quality')
  ).replace(/\s+/g, ' '), 320);
  return {
    id: String(asset?.id || `${type}_${String(index + 1).padStart(2, '0')}`).replace(/[^\w-]/g, '_').slice(0, 48),
    type,
    storyId,
    storyTitle,
    title,
    prompt,
    negativePrompt,
    image: asset?.image && typeof asset.image === 'object' ? asset.image : null,
    source: String(asset?.source || 'llm-plan').slice(0, 32),
  };
}

function buildFallbackVisualReferencePlan(analysis = {}, style = '') {
  const topic = trimByChars(String(analysis?.topic || 'short-form story').replace(/\s+/g, ' '), 80);
  const outline = trimByChars(String(analysis?.outline || '').replace(/\s+/g, ' '), 160);
  const assets = [
    normalizeVisualReferenceAsset({
      type: 'character',
      storyId: 'story_01',
      storyTitle: 'Story 1',
      title: 'Main character reference',
      prompt: `A reusable main character for the story about ${topic}. ${outline} Keep clothing and identity consistent.`,
      source: 'fallback',
    }, 0, style, analysis),
    normalizeVisualReferenceAsset({
      type: 'scene',
      storyId: 'story_01',
      storyTitle: 'Story 1',
      title: 'Main scene reference',
      prompt: `A reusable story environment for ${topic}. Show only the setting, props, light, color palette, and atmosphere.`,
      source: 'fallback',
    }, 1, style, analysis),
  ];
  return {
    enabled: true,
    status: 'planned',
    title: 'Visual reference assets',
    prompt: assets.map((asset) => asset.prompt).join('\n\n'),
    negativePrompt: 'text, watermark, logo, low quality, distorted anatomy, inconsistent style',
    source: 'fallback',
    assets,
  };
}

function sanitizeVisualReferencePlan(parsed, analysis = {}, style = '') {
  const direct = parsed?.visualReference || parsed?.visual_reference || parsed || {};
  let rawAssets = Array.isArray(direct.assets) ? direct.assets : [];
  if (Array.isArray(direct.stories)) {
    direct.stories.forEach((story, storyIndex) => {
      const storyId = String(story?.storyId || story?.id || story?.story_id || `story_${String(storyIndex + 1).padStart(2, '0')}`).replace(/[^\w-]/g, '_').slice(0, 48) || `story_${String(storyIndex + 1).padStart(2, '0')}`;
      const storyTitle = trimByChars(String(story?.storyTitle || story?.title || story?.name || `Story ${storyIndex + 1}`).replace(/\s+/g, ' '), 60);
      const storyAssets = Array.isArray(story?.assets) ? story.assets : [];
      rawAssets = rawAssets.concat(storyAssets.map((asset) => ({ ...asset, storyId, storyTitle })));
    });
  }
  if (!rawAssets.length && Array.isArray(direct.characters)) {
    rawAssets = rawAssets.concat(direct.characters.map((item) => ({ ...item, type: 'character' })));
  }
  if (!rawAssets.length && Array.isArray(direct.scenes)) {
    rawAssets = rawAssets.concat(direct.scenes.map((item) => ({ ...item, type: 'scene' })));
  } else if (Array.isArray(direct.scenes)) {
    rawAssets = rawAssets.concat(direct.scenes.map((item) => ({ ...item, type: 'scene' })));
  }
  if (!rawAssets.length && (direct.character || direct.scene || direct.prompt)) {
    if (direct.character || direct.prompt) {
      rawAssets.push({
        type: 'character',
        title: direct.characterTitle || 'Main character reference',
        prompt: [direct.character, direct.outfit, direct.prompt].filter(Boolean).join(' '),
        negativePrompt: direct.negativePrompt || direct.negative_prompt,
      });
    }
    if (direct.scene) {
      rawAssets.push({
        type: 'scene',
        title: direct.sceneTitle || 'Main scene reference',
        prompt: direct.scene,
        negativePrompt: direct.negativePrompt || direct.negative_prompt,
      });
    }
  }
  const assets = rawAssets
    .map((asset, index) => normalizeVisualReferenceAsset(asset, index, style, analysis))
    .filter((asset) => asset.prompt)
    .slice(0, 8);
  if (!assets.length) return buildFallbackVisualReferencePlan(analysis, style);
  return {
    enabled: direct.enabled !== false,
    status: 'planned',
    title: trimByChars(String(direct.title || 'Visual reference assets').replace(/\s+/g, ' '), 60),
    prompt: trimByChars(String(direct.prompt || assets.map((asset) => asset.prompt).join('\n\n')).replace(/\s+/g, ' '), 1600),
    negativePrompt: trimByChars(String(direct.negativePrompt || direct.negative_prompt || 'text, watermark, logo, low quality, inconsistent style').replace(/\s+/g, ' '), 500),
    source: 'llm-plan',
    assets,
  };
}

function buildVisualReferencePrompt(units, analysis = {}, style = '') {
  const list = (Array.isArray(units) ? units : [])
    .slice(0, 180)
    .map((u) => `${u.id}|${Number(u.start || 0).toFixed(2)}-${Number(u.end || 0).toFixed(2)}|${String(u.text || '').slice(0, 120)}`)
    .join('\n');
  return [
    'You are a short-video art director. Plan reusable visual reference assets before generating B-roll images or videos.',
    'Read the transcript and infer the story culture, protagonist, recurring locations, time period, clothing, props, and emotional tone.',
    'Return 2 to 8 assets. Use character assets only when a recurring person or narrator embodiment is useful. Use scene assets for recurring environments.',
    'If transcript contains multiple unrelated stories, cases, time periods or visual worlds, split them into story groups first. Every asset must include storyId and storyTitle.',
    'Character asset rule: prompt must be a white-background multi-view character sheet: front, side, three-quarter, consistent face, hair, outfit and accessories.',
    'Scene asset rule: prompt must show the environment only, no people, no characters, no readable text. Describe location, light, props, era, layout and color palette.',
    'Do not copy transcript sentences as prompts. Make reusable visual design prompts that future shots can reference.',
    `Chosen style: ${String(style || 'consistent editorial illustration')}`,
    `Topic: ${String(analysis?.topic || '') || 'unknown'}`,
    `Outline: ${String(analysis?.outline || '') || 'unknown'}`,
    'Return JSON only:',
    '{"visualReference":{"title":"...","negativePrompt":"...","stories":[{"storyId":"story_01","storyTitle":"Story 1","assets":[{"id":"character_01","type":"character","storyId":"story_01","storyTitle":"Story 1","title":"...","prompt":"..."},{"id":"scene_01","type":"scene","storyId":"story_01","storyTitle":"Story 1","title":"...","prompt":"..."}]}]}}',
    'Transcript units:',
    list,
  ].join('\n');
}

async function runLlmVisualReferencePlan(words, config, payload = {}) {
  const selected = Array.isArray(payload.selectedIndices) ? payload.selectedIndices : [];
  const deleteSegments = Array.isArray(payload.deleteSegments) ? payload.deleteSegments : [];
  const keptWords = pickWordsForVisualPlan(words, selected, deleteSegments);
  const units = buildTranscriptUnits(keptWords);
  const style = String(payload.style || payload.visualStyle || payload.imageStyle || '').trim();
  const analysis = payload.analysis && typeof payload.analysis === 'object'
    ? payload.analysis
    : analyzeTextForSuggestions(keptWords).analysis;
  if (!config.ready || !units.length) {
    return {
      topic: analysis.topic || '',
      outline: analysis.outline || '',
      visualReference: buildFallbackVisualReferencePlan(analysis, style),
    };
  }
  const prompt = buildVisualReferencePrompt(units, analysis, style);
  try {
    const raw = await callLlmProvider(config, prompt);
    const parsed = extractJsonObject(raw) || {};
    const visualReference = sanitizeVisualReferencePlan(parsed, analysis, style);
    return {
      topic: parsed.topic || analysis.topic || '',
      outline: parsed.outline || analysis.outline || '',
      visualReference,
      raw,
    };
  } catch (err) {
    appendCutLog(`Visual reference planning fallback: ${err.message || err}`);
    return {
      topic: analysis.topic || '',
      outline: analysis.outline || '',
      visualReference: buildFallbackVisualReferencePlan(analysis, style),
      error: err.message || String(err),
    };
  }
}

const DIRECTOR_VISUAL_TERMS = [
  '人物', '主角', '地点', '场景', '房间', '办公室', '街道', '城市', '家庭', '桌面', '窗边',
  '前景', '背景', '道具', '动作', '表情', '情绪', '镜头', '构图', '光线', '阴影', '色彩',
  '远景', '中景', '近景', '特写', '平视', '俯拍', '侧光', '逆光', '画面', '空间',
];

function compactForVisualCompare(text) {
  return String(text || '')
    .replace(/[\s\u3000，。！？、；：“”"'‘’（）()【】\[\]{}<>《》.,!?;:\-_/\\|]+/g, '')
    .trim();
}

function hasDirectTranscriptCopy(candidate, basis) {
  const text = compactForVisualCompare(candidate);
  const source = compactForVisualCompare(basis);
  if (source.length < 8 || text.length < 8) return false;
  if (text === source || text.includes(source)) return true;
  const chunkLen = Math.min(12, Math.max(8, Math.floor(source.length / 3)));
  let hits = 0;
  for (let i = 0; i + chunkLen <= source.length; i += Math.max(4, Math.floor(chunkLen / 2))) {
    if (text.includes(source.slice(i, i + chunkLen))) hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

function hasDirectorVisualLanguage(text) {
  const value = String(text || '');
  if (compactForVisualCompare(value).length < 28) return false;
  let hits = 0;
  for (const term of DIRECTOR_VISUAL_TERMS) {
    if (value.includes(term)) hits += 1;
    if (hits >= 3) return true;
  }
  return false;
}

function buildDirectorFallbackScene(textBasis, title, purpose, index) {
  const cue = trimByChars(String(title || purpose || '口播观点'), 28);
  const normalizedPurpose = String(purpose || '');
  const opening = index === 0 || /封面|开头|钩子/.test(normalizedPurpose);
  const ending = /结尾|总结/.test(normalizedPurpose);
  const conflict = /冲突|转折|问题|观点|案例/.test(normalizedPurpose);
  const scene = opening
    ? '一位统一设定的叙事主角站在整洁但有生活痕迹的室内空间，桌面摆着与主题相关的物件'
    : ending
      ? '同一位主角走到窗边或开阔空间，回望前面出现过的关键道具，形成收束感'
      : conflict
        ? '同一位主角面对两个形成对比的环境或道具，一侧代表旧状态，一侧代表新选择'
        : '同一位主角在统一场景中用动作和道具表达这个观点';
  return {
    sceneStory: `${scene}，用具体动作和环境隐喻表达这一段的核心含义：${cue}，画面不出现任何文字，情绪清晰，人物服饰与前后分镜一致`,
    camera: opening
      ? '中近景，平视镜头，主体略偏左，背景留出空间展示环境和道具'
      : ending
        ? '中景到大全景，柔和侧逆光，主体在画面三分线位置，留出呼吸感'
        : '中景，平视或轻微俯拍，主体动作清楚，前景道具引导视线，背景简洁',
  };
}

function sanitizeImagePlanItems(parsed, units, count, analysis, fallbackStyle) {
  const targetCount = Math.max(4, Math.min(12, Number(count) || 8));
  const visualBible = buildVisualBibleText(parsed, analysis, fallbackStyle);
  const styleAnchor = trimByChars(String(fallbackStyle || parsed?.style || '').replace(/\s+/g, ' '), 180);
  const rawItems = Array.isArray(parsed?.items)
    ? parsed.items
    : Array.isArray(parsed?.imagePoints)
      ? parsed.imagePoints
      : Array.isArray(parsed?.points)
        ? parsed.points
        : [];
  const out = [];
  for (let i = 0; i < rawItems.length; i += 1) {
    const item = rawItems[i] || {};
    const fallbackUnit = units[Math.min(units.length - 1, Math.floor((i / Math.max(1, targetCount - 1)) * Math.max(0, units.length - 1)))] || {};
    const start = Math.max(0, Number.isFinite(Number(item.start)) ? Number(item.start) : Number(fallbackUnit.start || 0));
    const rawEnd = Number.isFinite(Number(item.end)) ? Number(item.end) : Number(fallbackUnit.end || start + 7);
    const durationSec = clampDurationSec(item.durationSec || item.duration || (rawEnd - start), 5, 10, 7);
    const end = start + durationSec;
    const id = String(item.id || `img_${String(out.length + 1).padStart(2, '0')}`).replace(/[^\w-]/g, '_').slice(0, 32);
    const storyId = String(item.storyId || item.story_id || item.storyGroup || item.group || 'story_01').replace(/[^\w-]/g, '_').slice(0, 32) || 'story_01';
    const storyTitle = trimByChars(String(item.storyTitle || item.story_title || item.groupTitle || item.storyName || 'Story 1').replace(/\s+/g, ' '), 60);
    const title = trimByChars(String(item.title || item.name || `配图 ${out.length + 1}`).replace(/\s+/g, ' '), 40);
    const textBasis = trimByChars(String(item.textBasis || item.basis || fallbackUnit.text || '').replace(/\s+/g, ' '), 80);
    let sceneStory = trimByChars(String(item.sceneStory || item.scene_story || item.story || '').replace(/\s+/g, ' '), 180);
    let camera = trimByChars(String(item.camera || item.shot || item.composition || '').replace(/\s+/g, ' '), 80);
    let visual = trimByChars(String(item.visual || item.description || sceneStory || '').replace(/\s+/g, ' '), 160);
    const rawPrompt = trimByChars(String(item.prompt || '').replace(/\s+/g, ' '), 900);
    const fallbackScene = buildDirectorFallbackScene(textBasis, title, item.purpose, out.length);
    if (!sceneStory || hasDirectTranscriptCopy(sceneStory, textBasis) || !hasDirectorVisualLanguage(sceneStory)) {
      sceneStory = fallbackScene.sceneStory;
    }
    if (!camera || hasDirectTranscriptCopy(camera, textBasis)) {
      camera = fallbackScene.camera;
    }
    if (!visual || hasDirectTranscriptCopy(visual, textBasis) || !hasDirectorVisualLanguage(visual)) {
      visual = trimByChars(sceneStory, 160);
    }
    const basePrompt = trimByChars([
      sceneStory ? `画面故事：${sceneStory}` : '',
      visual ? `画面描述：${visual}` : '',
      camera ? `镜头构图：${camera}` : '',
      rawPrompt && rawPrompt !== textBasis && !hasDirectTranscriptCopy(rawPrompt, textBasis) && hasDirectorVisualLanguage(rawPrompt)
        ? `生成提示：${rawPrompt}`
        : '',
    ].filter(Boolean).join('；') || `把该配图点转写为一个具体故事画面：同一主角在统一场景中用动作和道具表达内容，不出现文字。`, 1000);
    const prompt = trimByChars([
      visualBible ? `全片统一视觉设定：${visualBible}` : '',
      styleAnchor ? `用户选择画风：${styleAnchor}，所有图片必须严格保持这一种画风，不要混入其他风格` : '',
      `当前配图点：${basePrompt}`,
      '这是视频分镜插图，不是文字海报；必须画出人物、地点、动作、情绪、前景背景和镜头构图。',
      '保持同一主角身份、脸型发型、服饰道具、时代地域、色彩系统和绘画笔触；只改变当前镜头的动作、构图和场景细节；画面无文字、无字幕、无水印、无 logo。',
    ].filter(Boolean).join('。'), 1300);
    if (!prompt) continue;
    out.push({
      id,
      storyId,
      storyTitle,
      timeRange: formatSecondsRange(start, end),
      start,
      end,
      durationSec,
      title,
      directorIntent: trimByChars(String(item.directorIntent || item.intent || item.reason || '').replace(/\s+/g, ' '), 80),
      purpose: trimByChars(String(item.purpose || '视频配图').replace(/\s+/g, ' '), 30),
      textBasis,
      sceneStory,
      camera,
      visual,
      prompt,
      negativePrompt: trimByChars(String(item.negativePrompt || item.negative_prompt || '低清，模糊，文字，水印，logo，畸形，变形，多余手指，人物服饰不一致，角色年龄变化，地域文化错位').replace(/\s+/g, ' '), 320),
      keywords: sanitizeKeywords(Array.isArray(item.keywords) ? item.keywords : []),
    });
    if (out.length >= targetCount) break;
  }
  return out;
}

function autoImageCountForUnits(units) {
  if (!Array.isArray(units) || !units.length) return 6;
  const start = Math.min(...units.map((u) => Number(u.start)).filter(Number.isFinite));
  const end = Math.max(...units.map((u) => Number(u.end)).filter(Number.isFinite));
  const duration = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : units.length * 3;
  if (duration <= 90) return 4;
  if (duration <= 180) return 6;
  if (duration <= 360) return 8;
  if (duration <= 720) return 10;
  return 12;
}

function autoVideoCountForUnits(units) {
  if (!Array.isArray(units) || !units.length) return 2;
  const starts = units.map((u) => Number(u.start)).filter(Number.isFinite);
  const ends = units.map((u) => Number(u.end)).filter(Number.isFinite);
  const start = starts.length ? Math.min(...starts) : 0;
  const end = ends.length ? Math.max(...ends) : units.length * 3;
  const duration = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : units.length * 3;
  if (duration <= 90) return 1;
  if (duration <= 180) return 2;
  if (duration <= 360) return 3;
  if (duration <= 720) return 4;
  return 5;
}

function buildFallbackImagePlan(units, analysis, count, style = '') {
  const targetCount = Math.max(4, Math.min(12, Number(count) || 8));
  const items = [];
  if (!units.length) return items;
  const topic = String(analysis?.topic || '口播内容').trim() || '口播内容';
  const styleAnchor = String(style || '彩铅故事插画，纸张纹理，温暖克制色彩').trim();
  const visualBible = `文化语境按原文判断，统一使用同一位自媒体叙事主角；人物发型、脸型、服饰、道具保持一致；画风统一为${styleAnchor}`;
  for (let i = 0; i < targetCount; i += 1) {
    const unit = units[Math.min(units.length - 1, Math.floor((i / Math.max(1, targetCount - 1)) * Math.max(0, units.length - 1)))];
    const title = `配图 ${i + 1}：${trimByChars(unit.text, 18)}`;
    const sceneStory = `同一位叙事主角在统一场景中，通过动作、表情和环境道具表现“${trimByChars(unit.text, 42)}”这一内容，不出现任何文字`;
    const camera = i === 0
      ? '中近景，主体居中，开场建立人物和环境'
      : (i === targetCount - 1 ? '中景偏大全景，留出结尾总结的空间感' : '中景或特写，突出动作和情绪转折');
    const prompt = [
      `全片统一视觉设定：${visualBible}`,
      `用户选择画风：${styleAnchor}，所有图片必须严格保持这一种画风`,
      `围绕“${topic}”的中文自媒体口播视频配图`,
      `画面故事：${sceneStory}`,
      `镜头构图：${camera}`,
      '主体明确，适合作为视频 B-roll，不要把原文当作文字写进画面，无文字，无字幕，无水印，无 logo，人物和服饰保持上下文一致',
    ].join('，');
    items.push({
      id: `img_${String(i + 1).padStart(2, '0')}`,
      timeRange: formatSecondsRange(unit.start, unit.start + 7),
      start: unit.start,
      end: unit.start + 7,
      durationSec: 7,
      title,
      purpose: i === 0 ? '开头铺垫' : (i === targetCount - 1 ? '结尾总结' : '观点说明'),
      textBasis: trimByChars(unit.text, 80),
      sceneStory,
      camera,
      visual: trimByChars(sceneStory, 120),
      prompt,
      negativePrompt: '低清，模糊，文字，水印，logo，畸形，变形，多余手指，人物服饰不一致，角色年龄变化，地域文化错位',
      keywords: sanitizeKeywords([topic]),
    });
  }
  return items;
}

function buildVideoPlanPrompt(units, analysis, style, count, aspectRatio, existingRanges = []) {
  const list = units
    .slice(0, 220)
    .map((u) => `${u.id}|${u.start.toFixed(2)}-${u.end.toFixed(2)}|${u.text}`)
    .join('\n');
  const targetCount = Math.max(1, Math.min(5, Number(count) || 3));
  const visualStyle = String(style || '').trim() || 'cinematic realistic B-roll, consistent character and scene';
  const blockedRangesText = formatExistingRangesForPrompt(existingRanges);
  return [
    '你是短视频口播内容的导演、分镜师和 AI 视频提示词专家。',
    '任务：阅读主视频转录文本，规划可插入主视频的短视频素材点。素材用于覆盖式 B-roll，不改变主视频音频。',
    '请先理解主题、人物、文化语境、情绪和叙事结构，再选择真正需要画面辅助的节点。',
    '选择原则：优先开头钩子、观点冲突、案例画面、人物行动、情绪转折、结尾记忆点；不要机械平均切分。',
    '每个视频素材点必须有明确 start/end，代表它覆盖主视频画面的字幕时间范围。范围必须控制在 3-8 秒，优先 4-6 秒，由你根据语义节奏判断。',
    'videoPrompt 必须是可拍摄/可生成的视频画面描述：人物或主体、地点、动作、镜头运动、光线、风格、情绪、环境细节；禁止直接复制原文句子。',
    '如文本是中国语境，用中国人物、服饰、空间和生活场景；如是海外故事，要匹配对应国家/时代/建筑/服饰。',
    'If there are multiple independent stories/cases/time periods/visual worlds, every media item must include storyId and storyTitle matching the visual reference asset story group.',
    '输出只允许 JSON，不要 markdown。',
    `生成 ${targetCount} 个视频素材点。`,
    `用户选择风格：${visualStyle}`,
    `目标比例：${aspectRatio || '16:9'}`,
    'Existing image/video media ranges. Avoid all listed ranges and never overlap with them. If value is none, ignore:',
    'delete|... is removed from the final video. Do not plan video materials from deleted content or place materials inside deleted ranges.',
    blockedRangesText,
    `主题参考：${String(analysis?.topic || '').trim() || '未知'}`,
    `梗概参考：${String(analysis?.outline || '').trim() || '未知'}`,
    'JSON 格式：',
    '{"topic":"...","items":[{"id":"vid_01","start":10.0,"end":15.0,"durationSec":5,"timeRange":"00:10-00:15","title":"...","purpose":"开头钩子/B-roll/案例画面/转场/结尾","textBasis":"对应原文依据，不超过40字","directorIntent":"为什么这里需要视频素材","sceneStory":"具体画面故事","camera":"镜头运动和构图","videoPrompt":"完整视频生成提示词","negativePrompt":"负面提示词"}]}',
    '文本单元（id|start-end|text）：',
    list,
  ].join('\n');
}

function sanitizeVideoPlanItems(parsed, units, count, analysis, fallbackStyle, aspectRatio) {
  const targetCount = Math.max(1, Math.min(5, Number(count) || 3));
  const rawItems = Array.isArray(parsed?.items)
    ? parsed.items
    : Array.isArray(parsed?.videoPoints)
      ? parsed.videoPoints
      : Array.isArray(parsed?.points)
        ? parsed.points
        : [];
  const out = [];
  const styleAnchor = trimByChars(String(fallbackStyle || parsed?.style || 'cinematic realistic B-roll').replace(/\s+/g, ' '), 180);
  const visualBible = buildVisualBibleText(parsed, analysis, fallbackStyle);
  for (let i = 0; i < rawItems.length; i += 1) {
    const item = rawItems[i] || {};
    const fallbackUnit = units[Math.min(units.length - 1, Math.floor((i / Math.max(1, targetCount - 1)) * Math.max(0, units.length - 1)))] || {};
    const rawStart = Number.isFinite(Number(item.start)) ? Number(item.start) : Number(fallbackUnit.start || 0);
    const start = Math.max(0, rawStart);
    const rawEnd = Number.isFinite(Number(item.end)) ? Number(item.end) : Number(fallbackUnit.end || start + 5);
    const durationSec = clampDurationSec(item.durationSec || item.duration || (rawEnd - start), 3, 8, 5);
    const end = start + durationSec;
    const generation = videoDurationToGenerationParams(durationSec);
    const id = String(item.id || `vid_${String(out.length + 1).padStart(2, '0')}`).replace(/[^\w-]/g, '_').slice(0, 32);
    const storyId = String(item.storyId || item.story_id || item.storyGroup || item.group || 'story_01').replace(/[^\w-]/g, '_').slice(0, 32) || 'story_01';
    const storyTitle = trimByChars(String(item.storyTitle || item.story_title || item.groupTitle || item.storyName || 'Story 1').replace(/\s+/g, ' '), 60);
    const title = trimByChars(String(item.title || item.name || `视频素材 ${out.length + 1}`).replace(/\s+/g, ' '), 40);
    const purpose = trimByChars(String(item.purpose || 'B-roll').replace(/\s+/g, ' '), 32);
    const textBasis = trimByChars(String(item.textBasis || item.basis || fallbackUnit.text || '').replace(/\s+/g, ' '), 80);
    let sceneStory = trimByChars(String(item.sceneStory || item.scene_story || item.story || '').replace(/\s+/g, ' '), 220);
    let camera = trimByChars(String(item.camera || item.shot || item.composition || '').replace(/\s+/g, ' '), 120);
    const fallbackScene = buildDirectorFallbackScene(textBasis, title, purpose, out.length);
    if (!sceneStory || hasDirectTranscriptCopy(sceneStory, textBasis) || !hasDirectorVisualLanguage(sceneStory)) {
      sceneStory = fallbackScene.sceneStory;
    }
    if (!camera || hasDirectTranscriptCopy(camera, textBasis)) {
      camera = fallbackScene.camera;
    }
    const rawPrompt = trimByChars(String(item.videoPrompt || item.prompt || '').replace(/\s+/g, ' '), 1000);
    const videoPrompt = trimByChars([
      visualBible ? `Consistent visual bible: ${visualBible}` : '',
      styleAnchor ? `Style: ${styleAnchor}` : '',
      `Scene story: ${sceneStory}`,
      `Camera: ${camera}; slow natural motion, stable cinematic B-roll, no subtitles, no text, no watermark, no logo.`,
      rawPrompt && !hasDirectTranscriptCopy(rawPrompt, textBasis) ? `Additional direction: ${rawPrompt}` : '',
    ].filter(Boolean).join(' '), 1400);
    if (!videoPrompt) continue;
    out.push({
      id,
      storyId,
      storyTitle,
      type: 'video',
      timeRange: formatSecondsRange(start, end),
      start,
      end,
      aspectRatio: aspectRatio || '16:9',
      durationSec,
      numFrames: generation.numFrames,
      frameRate: generation.frameRate,
      generationDurationSec: Number(generation.generationDurationSec.toFixed(2)),
      title,
      purpose,
      textBasis,
      directorIntent: trimByChars(String(item.directorIntent || item.intent || item.reason || '').replace(/\s+/g, ' '), 100),
      sceneStory,
      camera,
      videoPrompt,
      prompt: videoPrompt,
      negativePrompt: trimByChars(String(item.negativePrompt || item.negative_prompt || 'low quality, blurry, text, subtitles, watermark, logo, distorted face, inconsistent character, wrong culture').replace(/\s+/g, ' '), 320),
    });
    if (out.length >= targetCount) break;
  }
  return out;
}

function buildFallbackVideoPlan(units, analysis, count, style = '', aspectRatio = '16:9') {
  const targetCount = Math.max(1, Math.min(5, Number(count) || 3));
  const imageLike = buildFallbackImagePlan(units, analysis, Math.max(4, targetCount), style).slice(0, targetCount);
  return imageLike.map((item, index) => {
    const durationSec = clampDurationSec(Number(item.durationSec) || 5, 3, 8, 5);
    const end = Number(item.start) + durationSec;
    const generation = videoDurationToGenerationParams(durationSec);
    return {
      ...item,
      id: `vid_${String(index + 1).padStart(2, '0')}`,
      type: 'video',
      end,
      durationSec,
      numFrames: generation.numFrames,
      frameRate: generation.frameRate,
      generationDurationSec: Number(generation.generationDurationSec.toFixed(2)),
      timeRange: formatSecondsRange(item.start, end),
      aspectRatio,
      videoPrompt: trimByChars([
        `Style: ${style || 'cinematic realistic B-roll'}.`,
        `Scene story: ${item.sceneStory}.`,
        `Camera: ${item.camera}; slow natural camera movement, stable action, no subtitles, no text, no watermark, no logo.`,
      ].join(' '), 1400),
    };
  });
}

async function runLlmVideoPlan(words, config, payload = {}) {
  const sourceWords = pickWordsForVisualPlan(words, payload.selectedIndices, payload.deleteSegments);
  const units = buildTranscriptUnits(sourceWords);
  if (!units.length) {
    throw new Error('No transcript text available for video material planning');
  }
  const analysis = await resolveAnalysis(units, config, payload.analysis);
  const count = String(payload.count || '').toLowerCase() === 'auto'
    ? autoVideoCountForUnits(units)
    : Math.max(1, Math.min(5, Number(payload.count) || 3));
  const style = String(payload.style || '').trim();
  const aspectRatio = String(payload.aspectRatio || payload.aspect || '16:9').trim() || '16:9';
  let items = [];
  let raw = '';
  try {
    raw = await callLlmProvider(config, buildVideoPlanPrompt(units, analysis, style, count, aspectRatio, payload.existingRanges));
    const parsed = extractJsonObject(raw) || {};
    items = sanitizeVideoPlanItems(parsed, units, count, analysis, style, aspectRatio);
    if (parsed.topic && !analysis.topic) analysis.topic = trimByChars(String(parsed.topic), 80);
  } catch (err) {
    appendCutLog(`Video plan LLM fallback: ${err.message || String(err)}`);
  }
  if (!items.length) {
    items = buildFallbackVideoPlan(units, analysis, count, style, aspectRatio);
  }
  return {
    topic: analysis.topic,
    outline: analysis.outline,
    style: style || 'cinematic realistic B-roll',
    aspectRatio,
    items,
    raw: raw.slice(0, 1000),
  };
}

async function runLlmImagePlan(words, config, payload = {}) {
  const sourceWords = pickWordsForVisualPlan(words, payload.selectedIndices, payload.deleteSegments);
  const units = buildTranscriptUnits(sourceWords);
  if (!units.length) {
    throw new Error('可用于配图分析的文本为空');
  }
  const analysis = await resolveAnalysis(units, config, payload.analysis);
  const count = String(payload.count || '').toLowerCase() === 'auto'
    ? autoImageCountForUnits(units)
    : Math.max(4, Math.min(12, Number(payload.count) || 8));
  const style = String(payload.style || '').trim();
  let items = [];
  let raw = '';
  try {
    raw = await callLlmProvider(config, buildImagePlanPrompt(units, analysis, style, count, payload.existingRanges));
    const parsed = extractJsonObject(raw) || {};
    items = sanitizeImagePlanItems(parsed, units, count, analysis, style);
    if (parsed.topic && !analysis.topic) analysis.topic = trimByChars(String(parsed.topic), 80);
    if (parsed.outline && !analysis.outline) analysis.outline = trimByChars(String(parsed.outline), 120);
  } catch (err) {
    appendCutLog(`Image plan LLM fallback: ${err.message || String(err)}`);
  }
  if (!items.length) {
    items = buildFallbackImagePlan(units, analysis, count, style);
  }
  return {
    topic: analysis.topic,
    outline: analysis.outline,
    style: style || '彩铅故事插画，统一人物和场景',
    items,
    raw: raw.slice(0, 1000),
  };
}
function sanitizeAssetName(input) {
  const value = String(input || '')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return value || 'image';
}

async function saveImageBuffer(buffer, id, ext = '.png') {
  fs.mkdirSync(IMAGE_ASSET_DIR, { recursive: true });
  const safeId = sanitizeAssetName(id);
  const suffix = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext.toLowerCase()) ? ext.toLowerCase() : '.png';
  const fileName = `${Date.now()}_${safeId}${suffix}`;
  const filePath = path.join(IMAGE_ASSET_DIR, fileName);
  fs.writeFileSync(filePath, buffer);
  return {
    fileName,
    filePath,
    url: `/image_assets/${encodeURIComponent(fileName)}`,
  };
}

async function saveVideoBuffer(buffer, id, ext = '.mp4') {
  fs.mkdirSync(VIDEO_ASSET_DIR, { recursive: true });
  const safeId = sanitizeAssetName(id || 'video');
  const suffix = ['.mp4', '.mov', '.webm', '.m4v'].includes(String(ext || '').toLowerCase())
    ? String(ext || '').toLowerCase()
    : '.mp4';
  const fileName = `${Date.now()}_${safeId}${suffix}`;
  const filePath = path.join(VIDEO_ASSET_DIR, fileName);
  fs.writeFileSync(filePath, buffer);
  return {
    fileName,
    filePath,
    url: `/video_assets/${encodeURIComponent(fileName)}`,
  };
}

function imageExtFromContentType(contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';
  if (type.includes('webp')) return '.webp';
  if (type.includes('gif')) return '.gif';
  if (type.includes('svg')) return '.svg';
  return '.png';
}

function videoExtFromContentType(contentType, url = '') {
  const type = String(contentType || '').toLowerCase();
  const lowerUrl = String(url || '').toLowerCase();
  if (type.includes('webm') || /\.webm(\?|#|$)/.test(lowerUrl)) return '.webm';
  if (type.includes('quicktime') || /\.mov(\?|#|$)/.test(lowerUrl)) return '.mov';
  if (/\.m4v(\?|#|$)/.test(lowerUrl)) return '.m4v';
  return '.mp4';
}

function imageMimeFromExt(ext) {
  const value = String(ext || '').toLowerCase();
  if (value === '.jpg' || value === '.jpeg') return 'image/jpeg';
  if (value === '.webp') return 'image/webp';
  if (value === '.gif') return 'image/gif';
  if (value === '.svg') return 'image/svg+xml';
  return 'image/png';
}

function fileToDataUrl(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return '';
  const buffer = fs.readFileSync(resolved);
  return `data:${imageMimeFromExt(path.extname(resolved))};base64,${buffer.toString('base64')}`;
}

function resolveReferenceImageInput(input) {
  if (!input) return '';
  if (Array.isArray(input)) return resolveReferenceImageInput(input[0]);
  if (typeof input === 'object') {
    return resolveReferenceImageInput(input.dataUrl || input.base64 || input.filePath || input.path || input.url || input.imageUrl);
  }
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (/^data:image\//i.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/image_assets/')) {
    const name = decodeURIComponent(raw.split('/').pop() || '');
    return fileToDataUrl(path.join(IMAGE_ASSET_DIR, name));
  }
  if (raw.startsWith('/video_assets/')) return '';
  return fileToDataUrl(raw);
}

function resolveReferenceImageInputs(input, maxItems = 4) {
  const rawList = Array.isArray(input) ? input : [input];
  const seen = new Set();
  const out = [];
  for (const item of rawList) {
    const value = resolveReferenceImageInput(item);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= maxItems) break;
  }
  return out;
}

function resolvePublicReferenceImageInput(input) {
  const rawList = Array.isArray(input) ? input : [input];
  for (const item of rawList) {
    if (!item) continue;
    if (typeof item === 'object') {
      const value = resolvePublicReferenceImageInput(item.url || item.imageUrl || item.outputUrl || item.sourceUrl || item.href);
      if (value) return value;
      continue;
    }
    const raw = String(item || '').trim();
    if (/^https?:\/\//i.test(raw)) return raw;
  }
  return '';
}

async function rewriteImagePromptWithLlm(config, item, userNote = '') {
  if (!config.ready) return String(item?.prompt || '').trim();
  const prompt = [
    '你是 AI 图片提示词优化师。用户点击了重试，说明上一张不满意。',
    '请在不改变事实、主题、人物身份、服饰、地域文化和画风的前提下，换一个更清晰、更有画面感的图片生成提示词。',
    '必须继承原提示词里的“全片统一视觉设定”。只允许调整当前镜头的构图、动作、景别、光线和细节，不允许把中国故事改成外国场景，也不允许更换主角外貌和衣服。',
    '只返回 JSON：{"prompt":"...","negativePrompt":"..."}',
    `标题：${String(item?.title || '')}`,
    `原始提示词：${String(item?.prompt || '')}`,
    `用户补充：${String(userNote || '') || '无'}`,
  ].join('\n');
  const raw = await callLlmProvider(config, prompt);
  const parsed = extractJsonObject(raw) || {};
  return {
    prompt: trimByChars(String(parsed.prompt || item?.prompt || '').replace(/\s+/g, ' '), 1300),
    negativePrompt: trimByChars(String(parsed.negativePrompt || parsed.negative_prompt || item?.negativePrompt || '').replace(/\s+/g, ' '), 320),
  };
}

async function callImageGenerationApi(config, item) {
  if (!config.ready) {
    throw new Error(`图片生成配置不完整：缺少 ${config.missing.join(', ')}`);
  }
  const prompt = String(item?.prompt || '').trim();
  if (!prompt) throw new Error('图片提示词为空');

  if (config.provider === 'minimax') {
    const requestBody = {
      model: config.model || 'image-01',
      prompt,
      aspect_ratio: imageSizeToMiniMaxAspectRatio(config.size),
      response_format: 'base64',
      n: 1,
      prompt_optimizer: true,
    };
    const res = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`MiniMax 图片生成失败：HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    let json = {};
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`MiniMax 图片生成返回格式不是 JSON：${text.slice(0, 120)}`);
    }
    const base64List = Array.isArray(json?.data?.image_base64)
      ? json.data.image_base64
      : Array.isArray(json?.image_base64)
        ? json.image_base64
        : [];
    const firstBase64 = String(base64List[0] || json?.data?.b64_json || json?.b64_json || '').trim();
    if (!firstBase64) {
      const message = json?.base_resp?.status_msg || json?.message || '未返回 base64 图片';
      throw new Error(`MiniMax 图片生成失败：${message}`);
    }
    const data = firstBase64.replace(/^data:image\/\w+;base64,/, '');
    const saved = await saveImageBuffer(Buffer.from(data, 'base64'), item.id || 'image', '.jpg');
    return {
      ...saved,
      aspectRatio: imageSizeToMiniMaxAspectRatio(config.size),
      generatedSize: config.size,
      requestedSize: config.size,
    };
  }

  const generatedSize = config.provider === 'agnes'
    ? imageSizeToAgnesSize(config.size)
    : imageSizeToOpenAiSize(config.size);
  const requestBody = {
    model: config.model,
    prompt,
    size: generatedSize,
    n: 1,
  };
  if (config.provider === 'agnes') {
    requestBody.extra_body = {
      response_format: 'url',
    };
    const referenceImages = resolveReferenceImageInputs(item?.referenceImage || item?.visualReference || item?.reference, 4);
    if (referenceImages.length) {
      requestBody.extra_body.image = referenceImages.length === 1 ? referenceImages[0] : referenceImages;
    }
  }

  if (config.provider === 'agnes') {
    await waitAgnesRequestSlot('image');
  }

  const res = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`图片生成失败：HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`图片生成返回格式不是 JSON：${text.slice(0, 120)}`);
  }
  const first = Array.isArray(json?.data) ? json.data[0] : (json?.image || json?.result || json);
  const b64 = first?.b64_json || first?.base64 || first?.image_base64;
  if (b64) {
    const data = String(b64).replace(/^data:image\/\w+;base64,/, '');
    const saved = await saveImageBuffer(Buffer.from(data, 'base64'), item.id || 'image', '.png');
    return {
      ...saved,
      aspectRatio: imageSizeToMiniMaxAspectRatio(generatedSize),
      generatedSize,
      requestedSize: config.size,
    };
  }
  const imageUrl = first?.url || first?.image_url || first?.output_url;
  if (imageUrl) {
    const imageRes = await fetch(imageUrl);
    if (!imageRes.ok) throw new Error(`图片下载失败：HTTP ${imageRes.status}`);
    const buffer = Buffer.from(await imageRes.arrayBuffer());
    const saved = await saveImageBuffer(buffer, item.id || 'image', imageExtFromContentType(imageRes.headers.get('content-type')));
    return {
      ...saved,
      aspectRatio: imageSizeToMiniMaxAspectRatio(generatedSize),
      generatedSize,
      requestedSize: config.size,
    };
  }
  throw new Error('图片生成接口未返回 url 或 base64 图片');
}

function findVideoIdFromResponse(json) {
  return String(
    json?.video_id
    || json?.id
    || json?.remixed_from_video_id
    || json?.data?.video_id
    || json?.data?.id
    || json?.data?.remixed_from_video_id
    || json?.data?.video?.video_id
    || json?.data?.video?.id
    || json?.data?.video?.remixed_from_video_id
    || json?.output?.video_id
    || json?.output?.id
    || json?.output?.remixed_from_video_id
    || json?.result?.video_id
    || json?.result?.id
    || json?.result?.remixed_from_video_id
    || json?.task?.video_id
    || json?.task?.id
    || json?.task?.remixed_from_video_id
    || '',
  ).trim();
}

function findVideoUrlFromResponse(json) {
  const candidates = [
    json?.video_url,
    json?.url,
    json?.output_url,
    json?.remixed_from_video_id,
    json?.data?.video_url,
    json?.data?.url,
    json?.data?.output_url,
    json?.data?.remixed_from_video_id,
    json?.data?.video?.video_url,
    json?.data?.video?.url,
    json?.data?.video?.output_url,
    json?.data?.video?.remixed_from_video_id,
    json?.output?.video_url,
    json?.output?.url,
    json?.output?.output_url,
    json?.output?.remixed_from_video_id,
    json?.result?.video_url,
    json?.result?.url,
    json?.result?.output_url,
    json?.result?.remixed_from_video_id,
  ];
  if (Array.isArray(json?.data)) {
    candidates.push(json.data[0]?.video_url, json.data[0]?.url, json.data[0]?.output_url, json.data[0]?.remixed_from_video_id);
  }
  if (Array.isArray(json?.videos)) {
    candidates.push(json.videos[0]?.url, json.videos[0]?.video_url, json.videos[0]?.output_url, json.videos[0]?.remixed_from_video_id);
  }
  return String(candidates.find((value) => typeof value === 'string' && /^https?:\/\//i.test(value)) || '').trim();
}

function findVideoStatusFromResponse(json) {
  return String(
    json?.status
    || json?.state
    || json?.data?.status
    || json?.data?.state
    || json?.output?.status
    || json?.result?.status
    || '',
  ).toLowerCase();
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitAgnesRequestSlot(label = 'agnes') {
  const now = Date.now();
  const waitMs = Math.max(0, AGNES_MIN_REQUEST_INTERVAL_MS - (now - lastAgnesRequestAt));
  if (waitMs > 0) {
    appendCutLog('[' + label + '] Waiting ' + waitMs + 'ms to respect Agnes RPM 20 limit');
    await sleep(waitMs);
  }
  lastAgnesRequestAt = Date.now();
}

async function waitAgnesVideoRequestSlot() {
  return waitAgnesRequestSlot('video');
}

async function pollAgnesVideoResult(config, videoId) {
  const deadline = Date.now() + 8 * 60 * 1000;
  let attempt = 0;
  let lastText = '';
  const queryEndpoints = buildAgnesVideoQueryEndpoints(config.baseUrl, videoId);
  while (Date.now() < deadline) {
    attempt += 1;
    const queryUrl = queryEndpoints[(attempt - 1) % queryEndpoints.length];
    await waitAgnesVideoRequestSlot();
    let res;
    try {
      res = await fetch(queryUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      });
    } catch (err) {
      lastText = err.message || String(err);
      appendCutLog(`[video] Agnes query network error (${attempt}): ${lastText}`);
      await sleep(Math.min(15000, 3000 + attempt * 1000));
      continue;
    }
    const text = await res.text();
    lastText = text;
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) {
        await sleep(Math.min(15000, 2500 + attempt * 1000));
        continue;
      }
      if ((res.status === 400 || res.status === 404) && queryEndpoints.length > 1) {
        appendCutLog(`[video] Agnes query endpoint not ready (${res.status}): ${queryUrl}`);
        await sleep(5000);
        continue;
      }
      throw new Error(`Agnes video query failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    let json = {};
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Agnes video query returned non-JSON: ${text.slice(0, 120)}`);
    }
    const url = findVideoUrlFromResponse(json);
    if (url) return url;
    const status = findVideoStatusFromResponse(json);
    if (['failed', 'error', 'canceled', 'cancelled'].includes(status)) {
      throw new Error(`Agnes video generation failed: ${text.slice(0, 300)}`);
    }
    appendCutLog(`[video] waiting Agnes video ${videoId}, attempt ${attempt}, status=${status || 'pending'}, endpoint=${queryUrl}`);
    // Polling stays below the Agnes 20 RPM free limit while supporting both documented and compatibility endpoints.
    await sleep(5000);
  }
  throw new Error(`Agnes video generation timed out. Last response: ${lastText.slice(0, 240)}`);
}

async function callVideoGenerationApi(config, item, options = {}) {
  if (!config.ready) {
    throw new Error(`Video generation config incomplete: missing ${config.missing.join(', ')}`);
  }
  const prompt = String(item?.videoPrompt || item?.prompt || '').trim();
  if (!prompt) throw new Error('Video prompt is empty');

  const size = aspectToVideoSize(options.aspectRatio || item?.aspectRatio || '16:9');
  const targetDurationSec = clampDurationSec(options.durationSec || item?.durationSec || ((Number(item?.end) || 0) - (Number(item?.start) || 0)), 3, 8, 5);
  const generation = videoDurationToGenerationParams(targetDurationSec);
  const frameRate = Math.max(1, Math.min(60, Number(options.frameRate || item?.frameRate || generation.frameRate) || generation.frameRate));
  const numFrames = normalizeVideoFrameCount(options.numFrames || item?.numFrames || generation.numFrames, generation.numFrames);
  const requestBody = {
    model: config.model || AGNES_VIDEO_MODEL,
    prompt,
    mode: 'ti2vid',
    width: size.width,
    height: size.height,
    num_frames: numFrames,
    frame_rate: frameRate,
    negative_prompt: String(item?.negativePrompt || item?.negative_prompt || 'low quality, blurry, text, watermark, logo, distorted face, inconsistent character').trim(),
    extra_body: {
      mode: 'ti2vid',
    },
  };
  const referenceInput = options.referenceImage || item?.referenceImage || item?.visualReference || item?.reference;
  const publicReferenceImage = resolvePublicReferenceImageInput(referenceInput);
  if (publicReferenceImage) {
    requestBody.image = publicReferenceImage;
    requestBody.extra_body.image = publicReferenceImage;
  }

  const postCreate = async (body) => {
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await waitAgnesVideoRequestSlot();
      try {
        const response = await fetch(config.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(body),
        });
        const bodyText = await response.text();
        return { response, bodyText };
      } catch (err) {
        lastError = err;
        appendCutLog(`[video] Agnes create network error (${attempt}/2): ${err.message || String(err)}`);
        if (attempt < 2) await sleep(3500);
      }
    }
    throw lastError || new Error('Agnes video create network error');
  };

  let { response: res, bodyText: text } = await postCreate(requestBody);
  if (!res.ok && publicReferenceImage && /invalid\s+image|incorrect\s+padding|image/i.test(text)) {
    appendCutLog('[video] Agnes rejected the reference image; retrying text-to-video without image reference.');
    delete requestBody.image;
    if (requestBody.extra_body) delete requestBody.extra_body.image;
    ({ response: res, bodyText: text } = await postCreate(requestBody));
  }
  if (!res.ok) {
    throw new Error(`Agnes video create failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Agnes video create returned non-JSON: ${text.slice(0, 120)}`);
  }
  let videoUrl = findVideoUrlFromResponse(json);
  const videoId = findVideoIdFromResponse(json);
  if (!videoUrl) {
    if (!videoId) {
      throw new Error(`Agnes video create did not return video_id: ${text.slice(0, 300)}`);
    }
    appendCutLog(`[video] Agnes video queued: ${videoId}`);
    videoUrl = await pollAgnesVideoResult(config, videoId);
  }
  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) throw new Error(`Video asset download failed: HTTP ${videoRes.status}`);
  const buffer = Buffer.from(await videoRes.arrayBuffer());
  const saved = await saveVideoBuffer(buffer, item.id || videoId || 'video', videoExtFromContentType(videoRes.headers.get('content-type'), videoUrl));
  return {
    ...saved,
    sourceUrl: videoUrl,
    videoId,
    model: config.model,
    frameRate,
    numFrames,
    durationSec: targetDurationSec,
    generationDurationSec: Number((numFrames / frameRate).toFixed(2)),
    width: size.width,
    height: size.height,
  };
}

function randomDraftId(prefix = 'jaygo') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function toDraftUs(seconds) {
  return Math.max(0, Math.round((Number(seconds) || 0) * 1000000));
}

function sanitizeDraftName(input) {
  const value = String(input || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return value || `JaygoCut_${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
}

function parseJsonFileNoBom(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function resolveJianyingTemplatePath(input) {
  const raw = String(input || '').trim().replace(/^"|"$/g, '');
  if (!raw) return '';
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved)) return '';
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    const candidates = [
      path.join(resolved, 'draft_content.json'),
      path.join(resolved, 'draft_content.json.bak'),
    ];
    return candidates.find((p) => fs.existsSync(p)) || '';
  }
  if (stat.isFile() && path.basename(resolved).toLowerCase() === 'draft_content.json') return resolved;
  return '';
}

function resolveJianyingTemplateDir(input) {
  const contentPath = resolveJianyingTemplatePath(input);
  return contentPath ? path.dirname(contentPath) : '';
}

function isDirectorySafe(input) {
  try {
    return Boolean(input) && fs.existsSync(input) && fs.statSync(input).isDirectory();
  } catch {
    return false;
  }
}

function looksLikeJianyingDraftDir(dir) {
  if (!isDirectorySafe(dir)) return false;
  return ['draft_content.json', 'draft_info.json', 'draft_meta_info.json', 'template-2.tmp']
    .some((name) => fs.existsSync(path.join(dir, name)));
}

function looksLikeJianyingDraftRoot(dir) {
  if (!isDirectorySafe(dir)) return false;
  const base = path.basename(dir).toLowerCase();
  if (fs.existsSync(path.join(dir, 'root_meta_info.json'))) return true;
  if (base !== 'com.lveditor.draft') return false;
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .some((entry) => entry.isDirectory() && looksLikeJianyingDraftDir(path.join(dir, entry.name)));
  } catch {
    return false;
  }
}

function normalizeExistingDir(input) {
  const raw = String(input || '').trim().replace(/^"|"$/g, '');
  if (!raw) return '';
  const resolved = path.resolve(raw);
  return isDirectorySafe(resolved) ? resolved : '';
}

function parseConfiguredPathList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  const raw = String(value || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item || '').trim()).filter(Boolean);
    }
  } catch {
    // Fall through to delimiter parsing.
  }
  return raw
    .split(/\r?\n|[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getConfiguredJianyingDraftRoot() {
  return normalizeExistingDir(process.env.JIANYING_DRAFT_ROOT || '');
}

function getConfiguredJianyingTemplates() {
  return parseConfiguredPathList(process.env.JIANYING_TEMPLATE_PATHS || '')
    .map((item) => resolveJianyingTemplateDir(item) || normalizeExistingDir(item))
    .filter(Boolean)
    .filter((dir, index, list) => list.findIndex((item) => item.toLowerCase() === dir.toLowerCase()) === index)
    .slice(0, 5);
}

function getJianyingDraftRootCandidates(extra = []) {
  const roots = [];
  const push = (value) => {
    const normalized = normalizeExistingDir(value);
    if (normalized && !roots.some((item) => item.toLowerCase() === normalized.toLowerCase())) {
      roots.push(normalized);
    }
  };
  extra.forEach(push);
  push(process.env.JIANYING_DRAFT_ROOT);
  const local = process.env.LOCALAPPDATA || '';
  const roaming = process.env.APPDATA || '';
  push(path.join(local, 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft'));
  push(path.join(roaming, 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft'));
  push(path.join(local, 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft'));
  push(path.join(roaming, 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft'));
  return roots;
}

function findJianyingDraftRoots(extra = []) {
  return getJianyingDraftRootCandidates(extra)
    .filter(looksLikeJianyingDraftRoot)
    .map((dir) => ({
      path: dir,
      label: path.basename(path.dirname(path.dirname(path.dirname(dir)))) || path.basename(dir),
    }));
}

function listJianyingDrafts(root) {
  if (!looksLikeJianyingDraftRoot(root)) return [];
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = path.join(root, entry.name);
        if (!looksLikeJianyingDraftDir(dir)) return null;
        let name = entry.name;
        let modified = 0;
        for (const fileName of ['draft_meta_info.json', 'draft_content.json', 'draft_info.json']) {
          const filePath = path.join(dir, fileName);
          if (!fs.existsSync(filePath)) continue;
          try {
            const stat = fs.statSync(filePath);
            modified = Math.max(modified, stat.mtimeMs || 0);
            const json = parseJsonFileNoBom(filePath);
            name = String(json.draft_name || json.name || name);
            break;
          } catch {
            // Ignore partially unreadable draft metadata; the folder can still be used.
          }
        }
        return {
          name,
          path: dir,
          modified,
          modifiedText: modified ? new Date(modified).toLocaleString('zh-CN', { hour12: false }) : '',
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.modified || 0) - (a.modified || 0));
  } catch {
    return [];
  }
}

function uniqueDraftName(baseName, exportRoot) {
  const clean = sanitizeDraftName(baseName);
  if (!isDirectorySafe(exportRoot)) return clean;
  let candidate = clean;
  let index = 2;
  while (fs.existsSync(path.join(exportRoot, candidate))) {
    candidate = sanitizeDraftName(`${clean}_${index}`);
    index += 1;
  }
  return candidate;
}

function resolveJianyingExportTarget(payload = {}, templateDir = '') {
  const exportMode = String(payload.exportMode || 'auto').toLowerCase();
  const customRoot = normalizeExistingDir(payload.targetRoot || payload.draftRoot || '');
  const templateRoot = templateDir && looksLikeJianyingDraftDir(templateDir)
    ? path.dirname(templateDir)
    : '';
  if (exportMode === 'project') {
    return {
      exportRoot: path.resolve(process.cwd(), JIANYING_DRAFT_EXPORT_DIR_NAME),
      exportRootSource: 'project',
      autoPlaced: false,
      templateDir,
    };
  }
  if (customRoot) {
    if (looksLikeJianyingDraftRoot(customRoot)) {
      return { exportRoot: customRoot, exportRootSource: 'custom', autoPlaced: true, templateDir };
    }
    if (looksLikeJianyingDraftDir(customRoot)) {
      return { exportRoot: path.dirname(customRoot), exportRootSource: 'custom-draft-parent', autoPlaced: true, templateDir: templateDir || customRoot };
    }
    if (exportMode === 'custom') {
      return { exportRoot: customRoot, exportRootSource: 'custom-folder', autoPlaced: false, templateDir };
    }
  }
  if (templateRoot && looksLikeJianyingDraftRoot(templateRoot)) {
    return { exportRoot: templateRoot, exportRootSource: 'template-root', autoPlaced: true, templateDir };
  }
  const configuredRoot = getConfiguredJianyingDraftRoot();
  if (configuredRoot) {
    if (looksLikeJianyingDraftRoot(configuredRoot)) {
      return { exportRoot: configuredRoot, exportRootSource: 'configured-root', autoPlaced: true, templateDir };
    }
    return { exportRoot: configuredRoot, exportRootSource: 'configured-folder', autoPlaced: false, templateDir };
  }
  const detected = findJianyingDraftRoots()[0];
  if (detected?.path) {
    return { exportRoot: detected.path, exportRootSource: 'auto', autoPlaced: true, templateDir };
  }
  return {
    exportRoot: path.resolve(process.cwd(), JIANYING_DRAFT_EXPORT_DIR_NAME),
    exportRootSource: 'project-fallback',
    autoPlaced: false,
    templateDir,
  };
}

function loadJianyingTemplate(templatePath) {
  const contentPath = resolveJianyingTemplatePath(templatePath);
  if (!contentPath) return null;
  const content = parseJsonFileNoBom(contentPath);
  const materials = content.materials && typeof content.materials === 'object' ? content.materials : {};
  const textMaterial = Array.isArray(materials.texts) && materials.texts.length
    ? deepClone(materials.texts[0])
    : null;
  const textTrack = Array.isArray(content.tracks)
    ? content.tracks.find((track) => track && track.type === 'text' && Array.isArray(track.segments) && track.segments.length)
    : null;
  const textSegment = textTrack ? deepClone(textTrack.segments[0]) : null;
  return {
    content,
    contentPath,
    rootDir: path.dirname(contentPath),
    textMaterial,
    textSegment,
  };
}

function htmlEscapeText(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function replaceTextContent(templateContent, text) {
  const plain = String(text || '').trim();
  const escaped = htmlEscapeText(plain);
  const raw = String(templateContent || '');
  if (!raw || !/[<>]/.test(raw)) return plain;
  if (raw.includes('</text>')) {
    return raw.replace(/(<text[^>]*>)([\s\S]*?)(<\/text>)/i, `$1${escaped}$3`);
  }
  if (raw.includes('&lt;/text&gt;')) {
    return raw.replace(/(&lt;text[^&]*&gt;)([\s\S]*?)(&lt;\/text&gt;)/i, `$1${escaped}$3`);
  }
  const replaced = raw.replace(/(>)([^<>]*)(<\/[^>]+>\s*)$/s, `$1${escaped}$3`);
  return replaced === raw ? plain : replaced;
}

function presetTextMaterial(preset, text) {
  const key = String(preset || 'clean').trim();
  const presets = {
    clean: {
      content: text,
      font_size: 8,
      text_color: '#FFFFFF',
      border_color: '#111827',
      border_width: 0.08,
      background_alpha: 0,
    },
    blackgold: {
      content: text,
      font_size: 9,
      text_color: '#F8E7B0',
      border_color: '#0B0F17',
      border_width: 0.12,
      background_alpha: 0.18,
      background_color: '#111111',
    },
    variety: {
      content: text,
      font_size: 10,
      text_color: '#FFFFFF',
      border_color: '#FF7A00',
      border_width: 0.14,
      background_alpha: 0,
    },
    soft: {
      content: text,
      font_size: 8,
      text_color: '#FFF7ED',
      border_color: '#7C2D12',
      border_width: 0.08,
      background_alpha: 0.08,
      background_color: '#F97316',
    },
  };
  return presets[key] || presets.clean;
}

function buildDefaultTextMaterial(text, preset) {
  const style = presetTextMaterial(preset, text);
  return {
    id: randomDraftId('text'),
    type: 'text',
    name: 'Jaygo Cut Subtitle',
    content: String(text || ''),
    content_rich_text: [],
    font_path: '',
    font_resource_id: '',
    font_size: style.font_size,
    text_color: style.text_color,
    border_color: style.border_color,
    border_width: style.border_width,
    background_alpha: style.background_alpha || 0,
    background_color: style.background_color || '',
    alignment: 1,
    line_spacing: 0,
    letter_spacing: 0,
  };
}

function buildDefaultTextSegment(materialId, cue) {
  const start = toDraftUs(cue.start);
  const duration = Math.max(300000, toDraftUs(Math.max(0.3, Number(cue.end) - Number(cue.start))));
  return {
    id: randomDraftId('segment'),
    material_id: materialId,
    target_timerange: { start, duration },
    source_timerange: { start: 0, duration },
    render_index: 0,
    visible: true,
    volume: 1,
    extra_material_refs: [],
    clip: {
      alpha: 1,
      flip: { horizontal: false, vertical: false },
      rotation: 0,
      scale: { x: 1, y: 1 },
      transform: { x: 0, y: -0.72 },
    },
  };
}

function createBaseDraftContent(template, draftId, durationUs) {
  const base = template?.content ? deepClone(template.content) : {};
  base.id = draftId;
  base.duration = durationUs;
  base.version = base.version || 360000;
  base.fps = base.fps || 30;
  base.canvas_config = base.canvas_config || { width: 1920, height: 1080, ratio: 'original' };
  base.materials = base.materials && typeof base.materials === 'object' ? base.materials : {};
  base.materials.texts = [];
  base.tracks = Array.isArray(base.tracks)
    ? base.tracks.filter((track) => track && track.type !== 'text')
    : [];
  base.tracks.push({
    id: randomDraftId('track_text'),
    type: 'text',
    attribute: 0,
    flag: 0,
    is_default_name: true,
    name: 'Jaygo Cut Subtitles',
    segments: [],
  });
  return base;
}

function makeTextMaterialFromTemplate(templateMaterial, text, preset) {
  if (!templateMaterial) return buildDefaultTextMaterial(text, preset);
  const material = deepClone(templateMaterial);
  material.id = randomDraftId('text');
  material.name = material.name || 'Jaygo Cut Subtitle';
  material.content = replaceTextContent(material.content, text);
  if ('text' in material) material.text = String(text || '');
  if ('content_rich_text' in material && Array.isArray(material.content_rich_text)) {
    material.content_rich_text = [];
  }
  return material;
}

function makeTextSegmentFromTemplate(templateSegment, materialId, cue) {
  if (!templateSegment) return buildDefaultTextSegment(materialId, cue);
  const segment = deepClone(templateSegment);
  segment.id = randomDraftId('segment');
  segment.material_id = materialId;
  const start = toDraftUs(cue.start);
  const duration = Math.max(300000, toDraftUs(Math.max(0.3, Number(cue.end) - Number(cue.start))));
  segment.target_timerange = { ...(segment.target_timerange || {}), start, duration };
  segment.source_timerange = { ...(segment.source_timerange || {}), start: 0, duration };
  segment.visible = segment.visible !== false;
  return segment;
}

function normalizeCueList(cues) {
  if (!Array.isArray(cues)) return [];
  return cues
    .map((cue) => ({
      start: Math.max(0, Number(cue?.start) || 0),
      end: Math.max(0, Number(cue?.end) || 0),
      text: String(cue?.text || '').trim(),
    }))
    .filter((cue) => cue.text && cue.end > cue.start)
    .sort((a, b) => a.start - b.start);
}

function clampNumber(value, min, max, fallback = min) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function normalizeDraftDeleteSegments(segments, durationSec = Infinity) {
  if (!Array.isArray(segments)) return [];
  const maxEnd = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Infinity;
  const normalized = segments
    .map((seg) => {
      const start = clampNumber(seg?.start, 0, maxEnd, NaN);
      const end = clampNumber(seg?.end, 0, maxEnd, NaN);
      return { start, end };
    })
    .filter((seg) => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const seg of normalized) {
    const last = merged[merged.length - 1];
    if (last && seg.start <= last.end + 0.001) {
      last.end = Math.max(last.end, seg.end);
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

function sumDraftDeletedDuration(segments) {
  return normalizeDraftDeleteSegments(segments)
    .reduce((sum, seg) => sum + Math.max(0, seg.end - seg.start), 0);
}

function mapDraftTimeAfterDeletes(time, deleteSegments) {
  const value = Math.max(0, Number(time) || 0);
  let removed = 0;
  for (const seg of deleteSegments) {
    if (seg.end <= value) {
      removed += seg.end - seg.start;
    } else if (seg.start < value) {
      removed += Math.max(0, value - seg.start);
      break;
    } else {
      break;
    }
  }
  return Math.max(0, value - removed);
}

function buildDraftKeepSegments(deleteSegments, sourceDurationSec) {
  const duration = Math.max(0, Number(sourceDurationSec) || 0);
  if (!(duration > 0)) return [];
  const deletes = normalizeDraftDeleteSegments(deleteSegments, duration);
  const keep = [];
  let cursor = 0;
  let outStart = 0;
  for (const seg of deletes) {
    const start = Math.max(0, Math.min(duration, seg.start));
    const end = Math.max(0, Math.min(duration, seg.end));
    if (start > cursor + 0.015) {
      const keepDuration = start - cursor;
      keep.push({ sourceStart: cursor, start: outStart, duration: keepDuration });
      outStart += keepDuration;
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < duration - 0.015) {
    keep.push({ sourceStart: cursor, start: outStart, duration: duration - cursor });
  }
  return keep.filter((seg) => seg.duration >= 0.04);
}

function resolveCapcutCliPath() {
  let pkgPath = require.resolve('capcut-cli/package.json');
  if (pkgPath.includes('.asar')) {
    const unpackedPath = pkgPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    if (fs.existsSync(unpackedPath)) pkgPath = unpackedPath;
  }
  const cliPath = path.join(path.dirname(pkgPath), 'dist', 'index.js');
  if (!fs.existsSync(cliPath)) {
    throw new Error(`capcut-cli not found: ${cliPath}`);
  }
  return cliPath;
}

function inferJianyingCanvas(payload = {}) {
  const meta = payload.sourceVideoMeta || payload.videoMeta || {};
  const width = Math.round(Number(meta.width) || Number(payload.width) || 0);
  const height = Math.round(Number(meta.height) || Number(payload.height) || 0);
  if (width > 0 && height > 0) {
    return {
      width,
      height,
      fps: Math.round(Number(meta.fps) || Number(payload.fps) || 30),
      ratio: 'original',
    };
  }
  return { width: 1920, height: 1080, fps: 30, ratio: 'original' };
}

function textStyleForJianyingPreset(preset) {
  const key = String(preset || '').toLowerCase();
  if (key === 'blackgold') {
    return { fontSize: 9, color: '#F8E7B0', y: -0.76 };
  }
  if (key === 'bold') {
    return { fontSize: 10, color: '#FFFFFF', y: -0.74 };
  }
  return { fontSize: 9, color: '#FFFFFF', y: -0.76 };
}

function getDraftAssetFilePath(item, kind) {
  const direct = String(item?.filePath || '').trim();
  if (direct) return direct;
  const nestedKey = kind === 'video' ? 'video' : 'image';
  return resolveMediaFilePathFromAsset(item?.[nestedKey] || item, kind);
}

function resolveMediaFilePathFromAsset(asset, kind = '') {
  if (!asset || typeof asset !== 'object') return '';
  const direct = String(asset.filePath || asset.path || '').trim();
  if (direct && fs.existsSync(direct)) return path.resolve(direct);
  const url = String(asset.url || asset.imageUrl || asset.videoUrl || '').trim();
  const fileName = String(asset.fileName || '').trim() || (url ? decodeURIComponent(url.split(/[/?#]/).filter(Boolean).pop() || '') : '');
  const candidates = [];
  const lowerKind = String(kind || '').toLowerCase();
  if (lowerKind === 'image' || url.includes('/image_assets/')) candidates.push(path.join(IMAGE_ASSET_DIR, fileName));
  if (lowerKind === 'video' || url.includes('/video_assets/')) candidates.push(path.join(VIDEO_ASSET_DIR, fileName));
  if (!lowerKind && fileName) {
    candidates.push(path.join(IMAGE_ASSET_DIR, fileName));
    candidates.push(path.join(VIDEO_ASSET_DIR, fileName));
  }
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const allowed = resolved.startsWith(path.resolve(IMAGE_ASSET_DIR)) || resolved.startsWith(path.resolve(VIDEO_ASSET_DIR));
    if (allowed && fs.existsSync(resolved)) return resolved;
  }
  return '';
}

function collectJianyingMediaItems(payload = {}, kind, deleteSegments) {
  const mediaAssets = payload.mediaAssets && typeof payload.mediaAssets === 'object' ? payload.mediaAssets : {};
  const rawItems = kind === 'video'
    ? (mediaAssets.videos || payload.videoItems || [])
    : (mediaAssets.images || payload.imageItems || []);
  const sanitized = sanitizeReviewMediaItems(rawItems, kind);
  const mapTime = (time) => mapDraftTimeAfterDeletes(time, deleteSegments);
  return sanitized.map((item, index) => {
    const filePath = getDraftAssetFilePath(item, kind);
    if (!filePath || !fs.existsSync(filePath)) return null;
    const originalStart = Number(item.start);
    const originalEnd = Number(item.end);
    if (!Number.isFinite(originalStart) || !Number.isFinite(originalEnd) || originalEnd <= originalStart) return null;
    const mappedStart = mapTime(originalStart);
    const mappedEnd = mapTime(originalEnd);
    const duration = mappedEnd - mappedStart;
    if (duration < (kind === 'video' ? 0.4 : 0.8)) return null;
    return {
      ref: `${kind}_${index + 1}`,
      path: path.resolve(filePath),
      start: Number(mappedStart.toFixed(3)),
      duration: Number(duration.toFixed(3)),
      type: kind === 'image' ? 'photo' : 'video',
      title: item.title || '',
    };
  }).filter(Boolean);
}

function getJianyingSourceDuration(payload, sourceVideoPath, cues, deleteSegments) {
  const explicit = Number(payload.sourceDurationSec || payload.durationSec || payload.originalDurationSec);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const probed = fs.existsSync(sourceVideoPath) ? probeDuration(sourceVideoPath) : NaN;
  if (Number.isFinite(probed) && probed > 0) return probed;
  const cueEnd = Math.max(0, ...cues.map((cue) => Number(cue.end) || 0));
  const removed = sumDraftDeletedDuration(deleteSegments);
  const mediaEnd = Math.max(
    0,
    ...['images', 'videos'].flatMap((key) => {
      const list = payload.mediaAssets && Array.isArray(payload.mediaAssets[key]) ? payload.mediaAssets[key] : [];
      return list.map((item) => Number(item?.end) || 0);
    }),
  );
  return Math.max(cueEnd + removed, mediaEnd, 1);
}

function buildJianyingFullDraftSpec(payload = {}) {
  const cues = normalizeCueList(payload.cues);
  if (!cues.length) throw new Error('没有可导出的字幕，请检查是否全部内容都被标记删除。');
  const sourceVideoPath = path.resolve(payload.sourceVideoPath || VIDEO_FILE);
  if (!fs.existsSync(sourceVideoPath)) {
    throw new Error(`原视频文件不存在，无法生成完整剪映草稿：${sourceVideoPath}`);
  }
  const rawDeletes = normalizeDraftDeleteSegments(payload.deleteSegments || payload.segments || []);
  const sourceDurationSec = getJianyingSourceDuration(payload, sourceVideoPath, cues, rawDeletes);
  const deleteSegments = normalizeDraftDeleteSegments(rawDeletes, sourceDurationSec);
  const keepSegments = buildDraftKeepSegments(deleteSegments, sourceDurationSec);
  if (!keepSegments.length) {
    throw new Error('删除范围覆盖了全部视频，无法生成完整剪映草稿。');
  }
  const canvas = inferJianyingCanvas(payload);
  const textStyle = textStyleForJianyingPreset(payload.preset);
  const mainVideoItems = keepSegments.map((seg, index) => ({
    ref: `main_${index + 1}`,
    path: sourceVideoPath,
    start: Number(seg.start.toFixed(3)),
    duration: Number(seg.duration.toFixed(3)),
    sourceStart: Number(seg.sourceStart.toFixed(3)),
    type: 'video',
  }));
  const imageItems = collectJianyingMediaItems(payload, 'image', deleteSegments);
  const videoItems = collectJianyingMediaItems(payload, 'video', deleteSegments).map((item) => ({
    ...item,
    volume: 0,
    sourceStart: 0,
  }));
  const textItems = cues.map((cue, index) => ({
    ref: `subtitle_${index + 1}`,
    text: String(cue.text || '').trim(),
    start: Number(Number(cue.start).toFixed(3)),
    duration: Number(Math.max(0.35, Number(cue.end) - Number(cue.start)).toFixed(3)),
    ...textStyle,
  }));
  const tracks = [
    { type: 'video', name: 'Jaygo Cut 主视频', items: mainVideoItems },
  ];
  if (imageItems.length) tracks.push({ type: 'video', name: 'Jaygo Cut 图片素材', items: imageItems });
  if (videoItems.length) tracks.push({ type: 'video', name: 'Jaygo Cut 视频素材', items: videoItems });
  tracks.push({ type: 'text', name: 'Jaygo Cut 字幕', items: textItems });
  return {
    spec: {
      name: sanitizeDraftName(payload.draftName || `JaygoCut_${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`),
      width: canvas.width,
      height: canvas.height,
      fps: canvas.fps,
      ratio: canvas.ratio,
      tracks,
    },
    stats: {
      cues: textItems.length,
      deleteSegments: deleteSegments.length,
      keepSegments: mainVideoItems.length,
      imageAssets: imageItems.length,
      videoAssets: videoItems.length,
      sourceDurationSec: Number(sourceDurationSec.toFixed(3)),
      outputDurationSec: Number((sourceDurationSec - sumDraftDeletedDuration(deleteSegments)).toFixed(3)),
    },
  };
}

function runCapcutCliCompile(specPath, draftDir, templateDir = '') {
  const cliPath = resolveCapcutCliPath();
  const runner = getNodeRunner();
  const args = [cliPath, 'compile', specPath, '--out', draftDir, '--force-write', '--quiet'];
  if (templateDir && looksLikeJianyingDraftDir(templateDir)) {
    args.push('--template', templateDir);
  }
  const result = spawnSync(
    runner.command,
    args,
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, ...runner.extraEnv },
      windowsHide: true,
      timeout: 120000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(`capcut-cli exited with code ${result.status}${detail ? `: ${detail.slice(0, 1200)}` : ''}`);
  }
  return {
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function writeJianyingFullDraft(payload = {}) {
  const { spec, stats } = buildJianyingFullDraftSpec(payload);
  const templateDir = resolveJianyingTemplateDir(payload.templatePath);
  const target = resolveJianyingExportTarget(payload, templateDir);
  const exportRoot = path.resolve(target.exportRoot);
  fs.mkdirSync(exportRoot, { recursive: true });
  const draftName = uniqueDraftName(spec.name, exportRoot);
  spec.name = draftName;
  const draftDir = path.join(exportRoot, draftName);
  const specDir = path.join(path.resolve(process.cwd(), JIANYING_DRAFT_EXPORT_DIR_NAME), '_specs');
  const specPath = path.join(specDir, `${draftName}.json`);
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  const cliResult = runCapcutCliCompile(specPath, draftDir, target.templateDir);
  fs.copyFileSync(specPath, path.join(draftDir, 'jaygo_cut_full_draft_spec.json'));
  fs.writeFileSync(path.join(draftDir, 'README_JaygoCut.txt'), [
    'Jaygo Cut 完整剪映草稿导出说明',
    '',
    '1. 这个文件夹包含主视频轨、字幕轨，以及已生成的图片/视频素材轨。',
    target.autoPlaced
      ? '2. 草稿已直接写入剪映/CapCut 草稿目录，打开剪映即可在项目列表中看到；如果剪映已打开，必要时请重启剪映刷新列表。'
      : '2. 草稿已导出到当前项目目录，请将整个草稿文件夹复制到剪映草稿目录后打开。',
    target.templateDir
      ? '3. 本草稿基于你选择的模板草稿生成了一个新草稿，原模板不会被覆盖。'
      : '3. 未选择模板草稿，已使用 Jaygo Cut 默认草稿结构。',
    '4. 视频素材轨已默认静音，避免和主视频口播音频叠音。',
    '5. 备用规格文件：jaygo_cut_full_draft_spec.json，可用于排查或重新生成草稿。',
    '',
    `字幕条数：${stats.cues}`,
    `主视频保留片段：${stats.keepSegments}`,
    `图片素材：${stats.imageAssets}`,
    `视频素材：${stats.videoAssets}`,
    `导出根目录：${exportRoot}`,
    `导出方式：${target.exportRootSource}`,
  ].join('\r\n'), 'utf8');
  return {
    fullDraft: true,
    engine: 'capcut-cli',
    draftDir,
    draftName,
    specPath,
    exportRoot,
    exportRootSource: target.exportRootSource,
    autoPlaced: target.autoPlaced,
    templateUsed: Boolean(target.templateDir),
    templatePath: target.templateDir,
    compatibilityNote: target.autoPlaced
      ? '完整草稿已写入剪映/CapCut 草稿目录；若项目列表未刷新，请重启剪映。'
      : '完整草稿依赖剪映/CapCut 草稿格式兼容性；如新版剪映无法识别，请使用 SRT 或字幕草稿兜底。',
    cliStdout: cliResult.stdout,
    cliStderr: cliResult.stderr,
    ...stats,
  };
}

function writeJianyingDraftExport(payload = {}) {
  if (payload.fullDraft) {
    try {
      return writeJianyingFullDraft(payload);
    } catch (err) {
      const fallback = writeJianyingDraft({ ...payload, fullDraft: false });
      return {
        ...fallback,
        fullDraft: false,
        fallbackUsed: true,
        fallbackReason: err.message || String(err),
      };
    }
  }
  return writeJianyingDraft(payload);
}

function writeJianyingDraft(payload = {}) {
  const cues = normalizeCueList(payload.cues);
  if (!cues.length) throw new Error('没有可导出的字幕，请检查是否全部内容都被删除。');
  const template = loadJianyingTemplate(payload.templatePath);
  const draftName = sanitizeDraftName(payload.draftName || `JaygoCut_${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`);
  const draftId = randomDraftId('draft');
  const durationUs = Math.max(...cues.map((cue) => toDraftUs(cue.end)), 1000000);
  const draftDir = path.join(path.resolve(process.cwd(), JIANYING_DRAFT_EXPORT_DIR_NAME), draftName);
  fs.rmSync(draftDir, { recursive: true, force: true });
  fs.mkdirSync(draftDir, { recursive: true });

  const content = createBaseDraftContent(template, draftId, durationUs);
  const textTrack = content.tracks.find((track) => track.type === 'text');
  for (const cue of cues) {
    const material = makeTextMaterialFromTemplate(template?.textMaterial, cue.text, payload.preset);
    content.materials.texts.push(material);
    textTrack.segments.push(makeTextSegmentFromTemplate(template?.textSegment, material.id, cue));
  }

  fs.writeFileSync(path.join(draftDir, 'draft_content.json'), `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  const meta = {
    draft_id: draftId,
    draft_name: draftName,
    draft_fold_path: draftDir,
    draft_root_path: draftDir,
    draft_type: 'draft',
    tm_draft_create: Date.now(),
    tm_draft_modified: Date.now(),
    draft_duration: durationUs,
    draft_removable_storage_device: '',
    draft_cloud_purchase_info: '',
    draft_cover: '',
    version: '5.9.0',
  };
  fs.writeFileSync(path.join(draftDir, 'draft_meta_info.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(draftDir, 'draft_virtual_store.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(draftDir, 'README_JaygoCut.txt'), [
    'Jaygo Cut 剪映草稿导出说明',
    '',
    '1. 将整个文件夹复制到剪映草稿目录后，在剪映中打开。',
    '2. 如果使用剪映 6.x 或更新版本，草稿 JSON 可能被加密；若无法识别，请使用 SRT 导入方案。',
    '3. 自定义字幕模板来自：' + (template?.rootDir || '内置样式'),
  ].join('\r\n'), 'utf8');
  return {
    draftDir,
    draftName,
    cues: cues.length,
    templateUsed: Boolean(template),
    templatePath: template?.rootDir || '',
    compatibilityNote: '剪映 5.9 及以下通常可直接识别；剪映 6.x+ 可能加密草稿，请保留 SRT 兜底。',
  };
}

function parseChatAdjustIntent(message) {
  const text = String(message || '');
  return {
    wantsMark: /(删|删除|去掉|精简|压缩|标记|优化|裁剪|无用|废话|口头禅|语气词|重复|离题)/.test(text),
    wantsFiller: /(语气词|口头禅|嗯|啊|呃|然后|就是)/.test(text),
    wantsRepeat: /(重复|啰嗦|赘述|车轱辘)/.test(text),
    wantsOffTopic: /(离题|跑题|闲聊|无关|题外|偏题)/.test(text),
    wantsHead: /(开头|前半|前面|前段)/.test(text),
    wantsTail: /(结尾|后半|后面|后段)/.test(text),
    wantsKeepHead: /(保留开头|开头别删|不要删开头)/.test(text),
    wantsKeepTail: /(保留结尾|结尾别删|不要删结尾)/.test(text),
  };
}

function extractTopicKeywords(topic) {
  const text = String(topic || '').trim();
  if (!text) return [];
  const chunks = text.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,}/g) || [];
  return Array.from(new Set(chunks.map((v) => v.toLowerCase()))).slice(0, 8);
}

function buildHeuristicChatAddIds(units, selectedUnitIds, analysis, intent, maxAllowed) {
  const selectedSet = new Set(selectedUnitIds || []);
  const topicKeywords = extractTopicKeywords(analysis?.topic || analysis?.outline);
  const scores = new Map();

  const push = (id, score) => {
    if (!Number.isInteger(id) || score <= 0) return;
    const prev = scores.get(id) || 0;
    if (score > prev) scores.set(id, score);
  };

  const isInPreferredScope = (index) => {
    if (intent.wantsHead) return index <= Math.floor(units.length * 0.45);
    if (intent.wantsTail) return index >= Math.floor(units.length * 0.45);
    return true;
  };

  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    if (!u || selectedSet.has(u.id)) continue;
    if (!isInPreferredScope(i)) continue;
    const text = String(u.text || '').trim();
    if (!text || isInfoDenseTextForFallback(text)) continue;

    const filler = fillerScoreForUnit(text);
    if ((intent.wantsFiller || intent.wantsMark) && filler >= 0.30) {
      push(u.id, 0.58 + Math.min(0.2, filler * 0.3));
    }

    if (intent.wantsRepeat || intent.wantsMark) {
      for (let back = 1; back <= 5; back += 1) {
        const j = i - back;
        if (j < 0) break;
        const prev = units[j];
        if (!prev || isInfoDenseTextForFallback(prev.text)) continue;
        const sim = diceSimilarityForUnits(text, prev.text);
        if (sim >= 0.84) {
          push(u.id, Math.max(0.62, sim * 0.74));
          break;
        }
      }
    }

    if (intent.wantsOffTopic && topicKeywords.length) {
      const low = text.toLowerCase();
      const hit = topicKeywords.some((kw) => low.includes(kw));
      if (!hit && filler >= 0.18 && text.length <= 42) {
        push(u.id, 0.6);
      }
    }
  }

  const out = Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxAllowed)
    .map(([id]) => id);
  return out;
}

function buildHeuristicChatRemoveIds(units, selectedUnitIds, intent, maxAllowed) {
  const selectedSet = new Set(selectedUnitIds || []);
  const out = [];
  if (!selectedSet.size) return out;
  const headCut = Math.floor(units.length * 0.16);
  const tailCut = Math.floor(units.length * 0.84);

  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    if (!u || !selectedSet.has(u.id)) continue;
    if (intent.wantsKeepHead && i <= headCut) out.push(u.id);
    else if (intent.wantsKeepTail && i >= tailCut) out.push(u.id);
    if (out.length >= maxAllowed) break;
  }
  return Array.from(new Set(out));
}

async function runLlmChatAdjust(words, config, selectedIndices, userMessage, history, inputAnalysis, mediaAssets = {}) {
  const units = buildTranscriptUnits(words);
  if (!units.length) {
    throw new Error('转录内容为空，无法调整标记');
  }
  const message = String(userMessage || '').trim();
  if (!message) {
    throw new Error('请输入调整要求');
  }
  const intent = parseChatAdjustIntent(message);

  const analysis = await resolveAnalysis(units, config, inputAnalysis);
  const selectedUnitIds = selectedUnitIdsFromIndices(words, units, selectedIndices);
  const prompt = buildChatAdjustPrompt(units, selectedUnitIds, message, history, analysis, mediaAssets);
  let raw = '';
  let parsed = {};
  let llmError = '';
  try {
    raw = await callLlmProvider(config, prompt);
    parsed = extractJsonObject(raw) || {};
  } catch (err) {
    llmError = err && err.message ? String(err.message) : 'LLM 调用失败';
    parsed = {};
  }
  const validIdSet = new Set(units.map((u) => u.id));
  const unitById = new Map(units.map((u) => [u.id, u]));
  const maxAdjustUnits = Math.min(120, Math.max(16, Math.floor(units.length * 0.22)));

  let addIds = parseIdArray(parsed.add_ids || parsed.addIds, validIdSet);
  let removeIds = parseIdArray(parsed.remove_ids || parsed.removeIds, validIdSet);
  const mediaActions = sanitizeMediaActions(parsed.media_actions || parsed.mediaActions || parsed.actions);
  const fromMarkDelete = parseLlmDeleteItems(parsed, validIdSet).map((item) => item.id);
  if (!addIds.length && fromMarkDelete.length) {
    addIds = parseIdArray(fromMarkDelete, validIdSet);
  }
  if (!addIds.length) {
    addIds = parseIdArray(parsed.delete_ids || parsed.deleteIds, validIdSet);
  }

  if (!addIds.length) {
    addIds = parseAdjustIdsFromRaw(raw, 'add_ids').filter((id) => validIdSet.has(id));
  }
  if (!addIds.length) {
    addIds = parseAdjustIdsFromRaw(raw, 'delete_ids').filter((id) => validIdSet.has(id));
  }
  if (!removeIds.length) {
    removeIds = parseAdjustIdsFromRaw(raw, 'remove_ids').filter((id) => validIdSet.has(id));
  }

  if (!addIds.length && intent.wantsMark) {
    addIds = buildHeuristicChatAddIds(units, selectedUnitIds, analysis, intent, maxAdjustUnits);
  }
  if (!addIds.length && llmError) {
    addIds = buildHeuristicChatAddIds(
      units,
      selectedUnitIds,
      analysis,
      { ...intent, wantsMark: true, wantsFiller: true, wantsRepeat: true },
      maxAdjustUnits,
    );
  }
  if (!removeIds.length && (intent.wantsKeepHead || intent.wantsKeepTail)) {
    removeIds = buildHeuristicChatRemoveIds(units, selectedUnitIds, intent, maxAdjustUnits);
  }

  const removeSet = new Set(removeIds);
  addIds = addIds.filter((id) => !removeSet.has(id));
  addIds = addIds.filter((id) => {
    const unit = unitById.get(id);
    return unit && !isInfoDenseTextForFallback(unit.text);
  });

  if (addIds.length > maxAdjustUnits) {
    addIds = addIds.slice(0, maxAdjustUnits);
  }
  if (removeIds.length > maxAdjustUnits) {
    removeIds = removeIds.slice(0, maxAdjustUnits);
  }

  const addIndices = unitIdsToIndices(words, units, addIds);
  const removeIndices = unitIdsToIndices(words, units, removeIds);

  return {
    addIds,
    removeIds,
    addIndices,
    removeIndices,
    mediaActions,
    reason: trimByChars(String(parsed.reason || '').trim(), 60) || (llmError ? 'LLM异常，已采用规则兜底' : ''),
    summary: trimByChars(String(parsed.summary || parsed.note || '').trim(), 120) || llmError,
    analysis,
  };
}

function selectedUnitIdsFromIndices(words, units, selectedIndices) {
  const selectedSet = new Set(
    Array.isArray(selectedIndices)
      ? selectedIndices
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v >= 0 && v < words.length)
      : [],
  );
  const ids = [];
  for (const u of units) {
    let hit = false;
    for (let i = u.startIndex; i <= u.endIndex; i += 1) {
      if (selectedSet.has(i)) {
        hit = true;
        break;
      }
    }
    if (hit) ids.push(u.id);
  }
  return ids;
}

function unitIdsToIndices(words, units, unitIds) {
  const idSet = new Set(unitIds || []);
  const out = [];
  for (const u of units) {
    if (!idSet.has(u.id)) continue;
    for (let i = u.startIndex; i <= u.endIndex; i += 1) {
      if (words[i] && !words[i].isGap) out.push(i);
    }
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

function parseAdjustIdsFromRaw(rawText, key) {
  const text = String(rawText || '');
  const out = [];
  const pattern = new RegExp(`${key}\\s*[:：]\\s*\\[([^\\]]+)\\]`, 'i');
  const m = text.match(pattern);
  if (m && m[1]) {
    const nums = m[1].match(/\d+/g) || [];
    for (const n of nums) out.push(Number(n));
  }
  return out.filter((v) => Number.isInteger(v));
}

function parseIdArray(values, validIds) {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((v) => Number(v))
        .filter((id) => Number.isInteger(id) && validIds.has(id)),
    ),
  );
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

function sanitizeMediaActions(actions) {
  if (!Array.isArray(actions)) return [];
  const allowed = new Set([
    'add_image',
    'update_image',
    'move_image',
    'delete_image',
    'regenerate_image',
    'add_video',
    'update_video',
    'move_video',
    'delete_video',
    'regenerate_video',
  ]);
  const out = [];
  for (const raw of actions.slice(0, 40)) {
    if (!raw || typeof raw !== 'object') continue;
    const type = normalizeMediaActionType(raw.type || raw.action || raw.operation || raw.op);
    if (!allowed.has(type)) continue;
    const kind = type.includes('video') ? 'video' : 'image';
    const minDuration = kind === 'video' ? 3 : 5;
    const maxDuration = kind === 'video' ? 8 : 10;
    const fallbackDuration = kind === 'video' ? 5 : 7;
    const rawStart = raw.start ?? raw.startSec ?? raw.time ?? raw.begin;
    const rawEnd = raw.end ?? raw.endSec;
    const start = Number(rawStart);
    const end = Number(rawEnd);
    const hasStart = Number.isFinite(start) && start >= 0;
    const durationSec = clampDurationSec(
      raw.durationSec ?? raw.duration ?? (Number.isFinite(end) && hasStart ? end - start : undefined),
      minDuration,
      maxDuration,
      fallbackDuration,
    );
    const item = {
      type,
      id: String(raw.id || raw.mediaId || '').replace(/[^\w-]/g, '_').slice(0, 48),
      index: Number.isFinite(Number(raw.index ?? raw.ordinal ?? raw.no)) ? Math.max(1, Math.floor(Number(raw.index ?? raw.ordinal ?? raw.no))) : undefined,
      title: String(raw.title || '').trim().slice(0, 80),
      purpose: String(raw.purpose || raw.reason || '').trim().slice(0, 140),
      textBasis: String(raw.textBasis || raw.text || '').trim().slice(0, 160),
      directorIntent: String(raw.directorIntent || raw.intent || '').trim().slice(0, 240),
      sceneStory: String(raw.sceneStory || raw.scene || '').trim().slice(0, 420),
      camera: String(raw.camera || raw.lens || '').trim().slice(0, 260),
      prompt: String(raw.prompt || raw.imagePrompt || '').trim().slice(0, 1800),
      videoPrompt: String(raw.videoPrompt || '').trim().slice(0, 1800),
      negativePrompt: String(raw.negativePrompt || '').trim().slice(0, 600),
      aspectRatio: String(raw.aspectRatio || raw.ratio || '').trim().slice(0, 20),
      motionEffect: String(raw.motionEffect || raw.motion || '').trim().slice(0, 20),
      regenerate: !!raw.regenerate || type.startsWith('regenerate_'),
    };
    if (hasStart) {
      item.start = Number(start.toFixed(3));
      item.durationSec = Number(durationSec.toFixed(2));
      item.end = Number((item.start + durationSec).toFixed(3));
    } else if (type.startsWith('add_')) {
      item.start = 0;
      item.durationSec = Number(durationSec.toFixed(2));
      item.end = Number(durationSec.toFixed(3));
    }
    out.push(item);
  }
  return out;
}

async function runLlmMarking(words, config) {
  const units = buildTranscriptUnits(words);
  if (!units.length) {
    throw new Error('转录内容为空，无法执行 LLM 标记');
  }

  const allUnitIdSet = new Set(units.map((u) => u.id));
  const chunks = chunkTranscriptUnits(units);
  const selectedMap = new Map();
  const punctuationByUnitId = new Map();
  let analysis = {
    topic: '',
    outline: '',
    multiSpeaker: false,
    mainSpeakerHint: '',
  };
  let structure = {
    sections: [],
    mustKeepIds: [],
    riskNotes: [],
  };
  let summaryText = '';
  let successfulChunks = 0;
  let failedChunks = 0;
  let firstChunkError = '';
  const steps = {
    probe: false,
    structure: false,
    mark: false,
    selfCheck: false,
  };

  try {
    const probeRaw = await callLlmProvider(config, buildTopicProbePrompt(units));
    const probeParsed = extractJsonObject(probeRaw);
    if (probeParsed) {
      analysis = { ...analysis, ...parseLlmAnalysis(probeParsed) };
      if (!summaryText && analysis.outline) {
        summaryText = analysis.outline;
      }
    }
    steps.probe = true;
  } catch {
    // ignore probe errors; continue with chunk-level marking
  }

  try {
    const structureRaw = await callLlmProvider(config, buildStructurePrompt(units, analysis));
    const structureParsed = extractJsonObject(structureRaw);
    if (structureParsed) {
      structure = parseLlmStructure(structureParsed, allUnitIdSet);
      steps.structure = true;
    }
  } catch {
    // ignore structure errors
  }

  for (const chunk of chunks) {
    const prompt = buildLlmPrompt(chunk, analysis);
    let raw = '';
    try {
      raw = await callLlmProvider(config, prompt);
      successfulChunks += 1;
    } catch (err) {
      failedChunks += 1;
      if (!firstChunkError) {
        firstChunkError = err.message || String(err);
      }
      continue;
    }
    const parsed = extractJsonObject(raw);
    const validIds = new Set(chunk.map((u) => u.id));
    const items = parsed
      ? parseLlmDeleteItems(parsed, validIds)
      : [];
    const fallbackTextItems = (!items.length)
      ? parseLlmDeleteItemsFromText(raw, validIds)
      : [];
    const mergedItems = items.length ? items : fallbackTextItems;
    const punctPlan = parsed
      ? parseLlmPunctuationPlan(parsed, validIds)
      : [];
    const parsedAnalysis = parsed
      ? parseLlmAnalysis(parsed)
      : { topic: '', outline: '', multiSpeaker: false, mainSpeakerHint: '' };
    if (!analysis.topic && parsedAnalysis.topic) analysis.topic = parsedAnalysis.topic;
    if (!analysis.outline && parsedAnalysis.outline) analysis.outline = parsedAnalysis.outline;
    if (!analysis.mainSpeakerHint && parsedAnalysis.mainSpeakerHint) analysis.mainSpeakerHint = parsedAnalysis.mainSpeakerHint;
    if (parsedAnalysis.multiSpeaker) analysis.multiSpeaker = true;

    for (const item of mergedItems) {
      const prev = selectedMap.get(item.id);
      if (!prev || item.confidence > prev.confidence) {
        selectedMap.set(item.id, item);
      }
    }
    for (const item of punctPlan) {
      const prev = punctuationByUnitId.get(item.id);
      if (!prev || (!prev.punct && item.punct) || (!prev.paragraphAfter && item.paragraphAfter)) {
        punctuationByUnitId.set(item.id, item);
      }
    }

    if (!summaryText && ((parsed && parsed.summary) || parsedAnalysis.outline)) {
      summaryText = String((parsed && parsed.summary) || parsedAnalysis.outline).trim().slice(0, 120);
    }
  }
  steps.mark = successfulChunks > 0;

  const rawCandidates = Array.from(selectedMap.values())
    .sort((a, b) => b.confidence - a.confidence);
  const unitById = new Map(units.map((u) => [u.id, u]));
  let selectedItems = rawCandidates
    .filter((item) => shouldKeepLlmDeleteCandidate(unitById.get(item.id), item));
  let confidenceFilteredCount = Math.max(0, rawCandidates.length - selectedItems.length);

  const maxAllowed = Math.min(120, Math.max(3, Math.floor(units.length * LLM_MAX_DELETE_RATIO)));
  if (!selectedItems.length && rawCandidates.length) {
    const recoverableCandidates = rawCandidates.filter((item) => {
      const unit = unitById.get(item.id);
      if (!unit) return false;
      if ((Number(item.confidence) || 0) < LLM_MIN_CONFIDENCE) return false;
      return !isProtectedSemanticText(unit.text);
    });
    const fallbackCount = Math.min(maxAllowed, Math.max(2, Math.ceil(recoverableCandidates.length * 0.18)));
    selectedItems = recoverableCandidates.slice(0, fallbackCount);
    confidenceFilteredCount = Math.max(0, rawCandidates.length - selectedItems.length);
  }
  const heuristicFallbackItems = (!selectedItems.length)
    ? buildHeuristicFallbackItems(units, maxAllowed)
    : [];
  let heuristicFallbackUsed = false;
  if (!selectedItems.length && heuristicFallbackItems.length) {
    selectedItems = heuristicFallbackItems.slice(0, maxAllowed);
    heuristicFallbackUsed = true;
  }
  if (selectedItems.length > maxAllowed) {
    selectedItems = selectedItems.slice(0, maxAllowed);
  }

  const hardKeepSet = new Set(structure.mustKeepIds || []);
  for (const u of units) {
    if (isInfoDenseTextForFallback(u.text)) {
      hardKeepSet.add(u.id);
    }
  }
  if (hardKeepSet.size) {
    selectedItems = selectedItems.filter((item) => !hardKeepSet.has(item.id));
  }

  const selfCheck = { restoreIds: [], extraDeleteIds: [], note: '' };
  const selfCheckIgnored = false;
  const selfCheckPrunedCount = 0;

  const chosenIdSet = new Set(selectedItems.map((item) => item.id));
  const rawIndices = [];
  const suggestions = [];
  const reasonById = new Map(selectedItems.map((item) => [item.id, item]));
  const punctuationByIndex = {};

  for (const id of chosenIdSet) {
    const unit = unitById.get(id);
    const meta = reasonById.get(id);
    if (!unit) continue;
    for (let i = unit.startIndex; i <= unit.endIndex; i += 1) {
      if (words[i] && !words[i].isGap) rawIndices.push(i);
    }
    suggestions.push({
      id: unit.id,
      start: unit.start,
      end: unit.end,
      text: unit.text,
      reasonType: meta?.reasonType || 'nonsense',
      reason: meta?.reason || reasonTypeToZh(meta?.reasonType),
      confidence: Number((meta?.confidence || 0.7).toFixed(2)),
      startIndex: unit.startIndex,
      endIndex: unit.endIndex,
    });
  }

  for (const [id, item] of punctuationByUnitId.entries()) {
    const unit = unitById.get(id);
    if (!unit) continue;
    const endIndex = Number(unit.endIndex);
    if (!Number.isInteger(endIndex) || endIndex < 0 || endIndex >= words.length) continue;
    punctuationByIndex[String(endIndex)] = {
      punct: item.punct || '',
      paragraphAfter: !!item.paragraphAfter,
    };
  }

  const normalized = normalizeSelectedIndices(words, rawIndices);
  if (successfulChunks === 0) {
    throw new Error(firstChunkError || 'LLM returned no usable chunk result');
  }
  return {
    indices: normalized.indices,
    suggestions,
    unitCount: units.length,
    selectedUnitCount: suggestions.length,
    chunkCount: chunks.length,
    successfulChunks,
    failedChunks,
    summary: summaryText,
    analysis,
    structure,
    punctuationByIndex,
    selfCheck,
    debug: {
      rawCandidateCount: rawCandidates.length,
      confidenceFilteredCount,
      finalSelectedUnitCount: suggestions.length,
      selfCheckPrunedCount,
      selfCheckIgnored,
      heuristicFallbackUsed,
      heuristicFallbackCount: heuristicFallbackItems.length,
      hardKeepCount: hardKeepSet.size,
      structureSectionCount: Array.isArray(structure.sections) ? structure.sections.length : 0,
      stepProbe: steps.probe,
      stepStructure: steps.structure,
      stepMark: steps.mark,
      stepSelfCheck: steps.selfCheck,
      minConfidence: LLM_MIN_CONFIDENCE,
    },
    addedBridgeGaps: normalized.addedBridgeGaps,
  };
}

function setCutJobState(patch) {
  currentCutJob = { ...currentCutJob, ...patch };
}

function appendCutLog(line) {
  const text = String(line || '').trim();
  if (!text) return;
  const next = [...currentCutJob.logTail, text];
  setCutJobState({ logTail: next.slice(-120) });
}

function createJobId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function streamProcessOutput(child, onLine) {
  const bind = (stream) => {
    if (!stream) return;
    let pending = '';
    stream.on('data', (chunk) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) onLine(line);
    });
    stream.on('end', () => {
      if (pending.trim()) onLine(pending.trim());
    });
  };

  bind(child.stdout);
  bind(child.stderr);
}

function getNodeRunner() {
  const extraEnv = {};
  if (process.env.ELECTRON_RUN_AS_NODE === '1') {
    extraEnv.ELECTRON_RUN_AS_NODE = '1';
  }

  return {
    command: process.execPath,
    extraEnv,
  };
}

function runCommandStreaming(command, args, phaseLabel, envPatch = {}) {
  return new Promise((resolve, reject) => {
    setCutJobState({ phase: phaseLabel });
    appendCutLog(`$ ${command} ${args.join(' ')}`);
    const runtimeLines = [];
    const trackLine = (line) => {
      appendCutLog(line);
      const text = String(line || '').trim();
      if (!text) return;
      runtimeLines.push(text);
      if (runtimeLines.length > 50) runtimeLines.shift();
    };

    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...envPatch },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    streamProcessOutput(child, trackLine);

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else {
        const hint = runtimeLines.length ? ` | ${runtimeLines.slice(-5).join(' | ')}` : '';
        reject(new Error(`${command} exited with code ${code}${hint}`));
      }
    });
  });
}

function runNodeScript(scriptPath, args, phaseLabel) {
  const runner = getNodeRunner();
  return runCommandStreaming(runner.command, [scriptPath, ...args], phaseLabel, runner.extraEnv);
}

function probeDuration(mediaPath) {
  try {
    const out = execSync(
      `${shellQuote(FFPROBE_BIN)} -v error -show_entries format=duration -of csv=p=0 ${shellQuote(fileArg(mediaPath))}`,
      { encoding: 'utf8' }
    ).trim();
    const num = Number(out);
    return Number.isFinite(num) ? num : NaN;
  } catch {
    return NaN;
  }
}

function normalizeMediaOverlays(overlays) {
  if (!Array.isArray(overlays)) return [];
  const allowedMotionEffects = new Set(['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down']);
  return overlays.map((item) => {
    const type = String(item?.type || '').toLowerCase() === 'video' ? 'video' : 'image';
    const filePath = String(item?.filePath || '').trim();
    const start = Number(item?.start);
    const rawEnd = Number(item?.end);
    const durationSec = clampDurationSec(
      item?.durationSec || item?.duration || (Number.isFinite(rawEnd) && Number.isFinite(start) ? rawEnd - start : 0),
      type === 'video' ? 3 : 5,
      type === 'video' ? 8 : 10,
      type === 'video' ? 5 : 7,
    );
    const end = Number.isFinite(start) ? start + durationSec : rawEnd;
    const motionEffect = type === 'image' && allowedMotionEffects.has(String(item?.motionEffect || ''))
      ? String(item.motionEffect)
      : 'none';
    if (!filePath || !fs.existsSync(filePath)) return null;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) return null;
    return {
      type,
      filePath: path.resolve(filePath),
      start,
      end,
      durationSec,
      title: String(item?.title || '').slice(0, 80),
      fit: String(item?.fit || 'cover').slice(0, 20),
      motionEffect,
    };
  }).filter(Boolean).slice(0, 50);
}

async function runCutJob(deleteList, mediaOverlays = []) {
  const runtimeInfo = getRuntimeInfo();
  fs.mkdirSync(runtimeInfo.cutOutputDir, { recursive: true });

  const baseName = path.parse(VIDEO_FILE).name;
  const outputFile = path.join(runtimeInfo.cutOutputDir, `${baseName}_cut.mp4`);
  const deleteFile = path.resolve('delete_segments.json');
  const overlayFile = path.resolve('media_overlays.json');
  fs.writeFileSync(deleteFile, JSON.stringify(deleteList, null, 2));
  const normalizedOverlays = normalizeMediaOverlays(mediaOverlays);
  fs.writeFileSync(overlayFile, JSON.stringify(normalizedOverlays, null, 2));

  appendCutLog(`Output directory: ${runtimeInfo.cutOutputDir}`);
  if (normalizedOverlays.length) {
    appendCutLog(`Media overlays: ${normalizedOverlays.length}`);
  }

  const cutScript = path.join(__dirname, 'cut_video.js');
  if (!fs.existsSync(cutScript)) {
    throw new Error(`cut_video.js not found: ${cutScript}`);
  }

  await runNodeScript(cutScript, [VIDEO_FILE, deleteFile, outputFile, overlayFile], 'cutting');
  setCutJobState({ phase: 'finalizing' });

  const originalDuration = probeDuration(VIDEO_FILE);
  const newDuration = probeDuration(outputFile);
  const deletedDuration = Number.isFinite(originalDuration) && Number.isFinite(newDuration)
    ? Math.max(0, originalDuration - newDuration)
    : NaN;
  const savedPercent = Number.isFinite(originalDuration) && originalDuration > 0 && Number.isFinite(deletedDuration)
    ? ((deletedDuration / originalDuration) * 100).toFixed(1)
    : '';

  return {
    success: true,
    output: path.resolve(outputFile),
    outputDir: runtimeInfo.cutOutputDir,
    originalDuration: Number.isFinite(originalDuration) ? originalDuration.toFixed(2) : '',
    newDuration: Number.isFinite(newDuration) ? newDuration.toFixed(2) : '',
    deletedDuration: Number.isFinite(deletedDuration) ? deletedDuration.toFixed(2) : '',
    savedPercent,
    message: `Cut finished: ${outputFile}`,
  };
}

function writeJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sanitizeReviewMediaItems(items, kind) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const start = Number(item?.start);
    const end = Number(item?.end);
    const safeStart = Number.isFinite(start) && start >= 0 ? start : 0;
    const durationSec = clampDurationSec(
      item?.durationSec || item?.duration || (Number.isFinite(end) && Number.isFinite(start) ? end - start : 0),
      kind === 'video' ? 3 : 5,
      kind === 'video' ? 8 : 10,
      kind === 'video' ? 5 : 7,
    );
    const assetKey = kind === 'video' ? 'video' : 'image';
    const asset = item?.[assetKey] && typeof item[assetKey] === 'object' ? item[assetKey] : null;
    const sanitizedAsset = asset ? {
      fileName: String(asset.fileName || '').slice(0, 160),
      filePath: String(asset.filePath || '').slice(0, 500),
      url: String(asset.url || '').slice(0, 500),
      model: String(asset.model || '').slice(0, 80),
      size: String(asset.size || '').slice(0, 40),
      sourceUrl: String(asset.sourceUrl || '').slice(0, 500),
      videoId: String(asset.videoId || '').slice(0, 120),
    } : null;
    const rawStatus = String(item?.status || '');
    const hasGeneratedAsset = !!(sanitizedAsset && (sanitizedAsset.url || sanitizedAsset.filePath || sanitizedAsset.fileName));
    const status = rawStatus === 'generating' && !hasGeneratedAsset
      ? 'queued'
      : (['queued', 'generating', 'done', 'error'].includes(rawStatus) ? rawStatus : '');
    const error = rawStatus === 'generating' && !hasGeneratedAsset
      ? '?????????????'
      : String(item?.error || '').slice(0, 500);
    return {
      id: String(item?.id || '').replace(/[^\w-]/g, '_').slice(0, 48),
      type: kind,
      timeRange: String(item?.timeRange || '').slice(0, 40),
      start: safeStart,
      end: safeStart + durationSec,
      durationSec,
      aspectRatio: String(item?.aspectRatio || '').slice(0, 20),
      motionEffect: String(item?.motionEffect || '').slice(0, 20),
      title: String(item?.title || '').slice(0, 80),
      purpose: String(item?.purpose || '').slice(0, 80),
      textBasis: String(item?.textBasis || '').slice(0, 140),
      directorIntent: String(item?.directorIntent || '').slice(0, 200),
      sceneStory: String(item?.sceneStory || '').slice(0, 360),
      camera: String(item?.camera || '').slice(0, 220),
      prompt: String(item?.prompt || '').slice(0, 1600),
      videoPrompt: String(item?.videoPrompt || '').slice(0, 1600),
      negativePrompt: String(item?.negativePrompt || '').slice(0, 500),
      status,
      error,
      [assetKey]: sanitizedAsset,
    };
  }).filter((item) => item.id || item.prompt || item.videoPrompt || item[`${kind}`]).slice(0, 80);
}

function sanitizeReviewVisualReference(input) {
  if (!input || typeof input !== 'object') {
    return { enabled: true, status: 'empty', prompt: '', negativePrompt: '', image: null, assets: [] };
  }
  const assets = Array.isArray(input.assets)
    ? input.assets.map((asset, index) => {
      const normalized = normalizeVisualReferenceAsset(asset, index, '', {});
      const image = asset?.image && typeof asset.image === 'object' ? {
        fileName: String(asset.image.fileName || '').slice(0, 160),
        filePath: String(asset.image.filePath || '').slice(0, 500),
        url: String(asset.image.url || '').slice(0, 500),
        model: String(asset.image.model || '').slice(0, 80),
        size: String(asset.image.size || '').slice(0, 40),
      } : null;
      return { ...normalized, image };
    }).slice(0, 8)
    : [];
  const legacyImage = input.image && typeof input.image === 'object' ? {
    fileName: String(input.image.fileName || '').slice(0, 160),
    filePath: String(input.image.filePath || '').slice(0, 500),
    url: String(input.image.url || '').slice(0, 500),
    model: String(input.image.model || '').slice(0, 80),
    size: String(input.image.size || '').slice(0, 40),
  } : null;
  const nextAssets = assets.length || !legacyImage
    ? assets
    : [{
      id: 'legacy_reference_01',
      type: 'character',
      title: 'Legacy reference image',
      prompt: String(input.prompt || '').slice(0, 1200),
      negativePrompt: String(input.negativePrompt || '').slice(0, 500),
      source: 'legacy',
      image: legacyImage,
    }];
  return {
    enabled: input.enabled !== false,
    status: String(input.status || (nextAssets.length ? 'done' : 'empty')).slice(0, 32),
    title: String(input.title || '').slice(0, 80),
    prompt: String(input.prompt || nextAssets.map((asset) => asset.prompt).filter(Boolean).join('\n\n')).slice(0, 1600),
    negativePrompt: String(input.negativePrompt || '').slice(0, 500),
    source: String(input.source || '').slice(0, 32),
    image: legacyImage || nextAssets.find((asset) => asset.image?.url || asset.image?.filePath)?.image || null,
    assets: nextAssets,
  };
}

function normalizeReviewStatePayload(payload) {
  const selectedIndices = Array.isArray(payload?.selectedIndices)
    ? payload.selectedIndices
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v >= 0)
    : [];
  const llmSuggestedIndices = Array.isArray(payload?.llmSuggestedIndices)
    ? payload.llmSuggestedIndices
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v >= 0)
    : [];
  const llmParagraphAfterIndices = Array.isArray(payload?.llmParagraphAfterIndices)
    ? payload.llmParagraphAfterIndices
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v >= 0)
    : [];

  const llmReasons = {};
  if (payload?.llmReasons && typeof payload.llmReasons === 'object') {
    for (const [key, value] of Object.entries(payload.llmReasons)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0) continue;
      const text = String(value || '').trim().slice(0, 200);
      if (!text) continue;
      llmReasons[String(idx)] = text;
    }
  }
  const llmPunctuation = {};
  if (payload?.llmPunctuation && typeof payload.llmPunctuation === 'object') {
    for (const [key, value] of Object.entries(payload.llmPunctuation)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0) continue;
      const punct = String(value || '').trim();
      if (/[，。！？；：]/.test(punct)) {
        llmPunctuation[String(idx)] = punct[0];
      }
    }
  }
  const textOverrides = {};
  if (payload?.textOverrides && typeof payload.textOverrides === 'object') {
    for (const [key, value] of Object.entries(payload.textOverrides)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0) continue;
      const text = String(value ?? '').trim().slice(0, 80);
      if (text) textOverrides[String(idx)] = text;
    }
  }

  const threshold = Number(payload?.threshold);
  const currentTime = Number(payload?.currentTimeSec);
  const version = Number(payload?.version);
  const cutPrecisionModeRaw = String(payload?.cutPrecisionMode || 'standard');
  const cutPrecisionMode = ['conservative', 'standard', 'clean'].includes(cutPrecisionModeRaw)
    ? cutPrecisionModeRaw
    : 'standard';

  return {
    version: Number.isInteger(version) && version > 0 ? version : 1,
    savedAt: new Date().toISOString(),
    selectedIndices: Array.from(new Set(selectedIndices)).sort((a, b) => a - b),
    llmSuggestedIndices: Array.from(new Set(llmSuggestedIndices)).sort((a, b) => a - b),
    llmReasons,
    llmPunctuation,
    textOverrides,
    llmParagraphAfterIndices: Array.from(new Set(llmParagraphAfterIndices)).sort((a, b) => a - b),
    llmTopic: String(payload?.llmTopic || '').trim().slice(0, 80),
    llmOutline: String(payload?.llmOutline || '').trim().slice(0, 120),
    llmMultiSpeaker: !!payload?.llmMultiSpeaker,
    threshold: Number.isFinite(threshold) && threshold >= 0.2 ? threshold : 0.2,
    boundarySettings: normalizeBoundarySettings(payload?.boundarySettings),
    cutPrecisionMode,
    currentTimeSec: Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0,
    mediaAssets: {
      images: sanitizeReviewMediaItems(payload?.mediaAssets?.images || payload?.imageItems, 'image'),
      videos: sanitizeReviewMediaItems(payload?.mediaAssets?.videos || payload?.videoItems, 'video'),
      visualReference: sanitizeReviewVisualReference(payload?.mediaAssets?.visualReference || payload?.visualReference),
    },
  };
}

function readReviewState() {
  if (!fs.existsSync(REVIEW_STATE_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(REVIEW_STATE_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return normalizeReviewStatePayload(parsed);
  } catch {
    return null;
  }
}

function writeReviewState(payload) {
  const normalized = normalizeReviewStatePayload(payload);
  const tmp = `${REVIEW_STATE_FILE}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, REVIEW_STATE_FILE);
  return normalized;
}

function writeReviewStateBackup(payload, backupFile = REVIEW_STATE_BACKUP_FILE) {
  const normalized = normalizeReviewStatePayload(payload || readReviewState() || {});
  const tmp = `${backupFile}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, backupFile);
  return normalized;
}

function getCutPreflight(deleteCount = 0) {
  const runtimeInfo = getRuntimeInfo();
  const issues = [];
  const videoExists = !!(VIDEO_FILE && fs.existsSync(VIDEO_FILE));
  if (!videoExists) {
    issues.push({ code: 'missing_video', message: `原视频文件不存在：${VIDEO_FILE || '-'}` });
  }
  try {
    fs.mkdirSync(runtimeInfo.cutOutputDir, { recursive: true });
    fs.accessSync(runtimeInfo.cutOutputDir, fs.constants.W_OK);
  } catch (err) {
    issues.push({ code: 'output_not_writable', message: `输出目录不可写：${runtimeInfo.cutOutputDir}（${err.message}）` });
  }
  if (!Number.isFinite(Number(deleteCount)) || Number(deleteCount) <= 0) {
    issues.push({ code: 'empty_delete_list', message: '没有可裁剪的删除片段。' });
  }
  return {
    ok: issues.length === 0,
    issues,
    videoExists,
    cutOutputDir: runtimeInfo.cutOutputDir,
    deleteCount: Math.max(0, Number(deleteCount) || 0),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 30 * 1024 * 1024) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function resolveStaticPath(urlPathname) {
  const decoded = decodeURIComponent(urlPathname || '/');
  const requestPath = decoded === '/' ? '/review.html' : decoded;
  const resolved = path.resolve(process.cwd(), `.${requestPath}`);
  const root = path.resolve(process.cwd());

  if (!resolved.startsWith(root)) {
    throw new Error('Forbidden path');
  }

  return resolved;
}

function getReviewHtmlCompatibilityPatch() {
  return '<script id="jaygo-compat-build-time-mapper">\n'
    + '(function(){\n'
    + '  if (typeof window.buildTimeMapper !== "function") {\n'
    + '    window.buildTimeMapper = function(deleteSegments) {\n'
    + '      var source = Array.isArray(deleteSegments) ? deleteSegments : [];\n'
    + '      var segments = source.map(function(seg){ return { start: Number(seg && seg.start), end: Number(seg && seg.end) }; })\n'
    + '        .filter(function(seg){ return Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start; })\n'
    + '        .sort(function(a,b){ return (a.start - b.start) || (a.end - b.end); });\n'
    + '      var merged = [];\n'
    + '      segments.forEach(function(seg){\n'
    + '        var last = merged[merged.length - 1];\n'
    + '        if (last && seg.start <= last.end + 0.001) last.end = Math.max(last.end, seg.end);\n'
    + '        else merged.push({ start: seg.start, end: seg.end });\n'
    + '      });\n'
    + '      return function(time) {\n'
    + '        var value = Math.max(0, Number(time) || 0);\n'
    + '        var removed = 0;\n'
    + '        for (var i = 0; i < merged.length; i += 1) {\n'
    + '          var seg = merged[i];\n'
    + '          if (value >= seg.end) removed += seg.end - seg.start;\n'
    + '          else if (value > seg.start) { removed += value - seg.start; break; }\n'
    + '          else break;\n'
    + '        }\n'
    + '        return Math.max(0, Number((value - removed).toFixed(3)));\n'
    + '      };\n'
    + '    };\n'
    + '  }\n'
    + '}());\n'
    + '</script>\n';
}

function injectReviewHtmlCompatibility(html) {
  const body = String(html || '');
  if (!body.includes('buildExportCues') || body.includes('function buildTimeMapper') || body.includes('jaygo-compat-build-time-mapper')) {
    return body;
  }
  const patch = getReviewHtmlCompatibilityPatch();
  if (body.includes('</body>')) return body.replace('</body>', patch + '</body>');
  return body + patch;
}

function serveFile(req, res, absolutePath) {
  if (!fs.existsSync(absolutePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const stat = fs.statSync(absolutePath);
  const ext = path.extname(absolutePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  if (ext === '.html') {
    const html = injectReviewHtmlCompatibility(fs.readFileSync(absolutePath, 'utf8'));
    const buffer = Buffer.from(html, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buffer.length,
      'Accept-Ranges': 'none',
      'Cache-Control': 'no-store',
    });
    res.end(buffer);
    return;
  }

  if (req.headers.range && (ext === '.mp3' || ext === '.m4a' || ext === '.wav' || ext === '.mp4')) {
    const [startRaw, endRaw] = String(req.headers.range).replace('bytes=', '').split('-');
    const start = Number(startRaw);
    const end = endRaw ? Number(endRaw) : stat.size - 1;

    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= stat.size || start > end) {
      res.writeHead(416);
      res.end();
      return;
    }

    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Cache-Control': 'no-store',
    });

    fs.createReadStream(absolutePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(absolutePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const allowedOrigins = new Set([
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
  ]);
  const origin = String(req.headers.origin || '');
  if (allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const requestUrl = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = requestUrl.pathname;

    if (req.method === 'GET' && pathname === '/api/runtime-info') {
      writeJson(res, 200, { success: true, ...getRuntimeInfo() });
      return;
    }

    if (req.method === 'GET' && pathname === '/source-video') {
      if (!VIDEO_FILE || !fs.existsSync(VIDEO_FILE)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Source video not found');
        return;
      }
      serveFile(req, res, VIDEO_FILE);
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/image_assets/')) {
      const relative = decodeURIComponent(pathname.replace(/^\/image_assets\/+/, ''));
      const resolved = path.resolve(IMAGE_ASSET_DIR, relative);
      if (!resolved.startsWith(path.resolve(IMAGE_ASSET_DIR))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      serveFile(req, res, resolved);
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/video_assets/')) {
      const relative = decodeURIComponent(pathname.replace(/^\/video_assets\/+/, ''));
      const resolved = path.resolve(VIDEO_ASSET_DIR, relative);
      if (!resolved.startsWith(path.resolve(VIDEO_ASSET_DIR))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      serveFile(req, res, resolved);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/cut-status') {
      const jobId = requestUrl.searchParams.get('jobId');
      const isCurrent = !jobId || currentCutJob.jobId === jobId;
      writeJson(res, 200, {
        success: true,
        ...(isCurrent ? currentCutJob : { state: 'not_found', jobId }),
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/review-state') {
      const state = readReviewState();
      writeJson(res, 200, { success: true, state });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/review-state') {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const state = writeReviewState(payload);
      writeJson(res, 200, { success: true, state });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/review-state/backup') {
      const body = await readBody(req);
      const payload = body ? JSON.parse(body || '{}') : readReviewState();
      const state = writeReviewStateBackup(payload);
      writeJson(res, 200, { success: true, state, output: REVIEW_STATE_BACKUP_FILE });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/cut-preflight') {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const deleteCount = Array.isArray(payload?.segments) ? payload.segments.length : Number(payload?.deleteCount || 0);
      writeJson(res, 200, { success: true, ...getCutPreflight(deleteCount) });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/show-notes') {
      const candidates = ['show_notes.md', '视频介绍草稿.md'];
      const found = candidates.find((name) => fs.existsSync(path.resolve(process.cwd(), name)));
      if (!found) {
        writeJson(res, 404, { success: false, error: 'No show notes file found in current directory' });
        return;
      }
      const text = fs.readFileSync(path.resolve(process.cwd(), found), 'utf8');
      writeJson(res, 200, { success: true, output: found, text });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/show-notes') {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const text = String(payload.text || '').trim();
      if (!text) throw new Error('show notes content is empty');
      fs.writeFileSync(path.resolve(process.cwd(), 'show_notes.md'), text, 'utf8');
      writeJson(res, 200, { success: true, output: 'show_notes.md' });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/llm-mark') {
      const config = getLlmConfig();
      if (!config.ready) {
        throw new Error(`LLM 配置不完整：缺少 ${config.missing.join(', ')}`);
      }

      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const words = Array.isArray(payload.words) ? payload.words : [];
      if (!words.length) {
        throw new Error('words 为空，无法执行 LLM 标记');
      }
      if (words.length > 50000) {
        throw new Error('转录数据过大，请先裁剪后再执行 LLM 标记');
      }

      appendCutLog(`LLM 标记开始：provider=${config.provider}, model=${config.model}, words=${words.length}`);
      const result = await runLlmMarking(words, config);
      appendCutLog(`LLM 标记完成：建议 ${result.selectedUnitCount} 段，索引 ${result.indices.length} 个`);

      writeJson(res, 200, {
        success: true,
        ...result,
        llm: {
          provider: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
          temperature: config.temperature,
        },
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/llm-publish-suggestions') {
      const config = getLlmConfig();
      if (!config.ready) {
        throw new Error(`LLM 配置不完整：缺少 ${config.missing.join(', ')}`);
      }

      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const words = Array.isArray(payload.words) ? payload.words : [];
      const style = String(payload.style || '').trim();
      const analysis = sanitizeAnalysisInput(payload.analysis);

      if (!words.length) {
        throw new Error('words 为空，无法生成发布建议');
      }
      if (words.length > 50000) {
        throw new Error('转录数据过大，请先裁剪后再生成发布建议');
      }

      appendCutLog(`发布建议生成开始：provider=${config.provider}, model=${config.model}, words=${words.length}`);
      const result = await runLlmPublishSuggestions(words, config, style, analysis);
      appendCutLog(`发布建议生成完成：标题 ${result.titles.length} 条，简介 ${result.descriptions.length} 条`);
      writeJson(res, 200, { success: true, ...result });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/llm-chat-adjust') {
      const config = getLlmConfig();
      if (!config.ready) {
        throw new Error(`LLM 配置不完整：缺少 ${config.missing.join(', ')}`);
      }

      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const words = Array.isArray(payload.words) ? payload.words : [];
      const selectedIndices = Array.isArray(payload.selectedIndices) ? payload.selectedIndices : [];
      const message = String(payload.message || '').trim();
      const history = Array.isArray(payload.history) ? payload.history : [];
      const analysis = sanitizeAnalysisInput(payload.analysis);
      const mediaPayload = payload.mediaAssets && typeof payload.mediaAssets === 'object' ? payload.mediaAssets : {};
      const mediaAssets = {
        images: sanitizeReviewMediaItems(mediaPayload.images || payload.imageItems, 'image'),
        videos: sanitizeReviewMediaItems(mediaPayload.videos || payload.videoItems, 'video'),
      };

      if (!words.length) {
        throw new Error('words 为空，无法执行对话调标记');
      }
      if (!message) {
        throw new Error('请输入调标记要求');
      }

      appendCutLog(`LLM 对话调标记开始：provider=${config.provider}, model=${config.model}`);
      const result = await runLlmChatAdjust(words, config, selectedIndices, message, history, analysis, mediaAssets);
      appendCutLog(`LLM 对话调标记完成：新增 ${result.addIds.length} 段，取消 ${result.removeIds.length} 段`);
      writeJson(res, 200, { success: true, ...result });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/llm-visual-reference') {
      const config = getLlmConfig();
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const words = Array.isArray(payload.words) ? payload.words : [];
      if (!words.length) {
        throw new Error('words is empty, cannot plan visual reference assets');
      }
      if (words.length > 50000) {
        throw new Error('Transcript is too large; please cut or shorten before planning visual reference assets');
      }
      appendCutLog(`Visual reference planning started: provider=${config.provider || 'fallback'}, model=${config.model || '-'}`);
      const result = await runLlmVisualReferencePlan(words, config, payload);
      appendCutLog(`Visual reference planning completed: ${(result.visualReference?.assets || []).length} assets`);
      writeJson(res, 200, { success: true, ...result });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/llm-image-plan') {
      const config = getLlmConfig();
      if (!config.ready) {
        throw new Error(`LLM 配置不完整：缺少 ${config.missing.join(', ')}`);
      }

      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const words = Array.isArray(payload.words) ? payload.words : [];
      if (!words.length) {
        throw new Error('words 为空，无法生成视频配图方案');
      }
      if (words.length > 50000) {
        throw new Error('转录数据过大，请先裁剪后再生成视频配图');
      }
      appendCutLog(`视频配图方案生成开始：provider=${config.provider}, model=${config.model}, words=${words.length}`);
      const result = await runLlmImagePlan(words, config, payload);
      appendCutLog(`视频配图方案生成完成：${result.items.length} 个配图点`);
      writeJson(res, 200, { success: true, ...result });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/generate-image') {
      const llmConfig = getLlmConfig();
      const imageConfig = getImageConfig();
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const item = payload.item && typeof payload.item === 'object' ? payload.item : {};
      const retry = !!payload.retry;
      if (payload.imageSize || payload.aspectRatio) {
        imageConfig.size = normalizeImageSize(payload.imageSize || payload.aspectRatio);
      }
      let nextItem = {
        ...item,
        referenceImage: payload.referenceImage || item.referenceImage || item.visualReference || null,
      };
      if (retry && llmConfig.ready) {
        const rewritten = await rewriteImagePromptWithLlm(llmConfig, item, payload.note);
        if (rewritten && typeof rewritten === 'object') {
          nextItem = {
            ...nextItem,
            prompt: rewritten.prompt || nextItem.prompt,
            negativePrompt: rewritten.negativePrompt || nextItem.negativePrompt,
          };
        }
      }
      appendCutLog(`图片生成开始：${String(nextItem.title || nextItem.id || 'image')}`);
      const saved = await callImageGenerationApi(imageConfig, nextItem);
      appendCutLog(`图片生成完成：${saved.fileName}`);
      writeJson(res, 200, {
        success: true,
        item: nextItem,
        image: {
          ...saved,
          model: imageConfig.model,
          size: imageConfig.size,
        },
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/import-image') {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const item = payload.item && typeof payload.item === 'object' ? payload.item : {};
      const filename = String(payload.filename || item.id || 'local-image');
      const dataUrl = String(payload.dataUrl || '');
      const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i);
      if (!match) {
        throw new Error('Invalid image data. Please upload a png, jpg, webp, or gif image.');
      }
      const buffer = Buffer.from(match[2], 'base64');
      if (!buffer.length || buffer.length > 20 * 1024 * 1024) {
        throw new Error('Image file is empty or larger than 20MB.');
      }
      const ext = imageExtFromContentType(match[1]);
      const saved = await saveImageBuffer(buffer, item.id || path.basename(filename, path.extname(filename)) || 'local-image', ext);
      const nextItem = {
        ...item,
        source: 'local-upload',
        prompt: item.prompt || `Local uploaded image: ${filename}`,
      };
      appendCutLog(`Local image imported: ${saved.fileName}`);
      writeJson(res, 200, {
        success: true,
        item: nextItem,
        image: {
          ...saved,
          model: 'local-upload',
          size: normalizeImageSize(payload.aspectRatio || item.aspectRatio || '16:9'),
          sourceFileName: filename,
        },
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/llm-video-plan') {
      const config = getLlmConfig();
      if (!config.ready) {
        throw new Error(`LLM 配置不完整：缺少 ${config.missing.join(', ')}`);
      }

      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const words = Array.isArray(payload.words) ? payload.words : [];
      if (!words.length) {
        throw new Error('words is empty, cannot plan video materials');
      }
      if (words.length > 50000) {
        throw new Error('Transcript is too large; please cut or shorten before planning video materials');
      }
      appendCutLog(`Video material plan started: provider=${config.provider}, model=${config.model}, words=${words.length}`);
      const result = await runLlmVideoPlan(words, config, payload);
      appendCutLog(`Video material plan completed: ${result.items.length} points`);
      writeJson(res, 200, { success: true, ...result });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/generate-video') {
      const videoConfig = getVideoConfig();
      const llmConfig = getLlmConfig();
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const item = payload.item && typeof payload.item === 'object' ? payload.item : {};
      const retry = !!payload.retry;
      let nextItem = {
        ...item,
        referenceImage: payload.referenceImage || item.referenceImage || item.visualReference || null,
      };
      if (retry && llmConfig.ready) {
        const rewritten = await rewriteImagePromptWithLlm(llmConfig, {
          ...item,
          prompt: item.videoPrompt || item.prompt || '',
        }, payload.note);
        if (rewritten && typeof rewritten === 'object') {
          nextItem = {
            ...nextItem,
            videoPrompt: rewritten.prompt || nextItem.videoPrompt || nextItem.prompt,
            prompt: rewritten.prompt || nextItem.prompt,
            negativePrompt: rewritten.negativePrompt || nextItem.negativePrompt,
          };
        }
      }
      appendCutLog(`Video material generation started: ${String(nextItem.title || nextItem.id || 'video')}`);
      const saved = await callVideoGenerationApi(videoConfig, nextItem, {
        aspectRatio: payload.aspectRatio || nextItem.aspectRatio,
        durationSec: payload.durationSec || nextItem.durationSec,
        numFrames: payload.numFrames || nextItem.numFrames,
        frameRate: payload.frameRate || nextItem.frameRate,
        referenceImage: payload.referenceImage || nextItem.referenceImage,
      });
      appendCutLog(`Video material generation completed: ${saved.fileName}`);
      writeJson(res, 200, {
        success: true,
        item: nextItem,
        video: saved,
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/jianying-draft-targets') {
      const configuredRoot = getConfiguredJianyingDraftRoot();
      const configuredTemplates = getConfiguredJianyingTemplates().map((dir, index) => ({
        name: `模板${index + 1}: ${path.basename(dir) || dir}`,
        path: dir,
        modified: 0,
        modifiedText: '',
        source: 'settings',
      }));
      const roots = findJianyingDraftRoots(configuredRoot ? [configuredRoot] : []);
      const detectedRoot = roots[0]?.path || '';
      const autoDrafts = detectedRoot ? listJianyingDrafts(detectedRoot).slice(0, 80) : [];
      const seenDrafts = new Set();
      const drafts = [...configuredTemplates, ...autoDrafts]
        .filter((item) => {
          const key = String(item.path || '').toLowerCase();
          if (!key || seenDrafts.has(key)) return false;
          seenDrafts.add(key);
          return true;
        })
        .slice(0, 80);
      writeJson(res, 200, {
        success: true,
        detectedRoot,
        configuredRoot,
        configuredTemplates,
        roots,
        drafts,
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/export-jianying-draft') {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const result = writeJianyingDraftExport(payload);
      appendCutLog(`Jianying draft exported: ${result.draftDir}${result.autoPlaced ? ' (auto placed)' : ''}${result.fallbackUsed ? ` (fallback: ${result.fallbackReason})` : ''}`);
      writeJson(res, 200, { success: true, ...result });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/cut') {
      if (!fs.existsSync(VIDEO_FILE)) {
        throw new Error(`原视频文件不存在，无法执行裁剪：${VIDEO_FILE || '-'}`);
      }
      if (currentCutJob.state === 'running') {
        writeJson(res, 202, {
          success: true,
          existingRunning: true,
          jobId: currentCutJob.jobId,
          state: 'running',
          message: 'A cut task is already running',
        });
        return;
      }

      const body = await readBody(req);
      const payload = JSON.parse(body || '[]');
      const deleteList = Array.isArray(payload) ? payload : payload.segments;
      const mediaOverlays = Array.isArray(payload?.overlays) ? payload.overlays : [];
      if (!Array.isArray(deleteList)) throw new Error('delete list must be an array');

      const normalized = deleteList.map((seg) => ({
        start: Number(seg.start),
        end: Number(seg.end),
      })).filter((seg) => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start && seg.start >= 0);

      if (!normalized.length) {
        throw new Error('delete list is empty');
      }

      const jobId = createJobId();
      setCutJobState({
        jobId,
        state: 'running',
        phase: 'queued',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        segmentsCount: normalized.length,
        logTail: [`Queued ${normalized.length} delete segments, ${mediaOverlays.length} media overlays.`],
        result: null,
        error: '',
      });

      (async () => {
        try {
          const result = await runCutJob(normalized, mediaOverlays);
          appendCutLog('Cut task completed.');
          setCutJobState({
            state: 'completed',
            phase: 'completed',
            finishedAt: new Date().toISOString(),
            result,
          });
        } catch (err) {
          appendCutLog(`Cut task failed: ${err.message}`);
          setCutJobState({
            state: 'failed',
            phase: 'failed',
            finishedAt: new Date().toISOString(),
            error: err.message,
          });
        }
      })();

      writeJson(res, 202, {
        success: true,
        jobId,
        state: 'running',
        message: 'Cut task started',
      });
      return;
    }

    const staticPath = resolveStaticPath(pathname);
    serveFile(req, res, staticPath);
  } catch (err) {
    console.error('review_server request error:', err.stack || err.message);
    writeJson(res, 500, { success: false, error: err.message || 'internal error' });
  }
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err.stack || err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});

if (process.env.JAYGO_CUT_TEST_EXPORTS === '1') {
  module.exports = {
    buildImagePlanPrompt,
    buildVideoPlanPrompt,
    formatExistingRangesForPrompt,
    sanitizeImagePlanItems,
    sanitizeVideoPlanItems,
    buildFallbackImagePlan,
    buildFallbackVideoPlan,
    hasDirectTranscriptCopy,
    hasDirectorVisualLanguage,
    normalizeMediaOverlays,
    getVideoConfig,
    imageSizeToMiniMaxAspectRatio,
    imageSizeToOpenAiSize,
    imageSizeToAgnesSize,
    videoDurationToGenerationParams,
    autoImageCountForUnits,
    autoVideoCountForUnits,
    pickWordsForVisualPlan,
    sanitizeVisualReferencePlan,
    buildFallbackVisualReferencePlan,
    resolveReferenceImageInput,
    resolveReferenceImageInputs,
    buildLlmPrompt,
    buildChatAdjustPrompt,
    buildJianyingFullDraftSpec,
    resolveMediaFilePathFromAsset,
    findJianyingDraftRoots,
    listJianyingDrafts,
    resolveJianyingExportTarget,
    writeJianyingFullDraft,
    writeJianyingDraftExport,
    writeJianyingDraft,
    writeReviewStateBackup,
    getCutPreflight,
    replaceTextContent,
  };
} else {
  server.listen(PORT, '127.0.0.1', () => {
    const runtimeInfo = getRuntimeInfo();
    console.log('');
    console.log('Review server started');
    console.log(`URL: http://localhost:${PORT}`);
    console.log(`Video: ${VIDEO_FILE}`);
    console.log(`Output directory: ${runtimeInfo.cutOutputDir}`);
    console.log(`Output source: ${runtimeInfo.outputSourceText}`);
    if (OUTPUT_ROOT_ARG) {
      console.log(`Output argument: ${path.resolve(OUTPUT_ROOT_ARG)}`);
    }
    console.log('');
  });
}
