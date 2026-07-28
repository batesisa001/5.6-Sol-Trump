/**
 * Pure rules and lightweight AI for the Rook-style trick-taking game.
 *
 * The "top" of a deck is index 0. All helpers are immutable: caller-owned
 * arrays are never shuffled or sorted in place.
 */

export const COLORS = ["black", "red", "green", "yellow"] as const;

export type Color = (typeof COLORS)[number];

export type Rank =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14;

export type CardId = `${Color}-${Rank}`;

export interface Card {
  readonly id: CardId;
  readonly color: Color;
  readonly rank: Rank;
}

/** A numeric bid is the number of tricks claimed. */
export type Bid = number | "BOARD";

export interface PlayedCard {
  readonly playerIndex: number;
  readonly card: Card;
}

export interface DealResult {
  readonly hands: readonly (readonly Card[])[];
  readonly trumpCard: Card;
  readonly trumpColor: Color;
  readonly remainingDeck: readonly Card[];
}

export type RandomSource = () => number;

/**
 * Round state needed to determine which cards may be played. The legacy
 * lead-color-only form of getLegalCards/isLegalCard remains supported.
 */
export interface LegalPlayContext {
  readonly leadColor?: Color;
  readonly trumpColor: Color;
  readonly trumpBroken: boolean;
}

export interface AiCardOptions {
  readonly rng?: RandomSource;
  readonly trumpBroken?: boolean;
}

export interface BidEntry {
  readonly playerIndex: number;
  readonly bid: Bid;
}

/**
 * Bids are appended in `order`, so every bidder can safely see all preceding
 * entries without seeing future choices.
 */
export interface BiddingState {
  readonly handSize: number;
  readonly order: readonly number[];
  readonly entries: readonly BidEntry[];
}

export interface ScoredBid {
  readonly playerIndex: number;
  readonly bid: Bid;
  readonly tricksWon: number;
  readonly points: number;
}

function assertIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${label} must be an integer from ${minimum} to ${maximum}; received ${value}.`,
    );
  }
}

function randomUnit(rng: RandomSource): number {
  const value = rng();

  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError(
      `Random source must return a finite value in [0, 1); received ${value}.`,
    );
  }

  return value;
}

function isYellowTwo(card: Card): boolean {
  return card.color === "yellow" && card.rank === 2;
}

export function createDeck(): Card[] {
  const deck: Card[] = [];

  for (const color of COLORS) {
    for (let rank = 1; rank <= 14; rank += 1) {
      const typedRank = rank as Rank;
      deck.push({
        id: `${color}-${typedRank}` as CardId,
        color,
        rank: typedRank,
      });
    }
  }

  return deck;
}

/**
 * Returns a reproducible PRNG suitable for deals and AI decisions.
 * This is not intended for cryptographic use.
 */
export function createSeededRng(seed: number): RandomSource {
  if (!Number.isFinite(seed)) {
    throw new RangeError(`Seed must be finite; received ${seed}.`);
  }

  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Fisher-Yates shuffle returning a new array. */
export function shuffleDeck(
  deck: readonly Card[],
  rng: RandomSource = Math.random,
): Card[] {
  const shuffled = [...deck];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const otherIndex = Math.floor(randomUnit(rng) * (index + 1));
    [shuffled[index], shuffled[otherIndex]] = [
      shuffled[otherIndex],
      shuffled[index],
    ];
  }

  return shuffled;
}

/**
 * Produces 1..max..1, with the maximum occurring once.
 * Examples: 1 => [1], 3 => [1, 2, 3, 2, 1].
 */
export function buildRoundSchedule(maxHand: number): number[] {
  assertIntegerInRange(maxHand, 1, 55, "Maximum hand size");

  const ascending = Array.from({ length: maxHand }, (_, index) => index + 1);
  const descending = ascending.slice(0, -1).reverse();
  return [...ascending, ...descending];
}

/**
 * Because one card must remain to reveal trump, at most 55 cards can be dealt.
 */
export function getMaxHandSize(playerCount: number): number {
  assertIntegerInRange(playerCount, 2, 55, "Player count");
  return Math.floor(55 / playerCount);
}

/**
 * Deals clockwise, one card per player at a time, then reveals the next card.
 */
export function dealRound(
  playerCount: number,
  handSize: number,
  rng: RandomSource = Math.random,
): DealResult {
  assertIntegerInRange(playerCount, 2, 55, "Player count");
  assertIntegerInRange(handSize, 1, getMaxHandSize(playerCount), "Hand size");

  const deck = shuffleDeck(createDeck(), rng);
  const hands: Card[][] = Array.from({ length: playerCount }, () => []);
  let cursor = 0;

  for (let cardNumber = 0; cardNumber < handSize; cardNumber += 1) {
    for (let playerIndex = 0; playerIndex < playerCount; playerIndex += 1) {
      hands[playerIndex].push(deck[cursor]);
      cursor += 1;
    }
  }

  const trumpCard = deck[cursor];
  cursor += 1;

  return {
    hands,
    trumpCard,
    trumpColor: trumpCard.color,
    remainingDeck: deck.slice(cursor),
  };
}

export function getLeadColor(
  plays: readonly PlayedCard[],
): Color | undefined {
  return plays[0]?.card.color;
}

/**
 * A player with at least one card of the led color must follow that color.
 * When leading, unbroken trump is unavailable unless the player's entire
 * remaining hand is trump.
 */
export function getLegalCards(
  hand: readonly Card[],
  leadColor?: Color,
): Card[];
export function getLegalCards(
  hand: readonly Card[],
  context: LegalPlayContext,
): Card[];
export function getLegalCards(
  hand: readonly Card[],
  leadColorOrContext?: Color | LegalPlayContext,
): Card[] {
  const context =
    typeof leadColorOrContext === "object" ? leadColorOrContext : undefined;
  const leadColor = context ? context.leadColor : leadColorOrContext;

  if (leadColor !== undefined) {
    const followingColor = hand.filter((card) => card.color === leadColor);
    return followingColor.length > 0 ? followingColor : [...hand];
  }

  if (!context || context.trumpBroken) {
    return [...hand];
  }

  const nonTrumpCards = hand.filter(
    (card) => card.color !== context.trumpColor,
  );
  return nonTrumpCards.length > 0 ? nonTrumpCards : [...hand];
}

export function isLegalCard(
  card: Card,
  hand: readonly Card[],
  leadColor?: Color,
): boolean;
export function isLegalCard(
  card: Card,
  hand: readonly Card[],
  context: LegalPlayContext,
): boolean;
export function isLegalCard(
  card: Card,
  hand: readonly Card[],
  leadColorOrContext?: Color | LegalPlayContext,
): boolean {
  const cardIsInHand = hand.some((heldCard) => heldCard.id === card.id);
  if (!cardIsInHand) {
    return false;
  }

  const legalCards =
    typeof leadColorOrContext === "object"
      ? getLegalCards(hand, leadColorOrContext)
      : getLegalCards(hand, leadColorOrContext);

  return legalCards.some(
    (legalCard) => legalCard.id === card.id,
  );
}

/**
 * Returns whether a legal play causes trump to become broken for the round.
 * Trump breaks when it is played off-suit, or when a player whose entire
 * remaining hand is trump is forced to open a trick with it.
 */
export function doesPlayBreakTrump(
  card: Card,
  hand: readonly Card[],
  trick: readonly PlayedCard[],
  trumpColor: Color,
): boolean {
  if (
    card.color !== trumpColor ||
    !hand.some((heldCard) => heldCard.id === card.id)
  ) {
    return false;
  }

  const leadColor = getLeadColor(trick);
  if (leadColor === undefined) {
    return hand.every((heldCard) => heldCard.color === trumpColor);
  }

  return (
    leadColor !== trumpColor &&
    !hand.some((heldCard) => heldCard.color === leadColor)
  );
}

/**
 * Returns true when challenger defeats incumbent under the supplied trick
 * context. Yellow 2 is absolute high, even over trump.
 */
export function doesCardBeat(
  challenger: Card,
  incumbent: Card,
  leadColor: Color,
  trumpColor: Color,
): boolean {
  const challengerIsYellowTwo = isYellowTwo(challenger);
  const incumbentIsYellowTwo = isYellowTwo(incumbent);

  if (challengerIsYellowTwo || incumbentIsYellowTwo) {
    return challengerIsYellowTwo && !incumbentIsYellowTwo;
  }

  if (challenger.color === incumbent.color) {
    return challenger.rank > incumbent.rank;
  }

  const challengerIsTrump = challenger.color === trumpColor;
  const incumbentIsTrump = incumbent.color === trumpColor;
  if (challengerIsTrump !== incumbentIsTrump) {
    return challengerIsTrump;
  }

  const challengerFollowedLead = challenger.color === leadColor;
  const incumbentFollowedLead = incumbent.color === leadColor;
  if (challengerFollowedLead !== incumbentFollowedLead) {
    return challengerFollowedLead;
  }

  // Different off-colors do not defeat one another. In a valid trick the led
  // card remains above both, so preserving the incumbent is deterministic.
  return false;
}

export function getTrickWinnerIndex(
  plays: readonly PlayedCard[],
  trumpColor: Color,
): number {
  if (plays.length === 0) {
    throw new RangeError("Cannot choose a winner for an empty trick.");
  }

  const leadColor = plays[0].card.color;
  let winningIndex = 0;

  for (let index = 1; index < plays.length; index += 1) {
    if (
      doesCardBeat(
        plays[index].card,
        plays[winningIndex].card,
        leadColor,
        trumpColor,
      )
    ) {
      winningIndex = index;
    }
  }

  return winningIndex;
}

export function getTrickWinner(
  plays: readonly PlayedCard[],
  trumpColor: Color,
): PlayedCard {
  return plays[getTrickWinnerIndex(plays, trumpColor)];
}

export function validateBid(bid: Bid, handSize: number): void {
  assertIntegerInRange(handSize, 1, 55, "Hand size");

  if (bid === "BOARD") {
    return;
  }

  assertIntegerInRange(bid, 0, handSize, "Bid");
}

/**
 * Numeric scoring:
 * - made/over: 3 points per bid trick, plus 1 per overtrick
 * - under: negative 1 per missing trick
 * Board scores exactly +20 or -20.
 */
export function scoreBid(
  bid: Bid,
  tricksWon: number,
  handSize: number,
): number {
  assertIntegerInRange(handSize, 1, 55, "Hand size");
  assertIntegerInRange(tricksWon, 0, handSize, "Tricks won");
  validateBid(bid, handSize);

  if (bid === "BOARD") {
    return tricksWon === handSize ? 20 : -20;
  }

  if (tricksWon < bid) {
    return tricksWon - bid;
  }

  return bid * 3 + (tricksWon - bid);
}

export function scoreRound(
  results: readonly Omit<ScoredBid, "points">[],
  handSize: number,
): ScoredBid[] {
  assertIntegerInRange(handSize, 1, 55, "Hand size");
  const seenPlayers = new Set<number>();

  return results.map((result) => {
    if (seenPlayers.has(result.playerIndex)) {
      throw new Error(`Player ${result.playerIndex} appears more than once.`);
    }
    seenPlayers.add(result.playerIndex);

    return {
      ...result,
      points: scoreBid(result.bid, result.tricksWon, handSize),
    };
  });
}

function rotatedPlayerOrder(
  playerCount: number,
  startingPlayer: number,
): number[] {
  return Array.from(
    { length: playerCount },
    (_, offset) => (startingPlayer + offset) % playerCount,
  );
}

export function createBiddingState(
  playerCount: number,
  handSize: number,
  startingPlayer = 0,
): BiddingState {
  assertIntegerInRange(playerCount, 2, 55, "Player count");
  assertIntegerInRange(handSize, 1, getMaxHandSize(playerCount), "Hand size");
  assertIntegerInRange(
    startingPlayer,
    0,
    playerCount - 1,
    "Starting player",
  );

  return {
    handSize,
    order: rotatedPlayerOrder(playerCount, startingPlayer),
    entries: [],
  };
}

export function getNextBidder(state: BiddingState): number | undefined {
  return state.order[state.entries.length];
}

export function isBiddingComplete(state: BiddingState): boolean {
  return state.entries.length >= state.order.length;
}

/** Appends one bid and enforces the visible, clockwise bidding order. */
export function placeBid(
  state: BiddingState,
  playerIndex: number,
  bid: Bid,
): BiddingState {
  if (isBiddingComplete(state)) {
    throw new Error("Bidding is already complete.");
  }

  const expectedPlayer = getNextBidder(state);
  if (playerIndex !== expectedPlayer) {
    throw new Error(
      `Player ${expectedPlayer} must bid next; received player ${playerIndex}.`,
    );
  }

  validateBid(bid, state.handSize);
  return {
    ...state,
    entries: [...state.entries, { playerIndex, bid }],
  };
}

/**
 * Chooses the first leader from bids in the order they were made. Board ranks
 * above every numeric bid; equal bids retain the earlier bidder.
 */
export function getOpeningLeaderIndex(
  entries: readonly BidEntry[],
): number {
  if (entries.length === 0) {
    throw new RangeError("Cannot choose an opening leader without bids.");
  }

  let leader = entries[0];
  for (let index = 1; index < entries.length; index += 1) {
    const challenger = entries[index];
    const challengerIsHigher =
      challenger.bid === "BOARD"
        ? leader.bid !== "BOARD"
        : leader.bid !== "BOARD" && challenger.bid > leader.bid;

    if (challengerIsHigher) {
      leader = challenger;
    }
  }

  return leader.playerIndex;
}

const COLOR_SORT_INDEX: Readonly<Record<Color, number>> = {
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
};

export function sortHand(hand: readonly Card[]): Card[] {
  return [...hand].sort(
    (left, right) =>
      COLOR_SORT_INDEX[left.color] - COLOR_SORT_INDEX[right.color] ||
      left.rank - right.rank,
  );
}

function cardStrategicStrength(card: Card, trumpColor: Color): number {
  if (isYellowTwo(card)) {
    return 1_000;
  }

  if (card.color === trumpColor) {
    return 500 + card.rank;
  }

  return card.rank;
}

function estimatedTrickValue(card: Card, trumpColor: Color): number {
  if (isYellowTwo(card)) {
    return 1;
  }

  if (card.color === trumpColor) {
    return 0.28 + (card.rank / 14) * 0.66;
  }

  if (card.rank === 14) {
    return 0.72;
  }
  if (card.rank === 13) {
    return 0.5;
  }
  if (card.rank === 12) {
    return 0.3;
  }
  if (card.rank === 11) {
    return 0.16;
  }

  return 0.04;
}

function selectByStrength(
  cards: readonly Card[],
  trumpColor: Color,
  strongest: boolean,
  rng: RandomSource,
): Card {
  if (cards.length === 0) {
    throw new RangeError("Cannot select a card from an empty list.");
  }

  let bestStrength = cardStrategicStrength(cards[0], trumpColor);
  let candidates: Card[] = [cards[0]];

  for (let index = 1; index < cards.length; index += 1) {
    const card = cards[index];
    const strength = cardStrategicStrength(card, trumpColor);
    const isBetter = strongest
      ? strength > bestStrength
      : strength < bestStrength;

    if (isBetter) {
      bestStrength = strength;
      candidates = [card];
    } else if (strength === bestStrength) {
      candidates.push(card);
    }
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  return candidates[Math.floor(randomUnit(rng) * candidates.length)];
}

/**
 * Basic estimate-based AI. Prior bids slightly temper aggressive bidding when
 * the table has already claimed more tricks than are available.
 */
export function chooseAiBid(
  hand: readonly Card[],
  trumpColor: Color,
  handSize: number,
  priorBids: readonly Bid[] = [],
  rng: RandomSource = Math.random,
): Bid {
  assertIntegerInRange(handSize, 1, 55, "Hand size");
  if (hand.length !== handSize) {
    throw new RangeError(
      `AI hand contains ${hand.length} cards but hand size is ${handSize}.`,
    );
  }
  for (const priorBid of priorBids) {
    validateBid(priorBid, handSize);
  }

  const rawEstimate = hand.reduce(
    (total, card) => total + estimatedTrickValue(card, trumpColor),
    0,
  );
  const claimedTricks = priorBids.reduce<number>(
    (total, bid) => total + (bid === "BOARD" ? handSize : bid),
    0,
  );
  const crowdingAdjustment =
    priorBids.length === 0
      ? 0
      : Math.max(0, claimedTricks - handSize) /
        (priorBids.length * Math.max(1, handSize) * 4);
  const estimate =
    rawEstimate - crowdingAdjustment + (randomUnit(rng) - 0.5) * 0.28;

  const boardQuality = hand.every(
    (card) =>
      isYellowTwo(card) ||
      (card.color === trumpColor && card.rank >= 12) ||
      (card.color !== trumpColor && card.rank === 14),
  );
  if (boardQuality && rawEstimate >= handSize * 0.9) {
    return "BOARD";
  }

  return Math.max(0, Math.min(handSize, Math.round(estimate)));
}

function candidateWinsTrick(
  candidate: Card,
  trick: readonly PlayedCard[],
  trumpColor: Color,
): boolean {
  const candidatePlay: PlayedCard = {
    playerIndex: Number.MIN_SAFE_INTEGER,
    card: candidate,
  };
  const winner = getTrickWinner([...trick, candidatePlay], trumpColor);
  return winner === candidatePlay;
}

/**
 * Plays only legal cards. The AI tries to take another trick while below its
 * numeric bid (or throughout a Board attempt), using the cheapest winning card
 * when possible. Once its target is met it sheds the weakest losing card.
 */
export function chooseAiCard(
  hand: readonly Card[],
  trick: readonly PlayedCard[],
  trumpColor: Color,
  bid: Bid,
  tricksWon: number,
  rngOrOptions: RandomSource | AiCardOptions = Math.random,
): Card {
  if (hand.length === 0) {
    throw new RangeError("AI cannot play from an empty hand.");
  }
  assertIntegerInRange(tricksWon, 0, 55, "Tricks won");
  if (bid !== "BOARD" && (!Number.isInteger(bid) || bid < 0)) {
    throw new RangeError(`Bid must be a non-negative integer; received ${bid}.`);
  }

  const rng =
    typeof rngOrOptions === "function"
      ? rngOrOptions
      : (rngOrOptions.rng ?? Math.random);
  const trumpBroken =
    typeof rngOrOptions === "function"
      ? true
      : (rngOrOptions.trumpBroken ?? true);
  const leadColor = getLeadColor(trick);
  const legalCards = getLegalCards(hand, {
    leadColor,
    trumpColor,
    trumpBroken,
  });
  const shouldTryToWin = bid === "BOARD" || tricksWon < bid;

  if (trick.length === 0) {
    return selectByStrength(legalCards, trumpColor, shouldTryToWin, rng);
  }

  const winningCards = legalCards.filter((card) =>
    candidateWinsTrick(card, trick, trumpColor),
  );

  if (shouldTryToWin && winningCards.length > 0) {
    return selectByStrength(winningCards, trumpColor, false, rng);
  }

  if (!shouldTryToWin) {
    const losingCards = legalCards.filter(
      (card) => !candidateWinsTrick(card, trick, trumpColor),
    );
    if (losingCards.length > 0) {
      return selectByStrength(losingCards, trumpColor, false, rng);
    }
  }

  return selectByStrength(legalCards, trumpColor, false, rng);
}
