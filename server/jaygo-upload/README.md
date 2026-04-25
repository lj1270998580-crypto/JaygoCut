# Jaygo Cut Upload Service

This is the small HTTPS-backed upload service used before submitting audio URLs
to Volcengine ASR.

The service itself listens on `127.0.0.1:32179`; Nginx exposes it at:

```text
https://ailabing.cn/api/jaygo/upload-audio
https://ailabing.cn/api/jaygo/health
https://ailabing.cn/jaygo-uploads/
```

Runtime settings live in `/etc/jaygo-upload.env` on the server.

Important defaults:

- Files are deleted after 24 hours.
- Max upload size is 150 MB.
- Rate limit is 60 uploads per IP per hour.
- The upload token is intentionally not stored in this repository.
