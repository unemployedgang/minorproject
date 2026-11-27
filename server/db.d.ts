export interface RoomRow {
  id: string;
  password_hash: string;
  status: "active" | "ended" | "expired";
  created_at: number;
  expires_at: number;
  ended_at: number | null;
  language: string;
  code_snapshot: string;
  yjs_state: string | null;
}

export function getDb(): unknown;
export function createRoom(params: {
  id: string;
  passwordHash: string;
  expiresAt: number;
  language?: string;
}): RoomRow;
export function getRoomById(roomId: string): RoomRow | null;
export function saveRoomYjsState(
  roomId: string,
  params: {
    yjsStateBase64?: string | null;
    codeSnapshot?: string | null;
    language?: string | null;
  },
): void;
export function endRoom(
  roomId: string,
  params?: {
    codeSnapshot?: string | null;
    language?: string | null;
    yjsStateBase64?: string | null;
  },
): RoomRow | null;
export function getActiveParticipantCount(roomId: string): number;
export function registerActiveParticipant(params: {
  socketId: string;
  roomId: string;
  participantId: string;
  name: string;
}): void;
export function unregisterActiveParticipant(socketId: string): void;
export function clearAllActiveParticipants(): void;
export function logExecution(params: {
  roomId: string;
  ranBy: string;
  language: string;
  statusDescription: string;
  exitCode: number | null;
  timeSec: string | null;
  memoryKb: number | null;
}): void;
export function cleanupExpiredRooms(): string[];
