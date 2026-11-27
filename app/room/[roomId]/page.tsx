"use client";

import dynamic from "next/dynamic";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  clearStoredRoomAuth,
  getStoredRoomAuth,
  saveStoredRoomAuth,
  type StoredRoomAuth,
} from "@/lib/room-auth-storage";
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
type AuthPhase = "checking" | "password_prompt" | "authorized" | "ended" | "unavailable";

const MIC_VOLUME_THRESHOLD = 40;

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

function formatRemainingTime(expiresAt: number | null): string | null {
  if (!expiresAt) return null;
  const diffMs = Math.max(0, expiresAt - Date.now());
  const totalMins = Math.ceil(diffMs / 60_000);
  if (totalMins >= 60) {
    const hrs = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    return `${hrs}h ${mins}m left`;
  }
  return `${totalMins}m left`;
}

export default function RoomPage() {
  const params = useParams<{ roomId: string }>();
  const router = useRouter();
  const roomId = useMemo(() => decodeURIComponent(params.roomId), [params.roomId]);

  const [authPhase, setAuthPhase] = useState<AuthPhase>("checking");
  const [roomAuth, setRoomAuth] = useState<StoredRoomAuth | null>(null);
  const [gateName, setGateName] = useState("");
  const [gatePassword, setGatePassword] = useState("");
  const [gateError, setGateError] = useState("");
  const [gateSubmitting, setGateSubmitting] = useState(false);
  const [endedMessage, setEndedMessage] = useState("");

  const [participants, setParticipants] = useState<Participant[]>([]);
  const [myId, setMyId] = useState("");
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState("Connecting…");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [remainingLabel, setRemainingLabel] = useState<string | null>(null);
  const [endingSession, setEndingSession] = useState(false);
  const [isFullscreenActive, setIsFullscreenActive] = useState(false);
  const [showFullscreenOverlay, setShowFullscreenOverlay] = useState(false);
  const [enablingMedia, setEnablingMedia] = useState(false);
  const [currentVolume, setCurrentVolume] = useState(0);
  const [peakVolume, setPeakVolume] = useState(0);
  const [micCheckPassed, setMicCheckPassed] = useState(false);
  const [sessionIdCopied, setSessionIdCopied] = useState(false);
  const isFullscreenActiveRef = useRef(false);
  isFullscreenActiveRef.current = isFullscreenActive;

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
  const hasTerminatedRef = useRef(false);
  const nativeWriteTextRef = useRef<((text: string) => Promise<void>) | null>(null);

  const name = roomAuth?.name || "Guest";

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

  const stopMedia = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);
  }, []);

  // Step 1: Check stored room JWT or probe room status for inline password gate
  useEffect(() => {
    let cancelled = false;
    const savedName = sessionStorage.getItem("interview-room-name")?.trim() || "";
    if (savedName) setGateName(savedName);

    async function checkAccess() {
      if (!/^[a-zA-Z0-9-]{8,64}$/.test(roomId)) {
        setEndedMessage("That room link is invalid.");
        setAuthPhase("unavailable");
        return;
      }

      const existing = getStoredRoomAuth(roomId);
      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`);
        if (cancelled) return;
        const info = (await res.json()) as {
          exists: boolean;
          status: string;
          expiresAt?: number;
        };

        if (!res.ok || !info.exists) {
          clearStoredRoomAuth(roomId);
          setEndedMessage("This interview room does not exist or has been purged.");
          setAuthPhase("unavailable");
          return;
        }
        if (info.status === "ended" || info.status === "expired") {
          clearStoredRoomAuth(roomId);
          setEndedMessage(
            info.status === "expired"
              ? "This room has expired."
              : "This interview session has ended.",
          );
          setAuthPhase("ended");
          return;
        }

        if (existing) {
          setRoomAuth(existing);
          setAuthPhase("authorized");
        } else {
          setAuthPhase("password_prompt");
        }
      } catch {
        if (cancelled) return;
        if (existing) {
          setRoomAuth(existing);
          setAuthPhase("authorized");
        } else {
          setGateError("Could not verify room status. Please try again.");
          setAuthPhase("password_prompt");
        }
      }
    }

    void checkAccess();
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  // Countdown badge for room TTL
  useEffect(() => {
    if (!roomAuth?.expiresAt) {
      setRemainingLabel(null);
      return;
    }
    const update = () => setRemainingLabel(formatRemainingTime(roomAuth.expiresAt));
    update();
    const timer = setInterval(update, 30_000);
    return () => clearInterval(timer);
  }, [roomAuth?.expiresAt]);

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

  // Step 2: Connect WebRTC + Socket.IO + Yjs once authorized and in strict fullscreen
  useEffect(() => {
    if (authPhase !== "authorized" || !roomAuth || !isFullscreenActive) return;

    let disposed = false;
    const activeToken = roomAuth.token;
    const participantName = roomAuth.name;

    async function join() {
      let stream = localStreamRef.current;
      if (!stream || stream.getTracks().length === 0 || !stream.active) {
        if (navigator.mediaDevices?.getUserMedia) {
          try {
            setStatus("Connecting camera and microphone…");
            stream = await navigator.mediaDevices.getUserMedia({
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
      }

      if (stream) {
        // Enforce that camera and mic tracks remain on continuously
        stream.getTracks().forEach((track) => {
          track.enabled = true;
          track.onended = () => {
            setNotice(`Warning: ${track.kind} hardware was disconnected.`);
          };
        });
      }

      if (disposed) return;

      const signalingUrl =
        process.env.NEXT_PUBLIC_SIGNALING_URL ||
        window.location.origin.replace(/:\d+$/, ":3001");
      const socket: RoomSocket = io(signalingUrl, {
        auth: { token: activeToken },
      });
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

      socket.on("room:ended", ({ reason, byName }) => {
        if (disposed) return;
        clearStoredRoomAuth(roomId);
        teardownYjs();
        closePeers();
        stopMedia();
        socket.disconnect();
        setEndedMessage(
          reason === "expired"
            ? "This room has expired."
            : byName
              ? `Session ended by ${byName}.`
              : "This interview session has ended.",
        );
        setAuthPhase("ended");
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

      socket.on("connect_error", (connErr) => {
        const msg = connErr?.message || "";
        if (msg.toLowerCase().includes("unauthorized")) {
          clearStoredRoomAuth(roomId);
          setGateError("Your session expired. Re-enter the room password.");
          setAuthPhase("password_prompt");
          return;
        }
        if (msg.toLowerCase().includes("ended") || msg.toLowerCase().includes("expired")) {
          clearStoredRoomAuth(roomId);
          setEndedMessage(msg);
          setAuthPhase("ended");
          return;
        }
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
      stopMedia();
    };
  }, [
    authPhase,
    roomAuth,
    isFullscreenActive,
    closePeers,
    handleSignal,
    makePeerConnection,
    roomId,
    sendSignal,
    stopMedia,
    teardownYjs,
  ]);

  // Continuous lock: ensure camera and mic tracks are strictly enabled
  useEffect(() => {
    if (!localStream) return;
    const interval = setInterval(() => {
      localStream.getTracks().forEach((track) => {
        if (!track.enabled) track.enabled = true;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [localStream]);

  // Handler to close session automatically when exiting fullscreen
  const terminateSessionDueToFullscreenExit = useCallback(async () => {
    if (hasTerminatedRef.current) return;
    hasTerminatedRef.current = true;

    const codeSnapshot = yjsDocRef.current?.getText("code").toString() ?? "";
    const activeLanguage =
      (yjsDocRef.current?.getMap<string | boolean>("roomState").get("language") as string) ||
      language;

    try {
      if (roomAuth?.token) {
        await fetch(`/api/rooms/${encodeURIComponent(roomId)}/end`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${roomAuth.token}`,
          },
          body: JSON.stringify({ codeSnapshot, language: activeLanguage }),
        });
      }
    } catch {
      // Ignore network errors on emergency exit
    }

    socketRef.current?.emit("room:end");
    clearStoredRoomAuth(roomId);
    teardownYjs();
    closePeers();
    stopMedia();
    socketRef.current?.disconnect();

    setIsFullscreenActive(false);
    setEndedMessage(
      "Session automatically closed: You exited fullscreen mode. Strict fullscreen is required throughout the interview.",
    );
    setAuthPhase("ended");
  }, [closePeers, language, roomId, roomAuth, stopMedia, teardownYjs]);

  // Fullscreen change listener: prompts re-entry in testing mode instead of terminating session
  useEffect(() => {
    if (authPhase !== "authorized" || !isFullscreenActive) return;

    const handleFullscreenChange = () => {
      const isFullscreenNow = Boolean(
        document.fullscreenElement ||
          (document as unknown as { webkitFullscreenElement?: Element })
            .webkitFullscreenElement,
      );

      if (!isFullscreenNow && isFullscreenActiveRef.current && !hasTerminatedRef.current) {
        // Testing mode: Prompt user to enter fullscreen again instead of ending the session
        setShowFullscreenOverlay(true);
      } else if (isFullscreenNow) {
        setShowFullscreenOverlay(false);
      }
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
    };
  }, [authPhase, isFullscreenActive]);

  async function reenterFullscreen() {
    try {
      const docEl = document.documentElement as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void>;
      };
      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen();
      } else if (docEl.webkitRequestFullscreen) {
        await docEl.webkitRequestFullscreen();
      }
      setShowFullscreenOverlay(false);
    } catch (err) {
      console.warn("Fullscreen re-entry failed:", err);
    }
  }

  // Microphone volume threshold check for pre-session verification
  useEffect(() => {
    if (authPhase !== "authorized" || isFullscreenActive || !localStream) {
      return;
    }

    const audioTracks = localStream.getAudioTracks();
    if (audioTracks.length === 0) return;

    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;

    let audioContext: AudioContext;
    try {
      audioContext = new AudioContextClass();
      if (audioContext.state === "suspended") {
        void audioContext.resume();
      }
    } catch {
      return;
    }

    const source = audioContext.createMediaStreamSource(localStream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let animationFrameId: number;
    let localPeak = 0;
    let lastUiUpdate = 0;
    let lastDisplayedVol = -1;

    const checkVolume = () => {
      analyser.getByteTimeDomainData(dataArray);
      let maxDev = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const dev = Math.abs(dataArray[i] - 128);
        if (dev > maxDev) maxDev = dev;
      }

      // Convert max deviation (0-128) to 0-100% volume
      const vol = Math.min(100, Math.round((maxDev / 128) * 160));

      const now = performance.now();
      if (vol !== lastDisplayedVol && now - lastUiUpdate >= 65) {
        lastDisplayedVol = vol;
        lastUiUpdate = now;
        setCurrentVolume(vol);
      }

      if (vol > localPeak) {
        localPeak = vol;
        setPeakVolume(localPeak);
      }

      if (vol > MIC_VOLUME_THRESHOLD || localPeak > MIC_VOLUME_THRESHOLD) {
        setMicCheckPassed(true);
      }

      animationFrameId = requestAnimationFrame(checkVolume);
    };

    animationFrameId = requestAnimationFrame(checkVolume);

    return () => {
      cancelAnimationFrame(animationFrameId);
      try {
        audioContext.close();
      } catch {}
    };
  }, [authPhase, isFullscreenActive, localStream]);

  // Strictly disallow clipboard actions, copy/pasting, and opening clipboard
  useEffect(() => {
    if (authPhase !== "authorized" || !isFullscreenActive) return;

    // Neutralize navigator.clipboard so opening or writing to clipboard is rejected
    try {
      const existingClipboard = navigator.clipboard as
        | (Clipboard & { __locked?: boolean })
        | undefined;
      if (
        existingClipboard &&
        !existingClipboard.__locked &&
        typeof existingClipboard.writeText === "function"
      ) {
        nativeWriteTextRef.current = existingClipboard.writeText.bind(existingClipboard);
      }

      const rejectClipboard = () =>
        Promise.reject(
          new DOMException(
            "Clipboard access is strictly prohibited in this session.",
            "NotAllowedError",
          ),
        );
      Object.defineProperty(navigator, "clipboard", {
        value: {
          __locked: true,
          read: rejectClipboard,
          readText: rejectClipboard,
          write: rejectClipboard,
          writeText: rejectClipboard,
        },
        configurable: true,
        writable: false,
      });
    } catch {
      // Browser may seal navigator.clipboard in some contexts
    }

    const handleBlockedClipboard = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      setNotice("Clipboard actions (copy, cut, paste) are strictly prohibited.");
    };

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const isCtrlOrMeta = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      // Intercept Ctrl/Cmd + C, V, X, Insert, Win+V, Shift+Insert, Shift+Delete
      if (
        (isCtrlOrMeta && (key === "c" || key === "v" || key === "x" || key === "insert")) ||
        (event.shiftKey && (key === "insert" || key === "delete"))
      ) {
        event.preventDefault();
        event.stopPropagation();
        setNotice("Copying and pasting are strictly disabled.");
      }
    };

    window.addEventListener("copy", handleBlockedClipboard, true);
    window.addEventListener("cut", handleBlockedClipboard, true);
    window.addEventListener("paste", handleBlockedClipboard, true);
    window.addEventListener("beforecopy", handleBlockedClipboard, true);
    window.addEventListener("beforecut", handleBlockedClipboard, true);
    window.addEventListener("beforepaste", handleBlockedClipboard, true);
    window.addEventListener("contextmenu", handleContextMenu, true);
    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("copy", handleBlockedClipboard, true);
      window.removeEventListener("cut", handleBlockedClipboard, true);
      window.removeEventListener("paste", handleBlockedClipboard, true);
      window.removeEventListener("beforecopy", handleBlockedClipboard, true);
      window.removeEventListener("beforecut", handleBlockedClipboard, true);
      window.removeEventListener("beforepaste", handleBlockedClipboard, true);
      window.removeEventListener("contextmenu", handleContextMenu, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [authPhase, isFullscreenActive]);

  async function startSessionWithMediaAndFullscreen() {
    if (enablingMedia) return;
    setEnablingMedia(true);
    setGateError("");

    let stream = localStreamRef.current;
    if (!stream || stream.getTracks().length === 0 || !stream.active) {
      if (!navigator.mediaDevices?.getUserMedia) {
        setGateError("Your browser does not support camera and microphone access.");
        setEnablingMedia(false);
        return;
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: true,
        });
        stream.getTracks().forEach((track) => {
          track.enabled = true;
          track.onended = () => {
            setNotice(`Warning: ${track.kind} hardware was disconnected.`);
          };
        });
        localStreamRef.current = stream;
        setLocalStream(stream);
        setEnablingMedia(false);
        // After enabling devices, allow user to test mic above 40% volume
        return;
      } catch (mediaErr) {
        setEnablingMedia(false);
        const isDenied =
          mediaErr instanceof Error &&
          (mediaErr.name === "NotAllowedError" || mediaErr.name === "PermissionDeniedError");
        setGateError(
          isDenied
            ? "Camera and microphone permissions were denied. You must grant camera and mic permissions in your browser before entering the session."
            : mediaErr instanceof Error
            ? `Camera/mic error: ${mediaErr.message}`
            : "Camera and microphone access is required to proceed.",
        );
        return;
      }
    }

    // Require mic volume verification (> 40% volume)
    if (!micCheckPassed) {
      setGateError(
        `Microphone check required: Speak into your microphone so volume goes above ${MIC_VOLUME_THRESHOLD}% to unlock the session.`,
      );
      setEnablingMedia(false);
      return;
    }

    // Now that camera and mic are permitted and voice check passed, enter fullscreen
    try {
      const docEl = document.documentElement as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void>;
      };
      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen();
      } else if (docEl.webkitRequestFullscreen) {
        await docEl.webkitRequestFullscreen();
      }
      hasTerminatedRef.current = false;
      setIsFullscreenActive(true);
    } catch {
      setGateError(
        "Fullscreen access was blocked or denied. Strict fullscreen mode is mandatory to enter the interview.",
      );
    } finally {
      setEnablingMedia(false);
    }
  }

  async function handleGateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = gateName.trim();
    if (!trimmedName) {
      setGateError("Enter your name to join.");
      return;
    }
    if (!gatePassword) {
      setGateError("Enter the room password.");
      return;
    }

    setGateSubmitting(true);
    setGateError("");
    try {
      const response = await fetch("/api/rooms/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId,
          name: trimmedName,
          password: gatePassword,
        }),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        token?: string;
        participantId?: string;
        name?: string;
        expiresAt?: number;
        error?: string;
      };

      if (!response.ok || !data.ok || !data.token || !data.participantId || !data.expiresAt) {
        setGateError(data.error || "Could not join room.");
        return;
      }

      const authPayload: StoredRoomAuth = {
        roomId,
        token: data.token,
        participantId: data.participantId,
        name: data.name || trimmedName,
        expiresAt: data.expiresAt,
      };
      saveStoredRoomAuth(authPayload);
      setRoomAuth(authPayload);
      setAuthPhase("authorized");
    } catch {
      setGateError("Network error while verifying room password.");
    } finally {
      setGateSubmitting(false);
    }
  }

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
    if (!doc || isRunning || !roomAuth) return;

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
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${roomAuth.token}`,
        },
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
              statusDescription:
                response.status === 429 ? "Rate Limited" : "Request Error",
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
      if (typeof payload.statusId === "number") {
        socketRef.current?.emit("code:result", finalResult);
      }
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
    } finally {
      setIsRunning(false);
      setRunningBy(null);
    }
  }, [isRunning, language, name, roomAuth]);

  async function endSession() {
    if (!roomAuth || endingSession) return;
    hasTerminatedRef.current = true;
    setEndingSession(true);
    const codeSnapshot = yjsDocRef.current?.getText("code").toString() ?? "";
    const activeLanguage =
      (yjsDocRef.current?.getMap<string | boolean>("roomState").get("language") as string) ||
      language;

    try {
      await fetch(`/api/rooms/${encodeURIComponent(roomId)}/end`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${roomAuth.token}`,
        },
        body: JSON.stringify({ codeSnapshot, language: activeLanguage }),
      });
    } catch {
      // Socket room:end also persists & closes
    }

    socketRef.current?.emit("room:end");
    clearStoredRoomAuth(roomId);
    teardownYjs();
    closePeers();
    stopMedia();
    socketRef.current?.disconnect();

    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }

    setEndedMessage(`Session ended by ${name}.`);
    setAuthPhase("ended");
    setEndingSession(false);
  }

  // Temporary testing helper to copy session/room ID despite clipboard lock
  async function copySessionId() {
    try {
      const currentClipboard = navigator.clipboard as
        | (Clipboard & { __locked?: boolean })
        | undefined;
      const writeFn =
        nativeWriteTextRef.current ||
        (currentClipboard &&
        !currentClipboard.__locked &&
        typeof currentClipboard.writeText === "function"
          ? currentClipboard.writeText.bind(currentClipboard)
          : null);

      if (!writeFn) {
        setError(`Could not access clipboard. Session ID: ${roomId}`);
        return;
      }

      await writeFn(roomId);
      setSessionIdCopied(true);
      setNotice(`Session ID copied: ${roomId}`);
      setTimeout(() => {
        setSessionIdCopied(false);
        setNotice((current) =>
          current === `Session ID copied: ${roomId}` ? "" : current,
        );
      }, 2500);
    } catch {
      setError(`Could not copy automatically. Session ID: ${roomId}`);
    }
  }

  function leaveRoom() {
    hasTerminatedRef.current = true;
    teardownYjs();
    closePeers();
    stopMedia();
    socketRef.current?.disconnect();
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    router.push("/");
  }

  if (authPhase === "checking") {
    return (
      <main className="landing">
        <section className="panel">
          <p className="eyebrow">INTERVIEW ROOM</p>
          <h1>Verifying room…</h1>
          <p className="muted">Checking session access for room {roomId}.</p>
        </section>
      </main>
    );
  }

  if (authPhase === "unavailable" || authPhase === "ended") {
    return (
      <main className="landing">
        <section className="panel">
          <p className="eyebrow">INTERVIEW ROOM</p>
          <h1>{authPhase === "ended" ? "Session ended" : "Room unavailable"}</h1>
          <p className="muted">{endedMessage || "This room is no longer active."}</p>
          <button
            type="button"
            className="primary-button"
            style={{ width: "100%", marginTop: "16px" }}
            onClick={() => router.push("/")}
          >
            Back to home
          </button>
        </section>
      </main>
    );
  }

  if (authPhase === "password_prompt") {
    return (
      <main className="landing">
        <section className="panel landing-panel">
          <p className="eyebrow">PRIVATE ROOM</p>
          <h1>Enter room password</h1>
          <p className="muted">
            Room <span className="room-id-pill">{roomId}</span>
          </p>

          <form onSubmit={(e) => void handleGateSubmit(e)} className="room-form">
            <label htmlFor="gate-name">Your name</label>
            <input
              id="gate-name"
              autoComplete="name"
              maxLength={60}
              placeholder="e.g. Alex"
              value={gateName}
              onChange={(event) => {
                setGateName(event.target.value);
                setGateError("");
              }}
            />

            <label htmlFor="gate-password">Room password</label>
            <input
              id="gate-password"
              type="password"
              autoComplete="current-password"
              maxLength={128}
              placeholder="Enter password shared by host"
              value={gatePassword}
              onChange={(event) => {
                setGatePassword(event.target.value);
                setGateError("");
              }}
            />

            <button
              type="submit"
              className="primary-button"
              disabled={gateSubmitting}
            >
              {gateSubmitting ? "Verifying…" : "Join interview"}
            </button>

            {gateError && (
              <p className="error-message" role="alert">
                {gateError}
              </p>
            )}
          </form>
        </section>
      </main>
    );
  }

  if (authPhase === "authorized" && !isFullscreenActive) {
    return (
      <main className="landing">
        <section className="panel landing-panel fullscreen-gate">
          <p className="eyebrow">SESSION SETUP & INTEGRITY</p>
          <h1>Camera, Mic & Voice Check</h1>
          <p className="muted">
            Welcome, <strong>{name}</strong>. Before beginning the session, enable your devices and verify your microphone volume.
          </p>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
              marginTop: "12px",
            }}
          >
            <span className="room-id-pill">Session ID: {roomId}</span>
            <button
              type="button"
              className="secondary-button compact"
              onClick={() => void copySessionId()}
            >
              {sessionIdCopied ? "Copied!" : "Copy Session ID"}
            </button>
          </div>

          {localStream && (
            <div style={{ margin: "16px 0", textAlign: "center" }}>
              <div
                style={{
                  width: "100%",
                  height: "160px",
                  borderRadius: "8px",
                  overflow: "hidden",
                  background: "#000",
                  border: "1px solid #303136",
                }}
              >
                <PreviewVideo stream={localStream} />
              </div>

              {/* Mic Volume Threshold Check */}
              <div className="mic-check-box">
                <div className="mic-check-header">
                  <span>🎙️ Mic Check (&gt; {MIC_VOLUME_THRESHOLD}% Volume)</span>
                  <span
                    style={{
                      color: currentVolume > MIC_VOLUME_THRESHOLD ? "#22c55e" : "#a4a6ad",
                      fontWeight: 700,
                    }}
                  >
                    {currentVolume}%
                  </span>
                </div>

                <div className="volume-meter-wrapper">
                  <div
                    className={`volume-meter-fill ${currentVolume > MIC_VOLUME_THRESHOLD || peakVolume > MIC_VOLUME_THRESHOLD ? "threshold-reached" : ""}`}
                    style={{ width: `${Math.min(100, currentVolume)}%` }}
                  />
                  <div
                    className="volume-threshold-line"
                    title={`Above ${MIC_VOLUME_THRESHOLD}% Threshold`}
                  />
                  <span className="volume-threshold-label">{MIC_VOLUME_THRESHOLD}% Target</span>
                </div>

                <div className="mic-check-status-row">
                  <span>Current: {currentVolume}%</span>
                  <span>Peak: {peakVolume}%</span>
                </div>

                <div className="mic-check-items">
                  <div className={`mic-check-item ${micCheckPassed ? "done" : ""}`}>
                    <span>{micCheckPassed ? "✅" : "⭕"}</span>
                    <span>
                      {micCheckPassed
                        ? `Mic volume verified (Peak: ${peakVolume}% > ${MIC_VOLUME_THRESHOLD}%)`
                        : `Speak into your mic above ${MIC_VOLUME_THRESHOLD}% volume (Peak: ${peakVolume}%)`}
                    </span>
                  </div>
                </div>

                {micCheckPassed && (
                  <p
                    style={{
                      color: "#86efac",
                      fontSize: "12px",
                      marginTop: "10px",
                      fontWeight: 600,
                    }}
                  >
                    🎉 Microphone verified! You may now enter fullscreen and begin.
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="fullscreen-warning-box">
            <p><strong>Testing Mode Rules:</strong></p>
            <ul>
              <li>
                <strong>Camera & Mic Locked:</strong> Your camera and microphone will remain active continuously. There is no option to mute or disable them.
              </li>
              <li>
                <strong>Testing Fullscreen:</strong> Exiting fullscreen will prompt you to re-enter fullscreen instead of ending the session.
              </li>
              <li>
                <strong>No Clipboard:</strong> Copying, cutting, pasting, and opening the clipboard are completely prohibited.
              </li>
            </ul>
          </div>

          {gateError && (
            <p className="error-message" role="alert" style={{ marginTop: "12px" }}>
              {gateError}
            </p>
          )}

          <button
            type="button"
            className="primary-button"
            style={{ width: "100%", marginTop: "20px" }}
            disabled={enablingMedia || (Boolean(localStream) && !micCheckPassed)}
            onClick={() => void startSessionWithMediaAndFullscreen()}
          >
            {enablingMedia
              ? "Activating devices…"
              : !localStream
              ? "1. Enable Camera & Mic"
              : !micCheckPassed
              ? `Speak into mic (Peak: ${peakVolume}% / >${MIC_VOLUME_THRESHOLD}%)`
              : "2. Enter Fullscreen & Begin Session"}
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="workspace-page">
      <header className="workspace-header">
        <div className="workspace-title">
          <p className="eyebrow">INTERVIEW ROOM</p>
          <div className="workspace-heading-row">
            <h1>{name}&apos;s session</h1>
            <span className="room-id-pill">Room: {roomId}</span>
            {remainingLabel && (
              <span className="room-id-pill">{remainingLabel}</span>
            )}
          </div>
        </div>

        <div className="header-actions">
          <span className={`status-pill ${status === "Connected" ? "connected" : ""}`}>
            {status}
          </span>
          <span className="integrity-active-pill" title="Strict Fullscreen, Locked Media & Anti-Clipboard Enforced">
            🔒 Strict Integrity Active
          </span>
          <button
            type="button"
            className="secondary-button compact"
            onClick={() => void copySessionId()}
          >
            {sessionIdCopied ? "Copied!" : "Copy Session ID"}
          </button>
          <button
            type="button"
            className="secondary-button compact"
            onClick={leaveRoom}
          >
            Leave
          </button>
          <button
            type="button"
            className="danger-button compact"
            disabled={endingSession}
            onClick={() => void endSession()}
          >
            {endingSession ? "Ending…" : "End Session"}
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
            <div
              className="media-enforced-indicator"
              title="Camera and microphone are strictly enforced for interview integrity and cannot be disabled"
            >
              <span className="media-status-dot" />
              <span>Camera & Mic Active (Locked)</span>
            </div>
          </footer>
        </aside>
      </div>

      {showFullscreenOverlay && (
        <div className="fullscreen-overlay-backdrop">
          <div className="panel fullscreen-overlay-card">
            <p className="eyebrow" style={{ color: "#f59e0b" }}>TESTING MODE: FULLSCREEN PAUSED</p>
            <h2 style={{ margin: "10px 0 8px", fontSize: "22px" }}>Fullscreen Exited</h2>
            <p className="muted" style={{ fontSize: "14px", lineHeight: "1.5" }}>
              You have exited fullscreen mode. For testing purposes, your session has not been closed.
              Please re-enter fullscreen to continue your interview.
            </p>
            <button
              type="button"
              className="primary-button"
              style={{ width: "100%", marginTop: "18px" }}
              onClick={() => void reenterFullscreen()}
            >
              Re-enter Fullscreen & Continue
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function PreviewVideo({ stream }: { stream: MediaStream }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && videoRef.current.srcObject !== stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      style={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
        transform: "scaleX(-1)",
      }}
    />
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
    if (videoRef.current && videoRef.current.srcObject !== stream) {
      videoRef.current.srcObject = stream;
    }
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
