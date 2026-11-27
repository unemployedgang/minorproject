import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@/types/signaling";

export type RoomSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const REMOTE_ORIGIN = "yjs-remote";

function toUint8Array(payload: ArrayBuffer | Uint8Array): Uint8Array {
  if (payload instanceof Uint8Array) return payload;
  return new Uint8Array(payload);
}

export class YjsSocketProvider {
  public readonly doc: Y.Doc;
  public readonly awareness: awarenessProtocol.Awareness;
  private readonly socket: RoomSocket;
  private readonly onSyncedCallbacks = new Set<() => void>();
  private hasSynced = false;
  private destroyed = false;

  constructor(socket: RoomSocket, doc: Y.Doc, awareness?: awarenessProtocol.Awareness) {
    this.socket = socket;
    this.doc = doc;
    this.awareness = awareness ?? new awarenessProtocol.Awareness(doc);

    this.doc.on("update", this.handleLocalDocUpdate);
    this.awareness.on("update", this.handleLocalAwarenessUpdate);

    this.socket.on("yjs:sync", this.handleServerSync);
    this.socket.on("yjs:awareness", this.handleServerAwareness);

    this.startSync();
  }

  public onSynced(callback: () => void): () => void {
    if (this.hasSynced) {
      callback();
      return () => {};
    }
    this.onSyncedCallbacks.add(callback);
    return () => {
      this.onSyncedCallbacks.delete(callback);
    };
  }

  public startSync(): void {
    if (this.destroyed) return;
    this.socket.emit("yjs:ready");

    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.socket.emit("yjs:sync", encoding.toUint8Array(encoder));

    const localState = this.awareness.getLocalState();
    if (localState !== null) {
      const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(
        this.awareness,
        [this.doc.clientID],
      );
      this.socket.emit("yjs:awareness", awarenessUpdate);
    }
  }

  private markSynced(): void {
    if (this.hasSynced) return;
    this.hasSynced = true;
    for (const cb of this.onSyncedCallbacks) {
      cb();
    }
    this.onSyncedCallbacks.clear();
  }

  private handleServerSync = (payload: ArrayBuffer | Uint8Array): void => {
    if (this.destroyed) return;
    const bytes = toUint8Array(payload);
    if (bytes.byteLength === 0) return;

    const decoder = decoding.createDecoder(bytes);
    const encoder = encoding.createEncoder();
    const messageType = syncProtocol.readSyncMessage(
      decoder,
      encoder,
      this.doc,
      REMOTE_ORIGIN,
    );

    if (encoding.length(encoder) > 0) {
      this.socket.emit("yjs:sync", encoding.toUint8Array(encoder));
    }

    if (messageType === syncProtocol.messageYjsSyncStep2) {
      this.markSynced();
    }
  };

  private handleServerAwareness = (payload: ArrayBuffer | Uint8Array): void => {
    if (this.destroyed) return;
    const bytes = toUint8Array(payload);
    if (bytes.byteLength === 0) return;
    awarenessProtocol.applyAwarenessUpdate(this.awareness, bytes, REMOTE_ORIGIN);
  };

  private handleLocalDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (this.destroyed || origin === REMOTE_ORIGIN) return;
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    this.socket.emit("yjs:sync", encoding.toUint8Array(encoder));
  };

  private handleLocalAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (this.destroyed || origin === REMOTE_ORIGIN) return;
    const changed = added.concat(updated, removed);
    if (changed.length === 0) return;
    const encoded = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed);
    this.socket.emit("yjs:awareness", encoded);
  };

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.socket.connected) {
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        [this.doc.clientID],
        "local",
      );
    }

    this.doc.off("update", this.handleLocalDocUpdate);
    this.awareness.off("update", this.handleLocalAwarenessUpdate);
    this.socket.off("yjs:sync", this.handleServerSync);
    this.socket.off("yjs:awareness", this.handleServerAwareness);
    this.onSyncedCallbacks.clear();
  }
}
