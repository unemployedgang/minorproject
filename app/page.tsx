"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

function getRoomId(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/\/room\/([^/?#]+)/);
  return match ? match[1] : trimmed;
}

export default function Home() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [error, setError] = useState("");

  function enterRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const participantName = name.trim();
    const roomId = getRoomId(roomCode);

    if (!participantName) {
      setError("Enter your name to continue.");
      return;
    }
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(roomId)) {
      setError("Enter a valid room code or room link.");
      return;
    }

    sessionStorage.setItem("interview-room-name", participantName);
    router.push(`/room/${encodeURIComponent(roomId)}`);
  }

  function createRoom() {
    if (!name.trim()) {
      setError("Enter your name to continue.");
      return;
    }
    if (!window.isSecureContext) {
      setError("Camera and microphone access requires HTTPS or localhost.");
      return;
    }

    const roomId = crypto.randomUUID();
    sessionStorage.setItem("interview-room-name", name.trim());
    router.push(`/room/${roomId}`);
  }

  return (
    <main className="landing">
      <section className="panel landing-panel">
        <p className="eyebrow">INTERVIEW ROOM</p>
        <h1>Meet face to face.</h1>
        <p className="muted">Create a room and share the link, or join an existing interview.</p>

        <form onSubmit={enterRoom} className="room-form">
          <label htmlFor="name">Your name</label>
          <input
            id="name"
            autoComplete="name"
            maxLength={60}
            placeholder="e.g. Alex"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError("");
            }}
          />

          <button type="button" className="primary-button" onClick={createRoom}>
            Create a room
          </button>

          <div className="divider"><span>or join one</span></div>

          <label htmlFor="room-code">Room code or link</label>
          <input
            id="room-code"
            autoComplete="off"
            placeholder="Paste a room code or link"
            value={roomCode}
            onChange={(event) => {
              setRoomCode(event.target.value);
              setError("");
            }}
          />
          <button type="submit" className="secondary-button">Join room</button>
          {error && <p className="error-message" role="alert">{error}</p>}
        </form>
      </section>
    </main>
  );
}
