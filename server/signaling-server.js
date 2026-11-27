const { createServer } = require("node:http");
const { Server } = require("socket.io");

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

    acknowledge({
      ok: true,
      participantId: socket.id,
      participants: existingParticipants,
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

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const participants = roomParticipants.get(roomId);
    participants?.delete(socket.id);
    if (participants?.size === 0) roomParticipants.delete(roomId);

    socket.to(roomId).emit("room:peer-left", { id: socket.id });
  });
});

httpServer.listen(port, () => {
  console.log(`Signaling server listening on port ${port}`);
});
