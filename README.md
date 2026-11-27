# Interview Room

A self-hosted peer-to-peer technical interview platform built with Next.js, Socket.IO, WebRTC, Yjs CRDT, Monaco Editor, SQLite, and Judge0 sandboxed code execution.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. Create a password-protected room and share its link and password with the second participant (max 2 participants per room). Camera and microphone access require `localhost` or HTTPS.

The Next.js app runs on port `3000`; the Socket.IO signaling & Yjs CRDT server runs on port `3001`.

## Self-hosted HTTPS/WSS + TURN Deployment

For non-localhost deployments over HTTPS/WSS:

1. Copy `.env.example` to `.env.local` and set strong `JWT_SECRET`, `WEB_ORIGIN=https://your-domain`, `NEXT_PUBLIC_SIGNALING_URL=https://your-domain`, and your `JUDGE0_URL`.
2. Update `turnserver.conf` credentials and `NEXT_PUBLIC_TURN_*` variables if deploying behind restrictive NATs.
3. Start the stack with Caddy TLS/WSS reverse proxy + Coturn:

```bash
docker compose up -d --build
```

## Environment

| Variable | Purpose | Default |
| --- | --- | --- |
| `SIGNALING_PORT` | Signaling & Yjs server port | `3001` |
| `WEB_ORIGIN` | Comma-separated allowed web origins | `http://localhost:3000` |
| `NEXT_PUBLIC_SIGNALING_URL` | Signaling server URL used by the browser | `http://localhost:3001` |
| `JWT_SECRET` | Secret for signing short-lived room JWTs (required in prod) | Auto-generated dev secret in `data/.jwt-secret` |
| `DATABASE_PATH` | SQLite database file path | `./data/interview-room.db` |
| `ROOM_TTL_MINUTES` | Room expiration lifetime in minutes | `120` |
| `REPORT_RETENTION_HOURS` | Hours to retain ended/expired room data before GC purge | `24` |
| `NEXT_PUBLIC_TURN_URL` | Optional TURN server URL for restrictive networks | Not set |
| `NEXT_PUBLIC_TURN_USERNAME` | Optional TURN username | Not set |
| `NEXT_PUBLIC_TURN_CREDENTIAL` | Optional TURN credential | Not set |
| `JUDGE0_URL` | Server-side Judge0 base URL (e.g. `https://<ip>/judge0`) | `http://localhost:2358` |
| `JUDGE0_ALLOW_SELF_SIGNED` | Set `"true"` if `JUDGE0_URL` uses a self-signed TLS certificate | `false` |
| `JUDGE0_AUTH_TOKEN` | Optional `X-Auth-Token` header for Judge0 | Not set |
