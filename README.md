# Telegram Media Bot Server

A small private Node.js server that receives batches of images/videos from the Cloudflare Worker in [`telegram-media-dashboard`](../telegram-media-dashboard), validates them, splits them into packs of 5–10 and sends each pack to Telegram with `sendMediaGroup`.

```text
Cloudflare Worker --(X-Internal-Key)--> THIS SERVER --(TELEGRAM_BOT_TOKEN)--> Telegram Bot API
```

## 1. What the server does

- `POST /api/send-media` accepts multipart uploads (`files`, `packSize`, `caption`)
- Checks the file **contents** (magic bytes), not just the extension or MIME type
- Splits files into packs (e.g. 23 files, pack size 10 → 10 + 10 + 3) and sends them **sequentially** with `sendMediaGroup` and `attach://` uploads, mixing photos and videos
- A single leftover file is sent with `sendPhoto`/`sendVideo` (Telegram albums need 2–10 items)
- Honors Telegram `retry_after` (bounded retries), waits `PACK_DELAY_MS` between packs, runs one send job at a time
- Streams uploads to temporary disk files (not RAM) and deletes them afterwards

## 2. Requirements

Node.js 20+ (or Docker), a Telegram bot token, and a public HTTPS URL reachable by the Cloudflare Worker.

## 3. Installation

```bash
npm install
```

## 4. `.env` setup

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `TELEGRAM_BOT_TOKEN` | – | **Required.** From @BotFather. Never leaves this server. |
| `TELEGRAM_CHAT_ID` | – | **Required.** Destination chat/channel. |
| `INTERNAL_API_KEY` | – | **Required**, ≥16 chars. Must equal the Worker's secret. `openssl rand -hex 32` |
| `MAX_FILE_SIZE_MB` | `50` | Per-file limit |
| `MAX_FILES` | `100` | Max files per request |
| `PACK_DELAY_MS` | `1500` | Minimum pause between packs |
| `RATE_LIMIT_PER_MINUTE` | `60` | Optional, per-IP request limit |
| `TELEGRAM_MAX_RETRIES` | `5` | Optional, retries for 429/5xx/network errors |
| `TRUST_PROXY` | – | Optional. `true` (or a hop count) when behind a reverse proxy |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | Optional, for a self-hosted Bot API server |

The server refuses to start if a required value is missing. `.env` is git-ignored; never commit it.

## 5. Telegram bot setup

1. In Telegram open **@BotFather** → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`.
2. Add the bot to the group, or add it as an **administrator** of the channel (with permission to post).

## 6. Finding the chat ID

- **Private chat:** message your bot (press *Start*), then open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser (replace `<YOUR_TOKEN>`) and read `message.chat.id`.
- **Group:** add the bot, send a message in the group, call `getUpdates`; group IDs are negative (e.g. `-1001234567890`).
- **Channel:** use `@channelusername` for public channels, or the `-100…` ID from `getUpdates` after posting in the channel.

Do not share URLs that contain your token.

## 7. Run locally

```bash
npm start            # or: npm run dev   (auto-restart)
curl http://localhost:8080/health
```

Test sending without the Worker:

```bash
curl -X POST "http://localhost:8080/api/send-media?packSize=5" \
  -H "X-Internal-Key: YOUR_KEY" \
  -F files=@photo1.jpg -F files=@photo2.jpg -F caption="Test"
```

## 8. Docker

```bash
docker build -t telegram-media-bot-server .
docker run --env-file .env -p 8080:8080 telegram-media-bot-server
```

The image runs as a non-root user and includes a health check.

## 9. VPS deployment

```bash
git clone <your-repo> && cd telegram-media-bot-server
npm install --omit=dev && cp .env.example .env && nano .env
```

Run it with Docker (`docker run -d --restart unless-stopped --env-file .env -p 127.0.0.1:8080:8080 telegram-media-bot-server`) or systemd/pm2, and put a TLS reverse proxy in front. Example Caddyfile (automatic HTTPS):

```text
bot.example.com {
    request_body { max_size 120MB }
    reverse_proxy 127.0.0.1:8080
}
```

Set `TRUST_PROXY=true` when behind the proxy. Use standard port 443 for the public URL.

## 10. Railway / Render / Fly.io

- **Railway / Render:** create a service from the repo (Dockerfile is detected, or use build `npm install` and start `npm start`). Add all variables from section 4 in the dashboard (never in Git). Use the provided HTTPS URL as the Worker's `BOT_SERVER_URL`. Free tiers that sleep can add delay or time out the first request.
- **Fly.io:** `fly launch` (uses the Dockerfile; internal port 8080), then `fly secrets set TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… INTERNAL_API_KEY=…` and `fly deploy`.

## 11. Cloudflare Worker connection

In the dashboard repo: `npx wrangler secret put BOT_SERVER_URL` (this server's public HTTPS URL, no trailing slash) and `npx wrangler secret put INTERNAL_API_KEY` (same value as here). The Worker sends `X-Internal-Key` on each call. For extra isolation you can expose the server only through a Cloudflare Tunnel.

## 12. API endpoints

`GET /health` → `{ "ok": true, "service": "telegram-media-bot-server", "uptime": 42 }`

`POST /api/send-media` (multipart/form-data)

| Field | Description |
|---|---|
| `files` | one or more image/video files (repeat the field), order preserved |
| `packSize` | integer 5–10, default 10 (form field or query string) |
| `caption` | optional, ≤1024 chars, set on the first item of every pack |

Success:

```json
{ "ok": true, "jobId": "…", "filesSent": 23, "packsSent": 3, "packSize": 10, "packs": [10, 10, 3] }
```

Errors return `{ "ok": false, "error": "…", "filesSent": n, "packsSent": n }`:
`400` bad input · `401` bad key · `413` too large · `415` unsupported type · `429` rate limited · `502` Telegram/network failure · `500` internal.

## 13. Authentication

Every `/api/send-media` request needs the `X-Internal-Key` header equal to `INTERNAL_API_KEY` (checked in constant time, before the upload is read). `/health` is public and reveals nothing sensitive.

## 14. File limits

Only JPEG, PNG, GIF, WebP images and MP4/MOV/WebM videos pass the content check (HEIC/AVIF are rejected with a clear message). Defaults: 50 MB per file, 100 files per request, images ≤10 MB (Telegram limit). The Worker adds its own per-request cap (95 MB by default).

## 15. Telegram limits

Albums hold 2–10 items; standard Bot API uploads allow 50 MB per file; photos 10 MB; captions 1024 characters; roughly 20 messages/minute per group and about 1 message/second per chat. On HTTP 429 the server waits `retry_after` seconds and retries up to `TELEGRAM_MAX_RETRIES` times (it gives up if the wait exceeds 120 s). Non-MP4 videos may be displayed as files by some Telegram clients.

## 16. Troubleshooting

| Problem | Likely cause |
|---|---|
| Server exits at startup | A required variable is missing/invalid; read the `[config]` message. |
| 401 Unauthorized | `INTERNAL_API_KEY` differs from the Worker's secret. |
| `chat not found` | Wrong `TELEGRAM_CHAT_ID`, or you haven't pressed *Start* / added the bot. |
| `bot is not a member…` / `not enough rights` | Add the bot to the group/channel as admin with posting rights. |
| `Unauthorized` from Telegram | Wrong or revoked `TELEGRAM_BOT_TOKEN`. |
| 413 | File or request above the limits in section 14. |
| 415 | Unsupported or mislabelled file (e.g. HEIC); convert it. |
| 429 | Telegram or local rate limit; increase `PACK_DELAY_MS`. |
| Worker shows "bot server unreachable" | Server down, firewall, plain HTTP on a non-standard port, or wrong `BOT_SERVER_URL`. |
| Timeouts through a proxy | Raise the proxy's body-size and timeout limits. |

## 17. Security

- The bot token and chat ID exist only in this server's environment variables. They are never returned or logged (errors are redacted).
- Run it behind HTTPS and keep `INTERNAL_API_KEY` long and random; rotate it by updating both sides.
- Rate limiting, content sniffing, size/count limits and temp-file cleanup are built in.
- This server is "private" by secrecy of its URL plus the key; Workers must be able to reach it over the internet. For stronger isolation use a firewall allow-list or Cloudflare Tunnel.
- If a token ever leaks, revoke it with @BotFather (`/revoke`) immediately.

## License

MIT
