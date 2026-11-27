import type { ExecutionResult } from "./execution";

export type Participant = {
  id: string;
  name: string;
};

export type Signal =
  | { type: "description"; description: RTCSessionDescriptionInit }
  | { type: "candidate"; candidate: RTCIceCandidateInit };

export type JoinResponse =
  | {
      ok: true;
      participantId: string;
      participants: Participant[];
      lastExecution: ExecutionResult | null;
    }
  | { ok: false; error: string };

export interface ClientToServerEvents {
  "room:join": (
    request: { roomId: string; name: string },
    acknowledge: (response: JoinResponse) => void,
  ) => void;
  "room:signal": (request: { targetId: string; signal: Signal }) => void;
  "yjs:ready": () => void;
  "yjs:sync": (payload: ArrayBuffer | Uint8Array) => void;
  "yjs:awareness": (payload: ArrayBuffer | Uint8Array) => void;
  "code:running": (payload: { language: string }) => void;
  "code:result": (result: ExecutionResult) => void;
}

export interface ServerToClientEvents {
  "room:peer-joined": (participant: Participant) => void;
  "room:peer-left": (participant: { id: string }) => void;
  "room:signal": (message: {
    fromId: string;
    fromName: string;
    signal: Signal;
  }) => void;
  "yjs:sync": (payload: ArrayBuffer | Uint8Array) => void;
  "yjs:awareness": (payload: ArrayBuffer | Uint8Array) => void;
  "code:running": (payload: { byName: string; language: string }) => void;
  "code:result": (result: ExecutionResult) => void;
}
