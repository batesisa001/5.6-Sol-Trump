import {
  buildRoundSchedule,
  dealRound,
  doesPlayBreakTrump,
  getLeadColor,
  getLegalCards,
  getMaxHandSize,
  getOpeningLeaderIndex,
  getTrickWinner,
  scoreBid,
  sortHand,
  validateBid,
  type Bid,
  type BidEntry,
  type Card,
  type PlayedCard,
  type RandomSource,
} from "./game-engine.ts";

export type OnlinePhase =
  | "lobby"
  | "bidding"
  | "playing"
  | "round-result"
  | "game-over";

export interface OnlinePlayer {
  id: string;
  tokenHash: string;
  name: string;
  seat: number;
  score: number;
  bid: Bid | null;
  tricks: number;
  hand: Card[];
  lastDelta: number | null;
}

export interface OnlineRoundResult {
  playerIndex: number;
  name: string;
  bid: Bid;
  tricks: number;
  delta: number;
  previousTotal: number;
  total: number;
}

export interface OnlineRoomState {
  code: string;
  hostPlayerId: string;
  playerCount: number;
  maxHand: number;
  phase: OnlinePhase;
  players: OnlinePlayer[];
  schedule: number[];
  roundIndex: number;
  handSize: number;
  dealerIndex: number;
  firstBidderIndex: number;
  currentPlayerIndex: number;
  trumpCard: Card | null;
  trumpBroken: boolean;
  trick: PlayedCard[];
  lastTrick: PlayedCard[];
  bidLog: BidEntry[];
  lastWinner: PlayedCard | null;
  roundResults: OnlineRoundResult[];
  recentActionIds: string[];
}

export interface PublicOnlinePlayer {
  id: string;
  name: string;
  seat: number;
  score: number;
  bid: Bid | null;
  tricks: number;
  handCount: number;
  lastDelta: number | null;
}

export interface OnlineRoomView {
  code: string;
  revision: number;
  myPlayerId: string;
  isHost: boolean;
  playerCount: number;
  maxHand: number;
  phase: OnlinePhase;
  players: PublicOnlinePlayer[];
  myHand: Card[];
  schedule: number[];
  roundIndex: number;
  handSize: number;
  dealerIndex: number;
  firstBidderIndex: number;
  currentPlayerIndex: number;
  trumpCard: Card | null;
  trumpBroken: boolean;
  trick: PlayedCard[];
  lastTrick: PlayedCard[];
  bidLog: BidEntry[];
  lastWinner: PlayedCard | null;
  roundResults: OnlineRoundResult[];
}

export type OnlineRoomAction =
  | { type: "start" }
  | { type: "bid"; bid: Bid }
  | { type: "play"; cardId: string }
  | { type: "next-round" }
  | { type: "rematch" };

export class RoomRuleError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "INVALID_ACTION") {
    super(message);
    this.name = "RoomRuleError";
    this.status = status;
    this.code = code;
  }
}

function assertRoomSettings(playerCount: number, maxHand: number) {
  if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 6) {
    throw new RoomRuleError("Choose between 2 and 6 players.");
  }

  const maximum = Math.min(18, getMaxHandSize(playerCount));
  if (!Number.isInteger(maxHand) || maxHand < 1 || maxHand > maximum) {
    throw new RoomRuleError(
      `Maximum hand must be between 1 and ${maximum} cards.`,
    );
  }
}

export function normalizePlayerName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 18);
}

export function createOnlineLobby(input: {
  code: string;
  playerCount: number;
  maxHand: number;
  hostId: string;
  hostTokenHash: string;
  hostName: string;
}): OnlineRoomState {
  assertRoomSettings(input.playerCount, input.maxHand);
  const hostName = normalizePlayerName(input.hostName);
  if (!hostName) {
    throw new RoomRuleError("Enter your name.");
  }

  return {
    code: input.code,
    hostPlayerId: input.hostId,
    playerCount: input.playerCount,
    maxHand: input.maxHand,
    phase: "lobby",
    players: [
      {
        id: input.hostId,
        tokenHash: input.hostTokenHash,
        name: hostName,
        seat: 0,
        score: 0,
        bid: null,
        tricks: 0,
        hand: [],
        lastDelta: null,
      },
    ],
    schedule: buildRoundSchedule(input.maxHand),
    roundIndex: 0,
    handSize: 1,
    dealerIndex: 0,
    firstBidderIndex: 0,
    currentPlayerIndex: 0,
    trumpCard: null,
    trumpBroken: false,
    trick: [],
    lastTrick: [],
    bidLog: [],
    lastWinner: null,
    roundResults: [],
    recentActionIds: [],
  };
}

export function addPlayerToLobby(
  state: OnlineRoomState,
  input: {
    playerId: string;
    tokenHash: string;
    name: string;
  },
): OnlineRoomState {
  if (state.phase !== "lobby") {
    throw new RoomRuleError(
      "This game has already started.",
      409,
      "GAME_STARTED",
    );
  }
  if (state.players.length >= state.playerCount) {
    throw new RoomRuleError("This table is full.", 409, "ROOM_FULL");
  }

  const name = normalizePlayerName(input.name);
  if (!name) {
    throw new RoomRuleError("Enter your name.");
  }
  if (
    state.players.some(
      (player) => player.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    )
  ) {
    throw new RoomRuleError(
      "That name is already seated at this table.",
      409,
      "NAME_TAKEN",
    );
  }

  const player: OnlinePlayer = {
    id: input.playerId,
    tokenHash: input.tokenHash,
    name,
    seat: state.players.length,
    score: 0,
    bid: null,
    tricks: 0,
    hand: [],
    lastDelta: null,
  };

  return {
    ...state,
    players: [...state.players, player],
  };
}

function startRound(
  state: OnlineRoomState,
  roundIndex: number,
  rng: RandomSource,
): OnlineRoomState {
  const handSize = state.schedule[roundIndex];
  if (!handSize) {
    throw new RoomRuleError("This game has no remaining rounds.");
  }

  const deal = dealRound(state.players.length, handSize, rng);
  const dealerIndex = roundIndex % state.players.length;
  const firstBidderIndex = (dealerIndex + 1) % state.players.length;

  return {
    ...state,
    phase: "bidding",
    roundIndex,
    handSize,
    dealerIndex,
    firstBidderIndex,
    currentPlayerIndex: firstBidderIndex,
    trumpCard: deal.trumpCard,
    trumpBroken: false,
    trick: [],
    lastTrick: [],
    bidLog: [],
    lastWinner: null,
    roundResults: [],
    players: state.players.map((player, index) => ({
      ...player,
      bid: null,
      tricks: 0,
      hand: sortHand(deal.hands[index]),
      lastDelta: roundIndex === 0 ? null : player.lastDelta,
    })),
  };
}

function requireActor(state: OnlineRoomState, actorId: string) {
  const actor = state.players.find((player) => player.id === actorId);
  if (!actor) {
    throw new RoomRuleError(
      "Your seat is no longer available.",
      401,
      "INVALID_PLAYER",
    );
  }
  return actor;
}

function requireHost(state: OnlineRoomState, actorId: string) {
  if (state.hostPlayerId !== actorId) {
    throw new RoomRuleError(
      "Only the table host can do that.",
      403,
      "HOST_ONLY",
    );
  }
}

function applyBid(
  state: OnlineRoomState,
  actor: OnlinePlayer,
  bid: Bid,
): OnlineRoomState {
  if (state.phase !== "bidding") {
    throw new RoomRuleError("Bidding is not active.", 409, "WRONG_PHASE");
  }
  if (actor.seat !== state.currentPlayerIndex) {
    throw new RoomRuleError(
      "It is not your turn to bid.",
      409,
      "OUT_OF_TURN",
    );
  }
  if (state.bidLog.some((entry) => entry.playerIndex === actor.seat)) {
    throw new RoomRuleError(
      "Your bid is already locked in.",
      409,
      "ALREADY_BID",
    );
  }

  try {
    validateBid(bid, state.handSize);
  } catch (error) {
    throw new RoomRuleError(
      error instanceof Error ? error.message : "That bid is not valid.",
    );
  }

  const players = state.players.map((player) =>
    player.id === actor.id ? { ...player, bid } : player,
  );
  const bidLog = [...state.bidLog, { playerIndex: actor.seat, bid }];

  if (bidLog.length === players.length) {
    return {
      ...state,
      phase: "playing",
      players,
      bidLog,
      currentPlayerIndex: getOpeningLeaderIndex(bidLog),
    };
  }

  return {
    ...state,
    players,
    bidLog,
    currentPlayerIndex: (actor.seat + 1) % players.length,
  };
}

function applyCardPlay(
  state: OnlineRoomState,
  actor: OnlinePlayer,
  cardId: string,
): OnlineRoomState {
  if (state.phase !== "playing" || !state.trumpCard) {
    throw new RoomRuleError("Card play is not active.", 409, "WRONG_PHASE");
  }
  if (actor.seat !== state.currentPlayerIndex) {
    throw new RoomRuleError(
      "It is not your turn to play.",
      409,
      "OUT_OF_TURN",
    );
  }

  const card = actor.hand.find((entry) => entry.id === cardId);
  if (!card) {
    throw new RoomRuleError(
      "That card is not in your hand.",
      409,
      "CARD_NOT_HELD",
    );
  }

  const leadColor = getLeadColor(state.trick);
  const legalCards = getLegalCards(actor.hand, {
    leadColor,
    trumpColor: state.trumpCard.color,
    trumpBroken: state.trumpBroken,
  });
  if (!legalCards.some((entry) => entry.id === card.id)) {
    throw new RoomRuleError(
      leadColor
        ? `You must follow ${leadColor}.`
        : "Trump has not been broken yet.",
      409,
      "ILLEGAL_CARD",
    );
  }

  const breaksTrump =
    !state.trumpBroken &&
    doesPlayBreakTrump(
      card,
      actor.hand,
      state.trick,
      state.trumpCard.color,
    );
  const players = state.players.map((player) =>
    player.id === actor.id
      ? {
          ...player,
          hand: player.hand.filter((entry) => entry.id !== card.id),
        }
      : player,
  );
  const trick = [...state.trick, { playerIndex: actor.seat, card }];
  const baseState: OnlineRoomState = {
    ...state,
    players,
    trick,
    lastTrick: state.trick.length === 0 ? [] : state.lastTrick,
    lastWinner: state.trick.length === 0 ? null : state.lastWinner,
    trumpBroken: state.trumpBroken || breaksTrump,
  };

  if (trick.length < players.length) {
    return {
      ...baseState,
      currentPlayerIndex: (actor.seat + 1) % players.length,
    };
  }

  const winner = getTrickWinner(trick, state.trumpCard.color);
  const awardedPlayers = players.map((player) =>
    player.seat === winner.playerIndex
      ? { ...player, tricks: player.tricks + 1 }
      : player,
  );
  const roundComplete = awardedPlayers.every(
    (player) => player.hand.length === 0,
  );

  if (!roundComplete) {
    return {
      ...baseState,
      players: awardedPlayers,
      trick: [],
      lastTrick: trick,
      lastWinner: winner,
      currentPlayerIndex: winner.playerIndex,
    };
  }

  const roundResults = awardedPlayers.map((player) => {
    const bid = player.bid ?? 0;
    const delta = scoreBid(bid, player.tricks, state.handSize);
    return {
      playerIndex: player.seat,
      name: player.name,
      bid,
      tricks: player.tricks,
      delta,
      previousTotal: player.score,
      total: player.score + delta,
    };
  });
  const scoredPlayers = awardedPlayers.map((player) => ({
    ...player,
    score: roundResults[player.seat].total,
    lastDelta: roundResults[player.seat].delta,
  }));

  return {
    ...baseState,
    phase: "round-result",
    players: scoredPlayers,
    trick: [],
    lastTrick: trick,
    lastWinner: winner,
    currentPlayerIndex: winner.playerIndex,
    roundResults,
  };
}

export function applyOnlineRoomAction(
  state: OnlineRoomState,
  actorId: string,
  action: OnlineRoomAction,
  rng: RandomSource = Math.random,
): OnlineRoomState {
  const actor = requireActor(state, actorId);

  switch (action.type) {
    case "start":
      requireHost(state, actorId);
      if (state.phase !== "lobby") {
        throw new RoomRuleError(
          "This game has already started.",
          409,
          "GAME_STARTED",
        );
      }
      if (state.players.length !== state.playerCount) {
        throw new RoomRuleError(
          `Waiting for ${state.playerCount - state.players.length} more player${
            state.playerCount - state.players.length === 1 ? "" : "s"
          }.`,
          409,
          "WAITING_FOR_PLAYERS",
        );
      }
      return startRound(state, 0, rng);

    case "bid":
      return applyBid(state, actor, action.bid);

    case "play":
      return applyCardPlay(state, actor, action.cardId);

    case "next-round":
      requireHost(state, actorId);
      if (state.phase !== "round-result") {
        throw new RoomRuleError(
          "The round is still in progress.",
          409,
          "WRONG_PHASE",
        );
      }
      if (state.roundIndex >= state.schedule.length - 1) {
        return { ...state, phase: "game-over" };
      }
      return startRound(state, state.roundIndex + 1, rng);

    case "rematch": {
      requireHost(state, actorId);
      if (state.phase !== "game-over") {
        throw new RoomRuleError(
          "Finish the current game before starting a rematch.",
          409,
          "WRONG_PHASE",
        );
      }
      const reset = {
        ...state,
        players: state.players.map((player) => ({
          ...player,
          score: 0,
          bid: null,
          tricks: 0,
          hand: [],
          lastDelta: null,
        })),
      };
      return startRound(reset, 0, rng);
    }
  }
}

export function toOnlineRoomView(
  state: OnlineRoomState,
  actorId: string,
  revision: number,
): OnlineRoomView {
  const actor = requireActor(state, actorId);

  return {
    code: state.code,
    revision,
    myPlayerId: actor.id,
    isHost: state.hostPlayerId === actor.id,
    playerCount: state.playerCount,
    maxHand: state.maxHand,
    phase: state.phase,
    players: state.players.map((player) => ({
      id: player.id,
      name: player.name,
      seat: player.seat,
      score: player.score,
      bid: player.bid,
      tricks: player.tricks,
      handCount: player.hand.length,
      lastDelta: player.lastDelta,
    })),
    myHand: [...actor.hand],
    schedule: [...state.schedule],
    roundIndex: state.roundIndex,
    handSize: state.handSize,
    dealerIndex: state.dealerIndex,
    firstBidderIndex: state.firstBidderIndex,
    currentPlayerIndex: state.currentPlayerIndex,
    trumpCard: state.trumpCard,
    trumpBroken: state.trumpBroken,
    trick: [...state.trick],
    lastTrick: [...state.lastTrick],
    bidLog: [...state.bidLog],
    lastWinner: state.lastWinner,
    roundResults: [...state.roundResults],
  };
}

export function withRecordedAction(
  state: OnlineRoomState,
  actionId: string,
): OnlineRoomState {
  return {
    ...state,
    recentActionIds: [...state.recentActionIds, actionId].slice(-40),
  };
}
