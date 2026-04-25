#!/usr/bin/env node
/**
 * Volcengine async speech transcription (Node.js)
 * Usage: node volcengine_transcribe.js <audio_url>
 * Output: volcengine_result.json
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const AUDIO_URL = process.argv[2];
if (!AUDIO_URL) {
  console.error('Usage: node volcengine_transcribe.js <audio_url>');
  process.exit(1);
}

const SCRIPT_DIR = __dirname;
const ENV_FILE = path.join(SCRIPT_DIR, '..', '..', '.env');

function parseEnvFile(filePath) {
  const config = {};
  if (!fs.existsSync(filePath)) return config;

  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).replace(/\s+#.*$/, '').trim();
    config[key] = value;
  }
  return config;
}

const envConfig = parseEnvFile(ENV_FILE);
const API_KEY = process.env.VOLCENGINE_API_KEY || envConfig.VOLCENGINE_API_KEY || '';
if (!API_KEY) {
  console.error('VOLCENGINE_API_KEY is missing (set env var or .env).');
  process.exit(1);
}

const dictFile = path.join(SCRIPT_DIR, '..', '..', 'subtitles', 'dictionary.txt');
let hotWords = [];
if (fs.existsSync(dictFile)) {
  hotWords = fs.readFileSync(dictFile, 'utf8')
    .split(/\r?\n/)
    .map((w) => w.trim())
    .filter(Boolean);
}

const requestBody = { url: AUDIO_URL };
if (hotWords.length > 0) {
  requestBody.hot_words = hotWords.map((word) => ({ word }));
}

function request(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve(data);
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const submitUrl = 'https://openspeech.bytedance.com/api/v1/vc/submit?language=zh-CN&use_itn=True&use_capitalize=True&max_lines=1&words_per_line=15';
  const submitHeaders = {
    Accept: '*/*',
    'x-api-key': API_KEY,
    Connection: 'keep-alive',
    'Content-Type': 'application/json',
  };

  console.log('Submitting transcription task...');
  const submitResponse = await request('POST', submitUrl, submitHeaders, JSON.stringify(requestBody));

  let submitData;
  try {
    submitData = JSON.parse(submitResponse);
  } catch {
    console.error('Submit failed:', submitResponse);
    process.exit(1);
  }

  const taskId = submitData.id;
  if (!taskId) {
    console.error('Submit failed:', submitResponse);
    process.exit(1);
  }

  console.log(`Task submitted: ${taskId}`);
  const maxAttempts = 120;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(5000);

    const queryUrl = `https://openspeech.bytedance.com/api/v1/vc/query?id=${taskId}`;
    const queryResponse = await request('GET', queryUrl, {
      Accept: '*/*',
      'x-api-key': API_KEY,
      Connection: 'keep-alive',
    });

    let queryData;
    try {
      queryData = JSON.parse(queryResponse);
    } catch {
      process.stdout.write('.');
      continue;
    }

    const code = queryData.code;
    if (code === 0) {
      const utterances = Array.isArray(queryData.utterances) ? queryData.utterances : [];
      const utteranceCount = utterances.length;
      const wordCount = utterances.reduce(
        (sum, utt) => sum + (Array.isArray(utt.words) ? utt.words.length : 0),
        0,
      );
      const textChars = utterances.reduce(
        (sum, utt) => sum + String(utt.text || '').trim().length,
        0,
      );
      if (utteranceCount === 0 || (wordCount === 0 && textChars === 0)) {
        console.error(
          `\nTranscription returned empty result. utterances=${utteranceCount}, words=${wordCount}, textChars=${textChars}`,
        );
        console.error('Possible causes: uploaded audio URL is not reachable by Volcengine, audio is silent/too short, or the ASR service returned an incomplete result.');
        console.error(`Audio URL: ${AUDIO_URL}`);
        console.error('Raw response:', queryResponse.slice(0, 1000));
        process.exit(1);
      }
      fs.writeFileSync('volcengine_result.json', queryResponse, 'utf8');
      if (wordCount === 0) {
        console.log(`\nTranscription completed with sentence timestamps only. utterances=${utteranceCount}`);
      } else {
        console.log(`\nTranscription completed. utterances=${utteranceCount}, words=${wordCount}`);
      }
      process.exit(0);
    }

    if (code === 1000) {
      process.stdout.write('.');
      continue;
    }

    console.error('\nTranscription failed:', queryResponse);
    process.exit(1);
  }

  console.error('\nTimeout: transcription did not finish in time.');
  process.exit(1);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
