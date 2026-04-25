#!/usr/bin/env node
/**
 * 内置本地 Whisper 转录（ffmpeg whisper filter）
 *
 * 用法: node whisper_transcribe_local.js <audio_file>
 * 输出: subtitles_words.json（当前目录）
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const audioPath = process.argv[2];
const ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg';
const modelQuality = process.env.WHISPER_MODEL_QUALITY === 'standard' ? 'standard' : 'high';
const modelsDir = path.resolve(__dirname, '..', '..', 'electron', 'models');
const minDeleteSec = Math.max(0.2, Number(process.env.CUT_MIN_DELETE_MS || 200) / 1000);
const silenceNoiseDb = Number.isFinite(Number(process.env.LOCAL_SILENCE_NOISE_DB))
  ? Number(process.env.LOCAL_SILENCE_NOISE_DB)
  : -35;
const SIMPLIFIED_MODE = String(process.env.LOCAL_CHINESE_SCRIPT || 'simplified').trim().toLowerCase() !== 'traditional';

const T2S_PHRASE_MAP = new Map([
  ['這裡', '这里'],
  ['那裡', '那里'],
  ['裡面', '里面'],
  ['裡頭', '里头'],
  ['瞭解', '了解'],
  ['影片', '视频'],
  ['軟體', '软件'],
  ['硬體', '硬件'],
  ['資料', '资料'],
  ['網路', '网络'],
  ['訊息', '信息'],
  ['觀眾', '观众'],
  ['節目', '节目'],
  ['頻道', '频道'],
  ['標題', '标题'],
  ['關鍵詞', '关键词'],
  ['錄製', '录制'],
  ['剪輯', '剪辑'],
  ['審核', '审核'],
  ['發布', '发布'],
  ['帳號', '账号'],
  ['賬號', '账号'],
  ['幹嘛', '干嘛'],
  ['乾淨', '干净'],
  ['乾杯', '干杯'],
  ['週末', '周末'],
]);

const T2S_CHAR_MAP = Object.freeze({
  '這': '这', '個': '个', '們': '们', '說': '说', '時': '时', '為': '为', '來': '来', '會': '会',
  '點': '点', '裡': '里', '後': '后', '無': '无', '與': '与', '將': '将', '於': '于', '過': '过',
  '還': '还', '讓': '让', '開': '开', '關': '关', '對': '对', '嗎': '吗', '麼': '么', '覺': '觉',
  '實': '实', '應': '应', '當': '当', '頭': '头', '話': '话', '經': '经', '發': '发', '現': '现',
  '廣': '广', '產': '产', '學': '学', '習': '习', '體': '体', '聲': '声', '氣': '气', '變': '变',
  '價': '价', '質': '质', '壓': '压', '線': '线', '簡': '简', '複': '复', '雜': '杂', '專': '专',
  '業': '业', '網': '网', '電': '电', '腦': '脑', '區': '区', '長': '长', '門': '门', '臺': '台',
  '灣': '湾', '羅': '罗', '錄': '录', '問': '问', '題': '题', '證': '证', '處': '处', '畫': '画',
  '圖': '图', '語': '语', '詞': '词', '斷': '断', '總': '总', '彙': '汇', '滿': '满', '導': '导',
  '賽': '赛', '輸': '输', '贏': '赢', '錄': '录', '鐘': '钟', '鐘': '钟', '愛': '爱', '願': '愿',
  '寫': '写', '書': '书', '頁': '页', '節': '节', '親': '亲', '貓': '猫', '貴': '贵', '費': '费',
  '車': '车', '雲': '云', '碼': '码', '數': '数', '連': '连', '達': '达', '隊': '队', '責': '责',
  '務': '务', '務': '务', '務': '务', '濾': '滤', '權': '权', '聽': '听', '講': '讲', '額': '额',
  '點': '点', '優': '优', '銷': '销', '匯': '汇', '啟': '启', '閉': '闭', '檔': '档', '續': '续',
  '頁': '页', '從': '从', '較': '较', '嗎': '吗', '號': '号', '種': '种', '類': '类', '畢': '毕',
  '萬': '万', '億': '亿', '啞': '哑', '麗': '丽', '燈': '灯', '層': '层', '際': '际', '險': '险',
  '識': '识', '啟': '启', '終': '终', '態': '态', '術': '术', '嚴': '严', '薦': '荐', '庫': '库',
  '計': '计', '劃': '划', '錄': '录', '壞': '坏', '評': '评', '雖': '虽', '廣': '广', '訊': '讯',
  '禮': '礼', '靜': '静', '範': '范', '講': '讲', '類': '类', '鄉': '乡', '財': '财', '輕': '轻',
  '斂': '敛', '擇': '择', '續': '续', '邊': '边', '勵': '励', '錄': '录', '邏': '逻', '輯': '辑',
});

function resolveModelPath() {
  const fromEnv = process.env.WHISPER_MODEL || '';
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const preferred = modelQuality === 'high'
    ? ['ggml-large-v3-turbo.bin', 'ggml-base.bin']
    : ['ggml-base.bin', 'ggml-large-v3-turbo.bin'];

  for (const name of preferred) {
    const candidate = path.join(modelsDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return fromEnv || path.join(modelsDir, preferred[0]);
}

const modelPath = resolveModelPath();

if (!audioPath) {
  console.error('用法: node whisper_transcribe_local.js <audio_file>');
  process.exit(1);
}
if (!fs.existsSync(audioPath)) {
  console.error(`未找到音频文件: ${audioPath}`);
  process.exit(1);
}
if (!fs.existsSync(modelPath)) {
  console.error(`未找到内置 Whisper 模型（quality=${modelQuality}）: ${modelPath}`);
  process.exit(1);
}

function fileArg(p) {
  return process.platform === 'win32' ? p : `file:${p}`;
}

function escapeFilterValue(v) {
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/'/g, "\\'");
}

function parseWhisperJsonLines(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // fallback: normal JSON array/object
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed.segments)) return parsed.segments;
    } catch {
      // ignore and continue with NDJSON parser
    }
  }

  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || !text.startsWith('{')) continue;
    try {
      out.push(JSON.parse(text));
    } catch {
      // ignore malformed line
    }
  }
  return out;
}

function toSimplifiedChinese(input) {
  const source = String(input || '');
  if (!source) return '';
  if (!SIMPLIFIED_MODE) return source;

  let text = source;
  for (const [trad, simp] of T2S_PHRASE_MAP.entries()) {
    text = text.split(trad).join(simp);
  }
  return Array.from(text).map((ch) => T2S_CHAR_MAP[ch] || ch).join('');
}

function splitToTokens(text) {
  const cleaned = toSimplifiedChinese(text).trim();
  if (!cleaned) return [];

  const parts = cleaned.match(/[\p{Script=Han}]|[A-Za-z0-9]+|[^\s]/gu);
  if (parts && parts.length) return parts;
  return [cleaned];
}

function normalizeSegments(rawSegments) {
  const segments = [];
  for (const seg of rawSegments) {
    const startMs = Number(seg.start);
    const endMs = Number(seg.end);
    const text = toSimplifiedChinese(seg.text).trim();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    if (!text) continue;
    segments.push({
      start: startMs / 1000,
      end: endMs / 1000,
      text,
    });
  }
  segments.sort((a, b) => a.start - b.start);
  return segments;
}

function detectSilenceSegments(audioFile, noiseDb = silenceNoiseDb) {
  const args = [
    '-hide_banner',
    '-i',
    fileArg(path.resolve(audioFile)),
    '-af',
    `silencedetect=noise=${Number(noiseDb)}dB:d=${minDeleteSec.toFixed(2)}`,
    '-f',
    'null',
    '-',
  ];

  const result = spawnSync(ffmpegBin, args, {
    windowsHide: true,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });

  if (result.error || result.status !== 0) {
    return [];
  }

  const lines = String(result.stderr || '').split(/\r?\n/);
  const segments = [];
  let pendingStart = null;

  for (const line of lines) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/i);
    if (startMatch) {
      pendingStart = Number(startMatch[1]);
      continue;
    }

    const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/i);
    if (!endMatch) continue;

    const end = Number(endMatch[1]);
    const duration = Number(endMatch[2]);
    const start = Number.isFinite(pendingStart) ? pendingStart : (end - duration);
    pendingStart = null;

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (duration + 1e-6 < minDeleteSec) continue;

    segments.push({
      start: Math.max(0, start),
      end: Math.max(start, end),
    });
  }

  if (!segments.length) return [];

  segments.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const seg of segments) {
    if (!merged.length || seg.start > merged[merged.length - 1].end + 0.02) {
      merged.push({ ...seg });
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, seg.end);
    }
  }
  return merged;
}

function inferSilenceFromSegments(segments) {
  if (!Array.isArray(segments) || segments.length < 2) return [];
  const out = [];
  for (let i = 1; i < segments.length; i += 1) {
    const prev = segments[i - 1];
    const cur = segments[i];
    const start = Number(prev?.end);
    const end = Number(cur?.start);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (end - start + 1e-6 < minDeleteSec) continue;
    out.push({ start, end });
  }
  return out;
}

function detectSilenceSegmentsAdaptive(audioFile) {
  const primary = detectSilenceSegments(audioFile, silenceNoiseDb);
  if (primary.length >= 8) {
    return primary;
  }
  const relaxedNoise = Math.min(-22, silenceNoiseDb + 5);
  const relaxed = detectSilenceSegments(audioFile, relaxedNoise);
  if (!primary.length) return relaxed;
  return normalizeSilenceSegments([...primary, ...relaxed]);
}

function segmentSpeechWindows(segStart, segEnd, silenceSegments) {
  const windows = [];
  let cursor = segStart;
  for (const s of silenceSegments) {
    if (s.end <= cursor) continue;
    if (s.start >= segEnd) break;

    if (s.start > cursor) {
      windows.push({ start: cursor, end: Math.min(s.start, segEnd) });
    }

    cursor = Math.max(cursor, Math.min(s.end, segEnd));
    if (cursor >= segEnd) break;
  }

  if (cursor < segEnd) {
    windows.push({ start: cursor, end: segEnd });
  }

  return windows.filter((w) => w.end - w.start > 0.005);
}

function mapVirtualToRealTime(offset, windows) {
  if (!windows.length) return 0;
  let remain = Math.max(0, offset);
  for (const w of windows) {
    const dur = w.end - w.start;
    if (remain < dur) return w.start + remain;
    remain -= dur;
  }
  return windows[windows.length - 1].end;
}

function distributeTokenCounts(tokenCount, windows) {
  if (!windows.length) return [];
  if (windows.length === 1) return [tokenCount];

  const durations = windows.map((w) => Math.max(0, w.end - w.start));
  const total = durations.reduce((s, d) => s + d, 0);
  if (total <= 0) {
    return windows.map((_, idx) => (idx === 0 ? tokenCount : 0));
  }

  const raw = durations.map((d) => (d / total) * tokenCount);
  const counts = raw.map((x) => Math.floor(x));
  let assigned = counts.reduce((s, c) => s + c, 0);

  while (assigned < tokenCount) {
    let pick = 0;
    let best = -Infinity;
    for (let i = 0; i < raw.length; i += 1) {
      const score = raw[i] - counts[i];
      if (score > best) {
        best = score;
        pick = i;
      }
    }
    counts[pick] += 1;
    assigned += 1;
  }

  return counts;
}

function buildWordTimeline(segments, silenceSegments = []) {
  const silence = Array.isArray(silenceSegments)
    ? silenceSegments.slice().sort((a, b) => a.start - b.start)
    : [];

  const words = [];
  for (const seg of segments) {
    const tokens = splitToTokens(seg.text);
    if (!tokens.length) continue;

    let windows = segmentSpeechWindows(seg.start, seg.end, silence);
    if (!windows.length) {
      windows = [{ start: seg.start, end: seg.end }];
    }

    const counts = distributeTokenCounts(tokens.length, windows);
    let tokenCursor = 0;

    for (let wi = 0; wi < windows.length; wi += 1) {
      const w = windows[wi];
      const count = counts[wi] || 0;
      if (count <= 0) continue;

      const dur = Math.max(0.01, w.end - w.start);
      const unit = dur / count;
      for (let i = 0; i < count && tokenCursor < tokens.length; i += 1) {
        const start = w.start + unit * i;
        const end = i === count - 1 ? w.end : (w.start + unit * (i + 1));
        words.push({
          text: tokens[tokenCursor],
          start: Math.max(0, start),
          end: Math.max(start, end),
        });
        tokenCursor += 1;
      }
    }

    while (tokenCursor < tokens.length) {
      words.push({
        text: tokens[tokenCursor],
        start: Math.max(0, seg.start),
        end: Math.max(seg.start, seg.end),
      });
      tokenCursor += 1;
    }
  }
  return words;
}

function stripRepeatedTokens(words) {
  if (words.length < 8) return words;
  const remove = new Set();

  let i = 0;
  while (i < words.length) {
    const token = words[i].text;
    let j = i + 1;
    while (j < words.length && words[j].text === token) j += 1;
    if (j - i >= 6) {
      for (let k = i; k < j; k += 1) remove.add(k);
    }
    i = j;
  }

  if (!remove.size) return words;
  return words.filter((_w, idx) => !remove.has(idx));
}

function normalizeSilenceSegments(silenceSegments) {
  const clean = (silenceSegments || [])
    .map((s) => ({ start: Number(s.start), end: Number(s.end) }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .filter((s) => s.end - s.start + 1e-6 >= minDeleteSec)
    .sort((a, b) => a.start - b.start);

  if (!clean.length) return [];
  const merged = [];
  for (const seg of clean) {
    if (!merged.length || seg.start > merged[merged.length - 1].end + 0.02) {
      merged.push({ ...seg });
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, seg.end);
    }
  }
  return merged;
}

function buildGapSegmentsFromWords(words) {
  const gaps = [];
  let lastEnd = 0;
  for (const word of words) {
    const gap = word.start - lastEnd;
    if (gap > 0.1) {
      gaps.push({ start: lastEnd, end: word.start });
    }
    lastEnd = word.end;
  }
  return gaps;
}

function toSubtitlesWords(words, externalGapSegments = []) {
  const gapSegments = Array.isArray(externalGapSegments) && externalGapSegments.length
    ? externalGapSegments
    : buildGapSegmentsFromWords(words);

  const out = [];
  for (const gap of gapSegments) {
    const start = Number(gap.start);
    const end = Number(gap.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (end - start + 1e-6 < minDeleteSec) continue;
    out.push({
      text: '',
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      isGap: true,
    });
  }

  for (const word of words) {
    out.push({
      text: word.text,
      start: Number(word.start.toFixed(3)),
      end: Number(word.end.toFixed(3)),
      isGap: false,
    });
  }

  out.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.isGap !== b.isGap) return a.isGap ? -1 : 1;
    return a.end - b.end;
  });

  return out;
}

function summarizeSilence(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '0.00';
  return sec.toFixed(2);
}

function runWhisper() {
  const modelDir = path.dirname(modelPath);
  const modelName = path.basename(modelPath);
  const rawName = `whisper_result_${Date.now()}_${process.pid}.jsonl`;
  const rawPath = path.join(modelDir, rawName);
  const outputPath = path.resolve('subtitles_words.json');

  const whisperFilter = [
    `model=${escapeFilterValue(modelName)}`,
    'language=zh',
    'queue=20',
    'use_gpu=false',
    'format=json',
    `destination=${escapeFilterValue(rawName)}`,
  ].join(':');

  const args = [
    '-hide_banner',
    '-y',
    '-i',
    fileArg(path.resolve(audioPath)),
    '-af',
    `whisper=${whisperFilter}`,
    '-f',
    'null',
    '-',
  ];

  console.log(`🎙️  本地 Whisper 转录中: ${audioPath}`);
  console.log(`📦  模型: ${modelPath}（quality=${modelQuality}）`);

  const result = spawnSync(ffmpegBin, args, {
    cwd: modelDir,
    stdio: 'inherit',
    windowsHide: true,
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${ffmpegBin} exited with code ${result.status}`);
  }
  if (!fs.existsSync(rawPath)) {
    throw new Error(`未生成 Whisper 输出文件: ${rawPath}`);
  }

  const rawSegments = parseWhisperJsonLines(fs.readFileSync(rawPath, 'utf8'));
  const segments = normalizeSegments(rawSegments);
  const detectedSilence = normalizeSilenceSegments(detectSilenceSegmentsAdaptive(audioPath));
  const inferredSilence = normalizeSilenceSegments(inferSilenceFromSegments(segments));
  const silenceForTimeline = normalizeSilenceSegments([...detectedSilence, ...inferredSilence]);
  const words = stripRepeatedTokens(buildWordTimeline(segments, silenceForTimeline));
  const subtitlesWords = toSubtitlesWords(words, silenceForTimeline);

  fs.writeFileSync(outputPath, `${JSON.stringify(subtitlesWords, null, 2)}\n`, 'utf8');
  fs.rmSync(rawPath, { force: true });

  console.log(`原始段数: ${segments.length}`);
  console.log(`分词后字数: ${words.length}`);
  console.log(`总元素数: ${subtitlesWords.length}`);
  const gapSegments = subtitlesWords.filter((w) => w.isGap);
  const gapSec = gapSegments.reduce((sum, g) => sum + Math.max(0, Number(g.end) - Number(g.start)), 0);
  console.log(`静音检测: ffmpeg=${detectedSilence.length} 段, segment-gap=${inferredSilence.length} 段`);
  console.log(`静音段数: ${gapSegments.length}`);
  console.log(`静音总时长: ${summarizeSilence(gapSec)}s (threshold>=${minDeleteSec.toFixed(2)}s, noise=${silenceNoiseDb}dB)`);
  console.log(`✅ 已保存 ${outputPath}`);
}

try {
  runWhisper();
} catch (err) {
  console.error(`❌ 本地 Whisper 转录失败: ${err.message}`);
  process.exit(1);
}
