"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { io, Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  JoinResponse,
  Participant,
  ServerToClientEvents,
  Signal,
} from "@/types/signaling";

type PeerConnection = RTCPeerConnection;
type RoomSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  ...(process.env.NEXT_PUBLIC_TURN_URL
    ? [{
        urls: process.env.NEXT_PUBLIC_TURN_URL,
        username: process.env.NEXT_PUBLIC_TURN_USERNAME,
        credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
      }]
    : []),
];

export default function RoomPage() {
  const params = useParams<{ roomId: string }>();
  const router = useRouter();
  const roomId = useMemo(() => decodeURIComponent(params.roomId), [params.roomId]);
  const [name, setName] = useState("Guest");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [myId, setMyId] = useState("");
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState("Requesting camera and microphone…");
  const [error, setError] = useState("");
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const socketRef = useRef<RoomSocket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnections = useRef(new Map<string, PeerConnection>());
  const peerStreams = useRef(new Map<string, MediaStream>());
  const pendingCandidates = useRef(new Map<string, RTCIceCandidateInit[]>());

  const closePeers = useCallback(() => {
    for (const connection of peerConnections.current.values()) connection.close();
    peerConnections.current.clear();
    peerStreams.current.clear();
    pendingCandidates.current.clear();
    setRemoteStreams({});
  }, []);

  const sendSignal = useCallback((targetId: string, signal: Signal) => {
    socketRef.current?.emit("room:signal", { targetId, signal });
  }, []);

  const makePeerConnection = useCallback((peer: Participant) => {
    const existing = peerConnections.current.get(peer.id);
    if (existing) return existing;

    const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peerConnections.current.set(peer.id, connection);

    const localStream = localStreamRef.current;
    for (const track of localStream?.getTracks() ?? []) {
      if (localStream) connection.addTrack(track, localStream);
    }

    connection.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(peer.id, { type: "candidate", candidate: event.candidate.toJSON() });
      }
    };
    connection.ontrack = (event) => {
      const stream =
        peerStreams.current.get(peer.id) ??
        event.streams[0] ??
        new MediaStream();
      if (!stream.getTracks().some((track) => track.id === event.track.id)) {
        stream.addTrack(event.track);
      }
      peerStreams.current.set(peer.id, stream);
      setRemoteStreams((current) => ({ ...current, [peer.id]: stream }));
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "failed") {
        setError(`Connection to ${peer.name} failed. Check your network and try rejoining.`);
      }
    };

    return connection;
  }, [sendSignal]);

  const handleSignal = useCallback(async (message: {
    fromId: string;
    fromName: string;
    signal: Signal;
  }) => {
    const peer = {
      id: message.fromId,
      name: message.fromName,
    };
    const connection = makePeerConnection(peer);

    if (message.signal.type === "candidate") {
      if (connection.remoteDescription) {
        await connection.addIceCandidate(message.signal.candidate);
      } else {
        const queued = pendingCandidates.current.get(peer.id) ?? [];
        queued.push(message.signal.candidate);
        pendingCandidates.current.set(peer.id, queued);
      }
      return;
    }

    await connection.setRemoteDescription(message.signal.description);
    const queued = pendingCandidates.current.get(peer.id) ?? [];
    pendingCandidates.current.delete(peer.id);
    for (const candidate of queued) await connection.addIceCandidate(candidate);

    if (message.signal.description.type === "offer") {
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      if (connection.localDescription) {
        sendSignal(peer.id, {
          type: "description",
          description: connection.localDescription.toJSON(),
        });
      }
    }
  }, [makePeerConnection, sendSignal]);

  useEffect(() => {
    let disposed = false;
    const participantName = sessionStorage.getItem("interview-room-name")?.trim() || "Guest";
    setName(participantName);

    async function join() {
      if (!/^[a-zA-Z0-9-]{8,64}$/.test(roomId)) {
        setStatus("Unable to join");
        setError("That room link is invalid.");
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("Camera unavailable");
        setError("Camera and microphone access requires HTTPS or localhost.");
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        if (disposed) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        localStreamRef.current = stream;
        setLocalStream(stream);

        const signalingUrl =
          process.env.NEXT_PUBLIC_SIGNALING_URL || window.location.origin.replace(/:\d+$/, ":3001");
        const socket: RoomSocket = io(signalingUrl);
        socketRef.current = socket;
        socket.on("connect", () => {
          setStatus("Joining room…");
          socket.emit("room:join", { roomId, name: participantName }, async (response: JoinResponse) => {
            if (disposed) return;
            if (!response.ok) {
              setStatus("Unable to join");
              setError(response.error);
              return;
            }

            setMyId(response.participantId);
            setParticipants([
              ...response.participants,
              { id: response.participantId, name: participantName },
            ]);
            setStatus("Connected");

            try {
              for (const peer of response.participants) {
                const connection = makePeerConnection(peer);
                const offer = await connection.createOffer();
                await connection.setLocalDescription(offer);
                if (connection.localDescription) {
                  sendSignal(peer.id, {
                    type: "description",
                    description: connection.localDescription.toJSON(),
                  });
                }
              }
            } catch (joinError) {
              setError(joinError instanceof Error ? joinError.message : "Could not start the video connection.");
            }
          });
        });
        socket.on("room:peer-joined", (peer) => {
          setParticipants((current) =>
            current.some((participant) => participant.id === peer.id) ? current : [...current, peer],
          );
        });
        socket.on("room:peer-left", ({ id }) => {
          peerConnections.current.get(id)?.close();
          peerConnections.current.delete(id);
          peerStreams.current.delete(id);
          pendingCandidates.current.delete(id);
          setRemoteStreams((current) => {
            const next = { ...current };
            delete next[id];
            return next;
          });
          setParticipants((current) => current.filter((participant) => participant.id !== id));
        });
        socket.on("room:signal", (message) => {
          void handleSignal(message).catch((signalError: unknown) => {
            setError(signalError instanceof Error ? signalError.message : "A video connection error occurred.");
          });
        });
        socket.on("connect_error", () => {
          setStatus("Connection error");
          setError("Could not reach the signaling server. Make sure the app server is running.");
        });
        socket.on("disconnect", () => {
          if (!disposed) {
            closePeers();
            setParticipants([]);
            setMyId("");
            setStatus("Reconnecting…");
          }
        });
      } catch (mediaError) {
        if (disposed) return;
        setStatus("Camera or microphone unavailable");
        setError(
          mediaError instanceof Error
            ? `${mediaError.message}. Allow camera and microphone access, then reload this page.`
            : "Allow camera and microphone access, then reload this page.",
        );
      }
    }

    void join();

    return () => {
      disposed = true;
      socketRef.current?.disconnect();
      socketRef.current = null;
      closePeers();
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    };
  }, [closePeers, handleSignal, makePeerConnection, roomId, sendSignal]);

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setError("Invite link copied.");
    } catch {
      setError("Could not copy the invite link. Copy it from your browser address bar.");
    }
  }

  function leaveRoom() {
    socketRef.current?.disconnect();
    router.push("/");
  }

  function toggleAudio() {
    const nextEnabled = !micEnabled;
    localStream?.getAudioTracks().forEach((track) => { track.enabled = nextEnabled; });
    setMicEnabled(nextEnabled);
  }

  function toggleCamera() {
    const nextEnabled = !cameraEnabled;
    localStream?.getVideoTracks().forEach((track) => { track.enabled = nextEnabled; });
    setCameraEnabled(nextEnabled);
  }

  return (
    <main className="room-page">
      <header className="room-header">
        <div>
          <p className="eyebrow">INTERVIEW ROOM</p>
          <h1>{name}&apos;s interview</h1>
          <p className="muted">Room {roomId}</p>
        </div>
        <div className="header-actions">
          <span className="status">{status}</span>
          <button type="button" className="secondary-button compact" onClick={() => void copyInvite()}>
            Copy invite
          </button>
        </div>
      </header>

      <section className="video-grid" aria-label="Room participants">
        <VideoTile stream={localStream} label={`${name} (you)`} muted />
        {participants.filter((participant) => participant.id !== myId).map((participant) => (
          <VideoTile
            key={participant.id}
            stream={remoteStreams[participant.id] ?? null}
            label={participant.name}
          />
        ))}
        {status !== "Connected" && !error && <p className="muted">Connecting to the room…</p>}
      </section>

      {error && <p className="error-message room-error" role="status">{error}</p>}

      <footer className="call-controls">
        <button type="button" className="secondary-button" onClick={toggleAudio} disabled={!localStream}>
          {micEnabled ? "Mute mic" : "Unmute mic"}
        </button>
        <button type="button" className="secondary-button" onClick={toggleCamera} disabled={!localStream}>
          {cameraEnabled ? "Turn camera off" : "Turn camera on"}
        </button>
        <button type="button" className="danger-button" onClick={leaveRoom}>Leave room</button>
      </footer>
    </main>
  );
}

function VideoTile({
  stream,
  label,
  muted = false,
}: {
  stream: MediaStream | null;
  label: string;
  muted?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  return (
    <article className="video-tile">
      <video ref={videoRef} autoPlay playsInline muted={muted} />
      {!stream?.getVideoTracks().some((track) => track.readyState === "live" && track.enabled) && (
        <div className="video-placeholder">{label}</div>
      )}
      <span className="video-label">{label}</span>
    </article>
  );
}
