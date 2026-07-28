import { createRoom } from "@/server/room-store";
import {
  NO_STORE_HEADERS,
  playerTokenFrom,
  roomErrorResponse,
} from "@/server/room-route-utils";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      name?: unknown;
      playerCount?: unknown;
      maxHand?: unknown;
    };
    const room = await createRoom({
      name: typeof payload.name === "string" ? payload.name : "",
      playerCount: Number(payload.playerCount),
      maxHand: Number(payload.maxHand),
      playerToken: playerTokenFrom(request),
      sourceKey: request.headers.get("cf-connecting-ip") ?? undefined,
    });
    return Response.json({ room }, { status: 201, headers: NO_STORE_HEADERS });
  } catch (error) {
    return roomErrorResponse(error);
  }
}
