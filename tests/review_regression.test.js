const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { analyzeTranscriptQuality } = require('../talkcut/scripts/transcript_quality');
const { buildReviewDeleteSegments } = require('../talkcut/scripts/review_segment_utils');
process.env.JAYGO_CUT_TEST_EXPORTS = '1';
const reviewServerTools = require('../talkcut/scripts/review_server');

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

function testImageDirectorPromptSanitizer() {
  const units = [
    { id: 'u1', start: 0, end: 6, text: '我今天发现很多人做自媒体最大的问题是只会讲道理，但是没有画面感' },
    { id: 'u2', start: 6, end: 12, text: '如果你想让观众记住，就必须把观点变成一个真实的场景' },
  ];
  const parsed = {
    style: '动漫',
    visualBible: {
      culturalContext: '中国',
      mainCharacter: '年轻创作者，短发，米色外套',
      outfit: '米色外套和黑色背包',
      sceneWorld: '现代中文城市和小型工作室',
      colorAndStyle: '动漫，清晰线稿',
    },
    items: [
      {
        id: 'img_01',
        start: 0,
        end: 6,
        title: '观点开场',
        purpose: '观点说明',
        textBasis: units[0].text,
        prompt: units[0].text,
        visual: units[0].text,
      },
    ],
  };
  const items = reviewServerTools.sanitizeImagePlanItems(parsed, units, 4, { topic: '自媒体表达' }, '动漫');
  assert.ok(items.length >= 1);
  assert.ok(items[0].prompt.includes('用户选择画风：动漫'), '提示词必须显式锁定用户选择风格');
  assert.ok(items[0].prompt.includes('画面故事'), '提示词必须包含导演化画面故事');
  assert.ok(items[0].prompt.includes('镜头构图'), '提示词必须包含镜头构图');
  assert.strictEqual(
    reviewServerTools.hasDirectTranscriptCopy(items[0].prompt, units[0].text),
    false,
    '直接复述原文的提示词应被重写',
  );
  assert.ok(reviewServerTools.hasDirectorVisualLanguage(items[0].prompt), '重写后的提示词应具备场景/动作/镜头语言');
}

function testImagePlanPromptRulesAndAspectRatio() {
  const prompt = reviewServerTools.buildImagePlanPrompt(
    [{ id: 'u1', start: 0, end: 3, text: '这里是一句测试口播' }],
    { topic: '测试主题', outline: '测试梗概' },
    '水彩画',
    6,
  );
  assert.ok(prompt.includes('导演转译'));
  assert.ok(prompt.includes('严禁把 textBasis 或原文句子直接塞进 prompt'));
  assert.strictEqual(reviewServerTools.imageSizeToMiniMaxAspectRatio('2:3'), '2:3');
  assert.strictEqual(reviewServerTools.imageSizeToMiniMaxAspectRatio('16:9'), '16:9');
  assert.strictEqual(reviewServerTools.imageSizeToOpenAiSize('9:16'), '1024x1536');
}

function testLlmMarkingPromptIsConservative() {
  const prompt = reviewServerTools.buildLlmPrompt([
    { id: 1, start: 0, end: 1, text: '这个我觉得核心观点是不要误删内容' },
    { id: 2, start: 1, end: 2, text: '嗯嗯就是就是' },
  ], { topic: '剪辑测试', outline: '测试口播删除策略' });
  assert.ok(prompt.includes('宁可少删，也不要误删'));
  assert.ok(prompt.includes('不删除事实、数字'));
  assert.ok(prompt.includes('不要“见词就删”'));
  assert.ok(prompt.includes('mark_delete 不要超过本批文本单元的 12%'));
}

function testJianyingDraftExport() {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaygo-jianying-draft-'));
  process.chdir(dir);
  try {
    const result = reviewServerTools.writeJianyingDraft({
      draftName: 'test_draft',
      preset: 'blackgold',
      cues: [
        { start: 0, end: 1.2, text: '第一条字幕' },
        { start: 1.5, end: 3.0, text: '第二条字幕' },
      ],
    });
    assert.strictEqual(result.cues, 2);
    const contentPath = path.join(result.draftDir, 'draft_content.json');
    const metaPath = path.join(result.draftDir, 'draft_meta_info.json');
    assert.ok(fs.existsSync(contentPath), 'should write draft_content.json');
    assert.ok(fs.existsSync(metaPath), 'should write draft_meta_info.json');
    const content = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
    assert.strictEqual(content.materials.texts.length, 2);
    const textTrack = content.tracks.find((track) => track.type === 'text');
    assert.ok(textTrack);
    assert.strictEqual(textTrack.segments.length, 2);
    assert.strictEqual(textTrack.segments[0].target_timerange.start, 0);
    assert.ok(textTrack.segments[1].target_timerange.start > textTrack.segments[0].target_timerange.start);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testGeneratedReviewInlineScriptSyntax() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaygo-review-html-'));
  const wordsPath = path.join(dir, 'subtitles_words.json');
  const selectedPath = path.join(dir, 'auto_selected.json');
  const audioPath = path.join(dir, 'audio.wav');
  fs.writeFileSync(wordsPath, JSON.stringify([
    { text: '测', start: 0, end: 0.2, isGap: false },
    { text: '试', start: 0.2, end: 0.4, isGap: false },
    { text: '', start: 0.4, end: 0.7, isGap: true },
  ]), 'utf8');
  fs.writeFileSync(selectedPath, JSON.stringify({ indices: [2] }), 'utf8');
  fs.writeFileSync(audioPath, '');

  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'talkcut', 'scripts', 'generate_review.js'),
    wordsPath,
    selectedPath,
    audioPath,
  ], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(path.join(dir, 'review.html'), 'utf8');
  assert.ok(html.includes('id="btnShortcutHelp"'), 'review page should expose a shortcut guide button');
  assert.ok(html.includes('id="replaceFindText"'), 'review page should expose keyword search input');
  assert.ok(html.includes('id="btnReplaceAll"'), 'review page should expose batch keyword replacement');
  assert.ok(html.includes('textOverrides'), 'review state should persist transcript text corrections');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1, 'review.html should contain inline script');
  scripts.forEach((script, index) => {
    const scriptPath = path.join(dir, `inline_${index}.js`);
    fs.writeFileSync(scriptPath, script, 'utf8');
    const check = spawnSync(process.execPath, ['--check', scriptPath], { encoding: 'utf8' });
    assert.strictEqual(check.status, 0, check.stderr || check.stdout);
  });
}

function testMainSettingsDoNotExposeImageSize() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'electron', 'renderer', 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'electron', 'renderer', 'renderer.js'), 'utf8');
  assert.ok(!html.includes('id="imageSize"'), 'main settings should not expose image ratio because review page owns it');
  assert.ok(!renderer.includes('imageSize:'), 'main renderer should not read image ratio from removed settings control');
}

runAutoSelectFixture();
testTranscriptQuality();
testReviewBoundarySettings();
testImageDirectorPromptSanitizer();
testImagePlanPromptRulesAndAspectRatio();
testLlmMarkingPromptIsConservative();
testJianyingDraftExport();
testGeneratedReviewInlineScriptSyntax();
testMainSettingsDoNotExposeImageSize();
console.log('review regression tests passed');
