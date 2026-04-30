function isBadText(text) {
  const value = String(text || '');
  if (!value) return false;
  if (value.includes('\uFFFD')) return true;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) return true;
  if (/(?:\?{3,}|�{1,})/.test(value)) return true;
  return false;
}

function analyzeTranscriptQuality(words, options = {}) {
  const items = Array.isArray(words) ? words : [];
  const warnings = [];
  const badTextItems = [];
  const invalidTimeItems = [];
  const reversedTimeItems = [];
  let speechCount = 0;
  let gapCount = 0;
  let emptySpeechCount = 0;
  let lastEnd = 0;
  let maxEnd = 0;
  let longGapCount = 0;

  items.forEach((item, index) => {
    const text = String(item && item.text != null ? item.text : '');
    const start = Number(item && item.start);
    const end = Number(item && item.end);
    const isGap = !!(item && item.isGap);
    if (isGap) gapCount += 1;
    else speechCount += 1;
    if (!isGap && !text.trim()) emptySpeechCount += 1;
    if (isBadText(text)) badTextItems.push({ index, text, start, end });
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      invalidTimeItems.push({ index, text, start, end });
    } else {
      if (start + 0.003 < lastEnd) reversedTimeItems.push({ index, text, start, previousEnd: lastEnd });
      if (isGap && end - start >= 8) longGapCount += 1;
      lastEnd = Math.max(lastEnd, end);
      maxEnd = Math.max(maxEnd, end);
    }
  });

  if (!items.length) warnings.push('转录结果为空，无法生成审核文本。');
  if (speechCount === 0) warnings.push('没有检测到有效文字，请检查转录服务返回内容。');
  if (badTextItems.length) warnings.push(`检测到 ${badTextItems.length} 个乱码词，建议重转或手动修正。`);
  if (invalidTimeItems.length) warnings.push(`检测到 ${invalidTimeItems.length} 个无效时间戳，可能影响剪辑精度。`);
  if (reversedTimeItems.length) warnings.push(`检测到 ${reversedTimeItems.length} 个时间戳倒序片段，可能导致审核页定位异常。`);
  if (emptySpeechCount) warnings.push(`检测到 ${emptySpeechCount} 个空白文字片段。`);
  if (longGapCount >= 3) warnings.push(`检测到 ${longGapCount} 个超长空白段，建议确认音频提取或转录是否完整。`);

  const maxBadItems = Number.isFinite(Number(options.maxBadItems)) ? Number(options.maxBadItems) : 20;
  return {
    ok: warnings.length === 0,
    warnings,
    stats: {
      total: items.length,
      speechCount,
      gapCount,
      durationSec: Number(maxEnd.toFixed(3)),
      badTextCount: badTextItems.length,
      invalidTimeCount: invalidTimeItems.length,
      reversedTimeCount: reversedTimeItems.length,
      emptySpeechCount,
      longGapCount,
    },
    badTextItems: badTextItems.slice(0, maxBadItems),
    invalidTimeItems: invalidTimeItems.slice(0, maxBadItems),
    reversedTimeItems: reversedTimeItems.slice(0, maxBadItems),
  };
}

module.exports = {
  analyzeTranscriptQuality,
  isBadText,
};
