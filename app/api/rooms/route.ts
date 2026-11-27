import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { DEFAULT_LANGUAGE_ID } from "@/lib/languages";
import {
  checkRateLimit,
  extractClientIp,
  hashPassword,
  isAllowedOrigin,
  signRoomToken,
} from "@/server/auth";
import { createRoom } from "@/server/db";
import { getRoomTtlMs } from "@/server/env";

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403 });
  }

  const ip = extractClientIp(request);
  const createLimit = checkRateLimit({
    key: `create:${ip}`,
    maxAttempts: 20,
    windowMs: 10 * 60 * 1000,
    lockoutMs: 5 * 60 * 1000,
  });
  if (!createLimit.allowed) {
    return NextResponse.json(
      {
        error: `Too many rooms created. Try again in ${createLimit.retryAfterSeconds}s.`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(createLimit.retryAfterSeconds) },
      },
    );
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

  const { name, password, ttlMinutes } = body as Record<string, unknown>;
  const participantName = typeof name === "string" ? name.trim().slice(0, 60) : "";
  if (!participantName) {
    return NextResponse.json(
      { error: "Enter your name to create a room." },
      { status: 400 },
    );
  }

  if (typeof password !== "string" || password.length < 4 || password.length > 128) {
    return NextResponse.json(
      { error: "Room password must be between 4 and 128 characters." },
      { status: 400 },
    );
  }

  const defaultTtlMs = getRoomTtlMs();
  const ttlMs =
    typeof ttlMinutes === "number" && Number.isFinite(ttlMinutes)
      ? Math.min(Math.max(ttlMinutes, 15), 480) * 60 * 1000
      : defaultTtlMs;

  const roomId = crypto.randomUUID();
  const participantId = crypto.randomUUID();
  const expiresAt = Date.now() + ttlMs;
  const passwordHash = await hashPassword(password);

  createRoom({
    id: roomId,
    passwordHash,
    expiresAt,
    language: DEFAULT_LANGUAGE_ID,
  });

  const token = signRoomToken({
    roomId,
    participantId,
    name: participantName,
    expiresAt,
  });

  return NextResponse.json(
    {
      ok: true,
      roomId,
      participantId,
      name: participantName,
      token,
      expiresAt,
    },
    { status: 201 },
  );
}
