import { joinRoom } from "@/server/room-store";
import {
  NO_STORE_HEADERS,
  playerTokenFrom,
  roomErrorResponse,
} from "@/server/room-route-utils";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  try {
    const { code } = await context.params;
    const payload = (await request.json()) as { name?: unknown };
    const room = await joinRoom({
      code,
      name: typeof payload.name === "string" ? payload.name : "",
      playerToken: playerTokenFrom(request),
    });
    return Response.json({ room }, { status: 201, headers: NO_STORE_HEADERS });
  } catch (error) {
    return roomErrorResponse(error);
  }
}
