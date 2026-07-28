# High Trump

High Trump is a local, single-player Rook-style trick-taking game for one human
and two to five computer opponents.

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

## Verify

```bash
npm test
```

The test suite checks the complete deck, deal accounting, round schedule,
follow-color and trump-breaking legality, opening-leader precedence, trick
precedence, all scoring branches, ordered bidding, AI legality, and the rendered
setup screen.
