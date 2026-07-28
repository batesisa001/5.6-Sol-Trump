import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRoundSchedule,
  chooseAiBid,
  chooseAiCard,
  createBiddingState,
  createDeck,
  createSeededRng,
  dealRound,
  doesPlayBreakTrump,
  getLegalCards,
  getNextBidder,
  getOpeningLeaderIndex,
  getTrickWinner,
  placeBid,
  scoreBid,
  type Card,
  type Color,
  type PlayedCard,
  type Rank,
} from "../lib/game-engine.ts";

function card(color: Color, rank: Rank): Card {
  return { id: `${color}-${rank}`, color, rank };
}

test("builds the complete 56-card Rook deck without a Rook card", () => {
  const deck = createDeck();
  assert.equal(deck.length, 56);
  assert.equal(new Set(deck.map((entry) => entry.id)).size, 56);

  for (const color of ["black", "red", "green", "yellow"] as const) {
    assert.equal(deck.filter((entry) => entry.color === color).length, 14);
  }
});

test("builds an ascending then descending round path without duplicate peak", () => {
  assert.deepEqual(buildRoundSchedule(1), [1]);
  assert.deepEqual(buildRoundSchedule(4), [1, 2, 3, 4, 3, 2, 1]);
});

test("deals unique cards and reveals the next card as trump", () => {
  const deal = dealRound(4, 7, createSeededRng(42));
  assert.deepEqual(deal.hands.map((hand) => hand.length), [7, 7, 7, 7]);
  assert.equal(deal.trumpColor, deal.trumpCard.color);

  const allIds = [
    ...deal.hands.flat().map((entry) => entry.id),
    deal.trumpCard.id,
    ...deal.remainingDeck.map((entry) => entry.id),
  ];
  assert.equal(allIds.length, 56);
  assert.equal(new Set(allIds).size, 56);
});

test("enforces following the color that was led", () => {
  const hand = [card("red", 4), card("red", 11), card("green", 14)];
  assert.deepEqual(
    getLegalCards(hand, "red").map((entry) => entry.id),
    ["red-4", "red-11"],
  );
  assert.deepEqual(
    getLegalCards(hand, "yellow").map((entry) => entry.id),
    hand.map((entry) => entry.id),
  );
});

test("resolves lead color, trump, and Yellow 2 in the correct order", () => {
  const leadWins: PlayedCard[] = [
    { playerIndex: 0, card: card("red", 10) },
    { playerIndex: 1, card: card("black", 14) },
    { playerIndex: 2, card: card("red", 12) },
  ];
  assert.equal(getTrickWinner(leadWins, "green").playerIndex, 2);

  const trumpWins: PlayedCard[] = [
    { playerIndex: 0, card: card("red", 14) },
    { playerIndex: 1, card: card("green", 1) },
  ];
  assert.equal(getTrickWinner(trumpWins, "green").playerIndex, 1);

  const yellowTwoWins: PlayedCard[] = [
    { playerIndex: 0, card: card("green", 14) },
    { playerIndex: 1, card: card("yellow", 2) },
    { playerIndex: 2, card: card("yellow", 14) },
  ];
  assert.equal(getTrickWinner(yellowTwoWins, "green").playerIndex, 1);
});

test("scores numeric bids, overtricks, short bids, and Board exactly", () => {
  assert.equal(scoreBid(3, 3, 5), 9);
  assert.equal(scoreBid(3, 4, 5), 10);
  assert.equal(scoreBid(3, 2, 5), -1);
  assert.equal(scoreBid(0, 2, 5), 2);
  assert.equal(scoreBid("BOARD", 5, 5), 20);
  assert.equal(scoreBid("BOARD", 4, 5), -20);
});

test("records bids strictly in clockwise order", () => {
  let state = createBiddingState(4, 5, 2);
  assert.equal(getNextBidder(state), 2);
  state = placeBid(state, 2, 1);
  assert.equal(getNextBidder(state), 3);
  assert.throws(() => placeBid(state, 0, 2), /Player 3 must bid next/);
});

test("Board is the highest bid when choosing the opening leader", () => {
  assert.equal(
    getOpeningLeaderIndex([
      { playerIndex: 2, bid: 4 },
      { playerIndex: 3, bid: "BOARD" },
      { playerIndex: 0, bid: 5 },
    ]),
    3,
  );
  assert.equal(
    getOpeningLeaderIndex([
      { playerIndex: 1, bid: "BOARD" },
      { playerIndex: 2, bid: "BOARD" },
    ]),
    1,
  );
});

test("equal numeric bids leave the first bidder as opening leader", () => {
  assert.equal(
    getOpeningLeaderIndex([
      { playerIndex: 3, bid: 2 },
      { playerIndex: 0, bid: 4 },
      { playerIndex: 1, bid: 4 },
      { playerIndex: 2, bid: 1 },
    ]),
    0,
  );
  assert.throws(
    () => getOpeningLeaderIndex([]),
    /without bids/,
  );
});

test("blocks an unbroken trump lead while another color remains", () => {
  const hand = [
    card("green", 14),
    card("red", 3),
    card("black", 8),
  ];

  assert.deepEqual(
    getLegalCards(hand, {
      trumpColor: "green",
      trumpBroken: false,
    }).map((entry) => entry.id),
    ["red-3", "black-8"],
  );
});

test("allows and breaks a forced all-trump opening lead", () => {
  const hand = [card("green", 4), card("green", 11)];
  const legalCards = getLegalCards(hand, {
    trumpColor: "green",
    trumpBroken: false,
  });

  assert.deepEqual(
    legalCards.map((entry) => entry.id),
    ["green-4", "green-11"],
  );
  assert.equal(
    doesPlayBreakTrump(hand[0], hand, [], "green"),
    true,
  );
});

test("off-suit trump breaks trump only when the play follows color legally", () => {
  const trick: PlayedCard[] = [
    { playerIndex: 0, card: card("red", 10) },
  ];
  const voidInLeadColor = [card("green", 7), card("black", 9)];
  const stillHasLeadColor = [card("green", 7), card("red", 3)];

  assert.deepEqual(
    getLegalCards(voidInLeadColor, {
      leadColor: "red",
      trumpColor: "green",
      trumpBroken: false,
    }).map((entry) => entry.id),
    ["green-7", "black-9"],
  );
  assert.deepEqual(
    getLegalCards(stillHasLeadColor, {
      leadColor: "red",
      trumpColor: "green",
      trumpBroken: false,
    }).map((entry) => entry.id),
    ["red-3"],
  );
  assert.equal(
    doesPlayBreakTrump(
      voidInLeadColor[0],
      voidInLeadColor,
      trick,
      "green",
    ),
    true,
  );
  assert.equal(
    doesPlayBreakTrump(
      stillHasLeadColor[0],
      stillHasLeadColor,
      trick,
      "green",
    ),
    false,
  );
  assert.equal(
    doesPlayBreakTrump(card("black", 9), voidInLeadColor, trick, "green"),
    false,
  );
});

test("allows trump leads after trump has been broken", () => {
  const hand = [card("green", 14), card("red", 3)];

  assert.deepEqual(
    getLegalCards(hand, {
      trumpColor: "green",
      trumpBroken: true,
    }).map((entry) => entry.id),
    ["green-14", "red-3"],
  );
});

test("AI bids within range and always chooses a legal card", () => {
  const hand = [
    card("red", 4),
    card("red", 13),
    card("green", 8),
    card("yellow", 2),
  ];
  const bid = chooseAiBid(hand, "green", 4, [], createSeededRng(7));
  assert.ok(bid === "BOARD" || (bid >= 0 && bid <= 4));

  const trick: PlayedCard[] = [
    { playerIndex: 0, card: card("red", 10) },
  ];
  const chosen = chooseAiCard(
    hand,
    trick,
    "green",
    bid,
    0,
    createSeededRng(9),
  );
  assert.equal(chosen.color, "red");
});

test("AI obeys unbroken-trump leading restrictions", () => {
  const mixedHand = [card("green", 14), card("red", 3)];
  const chosenFromMixedHand = chooseAiCard(
    mixedHand,
    [],
    "green",
    "BOARD",
    0,
    {
      trumpBroken: false,
      rng: createSeededRng(11),
    },
  );
  assert.equal(chosenFromMixedHand.id, "red-3");

  const allTrumpHand = [card("green", 4), card("green", 14)];
  const chosenFromAllTrumpHand = chooseAiCard(
    allTrumpHand,
    [],
    "green",
    1,
    0,
    {
      trumpBroken: false,
      rng: createSeededRng(12),
    },
  );
  assert.equal(chosenFromAllTrumpHand.color, "green");
});
