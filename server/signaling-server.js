const { createServer } = require("node:http");
const { Server } = require("socket.io");
const { loadEnv, getAllowedOrigins } = require("./env");
const { verifyRoomToken } = require("./auth");
const {
  getDb,
  getRoomById,
  endRoom,
  registerActiveParticipant,
  unregisterActiveParticipant,
  clearAllActiveParticipants,
  cleanupExpiredRooms,
} = require("./db");
const {
  getOrCreateRoom,
  syncSocketOnJoin,
  handleSyncMessage,
  handleAwarenessMessage,
  removeSocketFromRoom,
  destroyRoom,
  setRoomLastExecution,
  persistAllActiveRooms,
} = require("./yjs-rooms");

loadEnv();
getDb();
clearAllActiveParticipants();

const MAX_PARTICIPANTS = 2;
const port = Number(process.env.SIGNALING_PORT || 3001);
const allowedOrigins = getAllowedOrigins();

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 2 * 1024 * 1024,
});

const roomParticipants = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const auth = verifyRoomToken(token);
  if (!auth) {
    next(new Error("Unauthorized: missing or invalid room token."));
    return;
  }

  const room = getRoomById(auth.roomId);
  if (!room || room.status !== "active" || room.expires_at <= Date.now()) {
    next(new Error("This interview room has ended or expired."));
    return;
  }

  socket.data.auth = auth;
  next();
});

io.on("connection", (socket) => {
  const auth = socket.data.auth;

  socket.on("room:join", ({ roomId } = {}, acknowledge = () => {}) => {
    if (typeof roomId !== "string" || roomId !== auth.roomId) {
      acknowledge({ ok: false, error: "Token is not valid for this room." });
      return;
    }

    if (socket.data.roomId) {
      acknowledge({ ok: false, error: "You have already joined a room." });
      return;
    }

    const roomRow = getRoomById(roomId);
    if (!roomRow || roomRow.status !== "active" || roomRow.expires_at <= Date.now()) {
      acknowledge({ ok: false, error: "This interview room has ended or expired." });
      return;
    }

    const participants = roomParticipants.get(roomId) || new Map();

    // Prevent a 3rd participant from entering (allow same participantId reconnect cleanup)
    const otherParticipants = Array.from(participants.entries()).filter(
      ([, participant]) => participant.participantId !== auth.participantId,
    );
    if (otherParticipants.length >= MAX_PARTICIPANTS) {
      acknowledge({
        ok: false,
        error: "This room is full (maximum 2 participants).",
      });
      return;
    }

    // If same participantId has a stale socket still lingering, disconnect the old socket
    for (const [existingSocketId, participant] of participants.entries()) {
      if (participant.participantId === auth.participantId) {
        participants.delete(existingSocketId);
        unregisterActiveParticipant(existingSocketId);
        io.sockets.sockets.get(existingSocketId)?.disconnect(true);
        socket.to(roomId).emit("room:peer-left", { id: existingSocketId });
      }
    }

    const existingParticipants = Array.from(participants, ([id, participant]) => ({
      id,
      name: participant.name,
    }));

    const participantName = auth.name.trim().slice(0, 60) || "Guest";
    participants.set(socket.id, {
      name: participantName,
      participantId: auth.participantId,
    });
    roomParticipants.set(roomId, participants);
    socket.data.roomId = roomId;
    socket.data.name = participantName;
    socket.join(roomId);

    registerActiveParticipant({
      socketId: socket.id,
      roomId,
      participantId: auth.participantId,
      name: participantName,
    });

    const yjsRoom = getOrCreateRoom(roomId, io);

    acknowledge({
      ok: true,
      participantId: socket.id,
      participants: existingParticipants,
      lastExecution: yjsRoom.lastExecution,
      expiresAt: roomRow.expires_at,
    });
    socket.to(roomId).emit("room:peer-joined", {
      id: socket.id,
      name: participantName,
    });
  });

  socket.on("room:signal", ({ targetId, signal } = {}) => {
    const roomId = socket.data.roomId;
    if (
      !roomId ||
      typeof targetId !== "string" ||
      !signal ||
      !roomParticipants.get(roomId)?.has(targetId)
    ) {
      return;
    }

    io.to(targetId).emit("room:signal", {
      fromId: socket.id,
      fromName: socket.data.name,
      signal,
    });
  });

  socket.on("room:end", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const snapshot = destroyRoom(roomId);
    const ended = endRoom(roomId, snapshot || undefined);
    roomParticipants.delete(roomId);

    io.to(roomId).emit("room:ended", {
      reason: "ended",
      endedAt: ended?.ended_at || Date.now(),
      byName: socket.data.name,
    });
  });

  socket.on("yjs:ready", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    syncSocketOnJoin(roomId, socket, io);
  });

  socket.on("yjs:sync", (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    handleSyncMessage(roomId, socket, payload, io);
  });

  socket.on("yjs:awareness", (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    handleAwarenessMessage(roomId, socket, payload, io);
  });

  socket.on("code:running", ({ language } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId || typeof language !== "string") return;
    socket.to(roomId).emit("code:running", {
      byName: socket.data.name || "Peer",
      language,
    });
  });

  socket.on("code:result", (result) => {
    const roomId = socket.data.roomId;
    if (!roomId || !result || typeof result !== "object") return;
    const enriched = {
      ...result,
      ranBy: result.ranBy || socket.data.name || "Peer",
    };
    setRoomLastExecution(roomId, enriched);
    socket.to(roomId).emit("code:result", enriched);
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    unregisterActiveParticipant(socket.id);

    const participants = roomParticipants.get(roomId);
    participants?.delete(socket.id);
    const remainingCount = participants?.size ?? 0;
    if (remainingCount === 0) roomParticipants.delete(roomId);

    removeSocketFromRoom(roomId, socket.id, remainingCount);
    socket.to(roomId).emit("room:peer-left", { id: socket.id });
  });
});

// Periodic garbage collection for expired rooms & retention purge
const gcInterval = setInterval(() => {
  try {
    const expiredRoomIds = cleanupExpiredRooms();
    for (const roomId of expiredRoomIds) {
      destroyRoom(roomId);
      roomParticipants.delete(roomId);
      io.to(roomId).emit("room:ended", {
        reason: "expired",
        endedAt: Date.now(),
      });
      io.in(roomId).disconnectSockets(true);
    }
  } catch (err) {
    console.error("Room cleanup error:", err);
  }
}, 60_000);
gcInterval.unref();

httpServer.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(
      `Port ${port} is already in use. Stop the existing process on port ${port} or set SIGNALING_PORT.`,
    );
    process.exit(1);
  }
  console.error("Signaling server error:", err);
  process.exit(1);
});

function shutdown() {
  clearInterval(gcInterval);
  persistAllActiveRooms();
  clearAllActiveParticipants();
  io.close(() => {
    httpServer.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

httpServer.listen(port, () => {
  console.log(`Signaling & Yjs server listening on port ${port}`);
});
