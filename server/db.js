const { DatabaseSync } = require("node:sqlite");
const { getDataDir, getReportRetentionMs } = require("./env");

let dbInstance = null;

function getDb() {
  if (dbInstance) return dbInstance;

  const { dbPath } = getDataDir();
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ended_at INTEGER,
      language TEXT NOT NULL DEFAULT 'python',
      code_snapshot TEXT NOT NULL DEFAULT '',
      yjs_state TEXT
    );

    CREATE TABLE IF NOT EXISTS active_participants (
      socket_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      participant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      joined_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS execution_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      ran_by TEXT NOT NULL,
      language TEXT NOT NULL,
      status_description TEXT NOT NULL,
      exit_code INTEGER,
      time_sec TEXT,
      memory_kb INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS integrity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      participant_id TEXT NOT NULL,
      participant_name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      reset_at INTEGER NOT NULL,
      locked_until INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_rooms_expires ON rooms(expires_at);
    CREATE INDEX IF NOT EXISTS idx_participants_room ON active_participants(room_id);
    CREATE INDEX IF NOT EXISTS idx_exec_room ON execution_logs(room_id);
  `);

  dbInstance = db;
  return db;
}

function createRoom({ id, passwordHash, expiresAt, language = "python" }) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO rooms (id, password_hash, status, created_at, expires_at, language, code_snapshot)
     VALUES (?, ?, 'active', ?, ?, ?, '')`,
  ).run(id, passwordHash, now, expiresAt, language);
  return getRoomById(id);
}

function getRoomById(roomId) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, password_hash, status, created_at, expires_at, ended_at, language, code_snapshot, yjs_state
       FROM rooms WHERE id = ?`,
    )
    .get(roomId);

  if (!row) return null;

  if (row.status === "active" && row.expires_at <= Date.now()) {
    db.prepare(
      `UPDATE rooms SET status = 'expired', ended_at = COALESCE(ended_at, ?) WHERE id = ? AND status = 'active'`,
    ).run(row.expires_at, roomId);
    row.status = "expired";
    row.ended_at = row.ended_at || row.expires_at;
  }

  return row;
}

function saveRoomYjsState(roomId, { yjsStateBase64, codeSnapshot, language }) {
  const db = getDb();
  db.prepare(
    `UPDATE rooms
     SET yjs_state = COALESCE(?, yjs_state),
         code_snapshot = COALESCE(?, code_snapshot),
         language = COALESCE(?, language)
     WHERE id = ?`,
  ).run(yjsStateBase64 ?? null, codeSnapshot ?? null, language ?? null, roomId);
}

function endRoom(roomId, { codeSnapshot, language, yjsStateBase64 } = {}) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `UPDATE rooms
     SET status = 'ended',
         ended_at = COALESCE(ended_at, ?),
         code_snapshot = COALESCE(?, code_snapshot),
         language = COALESCE(?, language),
         yjs_state = COALESCE(?, yjs_state)
     WHERE id = ?`,
  ).run(
    now,
    codeSnapshot ?? null,
    language ?? null,
    yjsStateBase64 ?? null,
    roomId,
  );
  db.prepare(`DELETE FROM active_participants WHERE room_id = ?`).run(roomId);
  return getRoomById(roomId);
}

function getActiveParticipantCount(roomId) {
  const db = getDb();
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM active_participants WHERE room_id = ?`)
    .get(roomId);
  return Number(row?.count || 0);
}

function registerActiveParticipant({ socketId, roomId, participantId, name }) {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO active_participants (socket_id, room_id, participant_id, name, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(socketId, roomId, participantId, name, Date.now());
}

function unregisterActiveParticipant(socketId) {
  const db = getDb();
  db.prepare(`DELETE FROM active_participants WHERE socket_id = ?`).run(socketId);
}

function clearAllActiveParticipants() {
  const db = getDb();
  db.prepare(`DELETE FROM active_participants`).run();
}

function logExecution({
  roomId,
  ranBy,
  language,
  statusDescription,
  exitCode,
  timeSec,
  memoryKb,
}) {
  const db = getDb();
  db.prepare(
    `INSERT INTO execution_logs (room_id, ran_by, language, status_description, exit_code, time_sec, memory_kb, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    roomId,
    ranBy,
    language,
    statusDescription,
    exitCode ?? null,
    timeSec ?? null,
    memoryKb ?? null,
    Date.now(),
  );
}

function cleanupExpiredRooms() {
  const db = getDb();
  const now = Date.now();
  const retentionMs = getReportRetentionMs();

  const expiredRows = db
    .prepare(`SELECT id FROM rooms WHERE status = 'active' AND expires_at <= ?`)
    .all(now);

  if (expiredRows.length > 0) {
    db.prepare(
      `UPDATE rooms SET status = 'expired', ended_at = COALESCE(ended_at, expires_at)
       WHERE status = 'active' AND expires_at <= ?`,
    ).run(now);
    for (const row of expiredRows) {
      db.prepare(`DELETE FROM active_participants WHERE room_id = ?`).run(row.id);
    }
  }

  const purgeCutoff = now - retentionMs;
  db.prepare(
    `DELETE FROM rooms WHERE status IN ('ended', 'expired') AND COALESCE(ended_at, expires_at) <= ?`,
  ).run(purgeCutoff);
  db.prepare(`DELETE FROM rate_limits WHERE reset_at <= ? AND locked_until <= ?`).run(
    now,
    now,
  );

  return expiredRows.map((row) => row.id);
}

module.exports = {
  getDb,
  createRoom,
  getRoomById,
  saveRoomYjsState,
  endRoom,
  getActiveParticipantCount,
  registerActiveParticipant,
  unregisterActiveParticipant,
  clearAllActiveParticipants,
  logExecution,
  cleanupExpiredRooms,
};
