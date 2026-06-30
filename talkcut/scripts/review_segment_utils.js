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

function normalizeCutKind(value) {
  const raw = String(value || '').toLowerCase();
  if (raw.includes('silence') || raw.includes('gap')) return 'silence';
  if (raw.includes('filler') || raw.includes('utterance')) return 'filler';
  if (raw.includes('repeat')) return 'repeat';
  if (raw.includes('llm') || raw.includes('ai')) return 'llm';
  if (raw.includes('manual')) return 'manual';
  if (raw.includes('mixed')) return 'mixed';
  return '';
}

function collectCutKinds(seg) {
  const kinds = new Set();
  const push = (value) => {
    const kind = normalizeCutKind(value);
    if (kind) kinds.add(kind);
  };
  push(seg?.kind);
  push(seg?.category);
  push(seg?.type);
  if (Array.isArray(seg?.sourceKinds)) seg.sourceKinds.forEach(push);
  if (seg?.hasFiller) push('filler');
  if (seg?.hasSpeech === false) push('silence');
  if (!kinds.size) kinds.add('manual');
  return Array.from(kinds);
}

function normalizeCutSegments(segments, durationSec) {
  const maxDuration = Number.isFinite(Number(durationSec)) && Number(durationSec) > 0
    ? Number(durationSec)
    : Number.POSITIVE_INFINITY;
  return (Array.isArray(segments) ? segments : [])
    .map((seg) => {
      const start = Math.max(0, Number(seg?.start));
      const end = Math.min(maxDuration, Number(seg?.end));
      const sourceKinds = collectCutKinds(seg);
      return {
        ...seg,
        start,
        end,
        kind: normalizeCutKind(seg?.kind || seg?.category || seg?.type) || sourceKinds[0] || 'manual',
        sourceKinds,
      };
    })
    .filter((seg) => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function joinCutKinds(a, b) {
  return Array.from(new Set([...(a || []), ...(b || [])].map(normalizeCutKind).filter(Boolean)));
}

function mergeCutSegments(segments, mergeGapSec = 0) {
  const merged = [];
  let mergedCloseGaps = 0;
  for (const seg of segments) {
    if (!merged.length || seg.start > merged[merged.length - 1].end + mergeGapSec) {
      merged.push({ ...seg, sourceKinds: collectCutKinds(seg) });
      continue;
    }
    const last = merged[merged.length - 1];
    if (seg.start > last.end) mergedCloseGaps += 1;
    last.end = Math.max(last.end, seg.end);
    last.minIdx = Number.isFinite(Number(last.minIdx)) && Number.isFinite(Number(seg.minIdx))
      ? Math.min(Number(last.minIdx), Number(seg.minIdx))
      : last.minIdx;
    last.maxIdx = Number.isFinite(Number(last.maxIdx)) && Number.isFinite(Number(seg.maxIdx))
      ? Math.max(Number(last.maxIdx), Number(seg.maxIdx))
      : last.maxIdx;
    last.sourceKinds = joinCutKinds(last.sourceKinds, collectCutKinds(seg));
    last.kind = last.sourceKinds.includes('mixed') || last.sourceKinds.length > 1
      ? 'mixed'
      : (last.sourceKinds[0] || last.kind || 'manual');
  }
  return {
    segments: merged.map((seg) => ({
      ...seg,
      start: Number(seg.start.toFixed(3)),
      end: Number(seg.end.toFixed(3)),
    })),
    mergedCloseGaps,
  };
}

function getBoundaryPolicy(sourceKinds, mode = 'standard') {
  const kinds = Array.isArray(sourceKinds) ? sourceKinds : ['manual'];
  const hasSpeechLike = kinds.some((kind) => ['filler', 'repeat', 'llm', 'manual', 'mixed'].includes(kind));
  let lead = 0.035;
  let tail = 0.065;

  if (kinds.includes('filler')) {
    lead = Math.max(lead, 0.075);
    tail = Math.max(tail, 0.115);
  }
  if (kinds.includes('repeat')) {
    lead = Math.max(lead, 0.055);
    tail = Math.max(tail, 0.085);
  }
  if (kinds.includes('llm')) {
    lead = Math.max(lead, 0.045);
    tail = Math.max(tail, 0.075);
  }
  if (!hasSpeechLike && kinds.includes('silence')) {
    return { lead: -0.012, tail: -0.012 };
  }

  const selectedMode = ['conservative', 'standard', 'clean'].includes(mode) ? mode : 'standard';
  const factor = selectedMode === 'clean' ? 1.35 : (selectedMode === 'conservative' ? 0.55 : 1);
  return {
    lead: lead * factor,
    tail: tail * factor,
  };
}

function refineDeleteSegmentsForExport(segments, options = {}) {
  const durationSec = Number(options.durationSec);
  const maxDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Number.POSITIVE_INFINITY;
  const mode = ['conservative', 'standard', 'clean'].includes(options.mode) ? options.mode : 'standard';
  const mergeGapSec = Math.max(0, Number.isFinite(Number(options.mergeGapSec)) ? Number(options.mergeGapSec) : 0.09);
  const minKeepGapSec = Math.max(0, Number.isFinite(Number(options.minKeepGapSec)) ? Number(options.minKeepGapSec) : 0.12);
  const minDeleteSec = Math.max(0.03, Number.isFinite(Number(options.minDeleteSec)) ? Number(options.minDeleteSec) : 0.05);
  const normalized = normalizeCutSegments(segments, maxDuration);

  const beforeDurationSec = normalized.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
  const adjusted = normalized.map((seg) => {
    const sourceKinds = collectCutKinds(seg);
    const policy = getBoundaryPolicy(sourceKinds, mode);
    let start = seg.start - policy.lead;
    let end = seg.end + policy.tail;
    if (policy.lead < 0) start = seg.start - policy.lead;
    if (policy.tail < 0) end = seg.end + policy.tail;
    start = Math.max(0, start);
    end = Math.min(maxDuration, end);
    return {
      ...seg,
      start,
      end,
      sourceKinds,
      kind: sourceKinds.length > 1 ? 'mixed' : (sourceKinds[0] || 'manual'),
      precisionMode: mode,
    };
  }).filter((seg) => seg.end - seg.start >= minDeleteSec);

  const mergedResult = mergeCutSegments(adjusted, Math.max(mergeGapSec, minKeepGapSec));
  const finalSegments = mergedResult.segments;
  const afterDurationSec = finalSegments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);

  return {
    segments: finalSegments,
    stats: {
      inputCount: normalized.length,
      outputCount: finalSegments.length,
      mergedCloseGaps: mergedResult.mergedCloseGaps,
      beforeDurationSec: Number(beforeDurationSec.toFixed(3)),
      afterDurationSec: Number(afterDurationSec.toFixed(3)),
      durationDeltaSec: Number((afterDurationSec - beforeDurationSec).toFixed(3)),
      mode,
    },
  };
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
  refineDeleteSegmentsForExport,
  normalizeBoundarySettings,
};
