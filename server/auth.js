const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { getDb } = require("./db");
const { getAllowedOrigins, getJwtSecret } = require("./env");

const BCRYPT_ROUNDS = 10;

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function verifyPassword(password, hash) {
  if (!password || !hash) return false;
  return bcrypt.compare(password, hash);
}

function signRoomToken({ roomId, participantId, name, expiresAt }) {
  const secret = getJwtSecret();
  const maxLifetimeSec = 4 * 60 * 60;
  const remainingSec = expiresAt
    ? Math.max(60, Math.floor((expiresAt - Date.now()) / 1000))
    : maxLifetimeSec;
  const expiresIn = Math.min(remainingSec, maxLifetimeSec);

  return jwt.sign(
    {
      roomId,
      participantId,
      name,
    },
    secret,
    {
      algorithm: "HS256",
      expiresIn,
    },
  );
}

function verifyRoomToken(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const payload = jwt.verify(token, getJwtSecret(), {
      algorithms: ["HS256"],
    });
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof payload.roomId !== "string" ||
      typeof payload.participantId !== "string" ||
      typeof payload.name !== "string"
    ) {
      return null;
    }
    return {
      roomId: payload.roomId,
      participantId: payload.participantId,
      name: payload.name,
      exp: typeof payload.exp === "number" ? payload.exp : undefined,
    };
  } catch {
    return null;
  }
}

function checkRateLimit({ key, maxAttempts, windowMs, lockoutMs = 0, increment = true }) {
  const db = getDb();
  const now = Date.now();
  const row = db
    .prepare(`SELECT count, reset_at, locked_until FROM rate_limits WHERE key = ?`)
    .get(key);

  if (row && row.locked_until > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((row.locked_until - now) / 1000)),
      remaining: 0,
    };
  }

  let count = row && row.reset_at > now ? row.count : 0;
  let resetAt = row && row.reset_at > now ? row.reset_at : now + windowMs;

  if (increment) {
    count += 1;
    if (count > maxAttempts) {
      const lockedUntil = lockoutMs > 0 ? now + lockoutMs : resetAt;
      db.prepare(
        `INSERT OR REPLACE INTO rate_limits (key, count, reset_at, locked_until) VALUES (?, ?, ?, ?)`,
      ).run(key, count, Math.max(resetAt, lockedUntil), lockedUntil);

      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil - now) / 1000)),
        remaining: 0,
      };
    }

    db.prepare(
      `INSERT OR REPLACE INTO rate_limits (key, count, reset_at, locked_until) VALUES (?, ?, ?, 0)`,
    ).run(key, count, resetAt);
  }

  return {
    allowed: true,
    retryAfterSeconds: 0,
    remaining: Math.max(0, maxAttempts - count),
  };
}

function clearRateLimit(key) {
  const db = getDb();
  db.prepare(`DELETE FROM rate_limits WHERE key = ?`).run(key);
}

function extractClientIp(request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "local";
}

function extractBearerToken(request) {
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

function isAllowedOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // Non-browser / server-to-server requests without Origin header

  const allowed = getAllowedOrigins();
  if (allowed.includes(origin)) return true;

  const host = request.headers.get("host");
  if (host) {
    try {
      const parsed = new URL(origin);
      if (parsed.host === host) return true;
    } catch {
      return false;
    }
  }
  return false;
}

module.exports = {
  hashPassword,
  verifyPassword,
  signRoomToken,
  verifyRoomToken,
  checkRateLimit,
  clearRateLimit,
  extractClientIp,
  extractBearerToken,
  isAllowedOrigin,
};
