"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { saveStoredRoomAuth } from "@/lib/room-auth-storage";

function getRoomId(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/\/room\/([^/?#]+)/);
  return match ? match[1] : trimmed;
}

interface RoomAuthResponse {
  ok?: boolean;
  roomId?: string;
  participantId?: string;
  name?: string;
  token?: string;
  expiresAt?: number;
  error?: string;
}

export default function Home() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [joinPassword, setJoinPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [busyAction, setBusyAction] = useState<"create" | "join" | null>(null);
  const [error, setError] = useState("");

  async function createRoom() {
    const participantName = name.trim();
    if (!participantName) {
      setError("Enter your name to continue.");
      return;
    }
    if (createPassword.length < 4) {
      setError("Enter a room password (at least 4 characters).");
      return;
    }
    if (!window.isSecureContext) {
      setError("Camera and microphone access requires HTTPS or localhost.");
      return;
    }

    setBusyAction("create");
    setError("");
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: participantName,
          password: createPassword,
        }),
      });
      const data = (await response.json()) as RoomAuthResponse;
      if (!response.ok || !data.ok || !data.roomId || !data.token || !data.participantId || !data.expiresAt) {
        setError(data.error || "Could not create room.");
        return;
      }

      saveStoredRoomAuth({
        roomId: data.roomId,
        token: data.token,
        participantId: data.participantId,
        name: data.name || participantName,
        expiresAt: data.expiresAt,
      });
      router.push(`/room/${encodeURIComponent(data.roomId)}`);
    } catch {
      setError("Network error while creating the room.");
    } finally {
      setBusyAction(null);
    }
  }

  async function enterRoom(event: FormEvent<HTMLFormElement>) {
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
    if (!joinPassword) {
      setError("Enter the room password.");
      return;
    }

    setBusyAction("join");
    setError("");
    try {
      const response = await fetch("/api/rooms/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId,
          name: participantName,
          password: joinPassword,
        }),
      });
      const data = (await response.json()) as RoomAuthResponse;
      if (!response.ok || !data.ok || !data.token || !data.participantId || !data.expiresAt) {
        setError(data.error || "Could not join room.");
        return;
      }

      saveStoredRoomAuth({
        roomId,
        token: data.token,
        participantId: data.participantId,
        name: data.name || participantName,
        expiresAt: data.expiresAt,
      });
      router.push(`/room/${encodeURIComponent(roomId)}`);
    } catch {
      setError("Network error while joining the room.");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <main className="landing">
      <section className="panel landing-panel">
        <p className="eyebrow">INTERVIEW ROOM</p>
        <h1>Meet, code, and run.</h1>
        <p className="muted">
          Create a password-protected 2-person interview room or join with an invite link.
        </p>

        <form onSubmit={(e) => void enterRoom(e)} className="room-form">
          <div className="form-header-row">
            <label htmlFor="name">Your name</label>
            <button
              type="button"
              className="io-link-button"
              onClick={() => setShowPasswords((v) => !v)}
            >
              {showPasswords ? "Hide passwords" : "Show passwords"}
            </button>
          </div>
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

          <label htmlFor="create-password">Set password for a new room</label>
          <input
            id="create-password"
            type={showPasswords ? "text" : "password"}
            autoComplete="new-password"
            maxLength={128}
            placeholder="Minimum 4 characters"
            value={createPassword}
            onChange={(event) => {
              setCreatePassword(event.target.value);
              setError("");
            }}
          />
          <button
            type="button"
            className="primary-button"
            disabled={busyAction !== null}
            onClick={() => void createRoom()}
          >
            {busyAction === "create" ? "Creating room…" : "Create private room"}
          </button>

          <div className="divider">
            <span>or join an existing room</span>
          </div>

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

          <label htmlFor="join-password">Room password</label>
          <input
            id="join-password"
            type={showPasswords ? "text" : "password"}
            autoComplete="current-password"
            maxLength={128}
            placeholder="Enter the shared room password"
            value={joinPassword}
            onChange={(event) => {
              setJoinPassword(event.target.value);
              setError("");
            }}
          />

          <button
            type="submit"
            className="secondary-button"
            disabled={busyAction !== null}
          >
            {busyAction === "join" ? "Joining room…" : "Join room"}
          </button>

          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
        </form>
      </section>
    </main>
  );
}
