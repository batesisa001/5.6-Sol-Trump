import { RoomStoreError } from "./room-store";

export const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

export function playerTokenFrom(request: Request): string {
  return request.headers.get("x-high-trump-player") ?? "";
}

export function roomErrorResponse(error: unknown): Response {
  if (error instanceof RoomStoreError) {
    return Response.json(
      {
        error: error.message,
        code: error.code,
        room: error.room,
      },
      { status: error.status, headers: NO_STORE_HEADERS },
    );
  }

  if (error instanceof SyntaxError) {
    return Response.json(
      {
        error: "The request body must be valid JSON.",
        code: "INVALID_JSON",
      },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  console.error("Multiplayer room error", error);
  return Response.json(
    {
      error: "The multiplayer table is temporarily unavailable.",
      code: "ROOM_SERVICE_ERROR",
    },
    { status: 500, headers: NO_STORE_HEADERS },
  );
}
