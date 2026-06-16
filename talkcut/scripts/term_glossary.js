function normalizeTerm(value, maxLength = 80) {
  return String(value || '')
    .replace(/\uFEFF/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function splitGlossaryLine(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('//')) return null;

  const separators = ['=>', '->', '＝', '=', '，', ','];
  for (const sep of separators) {
    const idx = raw.indexOf(sep);
    if (idx <= 0) continue;
    return [raw.slice(0, idx), raw.slice(idx + sep.length)];
  }
  return null;
}

function parseTermGlossary(input) {
  const lines = Array.isArray(input) ? input : String(input || '').split(/\r?\n/);
  const seen = new Set();
  const entries = [];
  for (const line of lines) {
    const pair = splitGlossaryLine(line);
    if (!pair) continue;
    const from = normalizeTerm(pair[0]);
    const to = normalizeTerm(pair[1]);
    if (!from || !to || from === to) continue;
    const key = `${from}\n${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ from, to });
  }
  return entries.slice(0, 200);
}

module.exports = {
  parseTermGlossary,
};
