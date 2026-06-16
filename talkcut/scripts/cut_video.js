#!/usr/bin/env node
/**
 * 根据删除列表剪辑视频（filter_complex 精确剪辑）— 跨平台 Node.js 版本
 *
 * 用法: node cut_video.js <input.mp4> <delete_segments.json> [output.mp4] [media_overlays.json]
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const INPUT = process.argv[2];
const DELETE_JSON = process.argv[3];
const OUTPUT = process.argv[4] || 'output_cut.mp4';
const OVERLAY_JSON = process.argv[5] || '';
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_BIN || 'ffprobe';

if (!INPUT || !DELETE_JSON) {
  console.error('❌ 用法: node cut_video.js <input.mp4> <delete_segments.json> [output.mp4] [media_overlays.json]');
  process.exit(1);
}
if (!fs.existsSync(INPUT)) {
  console.error(`❌ 找不到输入文件: ${INPUT}`);
  process.exit(1);
}
if (!fs.existsSync(DELETE_JSON)) {
  console.error(`❌ 找不到删除列表: ${DELETE_JSON}`);
  process.exit(1);
}

// file: 前缀：macOS/Linux 文件名可能含冒号，Windows 不需要
function fileArg(p) {
  return process.platform === 'win32' ? p : `file:${p}`;
}

function shellQuote(v) {
  return `"${String(v).replace(/"/g, '\\"')}"`;
}

function readEnvConfig() {
  const envFile = path.join(__dirname, '..', '..', '.env');
  const config = {};
  if (!fs.existsSync(envFile)) return config;

  const content = fs.readFileSync(envFile, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).replace(/\s+#.*$/, '').trim();
    config[key] = value;
  }
  return config;
}

function configValue(config, key, fallback = '') {
  const envValue = process.env[key];
  if (envValue !== undefined && String(envValue).trim() !== '') return String(envValue).trim();
  const fileValue = config[key];
  if (fileValue !== undefined && String(fileValue).trim() !== '') return String(fileValue).trim();
  return fallback;
}

function parseNumberInRange(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseEncoderPreset(value, fallback = 'slow') {
  const preset = String(value || '').trim();
  return ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'].includes(preset) ? preset : fallback;
}

function parseAudioBitrate(value, fallback = '192k') {
  const bitrate = String(value || '').trim().toLowerCase();
  return /^\d{2,4}k$/.test(bitrate) ? bitrate : fallback;
}

function sanitizeMotionEffect(value) {
  const effect = String(value || 'none').trim();
  return ['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down'].includes(effect)
    ? effect
    : 'none';
}

function evenDimension(value) {
  const parsed = Math.max(2, Math.ceil(Number(value) || 2));
  return parsed % 2 === 0 ? parsed : parsed + 1;
}

function parseMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function buildAdjustedDeleteSegments(deleteSegs, options) {
  const adjusted = [];
  for (const seg of deleteSegs) {
    const start = Math.max(0, seg.start + options.timelineOffsetSec - options.expandSec);
    const end = Math.min(options.duration, seg.end + options.timelineOffsetSec + options.expandSec);
    const rawDuration = Math.max(0, end - start);

    if (rawDuration >= options.minDeleteSec) {
      adjusted.push({ start, end });
    }
  }
  return adjusted;
}

function findAudioReferencePath() {
  const deleteDir = path.dirname(path.resolve(DELETE_JSON));
  const candidates = [
    path.join(deleteDir, 'audio.wav'),
    path.join(deleteDir, 'audio.mp3'),
    path.join(process.cwd(), 'audio.mp3'),
    path.join(process.cwd(), 'audio.wav'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function readTimelineMetadata() {
  const deleteDir = path.dirname(path.resolve(DELETE_JSON));
  const candidates = [
    path.join(deleteDir, 'audio_timeline.json'),
    path.join(process.cwd(), 'audio_timeline.json'),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (Number.isFinite(parsed.timelineOffsetSec)) {
        return parsed;
      }
    } catch (e) {
      // ignore malformed metadata and fall back to probing
    }
  }

  return null;
}

function probeMediaStartTime(mediaPath) {
  try {
    const output = execSync(
      `${shellQuote(FFPROBE_BIN)} -v error -show_entries format=start_time -of csv=p=0 ${shellQuote(fileArg(mediaPath))}`,
      { encoding: 'utf8' }
    ).trim();
    return parseFloat(output) || 0;
  } catch (e) {
    return 0;
  }
}

function probeSourceAudioStartTime(inputPath) {
  try {
    const output = execSync(
      `${shellQuote(FFPROBE_BIN)} -v error -select_streams a:0 -show_entries stream=start_time -of csv=p=0 ${shellQuote(fileArg(inputPath))}`,
      { encoding: 'utf8' }
    ).trim();
    return parseFloat(output) || 0;
  } catch (e) {
    return 0;
  }
}

function buildTempOutputPath(outputPath) {
  const resolved = path.resolve(outputPath);
  const dir = path.dirname(resolved);
  const ext = path.extname(resolved) || '.mp4';
  const base = path.basename(resolved, ext);
  return path.join(dir, `${base}.exporting.${process.pid}.${Date.now()}${ext}`);
}

function probeMediaInfo(mediaPath) {
  const raw = execSync(
    `${shellQuote(FFPROBE_BIN)} -v error -show_streams -show_format -print_format json ${shellQuote(fileArg(mediaPath))}`,
    { encoding: 'utf8' }
  );
  return JSON.parse(raw);
}

function parseFraction(value) {
  if (!value || typeof value !== 'string') return 0;
  const [num, den] = value.split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

function validateOutputFile(outputPath, expectedDurationSec) {
  if (!fs.existsSync(outputPath)) {
    throw new Error(`导出文件不存在: ${outputPath}`);
  }

  const stat = fs.statSync(outputPath);
  if (stat.size < 1024) {
    throw new Error(`导出文件过小，疑似损坏: ${stat.size} bytes`);
  }

  const info = probeMediaInfo(outputPath);
  const video = info.streams.find(stream => stream.codec_type === 'video');
  const audio = info.streams.find(stream => stream.codec_type === 'audio');
  const warnings = [];

  if (!video || !audio) {
    throw new Error('导出文件缺少视频流或音频流');
  }
  if (video.codec_name !== 'h264') {
    warnings.push(`视频编码为 ${video.codec_name}（期望 h264）`);
  }
  if (video.pix_fmt !== 'yuv420p') {
    warnings.push(`视频像素格式为 ${video.pix_fmt}（期望 yuv420p）`);
  }
  if (audio.codec_name !== 'aac') {
    warnings.push(`音频编码为 ${audio.codec_name}（期望 aac）`);
  }
  if (Number(audio.sample_rate) !== 48000) {
    warnings.push(`音频采样率为 ${audio.sample_rate}（期望 48000）`);
  }
  if (Number(audio.channels) !== 2) {
    warnings.push(`音频声道数为 ${audio.channels}（期望 2）`);
  }

  const formatStart = parseFloat(info.format.start_time) || 0;
  const videoStart = parseFloat(video.start_time) || 0;
  const audioStart = parseFloat(audio.start_time) || 0;
  if (Math.abs(formatStart) > 0.05 || Math.abs(videoStart) > 0.05 || Math.abs(audioStart) > 0.05) {
    warnings.push(`导出流起点偏移: format=${formatStart}s video=${videoStart}s audio=${audioStart}s`);
  }

  const formatDuration = parseFloat(info.format.duration) || 0;
  if (formatDuration < 0.2) {
    throw new Error(`导出时长异常: ${formatDuration}s`);
  }

  if (Number.isFinite(expectedDurationSec) && expectedDurationSec > 0) {
    const durationDrift = Math.abs(formatDuration - expectedDurationSec);
    if (durationDrift > 1.0) {
      warnings.push(`导出时长偏差较大: 期望约 ${expectedDurationSec.toFixed(3)}s，实际 ${formatDuration.toFixed(3)}s`);
    }
  }

  const frameRate = parseFraction(video.avg_frame_rate) || parseFraction(video.r_frame_rate);
  if (frameRate > 0 && Math.abs(frameRate - 30) > 0.05) {
    warnings.push(`导出帧率为 ${frameRate.toFixed(3)}fps（期望 30fps）`);
  }

  try {
    execSync(`${shellQuote(FFMPEG_BIN)} -v error -i ${shellQuote(fileArg(outputPath))} -f null -`, { stdio: 'pipe' });
  } catch (err) {
    warnings.push(`ffmpeg 二次校验有告警: ${err.message}`);
  }

  return {
    duration: formatDuration,
    size: stat.size,
    warnings,
  };
}

function ensureVisibleInFinder(outputPath) {
  if (process.platform !== 'darwin') return;

  try {
    spawnSync('chflags', ['nohidden', path.resolve(outputPath)], { stdio: 'ignore' });
  } catch (e) {
    // ignore visibility fix failures; export itself is still valid
  }
}

function buildAudioFilter(seg, index, totalSegments, fadeSec) {
  const segDuration = Math.max(0, seg.end - seg.start);
  const maxFadeSec = Math.max(0, segDuration / 2 - 0.001);
  const effectiveFadeSec = Math.min(fadeSec, maxFadeSec);

  let filter = `[0:a:0]atrim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},asettb=AVTB,asetpts=PTS-STARTPTS`;

  if (effectiveFadeSec > 0 && totalSegments > 1) {
    if (index > 0) {
      filter += `,afade=t=in:st=0:d=${effectiveFadeSec.toFixed(3)}`;
    }
    if (index < totalSegments - 1) {
      const fadeOutStart = Math.max(0, segDuration - effectiveFadeSec);
      filter += `,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${effectiveFadeSec.toFixed(3)}`;
    }
  }

  return `${filter}[a${index}]`;
}

function readJsonFileSafe(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return JSON.parse(normalized);
}

function runFfmpegWithFilterScript(inputPath, filterCmd, tempOutputPath) {
  const filterScriptPath = path.join(
    path.dirname(path.resolve(tempOutputPath)),
    `ffmpeg_filter_${process.pid}_${Date.now()}.txt`
  );
  fs.writeFileSync(filterScriptPath, filterCmd, 'utf8');

  const exportConfig = readEnvConfig();
  const exportCrf = parseNumberInRange(configValue(exportConfig, 'CUT_EXPORT_CRF', '16'), 16, 0, 35);
  const exportPreset = parseEncoderPreset(configValue(exportConfig, 'CUT_EXPORT_PRESET', 'slow'), 'slow');
  const audioBitrate = parseAudioBitrate(configValue(exportConfig, 'CUT_AUDIO_BITRATE', '192k'), '192k');
  console.log(`Export quality: CRF=${exportCrf}, preset=${exportPreset}, audio=${audioBitrate}`);

  const args = [
    '-y',
    '-i',
    inputPath,
    '-filter_complex_script',
    filterScriptPath,
    '-map',
    '[vfinal]',
    '-map',
    '[afinal]',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-c:v',
    'libx264',
    '-preset',
    exportPreset,
    '-crf',
    String(exportCrf),
    '-profile:v',
    'high',
    '-level:v',
    '4.1',
    '-pix_fmt',
    'yuv420p',
    '-tag:v',
    'avc1',
    '-movflags',
    '+faststart',
    '-brand',
    'mp42',
    '-video_track_timescale',
    '30000',
    '-c:a',
    'aac',
    '-profile:a',
    'aac_low',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-b:a',
    audioBitrate,
    tempOutputPath,
  ];

  try {
    const result = spawnSync(FFMPEG_BIN, args, { stdio: 'inherit', windowsHide: true });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`ffmpeg exited with code ${result.status}`);
    }
  } finally {
    if (fs.existsSync(filterScriptPath)) {
      fs.rmSync(filterScriptPath, { force: true });
    }
  }
}

function mapTimeAfterDeletes(time, deletedSegments) {
  const t = Math.max(0, Number(time) || 0);
  let removed = 0;
  for (const seg of deletedSegments) {
    if (seg.end <= t) {
      removed += seg.end - seg.start;
    } else if (seg.start < t) {
      return Math.max(0, seg.start - removed);
    } else {
      break;
    }
  }
  return Math.max(0, t - removed);
}

function loadMediaOverlays(overlayJson, deletedSegments, timelineOffsetSec, expectedDurationSec) {
  if (!overlayJson || !fs.existsSync(overlayJson)) return [];
  let raw = [];
  try {
    raw = readJsonFileSafe(overlayJson);
  } catch (err) {
    console.log(`⚠️ 无法读取素材合成文件: ${err.message}`);
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const overlays = [];
  for (const item of raw) {
    const type = String(item?.type || '').toLowerCase() === 'video' ? 'video' : 'image';
    const filePath = path.resolve(String(item?.filePath || ''));
    if (!fs.existsSync(filePath)) continue;
    const rawStart = Number(item?.start);
    const rawEnd = Number(item?.end);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawEnd <= rawStart) continue;

    const sourceStart = Math.max(0, rawStart + timelineOffsetSec);
    const sourceEnd = Math.max(sourceStart + 0.2, rawEnd + timelineOffsetSec);
    const mappedStart = mapTimeAfterDeletes(sourceStart, deletedSegments);
    let mappedEnd = mapTimeAfterDeletes(sourceEnd, deletedSegments);
    if (mappedEnd - mappedStart < 0.5) {
      mappedEnd = mappedStart + Math.min(5, Math.max(1.5, rawEnd - rawStart));
    }
    if (Number.isFinite(expectedDurationSec) && expectedDurationSec > 0) {
      if (mappedStart >= expectedDurationSec) continue;
      mappedEnd = Math.min(expectedDurationSec, mappedEnd);
    }
    if (mappedEnd <= mappedStart + 0.2) continue;

    overlays.push({
      type,
      filePath,
      start: mappedStart,
      end: mappedEnd,
      duration: mappedEnd - mappedStart,
      title: String(item?.title || '').slice(0, 80),
      motionEffect: type === 'image' ? sanitizeMotionEffect(item?.motionEffect) : 'none',
    });
  }
  return overlays.slice(0, 50);
}

function buildOverlayVisualFilter(inputLabel, overlay, width, height, duration) {
  const base = `[${inputLabel}:v]`;
  const effect = overlay.type === 'image' ? sanitizeMotionEffect(overlay.motionEffect) : 'none';
  const safeDuration = Math.max(0.2, Number(duration) || 0.2).toFixed(3);
  const w = evenDimension(width);
  const h = evenDimension(height);
  if (overlay.type !== 'image' || effect === 'none') {
    return `${base}scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,format=rgba`;
  }

  if (effect === 'zoom-in' || effect === 'zoom-out') {
    const scaleExpr = effect === 'zoom-in'
      ? `(1+0.06*t/${safeDuration})`
      : `(1.06-0.06*t/${safeDuration})`;
    return base + [
      `scale=w='ceil(${w}*${scaleExpr}/2)*2':h='ceil(${h}*${scaleExpr}/2)*2':eval=frame:force_original_aspect_ratio=increase`,
      `crop=${w}:${h}:x='(iw-ow)/2':y='(ih-oh)/2'`,
      'setsar=1',
      'format=rgba',
    ].join(',');
  }

  const panW = evenDimension(w * 1.08);
  const panH = evenDimension(h * 1.08);
  const xExpr = effect === 'pan-right'
    ? `(iw-ow)*t/${safeDuration}`
    : effect === 'pan-left'
      ? `(iw-ow)*(1-t/${safeDuration})`
      : '(iw-ow)/2';
  const yExpr = effect === 'pan-down'
    ? `(ih-oh)*t/${safeDuration}`
    : effect === 'pan-up'
      ? `(ih-oh)*(1-t/${safeDuration})`
      : '(ih-oh)/2';
  return base + [
    `scale=${panW}:${panH}:force_original_aspect_ratio=increase`,
    `crop=${w}:${h}:x='${xExpr}':y='${yExpr}'`,
    'setsar=1',
    'format=rgba',
  ].join(',');
}

function runFfmpegOverlay(baseInputPath, overlays, tempOutputPath) {
  if (!overlays.length) return false;

  const info = probeMediaInfo(baseInputPath);
  const video = info.streams.find(stream => stream.codec_type === 'video') || {};
  const width = Math.max(2, Number(video.width) || 1920);
  const height = Math.max(2, Number(video.height) || 1080);
  const exportConfig = readEnvConfig();
  const exportCrf = parseNumberInRange(configValue(exportConfig, 'CUT_EXPORT_CRF', '16'), 16, 0, 35);
  const exportPreset = parseEncoderPreset(configValue(exportConfig, 'CUT_EXPORT_PRESET', 'slow'), 'slow');

  const filterScriptPath = path.join(
    path.dirname(path.resolve(tempOutputPath)),
    `ffmpeg_overlay_${process.pid}_${Date.now()}.txt`
  );
  const filters = [`[0:v]format=yuv420p[base0]`];
  let currentLabel = 'base0';

  overlays.forEach((overlay, index) => {
    const inputIndex = index + 1;
    const start = Math.max(0, overlay.start);
    const end = Math.max(start + 0.2, overlay.end);
    const duration = Math.max(0.2, overlay.duration || (end - start));
    const fade = Math.min(0.18, Math.max(0, duration / 4));
    const outLabel = index === overlays.length - 1 ? 'vout' : `base${index + 1}`;
    const fadeOutStart = Math.max(0, duration - fade);
    let overlayFilter = buildOverlayVisualFilter(inputIndex, overlay, width, height, duration);
    if (fade > 0.02) {
      overlayFilter += `,fade=t=in:st=0:d=${fade.toFixed(3)}:alpha=1,fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fade.toFixed(3)}:alpha=1`;
    }
    overlayFilter += `,setpts=PTS-STARTPTS+${start.toFixed(3)}/TB[ov${index}]`;
    filters.push(overlayFilter);
    filters.push(`[${currentLabel}][ov${index}]overlay=0:0:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[${outLabel}]`);
    currentLabel = outLabel;
  });
  fs.writeFileSync(filterScriptPath, filters.join(';'), 'utf8');

  const args = ['-y', '-i', baseInputPath];
  for (const overlay of overlays) {
    const duration = Math.max(0.2, overlay.duration || (overlay.end - overlay.start));
    if (overlay.type === 'video') {
      args.push('-stream_loop', '-1', '-t', duration.toFixed(3), '-i', overlay.filePath);
    } else {
      args.push('-loop', '1', '-t', duration.toFixed(3), '-i', overlay.filePath);
    }
  }
  args.push(
    '-filter_complex_script',
    filterScriptPath,
    '-map',
    '[vout]',
    '-map',
    '0:a?',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-c:v',
    'libx264',
    '-preset',
    exportPreset,
    '-crf',
    String(exportCrf),
    '-profile:v',
    'high',
    '-level:v',
    '4.1',
    '-pix_fmt',
    'yuv420p',
    '-tag:v',
    'avc1',
    '-movflags',
    '+faststart',
    '-c:a',
    'copy',
    '-shortest',
    tempOutputPath,
  );

  try {
    console.log(`🎬 合成素材覆盖层: ${overlays.length} 个`);
    overlays.forEach((overlay, index) => {
      console.log(`  #${index + 1} ${overlay.type} ${overlay.start.toFixed(2)}-${overlay.end.toFixed(2)}s ${path.basename(overlay.filePath)}`);
    });
    const result = spawnSync(FFMPEG_BIN, args, { stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`ffmpeg overlay exited with code ${result.status}`);
    return true;
  } finally {
    if (fs.existsSync(filterScriptPath)) {
      fs.rmSync(filterScriptPath, { force: true });
    }
  }
}

function detectSpeechBoundsInKeepSegment(inputPath, seg, options) {
  const segDuration = seg.end - seg.start;
  if (segDuration <= options.minKeepSec) {
    return seg;
  }

  const args = [
    '-hide_banner',
    '-ss',
    seg.start.toFixed(3),
    '-to',
    seg.end.toFixed(3),
    '-i',
    fileArg(inputPath),
    '-map',
    '0:a:0',
    '-af',
    `silencedetect=noise=${options.silenceNoiseDb}:d=${options.detectSilenceSec}`,
    '-f',
    'null',
    '-',
  ];

  const result = spawnSync(FFMPEG_BIN, args, { encoding: 'utf8' });
  if (result.error) {
    return seg;
  }

  const log = `${result.stderr || ''}\n${result.stdout || ''}`;
  const lines = log.split('\n');

  let pendingSilenceStart = null;
  let leadingSilenceEnd = null;
  let trailingSilenceStart = null;

  for (const line of lines) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch) {
      pendingSilenceStart = parseFloat(startMatch[1]);
      continue;
    }

    const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
    if (!endMatch) continue;

    const silenceEnd = parseFloat(endMatch[1]);
    const silenceDuration = parseFloat(endMatch[2]);
    const silenceStart = pendingSilenceStart ?? Math.max(0, silenceEnd - silenceDuration);

    if (silenceStart <= options.edgeSlackSec && silenceDuration >= options.trimSilenceSec) {
      leadingSilenceEnd = silenceEnd;
    }

    if (segDuration - silenceEnd <= options.edgeSlackSec && silenceDuration >= options.trimSilenceSec) {
      trailingSilenceStart = silenceStart;
    }

    pendingSilenceStart = null;
  }

  let speechStart = seg.start;
  let speechEnd = seg.end;

  if (leadingSilenceEnd !== null && segDuration - leadingSilenceEnd >= options.minKeepSec) {
    speechStart = seg.start + leadingSilenceEnd;
  }

  if (trailingSilenceStart !== null && trailingSilenceStart >= options.minKeepSec) {
    speechEnd = seg.start + trailingSilenceStart;
  }

  if (speechEnd - speechStart < options.minKeepSec) {
    return seg;
  }

  const refined = {
    start: Math.max(0, speechStart - options.keepPaddingSec),
    end: Math.min(options.duration, speechEnd + options.keepPaddingSec),
  };

  if (refined.start > seg.start + 0.05 || refined.end < seg.end - 0.05) {
    console.log(
      `🎯 保留片段静音收紧: ${seg.start.toFixed(2)}-${seg.end.toFixed(2)}s -> ${refined.start.toFixed(2)}-${refined.end.toFixed(2)}s`
    );
  }

  return refined;
}

function refineKeepSegments(inputPath, keepSegs, options) {
  const refined = [];

  for (const seg of keepSegs) {
    const next = detectSpeechBoundsInKeepSegment(inputPath, seg, options);
    if (next.end - next.start >= options.minKeepSec) {
      refined.push(next);
    }
  }

  if (refined.length === 0) {
    return keepSegs;
  }

  const merged = [];
  for (const seg of refined) {
    if (merged.length === 0 || seg.start > merged[merged.length - 1].end) {
      merged.push({ ...seg });
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, seg.end);
    }
  }

  return merged;
}

// 获取视频时长
const duration = parseFloat(
  execSync(`${shellQuote(FFPROBE_BIN)} -v error -show_entries format=duration -of csv=p=0 ${shellQuote(fileArg(INPUT))}`, { encoding: 'utf8' }).trim()
);
console.log(`📹 视频时长: ${duration}s`);

// 配置参数
const envConfig = readEnvConfig();
const CUT_EXPAND_MS = parseMs(configValue(envConfig, 'CUT_EXPAND_MS', '0'), 0);
const CUT_KEEP_PADDING_MS = parseMs(configValue(envConfig, 'CUT_KEEP_PADDING_MS', '0'), 0);
const CUT_MIN_DELETE_MS = parseMs(configValue(envConfig, 'CUT_MIN_DELETE_MS', '200'), 200);
const CROSSFADE_MS = parseMs(configValue(envConfig, 'CROSSFADE_MS', '30'), 30);
const expandSec = CUT_EXPAND_MS / 1000;
const keepPaddingSec = CUT_KEEP_PADDING_MS / 1000;
const minDeleteSec = CUT_MIN_DELETE_MS / 1000;
const crossfadeSec = CROSSFADE_MS / 1000;

console.log(`⚙️ 优化参数: 边界保留=${CUT_KEEP_PADDING_MS}ms, 最小删除=${CUT_MIN_DELETE_MS}ms, 额外扩展=${CUT_EXPAND_MS}ms, 音频接缝淡化=${CROSSFADE_MS}ms`);

// 读取并处理删除片段
const deleteSegsRaw = readJsonFileSafe(DELETE_JSON);
if (!Array.isArray(deleteSegsRaw)) {
  throw new Error('删除列表格式错误：应为数组 JSON（[{start,end}, ...]）');
}
const deleteSegs = deleteSegsRaw
  .map((seg) => ({
    start: Number(seg?.start),
    end: Number(seg?.end),
  }))
  .filter((seg) => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start)
  .sort((a, b) => a.start - b.start);

if (!deleteSegs.length) {
  throw new Error('删除列表为空或无有效时间段');
}

const audioReference = findAudioReferencePath();
const timelineMetadata = readTimelineMetadata();
const reviewAudioStartSec = audioReference ? probeMediaStartTime(audioReference) : 0;
const sourceAudioStartSec = probeSourceAudioStartTime(INPUT);
const timelineOffsetSec = timelineMetadata
  ? Number(timelineMetadata.timelineOffsetSec) || 0
  : sourceAudioStartSec - reviewAudioStartSec;
if (timelineMetadata) {
  console.log(`🔧 已读取时间轴元数据，导出映射补偿=${timelineOffsetSec.toFixed(3)}s`);
} else if (audioReference) {
  console.log(`🔧 审核音频起点=${reviewAudioStartSec.toFixed(3)}s，源视频音频起点=${sourceAudioStartSec.toFixed(3)}s，导出映射补偿=${timelineOffsetSec.toFixed(3)}s`);
}

// 映射删除范围
const adjustedSegs = buildAdjustedDeleteSegments(deleteSegs, {
  timelineOffsetSec,
  duration,
  expandSec,
  minDeleteSec,
});

if (adjustedSegs.length === 0 && deleteSegs.length > 0) {
  console.log('⚠️ 当前删除片段都很短，按保留策略收缩后没有可执行的删除范围');
}

// 合并重叠的删除段
const mergedSegs = [];
for (const seg of adjustedSegs) {
  if (mergedSegs.length === 0 || seg.start > mergedSegs[mergedSegs.length - 1].end) {
    mergedSegs.push({ ...seg });
  } else {
    mergedSegs[mergedSegs.length - 1].end = Math.max(mergedSegs[mergedSegs.length - 1].end, seg.end);
  }
}

// 计算保留片段
const keepSegs = [];
let cursor = 0;
for (const del of mergedSegs) {
  if (del.start > cursor) {
    keepSegs.push({ start: cursor, end: del.start });
  }
  cursor = del.end;
}
if (cursor < duration) {
  keepSegs.push({ start: cursor, end: duration });
}

const refinedKeepSegs = refineKeepSegments(INPUT, keepSegs, {
  duration,
  keepPaddingSec,
  detectSilenceSec: 0.15,
  trimSilenceSec: 0.25,
  edgeSlackSec: 0.08,
  silenceNoiseDb: '-35dB',
  minKeepSec: 0.12,
});

if (!refinedKeepSegs.length) {
  throw new Error('删除片段覆盖了全部内容，无法导出空视频。请至少保留一段内容。');
}

console.log(`保留片段数: ${refinedKeepSegs.length}`);
console.log(`删除片段数: ${mergedSegs.length}`);

let deletedTime = 0;
for (const seg of mergedSegs) deletedTime += seg.end - seg.start;
console.log(`删除总时长: ${deletedTime.toFixed(2)}s`);

// 生成 filter_complex
const filters = [];
let concatInputs = '';

for (let i = 0; i < refinedKeepSegs.length; i++) {
  const seg = refinedKeepSegs[i];
  filters.push(`[0:v:0]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},settb=AVTB,setpts=PTS-STARTPTS[v${i}]`);
  filters.push(buildAudioFilter(seg, i, refinedKeepSegs.length, crossfadeSec));
  concatInputs += `[v${i}][a${i}]`;
}

filters.push(`${concatInputs}concat=n=${refinedKeepSegs.length}:v=1:a=1[outv][outa]`);

filters.push('[outv]fps=30,setsar=1,format=yuv420p[vfinal]');
// 不使用 async 拉伸，避免长视频多段拼接后产生累计音画漂移
filters.push('[outa]aresample=48000:first_pts=0,pan=stereo|c0=c0|c1=c0[afinal]');

const filterCmd = filters.join(';');
const expectedDuration = refinedKeepSegs.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
const tempOutput = buildTempOutputPath(OUTPUT);
let overlayTempOutput = '';

fs.mkdirSync(path.dirname(path.resolve(OUTPUT)), { recursive: true });

console.log('\n✂️ 执行 FFmpeg 精确剪辑...');

try {
  runFfmpegWithFilterScript(INPUT, filterCmd, tempOutput);

  validateOutputFile(tempOutput, expectedDuration);
  let finalTempOutput = tempOutput;
  const overlays = loadMediaOverlays(OVERLAY_JSON, mergedSegs, timelineOffsetSec, expectedDuration);
  if (overlays.length) {
    const overlayOutput = buildTempOutputPath(OUTPUT);
    overlayTempOutput = overlayOutput;
    runFfmpegOverlay(tempOutput, overlays, overlayOutput);
    fs.rmSync(tempOutput, { force: true });
    finalTempOutput = overlayOutput;
  }

  const validated = validateOutputFile(finalTempOutput, expectedDuration);
  fs.renameSync(finalTempOutput, path.resolve(OUTPUT));
  ensureVisibleInFinder(OUTPUT);
  console.log(`✅ 已保存: ${OUTPUT}`);
  console.log(`📹 新时长: ${validated.duration}s`);
  console.log(`📦 文件大小: ${validated.size} bytes`);
  if (validated.warnings && validated.warnings.length) {
    validated.warnings.forEach((msg) => console.log(`⚠️ ${msg}`));
  }
} catch (e) {
  if (fs.existsSync(tempOutput)) {
    fs.rmSync(tempOutput, { force: true });
  }
  if (overlayTempOutput && fs.existsSync(overlayTempOutput)) {
    fs.rmSync(overlayTempOutput, { force: true });
  }
  console.error('❌ 剪辑失败');
  if (e instanceof Error && e.message) {
    console.error(e.message);
  }
  process.exit(1);
}
