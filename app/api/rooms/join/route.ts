import crypto from "node:crypto";
import { NextResponse } from "next/server";
import {
  checkRateLimit,
  clearRateLimit,
  extractClientIp,
  isAllowedOrigin,
  signRoomToken,
  verifyPassword,
} from "@/server/auth";
import { getActiveParticipantCount, getRoomById } from "@/server/db";

const ROOM_ID_REGEX = /^[a-zA-Z0-9-]{8,64}$/;
const MAX_PARTICIPANTS = 2;

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { roomId, name, password } = body as Record<string, unknown>;
  if (typeof roomId !== "string" || !ROOM_ID_REGEX.test(roomId)) {
    return NextResponse.json(
      { error: "Enter a valid room code or link." },
      { status: 400 },
    );
  }

  const participantName = typeof name === "string" ? name.trim().slice(0, 60) : "";
  if (!participantName) {
    return NextResponse.json(
      { error: "Enter your name to join the room." },
      { status: 400 },
    );
  }

  if (typeof password !== "string" || !password) {
    return NextResponse.json(
      { error: "Enter the room password." },
      { status: 400 },
    );
  }

  const ip = extractClientIp(request);
  const lockKey = `join:${ip}:${roomId}`;
  const preCheck = checkRateLimit({
    key: lockKey,
    maxAttempts: 5,
    windowMs: 10 * 60 * 1000,
    lockoutMs: 10 * 60 * 1000,
    increment: false,
  });

  if (!preCheck.allowed) {
    return NextResponse.json(
      {
        error: `Too many failed attempts. Locked out for ${preCheck.retryAfterSeconds}s.`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(preCheck.retryAfterSeconds) },
      },
    );
  }

  const room = getRoomById(roomId);
  if (!room) {
    checkRateLimit({
      key: lockKey,
      maxAttempts: 5,
      windowMs: 10 * 60 * 1000,
      lockoutMs: 10 * 60 * 1000,
      increment: true,
    });
    return NextResponse.json(
      { error: "Invalid room code or password." },
      { status: 401 },
    );
  }

  if (room.status === "ended") {
    return NextResponse.json(
      { error: "This interview session has already ended." },
      { status: 410 },
    );
  }

  if (room.status === "expired" || room.expires_at <= Date.now()) {
    return NextResponse.json(
      { error: "This room has expired." },
      { status: 410 },
    );
  }

  const valid = await verifyPassword(password, room.password_hash);
  if (!valid) {
    const failResult = checkRateLimit({
      key: lockKey,
      maxAttempts: 5,
      windowMs: 10 * 60 * 1000,
      lockoutMs: 10 * 60 * 1000,
      increment: true,
    });
    if (!failResult.allowed) {
      return NextResponse.json(
        {
          error: `Too many failed attempts. Locked out for ${failResult.retryAfterSeconds}s.`,
        },
        {
          status: 429,
          headers: { "Retry-After": String(failResult.retryAfterSeconds) },
        },
      );
    }
    return NextResponse.json(
      {
        error: `Invalid room code or password. ${failResult.remaining} attempt(s) remaining.`,
      },
      { status: 401 },
    );
  }

  clearRateLimit(lockKey);

  const activeCount = getActiveParticipantCount(roomId);
  if (activeCount >= MAX_PARTICIPANTS) {
    return NextResponse.json(
      { error: "This room already has 2 participants." },
      { status: 409 },
    );
  }

  const participantId = crypto.randomUUID();
  const token = signRoomToken({
    roomId,
    participantId,
    name: participantName,
    expiresAt: room.expires_at,
  });

  return NextResponse.json({
    ok: true,
    roomId,
    participantId,
    name: participantName,
    token,
    expiresAt: room.expires_at,
  });
}
