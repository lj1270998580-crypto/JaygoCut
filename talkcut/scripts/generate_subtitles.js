#!/usr/bin/env node

const fs = require('fs');

const resultFile = process.argv[2] || 'volcengine_result.json';
const deleteFile = process.argv[3];

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

if (!fs.existsSync(resultFile)) {
  console.error(`未找到转录结果文件: ${resultFile}`);
  process.exit(1);
}

const result = loadJson(resultFile);
const utterances = Array.isArray(result.utterances) ? result.utterances : [];

const rawWords = [];
for (const utt of utterances) {
  const words = Array.isArray(utt.words) ? utt.words : [];
  for (const w of words) {
    const start = Number(w.start_time) / 1000;
    const end = Number(w.end_time) / 1000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    rawWords.push({
      text: String(w.text ?? ''),
      start,
      end,
    });
  }
}

if (rawWords.length === 0 && utterances.length > 0) {
  for (const utt of utterances) {
    const text = String(utt.text ?? utt.result_text ?? '').replace(/\s+/g, '');
    const startMs = Number(utt.start_time ?? utt.startTime ?? utt.start);
    const endMs = Number(utt.end_time ?? utt.endTime ?? utt.end);
    const start = startMs > 1000 ? startMs / 1000 : startMs;
    const end = endMs > 1000 ? endMs / 1000 : endMs;
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const chars = Array.from(text);
    const step = (end - start) / chars.length;
    chars.forEach((char, index) => {
      rawWords.push({
        text: char,
        start: start + step * index,
        end: index === chars.length - 1 ? end : start + step * (index + 1),
      });
    });
  }
  if (rawWords.length > 0) {
    console.log(`火山结果缺少 word 级时间戳，已按句级时间戳生成 ${rawWords.length} 个字符级元素`);
  }
}

if (rawWords.length === 0) {
  console.error('转录结果为空：火山引擎返回中没有可用的 words/text 时间戳，已停止生成审核页。');
  process.exit(1);
}

rawWords.sort((a, b) => a.start - b.start);
console.log(`原始字数: ${rawWords.length}`);

let words = rawWords;

if (deleteFile && fs.existsSync(deleteFile)) {
  const segs = loadJson(deleteFile)
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .map((s) => ({ start: Number(s.start), end: Number(s.end) }))
    .sort((a, b) => a.start - b.start);

  function overlap(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && aEnd > bStart;
  }

  function deletedBefore(t) {
    let d = 0;
    for (const s of segs) {
      if (s.end <= t) d += s.end - s.start;
      else if (s.start < t) d += t - s.start;
      else break;
    }
    return d;
  }

  words = [];
  for (const w of rawWords) {
    let removed = false;
    for (const s of segs) {
      if (s.start >= w.end) break;
      if (overlap(w.start, w.end, s.start, s.end)) {
        removed = true;
        break;
      }
    }
    if (removed) continue;

    const shift = deletedBefore(w.start);
    words.push({
      text: w.text,
      start: round3(w.start - shift),
      end: round3(w.end - shift),
      isGap: false,
    });
  }

  console.log(`映射后字数: ${words.length}`);
} else {
  words = words.map((w) => ({ ...w, isGap: false }));
}

const withGaps = [];
let lastEnd = 0;
for (const w of words) {
  const gap = w.start - lastEnd;
  if (gap > 0.1) {
    withGaps.push({
      text: '',
      start: round3(lastEnd),
      end: round3(w.start),
      isGap: true,
    });
  }
  withGaps.push({
    text: w.text,
    start: round3(w.start),
    end: round3(w.end),
    isGap: false,
  });
  lastEnd = w.end;
}

const gapCount = withGaps.filter((x) => x.isGap).length;
console.log(`总元素数: ${withGaps.length}`);
console.log(`空白段数: ${gapCount}`);

fs.writeFileSync('subtitles_words.json', JSON.stringify(withGaps, null, 2), 'utf8');
console.log('✅ 已保存 subtitles_words.json');
