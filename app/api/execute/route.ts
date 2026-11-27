import { NextResponse } from "next/server";
import { executeWithJudge0 } from "@/lib/judge0";
import { SUPPORTED_LANGUAGES } from "@/lib/languages";
import {
  checkRateLimit,
  extractBearerToken,
  extractClientIp,
  isAllowedOrigin,
  verifyRoomToken,
} from "@/server/auth";
import { getRoomById, logExecution } from "@/server/db";

const MAX_CODE_BYTES = 100_000;
const MAX_STDIN_BYTES = 100_000;

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403 });
  }

  const auth = verifyRoomToken(extractBearerToken(request));
  if (!auth) {
    return NextResponse.json(
      { error: "Unauthorized. Join a room with a valid password first." },
      { status: 401 },
    );
  }

  const room = getRoomById(auth.roomId);
  if (!room || room.status !== "active" || room.expires_at <= Date.now()) {
    return NextResponse.json(
      { error: "This interview session is no longer active." },
      { status: 403 },
    );
  }

  const ip = extractClientIp(request);
  const participantLimit = checkRateLimit({
    key: `exec:user:${auth.roomId}:${auth.participantId}`,
    maxAttempts: 15,
    windowMs: 60 * 1000,
  });
  if (!participantLimit.allowed) {
    return NextResponse.json(
      {
        error: `Execution rate limit reached. Wait ${participantLimit.retryAfterSeconds}s before running again.`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(participantLimit.retryAfterSeconds) },
      },
    );
  }

  const ipLimit = checkRateLimit({
    key: `exec:ip:${ip}`,
    maxAttempts: 30,
    windowMs: 60 * 1000,
  });
  if (!ipLimit.allowed) {
    return NextResponse.json(
      {
        error: `Too many executions from this network. Wait ${ipLimit.retryAfterSeconds}s.`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(ipLimit.retryAfterSeconds) },
      },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON request body." },
      { status: 400 },
    );
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "Request body must be an object." },
      { status: 400 },
    );
  }

  const { sourceCode, language, stdin } = body as Record<string, unknown>;

  if (typeof sourceCode !== "string" || !sourceCode.trim()) {
    return NextResponse.json(
      { error: "Source code cannot be empty." },
      { status: 400 },
    );
  }

  if (Buffer.byteLength(sourceCode, "utf-8") > MAX_CODE_BYTES) {
    return NextResponse.json(
      { error: "Source code exceeds the 100 KB limit." },
      { status: 413 },
    );
  }

  if (
    typeof language !== "string" ||
    !SUPPORTED_LANGUAGES.some((item) => item.id === language)
  ) {
    return NextResponse.json(
      { error: "Unsupported programming language." },
      { status: 400 },
    );
  }

  const normalizedStdin = typeof stdin === "string" ? stdin : "";
  if (Buffer.byteLength(normalizedStdin, "utf-8") > MAX_STDIN_BYTES) {
    return NextResponse.json(
      { error: "Standard input exceeds the 100 KB limit." },
      { status: 413 },
    );
  }

  const result = await executeWithJudge0({
    sourceCode,
    language,
    stdin: normalizedStdin,
  });

  logExecution({
    roomId: auth.roomId,
    ranBy: auth.name,
    language: result.language,
    statusDescription: result.statusDescription,
    exitCode: result.exitCode,
    timeSec: result.time,
    memoryKb: result.memory,
  });

  return NextResponse.json(
    { ...result, ranBy: auth.name },
    { status: result.error ? 502 : 200 },
  );
}
