const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

let envLoaded = false;
let cachedJwtSecret = null;

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf-8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

function loadEnv() {
  if (envLoaded) return;
  envLoaded = true;
  const root = process.cwd();
  // Match Next.js precedence: .env.local overrides .env, while existing process.env wins
  parseEnvFile(path.join(root, ".env.local"));
  parseEnvFile(path.join(root, ".env"));
}

function getDataDir() {
  loadEnv();
  const dbPath = process.env.DATABASE_PATH
    ? path.resolve(process.cwd(), process.env.DATABASE_PATH)
    : path.join(process.cwd(), "data", "interview-room.db");
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, dbPath };
}

function getJwtSecret() {
  loadEnv();
  if (cachedJwtSecret) return cachedJwtSecret;

  const envSecret = process.env.JWT_SECRET?.trim();
  if (envSecret) {
    if (envSecret.length < 16) {
      throw new Error("JWT_SECRET must be at least 16 characters long.");
    }
    cachedJwtSecret = envSecret;
    return cachedJwtSecret;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET environment variable is required in production.");
  }

  // Persist a random secret in data/.jwt-secret so Next.js and signaling server share it in dev
  const { dir } = getDataDir();
  const secretFile = path.join(dir, ".jwt-secret");
  try {
    if (fs.existsSync(secretFile)) {
      const existing = fs.readFileSync(secretFile, "utf-8").trim();
      if (existing.length >= 32) {
        cachedJwtSecret = existing;
        return cachedJwtSecret;
      }
    }
    const generated = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
    cachedJwtSecret = generated;
    return cachedJwtSecret;
  } catch {
    cachedJwtSecret = crypto.randomBytes(32).toString("hex");
    return cachedJwtSecret;
  }
}

function getRoomTtlMs() {
  loadEnv();
  const mins = Number(process.env.ROOM_TTL_MINUTES || 120);
  const clamped = Number.isFinite(mins) ? Math.min(Math.max(mins, 15), 1440) : 120;
  return clamped * 60 * 1000;
}

function getReportRetentionMs() {
  loadEnv();
  const hours = Number(process.env.REPORT_RETENTION_HOURS || 24);
  const clamped = Number.isFinite(hours) ? Math.min(Math.max(hours, 1), 720) : 24;
  return clamped * 60 * 60 * 1000;
}

function getAllowedOrigins() {
  loadEnv();
  return (process.env.WEB_ORIGIN || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

module.exports = {
  loadEnv,
  getDataDir,
  getJwtSecret,
  getRoomTtlMs,
  getReportRetentionMs,
  getAllowedOrigins,
};
