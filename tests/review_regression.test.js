const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { analyzeTranscriptQuality } = require('../talkcut/scripts/transcript_quality');
const {
  buildReviewDeleteSegments,
  applyCutPrecisionMode,
  diagnoseDeleteSegments,
} = require('../talkcut/scripts/review_segment_utils');
const { parseTermGlossary } = require('../talkcut/scripts/term_glossary');
process.env.JAYGO_CUT_TEST_EXPORTS = '1';
const reviewServerTools = require('../talkcut/scripts/review_server');
const historyUtils = require('../electron/history_utils');

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

function testCutPrecisionModeAdjustsOnlySubmittedSegments() {
  const segments = [
    { start: 1.000, end: 1.400 },
    { start: 2.000, end: 2.080 },
  ];

  assert.deepStrictEqual(
    applyCutPrecisionMode(segments, 'standard', 5),
    segments,
    'standard mode should keep submitted delete boundaries unchanged',
  );

  const clean = applyCutPrecisionMode(segments, 'clean', 5);
  assert.ok(clean[0].start < segments[0].start, 'clean mode should start slightly earlier');
  assert.ok(clean[0].end > segments[0].end, 'clean mode should end slightly later');

  const conservative = applyCutPrecisionMode(segments, 'conservative', 5);
  assert.ok(conservative[0].start > segments[0].start, 'conservative mode should trim the leading edge');
  assert.ok(conservative[0].end < segments[0].end, 'conservative mode should trim the trailing edge');
}

function testDeleteSegmentDiagnosticsFindsRisks() {
  const words = [
    { text: 'A', start: 0.00, end: 0.25, isGap: false },
    { text: 'B', start: 0.25, end: 0.34, isGap: false },
    { text: 'C', start: 0.34, end: 0.60, isGap: false },
    { text: 'D', start: 0.70, end: 9.50, isGap: false },
    { text: 'E', start: 9.53, end: 9.80, isGap: false },
    { text: 'F', start: 9.95, end: 10.10, isGap: false },
  ];
  const diagnostics = diagnoseDeleteSegments([
    { start: 0.25, end: 0.34 },
    { start: 0.38, end: 0.54 },
    { start: 0.70, end: 9.50 },
  ], words);

  assert.strictEqual(diagnostics.count, 3);
  assert.ok(diagnostics.totalDurationSec > 9, 'diagnostics should total delete duration');
  assert.ok(diagnostics.longest.durationSec > 8, 'diagnostics should expose longest segment');
  assert.ok(diagnostics.shortest.durationSec < 0.12, 'diagnostics should expose shortest segment');
  assert.ok(diagnostics.denseCount >= 1, 'diagnostics should count dense consecutive deletes');
  assert.ok(diagnostics.risks.some((risk) => risk.type === 'short'), 'short delete risks should be flagged');
  assert.ok(diagnostics.risks.some((risk) => risk.type === 'long'), 'long delete risks should be flagged');
  assert.ok(diagnostics.risks.some((risk) => risk.type === 'tight'), 'tight-to-kept-word risks should be flagged');
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
  assert.ok(items[0].prompt.length <= 760, '图片生成提示词应保持精简，避免模型抓错重点');
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
    [
      { type: 'video', start: 4, end: 9, title: 'existing b-roll' },
      { type: 'delete', start: 1, end: 2, title: 'deleted speech' },
    ],
  );
  assert.ok(prompt.includes('导演转译'));
  assert.ok(prompt.includes('严禁把 textBasis 或原文句子直接塞进 prompt'));
  assert.ok(prompt.includes('delete|... 是最终视频不会出现的时间段'), 'image plan prompt should explicitly avoid deleted ranges');
  assert.ok(prompt.includes('Existing image/video media ranges'), 'image plan prompt should avoid existing media ranges');
  assert.ok(prompt.includes('video|4.00-9.00|existing b-roll'), 'image plan prompt should include blocked video ranges');
  assert.ok(prompt.includes('delete|1.00-2.00|deleted speech'), 'image plan prompt should include blocked delete ranges');
  assert.strictEqual(reviewServerTools.imageSizeToMiniMaxAspectRatio('2:3'), '2:3');
  assert.strictEqual(reviewServerTools.imageSizeToMiniMaxAspectRatio('16:9'), '16:9');
  assert.strictEqual(reviewServerTools.imageSizeToOpenAiSize('9:16'), '1024x1536');
  assert.strictEqual(reviewServerTools.imageSizeToAgnesSize('9:16'), '768x1024');
  assert.strictEqual(reviewServerTools.imageSizeToAgnesSize('16:9'), '1024x768');
  assert.strictEqual(reviewServerTools.autoImageCountForUnits([{ start: 0, end: 60 }, { start: 60, end: 120 }]), 6);
  assert.strictEqual(reviewServerTools.autoVideoCountForUnits([{ start: 0, end: 60 }]), 1);
  assert.strictEqual(reviewServerTools.autoVideoCountForUnits([{ start: 0, end: 240 }]), 3);
  assert.strictEqual(reviewServerTools.autoVideoCountForUnits([{ start: 0, end: 900 }]), 5);
}

function testVisualPlanUsesOnlyKeptTranscript() {
  const words = [
    { text: '保留开头', start: 0, end: 1, isGap: false },
    { text: '应该删除', start: 1, end: 2, isGap: false },
    { text: '也要保留', start: 2, end: 3, isGap: false },
    { text: '', start: 3, end: 3.4, isGap: true },
  ];
  const kept = reviewServerTools.pickWordsForVisualPlan(words, [2], [{ start: 0.8, end: 2.1 }]);
  assert.deepStrictEqual(kept.map((w) => w.text), ['保留开头'], 'visual planning should ignore selected words and delete ranges');

  const visualReference = reviewServerTools.sanitizeVisualReferencePlan({
    visualReference: {
      character: '一位中国女性创作者，短发，米色衬衫',
      scene: '现代中文城市公寓与街道',
      outfit: '米色衬衫、深色长裤、帆布包',
      prompt: '统一人物场景参考图，主角站在窗边桌前，桌上有笔记本、马克杯和便签，暖色侧光，彩铅画风，无文字。',
    },
  }, { topic: '自媒体口播故事' }, '彩铅画');
  assert.ok(Array.isArray(visualReference.assets), 'visual reference should normalize to asset cards');
  assert.ok(visualReference.assets.length >= 2, 'visual reference should include character and scene assets');
  assert.strictEqual(visualReference.assets[0].type, 'character');
  assert.strictEqual(visualReference.assets[1].type, 'scene');
  assert.strictEqual(visualReference.assets[0].storyId, 'story_01');
  assert.strictEqual(visualReference.assets[1].storyId, 'story_01');
  assert.ok(/white-background|front view/i.test(visualReference.assets[0].prompt), 'character asset should be a reusable white-background reference sheet');
  assert.ok(/no people|environment-only/i.test(visualReference.assets[1].prompt), 'scene asset should avoid people and only describe the environment');
}

function testAgnesVideoPlanningAndOverlayWiring() {
  const prompt = reviewServerTools.buildVideoPlanPrompt(
    [{ id: 'u1', start: 10, end: 15, text: '这里需要一个观点冲突的 B-roll 画面' }],
    { topic: '测试主题', outline: '测试梗概' },
    '电影写实',
    2,
    '16:9',
    [{ type: 'image', start: 12, end: 18, title: 'existing image' }],
  );
  assert.ok(prompt.includes('start/end'), 'video plan prompt should require exact timeline ranges');
  assert.ok(prompt.includes('videoPrompt'), 'video plan prompt should ask for a video generation prompt');
  assert.ok(prompt.includes('禁止直接复制原文句子'), 'video plan prompt should prevent direct transcript copy');

  assert.ok(prompt.includes('Existing image/video media ranges'), 'video plan prompt should avoid existing media ranges');
  assert.ok(prompt.includes('image|12.00-18.00|existing image'), 'video plan prompt should include blocked image ranges');

  const items = reviewServerTools.sanitizeVideoPlanItems({
    items: [{
      id: 'vid_01',
      start: 10,
      end: 15,
      title: '测试视频素材',
      textBasis: '这里需要一个观点冲突的 B-roll 画面',
      prompt: '这里需要一个观点冲突的 B-roll 画面',
    }],
  }, [{ id: 'u1', start: 10, end: 15, text: '这里需要一个观点冲突的 B-roll 画面' }], 1, { topic: '测试主题' }, '电影写实', '16:9');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].type, 'video');
  assert.ok(items[0].videoPrompt.includes('画面故事'), 'video prompt should be transformed into Chinese storyboard language');
  assert.ok(items[0].videoPrompt.includes('镜头构图'), 'video prompt should include camera language');
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
  assert.ok(prompt.includes('0.88'), 'high-risk semantic deletes should require explicit high confidence');
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

function testJianyingFullDraftSpec() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaygo-jianying-full-spec-'));
  try {
    const videoPath = path.join(dir, 'source.mp4');
    const imagePath = path.join(dir, 'image.png');
    const videoAssetPath = path.join(dir, 'broll.mp4');
    fs.writeFileSync(videoPath, 'fake-video');
    fs.writeFileSync(imagePath, 'fake-image');
    fs.writeFileSync(videoAssetPath, 'fake-broll');

    const { spec, stats } = reviewServerTools.buildJianyingFullDraftSpec({
      draftName: 'full_spec_test',
      sourceVideoPath: videoPath,
      sourceDurationSec: 6,
      sourceVideoMeta: { width: 1280, height: 720, fps: 30 },
      deleteSegments: [{ start: 1, end: 2 }],
      cues: [
        { start: 0, end: 1, text: 'first caption' },
        { start: 1, end: 2, text: 'second caption' },
      ],
      mediaAssets: {
        images: [
          { id: 'img_1', start: 0.2, end: 5.2, durationSec: 5, status: 'done', image: { filePath: imagePath } },
        ],
        videos: [
          { id: 'vid_1', start: 2.2, end: 5.2, durationSec: 3, status: 'done', video: { filePath: videoAssetPath } },
        ],
      },
    });

    assert.strictEqual(spec.name, 'full_spec_test');
    assert.strictEqual(spec.width, 1280);
    assert.strictEqual(spec.height, 720);
    assert.strictEqual(stats.keepSegments, 2);
    assert.strictEqual(stats.outputDurationSec, 5);

    const mainTrack = spec.tracks.find((track) => track.name === 'Jaygo Cut 主视频');
    assert.ok(mainTrack, 'full draft should include editable main video track');
    assert.strictEqual(mainTrack.items.length, 2);
    assert.strictEqual(mainTrack.items[0].sourceStart, 0);
    assert.strictEqual(mainTrack.items[1].start, 1);
    assert.strictEqual(mainTrack.items[1].sourceStart, 2);

    const imageTrack = spec.tracks.find((track) => track.name === 'Jaygo Cut 图片素材');
    assert.ok(imageTrack, 'full draft should include image material track');
    assert.strictEqual(imageTrack.items[0].type, 'photo');
    assert.strictEqual(imageTrack.items[0].start, 0.2);
    assert.strictEqual(imageTrack.items[0].duration, 4);

    const videoTrack = spec.tracks.find((track) => track.name === 'Jaygo Cut 视频素材');
    assert.ok(videoTrack, 'full draft should include video material track');
    assert.strictEqual(videoTrack.items[0].start, 1.2);
    assert.strictEqual(videoTrack.items[0].volume, 0);

    const textTrack = spec.tracks.find((track) => track.name === 'Jaygo Cut 字幕');
    assert.ok(textTrack, 'full draft should include subtitle track');
    assert.strictEqual(textTrack.items.length, 2);
    for (let i = 1; i < textTrack.items.length; i += 1) {
      const prevEnd = textTrack.items[i - 1].start + textTrack.items[i - 1].duration;
      assert.ok(textTrack.items[i].start >= prevEnd - 0.001, 'subtitle items should not overlap on one track');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testJianyingSubtitleItemsStayOnSingleTrack() {
  const items = reviewServerTools.buildJianyingSubtitleItems([
    { start: 0, end: 0.04, text: '你' },
    { start: 0.05, end: 0.09, text: '好' },
    { start: 0.11, end: 0.16, text: '吗' },
    { start: 0.22, end: 0.70, text: '下一句' },
  ], { fontSize: 9, color: '#fff' });
  assert.ok(items.length >= 1, 'short subtitle cues should be kept instead of becoming invalid');
  for (let i = 1; i < items.length; i += 1) {
    const prevEnd = items[i - 1].start + items[i - 1].duration;
    assert.ok(items[i].start >= prevEnd - 0.001, 'normalized subtitle cues must not overlap');
  }
  const readable = reviewServerTools.buildJianyingSubtitleItems([
    { start: 0, end: 1.1, text: '第一句话' },
    { start: 1.12, end: 2.1, text: '第二句话' },
    { start: 2.15, end: 3.1, text: '第三句话' },
  ]);
  assert.strictEqual(readable.length, 3, 'normal adjacent subtitle cues should not be over-merged');
}

function testOriginalProofreadUsesMatchedCandidatesOnly() {
  const units = [
    { id: 1, text: '这个问题最近在网上爆火', startIndex: 0, endIndex: 9 },
    { id: 2, text: '我们今天聊一聊规则', startIndex: 10, endIndex: 19 },
    { id: 3, text: '她的选择很重要', startIndex: 20, endIndex: 27 },
  ];
  const candidates = reviewServerTools.buildProofreadCandidates(units, '这个问题最近在网上爆火。');
  assert.ok(candidates.length >= 1, 'proofread should find a sentence-level candidate before asking AI');
  assert.strictEqual(candidates[0].startIndex, 0);
  assert.ok(candidates.every((candidate) => candidate.original.includes('这个问题')), 'one pasted sentence should not expose unrelated transcript units');

  const words = '这个问题最近在网上爆火我们今天聊一聊规则她的选择很重要'
    .split('')
    .map((text) => ({ text }));
  const unsafe = reviewServerTools.sanitizeProofreadCorrections({
    corrections: [{ candidateId: candidates[0].id, startIndex: 20, endIndex: 20, from: '她', to: '他', reason: 'outside candidate' }],
  }, candidates, words);
  assert.strictEqual(unsafe.length, 0, 'proofread corrections outside the matched candidate should be rejected');

  const noChange = reviewServerTools.sanitizeProofreadCorrections({
    corrections: [{ candidateId: candidates[0].id, startIndex: 0, endIndex: 1, from: '这个', to: '这个', reason: 'inside candidate' }],
  }, candidates, words);
  assert.strictEqual(noChange.length, 0, 'proofread should reject no-op replacements even inside matched candidates');

  const unsafeLength = reviewServerTools.sanitizeProofreadCorrections({
    corrections: [{ candidateId: candidates[0].id, startIndex: 0, endIndex: 1, from: '这个', to: '这个问题', reason: 'too broad' }],
  }, candidates, words);
  assert.strictEqual(unsafeLength.length, 0, 'proofread should reject word-to-sentence replacements');
}

function testOriginalProofreadDeterministicCorrections() {
  const words = '规则不是用来束缚王超燃说王朝然到了'
    .split('')
    .map((text, index) => ({ text, start: index * 0.1, end: index * 0.1 + 0.08, isGap: false }));
  const units = [
    { id: 1, text: '规则不是用来束缚', startIndex: 0, endIndex: 7 },
  ];
  const candidates = reviewServerTools.buildProofreadCandidates(units, '规则不是用来舒服。王超然');
  const diffCorrections = reviewServerTools.sanitizeProofreadCorrections(
    { corrections: reviewServerTools.buildSentenceDiffProofreadCorrections(candidates, words) },
    candidates,
    words,
  );
  assert.ok(
    diffCorrections.some((item) => item.from === '束缚' && item.to === '舒服'),
    'sentence diff proofread should correct close homophone phrase inside the matched sentence',
  );

  const nameCorrections = reviewServerTools.buildProperNameProofreadCorrections(words, '王超然');
  assert.ok(
    nameCorrections.some((item) => item.from === '王超燃' && item.to === '王超然'),
    'proper-name proofread should correct near homophone variants such as 王超燃',
  );
  assert.ok(
    nameCorrections.some((item) => item.from === '王朝然' && item.to === '王超然'),
    'proper-name proofread should correct same-surname variants such as 王朝然',
  );
}

function testJianyingDraftMediaPathFallbacks() {
  const repoRoot = path.join(__dirname, '..');
  const imageAssetDir = path.join(repoRoot, 'image_assets');
  const videoAssetDir = path.join(repoRoot, 'video_assets');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaygo-jianying-media-fallback-'));
  const stamp = `${Date.now()}_${process.pid}`;
  const imageName = `test_image_${stamp}.png`;
  const videoName = `test_video_${stamp}.mp4`;
  const imageAssetPath = path.join(imageAssetDir, imageName);
  const videoAssetPath = path.join(videoAssetDir, videoName);
  try {
    fs.mkdirSync(imageAssetDir, { recursive: true });
    fs.mkdirSync(videoAssetDir, { recursive: true });
    fs.writeFileSync(imageAssetPath, 'fake-image');
    fs.writeFileSync(videoAssetPath, 'fake-video-asset');
    const sourceVideoPath = path.join(dir, 'source.mp4');
    fs.writeFileSync(sourceVideoPath, 'fake-source');

    assert.strictEqual(
      reviewServerTools.resolveMediaFilePathFromAsset({ fileName: imageName, url: `/image_assets/${encodeURIComponent(imageName)}` }),
      imageAssetPath,
      'image asset fileName/url should resolve to local image_assets path',
    );
    assert.strictEqual(
      reviewServerTools.resolveMediaFilePathFromAsset({ fileName: videoName, url: `/video_assets/${encodeURIComponent(videoName)}` }),
      videoAssetPath,
      'video asset fileName/url should resolve to local video_assets path',
    );
    assert.strictEqual(
      reviewServerTools.resolveMediaFilePathFromAsset({ fileName: '', url: '/image_assets/' }, 'image'),
      '',
      'empty or directory-only image asset URLs should not resolve to the image_assets folder',
    );
    assert.strictEqual(
      reviewServerTools.resolveMediaFilePathFromAsset({ filePath: imageAssetDir }, 'image'),
      '',
      'directory filePath should not be treated as a generated image file',
    );

    const { spec } = reviewServerTools.buildJianyingFullDraftSpec({
      draftName: 'media_fallback_test',
      sourceVideoPath,
      sourceDurationSec: 10,
      sourceVideoMeta: { width: 1920, height: 1080, fps: 30 },
      deleteSegments: [{ start: 4, end: 4.5 }],
      cues: [
        { start: 0, end: 2, text: 'first caption' },
        { start: 2, end: 5, text: 'second caption' },
      ],
      mediaAssets: {
        images: [
          { id: 'img_file_name', start: 0.5, end: 6.5, durationSec: 6, status: 'done', image: { fileName: imageName, url: `/image_assets/${encodeURIComponent(imageName)}` } },
          { id: 'img_failed_old_state', start: 6.6, end: 9.6, durationSec: 3, status: 'error', image: { fileName: '', url: '/image_assets/' } },
        ],
        videos: [
          { id: 'vid_file_name', start: 5.2, end: 8.2, durationSec: 3, status: 'done', video: { fileName: videoName, url: `/video_assets/${encodeURIComponent(videoName)}` } },
          { id: 'vid_failed_old_state', start: 8.3, end: 9.3, durationSec: 1, status: 'error', video: { fileName: '', url: '/video_assets/' } },
        ],
      },
    });
    const imageTrack = spec.tracks.find((track) => track.name === 'Jaygo Cut 图片素材');
    const videoTrack = spec.tracks.find((track) => track.name === 'Jaygo Cut 视频素材');
    assert.strictEqual(imageTrack.items.length, 1, 'failed historical image assets without files should be skipped');
    assert.strictEqual(videoTrack.items.length, 1, 'failed historical video assets without files should be skipped');
    assert.strictEqual(imageTrack.items[0].path, imageAssetPath);
    assert.strictEqual(videoTrack.items[0].path, videoAssetPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(imageAssetPath, { force: true });
    fs.rmSync(videoAssetPath, { force: true });
  }
}

function testJianyingDraftPathReferencesAreRewritten() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaygo-jianying-path-rewrite-'));
  try {
    const staging = path.join(dir, '_staging', 'JaygoCut_tmp');
    const finalDraft = path.join(dir, 'JaygoCut_final');
    fs.mkdirSync(staging, { recursive: true });
    const staleMedia = path.join(staging, 'assets', 'video', 'source.mp4');
    const finalMedia = path.join(finalDraft, 'assets', 'video', 'source.mp4');
    fs.writeFileSync(path.join(staging, 'draft_info.json'), JSON.stringify({
      materials: [
        { path: staleMedia },
        { path: staleMedia.replace(/\\/g, '/') },
      ],
    }), 'utf8');
    const changed = reviewServerTools.rewriteDraftPathReferences(staging, staging, finalDraft);
    const content = fs.readFileSync(path.join(staging, 'draft_info.json'), 'utf8');
    assert.ok(changed >= 1, 'path rewrite should update at least one draft metadata file');
    assert.ok(!content.includes('_staging'), 'draft metadata must not keep stale staging paths');
    assert.ok(content.includes(finalMedia) || content.includes(finalMedia.replace(/\\/g, '/')), 'draft metadata should point to the final draft media path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testJianyingDraftRootExportTarget() {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaygo-jianying-root-export-'));
  const draftRoot = path.join(dir, 'com.lveditor.draft');
  fs.mkdirSync(draftRoot, { recursive: true });
  fs.writeFileSync(path.join(draftRoot, 'root_meta_info.json'), JSON.stringify({ all_draft_store: [] }), 'utf8');
  process.chdir(dir);
  try {
    const videoPath = path.join(dir, 'source.mp4');
    fs.writeFileSync(videoPath, 'fake-video');
    const result = reviewServerTools.writeJianyingFullDraft({
      draftName: 'root_export_test',
      exportMode: 'custom',
      targetRoot: draftRoot,
      sourceVideoPath: videoPath,
      sourceDurationSec: 3,
      sourceVideoMeta: { width: 1280, height: 720, fps: 30 },
      deleteSegments: [{ start: 1, end: 1.2 }],
      cues: [
        { start: 0, end: 1, text: 'first caption' },
        { start: 1.2, end: 2, text: 'second caption' },
      ],
    });
    assert.strictEqual(result.autoPlaced, true);
    assert.strictEqual(result.exportRootSource, 'custom');
    assert.ok(result.draftDir.startsWith(draftRoot), 'draft should be written inside selected Jianying root');
    assert.ok(fs.existsSync(path.join(result.draftDir, 'draft_content.json')), 'full draft should write draft_content.json');
    assert.ok(fs.existsSync(path.join(draftRoot, 'root_meta_info.json')), 'draft root index should remain present');
    const foundDrafts = reviewServerTools.listJianyingDrafts(draftRoot);
    assert.ok(foundDrafts.some((draft) => draft.path === result.draftDir), 'exported draft should be discoverable from draft root');
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
  ], { cwd: dir, encoding: 'utf8', env: { ...process.env, TERM_GLOSSARY: '杰哥 => Jaygo' } });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(path.join(dir, 'review.html'), 'utf8');
  assert.ok(html.includes('id="btnShortcutHelp"'), 'review page should expose a shortcut guide button');
  assert.ok(!html.includes('id="btnPreviewDelete"'), 'review page should remove the low-value delete preview button');
  assert.ok(!html.includes('<kbd>S</kbd>'), 'shortcut guide should not mention removed delete preview shortcut');
  assert.ok(html.includes('id="btnToggleVideoPreview"'), 'review page should expose video preview toggle');
  assert.ok(html.includes('always-on-toggles'), 'video preview and focus review should stay visible as compact primary toggles');
  assert.ok(html.includes('aria-pressed'), 'compact primary toggles should expose pressed state');
  assert.ok(html.includes('id="waveZoomPopover"'), 'wave zoom should live in a compact popover instead of a permanent toolbar row');
  assert.ok(html.includes('.wave-wrap'), 'review page should include a waveform container');
  assert.ok(html.includes('overflow: visible'), 'wave zoom popover should not be clipped by the waveform container');
  assert.ok(html.includes('id="btnToggleLogPanel"'), 'cut logs should be opened from a right-side floating toggle');
  assert.ok(html.includes('class="side-panel floating-side right log-side"'), 'cut logs should live in a floating side panel instead of taking text review space');
  assert.ok(!html.includes('class="card logs-card"'), 'cut logs should not consume vertical space below the review text');
  assert.ok(html.includes('id="reviewToolFold"'), 'review page should group low-frequency tools in a compact fold panel');
  assert.ok(html.includes('class="toolbar-status-grid"'), 'review page should show compact status chips below primary actions');
  assert.ok(html.includes('id="statDeletedCount"'), 'review page should expose deleted segment count as a status chip');
  assert.ok(html.includes('max-height: min(235px, 32vh)'), 'expanded review tool panel should not consume too much first-screen space');
  assert.ok(html.includes('scrollbar-gutter: stable'), 'expanded review tool panel should keep an internal stable scrollbar');
  assert.ok(html.includes('.tool-fold button'), 'review tool panel buttons should use compact sizing');
  assert.ok(html.includes('data-tool-tab="marking"'), 'review page should expose tool tabs for grouped controls');
  assert.ok(!html.includes('data-tool-panel="export"'), 'Jianying export should move out of the hidden tools panel');
  assert.ok(html.includes('id="jianyingQuickTarget"'), 'review page should expose a compact Jianying target selector next to export');
  assert.ok(html.includes('id="btnExportJianyingDraft"'), 'review page should expose Jianying export next to the main cut action');
  assert.ok(html.includes('id="btnOriginalProofread"'), 'review page should expose original-script proofreading in text correction tools');
  assert.ok(html.includes('/api/llm-proofread-original'), 'review page should call the original-script proofreading endpoint');
  assert.ok(!html.includes('id="btnExportSrt"'), 'review page should remove redundant SRT export');
  assert.ok(!html.includes('id="btnExportTxt"'), 'review page should remove redundant TXT export');
  assert.ok(html.includes('fullDraft: true'), 'review page should request full Jianying draft export');
  assert.ok(!html.includes('Math.max(cue.end, cue.start + 0.35)'), 'review page should not force subtitle cue overlap before Jianying export');
  assert.ok(html.includes('/api/jianying-draft-targets'), 'review page should auto-detect Jianying draft targets');
  assert.ok(html.includes('exportMode,'), 'review page should send Jianying export mode to the server');
  assert.ok(html.includes('targetRoot,'), 'review page should send selected Jianying draft root to the server');
  assert.ok(html.includes('sourceVideoMeta'), 'review page should send source video dimensions for full draft export');
  assert.ok(html.includes('setToolPanel'), 'review page should switch grouped tool panels without regenerating the page');
  assert.ok(html.includes('id="sourceVideo"'), 'review page should include source video preview element');
  assert.ok(html.includes('id="compositePreviewOverlay"'), 'review page should preview generated media overlays on top of the video preview');
  assert.ok(html.includes('id="btnGenerateVideos"'), 'review page should expose Agnes video material generation');
  assert.ok(html.includes('id="imageMotionEffect"'), 'review page should expose image motion effect selector');
  assert.ok(html.includes('id="btnMediaModeImage"'), 'insert media panel should expose an image tab');
  assert.ok(html.includes('id="btnMediaModeVideo"'), 'insert media panel should expose a video tab');
  assert.ok(html.includes('id="imageMediaPanel"'), 'insert media panel should isolate image controls in their own panel');
  assert.ok(html.includes('id="videoMediaPanel"'), 'insert media panel should isolate video controls in their own panel');
  assert.ok(html.includes('id="useVisualReference"'), 'image/video material generation should expose a visual reference toggle');
  assert.ok(html.includes('id="referenceImageUploadInput"'), 'visual reference should support user-uploaded reference images');
  assert.ok(html.includes('/api/llm-visual-reference'), 'review page should ask LLM to plan a unified character/scene reference');
  assert.ok(html.includes('asset-reference-grid'), 'visual reference assets should render as compact thumbnail cards');
  assert.ok(!html.includes('data-ref-preview'), 'visual reference assets should no longer use click-to-preview buttons');
  assert.ok(html.includes('data-ref-hover'), 'visual reference assets should support hover preview');
  assert.ok(html.includes('asset-hover-preview'), 'visual reference hover preview should render above floating panels');
  assert.ok(html.includes('showAssetHoverPreview'), 'visual reference assets should support hover zoom preview');
  assert.ok(html.includes('data-ref-delete'), 'visual reference assets should expose delete actions');
  assert.ok(!html.includes('openAssetPreview'), 'visual reference click modal should be removed');
  assert.ok(html.includes('deleteVisualReferenceAsset'), 'visual reference assets should support deletion');
  assert.ok(html.includes('groupReferenceAssetsByStory'), 'visual reference assets should be grouped by story');
  assert.ok(html.includes('getReferenceAssetsForItem'), 'image/video generation should match reference assets to each storyboard item');
  assert.ok(html.includes('prepareReferenceAwareMediaItem'), 'image/video generation should simplify prompts when reference assets are present');
  assert.ok(html.includes('referenceImagesFromAssets(referenceAssets)'), 'image/video generation should pass matched reference images instead of every asset');
  assert.ok(html.includes('setJianyingExportBusy'), 'Jianying export button should expose busy state');
  assert.ok(html.includes('fetchJsonWithTimeout'), 'Jianying export should not hang forever while resolving targets');
  assert.ok(html.includes('function buildTimeMapper'), 'Jianying full draft export should remap subtitle time after deletions');
  assert.ok(html.includes('resetInterruptedMediaGenerationState'), 'review page should recover interrupted media generation as retryable cards');
  assert.ok(html.includes('runAiButlerLocalCommand'), 'AI butler should execute common app operations locally');
  assert.ok(html.includes('AI\u7ba1\u5bb6'), 'review page should rename LLM chat to AI butler');
  assert.ok(html.includes('AI\u5206\u6790'), 'review page should rename LLM marking to AI analysis');
  assert.ok(html.includes('media-download-icon'), 'media cards should expose compact corner download icons');
  assert.ok(html.includes('data-image-prompt'), 'image cards should expose direct prompt editing');
  assert.ok(html.includes('data-video-prompt'), 'video cards should expose direct prompt editing');
  assert.ok(html.includes("imageCardListEl.addEventListener('input'"), 'image prompt edits should sync before blur');
  assert.ok(html.includes("videoAssetListEl.addEventListener('input'"), 'video prompt edits should sync before blur');
  assert.ok(html.includes('class="media-control-grid"'), 'insert media panel should use compact two-column control grids');
  assert.ok(html.includes('class="media-field"'), 'insert media controls should keep labels and selects compact');
  assert.ok(html.includes('setMediaMode'), 'insert media tabs should switch image/video panels');
  assert.ok(html.includes('aspectRatioToCss'), 'media previews should sanitize ratio labels before assigning CSS aspect-ratio');
  assert.ok(!html.includes('data-image-motion'), 'image cards should not add crowded per-image motion controls');
  assert.ok(html.includes("motionEffect: type === 'image' ? sanitizeImageMotionEffect(item?.motionEffect || currentImageMotionEffect()) : 'none'"), 'motion effects should apply only to inserted image overlays');
  assert.ok(html.includes('appendMediaDetails'), 'image/video prompts should be rendered through collapsed details blocks');
  assert.ok(html.includes("className = 'media-details'"), 'media prompt details should be collapsed by default');
  assert.ok(html.includes('.video-asset-card'), 'video material cards should have their own layout styling');
  assert.ok(html.includes('width: clamp(440px, 27vw, 540px)'), 'insert media side panel should be wide enough for image and video controls');
  assert.ok(html.includes('.image-side > .panel-header .panel-actions button'), 'insert media header buttons should use compact sizing');
  assert.ok(html.includes('height: clamp(220px, 30vh, 320px)'), 'insert media previews should keep a comfortable visible height');
  assert.ok(html.includes('overflow-y: scroll'), 'insert media side panel should keep a visible scrollbar area');
  assert.ok(html.includes('media-dimension-badge'), 'insert media cards should show actual media dimensions after loading');
  assert.ok(html.includes('media-card-meta-line'), 'insert media cards should show time range and media metadata');
  assert.ok(html.includes('attachMediaDimensionBadge'), 'insert media previews should detect image/video dimensions');
  assert.ok(html.includes('border: 1px solid color-mix(in oklab, var(--accent) 32%, var(--border))'), 'video material section should be visually separated from image cards');
  assert.ok(html.includes('.composite-preview-overlay video'), 'video material preview should explicitly opt out of image motion transforms');
  assert.ok(html.includes('lastVideoPreviewSeekAt'), 'video preview should throttle forced seeks for smoother playback');
  assert.ok(html.includes('VIDEO_PREVIEW_PLAYING_SEEK_TOLERANCE'), 'video preview should avoid frequent hard seeks while playing');
  assert.ok(html.includes('syncVideoPreviewRate'), 'video preview should softly chase audio by tiny playback-rate adjustments');
  assert.ok(html.includes('overflow-y: visible'), 'insert media card lists should rely on the side panel scrollbar instead of nested scrollbars');
  assert.ok(html.includes('scrollbar-width: thin'), 'insert media side panel should use a thinner scrollbar');
  assert.ok(html.includes('id="localImageUploadInput"'), 'review page should allow importing local replacement images');
  assert.ok(html.includes('data-image-upload'), 'image cards should expose local upload replacement actions');
  assert.ok(html.includes('/api/import-image'), 'review page should call local image import API');
  assert.ok(html.includes('id="toggleAutoFiller"'), 'review page should let users toggle filler-word auto marking');
  assert.ok(html.includes('id="fillerWordAllowList"'), 'review page should let users choose which filler words are auto-marked');
  assert.ok(html.includes('id="toggleAutoRepeat"'), 'review page should let users toggle repeated-phrase auto marking');
  assert.ok(html.includes('<option value="auto" selected>'), 'image material quantity should default to automatic matching');
  assert.ok(html.includes('id="videoAssetCount"'), 'video material quantity selector should exist');
  assert.ok(html.includes("count: videoAssetCountEl ? String(videoAssetCountEl.value || 'auto') : 'auto'"), 'video material quantity should support automatic matching');
  assert.ok(html.includes('/api/llm-video-plan'), 'review page should request LLM video material plans');
  assert.ok(html.includes('/api/generate-video'), 'review page should call video generation API');
  assert.ok(html.includes('buildMediaOverlaysForCut'), 'review page should submit generated image/video overlays to cut API');
  assert.ok(html.includes('motionEffect'), 'review page should persist and submit selected image motion effects');
  assert.ok(html.includes('data-image-duration'), 'review page should let users tune each image display duration');
  assert.ok(html.includes('window.confirm'), 'review page should ask before compositing generated media into final cut');
  assert.ok(html.includes('syncCompositePreviewOverlay'), 'review page should keep generated media preview synced with playback');
  assert.ok(html.includes('syncCompositePreviewBounds'), 'composite preview should align to the rendered video bounds');
  assert.ok(html.includes('getRenderedSourceVideoRect'), 'review page should calculate the real video content rect');
  assert.ok(html.includes('applyNonOverlappingSchedule'), 'media plans should be locally adjusted to avoid overlapping ranges');
  assert.ok(html.includes('existingRanges'), 'media plan requests should send existing ranges to the LLM');
  assert.ok(html.includes('mediaAssets'), 'review state should persist generated media assets');
  assert.ok(html.includes('applyMediaActions'), 'LLM chat should be able to apply safe media planning actions');
  assert.ok(html.includes('collectMediaRangesExcept'), 'LLM media adjustments should avoid overlapping existing image/video ranges');
  assert.ok(html.includes("fetch('/api/llm-chat-adjust'"), 'review page should send LLM chat adjustment requests');
  assert.ok(html.includes('mediaActions'), 'review page should consume media actions returned by LLM chat');
  assert.ok(html.includes('/source-video'), 'review page should load source video through a safe route');
  assert.ok(html.includes('syncVideoPreview'), 'review page should keep video preview synced with playback');
  assert.ok(html.includes('toolbar-card.video-preview-visible'), 'video preview should use the compact top-right toolbar layout');
  assert.ok(html.includes("toolbarCardEl.classList.toggle('video-preview-visible'"), 'video preview layout should only reserve space while visible');
  assert.ok(html.includes('silenceVideoPreview'), 'video preview should force visual-only muted playback');
  assert.ok(html.includes("sourceVideoEl.addEventListener('volumechange'"), 'video preview should re-mute if the browser restores volume');
  assert.ok(!html.includes('id="sourceVideo" preload="metadata" src="/source-video" playsinline muted controls'), 'video preview should not expose native controls that can unmute audio');
  assert.ok(html.includes('function smoothSkipTo'), 'review playback should smooth automatic skip transitions');
  assert.ok(html.includes('skipFadeRestoreVolume'), 'interrupted skip fade should restore audio volume');
  assert.ok(html.includes('The source video is a visual preview only'), 'video preview should not drive review audio playback');
  assert.ok(html.includes('media.volume = 0'), 'generated video overlay preview should be muted at volume zero');
  assert.ok(html.includes('smoothSkipTo(target)'), 'selected delete segment playback should not hard-seek abruptly');
  assert.ok(html.includes('id="cutPrecisionMode"'), 'review page should expose cut precision mode selector');
  assert.ok(!html.includes('id="btnShowDeleteDiagnostics"'), 'delete diagnostics should not consume review text space');
  assert.ok(!html.includes('id="btnCopyDiagnostics"'), 'copy diagnostics should move out of the main review UI');
  assert.ok(!html.includes('id="deleteDiagnosticsPanel"'), 'delete diagnostics should not render a large blocking panel');
  assert.ok(html.includes('stripSubtitlePunctuation'), 'Jianying subtitle export should remove punctuation from exported subtitle text');
  assert.ok(html.includes('getSubtitleBreakPunctuation'), 'Jianying subtitle export should split by sentence punctuation, including commas');
  assert.ok(!html.includes('duration >= 3.8'), 'Jianying subtitle export should not split primarily by duration');
  assert.ok(!html.includes('duration >= 2.8'), 'Jianying subtitle export should not use the old over-sensitive split threshold');
  assert.ok(!/AI管家[\s\S]{0,240}\?{3,}/.test(html), 'AI butler status/progress text should not contain garbled question marks');
  assert.ok(html.includes('/api/review-state/backup'), 'review page should force a backup before cut');
  assert.ok(html.includes('/api/cut-preflight'), 'review page should run preflight before cut');
  assert.ok(html.includes('id="replaceFindText"'), 'review page should expose keyword search input');
  assert.ok(html.includes('id="btnReplaceAll"'), 'review page should expose batch keyword replacement');
  assert.ok(html.includes('id="btnApplyGlossary"'), 'review page should expose one-click glossary correction');
  assert.ok(html.includes('"from":"杰哥"'), 'review page should inject parsed term glossary entries');
  assert.ok(html.includes('id="btnFocusReview"'), 'review page should expose focus review mode');
  assert.ok(html.includes('review-focus-mode'), 'review page should include focus mode styles');
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

function testTermGlossaryParsingAndSettingsWiring() {
  const entries = parseTermGlossary([
    '# comment',
    '杰哥 => Jaygo',
    '王超然=王超燃',
    '剪映, 剪影',
    '空行 => ',
    'Jaygo=>Jaygo',
  ].join('\n'));

  assert.deepStrictEqual(entries, [
    { from: '杰哥', to: 'Jaygo' },
    { from: '王超然', to: '王超燃' },
    { from: '剪映', to: '剪影' },
  ]);

  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'electron', 'renderer', 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'electron', 'renderer', 'renderer.js'), 'utf8');
  assert.ok(main.includes('termGlossary'), 'main settings should persist term glossary');
  assert.ok(main.includes('AGNES_VIDEO_MODEL'), 'main settings should provide Agnes video model defaults');
  assert.ok(main.includes('VIDEO_API_BASE_URL'), 'runtime env should pass video generation config');
  assert.ok(main.includes('JAYGO_ENV_FILE'), 'runtime env should pass the live user env file to review servers');
  assert.ok(main.includes('JAYGO_KNOWLEDGE_FILE'), 'runtime env should pass the local editing knowledge file');
  assert.ok(main.includes('JAYGO_USER_STYLE_SUMMARY'), 'runtime env should pass learned editing style summary');
  assert.ok(main.includes('rebuildEditingKnowledge'), 'app startup should rebuild the local editing knowledge base');
  assert.ok(main.includes('REVIEW_TEMPLATE_VERSION'), 'main process should know when old review HTML needs regeneration');
  assert.ok(main.includes('TERM_GLOSSARY'), 'runtime env should pass term glossary to review generation');
  assert.ok(html.includes('id="termGlossary"'), 'settings page should expose term glossary textarea');
  assert.ok(html.includes('id="videoApiBaseUrl"'), 'settings page should expose video API base URL');
  assert.ok(html.includes('id="videoModel"'), 'settings page should expose video generation model');
  assert.ok(renderer.includes('termGlossary'), 'renderer should read and write term glossary setting');
  assert.ok(renderer.includes('videoApiBaseUrl'), 'renderer should read and write video generation settings');
}

function testReviewServerProvidesSafeSourceVideoRoute() {
  const server = fs.readFileSync(path.join(__dirname, '..', 'talkcut', 'scripts', 'review_server.js'), 'utf8');
  assert.ok(server.includes("pathname === '/source-video'"), 'review server should expose source video through a dedicated route');
  assert.ok(server.includes('VIDEO_FILE') && server.includes('serveFile(req, res, VIDEO_FILE'), 'source video route should stream the bound task video only');
  assert.ok(server.includes("pathname.startsWith('/image_assets/')"), 'review server should expose generated image assets safely');
  assert.ok(server.includes("pathname.startsWith('/video_assets/')"), 'review server should expose generated video assets safely');
  assert.ok(server.includes("pathname === '/api/import-image'"), 'review server should support local image replacement uploads');
  assert.ok(server.includes("pathname === '/api/llm-visual-reference'"), 'review server should plan unified visual reference images');
  assert.ok(server.includes("pathname === '/api/llm-video-plan'"), 'review server should expose video material planning endpoint');
  assert.ok(server.includes("pathname === '/api/generate-video'"), 'review server should expose video material generation endpoint');
  assert.ok(server.includes('pickWordsForVisualPlan(words, payload.selectedIndices, payload.deleteSegments)'), 'visual media planning should use kept transcript after deletion ranges');
  assert.ok(server.includes('resolveReferenceImageInputs'), 'Agnes image/video references should support multiple local or remote reference images');
  assert.ok(server.includes('requestBody.extra_body.image'), 'Agnes image reference should be sent through extra_body.image');
  assert.ok(server.includes('resolvePublicReferenceImageInput'), 'Agnes video references should only use public URL images');
  assert.ok(server.includes('retrying text-to-video without image reference'), 'Agnes video generation should fall back when a reference image is rejected');
  assert.ok(server.includes('resolveMediaFilePathFromAsset'), 'Jianying export should resolve generated media assets back to local files');
  assert.ok(server.includes('buildAgnesVideoQueryEndpoint'), 'review server should use Agnes video_id polling endpoint');
  assert.ok(server.includes('buildAgnesVideoStatusEndpoint'), 'review server should also support the documented /v1/videos/{id} polling endpoint');
  assert.ok(server.includes('remixed_from_video_id'), 'review server should detect Agnes completed video URL fields');
  assert.ok(server.includes('envValue(fileEnv'), 'review server should prefer the live env file over stale process env values');
  assert.ok(server.includes('AGNES_MIN_REQUEST_INTERVAL_MS'), 'review server should throttle Agnes image requests under the RPM limit');
  assert.ok(server.includes('AGNES_VIDEO_MIN_REQUEST_INTERVAL_MS = 60000'), 'Agnes video requests should respect the current 1 RPM limit');
  assert.ok(server.includes("waitAgnesRequestSlot('image')"), 'Agnes image requests should share the RPM throttle');
  assert.ok(server.includes('waitAgnesVideoRequestSlot'), 'Agnes video requests should use an independent slow throttle');
  assert.ok(server.includes('autoVideoCountForUnits'), 'video material planning should support automatic count matching');
  assert.ok(server.includes('rawStatus === \'generating\' && !hasGeneratedAsset'), 'review state should recover interrupted media generation as retryable cards');
  assert.ok(server.includes('injectReviewHtmlCompatibility'), 'review server should patch old review pages with compatibility helpers');
  assert.ok(server.includes('jaygo-compat-review-export-helpers'), 'old review pages should receive Jianying export helper compatibility patches');
  assert.ok(server.includes('window.appendSubtitleToken'), 'old review pages should receive subtitle join compatibility patches');
  assert.ok(server.includes('window.shouldBreakSubtitleCue'), 'old review pages should receive subtitle split compatibility patches');
  assert.ok(server.includes('duration >= 3.8'), 'old review page compatibility patch should use readable short-sentence subtitle splitting');
  assert.ok(server.includes("body.includes('duration >= 2.8')"), 'old review pages with stale subtitle splitting should be patched');
  assert.ok(server.includes('btnShowDeleteDiagnostics'), 'old review pages should remove the large delete diagnostics entry through compatibility patching');
  assert.ok(server.includes('_staging'), 'full Jianying draft export should compile outside the live draft root first');
  assert.ok(server.includes('.jaygo_tmp_'), 'full Jianying draft export should atomically place completed drafts to avoid duplicate partial drafts');
  assert.ok(server.includes('buildProofreadCandidates'), 'original-script proofreading should be constrained to matched sentence candidates');
  assert.ok(server.includes('videoDurationToGenerationParams'), 'review server should map planned video durations to stable Agnes frame counts');
  assert.ok(server.includes("mode: 'ti2vid'"), 'Agnes video requests should explicitly use the Agnes text-to-video mode');
  assert.ok(server.includes('formatMediaItemsForChat'), 'LLM chat prompt should include existing media cards');
  assert.ok(server.includes('sanitizeMediaActions'), 'LLM chat media actions should be sanitized server-side');
  assert.ok(server.includes('normalizeMediaActionType'), 'LLM chat should accept common media action aliases');
  assert.ok(server.includes('kind#index'), 'LLM chat should expose media ordinals for requests like second image');
  assert.ok(server.includes('media_actions'), 'LLM chat should support image/video media action plans');
  assert.ok(server.includes('mediaAssets = {}'), 'LLM chat should accept current media state without breaking old review pages');
  assert.ok(server.includes('allowedMotionEffects'), 'review server should sanitize media overlay motion effects');
  assert.ok(server.includes('buildConciseChineseScenePrompt'), 'image/video prompts should be compressed into short Chinese storyboard prompts');
  assert.ok(server.includes('原文“哪怕她摔了一跤”'), 'media planning prompts should teach concrete director translation examples');
  assert.ok(server.includes("rawStatus && !['done', 'ready', 'imported'].includes(rawStatus)"), 'Jianying export should skip failed or unfinished generated media');
  assert.ok(server.includes('from 和 to 必须字数相同'), 'original proofreading should enforce equal-length keyword replacements');
  const cutVideo = fs.readFileSync(path.join(__dirname, '..', 'talkcut', 'scripts', 'cut_video.js'), 'utf8');
  assert.ok(cutVideo.includes('loadMediaOverlays'), 'cut script should read media overlay plans');
  assert.ok(cutVideo.includes('runFfmpegOverlay'), 'cut script should apply generated media overlays');
  assert.ok(cutVideo.includes('buildOverlayVisualFilter'), 'cut script should apply image motion effects during overlay');
  assert.ok(cutVideo.includes('zoom-in'), 'cut script should support zoom-in image motion');
  assert.ok(cutVideo.includes('detectSourceFrameRate'), 'cut script should preserve the source frame rate by default');
  assert.ok(cutVideo.includes('snapSegmentsToFrameGrid'), 'cut script should snap splice points to the output frame grid');
  assert.ok(cutVideo.includes('fps=${outputFpsFilter}'), 'cut script should render final output at the detected/export frame rate');
  assert.ok(cutVideo.includes('formatFpsForFilter(frameRate)'), 'image overlay motion should follow the current output frame rate');
}

function testTextFilesStayUtf8Readable() {
  const files = [
    'CHANGELOG.md',
    'HANDOFF_JaygoCut.md',
    'release-notes.json',
    'electron/renderer/index.html',
    'talkcut/scripts/generate_review.js',
  ];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.ok(!text.includes('\uFFFD'), `${rel} should not contain replacement characters`);
    assert.ok(!/[鏇鐨涓绔搴]/.test(text), `${rel} should not contain common mojibake characters`);
  }
  const releaseNotes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'release-notes.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.ok(releaseNotes.notes.includes('剪映草稿'), 'release notes should stay readable Chinese UTF-8');
}

function testReviewStateBackupWriter() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaygo-review-backup-'));
  try {
    const result = reviewServerTools.writeReviewStateBackup({
      version: 4,
      selectedIndices: [3, 1, 1],
      threshold: 0.2,
      currentTimeSec: 8.5,
      cutPrecisionMode: 'clean',
      textOverrides: { 3: 'fixed-name' },
      llmPunctuation: { 3: '。' },
      llmParagraphAfterIndices: [3],
      boundarySettings: { speechLeadMs: 55, speechTailMs: 95, fillerBoostMs: 25, silenceGuardMs: 35 },
    }, path.join(dir, 'review-state.backup.json'));
    assert.strictEqual(result.selectedIndices.join(','), '1,3');
    assert.strictEqual(result.cutPrecisionMode, 'clean');
    assert.strictEqual(result.textOverrides['3'], 'fixed-name');
    assert.strictEqual(result.llmPunctuation['3'], '。');
    assert.deepStrictEqual(result.llmParagraphAfterIndices, [3]);
    assert.strictEqual(result.boundarySettings.speechLeadMs, 55);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'review-state.backup.json'), 'utf8'));
    assert.deepStrictEqual(saved.selectedIndices, [1, 3]);
    assert.strictEqual(saved.cutPrecisionMode, 'clean');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testHistoryReviewCanOpenWhenOriginalVideoIsMissing() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaygo-history-review-'));
  try {
    const reviewDir = path.join(dir, 'talkcut', '3_review');
    fs.mkdirSync(reviewDir, { recursive: true });
    const missingVideo = path.join(dir, 'missing.mp4');
    const plan = historyUtils.buildHistoryReviewResumePlan({
      reviewDir,
      projectDir: dir,
      videoPath: missingVideo,
      outputRoot: path.join(dir, 'output'),
    });

    assert.strictEqual(plan.reviewDir, reviewDir);
    assert.strictEqual(plan.videoPath, missingVideo);
    assert.strictEqual(plan.videoExists, false);
    assert.strictEqual(plan.canCut, false);
    assert.ok(plan.warning.includes('原视频文件不存在'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testHistoryEntryHealthAndRelinkVideo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaygo-history-health-'));
  try {
    const reviewDir = path.join(dir, 'talkcut', '3_review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'review.html'), '<!doctype html>', 'utf8');
    const originalVideo = path.join(dir, 'missing.mp4');
    const newVideo = path.join(dir, 'new.mp4');
    fs.writeFileSync(newVideo, '');
    const entry = {
      id: 'h1',
      finishedAt: '2026-05-04T00:00:00.000Z',
      reviewDir,
      projectDir: dir,
      videoPath: originalVideo,
    };

    const health = historyUtils.annotateHistoryEntry(entry);
    assert.strictEqual(health.health.status, 'missing_video');
    assert.strictEqual(health.health.canOpenReview, true);
    assert.strictEqual(health.health.canCut, false);

    const relinked = historyUtils.relinkHistoryVideo([entry], entry, newVideo);
    assert.strictEqual(relinked[0].videoPath, newVideo);
    assert.strictEqual(historyUtils.annotateHistoryEntry(relinked[0]).health.status, 'ready');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
testVisualPlanUsesOnlyKeptTranscript();
testAgnesVideoPlanningAndOverlayWiring();
testLlmMarkingPromptIsConservative();
testJianyingDraftExport();
testJianyingFullDraftSpec();
testJianyingSubtitleItemsStayOnSingleTrack();
testOriginalProofreadUsesMatchedCandidatesOnly();
testOriginalProofreadDeterministicCorrections();
testJianyingDraftMediaPathFallbacks();
testJianyingDraftPathReferencesAreRewritten();
testJianyingDraftRootExportTarget();
testCutPrecisionModeAdjustsOnlySubmittedSegments();
testDeleteSegmentDiagnosticsFindsRisks();
testGeneratedReviewInlineScriptSyntax();
testReviewStateBackupWriter();
testHistoryReviewCanOpenWhenOriginalVideoIsMissing();
testHistoryEntryHealthAndRelinkVideo();
testMainSettingsDoNotExposeImageSize();
testTermGlossaryParsingAndSettingsWiring();
testReviewServerProvidesSafeSourceVideoRoute();
testTextFilesStayUtf8Readable();
console.log('review regression tests passed');
