#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const HOST = process.env.JAYGO_UPLOAD_HOST || '127.0.0.1';
const PORT = Number(process.env.JAYGO_UPLOAD_PORT || 32179);
const UPLOAD_DIR = process.env.JAYGO_UPLOAD_DIR || '/www/wwwroot/ailabing.cn/jaygo-uploads';
const PUBLIC_BASE_URL = (process.env.JAYGO_PUBLIC_BASE_URL || 'https://ailabing.cn/jaygo-uploads').replace(/\/+$/, '');
const TOKEN = process.env.JAYGO_UPLOAD_TOKEN || '';
const MAX_BYTES = Number(process.env.JAYGO_MAX_BYTES || 150 * 1024 * 1024);
const RETENTION_MS = Number(process.env.JAYGO_RETENTION_MS || 24 * 60 * 60 * 1000);
const CLEANUP_INTERVAL_MS = Number(process.env.JAYGO_CLEANUP_INTERVAL_MS || 60 * 60 * 1000);
const RATE_WINDOW_MS = Number(process.env.JAYGO_RATE_WINDOW_MS || 60 * 60 * 1000);
const RATE_MAX_UPLOADS = Number(process.env.JAYGO_RATE_MAX_UPLOADS || 60);

const ALLOWED_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.webm']);
const rateBuckets = new Map();

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-upload-token',
  });
  res.end(body);
}

function safeExt(name, type) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (ALLOWED_EXT.has(ext)) return ext;
  if (type === 'audio/mpeg') return '.mp3';
  if (type === 'audio/wav' || type === 'audio/x-wav') return '.wav';
  if (type === 'audio/mp4' || type === 'audio/aac') return '.m4a';
  if (type === 'audio/flac') return '.flac';
  return '';
}

function getToken(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return String(req.headers['x-upload-token'] || '').trim();
}

function requireToken(req) {
  if (!TOKEN) return true;
  const got = getToken(req);
  if (!got || got.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(TOKEN));
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(req) {
  if (!RATE_MAX_UPLOADS || RATE_MAX_UPLOADS < 1) return true;
  const now = Date.now();
  const ip = getClientIp(req);
  const bucket = rateBuckets.get(ip) || [];
  const recent = bucket.filter((ts) => now - ts < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX_UPLOADS) {
    rateBuckets.set(ip, recent);
    return false;
  }
  recent.push(now);
  rateBuckets.set(ip, recent);
  return true;
}

async function cleanupOldFiles() {
  try {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const now = Date.now();
    const entries = await fs.readdir(UPLOAD_DIR, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile()) return;
      const full = path.join(UPLOAD_DIR, entry.name);
      try {
        const stat = await fs.stat(full);
        if (now - stat.mtimeMs > RETENTION_MS) await fs.unlink(full);
      } catch (_) {}
    }));
  } catch (err) {
    console.error('[cleanup]', err.message || err);
  }
}

async function handleUpload(req, res) {
  if (!requireToken(req)) return json(res, 401, { error: 'unauthorized' });
  if (!checkRateLimit(req)) {
    return json(res, 429, {
      error: 'rate_limited',
      message: 'too many uploads from this IP',
      windowMs: RATE_WINDOW_MS,
      maxUploads: RATE_MAX_UPLOADS,
    });
  }

  const len = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(len) && len > MAX_BYTES) {
    return json(res, 413, { error: 'file_too_large', maxBytes: MAX_BYTES });
  }

  const reqUrl = `http://${req.headers.host || 'localhost'}${req.url || '/'}`;
  const webReq = new Request(reqUrl, {
    method: req.method,
    headers: req.headers,
    body: Readable.toWeb(req),
    duplex: 'half',
  });

  let form;
  try {
    form = await webReq.formData();
  } catch (err) {
    return json(res, 400, { error: 'invalid_multipart', message: err.message || String(err) });
  }

  const file = form.get('file') || form.get('audio') || form.get('files[]') || form.get('fileToUpload');
  if (!file || typeof file.arrayBuffer !== 'function') {
    return json(res, 400, { error: 'missing_file' });
  }

  const size = Number(file.size || 0);
  if (!size) return json(res, 400, { error: 'empty_file' });
  if (size > MAX_BYTES) return json(res, 413, { error: 'file_too_large', maxBytes: MAX_BYTES });

  const ext = safeExt(file.name, file.type);
  if (!ext) return json(res, 415, { error: 'unsupported_file_type' });

  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${ext}`;
  const tmpPath = path.join(UPLOAD_DIR, `.${id}.tmp`);
  const finalPath = path.join(UPLOAD_DIR, id);
  const data = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(tmpPath, data, { mode: 0o644 });
  await fs.rename(tmpPath, finalPath);
  await cleanupOldFiles();

  return json(res, 200, {
    ok: true,
    url: `${PUBLIC_BASE_URL}/${encodeURIComponent(id)}`,
    size,
    expiresInHours: Math.round(RETENTION_MS / 3600000),
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });
  if (req.method === 'POST' && req.url === '/upload-audio') {
    handleUpload(req, res).catch((err) => {
      console.error('[upload]', err.stack || err.message || err);
      json(res, 500, { error: 'server_error', message: err.message || String(err) });
    });
    return;
  }
  json(res, 404, { error: 'not_found' });
});

cleanupOldFiles();
setInterval(cleanupOldFiles, CLEANUP_INTERVAL_MS).unref();

server.listen(PORT, HOST, () => {
  console.log(`Jaygo upload service listening on http://${HOST}:${PORT}`);
});
