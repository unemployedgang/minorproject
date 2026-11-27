export interface RoomTokenPayload {
  roomId: string;
  participantId: string;
  name: string;
  exp?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

export function hashPassword(password: string): Promise<string>;
export function verifyPassword(password: string, hash: string): Promise<boolean>;
export function signRoomToken(params: {
  roomId: string;
  participantId: string;
  name: string;
  expiresAt?: number;
}): string;
export function verifyRoomToken(token: string | null | undefined): RoomTokenPayload | null;
export function checkRateLimit(params: {
  key: string;
  maxAttempts: number;
  windowMs: number;
  lockoutMs?: number;
  increment?: boolean;
}): RateLimitResult;
export function clearRateLimit(key: string): void;
export function extractClientIp(request: Request): string;
export function extractBearerToken(request: Request): string | null;
export function isAllowedOrigin(request: Request): boolean;
