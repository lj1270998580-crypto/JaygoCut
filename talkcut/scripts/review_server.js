#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { normalizeSelectedIndices } = require('./auto_selected_utils');

const PORT = Number(process.argv[2]) || 8899;
const VIDEO_FILE = process.argv[3] || findVideoFile(process.cwd());
const OUTPUT_ROOT_ARG = String(process.argv[4] || '').trim();
const FFPROBE_BIN = process.env.FFPROBE_BIN || 'ffprobe';
const LLM_MIN_CONFIDENCE = 0.56;
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
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};
const REVIEW_STATE_FILE = path.resolve(process.cwd(), 'review_state.json');

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

function getRuntimeInfo() {
  const { env: fileEnv, envFile } = loadEnvFileConfig();
  const resolvedVideo = path.resolve(VIDEO_FILE);
  const themeMode = String(process.env.JAYGO_THEME_MODE || fileEnv.JAYGO_THEME_MODE || 'light').trim().toLowerCase();
  const normalizedTheme = themeMode === 'blackgold' || themeMode === 'system' ? themeMode : 'light';

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
    process.env.LLM_PROVIDER
    || fileEnv.LLM_PROVIDER
    || 'openai',
  );
  const defaultBaseUrl = provider === 'anthropic'
    ? 'https://api.anthropic.com'
    : 'https://api.openai.com/v1';
  const baseUrl = normalizeLlmBaseUrl(
    process.env.LLM_API_BASE_URL
    || fileEnv.LLM_API_BASE_URL
    || defaultBaseUrl,
  );
  const apiKey = String(process.env.LLM_API_KEY || fileEnv.LLM_API_KEY || '').trim();
  const model = String(process.env.LLM_MODEL || fileEnv.LLM_MODEL || '').trim();
  const temperature = parseLlmTemperature(process.env.LLM_TEMPERATURE || fileEnv.LLM_TEMPERATURE || '0.2');

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

function buildChatAdjustPrompt(units, selectedUnitIds, userMessage, history, analysis) {
  const scopedUnits = pickUnitsForChatAdjust(units, selectedUnitIds, userMessage);
  const list = scopedUnits
    .map((u) => `${u.id}|${u.start.toFixed(2)}-${u.end.toFixed(2)}|${u.text}`)
    .join('\n');
  const selectedText = selectedUnitIds.slice(0, 240).join(',');
  const hist = Array.isArray(history)
    ? history.slice(-10).map((it) => `${it.role || 'user'}: ${String(it.text || '').slice(0, 180)}`).join('\n')
    : '';
  return [
    '你是“口播剪辑大师”的二次调标记助手。',
    `主题: ${String(analysis?.topic || '').trim() || '未知'}`,
    `梗概: ${String(analysis?.outline || '').trim() || '未知'}`,
    '',
    '根据用户要求，返回“新增删除”和“取消删除”句段 id，不改原文。',
    '硬约束：不得破坏主线、数字、因果、结论；不确定时宁可不删。',
    '优先删除：语气词、重复句、口水话、离题闲聊、非主讲人插话。',
    '如果用户意图是“请标记需要删除”，必须给出可执行 id（除非确实无可删内容）。',
    `当前已选 id: ${selectedText || '无'}`,
    `用户要求: ${String(userMessage || '').trim()}`,
    hist ? `最近对话:\n${hist}` : '最近对话: 无',
    '',
    '输出 JSON（只返回 JSON）：',
    '{"add_ids":[12,13],"remove_ids":[2,3],"reason":"中文，不超过60字","summary":"中文，不超过80字","scope":"开头|中段|结尾|全片"}',
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

  return [
    '你是“口播剪辑大师”，专注中文自媒体口播剪辑。',
    '目标：删冗余、提密度、保主线，输出必须可直接执行。',
    '',
    '分步规则（严格按顺序）：',
    '1) 主题抽取：给出 topic 与 outline（简洁）。',
    '2) 结构识别：按 Hook(开场钩子)-Value(主体信息)-Proof(案例/证据)-Close(收束)判断句段角色。',
    '3) 规则优先标记：先标语气词/口头禅、重复句、口水话。',
    '4) 语义标记：再标离题闲聊、无信息增量句、非主讲人插话（若多人对话）。',
    '5) 可读性优化：为每个语义句末输出标点；只在话题推进、观点切换、案例切换、结论收束处设置段落断点。',
    '',
    '必须保留：事实、数字、因果、步骤、观点结论、关键专有名词。',
    '删除置信度规则：≥0.78 才可高置信删除；0.62~0.77 仅当属于语气词/重复句；<0.62 不输出。',
    '标点规则：短停顿或未完句用“，”；完整陈述用“。”；明显疑问用“？”；强情绪/强调用“！”；并列解释或转折可用“；”或“：”。',
    '分段规则：不要按固定字数分段；每段表达一个小主题，通常 2-5 个语义句；口播开头、关键论点、案例、结论优先分段。',
    '不确定时宁可不删（高精度优先）。',
    '',
    `全局主题参考: ${topic || '未知'}`,
    `全局梗概参考: ${outline || '未知'}`,
    `是否多人对话(预判): ${multiSpeaker}`,
    `主讲人线索(预判): ${mainSpeakerHint || '未知'}`,
    '',
    '输出 JSON（只返回 JSON，不要 markdown）：',
    '{"analysis":{"topic":"","outline":"","multiSpeaker":false,"mainSpeakerHint":""},',
    '"mark_delete":[{"id":12,"reason_type":"filler|repeat|off_topic|other_speaker|opening_offtopic|ending_offtopic|nonsense","reason":"中文简述","confidence":0.82}],',
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

async function runLlmChatAdjust(words, config, selectedIndices, userMessage, history, inputAnalysis) {
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
  const prompt = buildChatAdjustPrompt(units, selectedUnitIds, message, history, analysis);
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
  let selectedItems = rawCandidates
    .filter((item) => item.confidence >= LLM_MIN_CONFIDENCE);
  let confidenceFilteredCount = Math.max(0, rawCandidates.length - selectedItems.length);

  const maxAllowed = Math.min(180, Math.max(6, Math.floor(units.length * 0.3)));
  if (!selectedItems.length && rawCandidates.length) {
    const fallbackCount = Math.min(maxAllowed, Math.max(3, Math.ceil(rawCandidates.length * 0.35)));
    selectedItems = rawCandidates.slice(0, fallbackCount);
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

  const unitById = new Map(units.map((u) => [u.id, u]));
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

async function runCutJob(deleteList) {
  const runtimeInfo = getRuntimeInfo();
  fs.mkdirSync(runtimeInfo.cutOutputDir, { recursive: true });

  const baseName = path.parse(VIDEO_FILE).name;
  const outputFile = path.join(runtimeInfo.cutOutputDir, `${baseName}_cut.mp4`);
  const deleteFile = path.resolve('delete_segments.json');
  fs.writeFileSync(deleteFile, JSON.stringify(deleteList, null, 2));

  appendCutLog(`Output directory: ${runtimeInfo.cutOutputDir}`);

  const cutScript = path.join(__dirname, 'cut_video.js');
  if (!fs.existsSync(cutScript)) {
    throw new Error(`cut_video.js not found: ${cutScript}`);
  }

  await runNodeScript(cutScript, [VIDEO_FILE, deleteFile, outputFile], 'cutting');
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

  const threshold = Number(payload?.threshold);
  const currentTime = Number(payload?.currentTimeSec);
  const version = Number(payload?.version);

  return {
    version: Number.isInteger(version) && version > 0 ? version : 1,
    savedAt: new Date().toISOString(),
    selectedIndices: Array.from(new Set(selectedIndices)).sort((a, b) => a - b),
    llmSuggestedIndices: Array.from(new Set(llmSuggestedIndices)).sort((a, b) => a - b),
    llmReasons,
    threshold: Number.isFinite(threshold) && threshold >= 0.2 ? threshold : 0.2,
    currentTimeSec: Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0,
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
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

function serveFile(req, res, absolutePath) {
  if (!fs.existsSync(absolutePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const stat = fs.statSync(absolutePath);
  const ext = path.extname(absolutePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

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

      if (!words.length) {
        throw new Error('words 为空，无法执行对话调标记');
      }
      if (!message) {
        throw new Error('请输入调标记要求');
      }

      appendCutLog(`LLM 对话调标记开始：provider=${config.provider}, model=${config.model}`);
      const result = await runLlmChatAdjust(words, config, selectedIndices, message, history, analysis);
      appendCutLog(`LLM 对话调标记完成：新增 ${result.addIds.length} 段，取消 ${result.removeIds.length} 段`);
      writeJson(res, 200, { success: true, ...result });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/cut') {
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
      const deleteList = JSON.parse(body || '[]');
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
        logTail: [`Queued ${normalized.length} delete segments.`],
        result: null,
        error: '',
      });

      (async () => {
        try {
          const result = await runCutJob(normalized);
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

