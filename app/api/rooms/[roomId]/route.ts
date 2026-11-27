import { NextResponse } from "next/server";
import { getActiveParticipantCount, getRoomById } from "@/server/db";

const ROOM_ID_REGEX = /^[a-zA-Z0-9-]{8,64}$/;

export async function GET(
  _request: Request,
  context: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await context.params;
  if (!ROOM_ID_REGEX.test(roomId)) {
    return NextResponse.json({ exists: false, status: "invalid" }, { status: 400 });
  }

  const room = getRoomById(roomId);
  if (!room) {
    return NextResponse.json({ exists: false, status: "not_found" }, { status: 404 });
  }

  return NextResponse.json({
    exists: true,
    status: room.status,
    expiresAt: room.expires_at,
    endedAt: room.ended_at,
    participantCount: getActiveParticipantCount(roomId),
  });
}
