const { createServer } = require("node:http");
const { Server } = require("socket.io");
const {
  getOrCreateRoom,
  syncSocketOnJoin,
  handleSyncMessage,
  handleAwarenessMessage,
  removeSocketFromRoom,
  setRoomLastExecution,
} = require("./yjs-rooms");

const port = Number(process.env.SIGNALING_PORT || 3001);
const allowedOrigins = (process.env.WEB_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim());
const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 2 * 1024 * 1024,
});

const roomParticipants = new Map();

io.on("connection", (socket) => {
  socket.on("room:join", ({ roomId, name } = {}, acknowledge = () => {}) => {
    if (typeof roomId !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(roomId)) {
      acknowledge({ ok: false, error: "That room code is not valid." });
      return;
    }

    if (socket.data.roomId) {
      acknowledge({ ok: false, error: "You have already joined a room." });
      return;
    }

    const participants = roomParticipants.get(roomId) || new Map();
    const existingParticipants = Array.from(participants, ([id, participant]) => ({
      id,
      name: participant.name,
    }));

    const participantName =
      typeof name === "string" && name.trim()
        ? name.trim().slice(0, 60)
        : "Guest";

    participants.set(socket.id, { name: participantName });
    roomParticipants.set(roomId, participants);
    socket.data.roomId = roomId;
    socket.data.name = participantName;
    socket.join(roomId);

    const yjsRoom = getOrCreateRoom(roomId, io);

    acknowledge({
      ok: true,
      participantId: socket.id,
      participants: existingParticipants,
      lastExecution: yjsRoom.lastExecution,
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

    const participants = roomParticipants.get(roomId);
    participants?.delete(socket.id);
    const remainingCount = participants?.size ?? 0;
    if (remainingCount === 0) roomParticipants.delete(roomId);

    removeSocketFromRoom(roomId, socket.id, remainingCount);
    socket.to(roomId).emit("room:peer-left", { id: socket.id });
  });
});

httpServer.listen(port, () => {
  console.log(`Signaling & Yjs server listening on port ${port}`);
});
