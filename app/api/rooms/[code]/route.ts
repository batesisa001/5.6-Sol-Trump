import { getRoom } from "@/server/room-store";
import {
  NO_STORE_HEADERS,
  playerTokenFrom,
  roomErrorResponse,
} from "@/server/room-route-utils";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  try {
    const { code } = await context.params;
    const room = await getRoom(code, playerTokenFrom(request));
    return Response.json({ room }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return roomErrorResponse(error);
  }
}
