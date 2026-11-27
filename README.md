# Interview Room

A minimal multi-participant video interview app built with Next.js, Socket.IO, and WebRTC.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. Create a room and share its URL with other participants. Camera and microphone access are required. Use localhost or HTTPS.

The Next.js app runs on port `3000`; the Socket.IO signaling server runs on port `3001`.

## Environment

| Variable | Purpose | Default |
| --- | --- | --- |
| `SIGNALING_PORT` | Signaling server port | `3001` |
| `WEB_ORIGIN` | Comma-separated allowed web origins | `http://localhost:3000` |
| `NEXT_PUBLIC_SIGNALING_URL` | Signaling server URL used by the browser | `http://localhost:3001` |
| `NEXT_PUBLIC_TURN_URL` | Optional TURN server URL for restrictive networks | Not set |
| `NEXT_PUBLIC_TURN_USERNAME` | Optional TURN username | Not set |
| `NEXT_PUBLIC_TURN_CREDENTIAL` | Optional TURN credential | Not set |

WebRTC media is peer-to-peer. A TURN service is recommended for reliable connections across restrictive NATs and firewalls. Group calls use a peer mesh, so each participant connects directly to every other participant.
