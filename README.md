# Interview Room

A real-time peer-to-peer technical interview platform built with Next.js, Socket.IO, WebRTC, Yjs CRDT, Monaco Editor, and Judge0 sandboxed code execution.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. Create a room and share its link with the other participant. Camera and microphone access require `localhost` or HTTPS.

The Next.js app runs on port `3000`; the Socket.IO signaling & Yjs CRDT server runs on port `3001`.

## Environment

Copy `.env.example` to `.env.local` and configure as needed:

| Variable | Purpose | Default |
| --- | --- | --- |
| `SIGNALING_PORT` | Signaling & Yjs server port | `3001` |
| `WEB_ORIGIN` | Comma-separated allowed web origins | `http://localhost:3000` |
| `NEXT_PUBLIC_SIGNALING_URL` | Signaling server URL used by the browser | `http://localhost:3001` |
| `NEXT_PUBLIC_TURN_URL` | Optional TURN server URL for restrictive networks | Not set |
| `NEXT_PUBLIC_TURN_USERNAME` | Optional TURN username | Not set |
| `NEXT_PUBLIC_TURN_CREDENTIAL` | Optional TURN credential | Not set |
| `JUDGE0_URL` | Server-side Judge0 base URL (e.g. `https://<ip>/judge0`) | `http://localhost:2358` |
| `JUDGE0_ALLOW_SELF_SIGNED` | Set `"true"` if `JUDGE0_URL` uses a self-signed TLS certificate | `false` |
| `JUDGE0_AUTH_TOKEN` | Optional `X-Auth-Token` header for Judge0 | Not set |
