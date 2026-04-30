const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { analyzeTranscriptQuality } = require('../talkcut/scripts/transcript_quality');
const { buildReviewDeleteSegments } = require('../talkcut/scripts/review_segment_utils');

function runAutoSelectFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaygo-auto-select-'));
  const input = path.join(dir, 'words.json');
  const output = path.join(dir, 'selected.json');
  fs.writeFileSync(input, JSON.stringify([
    { text: 'A', start: 0, end: 1, isGap: false },
    { text: '', start: 1, end: 1.2, isGap: true },
    { text: 'B', start: 1.2, end: 2, isGap: false },
    { text: '', start: 2, end: 2.2, isGap: true },
  ]), 'utf8');

  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'talkcut', 'scripts', 'auto_select_silence.js'),
    input,
    output,
    '0.2',
  ], { encoding: 'utf8' });

  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  const selected = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepStrictEqual(selected.indices, [1, 3], '静音阈值应包含等于 0.2 秒的空白段');
}

function testTranscriptQuality() {
  const quality = analyzeTranscriptQuality([
    { text: '好', start: 0, end: 0.2, isGap: false },
    { text: '���', start: 0.2, end: 0.3, isGap: false },
    { text: '', start: 0.3, end: 9, isGap: true },
    { text: '坏', start: 0.1, end: 0.4, isGap: false },
  ]);

  assert.strictEqual(quality.ok, false);
  assert.strictEqual(quality.stats.badTextCount, 1);
  assert.ok(quality.stats.reversedTimeCount >= 1);
  assert.ok(quality.warnings.some((w) => w.includes('乱码词')));
}

function testReviewBoundarySettings() {
  const words = [
    { text: '心', start: 0.00, end: 0.20, isGap: false },
    { text: '目', start: 0.20, end: 0.40, isGap: false },
    { text: '之', start: 0.40, end: 0.60, isGap: false },
    { text: '中', start: 0.60, end: 0.78, isGap: false },
    { text: '他', start: 0.82, end: 0.94, isGap: false },
    { text: '是', start: 0.94, end: 1.08, isGap: false },
    { text: '带', start: 1.08, end: 1.24, isGap: false },
    { text: '有', start: 1.24, end: 1.40, isGap: false },
    { text: '一定', start: 1.40, end: 1.72, isGap: false },
    { text: '的', start: 1.72, end: 1.86, isGap: false },
    { text: '这种', start: 1.86, end: 2.18, isGap: false },
    { text: '用', start: 2.22, end: 2.38, isGap: false },
  ];
  const selected = [4, 5, 6, 7, 8, 9, 10];
  const segs = buildReviewDeleteSegments(words, selected, {
    boundarySettings: {
      speechLeadMs: 60,
      speechTailMs: 110,
      fillerBoostMs: 20,
      silenceGuardMs: 45,
    },
  });

  assert.strictEqual(segs.length, 1);
  assert.ok(segs[0].start < 0.82, '删除第一个字前应有少量提前，避免字头残留');
  assert.ok(segs[0].start > 0.72, '提前量不能吞掉前一个保留词太多');
  assert.ok(segs[0].end <= 2.215, '尾部延后不能压进下一个保留词');
}

runAutoSelectFixture();
testTranscriptQuality();
testReviewBoundarySettings();
console.log('review regression tests passed');
