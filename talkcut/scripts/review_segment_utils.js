function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeBoundarySettings(settings = {}) {
  return {
    speechLeadMs: clampNumber(settings.speechLeadMs, 0, 180, 45),
    speechTailMs: clampNumber(settings.speechTailMs, 0, 220, 90),
    fillerBoostMs: clampNumber(settings.fillerBoostMs, 0, 120, 30),
    silenceGuardMs: clampNumber(settings.silenceGuardMs, 0, 120, 45),
  };
}

function buildReviewDeleteSegments(words, selectedIndices, options = {}) {
  const selected = new Set(Array.isArray(selectedIndices) ? selectedIndices.map(Number) : []);
  const tokenCategory = typeof options.tokenCategory === 'function' ? options.tokenCategory : () => null;
  const boundary = normalizeBoundarySettings(options.boundarySettings);
  const residualGapSec = 0.18;
  const speechPadBeforeSec = boundary.speechLeadMs / 1000;
  const speechPadAfterSec = boundary.speechTailMs / 1000;
  const silenceEdgeGuardSec = boundary.silenceGuardMs / 1000;
  const fillerBoostSec = boundary.fillerBoostMs / 1000;
  const speechEntryOverlapSec = Math.max(0.025, Math.min(0.08, speechPadBeforeSec * 0.9));
  const fillerEntryOverlapSec = Math.max(speechEntryOverlapSec, Math.min(0.12, speechEntryOverlapSec + fillerBoostSec));
  const boundaryGuardSec = 0.005;
  const minDeleteSec = 0.05;

  const segs = Array.from(selected)
    .map((i) => ({ idx: Number(i), word: words[i] }))
    .filter((item) => Number.isInteger(item.idx) && item.word)
    .map(({ idx, word: w }) => ({
      idx,
      start: Number(w.start),
      end: Number(w.end),
      hasSpeech: !w.isGap,
      hasFiller: tokenCategory(idx) === 'filler',
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.idx - b.idx || a.start - b.start);

  const merged = [];
  function canBridgeSelectionGap(prevIdx, nextIdx) {
    for (let i = prevIdx + 1; i < nextIdx; i += 1) {
      if (selected.has(i)) continue;
      if (!words[i]?.isGap) return false;
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
      const w = words[i];
      if (!w || w.isGap) continue;
      const end = Number(w.end);
      return Number.isFinite(end) ? end : null;
    }
    return null;
  }

  function getNextSpeechStart(idx) {
    for (let i = idx + 1; i < words.length; i += 1) {
      const w = words[i];
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

function normalizeSegments(segments, durationSec) {
  const maxDuration = Number.isFinite(Number(durationSec)) && Number(durationSec) > 0
    ? Number(durationSec)
    : Number.POSITIVE_INFINITY;
  return (Array.isArray(segments) ? segments : [])
    .map((seg) => ({
      start: Math.max(0, Number(seg?.start)),
      end: Math.min(maxDuration, Number(seg?.end)),
    }))
    .filter((seg) => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function mergeSegments(segments) {
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

function applyCutPrecisionMode(segments, mode = 'standard', durationSec) {
  const normalized = normalizeSegments(segments, durationSec);
  const selectedMode = ['conservative', 'standard', 'clean'].includes(mode) ? mode : 'standard';
  if (selectedMode === 'standard') {
    return normalized.map((seg) => ({
      start: Number(seg.start.toFixed(3)),
      end: Number(seg.end.toFixed(3)),
    }));
  }

  const maxDuration = Number.isFinite(Number(durationSec)) && Number(durationSec) > 0
    ? Number(durationSec)
    : Number.POSITIVE_INFINITY;
  const adjusted = normalized.map((seg) => {
    const duration = seg.end - seg.start;
    if (selectedMode === 'clean') {
      const lead = duration < 0.16 ? 0.025 : 0.04;
      const tail = duration < 0.16 ? 0.035 : 0.06;
      return {
        start: Math.max(0, seg.start - lead),
        end: Math.min(maxDuration, seg.end + tail),
      };
    }

    const trim = Math.min(0.025, Math.max(0, (duration - 0.06) / 2));
    return {
      start: seg.start + trim,
      end: seg.end - trim,
    };
  }).filter((seg) => seg.end - seg.start >= 0.03);

  return mergeSegments(adjusted);
}

function findNearestWordIndex(words, timeSec, direction) {
  if (!Array.isArray(words)) return -1;
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (!word || word.isGap) continue;
    const start = Number(word.start);
    const end = Number(word.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (direction === 'prev' && end > timeSec) continue;
    if (direction === 'next' && start < timeSec) continue;
    const point = direction === 'prev' ? end : start;
    const distance = Math.abs(point - timeSec);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function diagnoseDeleteSegments(segments, words = [], options = {}) {
  const normalized = normalizeSegments(segments, options.durationSec);
  const risks = [];
  const shortSec = Number.isFinite(Number(options.shortSec)) ? Number(options.shortSec) : 0.16;
  const longSec = Number.isFinite(Number(options.longSec)) ? Number(options.longSec) : 8;
  const tightSec = Number.isFinite(Number(options.tightSec)) ? Number(options.tightSec) : 0.045;
  const denseGapSec = Number.isFinite(Number(options.denseGapSec)) ? Number(options.denseGapSec) : 0.25;
  let denseCount = 0;

  const details = normalized.map((seg, index) => {
    const durationSec = seg.end - seg.start;
    const detail = {
      index,
      start: Number(seg.start.toFixed(3)),
      end: Number(seg.end.toFixed(3)),
      durationSec: Number(durationSec.toFixed(3)),
      prevWordIndex: findNearestWordIndex(words, seg.start, 'prev'),
      nextWordIndex: findNearestWordIndex(words, seg.end, 'next'),
      risks: [],
    };

    if (durationSec < shortSec) {
      detail.risks.push('short');
      risks.push({ type: 'short', index, message: '删除段过短，可能残留碎音。', ...detail });
    }
    if (durationSec > longSec) {
      detail.risks.push('long');
      risks.push({ type: 'long', index, message: '删除段较长，请确认没有误删有效内容。', ...detail });
    }

    const prevWord = words[detail.prevWordIndex];
    const nextWord = words[detail.nextWordIndex];
    const prevGap = prevWord ? seg.start - Number(prevWord.end) : Number.POSITIVE_INFINITY;
    const nextGap = nextWord ? Number(nextWord.start) - seg.end : Number.POSITIVE_INFINITY;
    if ((Number.isFinite(prevGap) && prevGap >= 0 && prevGap < tightSec)
      || (Number.isFinite(nextGap) && nextGap >= 0 && nextGap < tightSec)) {
      detail.risks.push('tight');
      risks.push({ type: 'tight', index, message: '删除段紧贴保留词，可能吞字或留下尾音。', ...detail });
    }

    const nextSeg = normalized[index + 1];
    if (nextSeg && nextSeg.start - seg.end >= 0 && nextSeg.start - seg.end < denseGapSec) {
      detail.risks.push('dense');
      denseCount += 1;
      risks.push({ type: 'dense', index, message: '附近删除段过密，建议预听确认节奏。', ...detail });
    }

    return detail;
  });

  const totalDurationSec = normalized.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
  const byDuration = [...details].sort((a, b) => a.durationSec - b.durationSec);
  return {
    count: normalized.length,
    totalDurationSec: Number(totalDurationSec.toFixed(3)),
    longest: byDuration.length ? byDuration[byDuration.length - 1] : null,
    shortest: byDuration.length ? byDuration[0] : null,
    denseCount,
    risks,
    segments: details,
  };
}

module.exports = {
  applyCutPrecisionMode,
  buildReviewDeleteSegments,
  diagnoseDeleteSegments,
  normalizeBoundarySettings,
};
