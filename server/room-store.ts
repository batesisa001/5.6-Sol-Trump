import { ensureRoomSchema } from "@/db/init";
import { getD1 } from "@/db";
import {
  RoomRuleError,
  addPlayerToLobby,
  applyOnlineRoomAction,
  createOnlineLobby,
  toOnlineRoomView,
  withRecordedAction,
  type OnlineRoomAction,
  type OnlineRoomState,
  type OnlineRoomView,
} from "@/lib/multiplayer-engine";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAX_WRITE_ATTEMPTS = 5;
const CREATION_WINDOW_MS = 60 * 60 * 1_000;
const MAX_ROOMS_PER_SOURCE_WINDOW = 20;

interface RoomRow {
  code: string;
  state: string;
  revision: number;
  expires_at: number;
}

export class RoomStoreError extends Error {
  readonly status: number;
  readonly code: string;
  readonly room?: OnlineRoomView;

  constructor(
    message: string,
    status: number,
    code: string,
    room?: OnlineRoomView,
  ) {
    super(message);
    this.name = "RoomStoreError";
    this.status = status;
    this.code = code;
    this.room = room;
  }
}

function randomString(length: number, alphabet: string): string {
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  return Array.from(
    values,
    (value) => alphabet[value % alphabet.length],
  ).join("");
}

function createRoomCode(): string {
  return randomString(6, CODE_ALPHABET);
}

function createPlayerId(): string {
  return `p_${crypto.randomUUID().replaceAll("-", "")}`;
}

function secureRandomUnit(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] / 4_294_967_296;
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function validatePlayerToken(token: string): void {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    throw new RoomStoreError(
      "Your player key is invalid. Join the table again.",
      401,
      "INVALID_TOKEN",
    );
  }
}

async function hashToken(token: string): Promise<string> {
  validatePlayerToken(token);
  return hashValue(token);
}

async function hashValue(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseState(row: RoomRow): OnlineRoomState {
  try {
    return JSON.parse(row.state) as OnlineRoomState;
  } catch {
    throw new RoomStoreError(
      "This table could not be loaded.",
      500,
      "CORRUPT_ROOM",
    );
  }
}

async function loadRow(codeInput: string): Promise<RoomRow> {
  await ensureRoomSchema();
  const code = normalizeCode(codeInput);
  if (!/^[A-Z2-9]{6}$/.test(code)) {
    throw new RoomStoreError(
      "Enter a valid six-character table code.",
      400,
      "INVALID_CODE",
    );
  }

  const row = await getD1()
    .prepare(
      `
        SELECT code, state, revision, expires_at
        FROM game_rooms
        WHERE code = ?
      `,
    )
    .bind(code)
    .first<RoomRow>();

  if (!row || row.expires_at <= Date.now()) {
    throw new RoomStoreError(
      "That table was not found or has expired.",
      404,
      "ROOM_NOT_FOUND",
    );
  }
  return row;
}

async function resolveActor(
  state: OnlineRoomState,
  playerToken: string,
): Promise<string> {
  const tokenHash = await hashToken(playerToken);
  const player = state.players.find(
    (candidate) => candidate.tokenHash === tokenHash,
  );
  if (!player) {
    throw new RoomStoreError(
      "This browser does not have a seat at that table.",
      401,
      "INVALID_TOKEN",
    );
  }
  return player.id;
}

function roomRuleToStoreError(error: unknown): never {
  if (error instanceof RoomStoreError) throw error;
  if (error instanceof RoomRuleError) {
    throw new RoomStoreError(error.message, error.status, error.code);
  }
  throw error;
}

export async function createRoom(input: {
  name: string;
  playerCount: number;
  maxHand: number;
  playerToken: string;
  sourceKey?: string;
}): Promise<OnlineRoomView> {
  await ensureRoomSchema();
  const tokenHash = await hashToken(input.playerToken);
  const creatorHash = input.sourceKey
    ? await hashValue(input.sourceKey)
    : null;
  const playerId = createPlayerId();
  const now = Date.now();

  // Room codes are short-lived invitations. Clean up abandoned tables on
  // creation so expired room state cannot accumulate indefinitely.
  await getD1()
    .prepare("DELETE FROM game_rooms WHERE expires_at <= ?")
    .bind(now)
    .run();

  if (creatorHash) {
    const usage = await getD1()
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM game_rooms
          WHERE creator_hash = ? AND created_at >= ?
        `,
      )
      .bind(creatorHash, now - CREATION_WINDOW_MS)
      .first<{ count: number }>();
    if ((usage?.count ?? 0) >= MAX_ROOMS_PER_SOURCE_WINDOW) {
      throw new RoomStoreError(
        "Too many tables were created from this connection. Try again later.",
        429,
        "CREATE_RATE_LIMITED",
      );
    }
  }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = createRoomCode();
    let state: OnlineRoomState;
    try {
      state = createOnlineLobby({
        code,
        playerCount: input.playerCount,
        maxHand: input.maxHand,
        hostId: playerId,
        hostTokenHash: tokenHash,
        hostName: input.name,
      });
    } catch (error) {
      roomRuleToStoreError(error);
    }

    const result = await getD1()
      .prepare(
        `
          INSERT OR IGNORE INTO game_rooms
            (
              code,
              state,
              revision,
              creator_hash,
              created_at,
              updated_at,
              expires_at
            )
          VALUES (?, ?, 1, ?, ?, ?, ?)
        `,
      )
      .bind(
        code,
        JSON.stringify(state!),
        creatorHash,
        now,
        now,
        now + ROOM_LIFETIME_MS,
      )
      .run();

    if ((result.meta.changes ?? 0) === 1) {
      return toOnlineRoomView(state!, playerId, 1);
    }
  }

  throw new RoomStoreError(
    "Could not reserve a table code. Please try again.",
    503,
    "CODE_UNAVAILABLE",
  );
}

export async function joinRoom(input: {
  code: string;
  name: string;
  playerToken: string;
}): Promise<OnlineRoomView> {
  const tokenHash = await hashToken(input.playerToken);
  const playerId = createPlayerId();

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const row = await loadRow(input.code);
    const state = parseState(row);
    const existingPlayer = state.players.find(
      (player) => player.tokenHash === tokenHash,
    );
    if (existingPlayer) {
      return toOnlineRoomView(state, existingPlayer.id, row.revision);
    }

    let nextState: OnlineRoomState;
    try {
      nextState = addPlayerToLobby(state, {
        playerId,
        tokenHash,
        name: input.name,
      });
    } catch (error) {
      roomRuleToStoreError(error);
    }

    const now = Date.now();
    const result = await getD1()
      .prepare(
        `
          UPDATE game_rooms
          SET state = ?, revision = revision + 1, updated_at = ?, expires_at = ?
          WHERE code = ? AND revision = ?
        `,
      )
      .bind(
        JSON.stringify(nextState!),
        now,
        now + ROOM_LIFETIME_MS,
        row.code,
        row.revision,
      )
      .run();

    if ((result.meta.changes ?? 0) === 1) {
      return toOnlineRoomView(nextState!, playerId, row.revision + 1);
    }
  }

  throw new RoomStoreError(
    "The table changed while you were joining. Please try again.",
    409,
    "JOIN_CONFLICT",
  );
}

export async function getRoom(
  code: string,
  playerToken: string,
): Promise<OnlineRoomView> {
  const row = await loadRow(code);
  const state = parseState(row);
  const actorId = await resolveActor(state, playerToken);
  return toOnlineRoomView(state, actorId, row.revision);
}

export async function performRoomAction(input: {
  code: string;
  playerToken: string;
  actionId: string;
  expectedRevision: number;
  action: OnlineRoomAction;
}): Promise<OnlineRoomView> {
  if (!/^[A-Za-z0-9_-]{12,100}$/.test(input.actionId)) {
    throw new RoomStoreError(
      "The action identifier is invalid.",
      400,
      "INVALID_ACTION_ID",
    );
  }
  if (
    !Number.isInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  ) {
    throw new RoomStoreError(
      "The room revision is invalid.",
      400,
      "INVALID_REVISION",
    );
  }

  const row = await loadRow(input.code);
  const state = parseState(row);
  const actorId = await resolveActor(state, input.playerToken);

  if (state.recentActionIds.includes(input.actionId)) {
    return toOnlineRoomView(state, actorId, row.revision);
  }

  if (row.revision !== input.expectedRevision) {
    throw new RoomStoreError(
      "The table moved before that action arrived. Your view has been refreshed.",
      409,
      "STALE_REVISION",
      toOnlineRoomView(state, actorId, row.revision),
    );
  }

  let nextState: OnlineRoomState;
  try {
    nextState = withRecordedAction(
      applyOnlineRoomAction(
        state,
        actorId,
        input.action,
        secureRandomUnit,
      ),
      input.actionId,
    );
  } catch (error) {
    roomRuleToStoreError(error);
  }

  const now = Date.now();
  const result = await getD1()
    .prepare(
      `
        UPDATE game_rooms
        SET state = ?, revision = revision + 1, updated_at = ?, expires_at = ?
        WHERE code = ? AND revision = ?
      `,
    )
    .bind(
      JSON.stringify(nextState!),
      now,
      now + ROOM_LIFETIME_MS,
      row.code,
      row.revision,
    )
    .run();

  if ((result.meta.changes ?? 0) !== 1) {
    const latestRow = await loadRow(row.code);
    const latestState = parseState(latestRow);
    const latestActorId = await resolveActor(
      latestState,
      input.playerToken,
    );
    if (latestState.recentActionIds.includes(input.actionId)) {
      return toOnlineRoomView(
        latestState,
        latestActorId,
        latestRow.revision,
      );
    }
    throw new RoomStoreError(
      "Another player acted first. Your view has been refreshed.",
      409,
      "STALE_REVISION",
      toOnlineRoomView(
        latestState,
        latestActorId,
        latestRow.revision,
      ),
    );
  }

  return toOnlineRoomView(nextState!, actorId, row.revision + 1);
}
