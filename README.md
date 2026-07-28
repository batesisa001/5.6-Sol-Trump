# High Trump

High Trump is a Rook-style trick-taking game with two ways to play:

- Solo against two to five computer opponents.
- Live multiplayer for two to six people using a six-character share code.

Multiplayer rooms are server-authoritative and stored in D1. Each browser
receives only its own hand, while bids, turns, tricks, and scores stay
synchronized for the whole table. A device-local reconnect key restores the
same seat after a refresh.

## Game rules

- The 56-card deck has Black, Red, Green, and Yellow cards ranked 1–14. The Rook
  card is not used.
- Hand sizes climb from 1 to the configured maximum, then descend to 1.
- The card revealed after each deal sets trump for that round.
- The highest bidder leads the first trick. Board outranks every numeric bid,
  and the first player to make an equal high bid wins the tie.
- The winner of each trick leads the next one.
- Players must follow the color led when able. Trump beats ordinary non-trump
  cards, and the highest card within a color wins.
- Trump cannot be led until it has been broken by an off-color trump play,
  unless trump is the only color left in the leader's hand. That forced lead
  breaks trump.
- Yellow 2 is the absolute highest card, including over trump.
- Numeric bids score 3 points per promised trick, plus 1 per overtrick. Missing
  a bid loses 1 point per trick short.
- Board means taking every trick and scores +20 when made or −20 when missed.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The solo game is at `/`; multiplayer creation and joining are at `/online`.
Local multiplayer uses the D1 binding declared in `.openai/hosting.json`.

## Verify

```bash
npm test
```

The test suite checks the complete deck, deal accounting, round schedule,
follow-color and trump-breaking legality, opening-leader precedence, trick
precedence, all scoring branches, ordered bidding, AI legality, authoritative
multiplayer transitions, private-hand projections, and the rendered solo and
multiplayer setup screens.
