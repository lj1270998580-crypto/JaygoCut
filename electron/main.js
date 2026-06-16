const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const {
  annotateHistoryEntry,
  buildHistoryReviewResumePlan,
  findFirstExistingDir: findFirstExistingDirShared,
  findReviewDirUnder: findReviewDirUnderShared,
  relinkHistoryVideo,
  resolveHistoryReviewDir: resolveHistoryReviewDirShared,
  resolveHistoryVideoPath: resolveHistoryVideoPathShared,
} = require('./history_utils');
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  autoUpdater = null;
}

const REPO_ROOT = path.resolve(__dirname, '..');
const APP_NAME = 'Jaygo Cut';
const APP_ID = 'com.jaygo.cut';
const CLIP_DIR_NAME = 'talkcut';
const CLIP_TRANSCRIBE_DIR = '1_transcribe';
const CLIP_ANALYSIS_DIR = '2_analysis';
const CLIP_REVIEW_DIR = '3_review';

const SCRIPTS_DIR = path.join(REPO_ROOT, CLIP_DIR_NAME, 'scripts');
const AUTO_SELECT_SCRIPT = path.join(SCRIPTS_DIR, 'auto_select_silence.js');
const APP_ICON_PNG = path.join(REPO_ROOT, 'electron', 'assets', 'app-icon.png');
const APP_ICON_ICO = path.join(REPO_ROOT, 'electron', 'assets', 'app-icon.ico');
const BIN_DIR = path.join(REPO_ROOT, 'electron', 'bin');
const MODELS_DIR = path.join(REPO_ROOT, 'electron', 'models');
const WHISPER_MODEL_FILES = {
  standard: 'ggml-base.bin',
  high: 'ggml-large-v3-turbo.bin',
};
const DEFAULT_LOCAL_WHISPER_MODEL = 'high';
const WHISPER_MODEL_DOWNLOADS = {
  models: {
    standard: {
      file: 'ggml-base.bin',
      size: 147951465,
      sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
      urls: [
        'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
        'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
      ],
    },
    high: {
      file: 'ggml-large-v3-turbo.bin',
      size: 1624555275,
      sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
      urls: [
        'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
        'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
      ],
    },
  },
};
const UPDATE_FEED_URL = 'https://ailabing.cn/downloads/jaygo/';
const QWEN_ASR_MODEL = 'qwen3-asr-flash-filetrans';
const MIMO_ASR_MODEL = 'mimo-v2.5-asr';
const MIMO_ASR_BASE_URL = 'https://api.xiaomimimo.com/v1';
const QWEN_ASR_TEST_AUDIO_URL = 'https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/paraformer/hello_world.wav';
const VOLCENGINE_ASR_TEST_AUDIO_URL = QWEN_ASR_TEST_AUDIO_URL;
const MIMO_ASR_TEST_AUDIO_URL = QWEN_ASR_TEST_AUDIO_URL;
const EXPORT_QUALITY_PRESETS = {
  preview: { label: '\u5feb\u901f\u9884\u89c8', crf: 23, preset: 'veryfast', audioBitrate: '160k' },
  standard: { label: '\u6807\u51c6\u9ad8\u8d28\u91cf', crf: 18, preset: 'fast', audioBitrate: '192k' },
  high: { label: '\u66f4\u9ad8\u753b\u8d28', crf: 16, preset: 'slow', audioBitrate: '192k' },
  ultra: { label: '\u6781\u81f4\u753b\u8d28', crf: 14, preset: 'slow', audioBitrate: '256k' },
};
const DEFAULT_EXPORT_QUALITY = 'ultra';
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
const DEFAULT_OUTPUT_ROOT = app.isPackaged
  ? path.join(os.homedir(), 'Documents', 'Jaygo Cut Output')
  : path.join(REPO_ROOT, 'output');
const AGNES_API_BASE_URL = 'https://apihub.agnes-ai.com/v1';
const AGNES_IMAGE_MODEL = 'agnes-image-2.1-flash';
const AGNES_VIDEO_MODEL = 'agnes-video-v2.0';

const DEFAULT_SETTINGS = {
  asrEngine: 'volcengine',
  volcengineApiKey: '',
  dashscopeApiKey: '',
  mimoApiKey: '',
  outputRoot: DEFAULT_OUTPUT_ROOT,
  silenceThresholdSec: 0.2,
  exportQuality: DEFAULT_EXPORT_QUALITY,
  exportQualityMigratedToUltra: false,
  lastVideoPath: '',
  localWhisperModel: DEFAULT_LOCAL_WHISPER_MODEL,
  localWhisperModelPath: '',
  themeMode: 'light',
  llmProvider: 'openai',
  llmApiBaseUrl: 'https://api.openai.com/v1',
  llmApiKey: '',
  llmModel: '',
  llmTemperature: 0.2,
  imageApiBaseUrl: AGNES_API_BASE_URL,
  imageApiKey: '',
  imageModel: AGNES_IMAGE_MODEL,
  videoApiBaseUrl: AGNES_API_BASE_URL,
  videoApiKey: '',
  videoModel: AGNES_VIDEO_MODEL,
  termGlossary: '',
  closeBehavior: '',
  remoteUploadEndpoint: 'https://ailabing.cn/api/jaygo/upload-audio',
  remoteUploadToken: '6b5ec35b8e28d2e1fb24c899fa19e74f03355a5b62105df90c2086a76d14812a',
};

const TEMP_UPLOAD_ENDPOINTS = [
  {
    name: 'uguu.se',
    url: 'https://uguu.se/upload',
    fileField: 'files[]',
    parser: 'json_files_url',
  },
  {
    name: 'catbox.moe',
    url: 'https://catbox.moe/user/api.php',
    fileField: 'fileToUpload',
    parser: 'plain_url',
    extraFields: { reqtype: 'fileupload' },
  },
];

const TEMP_UPLOAD_TIMEOUT_MS = 45_000;
const TEMP_UPLOAD_RETRY_PER_ENDPOINT = 3;
const TEMP_UPLOAD_RETRY_BACKOFF_MS = 1_500;

let mainWindow = null;
let reviewWindow = null;
let tray = null;
let isQuitting = false;
let isHandlingMainWindowClose = false;
let activeTask = null;
let standaloneReviewServer = null;
let updaterConfigured = false;
let updateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
  latestVersion: '',
  message: '未检查更新',
  releaseNotes: '',
  progress: 0,
  canDownload: false,
  canInstall: false,
  lastCheckedAt: '',
};
let modelInstallState = {
  status: 'idle',
  model: '',
  message: '未检查模型',
  progress: 0,
};
let activeModelInstall = null;

function getAppIconPath() {
  if (!app.isPackaged) {
    if (process.platform === 'win32' && fs.existsSync(APP_ICON_ICO)) return APP_ICON_ICO;
    return APP_ICON_PNG;
  }

  const packedCandidates = process.platform === 'win32'
    ? [
      path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'assets', 'app-icon.ico'),
      path.join(process.resourcesPath, 'electron', 'assets', 'app-icon.ico'),
      path.join(process.resourcesPath, 'app.asar', 'electron', 'assets', 'app-icon.ico'),
    ]
    : [
      path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'assets', 'app-icon.png'),
      path.join(process.resourcesPath, 'electron', 'assets', 'app-icon.png'),
      path.join(process.resourcesPath, 'app.asar', 'electron', 'assets', 'app-icon.png'),
    ];

  for (const p of packedCandidates) {
    if (fs.existsSync(p)) return p;
  }
  return APP_ICON_PNG;
}

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
}

function withExeSuffix(name) {
  if (process.platform === 'win32') return `${name}.exe`;
  return name;
}

function getBundledToolPath(name) {
  const exe = withExeSuffix(name);
  const candidates = app.isPackaged
    ? [
      path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'bin', exe),
      path.join(process.resourcesPath, 'electron', 'bin', exe),
    ]
    : [path.join(BIN_DIR, exe)];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function getToolCommand(name) {
  return getBundledToolPath(name) || name;
}

function normalizeWhisperModelKey(value) {
  return value === 'standard' ? 'standard' : 'high';
}

function normalizeExportQuality(value) {
  const key = String(value || '').trim();
  return Object.prototype.hasOwnProperty.call(EXPORT_QUALITY_PRESETS, key) ? key : DEFAULT_EXPORT_QUALITY;
}

function normalizeThemeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'blackgold' || mode === 'system') return mode;
  return 'light';
}

function normalizeAsrEngine(value) {
  const engine = String(value || '').trim().toLowerCase();
  if (['volcengine', 'aliyun_qwen', 'mimo', 'local'].includes(engine)) return engine;
  if (engine === 'whisper') return 'local';
  return DEFAULT_SETTINGS.asrEngine;
}

function asrEngineEnvValue(value) {
  const engine = normalizeAsrEngine(value);
  return engine === 'local' ? 'whisper' : engine;
}

function normalizeSettings(source = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...source,
    asrEngine: normalizeAsrEngine(source.asrEngine),
    volcengineApiKey: String(source.volcengineApiKey || '').trim(),
    dashscopeApiKey: String(source.dashscopeApiKey || '').trim(),
    mimoApiKey: String(source.mimoApiKey || '').trim(),
  };
}

function normalizeLlmProviderKey(value) {
  const key = String(value || '').trim();
  return LLM_PROVIDER_KEYS.has(key) ? key : 'custom';
}

function normalizeLlmBaseUrl(url) {
  const value = String(url || '').trim();
  return value.replace(/\/+$/, '');
}

function buildOpenAiCompletionsEndpoint(baseUrl) {
  const clean = normalizeLlmBaseUrl(baseUrl);
  if (/\/chat\/completions$/i.test(clean)) return clean;
  return `${clean}/chat/completions`;
}

function buildAnthropicMessagesEndpoint(baseUrl) {
  const clean = normalizeLlmBaseUrl(baseUrl || 'https://api.anthropic.com');
  if (/\/v1$/i.test(clean)) return `${clean}/messages`;
  if (/\/v1\/messages$/i.test(clean)) return clean;
  return `${clean}/v1/messages`;
}

function getWhisperModelLabel(value) {
  const key = normalizeWhisperModelKey(value);
  return key === 'high' ? '高精度（large-v3-turbo）' : '标准（base）';
}

function getBundledWhisperModelPath(modelKey = DEFAULT_LOCAL_WHISPER_MODEL) {
  const selectedKey = normalizeWhisperModelKey(modelKey);
  const modelName = WHISPER_MODEL_FILES[selectedKey] || WHISPER_MODEL_FILES.high;
  const userModelPath = path.join(getUserModelsDir(), modelName);
  const candidates = [
    userModelPath,
    ...(app.isPackaged
      ? [
        path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'models', modelName),
        path.join(process.resourcesPath, 'electron', 'models', modelName),
      ]
      : [path.join(MODELS_DIR, modelName)]),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function getUserModelsDir() {
  return path.join(app.getPath('userData'), 'models');
}

function getExpectedWhisperModelPath(modelKey = DEFAULT_LOCAL_WHISPER_MODEL) {
  const selectedKey = normalizeWhisperModelKey(modelKey);
  const modelName = WHISPER_MODEL_FILES[selectedKey] || WHISPER_MODEL_FILES.high;
  return path.join(getUserModelsDir(), modelName);
}

function getConfiguredWhisperModelPath(settings = {}) {
  const configured = String(settings.localWhisperModelPath || '').trim();
  if (configured && fs.existsSync(configured)) return configured;
  return '';
}

function isSupportedWhisperModelFile(filePath, stat = null) {
  const base = path.basename(String(filePath || '')).toLowerCase();
  if (!base.endsWith('.bin')) return false;
  if (stat && stat.size < 10 * 1024 * 1024) return false;
  return base.startsWith('ggml') || base.includes('whisper');
}

function rankWhisperModel(filePath, stat = null) {
  const base = path.basename(String(filePath || '')).toLowerCase();
  let score = 0;
  if (base.includes('large-v3-turbo')) score += 1000;
  else if (base.includes('large')) score += 900;
  else if (base.includes('medium')) score += 700;
  else if (base.includes('small')) score += 500;
  else if (base.includes('base')) score += 300;
  else if (base.includes('tiny')) score += 100;
  if (base.startsWith('ggml')) score += 80;
  if (stat && stat.size) score += Math.min(120, Math.round(stat.size / (20 * 1024 * 1024)));
  return score;
}

function addWhisperCandidate(candidates, seen, filePath) {
  if (!filePath) return;
  const normalized = path.resolve(filePath);
  const key = normalized.toLowerCase();
  if (seen.has(key)) return;
  let stat = null;
  try {
    stat = fs.statSync(normalized);
  } catch {
    return;
  }
  if (!stat.isFile() || !isSupportedWhisperModelFile(normalized, stat)) return;
  seen.add(key);
  candidates.push({
    path: normalized,
    fileName: path.basename(normalized),
    size: stat.size,
    rank: rankWhisperModel(normalized, stat),
  });
}

function getFastWhisperModelCandidates(settings = {}) {
  const candidates = [];
  const seen = new Set();
  addWhisperCandidate(candidates, seen, getConfiguredWhisperModelPath(settings));
  for (const key of Object.keys(WHISPER_MODEL_FILES)) {
    addWhisperCandidate(candidates, seen, getExpectedWhisperModelPath(key));
    addWhisperCandidate(candidates, seen, getBundledWhisperModelPath(key));
    addWhisperCandidate(candidates, seen, path.join(MODELS_DIR, WHISPER_MODEL_FILES[key]));
  }
  return candidates.sort((a, b) => b.rank - a.rank || b.size - a.size);
}

function getSearchRoots() {
  const roots = new Set([
    getUserModelsDir(),
    MODELS_DIR,
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Documents'),
  ]);
  if (process.platform === 'win32') {
    for (let code = 65; code <= 90; code += 1) {
      const root = `${String.fromCharCode(code)}:\\`;
      if (fs.existsSync(root)) roots.add(root);
    }
  } else {
    roots.add(os.homedir());
    roots.add('/');
  }
  return Array.from(roots).filter((root) => {
    try {
      return fs.existsSync(root) && fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}

function shouldSkipModelSearchDir(dirPath) {
  const base = path.basename(dirPath).toLowerCase();
  if (['node_modules', '.git', '$recycle.bin', 'system volume information', 'windows', 'program files', 'program files (x86)', 'programdata'].includes(base)) return true;
  const lower = dirPath.toLowerCase();
  return lower.includes('\appdata\local\microsoft')
    || lower.includes('\appdata\local\packages')
    || lower.includes('\appdata\roaming\microsoft')
    || lower.includes('\windowsapps');
}

async function discoverWhisperModels(settings = {}) {
  const startedAt = Date.now();
  const maxMs = 20000;
  const maxDirs = 25000;
  const maxResults = 60;
  const candidates = getFastWhisperModelCandidates(settings);
  const seenFiles = new Set(candidates.map((item) => item.path.toLowerCase()));
  const seenDirs = new Set();
  const queue = getSearchRoots();
  let scannedDirs = 0;

  while (queue.length && scannedDirs < maxDirs && Date.now() - startedAt < maxMs && candidates.length < maxResults) {
    const dir = queue.shift();
    if (!dir) continue;
    const resolvedDir = path.resolve(dir);
    const dirKey = resolvedDir.toLowerCase();
    if (seenDirs.has(dirKey) || shouldSkipModelSearchDir(resolvedDir)) continue;
    seenDirs.add(dirKey);
    scannedDirs += 1;

    let entries = [];
    try {
      entries = await fsp.readdir(resolvedDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(resolvedDir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipModelSearchDir(fullPath)) queue.push(fullPath);
      } else if (entry.isFile()) {
        const fileKey = fullPath.toLowerCase();
        if (seenFiles.has(fileKey)) continue;
        let stat = null;
        try {
          stat = await fsp.stat(fullPath);
        } catch {
          continue;
        }
        if (!isSupportedWhisperModelFile(fullPath, stat)) continue;
        seenFiles.add(fileKey);
        candidates.push({
          path: path.resolve(fullPath),
          fileName: entry.name,
          size: stat.size,
          rank: rankWhisperModel(fullPath, stat),
        });
      }
    }
  }

  candidates.sort((a, b) => b.rank - a.rank || b.size - a.size);
  return {
    candidates,
    scannedDirs,
    elapsedMs: Date.now() - startedAt,
    timedOut: queue.length > 0 && Date.now() - startedAt >= maxMs,
  };
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)}GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(0)}MB`;
  return `${Math.round(value / 1024)}KB`;
}

async function persistDetectedWhisperModel(modelPath) {
  if (!modelPath) return;
  const settings = await loadSettings();
  if (settings.localWhisperModelPath === modelPath) return;
  await saveSettings({ ...settings, localWhisperModelPath: modelPath });
}

function ensureTrailingArray(value) {
  return Array.isArray(value) ? value : [];
}

function nowIso() {
  return new Date().toISOString();
}

function getSettingsFilePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function getHistoryFilePath() {
  return path.join(app.getPath('userData'), 'history.json');
}

function getEnvFilePath() {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), '.env');
  }
  return path.join(REPO_ROOT, '.env');
}

function buildRuntimeEnv(settings) {
  const localModelKey = normalizeWhisperModelKey(settings.localWhisperModel);
  const llmBase = String(settings.llmApiBaseUrl || '').trim();
  const exportQuality = normalizeExportQuality(settings.exportQuality);
  const exportPreset = EXPORT_QUALITY_PRESETS[exportQuality] || EXPORT_QUALITY_PRESETS[DEFAULT_EXPORT_QUALITY];
  return {
    VOLCENGINE_API_KEY: settings.volcengineApiKey || '',
    DASHSCOPE_API_KEY: settings.dashscopeApiKey || '',
    MIMO_API_KEY: settings.mimoApiKey || '',
    MIMO_ASR_BASE_URL: MIMO_ASR_BASE_URL,
    MIMO_ASR_MODEL: MIMO_ASR_MODEL,
    MIMO_ASR_LANGUAGE: 'zh',
    DASHSCOPE_ASR_MODEL: QWEN_ASR_MODEL,
    ASR_ENGINE: asrEngineEnvValue(settings.asrEngine),
    DEFAULT_OUTPUT_DIR: settings.outputRoot || DEFAULT_SETTINGS.outputRoot,
    CUT_MIN_DELETE_MS: '200',
    CUT_EXPORT_QUALITY: exportQuality,
    CUT_EXPORT_CRF: String(exportPreset.crf),
    CUT_EXPORT_PRESET: exportPreset.preset,
    CUT_AUDIO_BITRATE: exportPreset.audioBitrate,
    FFMPEG_BIN: getToolCommand('ffmpeg'),
    FFPROBE_BIN: getToolCommand('ffprobe'),
    WHISPER_MODEL_QUALITY: localModelKey,
    WHISPER_MODEL: getConfiguredWhisperModelPath(settings) || getBundledWhisperModelPath(localModelKey),
    JAYGO_THEME_MODE: normalizeThemeMode(settings.themeMode),
    LLM_API_BASE_URL: llmBase || DEFAULT_SETTINGS.llmApiBaseUrl,
    LLM_API_KEY: settings.llmApiKey || '',
    LLM_MODEL: String(settings.llmModel || '').trim(),
    LLM_TEMPERATURE: String(Number.isFinite(Number(settings.llmTemperature)) ? Number(settings.llmTemperature) : 0.2),
    LLM_PROVIDER: normalizeLlmProviderKey(settings.llmProvider),
    IMAGE_API_BASE_URL: String(settings.imageApiBaseUrl || '').trim(),
    IMAGE_API_KEY: String(settings.imageApiKey || settings.llmApiKey || '').trim(),
    IMAGE_MODEL: String(settings.imageModel || '').trim(),
    VIDEO_API_BASE_URL: String(settings.videoApiBaseUrl || settings.imageApiBaseUrl || '').trim(),
    VIDEO_API_KEY: String(settings.videoApiKey || settings.imageApiKey || settings.llmApiKey || '').trim(),
    VIDEO_MODEL: String(settings.videoModel || '').trim(),
    TERM_GLOSSARY: String(settings.termGlossary || ''),
  };
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function parseEnv(content) {
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function encodeMultilineEnvValue(value) {
  return JSON.stringify(String(value || ''));
}

function decodeMultilineEnvValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('"') || raw.startsWith("'")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.replace(/^['"]|['"]$/g, '').replace(/\\n/g, '\n');
    }
  }
  return raw.replace(/\\n/g, '\n');
}

async function loadHistory() {
  const file = getHistoryFilePath();
  try {
    if (!fs.existsSync(file)) return [];
    const data = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (!Array.isArray(data)) return [];
    return data;
  } catch {
    return [];
  }
}

async function saveHistory(list) {
  await ensureDir(path.dirname(getHistoryFilePath()));
  await fsp.writeFile(getHistoryFilePath(), `${JSON.stringify(list, null, 2)}\n`, 'utf8');
}

async function loadHistoryWithHealth() {
  const list = await loadHistory();
  return list.map((item) => annotateHistoryEntry(item));
}

async function addHistoryEntry(entry) {
  const list = await loadHistory();
  list.unshift(entry);

  const result = [];
  const seen = new Set();
  for (const item of list) {
    const key = `${item.projectDir}|${item.videoPath}|${item.finishedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= 40) break;
  }

  await saveHistory(result);
}

function sameHistoryEntry(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id) return String(a.id) === String(b.id);
  return (
    String(a.projectDir || '') === String(b.projectDir || '') &&
    String(a.videoPath || '') === String(b.videoPath || '') &&
    String(a.finishedAt || '') === String(b.finishedAt || '')
  );
}

async function deleteHistoryEntry(target) {
  const list = await loadHistory();
  const next = list.filter((item) => !sameHistoryEntry(item, target));
  await saveHistory(next);
  return next.map((item) => annotateHistoryEntry(item));
}

async function relinkHistoryEntryVideo(target) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '重新选择原视频文件',
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'mkv'] }],
  });
  if (result.canceled || !result.filePaths[0]) return loadHistoryWithHealth();
  const list = await loadHistory();
  const next = relinkHistoryVideo(list, target, result.filePaths[0]);
  await saveHistory(next);
  return next.map((item) => annotateHistoryEntry(item));
}

function taskSnapshot() {
  if (!activeTask) return null;
  return {
    id: activeTask.id,
    state: activeTask.state,
    stage: activeTask.stage,
    startedAt: activeTask.startedAt,
    finishedAt: activeTask.finishedAt,
    error: activeTask.error,
    reviewUrl: activeTask.reviewUrl,
    reviewPort: activeTask.reviewPort,
    projectDir: activeTask.projectDir,
    reviewDir: activeTask.reviewDir,
    videoPath: activeTask.videoPath,
    outputRoot: activeTask.outputRoot,
    outputVideoPath: activeTask.outputVideoPath,
    logs: ensureTrailingArray(activeTask.logs).slice(-300),
  };
}

function pushTaskUpdate() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('task:update', taskSnapshot());
}

function updateSnapshot() {
  return { ...updateState };
}

function setUpdateState(patch) {
  updateState = {
    ...updateState,
    currentVersion: app.getVersion(),
    ...patch,
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:state', updateSnapshot());
  }
}

function normalizeReleaseNotes(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item === 'object') {
          const version = String(item.version || item.releaseName || '').trim();
          const note = normalizeReleaseNotes(item.note || item.notes || item.body || item.releaseNotes || item.changes);
          return [version, note].filter(Boolean).join('\n');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  if (value && typeof value === 'object') {
    return normalizeReleaseNotes(value.note || value.notes || value.body || value.releaseNotes || value.changes);
  }
  return String(value || '').trim();
}

function releaseNotesFromUpdateInfo(info) {
  return normalizeReleaseNotes(info?.releaseNotes || info?.releaseName || '');
}

async function fetchReleaseNotes(version) {
  if (typeof fetch !== 'function') return '';
  const url = new URL('release-notes.json', UPDATE_FEED_URL);
  url.searchParams.set('v', String(version || app.getVersion()));
  url.searchParams.set('t', String(Date.now()));
  const response = await fetch(url.toString(), {
    headers: { accept: 'application/json,text/plain;q=0.9,*/*;q=0.8' },
  });
  if (!response.ok) return '';
  const text = await response.text();
  if (!text.trim()) return '';
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data)) {
      const found = data.find((item) => String(item?.version || '') === String(version || ''));
      return normalizeReleaseNotes(found || data[0]);
    }
    if (data && typeof data === 'object') {
      if (data.versions && version && data.versions[version]) return normalizeReleaseNotes(data.versions[version]);
      if (data[version]) return normalizeReleaseNotes(data[version]);
      return normalizeReleaseNotes(data);
    }
  } catch {
    return text.trim();
  }
  return '';
}

function refreshReleaseNotes(version, fallback = '') {
  const initial = normalizeReleaseNotes(fallback);
  if (initial) setUpdateState({ releaseNotes: initial });
  fetchReleaseNotes(version)
    .then((notes) => {
      if (notes) setUpdateState({ releaseNotes: notes });
    })
    .catch(() => {});
}

function modelInstallSnapshot() {
  return { ...modelInstallState };
}

function setModelInstallState(patch) {
  modelInstallState = {
    ...modelInstallState,
    ...patch,
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('model:install-state', modelInstallSnapshot());
  }
}

async function getWhisperModelStatus(options = {}) {
  const opts = typeof options === 'object' && options !== null ? options : {};
  const settings = await loadSettings();
  const key = normalizeWhisperModelKey(settings.localWhisperModel);
  const fileName = WHISPER_MODEL_FILES[key] || WHISPER_MODEL_FILES.high;
  const expectedPath = getExpectedWhisperModelPath(key);
  const scan = Boolean(opts.scan);
  const result = scan ? await discoverWhisperModels(settings) : {
    candidates: getFastWhisperModelCandidates(settings),
    scannedDirs: 0,
    elapsedMs: 0,
    timedOut: false,
  };
  const best = result.candidates[0] || null;
  if (scan && best?.path) {
    await persistDetectedWhisperModel(best.path);
  }
  return {
    key,
    label: '本地 Whisper / ggml 语音模型',
    fileName,
    installed: Boolean(best?.path),
    path: best?.path || expectedPath,
    userModelsDir: getUserModelsDir(),
    candidates: result.candidates.slice(0, 12),
    scannedDirs: result.scannedDirs,
    elapsedMs: result.elapsedMs,
    timedOut: result.timedOut,
    scan,
    installState: modelInstallSnapshot(),
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
  }
  return JSON.parse(text);
}

async function downloadFileWithProgress(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
  }

  const total = Number(res.headers.get('content-length') || 0);
  await ensureDir(path.dirname(dest));
  const tmpPath = `${dest}.download`;
  await fsp.rm(tmpPath, { force: true }).catch(() => {});

  const writer = fs.createWriteStream(tmpPath);
  let downloaded = 0;
  for await (const chunk of res.body) {
    const buffer = Buffer.from(chunk);
    downloaded += buffer.length;
    writer.write(buffer);
    if (total > 0) {
      onProgress(Math.max(0, Math.min(99, (downloaded / total) * 100)));
    }
  }

  await new Promise((resolve, reject) => {
    writer.end(resolve);
    writer.on('error', reject);
  });
  await fsp.rename(tmpPath, dest);
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function installWhisperModel(modelKey = DEFAULT_LOCAL_WHISPER_MODEL) {
  const key = DEFAULT_LOCAL_WHISPER_MODEL;
  if (activeModelInstall) return activeModelInstall;

  activeModelInstall = (async () => {
    const current = await getWhisperModelStatus();
    if (current.installed) {
      setModelInstallState({
        status: 'installed',
        model: key,
        message: '模型已install',
        progress: 100,
      });
      return getWhisperModelStatus();
    }

    setModelInstallState({
      status: 'checking',
      model: key,
      message: '正在获取模型清单...',
      progress: 0,
    });

    const manifest = WHISPER_MODEL_DOWNLOADS;
    const model = manifest?.models?.[key];
    if (!model) throw new Error(`模型清单缺少 ${key}`);
    const fileName = model.file || WHISPER_MODEL_FILES[key];
    const urls = Array.isArray(model.urls) && model.urls.length
      ? model.urls
      : [];
    if (!urls.length) throw new Error(`模型 ${key} 没有可用下载源`);
    const dest = getExpectedWhisperModelPath(key);

    let lastError = null;
    for (const url of urls) {
      try {
        setModelInstallState({
          status: 'downloading',
          model: key,
          message: '正在下载模型...',
          progress: 1,
        });
        await downloadFileWithProgress(url, dest, (progress) => {
          setModelInstallState({
            status: 'downloading',
            model: key,
            message: `正在下载模型 ${Math.round(progress)}%`,
            progress,
          });
        });
        if (model.sha256) {
          setModelInstallState({
            status: 'verifying',
            model: key,
            message: '正在校验模型...',
            progress: 99,
          });
          const actual = await sha256File(dest);
          if (actual.toLowerCase() !== String(model.sha256).toLowerCase()) {
            await fsp.rm(dest, { force: true }).catch(() => {});
            throw new Error('模型校验失败');
          }
        }
        setModelInstallState({
          status: 'installed',
          model: key,
          message: '模型install完成',
          progress: 100,
        });
        return getWhisperModelStatus();
      } catch (err) {
        lastError = err;
        await fsp.rm(dest, { force: true }).catch(() => {});
      }
    }

    throw lastError || new Error('模型下载失败');
  })();

  try {
    return await activeModelInstall;
  } catch (err) {
    setModelInstallState({
      status: 'error',
      model: key,
      message: `模型install失败：${err?.message || String(err)}`,
      progress: 0,
    });
    throw err;
  } finally {
    activeModelInstall = null;
  }
}

function configureAutoUpdater() {
  if (updaterConfigured) return Boolean(autoUpdater);
  updaterConfigured = true;

  if (!autoUpdater) {
    setUpdateState({
      status: 'unavailable',
      message: '自动更新模块未install',
      canDownload: false,
      canInstall: false,
    });
    return false;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: UPDATE_FEED_URL,
  });

  autoUpdater.on('checking-for-update', () => {
    setUpdateState({
      status: 'checking',
      message: '正在检查更新...',
      releaseNotes: '',
      progress: 0,
      canDownload: false,
      canInstall: false,
      lastCheckedAt: new Date().toISOString(),
    });
  });

  autoUpdater.on('update-available', (info) => {
    const latestVersion = info?.version || '';
    setUpdateState({
      status: 'available',
      latestVersion,
      message: `发现新版本 ${latestVersion}`.trim(),
      releaseNotes: releaseNotesFromUpdateInfo(info),
      progress: 0,
      canDownload: true,
      canInstall: false,
    });
    refreshReleaseNotes(latestVersion, info?.releaseNotes);
  });

  autoUpdater.on('update-not-available', (info) => {
    setUpdateState({
      status: 'not-available',
      latestVersion: info?.version || app.getVersion(),
      message: '当前已是最新版本',
      releaseNotes: '',
      progress: 0,
      canDownload: false,
      canInstall: false,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    setUpdateState({
      status: 'downloading',
      message: `正在下载更新 ${Math.round(progress?.percent || 0)}%`,
      progress: Number(progress?.percent || 0),
      canDownload: false,
      canInstall: false,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    const latestVersion = info?.version || updateState.latestVersion;
    setUpdateState({
      status: 'downloaded',
      latestVersion,
      message: '更新已下载，重启后安装',
      releaseNotes: updateState.releaseNotes || releaseNotesFromUpdateInfo(info),
      progress: 100,
      canDownload: false,
      canInstall: true,
    });
    refreshReleaseNotes(latestVersion, info?.releaseNotes);
  });

  autoUpdater.on('error', (err) => {
    setUpdateState({
      status: 'error',
      message: `更新失败：${err?.message || String(err)}`,
      canDownload: false,
      canInstall: false,
    });
  });

  return true;
}

async function checkForAppUpdates({ manual = false } = {}) {
  if (!configureAutoUpdater()) return updateSnapshot();
  if (!app.isPackaged) {
    setUpdateState({
      status: 'unavailable',
      message: manual ? '开发模式不检查更新，打包install后生效' : '开发模式已跳过自动更新检查',
      canDownload: false,
      canInstall: false,
    });
    return updateSnapshot();
  }
  await autoUpdater.checkForUpdates();
  return updateSnapshot();
}

function appendTaskLog(line) {
  if (!activeTask) return;
  const text = String(line || '').trim();
  if (!text) return;

  activeTask.logs.push(`[${new Date().toLocaleTimeString()}] ${text}`);
  if (activeTask.logs.length > 500) {
    activeTask.logs = activeTask.logs.slice(-500);
  }
  pushTaskUpdate();
}

function setTaskState(patch) {
  if (!activeTask) return;
  activeTask = { ...activeTask, ...patch };
  pushTaskUpdate();
}

async function loadSettings() {
  const file = getSettingsFilePath();
  let current = {};

  try {
    if (fs.existsSync(file)) {
      current = JSON.parse(await fsp.readFile(file, 'utf8'));
    }
  } catch {
    current = {};
  }

  const merged = { ...DEFAULT_SETTINGS, ...current };

  const envFile = getEnvFilePath();
  if (fs.existsSync(envFile)) {
    try {
      const env = parseEnv(await fsp.readFile(envFile, 'utf8'));
      if (env.DEFAULT_OUTPUT_DIR) merged.outputRoot = env.DEFAULT_OUTPUT_DIR;
      if (env.VOLCENGINE_API_KEY) merged.volcengineApiKey = env.VOLCENGINE_API_KEY;
      if (env.DASHSCOPE_API_KEY) merged.dashscopeApiKey = env.DASHSCOPE_API_KEY;
      if (env.MIMO_API_KEY) merged.mimoApiKey = env.MIMO_API_KEY;
      if (env.ASR_ENGINE === 'whisper') merged.asrEngine = 'local';
      if (env.ASR_ENGINE === 'volcengine') merged.asrEngine = 'volcengine';
      if (env.ASR_ENGINE === 'aliyun_qwen') merged.asrEngine = 'aliyun_qwen';
      if (env.ASR_ENGINE === 'mimo') merged.asrEngine = 'mimo';
      if (env.WHISPER_MODEL_QUALITY) merged.localWhisperModel = normalizeWhisperModelKey(env.WHISPER_MODEL_QUALITY);
      if (env.WHISPER_MODEL) merged.localWhisperModelPath = env.WHISPER_MODEL;
      if (env.JAYGO_THEME_MODE) merged.themeMode = normalizeThemeMode(env.JAYGO_THEME_MODE);
      if (env.CUT_EXPORT_QUALITY) merged.exportQuality = normalizeExportQuality(env.CUT_EXPORT_QUALITY);
      if (env.LLM_API_BASE_URL) merged.llmApiBaseUrl = env.LLM_API_BASE_URL;
      if (env.LLM_API_KEY) merged.llmApiKey = env.LLM_API_KEY;
      if (env.LLM_MODEL) merged.llmModel = env.LLM_MODEL;
      if (env.LLM_TEMPERATURE) merged.llmTemperature = Number(env.LLM_TEMPERATURE);
      if (env.LLM_PROVIDER) merged.llmProvider = normalizeLlmProviderKey(env.LLM_PROVIDER);
      if (env.IMAGE_API_BASE_URL) merged.imageApiBaseUrl = env.IMAGE_API_BASE_URL;
      if (env.IMAGE_API_KEY) merged.imageApiKey = env.IMAGE_API_KEY;
      if (env.IMAGE_MODEL) merged.imageModel = env.IMAGE_MODEL;
      if (env.VIDEO_API_BASE_URL) merged.videoApiBaseUrl = env.VIDEO_API_BASE_URL;
      if (env.VIDEO_API_KEY) merged.videoApiKey = env.VIDEO_API_KEY;
      if (env.VIDEO_MODEL) merged.videoModel = env.VIDEO_MODEL;
      if (env.TERM_GLOSSARY) merged.termGlossary = decodeMultilineEnvValue(env.TERM_GLOSSARY);
    } catch {
      // ignore malformed .env
    }
  }

  if (!merged.outputRoot || /app\.asar/i.test(String(merged.outputRoot))) {
    merged.outputRoot = DEFAULT_SETTINGS.outputRoot;
  }
  merged.localWhisperModel = normalizeWhisperModelKey(merged.localWhisperModel);
  merged.localWhisperModelPath = String(merged.localWhisperModelPath || '').trim();
  merged.asrEngine = normalizeAsrEngine(merged.asrEngine);
  merged.volcengineApiKey = String(merged.volcengineApiKey || '').trim();
  merged.dashscopeApiKey = String(merged.dashscopeApiKey || '').trim();
  merged.mimoApiKey = String(merged.mimoApiKey || '').trim();
  merged.exportQuality = normalizeExportQuality(merged.exportQuality);
  if (!merged.exportQualityMigratedToUltra && merged.exportQuality === 'high') {
    merged.exportQuality = DEFAULT_EXPORT_QUALITY;
    merged.exportQualityMigratedToUltra = true;
  }
  merged.themeMode = normalizeThemeMode(merged.themeMode);
  merged.llmProvider = normalizeLlmProviderKey(merged.llmProvider);
  if (!merged.llmApiBaseUrl) merged.llmApiBaseUrl = DEFAULT_SETTINGS.llmApiBaseUrl;
  if (!Number.isFinite(Number(merged.llmTemperature))) merged.llmTemperature = DEFAULT_SETTINGS.llmTemperature;
  if (!String(merged.imageApiBaseUrl || '').trim()) merged.imageApiBaseUrl = DEFAULT_SETTINGS.imageApiBaseUrl;
  if (!String(merged.imageModel || '').trim()) merged.imageModel = DEFAULT_SETTINGS.imageModel;
  if (!String(merged.videoApiBaseUrl || '').trim()) merged.videoApiBaseUrl = DEFAULT_SETTINGS.videoApiBaseUrl;
  if (!String(merged.videoModel || '').trim()) merged.videoModel = DEFAULT_SETTINGS.videoModel;
  return merged;
}

async function syncSkillEnv(settings) {
  try {
    const envFile = getEnvFilePath();
    let current = {};
    if (fs.existsSync(envFile)) {
      try {
        current = parseEnv(await fsp.readFile(envFile, 'utf8'));
      } catch {
        current = {};
      }
    }

    current.DEFAULT_OUTPUT_DIR = settings.outputRoot || DEFAULT_SETTINGS.outputRoot;
    current.VOLCENGINE_API_KEY = settings.volcengineApiKey || '';
    current.DASHSCOPE_API_KEY = settings.dashscopeApiKey || '';
    current.MIMO_API_KEY = settings.mimoApiKey || '';
    current.MIMO_ASR_BASE_URL = MIMO_ASR_BASE_URL;
    current.MIMO_ASR_MODEL = MIMO_ASR_MODEL;
    current.MIMO_ASR_LANGUAGE = 'zh';
    current.DASHSCOPE_ASR_MODEL = QWEN_ASR_MODEL;
    current.ASR_ENGINE = asrEngineEnvValue(settings.asrEngine);
    current.WHISPER_MODEL_QUALITY = normalizeWhisperModelKey(settings.localWhisperModel);
    current.WHISPER_MODEL = getConfiguredWhisperModelPath(settings) || settings.localWhisperModelPath || '';
    current.CUT_MIN_DELETE_MS = '200';
    current.CUT_EXPORT_QUALITY = normalizeExportQuality(settings.exportQuality);
    const exportPreset = EXPORT_QUALITY_PRESETS[current.CUT_EXPORT_QUALITY] || EXPORT_QUALITY_PRESETS[DEFAULT_EXPORT_QUALITY];
    current.CUT_EXPORT_CRF = String(exportPreset.crf);
    current.CUT_EXPORT_PRESET = exportPreset.preset;
    current.CUT_AUDIO_BITRATE = exportPreset.audioBitrate;
    current.JAYGO_THEME_MODE = normalizeThemeMode(settings.themeMode);
    current.LLM_PROVIDER = normalizeLlmProviderKey(settings.llmProvider);
    current.LLM_API_BASE_URL = String(settings.llmApiBaseUrl || DEFAULT_SETTINGS.llmApiBaseUrl);
    current.LLM_API_KEY = String(settings.llmApiKey || '');
    current.LLM_MODEL = String(settings.llmModel || '');
    current.LLM_TEMPERATURE = String(
      Number.isFinite(Number(settings.llmTemperature)) ? Number(settings.llmTemperature) : DEFAULT_SETTINGS.llmTemperature,
    );
    current.IMAGE_API_BASE_URL = String(settings.imageApiBaseUrl || '');
    current.IMAGE_API_KEY = String(settings.imageApiKey || settings.llmApiKey || '');
    current.IMAGE_MODEL = String(settings.imageModel || '');
    current.VIDEO_API_BASE_URL = String(settings.videoApiBaseUrl || settings.imageApiBaseUrl || '');
    current.VIDEO_API_KEY = String(settings.videoApiKey || settings.imageApiKey || settings.llmApiKey || '');
    current.VIDEO_MODEL = String(settings.videoModel || '');
    current.TERM_GLOSSARY = encodeMultilineEnvValue(settings.termGlossary || '');

    const ordered = [
      'VOLCENGINE_API_KEY',
      'DASHSCOPE_API_KEY',
      'MIMO_API_KEY',
      'MIMO_ASR_BASE_URL',
      'MIMO_ASR_MODEL',
      'MIMO_ASR_LANGUAGE',
      'DASHSCOPE_ASR_MODEL',
      'ASR_ENGINE',
      'WHISPER_MODEL_QUALITY',
      'WHISPER_MODEL',
      'JAYGO_THEME_MODE',
      'LLM_PROVIDER',
      'LLM_API_BASE_URL',
      'LLM_API_KEY',
      'LLM_MODEL',
      'LLM_TEMPERATURE',
      'IMAGE_API_BASE_URL',
      'IMAGE_API_KEY',
      'IMAGE_MODEL',
      'VIDEO_API_BASE_URL',
      'VIDEO_API_KEY',
      'VIDEO_MODEL',
      'TERM_GLOSSARY',
      'DEFAULT_OUTPUT_DIR',
      'CUT_MIN_DELETE_MS',
      'CUT_EXPORT_QUALITY',
      'CUT_EXPORT_CRF',
      'CUT_EXPORT_PRESET',
      'CUT_AUDIO_BITRATE',
    ];
    const keys = Array.from(new Set([...ordered, ...Object.keys(current)]));
    const lines = keys.map((key) => `${key}=${current[key] ?? ''}`);
    await ensureDir(path.dirname(envFile));
    await fsp.writeFile(envFile, `${lines.join('\n')}\n`, 'utf8');
  } catch (err) {
    console.warn('Failed to sync env file:', err.message);
  }
}

async function saveSettings(nextSettings = {}) {
  let current = {};
  try {
    if (fs.existsSync(getSettingsFilePath())) {
      current = JSON.parse(await fsp.readFile(getSettingsFilePath(), 'utf8'));
    }
  } catch {
    current = {};
  }
  const source = { ...DEFAULT_SETTINGS, ...current, ...nextSettings };
  const normalized = {
    ...DEFAULT_SETTINGS,
    ...current,
    ...nextSettings,
    asrEngine: normalizeAsrEngine(source.asrEngine),
    volcengineApiKey: String(source.volcengineApiKey || '').trim(),
    dashscopeApiKey: String(source.dashscopeApiKey || '').trim(),
    mimoApiKey: String(source.mimoApiKey || '').trim(),
    silenceThresholdSec: Number(source.silenceThresholdSec) >= 0.2
      ? Number(source.silenceThresholdSec)
      : 0.2,
    exportQuality: normalizeExportQuality(source.exportQuality),
    exportQualityMigratedToUltra: true,
    localWhisperModel: normalizeWhisperModelKey(source.localWhisperModel),
    localWhisperModelPath: String(source.localWhisperModelPath || '').trim(),
    themeMode: normalizeThemeMode(source.themeMode),
    llmProvider: normalizeLlmProviderKey(source.llmProvider),
    llmApiBaseUrl: String(source.llmApiBaseUrl || DEFAULT_SETTINGS.llmApiBaseUrl).trim() || DEFAULT_SETTINGS.llmApiBaseUrl,
    llmApiKey: String(source.llmApiKey || '').trim(),
    llmModel: String(source.llmModel || '').trim(),
    llmTemperature: Number.isFinite(Number(source.llmTemperature))
      ? Math.max(0, Math.min(1.5, Number(source.llmTemperature)))
      : DEFAULT_SETTINGS.llmTemperature,
    imageApiBaseUrl: String(source.imageApiBaseUrl || DEFAULT_SETTINGS.imageApiBaseUrl).trim(),
    imageApiKey: String(source.imageApiKey || '').trim(),
    imageModel: String(source.imageModel || DEFAULT_SETTINGS.imageModel).trim(),
    videoApiBaseUrl: String(source.videoApiBaseUrl || DEFAULT_SETTINGS.videoApiBaseUrl).trim(),
    videoApiKey: String(source.videoApiKey || '').trim(),
    videoModel: String(source.videoModel || DEFAULT_SETTINGS.videoModel).trim(),
    termGlossary: String(source.termGlossary || '').replace(/\r\n/g, '\n').slice(0, 20000),
    closeBehavior: ['tray', 'exit'].includes(source.closeBehavior) ? source.closeBehavior : DEFAULT_SETTINGS.closeBehavior,
    remoteUploadEndpoint: String(source.remoteUploadEndpoint || DEFAULT_SETTINGS.remoteUploadEndpoint).trim(),
    remoteUploadToken: String(source.remoteUploadToken || DEFAULT_SETTINGS.remoteUploadToken).trim(),
  };

  await ensureDir(path.dirname(getSettingsFilePath()));
  await fsp.writeFile(getSettingsFilePath(), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await syncSkillEnv(normalized);
  return normalized;
}

function runCommand(command, args, options = {}) {
  const { cwd, env, stageLabel } = options;
  return new Promise((resolve, reject) => {
    appendTaskLog(`$ ${command} ${args.join(' ')}`);
    if (stageLabel) setTaskState({ stage: stageLabel });

    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const bind = (stream) => {
      let pending = '';
      stream.on('data', (chunk) => {
        pending += chunk.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        lines.forEach((line) => appendTaskLog(line));
      });
      stream.on('end', () => {
        if (pending.trim()) appendTaskLog(pending.trim());
      });
    };

    bind(child.stdout);
    bind(child.stderr);

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function getNodeRunner() {
  if (app.isPackaged) {
    return {
      command: process.execPath,
      prefixArgs: [],
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  return {
    command: 'node',
    prefixArgs: [],
    extraEnv: {},
  };
}

function runNodeScript(scriptPath, scriptArgs = [], options = {}) {
  const runner = getNodeRunner();
  return runCommand(
    runner.command,
    [...runner.prefixArgs, scriptPath, ...scriptArgs],
    {
      ...options,
      env: { ...(options.env || {}), ...runner.extraEnv },
    },
  );
}

async function getDependencyStatus() {
  const settings = await loadSettings();
  const ffmpegCmd = getToolCommand('ffmpeg');
  const ffprobeCmd = getToolCommand('ffprobe');
  const whisperCandidates = getFastWhisperModelCandidates(settings);
  const bestWhisperModel = whisperCandidates[0] || null;
  const ffmpeg = spawnSync(ffmpegCmd, ['-version'], { windowsHide: true });
  const ffprobe = spawnSync(ffprobeCmd, ['-version'], { windowsHide: true });
  const python = spawnSync('python', ['--version'], { windowsHide: true });
  const runner = getNodeRunner();
  const nodeCheck = spawnSync(
    runner.command,
    [...runner.prefixArgs, '-e', 'console.log(process.version)'],
    { windowsHide: true, env: { ...process.env, ...runner.extraEnv } },
  );
  const nodeDetail = (nodeCheck.stdout.toString() || nodeCheck.stderr.toString()).trim() || runner.command;
  const llmReady = Boolean(
    String(settings.llmApiBaseUrl || '').trim()
    && String(settings.llmModel || '').trim()
    && String(settings.llmApiKey || '').trim(),
  );
  const qwenReady = Boolean(String(settings.dashscopeApiKey || '').trim());
  const mimoReady = Boolean(String(settings.mimoApiKey || '').trim());

  return {
    node: {
      ok: nodeCheck.status === 0,
      detail: nodeCheck.status === 0 ? `${nodeDetail} (${runner.command})` : '不可用',
    },
    ffmpeg: {
      ok: ffmpeg.status === 0,
      detail: ffmpeg.status === 0
        ? (getBundledToolPath('ffmpeg') ? `内置可用（${ffmpegCmd}）` : '系统可用')
        : '未install',
    },
    ffprobe: {
      ok: ffprobe.status === 0,
      detail: ffprobe.status === 0
        ? (getBundledToolPath('ffprobe') ? `内置可用（${ffprobeCmd}）` : '系统可用')
        : '未install',
    },
    python: {
      ok: true,
      detail: python.status === 0
        ? `可选（已install ${(python.stdout.toString() || python.stderr.toString()).trim()}）`
        : '可选（未install，不影响内置本地 Whisper）',
    },
    whisperModel: {
      ok: Boolean(bestWhisperModel),
      detail: bestWhisperModel
        ? `已找到可用本地语音模型：${bestWhisperModel.path}（${formatBytes(bestWhisperModel.size)}，共 ${whisperCandidates.length} 个候选）`
        : '未找到可用 Whisper/ggml 语音模型，可点击“检查模型”全盘扫描，或点击“install本地模型”下载默认模型',
    },
    llm: {
      ok: llmReady,
      detail: llmReady
        ? `已配置（${normalizeLlmProviderKey(settings.llmProvider)} | ${String(settings.llmModel || '').trim()} @ ${String(settings.llmApiBaseUrl || '').trim()}）`
        : '未完成配置（需填写 LLM 接口地址/API Key/模型名）',
    },
    qwenAsr: {
      ok: qwenReady,
      detail: qwenReady ? 'Aliyun Qwen3-ASR configured' : 'DashScope API Key missing',
    },
    mimoAsr: {
      ok: mimoReady,
      detail: mimoReady ? 'Xiaomi MiMo-V2.5-ASR configured' : 'MiMo API Key missing',
    },
  };
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

function extractLlmTestText(provider, json) {
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

function parseJsonBody(rawBody) {
  const text = String(rawBody || '').trim();
  if (!text) return { json: {}, parseError: '' };
  try {
    return { json: JSON.parse(text), parseError: '' };
  } catch (err) {
    return { json: {}, parseError: err.message || 'invalid json' };
  }
}

function llmTestPrompt(strict = false) {
  if (strict) {
    return '只返回 pong，不要任何标点或解释。';
  }
  return 'Ping. Reply with pong only.';
}

function anthropicTestBody(config, strict = false) {
  return {
    model: config.llmModel,
    max_tokens: strict ? 48 : 24,
    temperature: strict ? 0 : config.llmTemperature,
    system: strict
      ? 'Return plain text only. Output exactly: pong'
      : 'Return concise plain text only.',
    messages: [{ role: 'user', content: llmTestPrompt(strict) }],
  };
}

function openAiTestBody(config, strict = false) {
  return {
    model: config.llmModel,
    max_tokens: strict ? 48 : 24,
    temperature: strict ? 0 : config.llmTemperature,
    messages: [
      {
        role: 'system',
        content: strict
          ? 'You are a connectivity checker. Reply with exactly "pong".'
          : 'Reply with plain text only.',
      },
      { role: 'user', content: llmTestPrompt(strict) },
    ],
  };
}

function contentTypesText(json) {
  if (Array.isArray(json?.content)) {
    return json.content.map((item) => item?.type || 'unknown').join(',');
  }
  return 'none';
}

function buildLlmTestInput(payload = {}, fallbackSettings = DEFAULT_SETTINGS) {
  const provider = normalizeLlmProviderKey(payload.llmProvider || fallbackSettings.llmProvider);
  const defaultBase = provider === 'anthropic'
    ? 'https://api.anthropic.com'
    : DEFAULT_SETTINGS.llmApiBaseUrl;
  const llmApiBaseUrl = normalizeLlmBaseUrl(
    String(payload.llmApiBaseUrl || fallbackSettings.llmApiBaseUrl || defaultBase).trim(),
  );
  const llmApiKey = String(payload.llmApiKey || fallbackSettings.llmApiKey || '').trim();
  const llmModel = String(payload.llmModel || fallbackSettings.llmModel || '').trim();

  return {
    provider,
    llmApiBaseUrl,
    llmApiKey,
    llmModel,
    llmTemperature: Number.isFinite(Number(payload.llmTemperature))
      ? Math.max(0, Math.min(1.5, Number(payload.llmTemperature)))
      : (Number.isFinite(Number(fallbackSettings.llmTemperature))
        ? Math.max(0, Math.min(1.5, Number(fallbackSettings.llmTemperature)))
        : DEFAULT_SETTINGS.llmTemperature),
  };
}


async function fetchTextWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTextWithRetry(url, options = {}, retryOptions = {}) {
  const attempts = Math.max(1, Number(retryOptions.attempts) || 2);
  const timeoutMs = Math.max(3000, Number(retryOptions.timeoutMs) || 12000);
  const delayMs = Math.max(0, Number(retryOptions.delayMs) || 700);
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetchTextWithTimeout(url, options, timeoutMs);
    } catch (err) {
      lastError = err;
      if (attempt < attempts - 1 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildMimoAsrEndpoint(baseUrl = MIMO_ASR_BASE_URL) {
  const clean = String(baseUrl || MIMO_ASR_BASE_URL).trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(clean)) return clean;
  return `${clean}/chat/completions`;
}

async function fetchBinaryWithTimeout(url, timeoutMs = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function testAliyunQwenAsrConnection(settings) {
  const apiKey = String(settings.dashscopeApiKey || '').trim();
  if (!apiKey) return { ok: false, message: 'DashScope API Key 为空' };
  const started = Date.now();
  const submit = await fetchTextWithRetry('https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: QWEN_ASR_MODEL,
      input: { file_url: QWEN_ASR_TEST_AUDIO_URL },
      parameters: {
        channel_id: [0],
        language: 'zh',
        enable_itn: true,
        enable_words: true,
      },
    }),
  }, { attempts: 3, timeoutMs: 15000, delayMs: 900 });
  const submitRes = submit.res;
  const submitText = submit.text;
  const submitJson = parseJsonSafe(submitText);
  if (!submitRes.ok) {
    return { ok: false, message: `阿里 ASR 提交失败 HTTP ${submitRes.status}: ${submitText.slice(0, 240)}` };
  }
  const taskId = submitJson?.output?.task_id;
  if (!taskId) {
    return { ok: false, message: `阿里 ASR 未返回 task_id: ${submitText.slice(0, 240)}` };
  }

  let queryNote = '';
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, i === 0 ? 800 : 1500));
    try {
      const query = await fetchTextWithRetry(`https://dashscope.aliyuncs.com/api/v1/tasks/${encodeURIComponent(taskId)}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'X-DashScope-Async': 'enable',
        },
      }, { attempts: 2, timeoutMs: 10000, delayMs: 600 });
      const queryRes = query.res;
      const queryText = query.text;
      const queryJson = parseJsonSafe(queryText);
      if (!queryRes.ok) {
        queryNote = `查询接口暂时不可用 HTTP ${queryRes.status}`;
        continue;
      }
      const status = queryJson?.output?.task_status;
      if (status === 'SUCCEEDED') {
        return { ok: true, message: `阿里 Qwen3-ASR 连通成功，任务已完成（${Date.now() - started}ms）`, taskId, status };
      }
      if (status === 'FAILED' || status === 'UNKNOWN') {
        return { ok: false, message: `阿里 ASR 测试任务失败: ${JSON.stringify(queryJson?.output || queryJson).slice(0, 260)}` };
      }
      if (status) {
        return { ok: true, message: `阿里 Qwen3-ASR 连通成功，任务已提交（状态：${status}，${Date.now() - started}ms）`, taskId, status };
      }
      queryNote = '查询接口返回状态为空';
    } catch (err) {
      queryNote = `查询接口波动：${err.message || String(err)}`;
    }
  }
  return {
    ok: true,
    message: `阿里 Qwen3-ASR 连通成功，任务已提交；${queryNote || '结果仍在处理中'}（task_id=${taskId}）`,
    taskId,
  };
}

async function testVolcengineAsrConnection(settings) {
  const apiKey = String(settings.volcengineApiKey || '').trim();
  if (!apiKey) {
    return { ok: false, message: '火山引擎 API Key 为空' };
  }
  const started = Date.now();
  const submitUrl = 'https://openspeech.bytedance.com/api/v1/vc/submit?language=zh-CN&use_itn=True&use_capitalize=True&max_lines=1&words_per_line=15';
  try {
    const submit = await fetchTextWithRetry(submitUrl, {
      method: 'POST',
      headers: {
        Accept: '*/*',
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: VOLCENGINE_ASR_TEST_AUDIO_URL }),
    }, { attempts: 3, timeoutMs: 15000, delayMs: 900 });
    const submitRes = submit.res;
    const submitText = submit.text;
    const submitJson = parseJsonSafe(submitText);
    if (!submitRes.ok) {
      return { ok: false, message: `火山 ASR 提交失败 HTTP ${submitRes.status}: ${submitText.slice(0, 240)}` };
    }
    const taskId = submitJson?.id;
    if (!taskId) {
      return { ok: false, message: `火山 ASR 未返回任务 ID: ${submitText.slice(0, 240)}` };
    }

    let queryNote = '';
    for (let i = 0; i < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, i === 0 ? 800 : 1500));
      try {
        const query = await fetchTextWithRetry(`https://openspeech.bytedance.com/api/v1/vc/query?id=${encodeURIComponent(taskId)}`, {
          method: 'GET',
          headers: {
            Accept: '*/*',
            'x-api-key': apiKey,
          },
        }, { attempts: 2, timeoutMs: 10000, delayMs: 600 });
        const queryJson = parseJsonSafe(query.text);
        const code = Number(queryJson?.code);
        if (code === 0) {
          return { ok: true, message: `火山 ASR 连通成功，测试任务已完成（${Date.now() - started}ms）`, taskId, status: 'SUCCEEDED' };
        }
        if (code === 1000) {
          return { ok: true, message: `火山 ASR 连通成功，任务已提交并处理中（${Date.now() - started}ms）`, taskId, status: 'PROCESSING' };
        }
        if (Number.isFinite(code)) {
          return { ok: false, message: `火山 ASR 测试任务失败: ${query.text.slice(0, 260)}` };
        }
        queryNote = '查询接口返回状态为空';
      } catch (err) {
        queryNote = `查询接口波动：${err.message || String(err)}`;
      }
    }
    return {
      ok: true,
      message: `火山 ASR 连通成功，任务已提交；${queryNote || '结果仍在处理中'}（task_id=${taskId}）`,
      taskId,
    };
  } catch (err) {
    const uploadEndpoint = buildUploadEndpoints(settings)[0];
    if (uploadEndpoint) {
      try {
        const healthUrl = new URL(uploadEndpoint.url);
        healthUrl.pathname = healthUrl.pathname.replace(/\/api\/upload.*$/i, '/health');
        const health = await fetchTextWithRetry(healthUrl.toString(), { method: 'GET' }, { attempts: 1, timeoutMs: 5000 });
        if (health.res.ok) {
          return { ok: false, message: `火山 ASR 提交失败，但上传服务正常；请检查火山 Key 或服务额度。错误：${err.message || String(err)}` };
        }
      } catch {}
    }
    return { ok: false, message: `火山 ASR 连通失败: ${err.message || String(err)}` };
  }
}

async function testMimoAsrConnection(settings) {
  const apiKey = String(settings.mimoApiKey || '').trim();
  if (!apiKey) return { ok: false, message: 'MiMo API Key 为空' };

  const started = Date.now();
  try {
    const sample = await fetchBinaryWithTimeout(MIMO_ASR_TEST_AUDIO_URL, 15000);
    const dataUrl = `data:audio/wav;base64,${sample.toString('base64')}`;
    if (dataUrl.length > 9_800_000) {
      return { ok: false, message: 'MiMo ASR 测试音频超过 10MB 限制' };
    }

    const request = await fetchTextWithRetry(buildMimoAsrEndpoint(MIMO_ASR_BASE_URL), {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MIMO_ASR_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'input_audio',
                input_audio: { data: dataUrl },
              },
            ],
          },
        ],
        asr_options: { language: 'zh' },
        stream: false,
      }),
    }, { attempts: 2, timeoutMs: 30000, delayMs: 900 });

    const json = parseJsonSafe(request.text);
    if (!request.res.ok) {
      return { ok: false, message: `MiMo ASR 失败 HTTP ${request.res.status}: ${request.text.slice(0, 260)}` };
    }

    const content = collectTextFragments(json?.choices?.[0]?.message?.content).join('').trim();
    if (!json?.choices?.length) {
      return { ok: false, message: `MiMo ASR 未返回 choices: ${request.text.slice(0, 260)}` };
    }

    return {
      ok: true,
      message: content
        ? `MiMo-V2.5-ASR 连通成功（${Date.now() - started}ms）：${content.slice(0, 36)}`
        : `MiMo-V2.5-ASR 连通成功（${Date.now() - started}ms），但测试音频返回空文本`,
    };
  } catch (err) {
    return { ok: false, message: `MiMo ASR 连通失败: ${err.message || String(err)}` };
  }
}

async function testAsrConnection(payload = {}) {
  const settings = normalizeSettings({ ...(await loadSettings()), ...payload });
  if (settings.asrEngine === 'aliyun_qwen') return testAliyunQwenAsrConnection(settings);
  if (settings.asrEngine === 'mimo') return testMimoAsrConnection(settings);
  if (settings.asrEngine === 'volcengine') return testVolcengineAsrConnection(settings);
  const modelStatus = await getWhisperModelStatus({ scan: false });
  if (modelStatus.installed) {
    return { ok: true, message: `Local Whisper OK: ${modelStatus.modelPath || 'model found'}` };
  }
  return { ok: false, message: modelStatus.detail || 'Local Whisper model not found' };
}

async function testLlmConnection(payload = {}) {
  const settings = await loadSettings();
  const config = buildLlmTestInput(payload, settings);
  const missing = [];
  if (!config.llmApiBaseUrl) missing.push('LLM 接口地址');
  if (!config.llmApiKey) missing.push('LLM API Key');
  if (!config.llmModel) missing.push('LLM 模型名');
  if (missing.length) {
    return {
      ok: false,
      provider: config.provider,
      endpoint: '',
      model: config.llmModel,
      latencyMs: 0,
      message: `配置不完整：缺少 ${missing.join(' / ')}`,
      statusCode: 0,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const startedAt = Date.now();

  try {
    const attempts = [false, true];
    const retryableCodes = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
    let lastMeta = {
      endpoint: config.provider === 'anthropic'
        ? buildAnthropicMessagesEndpoint(config.llmApiBaseUrl)
        : buildOpenAiCompletionsEndpoint(config.llmApiBaseUrl),
      statusCode: 0,
      json: {},
    };

    for (let i = 0; i < attempts.length; i += 1) {
      const strict = attempts[i];
      const endpoint = config.provider === 'anthropic'
        ? buildAnthropicMessagesEndpoint(config.llmApiBaseUrl)
        : buildOpenAiCompletionsEndpoint(config.llmApiBaseUrl);

      const reqInit = config.provider === 'anthropic'
        ? {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.llmApiKey,
            'anthropic-version': process.env.ANTHROPIC_API_VERSION || '2023-06-01',
          },
          body: JSON.stringify(anthropicTestBody(config, strict)),
          signal: controller.signal,
        }
        : {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.llmApiKey}`,
          },
          body: JSON.stringify(openAiTestBody(config, strict)),
          signal: controller.signal,
        };

      const res = await fetch(endpoint, reqInit);
      const rawBody = await res.text();
      const { json, parseError } = parseJsonBody(rawBody);
      const latencyMs = Date.now() - startedAt;
      lastMeta = { endpoint, statusCode: res.status, json };

      if (!res.ok) {
        if (i < attempts.length - 1 && retryableCodes.has(res.status)) {
          continue;
        }
        const errMessage = parseAssistantContent(json?.error?.message || json?.error || '').trim();
        return {
          ok: false,
          provider: config.provider,
          endpoint,
          model: config.llmModel,
          latencyMs,
          message: `连接失败：HTTP ${res.status} ${(errMessage || rawBody).slice(0, 180)}`,
          statusCode: res.status,
        };
      }

      if (parseError) {
        return {
          ok: false,
          provider: config.provider,
          endpoint,
          model: config.llmModel,
          latencyMs,
          message: `连接失败：接口返回非 JSON（${parseError}）`,
          statusCode: res.status,
        };
      }

      const responseError = parseAssistantContent(json?.error?.message || json?.error || '').trim();
      if (responseError) {
        return {
          ok: false,
          provider: config.provider,
          endpoint,
          model: config.llmModel,
          latencyMs,
          message: `连接失败：${responseError.slice(0, 180)}`,
          statusCode: res.status,
        };
      }

      const text = extractLlmTestText(config.provider, json);
      if (text) {
        return {
          ok: true,
          provider: config.provider,
          endpoint,
          model: config.llmModel,
          latencyMs,
          message: `已连接（${latencyMs}ms）`,
          statusCode: res.status,
        };
      }
    }

    const latencyMs = Date.now() - startedAt;
    return {
      ok: true,
      warning: 'empty_text',
      provider: config.provider,
      endpoint: lastMeta.endpoint,
      model: config.llmModel,
      latencyMs,
      message:
        `已连通（${latencyMs}ms），但模型未返回可见文本。` +
        `建议检查模型权限或端点响应格式（stop_reason=${lastMeta.json?.stop_reason || 'unknown'}, content_types=${contentTypesText(lastMeta.json)}）`,
      statusCode: Number(lastMeta.statusCode) || 200,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    return {
      ok: false,
      provider: config.provider,
      endpoint: config.provider === 'anthropic'
        ? buildAnthropicMessagesEndpoint(config.llmApiBaseUrl)
        : buildOpenAiCompletionsEndpoint(config.llmApiBaseUrl),
      model: config.llmModel,
      latencyMs,
      message: `连接异常：${err.message || String(err)}`,
      statusCode: 0,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeName(name) {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'video';
}

function datePrefix() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function uploadAudioToUguu(filePath) {
  const fileData = await fsp.readFile(filePath);
  const fileName = path.basename(filePath);
  const failures = [];
  const settings = await loadSettings();
  const endpoints = buildUploadEndpoints(settings);

  for (const endpoint of endpoints) {
    for (let attempt = 1; attempt <= TEMP_UPLOAD_RETRY_PER_ENDPOINT; attempt += 1) {
      try {
        appendTaskLog(`上传尝试：${endpoint.name}（${attempt}/${TEMP_UPLOAD_RETRY_PER_ENDPOINT}）`);
        const result = await uploadAudioToEndpoint(endpoint, fileData, fileName);
        appendTaskLog(`上传成功：${endpoint.name}`);
        return result;
      } catch (err) {
        const msg = err?.message || String(err);
        failures.push(`${endpoint.name}#${attempt} ${msg}`);
        appendTaskLog(`上传失败：${endpoint.name}（${attempt}/${TEMP_UPLOAD_RETRY_PER_ENDPOINT}）- ${msg}`);
        if (attempt < TEMP_UPLOAD_RETRY_PER_ENDPOINT) {
          await waitMs(TEMP_UPLOAD_RETRY_BACKOFF_MS * attempt);
        }
      }
    }
  }

  const detail = failures.slice(0, 6).join(' | ');
  throw new Error(
    `临时上传服务不可用（并非火山接口本身失败）。请稍后重试，或切换“本地 Whisper”。详情：${detail || 'unknown'}`,
  );
}

function parseUploadResponse(endpoint, bodyText) {
  const text = String(bodyText || '').trim();
  if (!text) {
    throw new Error('响应为空');
  }

  if (endpoint.parser === 'json_files_url') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`返回非 JSON（${text.slice(0, 120)}）`);
    }
    const url = parsed?.files?.[0]?.url;
    if (!url) {
      throw new Error(`缺少文件 URL（${text.slice(0, 120)}）`);
    }
    return url;
  }

  if (endpoint.parser === 'json_url') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`返回非 JSON（${text.slice(0, 120)}）`);
    }
    const url = parsed?.url || parsed?.data?.url;
    if (!url || !/^https?:\/\/\S+$/i.test(String(url))) {
      throw new Error(`缺少文件 URL（${text.slice(0, 120)}）`);
    }
    return String(url);
  }

  if (endpoint.parser === 'plain_url') {
    const firstLine = text.split(/\r?\n/)[0].trim();
    const match = firstLine.match(/^https?:\/\/\S+$/i);
    if (!match) {
      throw new Error(`返回结果不包含 URL（${text.slice(0, 120)}）`);
    }
    return firstLine;
  }

  throw new Error(`未支持的响应解析器：${endpoint.parser}`);
}

function buildUploadEndpoints(settings = DEFAULT_SETTINGS) {
  const endpoints = [];
  const endpointUrl = String(settings.remoteUploadEndpoint || DEFAULT_SETTINGS.remoteUploadEndpoint || '').trim();
  const token = String(settings.remoteUploadToken || DEFAULT_SETTINGS.remoteUploadToken || '').trim();
  if (endpointUrl) {
    endpoints.push({
      name: 'Jaygo Cut 文件服务',
      url: endpointUrl,
      fileField: 'file',
      parser: 'json_url',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }
  return [...endpoints, ...TEMP_UPLOAD_ENDPOINTS];
}

async function assertUploadedUrlReachable(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new Error(`URL 校验失败 HTTP ${res.status}`);
    }
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('URL 校验超时');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function uploadAudioToEndpoint(endpoint, fileData, fileName) {
  const form = new FormData();
  const extraFields = endpoint.extraFields || {};
  for (const [key, value] of Object.entries(extraFields)) {
    form.append(key, String(value));
  }
  form.append(endpoint.fileField, new Blob([fileData]), fileName);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEMP_UPLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      body: form,
      signal: controller.signal,
      redirect: 'follow',
      headers: endpoint.headers || {},
    });
    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${bodyText.slice(0, 120)}`);
    }
    const uploadedUrl = parseUploadResponse(endpoint, bodyText);
    await assertUploadedUrlReachable(uploadedUrl);
    return uploadedUrl;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`请求超时（>${Math.floor(TEMP_UPLOAD_TIMEOUT_MS / 1000)}秒）`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 8899;
      server.close(() => resolve(port));
    });
  });
}

function startReviewServer(projectReviewDir, videoPath, outputRoot, port, runtimeEnv = {}) {
  const script = path.join(SCRIPTS_DIR, 'review_server.js');
  const runner = getNodeRunner();
  const args = [...runner.prefixArgs, script, String(port), videoPath, outputRoot];

  const child = spawn(runner.command, args, {
    cwd: projectReviewDir,
    env: { ...process.env, ...runner.extraEnv, ...runtimeEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const bind = (stream) => {
    let pending = '';
    stream.on('data', (chunk) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      lines.forEach((line) => appendTaskLog(`[review-server] ${line}`));
    });
  };

  bind(child.stdout);
  bind(child.stderr);

  child.on('exit', (code) => {
    appendTaskLog(`[review-server] exited with code ${code}`);
    if (activeTask && activeTask.reviewServer === child) {
      activeTask.reviewServer = null;
    }
  });
  child.on('error', (err) => {
    appendTaskLog(`[review-server] start error: ${err.message}`);
  });

  return child;
}

function pickReviewAudioFile(reviewDir) {
  const candidates = ['audio.wav', 'audio.mp3', 'audio.m4a'];
  for (const name of candidates) {
    const full = path.join(reviewDir, name);
    if (fs.existsSync(full)) return name;
  }
  return 'audio.wav';
}

async function rebuildReviewHtml(reviewDir, runtimeEnv) {
  const subtitles = path.join(reviewDir, 'subtitles_words.json');
  const subtitlesBad = path.join(reviewDir, 'subtitles_words.bad.json');
  if (!fs.existsSync(subtitles) && fs.existsSync(subtitlesBad)) {
    await copyFileSafe(subtitlesBad, subtitles);
    appendTaskLog('检测到 subtitles_words.json 缺失，已从 subtitles_words.bad.json 自动恢复。');
  }
  if (!fs.existsSync(subtitles)) {
    throw new Error(`审核目录缺少subtitles文件：${subtitles}`);
  }

  await runNodeScript(
    path.join(SCRIPTS_DIR, 'generate_review.js'),
    ['subtitles_words.json', 'auto_selected.json', pickReviewAudioFile(reviewDir)],
    {
      cwd: reviewDir,
      env: runtimeEnv,
      stageLabel: 'generate_review',
    },
  );
}

async function waitForReviewServerReady(port) {
  const url = `http://localhost:${port}/api/runtime-info`;
  const started = Date.now();

  while (Date.now() - started < 30000) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error('审核服务 30 秒内未启动成功');
}

async function isUrlReady(url) {
  if (!url) return false;
  const base = String(url).replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/api/runtime-info`);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureActiveReviewServer() {
  if (!activeTask) {
    throw new Error('当前没有可用任务');
  }
  if (!activeTask.reviewDir || !activeTask.videoPath || !activeTask.outputRoot) {
    throw new Error('审核服务上下文不完整，请重新执行完整流程');
  }

  if (await isUrlReady(activeTask.reviewUrl)) {
    return activeTask.reviewUrl;
  }

  stopServerProc(activeTask.reviewServer);

  const port = await getFreePort();
  const settings = await loadSettings();
  const runtimeEnv = buildRuntimeEnv(settings);
  await rebuildReviewHtml(activeTask.reviewDir, runtimeEnv);
  const reviewServer = startReviewServer(
    activeTask.reviewDir,
    activeTask.videoPath,
    activeTask.outputRoot,
    port,
    runtimeEnv,
  );
  activeTask.reviewServer = reviewServer;

  await waitForReviewServerReady(port);
  const url = `http://localhost:${port}`;
  setTaskState({ reviewUrl: url, reviewPort: port });
  appendTaskLog(`审核服务已恢复：${url}`);
  return url;
}

async function copyFileSafe(src, dest) {
  await ensureDir(path.dirname(dest));
  await fsp.copyFile(src, dest);
}

async function runWorkflow(input) {
  const settings = await loadSettings();
  const runtimeEnv = buildRuntimeEnv(settings);
  const videoPath = input.videoPath || settings.lastVideoPath;
  if (!videoPath) throw new Error('请先选择视频文件');
  if (!fs.existsSync(videoPath)) throw new Error(`视频文件不存在：${videoPath}`);

  const outputRoot = input.outputRoot || settings.outputRoot;
  await ensureDir(outputRoot);

  const baseName = sanitizeName(path.parse(videoPath).name);
  const projectRoot = path.join(outputRoot, `${datePrefix()}_${baseName}`);
  const clipRoot = path.join(projectRoot, CLIP_DIR_NAME);
  const transcribeDir = path.join(clipRoot, CLIP_TRANSCRIBE_DIR);
  const analysisDir = path.join(clipRoot, CLIP_ANALYSIS_DIR);
  const reviewDir = path.join(clipRoot, CLIP_REVIEW_DIR);

  await ensureDir(transcribeDir);
  await ensureDir(analysisDir);
  await ensureDir(reviewDir);

  setTaskState({
    projectDir: projectRoot,
    outputRoot,
    reviewDir,
    videoPath,
    stage: 'extract_audio',
  });
  appendTaskLog(`Project directory: ${projectRoot}`);

  const audioWav = path.join(transcribeDir, 'audio.wav');
  const timelineJson = path.join(transcribeDir, 'audio_timeline.json');
  await runNodeScript(path.join(SCRIPTS_DIR, 'extract_review_audio.js'), [videoPath, audioWav, timelineJson], {
    cwd: transcribeDir,
    env: runtimeEnv,
    stageLabel: 'extract_audio',
  });

  if (settings.asrEngine === 'mimo') {
    if (!settings.mimoApiKey) {
      throw new Error('MiMo API Key 为空，请先在设置中填写 Token Plan 密匙');
    }
    const audioMp3 = path.join(transcribeDir, 'audio_mimo.mp3');
    await runCommand(getToolCommand('ffmpeg'), ['-y', '-i', audioWav, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', audioMp3], {
      cwd: transcribeDir,
      env: runtimeEnv,
      stageLabel: 'prepare_upload',
    });
    await runNodeScript(path.join(SCRIPTS_DIR, 'mimo_asr_transcribe.js'), [audioMp3], {
      cwd: transcribeDir,
      env: runtimeEnv,
      stageLabel: 'transcribe_remote',
    });
  } else if (settings.asrEngine === 'volcengine' || settings.asrEngine === 'aliyun_qwen') {
    const isAliyunQwen = settings.asrEngine === 'aliyun_qwen';
    if (!settings.volcengineApiKey) {
      if (!isAliyunQwen) throw new Error('火山引擎 API Key 为空，请先在设置中填写');
    }
    if (isAliyunQwen && !settings.dashscopeApiKey) {
      throw new Error('阿里云 DashScope API Key 为空，请先在设置中填写');
    }

    const audioMp3 = path.join(transcribeDir, 'audio.mp3');
    await runCommand(getToolCommand('ffmpeg'), ['-y', '-i', audioWav, '-vn', '-acodec', 'libmp3lame', audioMp3], {
      cwd: transcribeDir,
      env: runtimeEnv,
      stageLabel: 'prepare_upload',
    });

    setTaskState({ stage: 'upload_audio' });
    appendTaskLog('正在上传音频到 Jaygo Cut 文件服务（用于火山引擎转写）...');
    const audioUrl = await uploadAudioToUguu(audioMp3);
    appendTaskLog(`上传地址：${audioUrl}`);

    if (isAliyunQwen) {
      await runNodeScript(path.join(SCRIPTS_DIR, 'qwen_asr_transcribe.js'), [audioUrl], {
        cwd: transcribeDir,
        env: runtimeEnv,
        stageLabel: 'transcribe_remote',
      });
    } else {
      await runNodeScript(path.join(SCRIPTS_DIR, 'volcengine_transcribe.js'), [audioUrl], {
        cwd: transcribeDir,
        env: runtimeEnv,
        stageLabel: 'transcribe_remote',
      });

      await runNodeScript(path.join(SCRIPTS_DIR, 'generate_subtitles.js'), ['volcengine_result.json'], {
        cwd: transcribeDir,
        env: runtimeEnv,
        stageLabel: 'build_subtitles',
      });
    }
  } else {
    if (!runtimeEnv.WHISPER_MODEL || !fs.existsSync(runtimeEnv.WHISPER_MODEL)) {
      throw new Error(
        '本地 Whisper 模型缺失，请先在设置里点击“检查模型”扫描电脑，或点击“install本地模型”，也可以切换为火山引擎/阿里 Qwen3-ASR 云端转录',
      );
    }

    await runNodeScript(path.join(SCRIPTS_DIR, 'whisper_transcribe_local.js'), [audioWav], {
      cwd: transcribeDir,
      env: runtimeEnv,
      stageLabel: 'transcribe_local',
    });
  }

  const subtitlesFile = path.join(transcribeDir, 'subtitles_words.json');
  if (!fs.existsSync(subtitlesFile)) {
    throw new Error('未生成 subtitles_words.json');
  }

  const analysisSubtitles = path.join(analysisDir, 'subtitles_words.json');
  const analysisAutoSelected = path.join(analysisDir, 'auto_selected.json');
  await copyFileSafe(subtitlesFile, analysisSubtitles);

  await runNodeScript(AUTO_SELECT_SCRIPT, [analysisSubtitles, analysisAutoSelected, String(settings.silenceThresholdSec || 0.2)], {
    cwd: analysisDir,
    env: runtimeEnv,
    stageLabel: 'auto_select_silence',
  });

  await copyFileSafe(analysisSubtitles, path.join(reviewDir, 'subtitles_words.json'));
  await copyFileSafe(analysisAutoSelected, path.join(reviewDir, 'auto_selected.json'));
  await copyFileSafe(audioWav, path.join(reviewDir, 'audio.wav'));
  if (fs.existsSync(timelineJson)) {
    await copyFileSafe(timelineJson, path.join(reviewDir, 'audio_timeline.json'));
  }

  await runNodeScript(path.join(SCRIPTS_DIR, 'generate_review.js'), ['subtitles_words.json', 'auto_selected.json', 'audio.wav'], {
    cwd: reviewDir,
    env: runtimeEnv,
    stageLabel: 'generate_review',
  });

  const port = await getFreePort();
  setTaskState({ stage: 'start_review_server' });
  const reviewServer = startReviewServer(reviewDir, videoPath, outputRoot, port, runtimeEnv);
  activeTask.reviewServer = reviewServer;

  await waitForReviewServerReady(port);
  const reviewUrl = `http://localhost:${port}`;
  setTaskState({
    state: 'completed',
    stage: 'completed',
    reviewUrl,
    reviewPort: port,
    finishedAt: nowIso(),
  });
  appendTaskLog(`审核页面已就绪：${reviewUrl}`);

  await addHistoryEntry({
    id: `${Date.now()}`,
    finishedAt: nowIso(),
    videoPath,
    outputRoot,
    projectDir: projectRoot,
    reviewDir,
    reviewUrl,
    asrEngine: settings.asrEngine,
    silenceThresholdSec: Number(settings.silenceThresholdSec) || 0.2,
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray && !tray.isDestroyed?.()) return true;
  try {
    tray = new Tray(getAppIconPath());
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: '打开 Jaygo Cut',
        click: () => showMainWindow(),
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]));
    tray.on('double-click', () => showMainWindow());
    tray.on('click', () => showMainWindow());
    return true;
  } catch (err) {
    console.warn('Failed to create tray:', err.message);
    tray = null;
    return false;
  }
}

async function rememberCloseBehavior(closeBehavior) {
  const settings = await loadSettings();
  await saveSettings({ ...settings, closeBehavior });
}

async function handleMainWindowClose(event) {
  if (isQuitting) return;
  event.preventDefault();
  if (isHandlingMainWindowClose) return;
  isHandlingMainWindowClose = true;
  try {
    const settings = await loadSettings();
    if (settings.closeBehavior === 'exit') {
      isQuitting = true;
      app.quit();
      return;
    }
    if (settings.closeBehavior === 'tray') {
      if (createTray()) {
        mainWindow.hide();
      } else {
        isQuitting = true;
        app.quit();
      }
      return;
    }

    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: APP_NAME,
      message: '关闭窗口后要如何处理？',
      detail: '你的选择会被永久记住。以后可以从系统托盘菜单退出应用。',
      buttons: ['在托盘继续运行', '直接退出', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });

    if (result.response === 2) return;
    if (result.response === 0) {
      await rememberCloseBehavior('tray');
      if (createTray()) {
        mainWindow.hide();
      } else {
        await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: APP_NAME,
          message: '托盘初始化失败，本次将直接退出应用。',
          buttons: ['确定'],
          noLink: true,
        });
        await rememberCloseBehavior('exit');
        isQuitting = true;
        app.quit();
      }
      return;
    }

    await rememberCloseBehavior('exit');
    isQuitting = true;
    app.quit();
  } finally {
    isHandlingMainWindowClose = false;
  }
}

function createMainWindow() {
  const iconPath = getAppIconPath();
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    title: APP_NAME,
    icon: iconPath,
    autoHideMenuBar: true,
    backgroundColor: '#f6f8fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    mainWindow.setIcon(iconPath);
  } catch {}
  mainWindow.removeMenu();
  mainWindow.on('close', (event) => {
    handleMainWindowClose(event).catch((err) => {
      console.error('Failed to handle main window close:', err);
      isQuitting = true;
      app.quit();
    });
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function openReviewWindow(url) {
  if (!url) return;
  if (reviewWindow && !reviewWindow.isDestroyed()) {
    reviewWindow.loadURL(url);
    reviewWindow.focus();
    return;
  }

  const iconPath = getAppIconPath();
  reviewWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    title: `${APP_NAME} - 审核`,
    icon: iconPath,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    reviewWindow.setIcon(iconPath);
  } catch {}
  reviewWindow.removeMenu();
  reviewWindow.loadURL(url);
}

function stopServerProc(proc) {
  if (proc && !proc.killed) {
    proc.kill('SIGTERM');
  }
}


function findFirstExistingDir(candidates) {
  for (const dir of candidates) {
    if (dir && fs.existsSync(dir)) return dir;
  }
  return '';
}

function findReviewDirUnder(projectDir) {
  if (!projectDir || !fs.existsSync(projectDir)) return '';
  const allDirs = [];
  const queue = [projectDir];
  let scanned = 0;
  while (queue.length && scanned < 300) {
    const dir = queue.shift();
    scanned += 1;
    allDirs.push(dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of entries) {
      if (item.isDirectory()) queue.push(path.join(dir, item.name));
    }
  }

  for (const dir of allDirs) {
    if (fs.existsSync(path.join(dir, 'review.html'))) return dir;
  }
  for (const dir of allDirs) {
    const hasSubtitles = fs.existsSync(path.join(dir, 'subtitles_words.json')) || fs.existsSync(path.join(dir, 'subtitles_words.bad.json'));
    const hasAudio = ['audio.wav', 'audio.mp3', 'audio.m4a'].some((name) => fs.existsSync(path.join(dir, name)));
    if (hasSubtitles && hasAudio) return dir;
  }
  return '';
}

function resolveHistoryReviewDir(entry) {
  const direct = findFirstExistingDir([entry?.reviewDir]);
  if (direct) return direct;
  const projectDir = findFirstExistingDir([entry?.projectDir]);
  const candidate = findFirstExistingDir([
    projectDir ? path.join(projectDir, 'talkcut', '3_review') : '',
    projectDir ? path.join(projectDir, '剪口播', '3_审核') : '',
  ]);
  if (candidate) return candidate;
  return findReviewDirUnder(projectDir);
}

function resolveHistoryVideoPath(entry, reviewDir) {
  if (entry?.videoPath && fs.existsSync(entry.videoPath)) return entry.videoPath;
  const runtimeInfo = path.join(reviewDir || '', 'runtime_info.json');
  if (fs.existsSync(runtimeInfo)) {
    try {
      const data = JSON.parse(fs.readFileSync(runtimeInfo, 'utf8'));
      if (data.videoPath && fs.existsSync(data.videoPath)) return data.videoPath;
    } catch {}
  }
  return entry?.videoPath || '';
}

async function resumeReviewFromHistory(entry) {
  const plan = buildHistoryReviewResumePlan(entry);

  stopServerProc(standaloneReviewServer);

  const port = await getFreePort();
  const runtimeEnv = buildRuntimeEnv(await loadSettings());
  if (!plan.videoExists) {
    runtimeEnv.JAYGO_REVIEW_VIDEO_MISSING = '1';
    runtimeEnv.JAYGO_REVIEW_VIDEO_MISSING_MESSAGE = plan.warning;
  }
  await rebuildReviewHtml(plan.reviewDir, runtimeEnv);
  standaloneReviewServer = startReviewServer(
    plan.reviewDir,
    plan.videoPath || '',
    plan.outputRoot,
    port,
    runtimeEnv,
  );

  await waitForReviewServerReady(port);
  const url = `http://localhost:${port}`;
  openReviewWindow(url);
  return { url, warning: plan.warning, canCut: plan.canCut };
}

function cleanupReviewServer() {
  stopServerProc(activeTask?.reviewServer);
  stopServerProc(standaloneReviewServer);
}

app.whenReady().then(async () => {
  app.setName(APP_NAME);
  app.setAppUserModelId(APP_ID);
  createMainWindow();

  ipcMain.handle('settings:get', async () => loadSettings());
  ipcMain.handle('settings:save', async (_event, settings) => saveSettings(settings));

  ipcMain.handle('dialog:pick-video', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择视频文件',
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'mkv'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:pick-output', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择输出目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('deps:check', () => getDependencyStatus());
  ipcMain.handle('llm:test', async (_event, payload) => testLlmConnection(payload));
  ipcMain.handle('asr:test', async (_event, payload) => testAsrConnection(payload));
  ipcMain.handle('task:get', () => taskSnapshot());
  ipcMain.handle('history:get', async () => loadHistoryWithHealth());
  ipcMain.handle('history:delete', async (_event, entry) => deleteHistoryEntry(entry));
  ipcMain.handle('history:relink-video', async (_event, entry) => relinkHistoryEntryVideo(entry));
  ipcMain.handle('history:open-project', async (_event, entry) => {
    const dir = entry?.projectDir;
    if (!dir) throw new Error('历史记录无效');
    await shell.openPath(dir);
    return dir;
  });
  ipcMain.handle('history:resume-review', async (_event, entry) => resumeReviewFromHistory(entry));
  ipcMain.handle('update:get-state', () => updateSnapshot());
  ipcMain.handle('update:check', async () => checkForAppUpdates({ manual: true }));
  ipcMain.handle('update:download', async () => {
    if (!configureAutoUpdater() || !autoUpdater) return updateSnapshot();
    if (!app.isPackaged) {
      setUpdateState({
        status: 'unavailable',
        message: '开发模式不下载更新，打包install后生效',
        canDownload: false,
        canInstall: false,
      });
      return updateSnapshot();
    }
    setUpdateState({
      status: 'downloading',
      message: '开始下载更新...',
      canDownload: false,
      canInstall: false,
      progress: 0,
    });
    await autoUpdater.downloadUpdate();
    return updateSnapshot();
  });
  ipcMain.handle('update:install', () => {
    if (!configureAutoUpdater() || !autoUpdater) return updateSnapshot();
    if (!updateState.canInstall) return updateSnapshot();
    autoUpdater.quitAndInstall(false, true);
    return updateSnapshot();
  });
  ipcMain.handle('model:status', (_event, options) => getWhisperModelStatus(options));
  ipcMain.handle('model:scan', () => getWhisperModelStatus({ scan: true }));
  ipcMain.handle('model:install', async () => installWhisperModel());

  ipcMain.handle('task:start', async (_event, input) => {
    if (activeTask && activeTask.state === 'running') {
      throw new Error('已有任务正在运行');
    }
    cleanupReviewServer();
    if (activeTask) {
      activeTask.reviewServer = null;
    }

    const settings = await loadSettings();
    const nextSettings = {
      ...settings,
      lastVideoPath: input.videoPath || settings.lastVideoPath,
    };
    await saveSettings(nextSettings);

    activeTask = {
      id: `${Date.now()}`,
      state: 'running',
      stage: 'queued',
      startedAt: nowIso(),
      finishedAt: null,
      error: '',
      reviewUrl: '',
      reviewPort: null,
      projectDir: '',
      reviewDir: '',
      videoPath: '',
      outputRoot: '',
      outputVideoPath: '',
      logs: [],
      reviewServer: null,
    };
    pushTaskUpdate();

    try {
      await runWorkflow(input || {});
      pushTaskUpdate();
      return taskSnapshot();
    } catch (err) {
      setTaskState({
        state: 'failed',
        stage: 'failed',
        finishedAt: nowIso(),
        error: err.message,
      });
      appendTaskLog(`ERROR: ${err.message}`);
      throw err;
    }
  });

  ipcMain.handle('task:open-review', async () => {
    const url = await ensureActiveReviewServer();
    openReviewWindow(url);
    return url;
  });

  ipcMain.handle('task:open-folder', async () => {
    const dir = activeTask?.projectDir;
    if (!dir) throw new Error('项目目录尚未就绪');
    await shell.openPath(dir);
    return dir;
  });
  setTimeout(() => {
    checkForAppUpdates({ manual: false }).catch(() => {});
  }, 5000);
});

app.on('before-quit', () => {
  isQuitting = true;
  cleanupReviewServer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  showMainWindow();
});
