import assert from "node:assert/strict";
import test from "node:test";
import {
  addPlayerToLobby,
  applyOnlineRoomAction,
  createOnlineLobby,
  toOnlineRoomView,
  type OnlineRoomState,
} from "../lib/multiplayer-engine.ts";
import {
  createSeededRng,
  type Card,
} from "../lib/game-engine.ts";

function lobby(maxHand = 1) {
  let state = createOnlineLobby({
    code: "TABLE2",
    playerCount: 3,
    maxHand,
    hostId: "host",
    hostTokenHash: "host-hash",
    hostName: "Host",
  });
  state = addPlayerToLobby(state, {
    playerId: "second",
    tokenHash: "second-hash",
    name: "Second",
  });
  state = addPlayerToLobby(state, {
    playerId: "third",
    tokenHash: "third-hash",
    name: "Third",
  });
  return state;
}

test("creates a fixed-seat lobby and rejects late or duplicate joins", () => {
  const state = lobby();
  assert.equal(state.players.length, 3);
  assert.deepEqual(
    state.players.map((player) => player.seat),
    [0, 1, 2],
  );
  assert.throws(
    () =>
      addPlayerToLobby(state, {
        playerId: "fourth",
        tokenHash: "fourth-hash",
        name: "Fourth",
      }),
    /full/,
  );

  const twoPlayerLobby = createOnlineLobby({
    code: "OTHER2",
    playerCount: 2,
    maxHand: 1,
    hostId: "host",
    hostTokenHash: "host-hash",
    hostName: "Same",
  });
  assert.throws(
    () =>
      addPlayerToLobby(twoPlayerLobby, {
        playerId: "second",
        tokenHash: "second-hash",
        name: "same",
      }),
    /already seated/,
  );
});

test("host starts, bids stay ordered, and the earliest equal high bid opens", () => {
  let state = lobby();
  assert.throws(
    () =>
      applyOnlineRoomAction(
        state,
        "second",
        { type: "start" },
        createSeededRng(4),
      ),
    /Only the table host/,
  );

  state = applyOnlineRoomAction(
    state,
    "host",
    { type: "start" },
    createSeededRng(4),
  );
  assert.equal(state.phase, "bidding");
  assert.equal(state.currentPlayerIndex, 1);

  assert.throws(
    () => applyOnlineRoomAction(state, "host", { type: "bid", bid: 1 }),
    /not your turn/,
  );
  state = applyOnlineRoomAction(state, "second", { type: "bid", bid: 1 });
  state = applyOnlineRoomAction(state, "third", { type: "bid", bid: 0 });
  state = applyOnlineRoomAction(state, "host", { type: "bid", bid: 1 });

  assert.equal(state.phase, "playing");
  assert.equal(state.currentPlayerIndex, 1);
  assert.deepEqual(
    state.bidLog.map((entry) => entry.playerIndex),
    [1, 2, 0],
  );
});

test("server play completes a trick, scores the round, and supports rematch", () => {
  let state = lobby();
  state = applyOnlineRoomAction(
    state,
    "host",
    { type: "start" },
    createSeededRng(17),
  );
  state = applyOnlineRoomAction(state, "second", { type: "bid", bid: 0 });
  state = applyOnlineRoomAction(state, "third", { type: "bid", bid: 0 });
  state = applyOnlineRoomAction(state, "host", { type: "bid", bid: 0 });

  for (let playNumber = 0; playNumber < 3; playNumber += 1) {
    const actor = state.players[state.currentPlayerIndex];
    assert.equal(actor.hand.length, 1);
    state = applyOnlineRoomAction(state, actor.id, {
      type: "play",
      cardId: actor.hand[0].id,
    });
  }

  assert.equal(state.phase, "round-result");
  assert.equal(state.lastTrick.length, 3);
  assert.equal(state.trick.length, 0);
  assert.equal(
    state.players.reduce((sum, player) => sum + player.tricks, 0),
    1,
  );
  assert.equal(state.roundResults.length, 3);

  state = applyOnlineRoomAction(state, "host", { type: "next-round" });
  assert.equal(state.phase, "game-over");
  state = applyOnlineRoomAction(
    state,
    "host",
    { type: "rematch" },
    createSeededRng(18),
  );
  assert.equal(state.phase, "bidding");
  assert.ok(state.players.every((player) => player.score === 0));
});

test("authoritative play rejects an unbroken trump lead from a mixed hand", () => {
  const redThree: Card = { id: "red-3", color: "red", rank: 3 };
  const greenFourteen: Card = {
    id: "green-14",
    color: "green",
    rank: 14,
  };
  const base = lobby(2);
  const state: OnlineRoomState = {
    ...base,
    phase: "playing",
    handSize: 2,
    currentPlayerIndex: 0,
    trumpCard: { id: "green-8", color: "green", rank: 8 },
    trumpBroken: false,
    players: base.players.map((player) =>
      player.seat === 0
        ? { ...player, hand: [redThree, greenFourteen], bid: 1 }
        : { ...player, hand: [], bid: 0 },
    ),
  };

  assert.throws(
    () =>
      applyOnlineRoomAction(state, "host", {
        type: "play",
        cardId: greenFourteen.id,
      }),
    /Trump has not been broken/,
  );
  const next = applyOnlineRoomAction(state, "host", {
    type: "play",
    cardId: redThree.id,
  });
  assert.equal(next.trick[0].card.id, redThree.id);
});

test("player-specific views expose one hand and no token hashes", () => {
  let state = lobby(2);
  state = applyOnlineRoomAction(
    state,
    "host",
    { type: "start" },
    createSeededRng(77),
  );
  const hostView = toOnlineRoomView(state, "host", 8);
  const secondView = toOnlineRoomView(state, "second", 8);

  assert.deepEqual(hostView.myHand, state.players[0].hand);
  assert.deepEqual(secondView.myHand, state.players[1].hand);
  assert.notDeepEqual(hostView.myHand, secondView.myHand);
  assert.equal(
    hostView.players.some((player) => "hand" in player),
    false,
  );
  assert.doesNotMatch(JSON.stringify(hostView), /tokenHash|second-hash/);
});
