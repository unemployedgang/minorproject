export interface StoredRoomAuth {
  roomId: string;
  token: string;
  participantId: string;
  name: string;
  expiresAt: number;
}

const STORAGE_PREFIX = "interview-room-auth:";

export function getStoredRoomAuth(roomId: string): StoredRoomAuth | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(`${STORAGE_PREFIX}${roomId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredRoomAuth>;
    if (
      !parsed ||
      typeof parsed.token !== "string" ||
      typeof parsed.participantId !== "string" ||
      typeof parsed.name !== "string" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }
    if (parsed.expiresAt <= Date.now()) {
      sessionStorage.removeItem(`${STORAGE_PREFIX}${roomId}`);
      return null;
    }
    return {
      roomId,
      token: parsed.token,
      participantId: parsed.participantId,
      name: parsed.name,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

export function saveStoredRoomAuth(auth: StoredRoomAuth): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(`${STORAGE_PREFIX}${auth.roomId}`, JSON.stringify(auth));
  sessionStorage.setItem("interview-room-name", auth.name);
}

export function clearStoredRoomAuth(roomId: string): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(`${STORAGE_PREFIX}${roomId}`);
}
