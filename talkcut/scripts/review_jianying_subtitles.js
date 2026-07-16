function stripJianyingSubtitlePunctuation(text) {
  return String(text || '')
    .replace(/[，。！？；：、,.!?;:]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCueList(cues = []) {
  return (Array.isArray(cues) ? cues : [])
    .map((cue) => {
      const start = Number(cue?.start);
      const end = Number(cue?.end);
      const rawText = String(cue?.text || '').trim();
      return {
        ...cue,
        start,
        end,
        rawText,
        text: stripJianyingSubtitlePunctuation(rawText),
      };
    })
    .filter((cue) => cue.text && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start)
    .sort((a, b) => (a.start - b.start) || (a.end - b.end));
}

function splitLongSubtitleText(text, maxChars) {
  const chars = Array.from(text);
  const out = [];
  let cursor = 0;
  while (cursor < chars.length) {
    out.push(chars.slice(cursor, cursor + maxChars).join(''));
    cursor += maxChars;
  }
  return out;
}

function splitSubtitleByChineseSentence(rawText, maxChars = 15) {
  const source = String(rawText || '').trim();
  const sentenceParts = source
    .split(/(?<=[，。！？；：、,.!?;:])/u)
    .map((part) => stripJianyingSubtitlePunctuation(part))
    .filter(Boolean);
  const baseParts = sentenceParts.length ? sentenceParts : [stripJianyingSubtitlePunctuation(source)].filter(Boolean);
  const out = [];
  for (const part of baseParts) {
    if (Array.from(part).length <= maxChars) {
      out.push(part);
    } else {
      out.push(...splitLongSubtitleText(part, maxChars));
    }
  }
  return out;
}

function textStyleForJianyingPreset(preset = '') {
  const key = String(preset || '').toLowerCase();
  const base = {
    fontSize: 8,
    color: '#FFFFFF',
    backgroundColor: '',
    borderColor: '#000000',
    borderWidth: 4,
    position: { x: 0, y: -0.78 },
  };
  if (key.includes('black') || key.includes('gold')) {
    return {
      ...base,
      color: '#F7E7B2',
      borderColor: '#15120A',
      borderWidth: 5,
    };
  }
  if (key.includes('clean') || key.includes('simple')) {
    return {
      ...base,
      borderWidth: 3,
    };
  }
  return base;
}

function buildJianyingSubtitleItems(cues = [], textStyle = {}) {
  const normalized = normalizeCueList(cues);
  const items = [];
  let cursor = 0;
  const gap = 0.012;
  for (const cue of normalized) {
    const parts = splitSubtitleByChineseSentence(cue.rawText || cue.text, 15);
    if (!parts.length) continue;
    const totalChars = Math.max(1, parts.reduce((sum, part) => sum + Array.from(part).length, 0));
    const cueDuration = Math.max(0.08, cue.end - cue.start);
    let localStart = cue.start;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const ratio = Array.from(part).length / totalChars;
      const idealDuration = i === parts.length - 1
        ? Math.max(0.08, cue.end - localStart)
        : Math.max(0.18, cueDuration * ratio);
      let start = Math.max(localStart, cursor);
      let end = i === parts.length - 1 ? cue.end : Math.min(cue.end, localStart + idealDuration);
      if (end <= start) end = start + 0.12;
      if (items.length && start < cursor) start = cursor;
      if (items.length && start - cursor < gap) start = cursor + gap;
      if (end <= start) end = start + 0.12;
      items.push({
        type: 'text',
        text: part,
        start: Number(start.toFixed(3)),
        duration: Number(Math.max(0.05, end - start).toFixed(3)),
        style: { ...textStyle },
        ...textStyle,
      });
      cursor = start + Math.max(0.05, end - start);
      localStart = end;
    }
  }
  return items;
}

module.exports = {
  stripJianyingSubtitlePunctuation,
  normalizeCueList,
  splitSubtitleByChineseSentence,
  textStyleForJianyingPreset,
  buildJianyingSubtitleItems,
};
