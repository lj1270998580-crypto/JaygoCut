#!/usr/bin/env node

const fs = require('fs');

const AUDIO_URL = process.argv[2];
if (!AUDIO_URL) {
  console.error('Usage: node qwen_asr_transcribe.js <audio_url>');
  process.exit(1);
}

const API_KEY = process.env.DASHSCOPE_API_KEY || process.env.ALIYUN_DASHSCOPE_API_KEY || '';
if (!API_KEY) {
  console.error('DASHSCOPE_API_KEY is missing.');
  process.exit(1);
}

const BASE_URL = (process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1').replace(/\/+$/, '');
const SUBMIT_URL = `${BASE_URL}/services/audio/asr/transcription`;
const TASK_URL = `${BASE_URL}/tasks`;
const MODEL = process.env.DASHSCOPE_ASR_MODEL || 'qwen3-asr-flash-filetrans';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 800)}`);
  }
  return json;
}

function wordFromQwenWord(word) {
  const startMs = Number(word.begin_time ?? word.start_time ?? word.start);
  const endMs = Number(word.end_time ?? word.finish_time ?? word.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const text = String(word.text ?? word.word ?? '').trim();
  const punctuation = String(word.punctuation ?? '').trim();
  return {
    text: text + punctuation,
    start: startMs / 1000,
    end: endMs / 1000,
  };
}

function sentenceToChars(sentence) {
  const text = String(sentence.text || '').replace(/\s+/g, '');
  const startMs = Number(sentence.begin_time ?? sentence.start_time ?? sentence.start);
  const endMs = Number(sentence.end_time ?? sentence.finish_time ?? sentence.end);
  if (!text || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const start = startMs / 1000;
  const end = endMs / 1000;
  const chars = Array.from(text);
  const step = (end - start) / Math.max(1, chars.length);
  return chars.map((char, index) => ({
    text: char,
    start: start + step * index,
    end: index === chars.length - 1 ? end : start + step * (index + 1),
  }));
}

function toSubtitlesWords(result) {
  const words = [];
  const transcripts = Array.isArray(result.transcripts) ? result.transcripts : [];
  for (const transcript of transcripts) {
    const sentences = Array.isArray(transcript.sentences) ? transcript.sentences : [];
    for (const sentence of sentences) {
      const sentenceWords = Array.isArray(sentence.words) ? sentence.words : [];
      if (sentenceWords.length) {
        for (const rawWord of sentenceWords) {
          const word = wordFromQwenWord(rawWord);
          if (word && word.text) words.push(word);
        }
      } else {
        words.push(...sentenceToChars(sentence));
      }
    }
  }

  words.sort((a, b) => a.start - b.start);
  if (!words.length) {
    throw new Error('Qwen-ASR returned no usable words or sentences.');
  }

  const out = [];
  let lastEnd = 0;
  for (const word of words) {
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

function findTranscriptionUrl(output) {
  const candidates = [
    output?.result?.transcription_url,
    output?.result?.url,
    output?.transcription_url,
  ];
  const results = Array.isArray(output?.results) ? output.results : [];
  for (const item of results) {
    candidates.push(item?.transcription_url, item?.url, item?.file_url);
  }
  return candidates.find((value) => typeof value === 'string' && /^https?:\/\//i.test(value));
}

function normalizeTranscriptionPayload(payload) {
  if (Array.isArray(payload)) return { transcripts: payload };
  if (Array.isArray(payload?.transcripts)) return payload;
  if (Array.isArray(payload?.results)) return { transcripts: payload.results };
  if (Array.isArray(payload?.output?.transcripts)) return { transcripts: payload.output.transcripts };
  if (Array.isArray(payload?.output?.results)) return { transcripts: payload.output.results };
  return payload || {};
}

async function main() {
  console.log('Submitting Qwen-ASR task...');
  const submit = await requestJson(SUBMIT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: MODEL,
      input: {
        file_url: AUDIO_URL,
      },
      parameters: {
        channel_id: [0],
        language: 'zh',
        enable_itn: true,
        enable_words: true,
      },
    }),
  });

  const taskId = submit?.output?.task_id;
  if (!taskId) {
    throw new Error(`Submit failed: ${JSON.stringify(submit).slice(0, 1000)}`);
  }
  console.log(`Task submitted: ${taskId}`);

  for (let attempt = 0; attempt < 180; attempt += 1) {
    await sleep(3000);
    const query = await requestJson(`${TASK_URL}/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
      },
    });

    const output = query.output || {};
    const status = output.task_status;
    if (status === 'PENDING' || status === 'RUNNING') {
      process.stdout.write('.');
      continue;
    }

    if (status === 'FAILED' || status === 'UNKNOWN') {
      throw new Error(`Qwen-ASR task failed: ${JSON.stringify(output).slice(0, 1000)}`);
    }

    if (status === 'SUCCEEDED') {
      const transcriptionUrl = findTranscriptionUrl(output);
      if (!transcriptionUrl) {
        throw new Error(`Missing transcription_url: ${JSON.stringify(query).slice(0, 1000)}`);
      }
      console.log(`\nDownloading transcription result...`);
      const transcription = await requestJson(transcriptionUrl);
      fs.writeFileSync('qwen_asr_result.json', `${JSON.stringify(transcription, null, 2)}\n`, 'utf8');
      const subtitles = toSubtitlesWords(normalizeTranscriptionPayload(transcription));
      fs.writeFileSync('subtitles_words.json', `${JSON.stringify(subtitles, null, 2)}\n`, 'utf8');
      const gapCount = subtitles.filter((x) => x.isGap).length;
      const wordCount = subtitles.length - gapCount;
      console.log(`Qwen-ASR completed. words=${wordCount}, gaps=${gapCount}`);
      process.exit(0);
    }
  }

  throw new Error('Qwen-ASR task timed out.');
}

main().catch((err) => {
  console.error('Error:', err.message || String(err));
  process.exit(1);
});
