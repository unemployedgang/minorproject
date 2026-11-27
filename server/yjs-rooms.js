const Y = require("yjs");
const syncProtocol = require("y-protocols/sync");
const awarenessProtocol = require("y-protocols/awareness");
const encoding = require("lib0/encoding");
const decoding = require("lib0/decoding");
const { getRoomById, saveRoomYjsState } = require("./db");

const rooms = new Map();

function toUint8Array(payload) {
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (Buffer.isBuffer(payload)) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  return null;
}

function getRoomSnapshot(room) {
  const state = Y.encodeStateAsUpdate(room.doc);
  const yjsStateBase64 = Buffer.from(state).toString("base64");
  const codeSnapshot = room.doc.getText("code").toString();
  const lang = room.doc.getMap("roomState").get("language");
  const language = typeof lang === "string" && lang ? lang : "python";
  return { yjsStateBase64, codeSnapshot, language };
}

function persistRoomNow(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  if (room.persistTimer) {
    clearTimeout(room.persistTimer);
    room.persistTimer = null;
  }
  const snapshot = getRoomSnapshot(room);
  try {
    saveRoomYjsState(roomId, snapshot);
  } catch (err) {
    console.error(`Failed to persist Yjs state for room ${roomId}:`, err);
  }
  return snapshot;
}

function schedulePersist(roomId, room) {
  if (room.persistTimer) return;
  room.persistTimer = setTimeout(() => {
    room.persistTimer = null;
    persistRoomNow(roomId);
  }, 1000);
}

function getOrCreateRoom(roomId, io) {
  let room = rooms.get(roomId);
  if (room) return room;

  const doc = new Y.Doc();
  const dbRow = getRoomById(roomId);
  if (dbRow?.yjs_state) {
    try {
      const savedBytes = Buffer.from(dbRow.yjs_state, "base64");
      if (savedBytes.byteLength > 0) {
        Y.applyUpdate(doc, new Uint8Array(savedBytes), "db-hydrate");
      }
    } catch (err) {
      console.error(`Failed to hydrate Yjs state for room ${roomId}:`, err);
    }
  }

  const awareness = new awarenessProtocol.Awareness(doc);
  const socketClientIds = new Map();

  awareness.setLocalState(null);

  room = {
    doc,
    awareness,
    socketClientIds,
    lastExecution: null,
    persistTimer: null,
  };

  doc.on("update", (update, origin) => {
    if (origin === "db-hydrate") return;

    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);

    if (typeof origin === "string" && origin) {
      io.to(roomId).except(origin).emit("yjs:sync", message);
    } else {
      io.to(roomId).emit("yjs:sync", message);
    }

    schedulePersist(roomId, room);
  });

  awareness.on("update", ({ added, updated, removed }, origin) => {
    const changedClients = added.concat(updated, removed);
    if (changedClients.length === 0) return;

    if (typeof origin === "string" && origin) {
      let controlled = socketClientIds.get(origin);
      if (!controlled) {
        controlled = new Set();
        socketClientIds.set(origin, controlled);
      }
      for (const id of added) controlled.add(id);
      for (const id of removed) controlled.delete(id);
    }

    const encoded = awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients);
    if (typeof origin === "string" && origin) {
      io.to(roomId).except(origin).emit("yjs:awareness", encoded);
    } else {
      io.to(roomId).emit("yjs:awareness", encoded);
    }
  });

  rooms.set(roomId, room);
  return room;
}

function syncSocketOnJoin(roomId, socket, io) {
  const room = getOrCreateRoom(roomId, io);
  room.socketClientIds.set(socket.id, new Set());

  const syncEncoder = encoding.createEncoder();
  syncProtocol.writeSyncStep1(syncEncoder, room.doc);
  socket.emit("yjs:sync", encoding.toUint8Array(syncEncoder));

  const awarenessStates = room.awareness.getStates();
  if (awarenessStates.size > 0) {
    const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(
      room.awareness,
      Array.from(awarenessStates.keys()),
    );
    socket.emit("yjs:awareness", awarenessUpdate);
  }

  return room;
}

function handleSyncMessage(roomId, socket, payload, io) {
  const bytes = toUint8Array(payload);
  if (!bytes || bytes.byteLength === 0) return;

  const room = getOrCreateRoom(roomId, io);
  const decoder = decoding.createDecoder(bytes);
  const encoder = encoding.createEncoder();
  syncProtocol.readSyncMessage(decoder, encoder, room.doc, socket.id);

  if (encoding.length(encoder) > 0) {
    socket.emit("yjs:sync", encoding.toUint8Array(encoder));
  }
}

function handleAwarenessMessage(roomId, socket, payload, io) {
  const bytes = toUint8Array(payload);
  if (!bytes || bytes.byteLength === 0) return;

  const room = getOrCreateRoom(roomId, io);
  awarenessProtocol.applyAwarenessUpdate(room.awareness, bytes, socket.id);
}

function destroyRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const snapshot = persistRoomNow(roomId);
  room.awareness.destroy();
  room.doc.destroy();
  rooms.delete(roomId);
  return snapshot;
}

function removeSocketFromRoom(roomId, socketId, remainingCount) {
  const room = rooms.get(roomId);
  if (!room) return;

  const controlled = room.socketClientIds.get(socketId);
  room.socketClientIds.delete(socketId);

  if (controlled && controlled.size > 0) {
    awarenessProtocol.removeAwarenessStates(
      room.awareness,
      Array.from(controlled),
      null,
    );
  }

  if (remainingCount === 0) {
    destroyRoom(roomId);
  }
}

function setRoomLastExecution(roomId, result) {
  const room = rooms.get(roomId);
  if (room) {
    room.lastExecution = result;
  }
}

function persistAllActiveRooms() {
  for (const roomId of rooms.keys()) {
    persistRoomNow(roomId);
  }
}

module.exports = {
  getOrCreateRoom,
  syncSocketOnJoin,
  handleSyncMessage,
  handleAwarenessMessage,
  removeSocketFromRoom,
  destroyRoom,
  setRoomLastExecution,
  persistAllActiveRooms,
};
