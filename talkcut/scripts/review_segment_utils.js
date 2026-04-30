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

module.exports = {
  buildReviewDeleteSegments,
  normalizeBoundarySettings,
};
