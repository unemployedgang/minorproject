export type Participant = {
  id: string;
  name: string;
};

export type Signal =
  | { type: "description"; description: RTCSessionDescriptionInit }
  | { type: "candidate"; candidate: RTCIceCandidateInit };

export type JoinResponse =
  | { ok: true; participantId: string; participants: Participant[] }
  | { ok: false; error: string };

export interface ClientToServerEvents {
  "room:join": (
    request: { roomId: string; name: string },
    acknowledge: (response: JoinResponse) => void,
  ) => void;
  "room:signal": (request: { targetId: string; signal: Signal }) => void;
}

export interface ServerToClientEvents {
  "room:peer-joined": (participant: Participant) => void;
  "room:peer-left": (participant: { id: string }) => void;
  "room:signal": (message: {
    fromId: string;
    fromName: string;
    signal: Signal;
  }) => void;
}
