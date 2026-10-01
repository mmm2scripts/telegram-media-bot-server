import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */
const env = process.env;
const die = (msg) => { console.error(`[config] ${msg}`); process.exit(1); };
const intEnv = (name, def, min, max) => {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) die(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  return n;
};

const PORT = intEnv("PORT", 8080, 1, 65535);
const MAX_FILE_SIZE_MB = intEnv("MAX_FILE_SIZE_MB", 50, 1, 2000);
const MAX_FILES = intEnv("MAX_FILES", 100, 1, 1000);
const PACK_DELAY_MS = intEnv("PACK_DELAY_MS", 1500, 0, 600000);
const RATE_LIMIT_PER_MINUTE = intEnv("RATE_LIMIT_PER_MINUTE", 60, 1, 100000);
const TELEGRAM_MAX_RETRIES = intEnv("TELEGRAM_MAX_RETRIES", 5, 0, 20);
const TOKEN = (env.TELEGRAM_BOT_TOKEN || "").trim();
const CHAT_ID = (env.TELEGRAM_CHAT_ID || "").trim();
const INTERNAL_API_KEY = (env.INTERNAL_API_KEY || "").trim();
const API_BASE = (env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");

if (!TOKEN) die("TELEGRAM_BOT_TOKEN is not set");
if (!CHAT_ID) die("TELEGRAM_CHAT_ID is not set");
if (INTERNAL_API_KEY.length < 16) die("INTERNAL_API_KEY must be set and at least 16 characters long");

const MB = 1024 * 1024;
const MIN_PACK = 5, MAX_PACK = 10, DEFAULT_PACK = 10;
const PHOTO_MAX_BYTES = 10 * MB;          // Telegram photo limit
const CAPTION_MAX = 1024;                 // Telegram caption limit
const MAX_RETRY_WAIT_S = 120;             // never wait longer than this for retry_after
const TELEGRAM_TIMEOUT_MS = 10 * 60 * 1000;
const UPLOAD_DIR = path.join(os.tmpdir(), "telegram-media-bot-server");

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const redact = (s) => String(s).split(TOKEN).join("***");
const log = (jobId, msg) => console.log(`${new Date().toISOString()} [${jobId}] ${redact(msg)}`);
const sha256 = (s) => crypto.createHash("sha256").update(s).digest();
const keyHash = sha256(INTERNAL_API_KEY);
const safeName = (n) => String(n).replace(/[^\w.\-()\[\] ]+/g, "_").slice(0, 80);
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

/** Identify a file by its first bytes (never trust the extension or client MIME type). */
function sniff(b) {
  if (b.length < 12) return null;
  const a = (s, e) => b.toString("latin1", s, e);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: "photo", ext: "jpg", mime: "image/jpeg" };
  if (b[0] === 0x89 && a(1, 4) === "PNG") return { kind: "photo", ext: "png", mime: "image/png" };
  if (a(0, 4) === "GIF8") return { kind: "photo", ext: "gif", mime: "image/gif" };
  if (a(0, 4) === "RIFF" && a(8, 12) === "WEBP") return { kind: "photo", ext: "webp", mime: "image/webp" };
  if (a(4, 8) === "ftyp") {
    const brand = a(8, 12);
    if (["heic", "heix", "hevx", "heim", "heis", "mif1", "msf1", "avif", "avis"].includes(brand)) {
      return { unsupported: "HEIC/AVIF images are not supported by Telegram. Convert them to JPEG or PNG." };
    }
    return brand === "qt  " ? { kind: "video", ext: "mov", mime: "video/quicktime" } : { kind: "video", ext: "mp4", mime: "video/mp4" };
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: "video", ext: "webm", mime: "video/webm" };
  return null;
}

async function readHead(file) {
  const fh = await fsp.open(file, "r");
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

/* ------------------------------------------------------------------ */
/* Telegram                                                            */
/* ------------------------------------------------------------------ */
async function telegramCall(method, buildForm, jobId) {
  const url = `${API_BASE}/bot${TOKEN}/${method}`;
  let attempt = 0;
  for (;;) {
    let res, data;
    try {
      res = await fetch(url, { method: "POST", body: await buildForm(), signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS) });
      data = await res.json().catch(() => null);
    } catch (err) {
      if (attempt < TELEGRAM_MAX_RETRIES) {
        attempt++;
        const wait = Math.min(2000 * 2 ** attempt, 30000);
        log(jobId, `Network error talking to Telegram (${redact(err.cause?.code || err.message)}); retry ${attempt}/${TELEGRAM_MAX_RETRIES} in ${wait} ms`);
        await sleep(wait);
        continue;
      }
      throw new HttpError(502, `Could not reach Telegram: ${redact(err.cause?.code || err.message)}`);
    }
    if (res.ok && data?.ok) return data.result;

    const desc = data?.description || `HTTP ${res.status}`;
    const retryAfter = data?.parameters?.retry_after;
    if (res.status === 429 && Number.isFinite(retryAfter)) {
      if (retryAfter > MAX_RETRY_WAIT_S || attempt >= TELEGRAM_MAX_RETRIES) {
        throw new HttpError(429, `Telegram rate limit reached (retry after ${retryAfter}s).`, { retryAfter });
      }
      attempt++;
      log(jobId, `Telegram asked us to wait ${retryAfter}s; retry ${attempt}/${TELEGRAM_MAX_RETRIES}`);
      await sleep((retryAfter + 1) * 1000);
      continue;
    }
    if (res.status >= 500 && attempt < TELEGRAM_MAX_RETRIES) {
      attempt++;
      await sleep(Math.min(2000 * 2 ** attempt, 30000));
      continue;
    }
    throw new HttpError(502, `Telegram rejected the request: ${desc}`);
  }
}

async function sendPack(pack, caption, jobId) {
  if (pack.length === 1) {
    // sendMediaGroup requires 2–10 items, so a lone leftover file is sent on its own.
    const f = pack[0];
    const field = f.kind === "photo" ? "photo" : "video";
    return telegramCall(f.kind === "photo" ? "sendPhoto" : "sendVideo", async () => {
      const form = new FormData();
      form.append("chat_id", CHAT_ID);
      if (caption) form.append("caption", caption);
      if (f.kind === "video") form.append("supports_streaming", "true");
      form.append(field, await fs.openAsBlob(f.path, { type: f.mime }), `media_0.${f.ext}`);
      return form;
    }, jobId);
  }
  return telegramCall("sendMediaGroup", async () => {
    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    const media = [];
    for (const [i, f] of pack.entries()) {
      const name = `file${i}`;
      const item = { type: f.kind, media: `attach://${name}` };
      if (f.kind === "video") item.supports_streaming = true;
      if (i === 0 && caption) item.caption = caption;
      media.push(item);
      form.append(name, await fs.openAsBlob(f.path, { type: f.mime }), `media_${i}.${f.ext}`);
    }
    form.append("media", JSON.stringify(media));
    return form;
  }, jobId);
}

// One send job at a time, with PACK_DELAY_MS between consecutive packs (even across requests).
let queue = Promise.resolve();
let lastPackAt = 0;
const runExclusive = (task) => { const run = queue.then(task); queue = run.catch(() => {}); return run; };

async function sendAllPacks(packs, caption, jobId, progress) {
  for (const [i, pack] of packs.entries()) {
    const wait = lastPackAt + PACK_DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try { await sendPack(pack, caption, jobId); } finally { lastPackAt = Date.now(); }
    progress.packsSent += 1;
    progress.filesSent += pack.length;
    log(jobId, `Pack ${i + 1}/${packs.length} sent (${pack.length} files)`);
  }
}

/* ------------------------------------------------------------------ */
/* Express app                                                         */
/* ------------------------------------------------------------------ */
await fsp.rm(UPLOAD_DIR, { recursive: true, force: true });
await fsp.mkdir(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: MAX_FILE_SIZE_MB * MB, files: MAX_FILES, fields: 10, fieldSize: 8 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^(image|video)\//.test(file.mimetype)) return cb(null, true);
    cb(new HttpError(415, `"${safeName(file.originalname)}" is not an image or video.`));
  },
});

const app = express();
app.disable("x-powered-by");
if (env.TRUST_PROXY) app.set("trust proxy", env.TRUST_PROXY === "true" ? 1 : env.TRUST_PROXY);
app.use((_req, res, next) => {
  res.set({ "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
  next();
});

const limiter = rateLimit({
  windowMs: 60_000,
  limit: RATE_LIMIT_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ ok: false, error: "Too many requests. Slow down and retry shortly." }),
});

function requireKey(req, res, next) {
  const given = sha256(req.get("x-internal-key") || "");
  if (!crypto.timingSafeEqual(given, keyHash)) return res.status(401).json({ ok: false, error: "Unauthorized." });
  next();
}

app.get("/health", limiter, (_req, res) => {
  res.json({ ok: true, service: "telegram-media-bot-server", uptime: Math.round(process.uptime()) });
});

app.post("/api/send-media", limiter, requireKey, upload.array("files", MAX_FILES), async (req, res) => {
  const jobId = crypto.randomUUID();
  const files = req.files || [];
  const progress = { filesSent: 0, packsSent: 0 };
  try {
    if (!files.length) throw new HttpError(400, 'No files received. Send multipart/form-data with one or more "files" fields.');

    const packSize = Number(req.body?.packSize ?? req.query.packSize ?? DEFAULT_PACK);
    if (!Number.isInteger(packSize) || packSize < MIN_PACK || packSize > MAX_PACK) {
      throw new HttpError(400, `packSize must be an integer from ${MIN_PACK} to ${MAX_PACK}.`);
    }
    const caption = typeof req.body?.caption === "string" ? req.body.caption.trim() : "";
    if (caption.length > CAPTION_MAX) throw new HttpError(400, `Caption is longer than ${CAPTION_MAX} characters.`);

    const items = [];
    for (const f of files) {
      const t = sniff(await readHead(f.path));
      const label = `"${safeName(f.originalname)}"`;
      if (!t) throw new HttpError(415, `${label} is not a supported image or video (file content check failed).`);
      if (t.unsupported) throw new HttpError(415, `${label}: ${t.unsupported}`);
      if (t.kind === "photo" && f.size > PHOTO_MAX_BYTES) throw new HttpError(413, `${label} exceeds Telegram's 10 MB photo limit.`);
      items.push({ path: f.path, size: f.size, kind: t.kind, ext: t.ext, mime: t.mime });
    }

    const packs = chunk(items, packSize);
    log(jobId, `Job started: ${items.length} files, ${packs.length} packs of up to ${packSize}`);
    await runExclusive(() => sendAllPacks(packs, caption, jobId, progress));

    res.json({ ok: true, jobId, filesSent: progress.filesSent, packsSent: progress.packsSent, packSize, packs: packs.map((p) => p.length) });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) log(jobId, `Job failed: ${err.message}`);
    const message = err instanceof HttpError ? err.message : "Internal server error.";
    if (err.extra?.retryAfter) res.set("Retry-After", String(err.extra.retryAfter));
    res.status(status).json({ ok: false, jobId, error: message, ...progress });
  } finally {
    await Promise.all(files.map((f) => fsp.rm(f.path, { force: true })));
  }
});

app.use((_req, res) => res.status(404).json({ ok: false, error: "Not found." }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (res.headersSent) return;
  let status = 500, message = "Internal server error.";
  if (err instanceof multer.MulterError) {
    status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    message = err.code === "LIMIT_FILE_SIZE" ? `A file exceeds the ${MAX_FILE_SIZE_MB} MB limit.`
      : err.code === "LIMIT_FILE_COUNT" ? `Too many files (maximum ${MAX_FILES}).`
      : `Upload error: ${err.message}`;
  } else if (err instanceof HttpError) {
    status = err.status; message = err.message;
  } else if (/multipart|boundary|unexpected end of form/i.test(err?.message || "")) {
    status = 400; message = "Malformed multipart upload.";
  } else {
    console.error(redact(err?.stack || err));
  }
  res.status(status).json({ ok: false, error: message });
});

const server = app.listen(PORT, "0.0.0.0", () => console.log(`telegram-media-bot-server listening on :${PORT}`));
server.requestTimeout = 30 * 60 * 1000; // allow slow uploads of large packs
server.timeout = 0;

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
