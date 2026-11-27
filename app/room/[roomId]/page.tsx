"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { io, Socket } from "socket.io-client";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import ExecutionPanel from "@/components/ExecutionPanel";
import {
  DEFAULT_LANGUAGE_ID,
  getLanguageConfig,
  isStarterTemplate,
} from "@/lib/languages";
import { YjsSocketProvider } from "@/lib/yjs-socket-provider";
import type { ExecutionResult } from "@/types/execution";
import type {
  ClientToServerEvents,
  JoinResponse,
  Participant,
  ServerToClientEvents,
  Signal,
} from "@/types/signaling";

const CollaborativeEditor = dynamic(
  () => import("@/components/CollaborativeEditor"),
  {
    ssr: false,
    loading: () => (
      <div className="editor-loading">Loading collaborative editor…</div>
    ),
  },
);

type PeerConnection = RTCPeerConnection;
type RoomSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  ...(process.env.NEXT_PUBLIC_TURN_URL
    ? [
        {
          urls: process.env.NEXT_PUBLIC_TURN_URL,
          username: process.env.NEXT_PUBLIC_TURN_USERNAME,
          credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
        },
      ]
    : []),
];

function applyTextDiff(ytext: Y.Text, nextValue: string) {
  const prevValue = ytext.toString();
  if (prevValue === nextValue) return;

  let start = 0;
  while (
    start < prevValue.length &&
    start < nextValue.length &&
    prevValue[start] === nextValue[start]
  ) {
    start++;
  }

  let prevEnd = prevValue.length;
  let nextEnd = nextValue.length;
  while (
    prevEnd > start &&
    nextEnd > start &&
    prevValue[prevEnd - 1] === nextValue[nextEnd - 1]
  ) {
    prevEnd--;
    nextEnd--;
  }

  const deleteCount = prevEnd - start;
  const insertText = nextValue.slice(start, nextEnd);
  if (deleteCount > 0) ytext.delete(start, deleteCount);
  if (insertText.length > 0) ytext.insert(start, insertText);
}

export default function RoomPage() {
  const params = useParams<{ roomId: string }>();
  const router = useRouter();
  const roomId = useMemo(() => decodeURIComponent(params.roomId), [params.roomId]);

  const [name, setName] = useState("Guest");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [myId, setMyId] = useState("");
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState("Connecting…");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);

  const [yjsSession, setYjsSession] = useState<{
    doc: Y.Doc;
    awareness: Awareness;
  } | null>(null);
  const [language, setLanguage] = useState(DEFAULT_LANGUAGE_ID);
  const [stdin, setStdin] = useState("");
  const [executionResult, setExecutionResult] = useState<ExecutionResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runningBy, setRunningBy] = useState<string | null>(null);

  const socketRef = useRef<RoomSocket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const yjsProviderRef = useRef<YjsSocketProvider | null>(null);
  const yjsDocRef = useRef<Y.Doc | null>(null);
  const yjsAwarenessRef = useRef<Awareness | null>(null);
  const peerConnections = useRef(new Map<string, PeerConnection>());
  const peerStreams = useRef(new Map<string, MediaStream>());
  const pendingCandidates = useRef(new Map<string, RTCIceCandidateInit[]>());

  const teardownYjs = useCallback(() => {
    yjsProviderRef.current?.destroy();
    yjsProviderRef.current = null;
    yjsAwarenessRef.current?.destroy();
    yjsAwarenessRef.current = null;
    yjsDocRef.current?.destroy();
    yjsDocRef.current = null;
    setYjsSession(null);
  }, []);

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

  const makePeerConnection = useCallback(
    (peer: Participant) => {
      const existing = peerConnections.current.get(peer.id);
      if (existing) return existing;

      const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      peerConnections.current.set(peer.id, connection);

      const currentLocalStream = localStreamRef.current;
      for (const track of currentLocalStream?.getTracks() ?? []) {
        if (currentLocalStream) connection.addTrack(track, currentLocalStream);
      }

      connection.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal(peer.id, {
            type: "candidate",
            candidate: event.candidate.toJSON(),
          });
        }
      };
      connection.ontrack = (event) => {
        const stream =
          peerStreams.current.get(peer.id) ?? event.streams[0] ?? new MediaStream();
        if (!stream.getTracks().some((track) => track.id === event.track.id)) {
          stream.addTrack(event.track);
        }
        peerStreams.current.set(peer.id, stream);
        setRemoteStreams((current) => ({ ...current, [peer.id]: stream }));
      };
      connection.onconnectionstatechange = () => {
        if (connection.connectionState === "failed") {
          setError(
            `Video connection to ${peer.name} failed. Check your network and try rejoining.`,
          );
        }
      };

      return connection;
    },
    [sendSignal],
  );

  const handleSignal = useCallback(
    async (message: { fromId: string; fromName: string; signal: Signal }) => {
      const peer = { id: message.fromId, name: message.fromName };
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
    },
    [makePeerConnection, sendSignal],
  );

  useEffect(() => {
    let disposed = false;
    const participantName =
      sessionStorage.getItem("interview-room-name")?.trim() || "Guest";
    setName(participantName);

    async function join() {
      if (!/^[a-zA-Z0-9-]{8,64}$/.test(roomId)) {
        setStatus("Unable to join");
        setError("That room link is invalid.");
        return;
      }

      if (navigator.mediaDevices?.getUserMedia) {
        try {
          setStatus("Requesting camera and microphone…");
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: true,
          });
          if (disposed) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          localStreamRef.current = stream;
          setLocalStream(stream);
        } catch (mediaError) {
          if (disposed) return;
          setNotice(
            mediaError instanceof Error
              ? `Camera/mic unavailable (${mediaError.message}). Joined in editor-only mode.`
              : "Camera/mic unavailable. Joined in editor-only mode.",
          );
        }
      } else {
        setNotice(
          "Camera and microphone require HTTPS or localhost. Joined in editor-only mode.",
        );
      }

      if (disposed) return;

      const signalingUrl =
        process.env.NEXT_PUBLIC_SIGNALING_URL ||
        window.location.origin.replace(/:\d+$/, ":3001");
      const socket: RoomSocket = io(signalingUrl);
      socketRef.current = socket;

      socket.on("connect", () => {
        setStatus("Joining room…");
        socket.emit(
          "room:join",
          { roomId, name: participantName },
          async (response: JoinResponse) => {
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
            if (response.lastExecution) {
              setExecutionResult(response.lastExecution);
            }
            setStatus("Connected");
            setError("");

            // Initialize CRDT document & awareness sync for this room
            teardownYjs();
            const doc = new Y.Doc();
            const awareness = new Awareness(doc);
            const roomState = doc.getMap<string | boolean>("roomState");
            const codeText = doc.getText("code");
            const stdinText = doc.getText("stdin");

            const syncLanguageFromDoc = () => {
              const lang = roomState.get("language");
              if (typeof lang === "string") {
                setLanguage(lang);
              }
            };
            const syncStdinFromDoc = () => {
              setStdin(stdinText.toString());
            };

            roomState.observe(syncLanguageFromDoc);
            stdinText.observe(syncStdinFromDoc);

            const provider = new YjsSocketProvider(socket, doc, awareness);
            yjsDocRef.current = doc;
            yjsAwarenessRef.current = awareness;
            yjsProviderRef.current = provider;
            setYjsSession({ doc, awareness });

            provider.onSynced(() => {
              if (disposed) return;
              if (!roomState.get("initialized") && codeText.length === 0) {
                doc.transact(() => {
                  if (!roomState.get("initialized") && codeText.length === 0) {
                    roomState.set("initialized", true);
                    roomState.set("language", DEFAULT_LANGUAGE_ID);
                    codeText.insert(
                      0,
                      getLanguageConfig(DEFAULT_LANGUAGE_ID).starterCode,
                    );
                  }
                });
              }
              syncLanguageFromDoc();
              syncStdinFromDoc();
            });

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
              setError(
                joinError instanceof Error
                  ? joinError.message
                  : "Could not start the video connection.",
              );
            }
          },
        );
      });

      socket.on("room:peer-joined", (peer) => {
        setParticipants((current) =>
          current.some((participant) => participant.id === peer.id)
            ? current
            : [...current, peer],
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
        setParticipants((current) =>
          current.filter((participant) => participant.id !== id),
        );
      });

      socket.on("room:signal", (message) => {
        void handleSignal(message).catch((signalError: unknown) => {
          setError(
            signalError instanceof Error
              ? signalError.message
              : "A video connection error occurred.",
          );
        });
      });

      socket.on("code:running", ({ byName }) => {
        setIsRunning(true);
        setRunningBy(byName);
      });

      socket.on("code:result", (result) => {
        setIsRunning(false);
        setRunningBy(null);
        setExecutionResult(result);
      });

      socket.on("connect_error", () => {
        setStatus("Connection error");
        setError(
          "Could not reach the signaling server. Make sure the app server is running.",
        );
      });

      socket.on("disconnect", () => {
        if (!disposed) {
          closePeers();
          teardownYjs();
          setParticipants([]);
          setMyId("");
          setStatus("Reconnecting…");
        }
      });
    }

    void join();

    return () => {
      disposed = true;
      teardownYjs();
      socketRef.current?.disconnect();
      socketRef.current = null;
      closePeers();
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    };
  }, [closePeers, handleSignal, makePeerConnection, roomId, sendSignal, teardownYjs]);

  const handleLanguageChange = useCallback((nextLanguageId: string) => {
    const doc = yjsDocRef.current;
    if (!doc) return;

    const roomState = doc.getMap<string | boolean>("roomState");
    const codeText = doc.getText("code");

    doc.transact(() => {
      roomState.set("language", nextLanguageId);
      if (isStarterTemplate(codeText.toString())) {
        codeText.delete(0, codeText.length);
        codeText.insert(0, getLanguageConfig(nextLanguageId).starterCode);
      }
    });
  }, []);

  const handleStdinChange = useCallback((nextValue: string) => {
    const doc = yjsDocRef.current;
    setStdin(nextValue);
    if (!doc) return;
    const stdinText = doc.getText("stdin");
    doc.transact(() => {
      applyTextDiff(stdinText, nextValue);
    });
  }, []);

  const handleRunCode = useCallback(async () => {
    const doc = yjsDocRef.current;
    if (!doc || isRunning) return;

    const sourceCode = doc.getText("code").toString();
    const currentStdin = doc.getText("stdin").toString();
    const activeLang =
      (doc.getMap<string | boolean>("roomState").get("language") as string) ||
      language;

    if (!sourceCode.trim()) {
      setNotice("Write some code before running.");
      return;
    }

    setIsRunning(true);
    setRunningBy(name);
    socketRef.current?.emit("code:running", { language: activeLang });

    try {
      const response = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceCode,
          language: activeLang,
          stdin: currentStdin,
        }),
      });

      const payload = (await response.json()) as ExecutionResult & { error?: string };
      const finalResult: ExecutionResult =
        typeof payload.statusId === "number"
          ? { ...payload, ranBy: name }
          : {
              ok: false,
              language: activeLang,
              statusId: 0,
              statusDescription: "Request Error",
              stdout: "",
              stderr: "",
              compileOutput: "",
              message: "",
              exitCode: null,
              exitSignal: null,
              time: null,
              memory: null,
              ranAt: new Date().toISOString(),
              ranBy: name,
              error: payload.error || `Request failed (${response.status}).`,
            };

      setExecutionResult(finalResult);
      socketRef.current?.emit("code:result", finalResult);
    } catch (runError) {
      const errorResult: ExecutionResult = {
        ok: false,
        language: activeLang,
        statusId: 0,
        statusDescription: "Network Error",
        stdout: "",
        stderr: "",
        compileOutput: "",
        message: "",
        exitCode: null,
        exitSignal: null,
        time: null,
        memory: null,
        ranAt: new Date().toISOString(),
        ranBy: name,
        error:
          runError instanceof Error
            ? runError.message
            : "Failed to reach code execution API.",
      };
      setExecutionResult(errorResult);
      socketRef.current?.emit("code:result", errorResult);
    } finally {
      setIsRunning(false);
      setRunningBy(null);
    }
  }, [isRunning, language, name]);

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setNotice("Invite link copied to clipboard.");
      setTimeout(() => {
        setNotice((current) =>
          current === "Invite link copied to clipboard." ? "" : current,
        );
      }, 3000);
    } catch {
      setError("Could not copy the invite link. Copy it from your browser address bar.");
    }
  }

  function leaveRoom() {
    teardownYjs();
    socketRef.current?.disconnect();
    router.push("/");
  }

  function toggleAudio() {
    const nextEnabled = !micEnabled;
    localStream?.getAudioTracks().forEach((track) => {
      track.enabled = nextEnabled;
    });
    setMicEnabled(nextEnabled);
  }

  function toggleCamera() {
    const nextEnabled = !cameraEnabled;
    localStream?.getVideoTracks().forEach((track) => {
      track.enabled = nextEnabled;
    });
    setCameraEnabled(nextEnabled);
  }

  return (
    <main className="workspace-page">
      <header className="workspace-header">
        <div className="workspace-title">
          <p className="eyebrow">INTERVIEW ROOM</p>
          <div className="workspace-heading-row">
            <h1>{name}&apos;s session</h1>
            <span className="room-id-pill">Room: {roomId}</span>
          </div>
        </div>

        <div className="header-actions">
          <span className={`status-pill ${status === "Connected" ? "connected" : ""}`}>
            {status}
          </span>
          <button
            type="button"
            className="secondary-button compact"
            onClick={() => void copyInvite()}
          >
            Copy invite
          </button>
          <button
            type="button"
            className="danger-button compact"
            onClick={leaveRoom}
          >
            Leave
          </button>
        </div>
      </header>

      {error && (
        <p className="banner-message error" role="alert">
          {error}
        </p>
      )}
      {!error && notice && (
        <p className="banner-message info" role="status">
          {notice}
        </p>
      )}

      <div className="workspace-grid">
        <div className="ide-column">
          <CollaborativeEditor
            doc={yjsSession?.doc ?? null}
            awareness={yjsSession?.awareness ?? null}
            language={language}
            localName={name}
            isRunning={isRunning}
            onLanguageChange={handleLanguageChange}
            onRunCode={() => void handleRunCode()}
          />
          <ExecutionPanel
            stdin={stdin}
            onStdinChange={handleStdinChange}
            result={executionResult}
            isRunning={isRunning}
            runningBy={runningBy}
            onClearOutput={() => setExecutionResult(null)}
          />
        </div>

        <aside className="media-sidebar" aria-label="Video call and controls">
          <div className="sidebar-video-list">
            <VideoTile stream={localStream} label={`${name} (you)`} muted />
            {participants
              .filter((participant) => participant.id !== myId)
              .map((participant) => (
                <VideoTile
                  key={participant.id}
                  stream={remoteStreams[participant.id] ?? null}
                  label={participant.name}
                />
              ))}
            {participants.filter((participant) => participant.id !== myId).length === 0 && (
              <div className="waiting-peer-card">
                <p className="muted">Waiting for the other participant to join…</p>
              </div>
            )}
          </div>

          <footer className="sidebar-controls">
            <button
              type="button"
              className="secondary-button"
              onClick={toggleAudio}
              disabled={!localStream}
            >
              {micEnabled ? "Mute mic" : "Unmute mic"}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={toggleCamera}
              disabled={!localStream}
            >
              {cameraEnabled ? "Camera off" : "Camera on"}
            </button>
          </footer>
        </aside>
      </div>
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
      {!stream
        ?.getVideoTracks()
        .some((track) => track.readyState === "live" && track.enabled) && (
        <div className="video-placeholder">{label}</div>
      )}
      <span className="video-label">{label}</span>
    </article>
  );
}
