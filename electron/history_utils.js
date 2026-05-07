const fs = require('fs');
const path = require('path');

function findFirstExistingDir(candidates) {
  for (const candidate of candidates || []) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {}
  }
  return '';
}

function findReviewDirUnder(rootDir) {
  if (!rootDir) return '';
  const stack = [rootDir];
  const maxVisits = 300;
  let visits = 0;
  while (stack.length && visits < maxVisits) {
    visits += 1;
    const current = stack.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === 'review.html')) {
      return current;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name.toLowerCase();
      if (name === 'node_modules' || name === '.git') continue;
      stack.push(path.join(current, entry.name));
    }
  }
  return '';
}

function resolveHistoryReviewDir(entry) {
  const direct = findFirstExistingDir([entry?.reviewDir]);
  if (direct) return direct;
  const projectDir = findFirstExistingDir([entry?.projectDir]);
  const candidate = findFirstExistingDir([
    projectDir ? path.join(projectDir, 'talkcut', '3_review') : '',
    projectDir ? path.join(projectDir, '剪口播', '3_审核') : '',
  ]);
  if (candidate) return candidate;
  return findReviewDirUnder(projectDir);
}

function resolveHistoryVideoPath(entry, reviewDir) {
  if (entry?.videoPath && fs.existsSync(entry.videoPath)) return entry.videoPath;
  const runtimeInfo = path.join(reviewDir || '', 'runtime_info.json');
  if (fs.existsSync(runtimeInfo)) {
    try {
      const data = JSON.parse(fs.readFileSync(runtimeInfo, 'utf8'));
      if (data.videoPath && fs.existsSync(data.videoPath)) return data.videoPath;
    } catch {}
  }
  return entry?.videoPath || '';
}

function buildHistoryReviewResumePlan(entry) {
  if (!entry) {
    throw new Error('Invalid history entry');
  }
  const reviewDir = resolveHistoryReviewDir(entry);
  if (!reviewDir) {
    throw new Error(`Review directory is missing and could not be located: ${entry.reviewDir || entry.projectDir || '-'}`);
  }
  const videoPath = resolveHistoryVideoPath(entry, reviewDir);
  const videoExists = !!(videoPath && fs.existsSync(videoPath));
  return {
    reviewDir,
    videoPath,
    outputRoot: entry.outputRoot || path.dirname(entry.projectDir || reviewDir),
    videoExists,
    canCut: videoExists,
    warning: videoExists ? '' : `原视频文件不存在：${videoPath || entry.videoPath || '-'}。审核页仍可打开查看和恢复草稿，但暂时不能执行裁剪。`,
  };
}

function annotateHistoryEntry(entry) {
  const reviewDir = resolveHistoryReviewDir(entry);
  const videoPath = resolveHistoryVideoPath(entry, reviewDir);
  const reviewExists = !!reviewDir;
  const videoExists = !!(videoPath && fs.existsSync(videoPath));
  let status = 'ready';
  let label = '可恢复';
  let message = '审核文件和原视频都可用。';
  if (!reviewExists) {
    status = 'missing_review';
    label = '审核缺失';
    message = '审核页面文件不存在，无法恢复审核。';
  } else if (!videoExists) {
    status = 'missing_video';
    label = '原视频缺失';
    message = '可打开审核页查看草稿，但执行裁剪前需要重新定位原视频。';
  }
  return {
    ...entry,
    reviewDir: reviewDir || entry?.reviewDir || '',
    videoPath: videoPath || entry?.videoPath || '',
    health: {
      status,
      label,
      message,
      reviewExists,
      videoExists,
      canOpenReview: reviewExists,
      canCut: reviewExists && videoExists,
    },
  };
}

function sameHistoryEntry(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id) return String(a.id) === String(b.id);
  return (
    String(a.projectDir || '') === String(b.projectDir || '') &&
    String(a.videoPath || '') === String(b.videoPath || '') &&
    String(a.finishedAt || '') === String(b.finishedAt || '')
  );
}

function relinkHistoryVideo(list, target, newVideoPath) {
  const nextVideoPath = path.resolve(String(newVideoPath || ''));
  if (!nextVideoPath || !fs.existsSync(nextVideoPath)) {
    throw new Error(`Video file is missing: ${newVideoPath || '-'}`);
  }
  return (Array.isArray(list) ? list : []).map((item) => {
    if (!sameHistoryEntry(item, target)) return item;
    return {
      ...item,
      videoPath: nextVideoPath,
      relinkedAt: new Date().toISOString(),
    };
  });
}

module.exports = {
  annotateHistoryEntry,
  buildHistoryReviewResumePlan,
  findFirstExistingDir,
  findReviewDirUnder,
  relinkHistoryVideo,
  resolveHistoryReviewDir,
  resolveHistoryVideoPath,
  sameHistoryEntry,
};
