#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { analyzeTranscriptQuality } = require('./transcript_quality');

const AUDIO_FILE = process.argv[2];
if (!AUDIO_FILE) {
  console.error('Usage: node mimo_asr_transcribe.js <audio.mp3|audio.wav>');
  process.exit(1);
}

if (!fs.existsSync(AUDIO_FILE)) {
  console.error(`Audio file not found: ${AUDIO_FILE}`);
  process.exit(1);
}

const API_KEY = process.env.MIMO_API_KEY || '';
if (!API_KEY) {
  console.error('MIMO_API_KEY is missing.');
  process.exit(1);
}

const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_BIN || 'ffprobe';
const BASE_URL = (process.env.MIMO_ASR_BASE_URL || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '');
const MODEL = process.env.MIMO_ASR_MODEL || 'mimo-v2.5-asr';
const LANGUAGE = ['auto', 'zh', 'en'].includes(String(process.env.MIMO_ASR_LANGUAGE || '').trim())
  ? String(process.env.MIMO_ASR_LANGUAGE).trim()
  : 'zh';
const MAX_DATA_URL_CHARS = Math.min(
  10_000_000,
  Math.max(1_000_000, Number(process.env.MIMO_ASR_MAX_DATA_URL_CHARS) || 9_500_000),
);
const CHUNK_SEC = Math.max(60, Math.min(600, Number(process.env.MIMO_ASR_CHUNK_SEC) || 300));

function endpoint() {
  if (/\/chat\/completions$/i.test(BASE_URL)) return BASE_URL;
  return `${BASE_URL}/chat/completions`;
}

function shellArg(value) {
  return String(value);
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probeDuration(filePath) {
  try {
    const out = execFileSync(FFPROBE_BIN, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      shellArg(filePath),
    ], { encoding: 'utf8', windowsHide: true }).trim();
    const duration = Number(out);
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  } catch {
    return 0;
  }
}

function dataUrlFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.wav' ? 'audio/wav' : 'audio/mpeg';
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

function ensureChunks(audioFile) {
  const originalDataUrl = dataUrlFor(audioFile);
  const originalDuration = probeDuration(audioFile);
  if (originalDataUrl.length <= MAX_DATA_URL_CHARS) {
    return [{
      file: audioFile,
      offset: 0,
      duration: originalDuration,
      dataUrlLength: originalDataUrl.length,
    }];
  }

  const chunkDir = path.join(process.cwd(), 'mimo_chunks');
  fs.rmSync(chunkDir, { recursive: true, force: true });
  fs.mkdirSync(chunkDir, { recursive: true });
  const pattern = path.join(chunkDir, 'chunk_%03d.mp3');
  console.log(`MiMo audio exceeds data URL limit (${originalDataUrl.length} chars). Splitting into ${CHUNK_SEC}s chunks...`);
  execFileSync(FFMPEG_BIN, [
    '-y',
    '-i',
    audioFile,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-b:a',
    '48k',
    '-f',
    'segment',
    '-segment_time',
    String(CHUNK_SEC),
    '-reset_timestamps',
    '1',
    pattern,
  ], { stdio: 'inherit', windowsHide: true });

  const files = fs.readdirSync(chunkDir)
    .filter((name) => /^chunk_\d+\.mp3$/i.test(name))
    .sort()
    .map((name) => path.join(chunkDir, name));

  if (!files.length) throw new Error('Failed to create MiMo ASR audio chunks.');

  let offset = 0;
  return files.map((file) => {
    const duration = probeDuration(file);
    const info = { file, offset, duration, dataUrlLength: dataUrlFor(file).length };
    if (info.dataUrlLength > MAX_DATA_URL_CHARS) {
      throw new Error(`MiMo chunk is still too large: ${path.basename(file)} (${info.dataUrlLength} chars)`);
    }
    offset += duration || CHUNK_SEC;
    return info;
  });
}

function collectText(raw, out = []) {
  if (raw === null || raw === undefined) return out;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text) out.push(text);
    return out;
  }
  if (Array.isArray(raw)) {
    raw.forEach((item) => collectText(item, out));
    return out;
  }
  if (typeof raw === 'object') {
    if (typeof raw.text === 'string') collectText(raw.text, out);
    if (typeof raw.content === 'string') collectText(raw.content, out);
    if (typeof raw.transcript === 'string') collectText(raw.transcript, out);
    if (typeof raw.result === 'string') collectText(raw.result, out);
  }
  return out;
}

function extractTranscript(json) {
  const candidates = [
    json?.choices?.[0]?.message?.content,
    json?.choices?.[0]?.delta?.content,
    json?.output?.text,
    json?.text,
    json?.transcript,
  ];
  return candidates.flatMap((item) => collectText(item, [])).join('').trim();
}

async function requestMimo(dataUrl, attempt = 0) {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: {
      'api-key': API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
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
      asr_options: { language: LANGUAGE },
      stream: false,
    }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // handled below
  }
  if (!res.ok || !json) {
    if (attempt < 2) {
      await sleep(900 * (attempt + 1));
      return requestMimo(dataUrl, attempt + 1);
    }
    throw new Error(`MiMo ASR HTTP ${res.status}: ${text.slice(0, 1000)}`);
  }
  return json;
}

function textToTimedWords(text, offset, duration) {
  const clean = String(text || '').replace(/\s+/g, '');
  const chars = Array.from(clean);
  if (!chars.length) return [];
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : Math.max(1, chars.length * 0.18);
  const step = safeDuration / chars.length;
  return chars.map((char, index) => ({
    text: char,
    start: offset + step * index,
    end: offset + (index === chars.length - 1 ? safeDuration : step * (index + 1)),
  }));
}

function addGaps(words) {
  const out = [];
  let lastEnd = 0;
  for (const word of words.sort((a, b) => a.start - b.start)) {
    if (word.start - lastEnd > 0.1) {
      out.push({
        text: '',
        start: round3(lastEnd),
        end: round3(word.start),
        isGap: true,
      });
    }
    out.push({
      text: word.text,
      start: round3(word.start),
      end: round3(word.end),
      isGap: false,
    });
    lastEnd = Math.max(lastEnd, word.end);
  }
  return out;
}

async function main() {
  const chunks = ensureChunks(AUDIO_FILE);
  console.log(`MiMo-V2.5-ASR started. chunks=${chunks.length}, language=${LANGUAGE}`);
  const rawResults = [];
  const words = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    console.log(`Submitting MiMo chunk ${i + 1}/${chunks.length}: ${path.basename(chunk.file)} (${chunk.dataUrlLength} chars)`);
    const json = await requestMimo(dataUrlFor(chunk.file));
    const transcript = extractTranscript(json);
    rawResults.push({
      index: i,
      file: path.basename(chunk.file),
      offset: round3(chunk.offset),
      duration: round3(chunk.duration),
      transcript,
      response: json,
    });
    if (!transcript) {
      console.warn(`MiMo chunk ${i + 1} returned empty text.`);
      continue;
    }
    words.push(...textToTimedWords(transcript, chunk.offset, chunk.duration));
  }

  fs.writeFileSync('mimo_asr_result.json', `${JSON.stringify({
    model: MODEL,
    language: LANGUAGE,
    estimated_timestamps: true,
    chunks: rawResults,
  }, null, 2)}\n`, 'utf8');

  if (!words.length) {
    throw new Error('MiMo ASR returned no usable transcript text.');
  }

  const subtitles = addGaps(words);
  const quality = analyzeTranscriptQuality(subtitles);
  quality.warnings = Array.from(new Set([
    ...(quality.warnings || []),
    'MiMo-V2.5-ASR 当前接口只返回文本，Jaygo Cut 已按音频时长估算字级时间戳；如需精确剪字，建议使用火山/阿里或本地 Whisper。',
  ]));
  quality.estimatedTimestamps = true;
  quality.asrEngine = 'mimo';

  fs.writeFileSync('transcript_quality.json', `${JSON.stringify(quality, null, 2)}\n`, 'utf8');
  fs.writeFileSync('subtitles_words.json', `${JSON.stringify(subtitles, null, 2)}\n`, 'utf8');
  const gapCount = subtitles.filter((x) => x.isGap).length;
  console.log(`MiMo-ASR completed. words=${subtitles.length - gapCount}, gaps=${gapCount}, estimated_timestamps=true`);
}

main().catch((err) => {
  console.error('Error:', err.message || String(err));
  process.exit(1);
});
