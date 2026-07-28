import {
  RoomStoreError,
  performRoomAction,
} from "@/server/room-store";
import type { Bid } from "@/lib/game-engine";
import type { OnlineRoomAction } from "@/lib/multiplayer-engine";
import {
  NO_STORE_HEADERS,
  playerTokenFrom,
  roomErrorResponse,
} from "@/server/room-route-utils";

export const dynamic = "force-dynamic";

function parseAction(value: unknown): OnlineRoomAction {
  if (!value || typeof value !== "object") {
    throw new RoomStoreError(
      "Action is required.",
      400,
      "INVALID_ACTION",
    );
  }
  const payload = value as Record<string, unknown>;
  switch (payload.type) {
    case "start":
    case "next-round":
    case "rematch":
      return { type: payload.type };
    case "bid": {
      const bid =
        payload.bid === "BOARD"
          ? "BOARD"
          : typeof payload.bid === "number"
            ? payload.bid
            : Number.NaN;
      return { type: "bid", bid: bid as Bid };
    }
    case "play":
      return {
        type: "play",
        cardId: typeof payload.cardId === "string" ? payload.cardId : "",
      };
    default:
      throw new RoomStoreError(
        "Action type is not supported.",
        400,
        "INVALID_ACTION",
      );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  try {
    const { code } = await context.params;
    const payload = (await request.json()) as {
      actionId?: unknown;
      expectedRevision?: unknown;
      action?: unknown;
    };
    const room = await performRoomAction({
      code,
      playerToken: playerTokenFrom(request),
      actionId:
        typeof payload.actionId === "string" ? payload.actionId : "",
      expectedRevision: Number(payload.expectedRevision),
      action: parseAction(payload.action),
    });
    return Response.json({ room }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return roomErrorResponse(error);
  }
}
