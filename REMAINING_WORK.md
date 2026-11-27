# Remaining Work & Implementation Roadmap

**Project:** A Real-Time Collaborative Platform for Peer-to-Peer Technical Interviews with CRDT-Based Code Editing, Isolated Sandboxed Execution, and Session Integrity Monitoring

This document maps the current codebase against the **Minor-Project Synopsis** and details everything remaining to complete the platform.

---

## 1. Current Baseline (Already Implemented)

| Module | Current Status | Implemented Files |
| :--- | :--- | :--- |
| **WebRTC Audio/Video** | Working (v1) | [app/room/[roomId]/page.tsx](app/room/%5BroomId%5D/page.tsx), [server/signaling-server.js](server/signaling-server.js) |
| **CRDT Collaborative Editor (Yjs + Monaco)** | Working | [components/CollaborativeEditor.tsx](components/CollaborativeEditor.tsx), [lib/y-monaco-binding.ts](lib/y-monaco-binding.ts), [lib/yjs-socket-provider.ts](lib/yjs-socket-provider.ts), [server/yjs-rooms.js](server/yjs-rooms.js) |
| **Sandboxed Code Execution (Judge0)** | Working | [app/api/execute/route.ts](app/api/execute/route.ts), [lib/judge0.ts](lib/judge0.ts), [lib/languages.ts](lib/languages.ts), [components/ExecutionPanel.tsx](components/ExecutionPanel.tsx) |

**What works today:**
* Create/join a room via UUID link (`roomId`) and display name (`sessionStorage`).
* Peer-to-peer WebRTC audio/video with STUN + optional TURN env support, mic/camera toggles, and editor-only fallback when media devices are unavailable.
* Real-time Yjs CRDT collaborative Monaco Editor with self-hosted assets (`/monaco/vs`), per-user colored selections/carets/name badges, synced language selector (8 languages), and synced `stdin` + full Judge0 terminal output (`stdout`, `stderr`, `compileOutput`, exit code, time, memory).

---

## 2. Remaining Work (By Module)

### A. Room & Access Control + Persistence *(Synopsis Module 4 & Data Layer)*

Currently, rooms exist only in memory (`Map` in `server/signaling-server.js` and `server/yjs-rooms.js`), anyone with the `roomId` URL can join without a password, and there is no participant cap or session persistence.

1. **Session Database Layer**
   * Add a lightweight persistent database (e.g., SQLite via `better-sqlite3` / Prisma, or PostgreSQL) to persist:
     * `rooms`: `id`, `password_hash`, `created_at`, `expires_at`, `ended_at`, `status` (`active` | `ended` | `expired`), `language`, `code_snapshot` (and/or Yjs binary state `yjs_state`).
     * `integrity_events`: `id`, `room_id`, `participant_name`, `participant_id`, `event_type`, `metadata` (JSON), `created_at`.
     * `execution_logs`: `id`, `room_id`, `ran_by`, `language`, `status_description`, `time_sec`, `memory_kb`, `created_at`.

2. **Password-Protected Room Creation & Join APIs**
   * `POST /api/rooms`: Generate cryptographically random, non-sequential `roomId` server-side; require a room password; salt and hash it with **Argon2id** (`argon2`) or **bcrypt** (`bcryptjs`) before storing.
   * `POST /api/rooms/join`: Verify `roomId` + password against the stored hash; reject expired/ended rooms.
   * Update [app/page.tsx](app/page.tsx) to include password fields for both **Create a room** and **Join room**.
   * Update [app/room/[roomId]/page.tsx](app/room/%5BroomId%5D/page.tsx) to prompt for the room password + display name when someone opens a shared `/room/<roomId>` link directly without a valid session token.

3. **Two-Participant Room Cap**
   * Enforce a strict maximum of **2 active participants** per room in both `POST /api/rooms/join` and `room:join` inside [server/signaling-server.js](server/signaling-server.js) (returning a clear error if a 3rd participant attempts to join).

4. **Short-Lived Signed JWT Authorization**
   * Upon successful password verification, issue a signed short-lived **JWT** (`roomId`, `participantId`, `name`, `exp`).
   * Verify the JWT in:
     * Socket.IO connection/handshake middleware (`io.use(...)`) before allowing `room:join`, `room:signal`, `yjs:*`, or `code:*` events.
     * `POST /api/execute` (so unauthenticated users outside a room cannot execute code on your Judge0 server).
     * Integrity and report API routes.

5. **Brute-Force Rate Limiting & Temporary Lockout**
   * Track failed password attempts by `(ip, roomId)` (and globally per IP).
   * Enforce temporary lockout (e.g., 5 failed attempts → 5–15 minute cooldown returning `429 Too Many Requests`).

6. **Room TTL, End-Session Action & Garbage Collection**
   * Give every room a configurable TTL (`ROOM_TTL_MINUTES`).
   * Add an **"End Session"** button in the room header that saves the final code snapshot, transitions the room to `ended`, and redirects participants to the post-session report.
   * Run periodic garbage collection to close expired rooms, clean up in-memory `Y.Doc` instances, and purge data past the configured retention period (`REPORT_RETENTION_HOURS`).

---

### B. Session Integrity Monitoring *(Synopsis Module 5)*

Currently unimplemented. Must passively log indicators without blocking legitimate interviewer/candidate actions and without recording keystrokes, webcam video, or screen contents.

1. **Browser Integrity Listeners (`lib/integrity-monitor.ts` / React hook)**
   * **Tab / Window Focus Loss:** Listen to `document.visibilitychange`, `window.blur`, and `window.focus`. Record `tab_hidden` / `window_blur` and `focus_restored` events with exact `durationMs`. Apply a configurable minimum threshold (e.g., ignore < `1000ms` accidental clicks).
   * **Abnormally Large Paste Detection:** Hook Monaco's `editor.onDidPaste` and the `stdin` textarea's `onPaste`. Check pasted character count and line count against configurable thresholds (e.g., `LARGE_PASTE_MIN_CHARS=80` or `LARGE_PASTE_MIN_LINES=4`). Log only metadata (`charCount`, `lineCount`, target area, timestamp) — **never block pasting** and **never store full keystroke logs**.
   * **Clipboard / DevTools / Multi-Window Signals (optional):** Optionally log copy/cut spikes if configured, keeping privacy guarantees intact.

2. **Backend Integrity Event Pipeline**
   * Endpoint `POST /api/rooms/[roomId]/integrity` (or authenticated Socket.IO event `integrity:event` persisted by the backend).
   * Server-side timestamping, schema validation, per-session event rate limiting, and persistence to `integrity_events`.
   * Display a transparent status pill in the room UI (e.g. `Integrity monitoring active`) so both participants are aware.

---

### C. Session Report Module *(Synopsis Module 7)*

Currently unimplemented.

1. **Report Generation API (`GET /api/rooms/[roomId]/report`)**
   * Access-controlled via the room's participant JWT (only participants of that room can access it).
   * Compiles:
     * Session metadata (room ID, start/end timestamps, duration, participants, active language).
     * Integrity summary metrics (total tab/window switches, total unfocused duration, longest away duration, large paste count, largest paste size).
     * Chronological integrity event timeline.
     * Execution history summary (run count, statuses).
     * **Final code snapshot** (saved from `Y.Doc` on session end or periodic autosave).

2. **Post-Session Report UI (`app/room/[roomId]/report/page.tsx`)**
   * Dashboard cards summarizing integrity indicators and execution stats.
   * Timeline table of logged integrity events with participant labels and timestamps.
   * Read-only syntax-highlighted viewer for the final code snapshot.
   * Export / print-friendly view (JSON export + browser print-to-PDF).

3. **Retention & Auto-Purge**
   * Automatically delete report, integrity logs, and snapshots once `REPORT_RETENTION_HOURS` expires.

---

### D. Sandbox Hardening & Security Perimeter *(Synopsis Modules 2 & 6)*

1. **Execution Sandbox Hardening & Policy Alignment**
   * **Rate Limiting on `/api/execute`:** Limit execution frequency per participant/room (e.g., max 15 runs/minute) to prevent sandbox DoS.
   * **Explicit Judge0 Resource & Output Caps in [lib/judge0.ts](lib/judge0.ts):**
     * Add `enable_network: false`, `max_processes_and_or_threads`, and `max_file_size` to the Judge0 submission payload.
     * Truncate oversized `stdout` / `stderr` / `compileOutput` beyond a configured byte cap before returning or storing.
   * **Synopsis Alignment (Judge0 vs. Piston):** Your synopsis specifically mentions *Dockerized Piston*, whereas the current implementation uses your hosted *Judge0* instance (which uses `isolate` cgroup/namespace/no-network sandboxing). Either:
     * Document Judge0 + its `isolate` security configuration in the final report & provide a self-hosted `docker-compose.yml` for Judge0, **or**
     * Implement an interchangeable Piston execution adapter if your guide requires Piston specifically.

2. **Transport Security & Network Perimeter (HTTPS / WSS / TURN)**
   * Reverse proxy setup (Nginx or Caddy) terminating **HTTPS** and **WSS** for both Next.js (`3000`) and Socket.IO/Yjs (`3001`) so `getUserMedia`, WebRTC signalling, Yjs sync, passwords, and JWTs are encrypted in transit on non-localhost deployments.
   * Enforce strict origin validation (`WEB_ORIGIN`) across Next.js API routes as well as Socket.IO.
   * Provision and document a self-hosted **TURN server** (`coturn`) via `NEXT_PUBLIC_TURN_*` for restrictive NATs/college/corporate Wi-Fi networks.

---

### E. Persistence, UX Polish, Testing & Deployment

1. **Yjs State Persistence Across Server Restarts**
   * Periodically snapshot `Y.encodeStateAsUpdate(doc)` to the DB and reload it in [server/yjs-rooms.js](server/yjs-rooms.js) if the backend restarts mid-interview.
2. **UI/UX Enhancements**
   * Add a collapsible **Problem / Notes** scratchpad (synced via a separate `Y.Text("notes")` in `Y.Doc`) so the interviewer can paste the question without cluttering the code file.
   * Add a **"Reset Code"** button (with confirmation) to restore the active language's starter template.
   * Add a collapsible execution history drawer or inline run indicator.
3. **Automated Testing Suite**
   * Auth & access control tests (Argon2/bcrypt verification, brute-force lockout, 2-user room limit, JWT expiry/rejection).
   * Integrity logger unit & API tests (threshold filtering, privacy: no keystrokes stored).
   * Report API tests (participant-only access control, retention purge).
   * End-to-end 2-browser Playwright verification (room creation with password → join → WebRTC connection → concurrent Yjs editing & cursor presence → Judge0 execution → tab-switch/paste logging → End Session → post-session report).
4. **Self-Hosted Deployment Packaging**
   * Add `Dockerfile` + `docker-compose.yml` orchestrating Next.js, Socket.IO/Yjs server, database, Judge0/Piston, `coturn`, and Caddy/Nginx reverse proxy.
   * Add environment validation on startup so missing `JWT_SECRET`, `JUDGE0_URL`, or `DATABASE_URL` fail fast with clear messages.

---

## 3. Recommended Execution Order

1. **Phase 1 — Auth, Room Cap & Persistence:** Database schema + Argon2/bcrypt room passwords + 2-participant cap + JWT auth + brute-force rate limiting + room TTL.
2. **Phase 2 — Integrity Monitoring & Session Reports:** Tab-switch/paste listeners + `/integrity` persistence + End Session flow + `/room/[roomId]/report` UI + retention purge.
3. **Phase 3 — Security Hardening & Deployment:** `/api/execute` rate limiting & output truncation + Judge0/Piston Docker Compose + HTTPS/WSS reverse proxy + TURN setup.
4. **Phase 4 — Automated Tests & Final Report Alignment:** Automated E2E tests + aligning final project report diagrams/text with the final stack.
