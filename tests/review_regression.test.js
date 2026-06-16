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

function testAgnesVideoPlanningAndOverlayWiring() {
  const prompt = reviewServerTools.buildVideoPlanPrompt(
    [{ id: 'u1', start: 10, end: 15, text: '这里需要一个观点冲突的 B-roll 画面' }],
    { topic: '测试主题', outline: '测试梗概' },
    '电影写实',
    2,
    '16:9',
  );
  assert.ok(prompt.includes('start/end'), 'video plan prompt should require exact timeline ranges');
  assert.ok(prompt.includes('videoPrompt'), 'video plan prompt should ask for a video generation prompt');
  assert.ok(prompt.includes('禁止直接复制原文句子'), 'video plan prompt should prevent direct transcript copy');

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
  assert.ok(items[0].videoPrompt.includes('Scene story'), 'video prompt should be transformed into visual scene language');
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
  ], { cwd: dir, encoding: 'utf8', env: { ...process.env, TERM_GLOSSARY: '杰哥 => Jaygo' } });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(path.join(dir, 'review.html'), 'utf8');
  assert.ok(html.includes('id="btnShortcutHelp"'), 'review page should expose a shortcut guide button');
  assert.ok(html.includes('id="btnPreviewDelete"'), 'review page should expose delete preview button');
  assert.ok(html.includes('id="btnToggleVideoPreview"'), 'review page should expose video preview toggle');
  assert.ok(html.includes('id="sourceVideo"'), 'review page should include source video preview element');
  assert.ok(html.includes('id="btnGenerateVideos"'), 'review page should expose Agnes video material generation');
  assert.ok(html.includes('id="imageMotionEffect"'), 'review page should expose image motion effect selector');
  assert.ok(html.includes('/api/llm-video-plan'), 'review page should request LLM video material plans');
  assert.ok(html.includes('/api/generate-video'), 'review page should call video generation API');
  assert.ok(html.includes('buildMediaOverlaysForCut'), 'review page should submit generated image/video overlays to cut API');
  assert.ok(html.includes('motionEffect'), 'review page should persist and submit selected image motion effects');
  assert.ok(html.includes('mediaAssets'), 'review state should persist generated media assets');
  assert.ok(html.includes('/source-video'), 'review page should load source video through a safe route');
  assert.ok(html.includes('syncVideoPreview'), 'review page should keep video preview synced with playback');
  assert.ok(html.includes('toolbar-card.video-preview-visible'), 'video preview should use the compact top-right toolbar layout');
  assert.ok(html.includes("toolbarCardEl.classList.toggle('video-preview-visible'"), 'video preview layout should only reserve space while visible');
  assert.ok(html.includes('silenceVideoPreview'), 'video preview should force visual-only muted playback');
  assert.ok(html.includes("sourceVideoEl.addEventListener('volumechange'"), 'video preview should re-mute if the browser restores volume');
  assert.ok(!html.includes('id="sourceVideo" preload="metadata" src="/source-video" playsinline muted controls'), 'video preview should not expose native controls that can unmute audio');
  assert.ok(html.includes('function smoothSkipTo'), 'review playback should smooth automatic skip transitions');
  assert.ok(html.includes('smoothSkipTo(target)'), 'selected delete segment playback should not hard-seek abruptly');
  assert.ok(html.includes('id="btnShowDeleteDiagnostics"'), 'review page should expose delete diagnostics button');
  assert.ok(html.includes('id="cutPrecisionMode"'), 'review page should expose cut precision mode selector');
  assert.ok(html.includes('id="btnCopyDiagnostics"'), 'review page should expose copy diagnostics button');
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
  assert.ok(server.includes("pathname.startsWith('/video_assets/')"), 'review server should expose generated video assets safely');
  assert.ok(server.includes("pathname === '/api/llm-video-plan'"), 'review server should expose video material planning endpoint');
  assert.ok(server.includes("pathname === '/api/generate-video'"), 'review server should expose video material generation endpoint');
  assert.ok(server.includes('buildAgnesVideoQueryEndpoint'), 'review server should use Agnes video_id polling endpoint');
  assert.ok(server.includes('allowedMotionEffects'), 'review server should sanitize media overlay motion effects');
  const cutVideo = fs.readFileSync(path.join(__dirname, '..', 'talkcut', 'scripts', 'cut_video.js'), 'utf8');
  assert.ok(cutVideo.includes('loadMediaOverlays'), 'cut script should read media overlay plans');
  assert.ok(cutVideo.includes('runFfmpegOverlay'), 'cut script should apply generated media overlays');
  assert.ok(cutVideo.includes('buildOverlayVisualFilter'), 'cut script should apply image motion effects during overlay');
  assert.ok(cutVideo.includes('zoom-in'), 'cut script should support zoom-in image motion');
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
  assert.ok(releaseNotes.notes.includes('插入素材'), 'release notes should stay readable Chinese UTF-8');
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
testAgnesVideoPlanningAndOverlayWiring();
testLlmMarkingPromptIsConservative();
testJianyingDraftExport();
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
