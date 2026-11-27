import { NextResponse } from "next/server";
import {
  extractBearerToken,
  isAllowedOrigin,
  verifyRoomToken,
} from "@/server/auth";
import { endRoom, getRoomById } from "@/server/db";

export async function POST(
  request: Request,
  context: { params: Promise<{ roomId: string }> },
) {
  if (!isAllowedOrigin(request)) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403 });
  }

  const { roomId } = await context.params;
  const auth = verifyRoomToken(extractBearerToken(request));
  if (!auth || auth.roomId !== roomId) {
    return NextResponse.json(
      { error: "Unauthorized room session." },
      { status: 401 },
    );
  }

  const room = getRoomById(roomId);
  if (!room) {
    return NextResponse.json({ error: "Room not found." }, { status: 404 });
  }

  let codeSnapshot: string | undefined;
  let language: string | undefined;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body?.codeSnapshot === "string") {
      codeSnapshot = body.codeSnapshot.slice(0, 100_000);
    }
    if (typeof body?.language === "string") {
      language = body.language.slice(0, 32);
    }
  } catch {
    // Empty body is valid
  }

  const ended = endRoom(roomId, { codeSnapshot, language });
  return NextResponse.json({
    ok: true,
    status: ended?.status ?? "ended",
    endedAt: ended?.ended_at ?? Date.now(),
  });
}
