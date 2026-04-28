#!/usr/bin/env node

const fs = require('fs');
const { normalizeSelectedIndices } = require('./auto_selected_utils');

const subtitlesPath = process.argv[2];
const outputPath = process.argv[3] || 'auto_selected.json';
const thresholdArg = Number(process.argv[4]);
const threshold = Number.isFinite(thresholdArg) && thresholdArg >= 0.2 ? thresholdArg : 0.2;
const thresholdEpsilon = 0.0005;

if (!subtitlesPath) {
  console.error('Usage: node auto_select_silence.js <subtitles_words.json> [auto_selected.json] [thresholdSec]');
  process.exit(1);
}

if (!fs.existsSync(subtitlesPath)) {
  console.error(`Subtitles file not found: ${subtitlesPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(subtitlesPath, 'utf8').replace(/^\uFEFF/, '');
const words = JSON.parse(raw);
if (!Array.isArray(words)) {
  console.error('Invalid subtitles_words.json: expected array');
  process.exit(1);
}

function round2(v) {
  return Math.round(Number(v || 0) * 100) / 100;
}

function normalizeTokenText(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[，。！？、；：,.!?;:\s"'“”‘’（）()【】[\]{}<>《》]/g, '');
}

function isInfoDenseText(text) {
  const rawText = String(text || '');
  if (!rawText.trim()) return false;
  if (/\d/.test(rawText)) return true;
  if (/[A-Z]{2,}/.test(rawText)) return true;
  if (/(元|块|万|亿|%|公里|分钟|小时|日期|时间|第[一二三四五六七八九十\d])/u.test(rawText)) return true;
  return false;
}

function diceSimilarity(a, b) {
  const s1 = normalizeTokenText(a);
  const s2 = normalizeTokenText(b);
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

function buildUnits(items) {
  const units = [];
  let current = null;

  const flush = () => {
    if (!current || !current.indices.length) {
      current = null;
      return;
    }
    current.text = current.tokens.join('');
    current.norm = normalizeTokenText(current.text);
    units.push(current);
    current = null;
  };

  for (let i = 0; i < items.length; i += 1) {
    const w = items[i] || {};
    const text = String(w.text || '').trim();
    const start = Number(w.start);
    const end = Number(w.end);
    const isGap = !!w.isGap;
    const dur = end - start;

    if (isGap) {
      if (Number.isFinite(dur) && dur >= 0.2) {
        flush();
      }
      continue;
    }

    if (!text) continue;

    if (!current) {
      current = {
        indices: [],
        tokens: [],
        start: Number.isFinite(start) ? start : 0,
        end: Number.isFinite(end) ? end : (Number.isFinite(start) ? start : 0),
      };
    }

    current.indices.push(i);
    current.tokens.push(text);
    current.end = Number.isFinite(end) ? end : current.end;

    if (/[。！？!?；;]$/.test(text) || current.indices.length >= 36) {
      flush();
    }
  }

  flush();
  return units;
}

const fillerSingles = new Set([
  '嗯', '呃', '额', '啊', '唉', '哦', '诶', '欸', '哎', '哈', '嘛', '啦',
]);

const fillerPhrases = new Set([
  '就是',
  '然后',
  '然后呢',
  '那个',
  '这个',
  '其实',
  '怎么说呢',
  '你知道吧',
  '就是说',
  '总之就是',
]);

const selectedSet = new Set();
const reasonByIndex = new Map();
const stats = {
  silence: 0,
  filler: 0,
  repeat: 0,
  bridgeGap: 0,
};

function addReason(index, reason) {
  if (!Number.isInteger(index) || index < 0 || index >= words.length) return;
  let set = reasonByIndex.get(index);
  if (!set) {
    set = new Set();
    reasonByIndex.set(index, set);
  }
  set.add(reason);
}

function markIndices(indices, reason) {
  for (const idx of indices) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= words.length) continue;
    selectedSet.add(idx);
    addReason(idx, reason);
  }
}

for (let i = 0; i < words.length; i += 1) {
  const item = words[i];
  if (!item || !item.isGap) continue;
  const dur = Number(item.end) - Number(item.start);
  if (Number.isFinite(dur) && dur + thresholdEpsilon >= threshold) {
    if (!selectedSet.has(i)) stats.silence += 1;
    selectedSet.add(i);
    addReason(i, `silence >= ${threshold.toFixed(2)}s`);
  }
}

const units = buildUnits(words);

for (let i = 0; i < words.length; i += 1) {
  const w = words[i] || {};
  if (w.isGap) continue;
  const rawText = String(w.text || '').trim();
  const text = normalizeTokenText(rawText);
  if (!text) continue;

  const dur = Number(w.end) - Number(w.start);
  const isShortToken = Number.isFinite(dur) ? dur <= 1.2 : true;
  if (isShortToken && fillerSingles.has(text)) {
    if (!selectedSet.has(i)) stats.filler += 1;
    selectedSet.add(i);
    addReason(i, 'filler-word');
  }
}

for (const unit of units) {
  if (!unit || !unit.indices || !unit.indices.length) continue;
  const text = String(unit.text || '');
  const norm = String(unit.norm || '');
  if (!norm) continue;
  if (isInfoDenseText(text)) continue;

  const shortEnough = norm.length <= 8;
  const isPureFiller = fillerPhrases.has(norm) || /^([嗯呃额啊哦欸诶哎哈嘛啦]+)$/.test(norm);
  if (shortEnough && isPureFiller) {
    let added = 0;
    for (const idx of unit.indices) {
      if (!selectedSet.has(idx)) added += 1;
    }
    if (added > 0) stats.filler += added;
    markIndices(unit.indices, 'filler-phrase');
  }

  const fillerTokenCount = unit.tokens
    .map((t) => normalizeTokenText(t))
    .filter((t) => fillerSingles.has(t)).length;
  const fillerRatio = unit.tokens.length ? (fillerTokenCount / unit.tokens.length) : 0;
  if (unit.tokens.length <= 18 && fillerRatio >= 0.6) {
    let added = 0;
    for (const idx of unit.indices) {
      if (!selectedSet.has(idx)) added += 1;
    }
    if (added > 0) stats.filler += added;
    markIndices(unit.indices, 'filler-chain');
  }
}

for (const unit of units) {
  if (!unit || !Array.isArray(unit.tokens) || unit.tokens.length < 6) continue;
  if (!Array.isArray(unit.indices) || unit.indices.length !== unit.tokens.length) continue;
  if (isInfoDenseText(unit.text)) continue;

  const tokenNorms = unit.tokens.map((t) => normalizeTokenText(t));
  const maxN = Math.min(12, Math.floor(tokenNorms.length / 2));
  let marked = false;

  for (let n = 3; n <= maxN; n += 1) {
    let same = true;
    for (let k = 0; k < n; k += 1) {
      if (!tokenNorms[k] || tokenNorms[k] !== tokenNorms[k + n]) {
        same = false;
        break;
      }
    }
    if (!same) continue;

    const secondHalf = unit.indices.slice(n, 2 * n);
    let added = 0;
    for (const idx of secondHalf) {
      if (!selectedSet.has(idx)) added += 1;
    }
    if (added > 0) stats.repeat += added;
    markIndices(secondHalf, 'repeated sentence (later)');
    marked = true;
    break;
  }

  if (marked) continue;
}

for (let i = 1; i < units.length; i += 1) {
  const cur = units[i];
  if (!cur || !cur.indices.length) continue;
  if (cur.norm.length < 4) continue;
  if (isInfoDenseText(cur.text)) continue;

  for (let back = 1; back <= 3; back += 1) {
    const j = i - back;
    if (j < 0) break;
    const prev = units[j];
    if (!prev || !prev.indices.length) continue;
    if (prev.norm.length < 4) continue;

    const timeGap = Number(cur.start) - Number(prev.end);
    if (Number.isFinite(timeGap) && timeGap > 35) continue;

    const sim = diceSimilarity(cur.text, prev.text);
    const lenRatio = cur.norm.length / Math.max(1, prev.norm.length);
    const containment = cur.norm.length >= 6 && prev.norm.length >= 6
      && (cur.norm.includes(prev.norm) || prev.norm.includes(cur.norm));
    if ((sim >= 0.84 && lenRatio <= 1.35) || (containment && sim >= 0.74)) {
      let added = 0;
      for (const idx of cur.indices) {
        if (!selectedSet.has(idx)) added += 1;
      }
      if (added > 0) stats.repeat += added;
      markIndices(cur.indices, 'repeated sentence (later)');
      break;
    }
  }
}

const selectedBeforeNormalize = new Set(selectedSet);
const normalized = normalizeSelectedIndices(words, Array.from(selectedSet));

for (const idx of normalized.indices) {
  if (selectedBeforeNormalize.has(idx)) continue;
  if (words[idx] && words[idx].isGap) {
    stats.bridgeGap += 1;
    addReason(idx, 'bridge short gap');
  }
}

const reasons = {};
for (const idx of normalized.indices) {
  const set = reasonByIndex.get(idx);
  if (set && set.size) {
    reasons[String(idx)] = Array.from(set).join(' + ');
  } else if (words[idx] && words[idx].isGap) {
    reasons[String(idx)] = `silence >= ${threshold.toFixed(2)}s`;
  }
}

const payload = {
  indices: normalized.indices,
  reasons,
  stats: {
    thresholdSec: round2(threshold),
    silenceCount: stats.silence,
    fillerCount: stats.filler,
    repeatCount: stats.repeat,
    bridgeGapCount: stats.bridgeGap,
    total: normalized.indices.length,
  },
};

fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(
  `Selected ${payload.stats.total} items`
  + ` | silence=${payload.stats.silenceCount}`
  + ` | filler=${payload.stats.fillerCount}`
  + ` | repeat=${payload.stats.repeatCount}`
  + ` | bridgeGap=${payload.stats.bridgeGapCount}`
  + ` | threshold>=${threshold.toFixed(2)}s`,
);
console.log(`Output: ${outputPath}`);
