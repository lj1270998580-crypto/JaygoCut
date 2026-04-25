const $ = (id) => document.getElementById(id);

const els = {
  volcengineApiKey: $('volcengineApiKey'),
  dashscopeApiKey: $('dashscopeApiKey'),
  asrEngine: $('asrEngine'),
  themeMode: $('themeMode'),
  llmProvider: $('llmProvider'),
  llmApiBaseUrl: $('llmApiBaseUrl'),
  llmApiKey: $('llmApiKey'),
  llmModel: $('llmModel'),
  llmTemperature: $('llmTemperature'),
  testLlm: $('testLlm'),
  llmConnState: $('llmConnState'),
  testAsr: $('testAsr'),
  asrConnState: $('asrConnState'),
  outputRoot: $('outputRoot'),
  silenceThresholdSec: $('silenceThresholdSec'),
  exportQuality: $('exportQuality'),
  videoPath: $('videoPath'),
  depsOutput: $('depsOutput'),
  taskState: $('taskState'),
  taskStage: $('taskStage'),
  reviewUrl: $('reviewUrl'),
  projectDir: $('projectDir'),
  taskLogs: $('taskLogs'),
  historyList: $('historyList'),
  startTask: $('startTask'),
  openReview: $('openReview'),
  openFolder: $('openFolder'),
  toggleSettings: $('toggleSettings'),
  settingsBody: $('settingsBody'),
  quickAsrEngine: $('quickAsrEngine'),
  quickThemeMode: $('quickThemeMode'),
  updateStatus: $('updateStatus'),
  updateCurrentVersion: $('updateCurrentVersion'),
  updateLatestVersion: $('updateLatestVersion'),
  updateProgressBar: $('updateProgressBar'),
  updateMessage: $('updateMessage'),
  checkUpdate: $('checkUpdate'),
  downloadUpdate: $('downloadUpdate'),
  installUpdate: $('installUpdate'),
  checkWhisperModel: $('checkWhisperModel'),
  installWhisperModel: $('installWhisperModel'),
  modelInstallState: $('modelInstallState'),
  modelProgressBar: $('modelProgressBar'),
  modelInstallHint: $('modelInstallHint'),
};


function requireElementsReady() {
  const required = [
    'volcengineApiKey', 'dashscopeApiKey', 'asrEngine',
    'themeMode', 'outputRoot', 'silenceThresholdSec', 'exportQuality', 'videoPath',
    'taskState', 'taskStage', 'reviewUrl', 'projectDir', 'taskLogs',
    'historyList', 'startTask', 'openReview', 'openFolder',
  ];
  const missing = required.filter((key) => !els[key]);
  if (missing.length) {
    throw new Error(`初始化失败：缺少页面元素 ${missing.join(', ')}`);
  }
}

let historyCache = [];
let settingsCache = {};
let isApplyingLlmPreset = false;
let llmAutoTimer = null;
let llmTestSeq = 0;
let asrTestSeq = 0;
let llmLastFingerprint = '';
let systemThemeMediaQuery = null;
let removeSystemThemeListener = null;
const SETTINGS_COLLAPSE_KEY = 'jaygo.settings.collapsed';

const ASR_MODE_LABELS = {
  volcengine: '火山引擎（云端）',
  aliyun_qwen: '阿里 Qwen3-ASR（云端）',
  local: '本地 Whisper（按需install）',
};

const THEME_MODE_LABELS = {
  light: '浅色',
  blackgold: '黑金模式',
  system: '跟随系统',
};

const STATE_LABELS = {
  idle: '空闲',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
};

const STAGE_LABELS = {
  queued: '排队中',
  extract_audio: '提取音频',
  prepare_upload: '准备上传',
  upload_audio: '上传音频',
  transcribe_remote: '云端转录',
  transcribe_local: '本地转录',
  build_subtitles: '生成subtitles',
  auto_select_silence: '自动选择静音段',
  generate_review: '生成审核页',
  start_review_server: '启动审核服务',
  completed: '完成',
  failed: '失败',
};

const UPDATE_STATUS_LABELS = {
  idle: '\u672a\u68c0\u67e5',
  checking: '\u68c0\u67e5\u4e2d',
  available: '\u6709\u65b0\u7248\u672c',
  'not-available': '\u5df2\u662f\u6700\u65b0',
  downloading: '\u4e0b\u8f7d\u4e2d',
  downloaded: '\u5df2\u4e0b\u8f7d',
  error: '\u66f4\u65b0\u5931\u8d25',
  unavailable: '\u4e0d\u53ef\u7528',
};

const LLM_PROVIDER_PRESETS = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-20250514',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4',
  },
  openclaw: {
    baseUrl: 'http://127.0.0.1:3456/v1',
    model: 'claude-sonnet-4',
  },
  xai: {
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-3-mini',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
  },
  together: {
    baseUrl: 'https://api.together.xyz/v1',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  moonshot: {
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
  },
  zhipu: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-plus',
  },
  volcengine_ark: {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: '请填写你的 endpoint-id',
  },
  siliconflow: {
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
  },
  custom: {
    baseUrl: '',
    model: '',
  },
};

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

function bindSystemThemeListener(mode) {
  if (removeSystemThemeListener) {
    removeSystemThemeListener();
    removeSystemThemeListener = null;
  }
  if (normalizeThemeMode(mode) !== 'system' || !window.matchMedia) return;

  systemThemeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => applyTheme('system');
  if (systemThemeMediaQuery.addEventListener) {
    systemThemeMediaQuery.addEventListener('change', handler);
    removeSystemThemeListener = () => systemThemeMediaQuery.removeEventListener('change', handler);
  } else if (systemThemeMediaQuery.addListener) {
    systemThemeMediaQuery.addListener(handler);
    removeSystemThemeListener = () => systemThemeMediaQuery.removeListener(handler);
  }
}

function setSettingsCollapsed(collapsed, opts = {}) {
  const shouldCollapse = Boolean(collapsed);
  if (els.settingsBody) {
    els.settingsBody.hidden = shouldCollapse;
  }
  if (els.toggleSettings) {
    els.toggleSettings.textContent = shouldCollapse ? '展开' : '收起';
    els.toggleSettings.setAttribute('aria-expanded', shouldCollapse ? 'false' : 'true');
  }

  if (opts.persist !== false) {
    localStorage.setItem(SETTINGS_COLLAPSE_KEY, shouldCollapse ? '1' : '0');
  }
}

function loadSettingsCollapsed() {
  const stored = localStorage.getItem(SETTINGS_COLLAPSE_KEY);
  if (stored === null) {
    // 默认收起，减少主界面占用。
    setSettingsCollapsed(true, { persist: false });
    return;
  }
  setSettingsCollapsed(stored === '1', { persist: false });
}

function refreshSettingsQuick() {
  if (els.quickAsrEngine) {
    const key = els.asrEngine?.value || 'volcengine';
    els.quickAsrEngine.textContent = ASR_MODE_LABELS[key] || key;
  }
  if (els.quickThemeMode) {
    const key = normalizeThemeMode(els.themeMode?.value || 'light');
    els.quickThemeMode.textContent = THEME_MODE_LABELS[key] || key;
  }
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setLogs(lines) {
  els.taskLogs.textContent = Array.isArray(lines) ? lines.join('\n') : '';
  els.taskLogs.scrollTop = els.taskLogs.scrollHeight;
}

function setTask(data) {
  if (!data) {
    els.taskState.textContent = STATE_LABELS.idle;
    els.taskStage.textContent = '-';
    els.reviewUrl.textContent = '-';
    els.projectDir.textContent = '-';
    setLogs([]);
    setBusy(false);
    return;
  }

  els.taskState.textContent = STATE_LABELS[data.state] || data.state || '-';
  els.taskStage.textContent = STAGE_LABELS[data.stage] || data.stage || '-';
  els.reviewUrl.textContent = data.reviewUrl || '-';
  els.projectDir.textContent = data.projectDir || '-';
  setLogs(data.logs || []);
  setBusy(data.state === 'running');
}

function setBusy(isBusy) {
  els.startTask.disabled = isBusy;
  els.startTask.textContent = isBusy ? '处理中...' : '开始完整流程';
}

function renderHistory(list) {
  historyCache = Array.isArray(list) ? list : [];
  if (!historyCache.length) {
    els.historyList.innerHTML = '<div class="history-item"><div class="history-meta">暂无历史项目。</div></div>';
    return;
  }

  els.historyList.innerHTML = historyCache.map((item, index) => {
    const time = item.finishedAt ? new Date(item.finishedAt).toLocaleString() : '-';
    const video = item.videoPath || '-';
    const project = item.projectDir || '-';
    return `
      <div class="history-item">
        <div class="history-row">
          <div class="history-meta">
            <strong>${escapeHtml(time)}</strong>
            <span class="mono">${escapeHtml(video)}</span>
            <span class="mono">${escapeHtml(project)}</span>
          </div>
          <div class="history-actions">
            <button type="button" class="secondary" data-history-open="${index}">打开目录</button>
            <button type="button" class="secondary" data-history-review="${index}">恢复审核</button>
            <button type="button" class="danger" data-history-delete="${index}">删除记录</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function refreshHistory() {
  const list = await window.talkcut.getHistory();
  renderHistory(list);
}

function getSettingsFromForm() {
  return {
    volcengineApiKey: els.volcengineApiKey.value.trim(),
    dashscopeApiKey: els.dashscopeApiKey.value.trim(),
    asrEngine: els.asrEngine.value,
    localWhisperModel: settingsCache.localWhisperModel || 'high',
    localWhisperModelPath: settingsCache.localWhisperModelPath || '',
    themeMode: normalizeThemeMode(els.themeMode.value),
    llmProvider: els.llmProvider.value,
    llmApiBaseUrl: els.llmApiBaseUrl.value.trim(),
    llmApiKey: els.llmApiKey.value.trim(),
    llmModel: els.llmModel.value.trim(),
    llmTemperature: Number(els.llmTemperature.value),
    outputRoot: els.outputRoot.value.trim(),
    silenceThresholdSec: Number(els.silenceThresholdSec.value) || 0.2,
    exportQuality: els.exportQuality.value || 'ultra',
  };
}

function getLlmInputFromForm() {
  return {
    llmProvider: els.llmProvider.value,
    llmApiBaseUrl: els.llmApiBaseUrl.value.trim(),
    llmApiKey: els.llmApiKey.value.trim(),
    llmModel: els.llmModel.value.trim(),
    llmTemperature: Number(els.llmTemperature.value),
  };
}


function getAsrInputFromForm() {
  return {
    asrEngine: els.asrEngine.value,
    volcengineApiKey: els.volcengineApiKey.value.trim(),
    dashscopeApiKey: els.dashscopeApiKey.value.trim(),
  };
}

function setAsrConnState(type, message) {
  if (!els.asrConnState) return;
  const state = type === 'ok' || type === 'error' || type === 'pending' ? type : 'pending';
  els.asrConnState.className = `llm-conn-state ${state}`;
  els.asrConnState.textContent = message || 'ASR connection: not tested';
}

function markAsrConnPending() {
  const engine = els.asrEngine.value;
  if (engine === 'aliyun_qwen' && !els.dashscopeApiKey.value.trim()) {
    setAsrConnState('pending', 'ASR connection: DashScope API Key required');
    return;
  }
  if (engine === 'volcengine' && !els.volcengineApiKey.value.trim()) {
    setAsrConnState('pending', 'ASR connection: Volcengine API Key required');
    return;
  }
  if (engine === 'local') {
    setAsrConnState('pending', 'ASR connection: check local model first');
    return;
  }
  setAsrConnState('pending', 'ASR connection: config changed, test required');
}

async function runAsrConnectionTest() {
  if (!window.talkcut.testAsrConnection) return;
  const seq = ++asrTestSeq;
  const originalText = els.testAsr ? els.testAsr.textContent : '';
  if (els.testAsr) {
    els.testAsr.disabled = true;
    els.testAsr.textContent = 'Testing...';
  }
  setAsrConnState('pending', 'ASR connection: testing...');
  try {
    const result = await window.talkcut.testAsrConnection(getAsrInputFromForm());
    if (seq !== asrTestSeq) return;
    if (result && result.ok) {
      setAsrConnState('ok', `ASR connection: ${result.message || 'OK'}`);
    } else {
      setAsrConnState('error', `ASR connection failed: ${result?.message || 'unknown error'}`);
    }
  } catch (err) {
    if (seq !== asrTestSeq) return;
    setAsrConnState('error', `ASR connection error: ${err.message || String(err)}`);
  } finally {
    if (seq === asrTestSeq && els.testAsr) {
      els.testAsr.disabled = false;
      els.testAsr.textContent = originalText || 'Test ASR connection';
    }
  }
}

function getLlmFingerprint() {
  const input = getLlmInputFromForm();
  return JSON.stringify({
    provider: input.llmProvider,
    baseUrl: input.llmApiBaseUrl,
    apiKey: input.llmApiKey,
    model: input.llmModel,
    temperature: Number.isFinite(Number(input.llmTemperature))
      ? Number(input.llmTemperature)
      : 0.2,
  });
}

function isLlmConfigComplete() {
  const input = getLlmInputFromForm();
  return Boolean(input.llmApiBaseUrl && input.llmApiKey && input.llmModel);
}

function setLlmConnState(type, message) {
  const state = type === 'ok' || type === 'error' || type === 'pending' ? type : 'pending';
  els.llmConnState.className = `llm-conn-state ${state}`;
  els.llmConnState.textContent = message || '连通状态：未测试';
}

function markLlmConnStateByForm() {
  const complete = isLlmConfigComplete();
  if (!complete) {
    setLlmConnState('pending', '连通状态：待配置（请填写地址 / Key / 模型）');
    return;
  }
  const currentFingerprint = getLlmFingerprint();
  if (llmLastFingerprint && llmLastFingerprint === currentFingerprint) {
    return;
  }
  setLlmConnState('pending', '连通状态：配置已变更，等待测试...');
}

async function runLlmConnectionTest(mode = 'manual') {
  if (!isLlmConfigComplete()) {
    setLlmConnState('pending', '连通状态：待配置（请填写地址 / Key / 模型）');
    return;
  }

  const seq = ++llmTestSeq;
  const testingText = mode === 'auto'
    ? '连通状态：自动检测中...'
    : '连通状态：测试中...';
  setLlmConnState('pending', testingText);

  const originalBtnText = els.testLlm.textContent;
  els.testLlm.disabled = true;
  els.testLlm.textContent = '测试中...';

  try {
    const result = await window.talkcut.testLlmConnection(getLlmInputFromForm());
    if (seq !== llmTestSeq) return;

    llmLastFingerprint = getLlmFingerprint();
    if (result && result.ok) {
      const okText = String(result.message || '').trim()
        || `已连接（${result.latencyMs || 0}ms）`;
      setLlmConnState('ok', `连通状态：${okText}`);
    } else {
      setLlmConnState('error', `连通状态：失败（${result?.message || '未知错误'}）`);
    }
  } catch (err) {
    if (seq !== llmTestSeq) return;
    setLlmConnState('error', `连通状态：异常（${err.message || String(err)}）`);
  } finally {
    if (seq === llmTestSeq) {
      els.testLlm.disabled = false;
      els.testLlm.textContent = originalBtnText;
    }
  }
}

function scheduleAutoLlmTest() {
  if (llmAutoTimer) {
    clearTimeout(llmAutoTimer);
    llmAutoTimer = null;
  }

  markLlmConnStateByForm();
  if (!isLlmConfigComplete()) return;

  const currentFingerprint = getLlmFingerprint();
  if (currentFingerprint === llmLastFingerprint) return;

  llmAutoTimer = setTimeout(() => {
    llmAutoTimer = null;
    runLlmConnectionTest('auto').catch(() => {});
  }, 1200);
}

function applyLlmProviderPreset(provider, force = false) {
  const key = Object.prototype.hasOwnProperty.call(LLM_PROVIDER_PRESETS, provider) ? provider : 'custom';
  const preset = LLM_PROVIDER_PRESETS[key];
  if (!preset) return;

  const currentBase = els.llmApiBaseUrl.value.trim();
  const currentModel = els.llmModel.value.trim();

  if (force || !currentBase) {
    els.llmApiBaseUrl.value = preset.baseUrl || '';
  }
  if (force || !currentModel) {
    els.llmModel.value = preset.model || '';
  }
}

function applySettingsToForm(settings) {
  settingsCache = { ...(settings || {}) };
  els.volcengineApiKey.value = settings.volcengineApiKey || '';
  els.dashscopeApiKey.value = settings.dashscopeApiKey || '';
  els.asrEngine.value = settings.asrEngine || 'volcengine';
  els.themeMode.value = normalizeThemeMode(settings.themeMode || 'light');

  const provider = settings.llmProvider || 'openai';
  isApplyingLlmPreset = true;
  els.llmProvider.value = Object.prototype.hasOwnProperty.call(LLM_PROVIDER_PRESETS, provider) ? provider : 'custom';
  isApplyingLlmPreset = false;

  els.llmApiBaseUrl.value = settings.llmApiBaseUrl || '';
  els.llmApiKey.value = settings.llmApiKey || '';
  els.llmModel.value = settings.llmModel || '';
  els.llmTemperature.value = String(
    Number.isFinite(Number(settings.llmTemperature))
      ? Number(settings.llmTemperature)
      : 0.2,
  );

  if (!els.llmApiBaseUrl.value.trim() || !els.llmModel.value.trim()) {
    applyLlmProviderPreset(els.llmProvider.value, false);
  }

  els.outputRoot.value = settings.outputRoot || '';
  els.silenceThresholdSec.value = String(settings.silenceThresholdSec || 0.2);
  els.exportQuality.value = settings.exportQuality || 'ultra';
  if (settings.lastVideoPath) {
    els.videoPath.value = settings.lastVideoPath;
  }

  refreshLocalModelState();
  refreshSettingsQuick();
  markLlmConnStateByForm();
  applyTheme(els.themeMode.value);
  bindSystemThemeListener(els.themeMode.value);
}

function refreshLocalModelState() {
  // Local model install/check is always available, even when cloud ASR is selected.
}



function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)}GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(0)}MB`;
  return `${Math.round(value / 1024)}KB`;
}

function renderModelStatus(status = {}) {
  if (!els.modelInstallState) return;
  const installState = status.installState || status;
  const installed = Boolean(status.installed);
  const rawState = installState.status || '';
  const state = rawState === 'idle'
    ? (installed ? 'installed' : (status.scan ? 'missing' : 'idle'))
    : (rawState || (installed ? 'installed' : 'missing'));
  const progress = Math.max(0, Math.min(100, Number(installState.progress || (installed ? 100 : 0))));
  const stateText = {
    idle: '\u672a\u68c0\u67e5',
    missing: '\u672a\u5b89\u88c5',
    checking: '\u68c0\u67e5\u4e2d',
    downloading: '\u4e0b\u8f7d\u4e2d',
    verifying: '\u6821\u9a8c\u4e2d',
    installed: '\u5df2\u5b89\u88c5',
    error: '\u5b89\u88c5\u5931\u8d25',
  }[state] || state;
  if (installed && status.path) {
    settingsCache.localWhisperModelPath = status.path;
    settingsCache.localWhisperModel = status.key || settingsCache.localWhisperModel || 'high';
  }
  els.modelInstallState.textContent = stateText;
  els.modelInstallState.dataset.status = state;
  els.modelProgressBar.style.width = `${progress}%`;
  const candidates = Array.isArray(status.candidates) ? status.candidates : [];
  let message = installState.message || (installed ? '\u5df2\u627e\u5230\u53ef\u7528\u672c\u5730\u8bed\u97f3\u6a21\u578b\u3002' : '\u672a\u627e\u5230\u53ef\u7528\u672c\u5730 Whisper/ggml \u8bed\u97f3\u6a21\u578b\u3002');
  if (status.scan) {
    message = installed
      ? `\u68c0\u67e5\u5b8c\u6210\uff1a\u627e\u5230 ${candidates.length || 1} \u4e2a\u5019\u9009\uff0c\u5df2\u9009\u7528 ${status.path}\uff0c\u8017\u65f6 ${Math.round((status.elapsedMs || 0) / 1000)}\u79d2${status.timedOut ? '\uff08\u5df2\u8fbe\u5230\u65f6\u95f4\u4e0a\u9650\uff09' : ''}`
      : `\u68c0\u67e5\u5b8c\u6210\uff1a\u672a\u627e\u5230\u53ef\u7528\u6a21\u578b\uff0c\u5df2\u626b\u63cf ${status.scannedDirs || 0} \u4e2a\u76ee\u5f55\uff0c\u53ef\u70b9\u51fb\u201c\u5b89\u88c5\u672c\u5730\u6a21\u578b\u201d\u3002`;
  } else if (installed && candidates[0]?.size) {
    message = `\u5df2\u627e\u5230\u53ef\u7528\u6a21\u578b\uff1a${status.path}\uff08${formatBytes(candidates[0].size)}\uff09`;
  }
  els.modelInstallHint.textContent = message;
  els.installWhisperModel.disabled = state === 'checking' || state === 'downloading' || state === 'verifying' || installed;
}

async function refreshModelStatus(options = {}) {
  if (!window.talkcut.getWhisperModelStatus) return;
  renderModelStatus(await window.talkcut.getWhisperModelStatus(options));
}

function renderUpdateState(state = {}) {
  if (!els.updateStatus) return;
  const status = state.status || 'idle';
  const progress = Math.max(0, Math.min(100, Number(state.progress || 0)));
  els.updateStatus.textContent = UPDATE_STATUS_LABELS[status] || status;
  els.updateStatus.dataset.status = status;
  els.updateCurrentVersion.textContent = state.currentVersion || '-';
  els.updateLatestVersion.textContent = state.latestVersion || '-';
  els.updateMessage.textContent = state.message || '\u542f\u52a8\u540e\u4f1a\u81ea\u52a8\u68c0\u67e5\u66f4\u65b0\uff0c\u4e5f\u53ef\u4ee5\u624b\u52a8\u68c0\u67e5\u3002';
  els.updateProgressBar.style.width = `${progress}%`;
  els.checkUpdate.disabled = status === 'checking' || status === 'downloading';
  els.downloadUpdate.disabled = !state.canDownload;
  els.installUpdate.disabled = !state.canInstall;
}

async function refreshUpdateState() {
  if (!window.talkcut.getUpdateState) return;
  renderUpdateState(await window.talkcut.getUpdateState());
}

async function boot() {
  requireElementsReady();
  const settings = await window.talkcut.getSettings();
  applySettingsToForm(settings);
  loadSettingsCollapsed();
  setTask(await window.talkcut.getTask());
  await refreshUpdateState();
  await refreshModelStatus();
  await refreshHistory();

  window.talkcut.onTaskUpdate((data) => {
    setTask(data);
    if (data && (data.state === 'completed' || data.state === 'failed')) {
      refreshHistory().catch(() => {});
    }
  });

  if (window.talkcut.onUpdateState) {
    window.talkcut.onUpdateState((data) => {
      renderUpdateState(data);
    });
  }

  if (window.talkcut.onModelInstallState) {
    window.talkcut.onModelInstallState((data) => {
      renderModelStatus({
        installed: false,
        installState: data,
        path: '',
      });
    });
  }

  scheduleAutoLlmTest();
}

$('pickVideo').addEventListener('click', async () => {
  const picked = await window.talkcut.pickVideo();
  if (picked) els.videoPath.value = picked;
});

$('pickOutputRoot').addEventListener('click', async () => {
  const picked = await window.talkcut.pickOutputDir();
  if (picked) els.outputRoot.value = picked;
});

['volcengineApiKey', 'dashscopeApiKey'].forEach((id) => {
  if (els[id]) {
    els[id].addEventListener('input', markAsrConnPending);
  }
});

els.asrEngine.addEventListener('change', () => {
  markAsrConnPending();
  refreshLocalModelState();
  refreshSettingsQuick();
  refreshModelStatus().catch(() => {});
});


if (els.checkWhisperModel) {
  els.checkWhisperModel.addEventListener('click', async () => {
    renderModelStatus({ installState: { status: 'checking', message: '\u6b63\u5728\u5168\u76d8\u68c0\u67e5\u53ef\u7528\u8bed\u97f3\u6a21\u578b...', progress: 10 } });
    renderModelStatus(await window.talkcut.scanWhisperModels());
  });
}

if (els.installWhisperModel) {
  els.installWhisperModel.addEventListener('click', async () => {
    try {
      renderModelStatus(await window.talkcut.installWhisperModel());
    } catch (err) {
      renderModelStatus({
        installed: false,
        installState: {
          status: 'error',
          message: `\u6a21\u578b\u5b89\u88c5\u5931\u8d25\uff1a${err.message || String(err)}`,
          progress: 0,
        },
      });
    }
  });
}

els.themeMode.addEventListener('change', () => {
  applyTheme(els.themeMode.value);
  bindSystemThemeListener(els.themeMode.value);
  refreshSettingsQuick();
});

if (els.toggleSettings) {
  els.toggleSettings.addEventListener('click', () => {
    const collapsed = !(els.settingsBody && els.settingsBody.hidden);
    setSettingsCollapsed(collapsed);
  });
}

els.llmProvider.addEventListener('change', () => {
  if (isApplyingLlmPreset) return;
  applyLlmProviderPreset(els.llmProvider.value, true);
  llmLastFingerprint = '';
  scheduleAutoLlmTest();
});

['llmApiBaseUrl', 'llmApiKey', 'llmModel', 'llmTemperature'].forEach((id) => {
  els[id].addEventListener('input', () => {
    llmLastFingerprint = '';
    scheduleAutoLlmTest();
  });
});

els.testLlm.addEventListener('click', async () => {
  await runLlmConnectionTest('manual');
});

if (els.testAsr) {
  els.testAsr.addEventListener('click', async () => {
    await runAsrConnectionTest();
  });
}


if (els.checkUpdate) {
  els.checkUpdate.addEventListener('click', async () => {
    try {
      renderUpdateState(await window.talkcut.checkForUpdates());
    } catch (err) {
      renderUpdateState({
        status: 'error',
        currentVersion: els.updateCurrentVersion.textContent,
        latestVersion: els.updateLatestVersion.textContent,
        message: `\u68c0\u67e5\u66f4\u65b0\u5931\u8d25\uff1a${err.message || String(err)}`,
      });
    }
  });
}

if (els.downloadUpdate) {
  els.downloadUpdate.addEventListener('click', async () => {
    try {
      renderUpdateState(await window.talkcut.downloadUpdate());
    } catch (err) {
      renderUpdateState({
        status: 'error',
        currentVersion: els.updateCurrentVersion.textContent,
        latestVersion: els.updateLatestVersion.textContent,
        message: `\u4e0b\u8f7d\u66f4\u65b0\u5931\u8d25\uff1a${err.message || String(err)}`,
      });
    }
  });
}

if (els.installUpdate) {
  els.installUpdate.addEventListener('click', async () => {
    try {
      await window.talkcut.installUpdate();
    } catch (err) {
      renderUpdateState({
        status: 'error',
        currentVersion: els.updateCurrentVersion.textContent,
        latestVersion: els.updateLatestVersion.textContent,
        message: `\u5b89\u88c5\u66f4\u65b0\u5931\u8d25\uff1a${err.message || String(err)}`,
      });
    }
  });
}

$('saveSettings').addEventListener('click', async () => {
  const saved = await window.talkcut.saveSettings(getSettingsFromForm());
  applySettingsToForm(saved);
  scheduleAutoLlmTest();
});

$('checkDeps').addEventListener('click', async () => {
  const deps = await window.talkcut.checkDependencies();
  const lines = Object.entries(deps).map(([name, item]) => {
    return `${name}: ${item.ok ? '正常' : '缺失'} (${item.detail})`;
  });
  els.depsOutput.textContent = lines.join('\n');
});

$('startTask').addEventListener('click', async () => {
  try {
    if (els.asrEngine.value === 'local' && window.talkcut.getWhisperModelStatus) {
      const modelStatus = await window.talkcut.getWhisperModelStatus({ scan: true });
      renderModelStatus(modelStatus);
      if (!modelStatus.installed) {
        renderModelStatus({
          installed: false,
          installState: {
            status: 'checking',
            message: '\u672c\u5730\u6a21\u578b\u672a\u5b89\u88c5\uff0c\u5c06\u5148\u81ea\u52a8\u5b89\u88c5\u3002',
            progress: 0,
          },
        });
        await window.talkcut.installWhisperModel();
      }
    }
    await window.talkcut.saveSettings({
      ...getSettingsFromForm(),
      lastVideoPath: els.videoPath.value.trim(),
    });
    await window.talkcut.startTask({
      videoPath: els.videoPath.value.trim(),
      outputRoot: els.outputRoot.value.trim(),
    });
  } catch (err) {
    alert(`启动失败：${err.message || String(err)}`);
  }
});

$('openReview').addEventListener('click', async () => {
  try {
    await window.talkcut.openReviewWindow();
  } catch (err) {
    alert(`打开审核窗口失败：${err.message || String(err)}`);
  }
});

$('openFolder').addEventListener('click', async () => {
  try {
    await window.talkcut.openProjectFolder();
  } catch (err) {
    alert(`打开项目目录失败：${err.message || String(err)}`);
  }
});

els.historyList.addEventListener('click', async (event) => {
  const btn = event.target.closest('button');
  if (!btn) return;

  const openIndex = btn.getAttribute('data-history-open');
  const reviewIndex = btn.getAttribute('data-history-review');
  const deleteIndex = btn.getAttribute('data-history-delete');

  try {
    if (openIndex !== null) {
      const item = historyCache[Number(openIndex)];
      if (!item) return;
      await window.talkcut.openHistoryProject(item);
      return;
    }

    if (reviewIndex !== null) {
      const item = historyCache[Number(reviewIndex)];
      if (!item) return;
      await window.talkcut.resumeHistoryReview(item);
      return;
    }

    if (deleteIndex !== null) {
      const item = historyCache[Number(deleteIndex)];
      if (!item) return;
      const ok = window.confirm('确认删除这条历史记录吗？');
      if (!ok) return;
      await window.talkcut.deleteHistory(item);
      await refreshHistory();
    }
  } catch (err) {
    alert(`操作失败：${err.message || String(err)}`);
  }
});

boot().catch((err) => {
  alert(`初始化失败：${err.message || String(err)}`);
});
