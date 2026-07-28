"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  buildRoundSchedule,
  chooseAiBid,
  chooseAiCard,
  dealRound,
  doesPlayBreakTrump,
  getLeadColor,
  getLegalCards,
  getMaxHandSize,
  getOpeningLeaderIndex,
  getTrickWinner,
  scoreBid,
  sortHand,
  type Bid,
  type Card,
  type Color,
  type PlayedCard,
} from "@/lib/game-engine";

type Phase =
  | "setup"
  | "bidding"
  | "playing"
  | "trick-result"
  | "round-result"
  | "game-over";

interface Player {
  id: number;
  name: string;
  isHuman: boolean;
  score: number;
  bid: Bid | null;
  tricks: number;
  hand: Card[];
  lastDelta: number | null;
}

interface BidLogEntry {
  playerIndex: number;
  bid: Bid;
}

interface RoundResult {
  playerIndex: number;
  name: string;
  bid: Bid;
  tricks: number;
  delta: number;
  previousTotal: number;
  total: number;
}

interface GameSettings {
  playerName: string;
  playerCount: number;
  maxHand: number;
}

const AI_NAMES = ["Mara", "Theo", "Ivy", "Otis", "June"];

const COLOR_META: Record<
  Color,
  { label: string; symbol: string; short: string }
> = {
  black: { label: "Black", symbol: "●", short: "B" },
  red: { label: "Red", symbol: "◆", short: "R" },
  green: { label: "Green", symbol: "▲", short: "G" },
  yellow: { label: "Yellow", symbol: "✦", short: "Y" },
};

const DEFAULT_SETTINGS: GameSettings = {
  playerName: "You",
  playerCount: 4,
  maxHand: 7,
};

function rotateOrder(playerCount: number, start: number) {
  return Array.from(
    { length: playerCount },
    (_, offset) => (start + offset) % playerCount,
  );
}

function displayBid(bid: Bid | null) {
  if (bid === null) return "—";
  return bid === "BOARD" ? "Board" : String(bid);
}

function scoreExplanation(bid: Bid, tricks: number, handSize: number) {
  if (bid === "BOARD") {
    return tricks === handSize
      ? "Board made · +20"
      : `Board missed · ${tricks}/${handSize} tricks`;
  }

  if (tricks < bid) {
    return `${bid - tricks} trick${bid - tricks === 1 ? "" : "s"} short`;
  }

  const overtricks = tricks - bid;
  return overtricks > 0
    ? `${bid} × 3 + ${overtricks} over`
    : `${bid} × 3 · bid made`;
}

function describeTrickWin(
  winner: PlayedCard,
  trick: readonly PlayedCard[],
  trump: Color,
) {
  if (winner.card.color === "yellow" && winner.card.rank === 2) {
    return "Yellow 2 takes all";
  }

  const lead = trick[0]?.card.color;
  if (winner.card.color === trump && lead !== trump) {
    return `${COLOR_META[trump].label} trump`;
  }

  return `High ${COLOR_META[winner.card.color].label}`;
}

function CardFace({
  card,
  compact = false,
  selected = false,
  disabled = false,
  unavailableReason,
  onSelect,
  delay = 0,
}: {
  card: Card;
  compact?: boolean;
  selected?: boolean;
  disabled?: boolean;
  unavailableReason?: string;
  onSelect?: () => void;
  delay?: number;
}) {
  const meta = COLOR_META[card.color];
  const isCrown = card.color === "yellow" && card.rank === 2;
  const className = [
    "rook-card",
    `card-${card.color}`,
    compact ? "rook-card-compact" : "",
    selected ? "is-selected" : "",
    disabled ? "is-disabled" : "",
    isCrown ? "is-crown" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const label = `${meta.label} ${card.rank}${
    isCrown ? ", highest card in the deck" : ""
  }${disabled && unavailableReason ? `, unavailable: ${unavailableReason}` : ""}`;
  const content = (
    <>
      <span className="card-corner card-corner-top" aria-hidden="true">
        <strong>{card.rank}</strong>
        <span>{meta.symbol}</span>
      </span>
      <span className="card-center" aria-hidden="true">
        {isCrown && <span className="crown-mark">♛</span>}
        <span className="card-emblem">{meta.symbol}</span>
        <span className="card-color-name">{meta.label}</span>
        {isCrown && <span className="highest-ribbon">Highest</span>}
      </span>
      <span className="card-corner card-corner-bottom" aria-hidden="true">
        <strong>{card.rank}</strong>
        <span>{meta.symbol}</span>
      </span>
    </>
  );

  if (onSelect) {
    return (
      <button
        type="button"
        className={className}
        aria-label={label}
        aria-pressed={selected}
        disabled={disabled}
        title={disabled ? unavailableReason : label}
        onClick={onSelect}
        style={{ "--deal-delay": `${delay}ms` } as React.CSSProperties}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className={className}
      role="img"
      aria-label={label}
      style={{ "--deal-delay": `${delay}ms` } as React.CSSProperties}
    >
      {content}
    </div>
  );
}

function CardBack({ small = false }: { small?: boolean }) {
  return (
    <span
      className={`card-back ${small ? "card-back-small" : ""}`}
      aria-hidden="true"
    >
      <span className="card-back-inset">
        <i />
        <b>H</b>
        <i />
      </span>
    </span>
  );
}

function SuitChip({ color, label = true }: { color: Color; label?: boolean }) {
  const meta = COLOR_META[color];
  return (
    <span className={`suit-chip suit-${color}`}>
      <span aria-hidden="true">{meta.symbol}</span>
      {label && <strong>{meta.label}</strong>}
    </span>
  );
}

function ModalLayer({
  children,
  onClose,
  strong = false,
}: {
  children: React.ReactNode;
  onClose?: () => void;
  strong?: boolean;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const backdrop = backdropRef.current;
    const dialog = backdrop?.querySelector<HTMLElement>(
      '[role="dialog"], [role="alertdialog"]',
    );
    const page = document.querySelector<HTMLElement>("main");
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    page?.setAttribute("inert", "");
    document.body.style.overflow = "hidden";

    const focusableSelector =
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusable = () =>
      dialog
        ? Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
        : [];
    const frame = window.requestAnimationFrame(() => {
      const targets = focusable();
      (targets[0] ?? dialog)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && onCloseRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;
      const targets = focusable();
      if (targets.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }

      const first = targets[0];
      const last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      page?.removeAttribute("inert");
      previousFocus?.focus();
    };
  }, []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={backdropRef}
      className={`modal-backdrop ${strong ? "modal-backdrop-strong" : ""}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCloseRef.current?.();
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function RulesDialog({ onClose }: { onClose: () => void }) {
  return (
    <ModalLayer onClose={onClose}>
      <section
        className="rules-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rules-title"
        tabIndex={-1}
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">House rules</span>
            <h2 id="rules-title">How to play High Trump</h2>
          </div>
          <button
            type="button"
            className="close-button"
            onClick={onClose}
            aria-label="Close rules"
          >
            ×
          </button>
        </header>

        <div className="rules-grid">
          <article>
            <span className="rule-number">01</span>
            <h3>High bid opens</h3>
            <p>
              After the deal and trump reveal, players bid clockwise. Earlier
              bids stay visible. The highest bidder leads the first trick;
              Board is highest, and the first bid wins a tie.
            </p>
          </article>
          <article>
            <span className="rule-number">02</span>
            <h3>Follow the lead</h3>
            <p>
              The first card sets the lead color for that trick. You must play
              that color when you have it. If you do not, any card is legal.
              Whoever wins the trick leads the next one.
            </p>
          </article>
          <article>
            <span className="rule-number">03</span>
            <h3>Break trump first</h3>
            <p>
              Trump cannot lead a trick until someone who is void in the lead
              color plays trump. If trump is the only color left in your hand,
              you may lead it, and that forced lead breaks trump.
            </p>
          </article>
          <article>
            <span className="rule-number">04</span>
            <h3>Trump cuts through</h3>
            <p>
              Every trump-color card beats every ordinary non-trump. Otherwise,
              the highest card in the lead color wins. High rank wins within a
              color.
            </p>
          </article>
          <article className="yellow-rule">
            <span className="rule-number">★</span>
            <h3>Yellow 2 is supreme</h3>
            <p>
              Yellow 2 beats every other card—even the highest trump. It is
              still a Yellow card and must obey the follow-color rule.
            </p>
          </article>
        </div>

        <div className="scoring-rules">
          <h3>Scoring</h3>
          <div>
            <span>
              <strong>Made your bid</strong>
              3 points per bid trick
            </span>
            <span>
              <strong>Overtricks</strong>
              +1 for each extra
            </span>
            <span>
              <strong>Under bid</strong>
              −1 for each trick short
            </span>
            <span>
              <strong>Board</strong>
              +20 made · −20 missed
            </span>
          </div>
        </div>

        <button type="button" className="primary-button" onClick={onClose}>
          Back to the table
        </button>
      </section>
    </ModalLayer>
  );
}

export default function Home() {
  const [settings, setSettings] = useState<GameSettings>(DEFAULT_SETTINGS);
  const [phase, setPhase] = useState<Phase>("setup");
  const [players, setPlayers] = useState<Player[]>([]);
  const [schedule, setSchedule] = useState<number[]>([]);
  const [roundIndex, setRoundIndex] = useState(0);
  const [handSize, setHandSize] = useState(1);
  const [dealerIndex, setDealerIndex] = useState(0);
  const [firstBidderIndex, setFirstBidderIndex] = useState(0);
  const [currentPlayerIndex, setCurrentPlayerIndex] = useState(0);
  const [trumpCard, setTrumpCard] = useState<Card | null>(null);
  const [trumpBroken, setTrumpBroken] = useState(false);
  const [trick, setTrick] = useState<PlayedCard[]>([]);
  const [bidLog, setBidLog] = useState<BidLogEntry[]>([]);
  const [lastWinner, setLastWinner] = useState<PlayedCard | null>(null);
  const [roundResults, setRoundResults] = useState<RoundResult[]>([]);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [boardConfirmOpen, setBoardConfirmOpen] = useState(false);
  const playCardButtonRef = useRef<HTMLButtonElement>(null);
  const [announcement, setAnnouncement] = useState(
    "Choose your table settings to begin.",
  );

  const maxAllowed = Math.min(18, getMaxHandSize(settings.playerCount));
  const setupSchedule = useMemo(
    () => buildRoundSchedule(Math.min(settings.maxHand, maxAllowed)),
    [settings.maxHand, maxAllowed],
  );

  const beginRound = useCallback(
    (basePlayers: Player[], nextRoundIndex: number, gameSchedule: number[]) => {
      const nextHandSize = gameSchedule[nextRoundIndex];
      const deal = dealRound(basePlayers.length, nextHandSize);
      const nextDealer = nextRoundIndex % basePlayers.length;
      const firstToAct = (nextDealer + 1) % basePlayers.length;
      const dealtPlayers = basePlayers.map((player, index) => ({
        ...player,
        bid: null,
        tricks: 0,
        hand: sortHand(deal.hands[index]),
        lastDelta: nextRoundIndex === 0 ? null : player.lastDelta,
      }));

      setPlayers(dealtPlayers);
      setRoundIndex(nextRoundIndex);
      setHandSize(nextHandSize);
      setDealerIndex(nextDealer);
      setFirstBidderIndex(firstToAct);
      setCurrentPlayerIndex(firstToAct);
      setTrumpCard(deal.trumpCard);
      setTrumpBroken(false);
      setTrick([]);
      setBidLog([]);
      setLastWinner(null);
      setRoundResults([]);
      setSelectedCardId(null);
      setBoardConfirmOpen(false);
      setPhase("bidding");
      setAnnouncement(
        `${COLOR_META[deal.trumpColor].label} is trump. ${
          dealtPlayers[firstToAct].name
        } bids first.`,
      );
    },
    [],
  );

  const startGame = () => {
    const safeMax = Math.max(1, Math.min(settings.maxHand, maxAllowed));
    const nextSchedule = buildRoundSchedule(safeMax);
    const humanName = settings.playerName.trim() || "You";
    const nextPlayers: Player[] = Array.from(
      { length: settings.playerCount },
      (_, index) => ({
        id: index,
        name: index === 0 ? humanName : AI_NAMES[index - 1],
        isHuman: index === 0,
        score: 0,
        bid: null,
        tricks: 0,
        hand: [],
        lastDelta: null,
      }),
    );

    setSettings((current) => ({ ...current, maxHand: safeMax }));
    setSchedule(nextSchedule);
    beginRound(nextPlayers, 0, nextSchedule);
  };

  const commitBid = useCallback(
    (playerIndex: number, bid: Bid) => {
      if (
        phase !== "bidding" ||
        playerIndex !== currentPlayerIndex ||
        bidLog.some((entry) => entry.playerIndex === playerIndex)
      ) {
        return;
      }

      const nextPlayers = players.map((player, index) =>
        index === playerIndex ? { ...player, bid } : player,
      );
      const nextBidLog = [...bidLog, { playerIndex, bid }];
      setPlayers(nextPlayers);
      setBidLog(nextBidLog);
      setBoardConfirmOpen(false);

      if (nextBidLog.length === nextPlayers.length) {
        const openingLeader = getOpeningLeaderIndex(nextBidLog);
        const openingBid = nextBidLog.find(
          (entry) => entry.playerIndex === openingLeader,
        )?.bid;
        const openingSubject = nextPlayers[openingLeader].isHuman
          ? "You have"
          : `${nextPlayers[openingLeader].name} has`;
        const openingLeadVerb = nextPlayers[openingLeader].isHuman
          ? "lead"
          : "leads";
        setPhase("playing");
        setCurrentPlayerIndex(openingLeader);
        setAnnouncement(
          `Bidding is complete. ${openingSubject} the high bid, ${displayBid(
            openingBid ?? 0,
          )}, and ${openingLeadVerb} the first trick. Trump is unbroken.`,
        );
        return;
      }

      const nextBidder = (playerIndex + 1) % nextPlayers.length;
      const nextBidderSubject = nextPlayers[nextBidder].isHuman
        ? "You are"
        : `${nextPlayers[nextBidder].name} is`;
      const currentHighBidder = getOpeningLeaderIndex(nextBidLog);
      const currentHighBid = nextBidLog.find(
        (entry) => entry.playerIndex === currentHighBidder,
      )?.bid;
      const highBidSubject = nextPlayers[currentHighBidder].isHuman
        ? "You currently hold"
        : `${nextPlayers[currentHighBidder].name} currently holds`;
      setCurrentPlayerIndex(nextBidder);
      setAnnouncement(
        `${nextPlayers[playerIndex].name} bid ${displayBid(
          bid,
        )}. ${highBidSubject} the high bid at ${displayBid(
          currentHighBid ?? 0,
        )}. ${nextBidderSubject} next.`,
      );
    },
    [
      bidLog,
      currentPlayerIndex,
      phase,
      players,
    ],
  );

  useEffect(() => {
    if (
      phase !== "bidding" ||
      players.length === 0 ||
      players[currentPlayerIndex]?.isHuman ||
      !trumpCard
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      const player = players[currentPlayerIndex];
      const bid = chooseAiBid(
        player.hand,
        trumpCard.color,
        handSize,
        bidLog.map((entry) => entry.bid),
      );
      commitBid(currentPlayerIndex, bid);
    }, 620);

    return () => window.clearTimeout(timer);
  }, [
    bidLog,
    commitBid,
    currentPlayerIndex,
    handSize,
    phase,
    players,
    trumpCard,
  ]);

  const playCard = useCallback(
    (playerIndex: number, card: Card) => {
      if (
        phase !== "playing" ||
        playerIndex !== currentPlayerIndex ||
        !trumpCard
      ) {
        return;
      }

      const player = players[playerIndex];
      const leadBeforePlay = getLeadColor(trick);
      const legalCards = getLegalCards(player.hand, {
        leadColor: leadBeforePlay,
        trumpColor: trumpCard.color,
        trumpBroken,
      });
      if (!legalCards.some((legalCard) => legalCard.id === card.id)) {
        if (leadBeforePlay === undefined && card.color === trumpCard.color) {
          setAnnouncement(
            `${COLOR_META[trumpCard.color].label} trump has not been broken. Lead a non-trump card unless trump is the only color you hold.`,
          );
        } else if (leadBeforePlay !== undefined) {
          setAnnouncement(
            `You must follow ${COLOR_META[leadBeforePlay].label}.`,
          );
        }
        return;
      }

      const breaksTrump =
        !trumpBroken &&
        doesPlayBreakTrump(
          card,
          player.hand,
          trick,
          trumpCard.color,
        );
      const nextPlayers = players.map((entry, index) =>
        index === playerIndex
          ? {
              ...entry,
              hand: entry.hand.filter((held) => held.id !== card.id),
            }
          : entry,
      );
      const nextTrick = [...trick, { playerIndex, card }];
      setSelectedCardId(null);
      setTrick(nextTrick);
      if (breaksTrump) {
        setTrumpBroken(true);
      }

      if (nextTrick.length < nextPlayers.length) {
        const nextPlayerIndex = (playerIndex + 1) % nextPlayers.length;
        setPlayers(nextPlayers);
        setCurrentPlayerIndex(nextPlayerIndex);
        setAnnouncement(
          breaksTrump
            ? `${nextPlayers[playerIndex].name} breaks ${
                COLOR_META[trumpCard.color].label
              } trump. ${nextPlayers[nextPlayerIndex].name} is next.`
            : `${nextPlayers[nextPlayerIndex].name} to play.`,
        );
        return;
      }

      const winner = getTrickWinner(nextTrick, trumpCard.color);
      const awardedPlayers = nextPlayers.map((entry, index) =>
        index === winner.playerIndex
          ? { ...entry, tricks: entry.tricks + 1 }
          : entry,
      );
      setPlayers(awardedPlayers);
      setLastWinner(winner);
      setCurrentPlayerIndex(winner.playerIndex);
      setPhase("trick-result");
      setAnnouncement(
        `${awardedPlayers[winner.playerIndex].name} wins the trick. ${describeTrickWin(
          winner,
          nextTrick,
          trumpCard.color,
        )}.${breaksTrump ? ` ${COLOR_META[trumpCard.color].label} trump is now broken.` : ""}`,
      );
    },
    [
      currentPlayerIndex,
      phase,
      players,
      trick,
      trumpBroken,
      trumpCard,
    ],
  );

  useEffect(() => {
    if (
      phase !== "playing" ||
      players.length === 0 ||
      players[currentPlayerIndex]?.isHuman ||
      !trumpCard
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      const player = players[currentPlayerIndex];
      const card = chooseAiCard(
        player.hand,
        trick,
        trumpCard.color,
        player.bid ?? 0,
        player.tricks,
        { trumpBroken },
      );
      playCard(currentPlayerIndex, card);
    }, 720);

    return () => window.clearTimeout(timer);
  }, [
    currentPlayerIndex,
    phase,
    playCard,
    players,
    trick,
    trumpBroken,
    trumpCard,
  ]);

  const finishTrick = () => {
    if (!lastWinner) return;

    const roundIsComplete = players.every((player) => player.hand.length === 0);
    if (!roundIsComplete) {
      setTrick([]);
      setLastWinner(null);
      setPhase("playing");
      setCurrentPlayerIndex(lastWinner.playerIndex);
      setAnnouncement(
        `${players[lastWinner.playerIndex].name} leads the next trick. Trump is ${
          trumpBroken ? "broken" : "still unbroken"
        }.`,
      );
      return;
    }

    const results = players.map((player, playerIndex) => {
      const bid = player.bid ?? 0;
      const delta = scoreBid(bid, player.tricks, handSize);
      return {
        playerIndex,
        name: player.name,
        bid,
        tricks: player.tricks,
        delta,
        previousTotal: player.score,
        total: player.score + delta,
      };
    });
    const scoredPlayers = players.map((player, playerIndex) => ({
      ...player,
      score: results[playerIndex].total,
      lastDelta: results[playerIndex].delta,
    }));

    setPlayers(scoredPlayers);
    setRoundResults(results);
    setPhase("round-result");
    setAnnouncement(`Round ${roundIndex + 1} is complete. Scores are ready.`);
  };

  const advanceRound = () => {
    if (roundIndex >= schedule.length - 1) {
      setPhase("game-over");
      const highScore = Math.max(...players.map((player) => player.score));
      const winners = players
        .filter((player) => player.score === highScore)
        .map((player) => player.name);
      setAnnouncement(
        winners.length === 1
          ? `${winners[0]} wins with ${highScore} points.`
          : `${winners.join(" and ")} tie with ${highScore} points.`,
      );
      return;
    }

    beginRound(players, roundIndex + 1, schedule);
  };

  const resetToSetup = () => {
    setPhase("setup");
    setPlayers([]);
    setSchedule([]);
    setTrick([]);
    setBidLog([]);
    setLastWinner(null);
    setRoundResults([]);
    setTrumpCard(null);
    setTrumpBroken(false);
    setAnnouncement("Choose your table settings to begin.");
  };

  const human = players.find((player) => player.isHuman);
  const currentPlayer = players[currentPlayerIndex];
  const leadColor = getLeadColor(trick);
  const currentPlayerOnlyHasTrump =
    Boolean(currentPlayer && trumpCard && currentPlayer.hand.length > 0) &&
    currentPlayer.hand.every((card) => card.color === trumpCard?.color);
  const leadInstruction = leadColor
    ? `${COLOR_META[leadColor].label} was led`
    : !trumpBroken && trumpCard
      ? currentPlayerOnlyHasTrump
        ? `Only ${COLOR_META[trumpCard.color].label} remains — trump may lead`
        : `${COLOR_META[trumpCard.color].label} trump is locked — lead another color`
      : "Lead any color";
  const legalIds = useMemo(() => {
    if (
      !human ||
      !trumpCard ||
      phase !== "playing" ||
      !currentPlayer?.isHuman
    ) {
      return new Set<string>();
    }
    return new Set(
      getLegalCards(human.hand, {
        leadColor,
        trumpColor: trumpCard.color,
        trumpBroken,
      }).map((card) => card.id),
    );
  }, [
    currentPlayer?.isHuman,
    human,
    leadColor,
    phase,
    trumpBroken,
    trumpCard,
  ]);
  const openingLeaderIndex =
    bidLog.length === players.length && bidLog.length > 0
      ? getOpeningLeaderIndex(bidLog)
      : null;
  const currentHighBidderIndex =
    bidLog.length > 0 ? getOpeningLeaderIndex(bidLog) : null;
  const completedTricks = players.reduce(
    (total, player) => total + player.tricks,
    0,
  );
  const isOpeningLead =
    phase === "playing" && completedTricks === 0 && trick.length === 0;
  const selectedCard = human?.hand.find(
    (card) => card.id === selectedCardId,
  );
  useEffect(() => {
    if (selectedCardId && phase === "playing" && currentPlayer?.isHuman) {
      playCardButtonRef.current?.focus();
    }
  }, [currentPlayer?.isHuman, phase, selectedCardId]);
  const standings = useMemo(
    () =>
      [...players].sort(
        (left, right) => right.score - left.score || left.id - right.id,
      ),
    [players],
  );
  const gameWinners =
    standings.length > 0
      ? standings.filter((player) => player.score === standings[0].score)
      : [];

  if (phase === "setup") {
    return (
      <main className="setup-screen">
        <div className="setup-glow setup-glow-left" />
        <div className="setup-glow setup-glow-right" />
        <nav className="setup-nav" aria-label="Game navigation">
          <a className="brand" href="#" aria-label="High Trump home">
            <span className="brand-mark" aria-hidden="true">
              <i />
              <b>2</b>
            </span>
            <span>
              <strong>High Trump</strong>
              <small>A Rook-style card game</small>
            </span>
          </a>
          <button
            type="button"
            className="text-button"
            onClick={() => setRulesOpen(true)}
          >
            How to play
          </button>
        </nav>

        <div className="setup-content">
          <section className="setup-hero">
            <span className="eyebrow">
              Read the table. Call your hand. Take the trick.
            </span>
            <h1>
              Every bid is a promise.
              <em>Every card can break it.</em>
            </h1>
            <p>
              A strategic trick-taking game played with a 56-card Rook deck.
              Follow the lead, use trump wisely, and never lose sight of the
              unbeatable Yellow 2.
            </p>

            <div className="hero-rule-row">
              <span>
                <i>◆</i>
                Bid in order
              </span>
              <span>
                <i>▲</i>
                Follow color
              </span>
              <span>
                <i>✦</i>
                Call Board
              </span>
            </div>

            <div className="hero-cards" aria-label="Example game cards">
              <CardFace
                card={{ id: "red-14", color: "red", rank: 14 }}
                compact
              />
              <CardFace
                card={{ id: "green-11", color: "green", rank: 11 }}
                compact
              />
              <CardFace
                card={{ id: "yellow-2", color: "yellow", rank: 2 }}
                compact
              />
              <span className="hero-trump-tag">Absolute high</span>
            </div>
          </section>

          <section className="setup-panel" aria-labelledby="table-title">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">New table</span>
                <h2 id="table-title">Set the stakes</h2>
              </div>
              <span className="deck-badge">56 cards</span>
            </div>

            <label className="field-group">
              <span>Your name</span>
              <input
                type="text"
                value={settings.playerName}
                maxLength={14}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    playerName: event.target.value,
                  }))
                }
                placeholder="You"
              />
            </label>

            <fieldset className="field-group">
              <legend>Players</legend>
              <div className="segmented-control">
                {[3, 4, 5, 6].map((count) => (
                  <button
                    type="button"
                    key={count}
                    className={
                      settings.playerCount === count ? "is-active" : ""
                    }
                    onClick={() =>
                      setSettings((current) => ({
                        ...current,
                        playerCount: count,
                        maxHand: Math.min(
                          current.maxHand,
                          Math.min(18, getMaxHandSize(count)),
                        ),
                      }))
                    }
                    aria-pressed={settings.playerCount === count}
                  >
                    {count}
                  </button>
                ))}
              </div>
              <small>You + {settings.playerCount - 1} computer players</small>
            </fieldset>

            <fieldset className="field-group max-hand-field">
              <legend>
                Maximum hand
                <strong>{settings.maxHand} cards</strong>
              </legend>
              <input
                type="range"
                min="1"
                max={maxAllowed}
                value={Math.min(settings.maxHand, maxAllowed)}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    maxHand: Number(event.target.value),
                  }))
                }
                aria-label="Maximum cards per player"
              />
              <div className="range-labels">
                <span>1</span>
                <span>{maxAllowed}</span>
              </div>
            </fieldset>

            <div className="round-preview">
              <div className="round-preview-header">
                <span>Round path</span>
                <strong>
                  {setupSchedule.length} round
                  {setupSchedule.length === 1 ? "" : "s"}
                </strong>
              </div>
              <div className="round-dots" aria-label="Round hand sizes">
                {setupSchedule.map((size, index) => (
                  <span
                    key={`${size}-${index}`}
                    className={size === settings.maxHand ? "is-peak" : ""}
                    title={`Round ${index + 1}: ${size} card${
                      size === 1 ? "" : "s"
                    }`}
                  >
                    {size}
                  </span>
                ))}
              </div>
            </div>

            <button
              type="button"
              className="primary-button deal-button"
              onClick={startGame}
            >
              <span>Deal the first round</span>
              <b aria-hidden="true">→</b>
            </button>
            <p className="setup-footnote">
              Bidding rotates each round. The high bid opens the first trick.
            </p>
          </section>
        </div>

        <footer className="setup-footer">
          <span>Four colors · Ranks 1–14 · No Rook card</span>
          <span className="suit-key" aria-label="Card colors">
            {(Object.keys(COLOR_META) as Color[]).map((color) => (
              <SuitChip color={color} label={false} key={color} />
            ))}
          </span>
        </footer>
        {rulesOpen && <RulesDialog onClose={() => setRulesOpen(false)} />}
      </main>
    );
  }

  return (
    <main className="game-shell">
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>

      <header className="game-topbar">
        <a
          className="brand brand-compact"
          href="#"
          onClick={resetToSetup}
          aria-label="Return to game setup"
        >
          <span className="brand-mark" aria-hidden="true">
            <i />
            <b>2</b>
          </span>
          <span>
            <strong>High Trump</strong>
            <small>Table {settings.playerCount}</small>
          </span>
        </a>

        <div className="topbar-round">
          <span className="mobile-game-context">
            R{roundIndex + 1}/{schedule.length} ·{" "}
            {trumpCard ? `${COLOR_META[trumpCard.color].label} trump` : ""} ·{" "}
            {trumpBroken ? "Broken" : "Locked"}
          </span>
          <span>
            Round <strong>{roundIndex + 1}</strong> of {schedule.length}
          </span>
          <i />
          <span>
            <strong>{handSize}</strong> card{handSize === 1 ? "" : "s"}
          </span>
          {trumpCard && (
            <>
              <i />
              <SuitChip color={trumpCard.color} />
              <span
                className={`trump-state-chip ${
                  trumpBroken ? "is-broken" : "is-unbroken"
                }`}
              >
                {trumpBroken ? "Broken" : "Unbroken"}
              </span>
            </>
          )}
        </div>

        <div className="topbar-actions">
          <button
            type="button"
            className="text-button"
            onClick={() => setRulesOpen(true)}
          >
            Rules
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={resetToSetup}
            aria-label="Leave game and return to setup"
            title="New game"
          >
            ↻
          </button>
        </div>
      </header>

      <div className="game-layout">
        <section className="table-column" aria-label="Card table">
          <div
            className="opponents-rack"
            role="region"
            aria-label="Computer players. Scroll horizontally for all players."
            tabIndex={0}
          >
            {players
              .filter((player) => !player.isHuman)
              .map((player) => {
                const playerIndex = players.findIndex(
                  (entry) => entry.id === player.id,
                );
                const isCurrent = playerIndex === currentPlayerIndex;
                return (
                  <article
                    className={`opponent-seat ${
                      isCurrent ? "is-current" : ""
                    } ${
                      phase === "bidding" &&
                      currentHighBidderIndex === playerIndex
                        ? "has-high-bid"
                        : ""
                    } ${
                      isOpeningLead && openingLeaderIndex === playerIndex
                        ? "is-opening-leader"
                        : ""
                    }`}
                    key={player.id}
                  >
                    <div className="seat-avatar" aria-hidden="true">
                      {player.name.slice(0, 1)}
                      {playerIndex === dealerIndex && (
                        <span className="dealer-pin">D</span>
                      )}
                    </div>
                    <div className="seat-copy">
                      <strong>
                        {player.name}
                        {isOpeningLead &&
                          openingLeaderIndex === playerIndex && (
                            <em>Opens</em>
                          )}
                      </strong>
                      <span>
                        {phase === "bidding" && player.bid === null
                          ? isCurrent
                            ? "Choosing a bid…"
                            : "Waiting to bid"
                          : `${displayBid(player.bid)} bid · ${
                              player.tricks
                            } won · ${player.score} pts`}
                      </span>
                    </div>
                    <div className="opponent-hand" aria-label="Hidden cards">
                      <CardBack small />
                      <span>{player.hand.length}</span>
                    </div>
                    <b
                      className="opponent-score"
                      aria-hidden="true"
                    >
                      {player.score}
                      <small>pts</small>
                    </b>
                  </article>
                );
              })}
          </div>

          <div className="table-frame">
            <div className="table-felt">
              <div className="felt-grain" />
              <div className="trump-plinth">
                <span className="plinth-label">Trump card</span>
                {trumpCard && <CardFace card={trumpCard} compact />}
                {trumpCard && (
                  <div className="trump-readout">
                    <SuitChip color={trumpCard.color} />
                    <span
                      className={`trump-break-state ${
                        trumpBroken ? "is-broken" : ""
                      }`}
                    >
                      <i aria-hidden="true">{trumpBroken ? "↯" : "◇"}</i>
                      {trumpBroken ? "Broken" : "Locked"}
                    </span>
                  </div>
                )}
              </div>

              <div className="trick-stage">
                {trick.length === 0 && phase !== "bidding" && (
                  <div className="empty-trick">
                    <span aria-hidden="true">◇</span>
                    <strong>
                      {currentPlayer?.isHuman
                        ? "Your lead"
                        : `${currentPlayer?.name} leads`}
                    </strong>
                    <small>
                      {isOpeningLead
                        ? `${displayBid(
                            currentPlayer?.bid ?? null,
                          )} is the high bid · ${leadInstruction}`
                        : leadInstruction}
                    </small>
                  </div>
                )}

                {trick.length > 0 && (
                  <div
                    className="trick-grid"
                    aria-label={`Current trick, ${trick.length} cards played`}
                  >
                    {trick.map((play, index) => (
                      <div
                        className={`played-card ${
                          lastWinner?.playerIndex === play.playerIndex
                            ? "is-winner"
                            : ""
                        }`}
                        key={`${play.playerIndex}-${play.card.id}`}
                      >
                        <span>{players[play.playerIndex].name}</span>
                        <CardFace card={play.card} compact delay={index * 70} />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {phase === "bidding" && (
                <section className="bid-console" aria-labelledby="bid-title">
                  <div className="bid-console-heading">
                    <span className="phase-chip">Bidding</span>
                    <h2 id="bid-title">
                      {currentPlayer?.isHuman
                        ? "How many tricks will you take?"
                        : `${currentPlayer?.name} is studying the hand`}
                    </h2>
                    <p>
                      {currentPlayer?.isHuman
                        ? `Choose 0–${handSize}, or risk it all with Board.`
                        : "Each player can see every bid made before theirs."}
                    </p>
                    <div className="bid-rule-strip">
                      <span>High bid opens</span>
                      <span>Board is highest</span>
                      <span>First bid wins ties</span>
                    </div>
                  </div>

                  {currentPlayer?.isHuman ? (
                    <>
                      <div
                        className="bid-options"
                        aria-label="Choose your bid"
                      >
                        {Array.from(
                          { length: handSize + 1 },
                          (_, bid) => (
                            <button
                              type="button"
                              key={bid}
                              onClick={() => commitBid(currentPlayerIndex, bid)}
                              aria-label={`Bid ${bid} trick${
                                bid === 1 ? "" : "s"
                              }`}
                            >
                              {bid}
                            </button>
                          ),
                        )}
                      </div>
                      <button
                        type="button"
                        className="board-button"
                        onClick={() => setBoardConfirmOpen(true)}
                      >
                        <span aria-hidden="true">♛</span>
                        <strong>Call Board</strong>
                        <small>Take every trick · ±20</small>
                      </button>
                    </>
                  ) : (
                    <div className="thinking-cards" aria-hidden="true">
                      <CardBack />
                      <CardBack />
                      <CardBack />
                    </div>
                  )}

                  <div
                    className={`bid-order player-count-${players.length}`}
                  >
                    {rotateOrder(players.length, firstBidderIndex).map(
                      (playerIndex, orderIndex) => {
                        const player = players[playerIndex];
                        const entry = bidLog.find(
                          (item) => item.playerIndex === playerIndex,
                        );
                        return (
                          <span
                            key={player.id}
                            className={`${
                              playerIndex === currentPlayerIndex
                                ? "is-current"
                                : entry
                                  ? "is-complete"
                                  : ""
                            } ${
                              entry &&
                              currentHighBidderIndex === playerIndex
                                ? "is-high-bid"
                                : ""
                            }`}
                          >
                            <i>{orderIndex + 1}</i>
                            {player.name}
                            <b>{entry ? displayBid(entry.bid) : "…"}</b>
                            {entry &&
                              currentHighBidderIndex === playerIndex && (
                                <em>Leads</em>
                              )}
                          </span>
                        );
                      },
                    )}
                  </div>
                </section>
              )}

              {phase === "trick-result" && lastWinner && trumpCard && (
                <section className="trick-result-banner">
                  <span className="winner-kicker">Trick won</span>
                  <h2>{players[lastWinner.playerIndex].name}</h2>
                  <p>{describeTrickWin(lastWinner, trick, trumpCard.color)}</p>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={finishTrick}
                  >
                    {players.every((player) => player.hand.length === 0)
                      ? "Score the round"
                      : "Next trick"}
                    <span aria-hidden="true">→</span>
                  </button>
                </section>
              )}

              {phase === "playing" && currentPlayer && (
                <div
                  className={`turn-banner ${
                    currentPlayer.isHuman ? "is-human-turn" : ""
                  }`}
                >
                  <span className="turn-pulse" />
                  <strong>
                    {currentPlayer.isHuman
                      ? "Your turn"
                      : `${currentPlayer.name} is playing`}
                  </strong>
                  <small>
                    {leadInstruction}
                  </small>
                </div>
              )}
            </div>
          </div>

          <section className="player-zone" aria-label="Your hand">
            <header className="player-zone-header">
              <div className="player-identity">
                <span className="seat-avatar human-avatar">
                  {human?.name.slice(0, 1)}
                  {dealerIndex === 0 && <i className="dealer-pin">D</i>}
                </span>
                <span>
                  <strong>
                    {human?.name}
                    {isOpeningLead && openingLeaderIndex === 0 && (
                      <em className="opening-tag">Opens</em>
                    )}
                  </strong>
                  <small>
                    {human?.score ?? 0} pts · Bid{" "}
                    {displayBid(human?.bid ?? null)} · {human?.tricks ?? 0}{" "}
                    won
                  </small>
                </span>
              </div>
              {phase === "playing" && currentPlayer?.isHuman && (
                <div className="follow-note">
                  {leadColor &&
                  !human?.hand.some((card) => card.color === leadColor)
                    ? `Void in ${COLOR_META[leadColor].label} — any card is legal`
                    : leadColor
                      ? `Follow ${COLOR_META[leadColor].label}`
                      : leadInstruction}
                </div>
              )}
              {phase === "bidding" && (
                <div className="hand-status-note">
                  {currentPlayer?.isHuman
                    ? "Your bid is up"
                    : `Bidding · ${currentPlayer?.name} is deciding`}
                </div>
              )}
              {phase === "playing" && !currentPlayer?.isHuman && (
                <div className="hand-status-note">
                  Waiting for {currentPlayer?.name}
                </div>
              )}
              {selectedCard && phase === "playing" && (
                <button
                  ref={playCardButtonRef}
                  type="button"
                  className="play-card-button"
                  onClick={() => playCard(0, selectedCard)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setSelectedCardId(null);
                    }
                  }}
                >
                  Play {COLOR_META[selectedCard.color].label}{" "}
                  {selectedCard.rank}
                  <span aria-hidden="true">↑</span>
                </button>
              )}
            </header>

            <div className="hand-scroll">
              <div
                className={`player-hand ${
                  phase === "playing" && currentPlayer?.isHuman
                    ? "is-active"
                    : ""
                }`}
              >
                {human?.hand.map((card, index) => {
                  const isLegal =
                    phase === "playing" &&
                    currentPlayer?.isHuman &&
                    legalIds.has(card.id);
                  const unavailableReason =
                    phase === "bidding"
                      ? "Bidding is still in progress"
                      : phase !== "playing"
                        ? "Wait for the next trick"
                        : !currentPlayer?.isHuman
                          ? `Waiting for ${currentPlayer?.name}`
                          : leadColor
                            ? `You must follow ${
                                COLOR_META[leadColor].label
                              }`
                            : trumpCard &&
                                !trumpBroken &&
                                card.color === trumpCard.color
                              ? `${COLOR_META[trumpCard.color].label} trump is not broken`
                              : "This card is not legal now";
                  return (
                    <CardFace
                      key={card.id}
                      card={card}
                      selected={selectedCardId === card.id}
                      disabled={!isLegal}
                      unavailableReason={
                        isLegal ? undefined : unavailableReason
                      }
                      delay={index * 35}
                      onSelect={() =>
                        setSelectedCardId((current) =>
                          current === card.id ? null : card.id,
                        )
                      }
                    />
                  );
                })}
              </div>
            </div>
          </section>
        </section>

        <aside className="score-panel" aria-labelledby="score-title">
          <header>
            <div>
              <span className="eyebrow">Live table</span>
              <h2 id="score-title">Scoreboard</h2>
            </div>
            <span className="round-badge">
              {roundIndex + 1}/{schedule.length}
            </span>
          </header>

          <div
            className="score-list"
            role="region"
            aria-label="Player scores. Scroll horizontally on small screens."
            tabIndex={0}
          >
            {players.map((player, index) => (
              <article
                className={`${index === currentPlayerIndex ? "is-current" : ""} ${
                  player.isHuman ? "is-human" : ""
                }`}
                key={player.id}
              >
                <span className="score-rank">
                  {standings.findIndex((entry) => entry.id === player.id) + 1}
                </span>
                <span className="score-name">
                  <strong>{player.name}</strong>
                  <small>
                    {index === dealerIndex && "Dealer · "}
                    {displayBid(player.bid)} bid · {player.tricks} won
                  </small>
                </span>
                <span className="score-total">
                  <strong>{player.score}</strong>
                  {player.lastDelta !== null && (
                    <small
                      className={
                        player.lastDelta > 0
                          ? "positive"
                          : player.lastDelta === 0
                            ? "neutral"
                            : ""
                      }
                    >
                      {player.lastDelta > 0 ? "+" : ""}
                      {player.lastDelta}
                    </small>
                  )}
                </span>
              </article>
            ))}
          </div>

          <div className="round-track">
            <div>
              <span>Game path</span>
              <small>
                {schedule.length - roundIndex - 1} round
                {schedule.length - roundIndex - 1 === 1 ? "" : "s"} left
              </small>
            </div>
            <div className="track-line">
              {schedule.map((size, index) => (
                <i
                  key={`${size}-${index}`}
                  className={
                    index < roundIndex
                      ? "is-done"
                      : index === roundIndex
                        ? "is-current"
                        : ""
                  }
                  title={`Round ${index + 1}: ${size} card${
                    size === 1 ? "" : "s"
                  }`}
                />
              ))}
            </div>
            <p>
              Next:{" "}
              <strong>
                {schedule[roundIndex + 1]
                  ? `${schedule[roundIndex + 1]} card${
                      schedule[roundIndex + 1] === 1 ? "" : "s"
                    } each`
                  : "final scores"}
              </strong>
            </p>
          </div>

          <div className="score-legend">
            <span>
              <i>3×</i>
              Each bid trick
            </span>
            <span>
              <i>+1</i>
              Each overtrick
            </span>
            <span>
              <i>−1</i>
              Each trick short
            </span>
            <span>
              <i>±20</i>
              Board
            </span>
          </div>
        </aside>
      </div>

      {boardConfirmOpen && (
        <ModalLayer onClose={() => setBoardConfirmOpen(false)}>
          <section
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="board-title"
            tabIndex={-1}
          >
            <span className="board-crown" aria-hidden="true">
              ♛
            </span>
            <span className="eyebrow">High-risk call</span>
            <h2 id="board-title">Take every trick?</h2>
            <p>
              Make Board and score <strong>+20</strong>. Lose even one trick and
              take <strong>−20</strong>.
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setBoardConfirmOpen(false)}
              >
                Not this hand
              </button>
              <button
                type="button"
                className="board-confirm-button"
                onClick={() => commitBid(currentPlayerIndex, "BOARD")}
              >
                Call Board
              </button>
            </div>
          </section>
        </ModalLayer>
      )}

      {phase === "round-result" && (
        <ModalLayer strong>
          <section
            className="result-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="result-title"
            tabIndex={-1}
          >
            <header className="result-heading">
              <span className="result-medallion" aria-hidden="true">
                {roundIndex + 1}
              </span>
              <div>
                <span className="eyebrow">Round complete</span>
                <h2 id="result-title">
                  {handSize} card{handSize === 1 ? "" : "s"} played
                </h2>
                <p>Every promise settled. Here is how the table moved.</p>
              </div>
            </header>

            <div
              className="result-table-wrap"
              role="region"
              aria-label="Round results. Scroll horizontally for all columns."
              tabIndex={0}
            >
              <table className="result-table">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>Bid</th>
                    <th>Won</th>
                    <th>Score</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {roundResults.map((result) => (
                    <tr
                      key={result.playerIndex}
                      className={
                        result.playerIndex === 0 ? "is-human-result" : ""
                      }
                    >
                      <td>
                        <span
                          className={`mini-avatar ${
                            result.playerIndex === 0 ? "is-human" : ""
                          }`}
                        >
                          {result.name.slice(0, 1)}
                        </span>
                        <span>
                          <strong>{result.name}</strong>
                          <small>
                            {scoreExplanation(
                              result.bid,
                              result.tricks,
                              handSize,
                            )}
                          </small>
                        </span>
                      </td>
                      <td>{displayBid(result.bid)}</td>
                      <td>{result.tricks}</td>
                      <td
                        className={
                          result.delta > 0
                            ? "positive-score"
                            : result.delta < 0
                              ? "negative-score"
                              : "neutral-score"
                        }
                      >
                        {result.delta > 0 ? "+" : ""}
                        {result.delta}
                      </td>
                      <td>
                        <strong>{result.total}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <footer className="result-footer">
              <div>
                <span>Table leader</span>
                <strong>
                  {standings[0]?.name} · {standings[0]?.score} points
                </strong>
              </div>
              <button
                type="button"
                className="primary-button"
                onClick={advanceRound}
              >
                {roundIndex >= schedule.length - 1
                  ? "See final standings"
                  : `Deal round ${roundIndex + 2}`}
                <span aria-hidden="true">→</span>
              </button>
            </footer>
          </section>
        </ModalLayer>
      )}

      {phase === "game-over" && !rulesOpen && (
        <ModalLayer strong>
          <section
            className="game-over-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="game-over-title"
            tabIndex={-1}
          >
            <div className="victory-rays" aria-hidden="true" />
            <span className="victory-crown" aria-hidden="true">
              ♛
            </span>
            <span className="eyebrow">Final standings</span>
            <h2 id="game-over-title">
              {gameWinners.length === 1
                ? `${gameWinners[0].name} rules the table`
                : "The table ends in a tie"}
            </h2>
            <p>
              {schedule.length} rounds,{" "}
              {schedule.reduce((total, size) => total + size, 0)} tricks, one
              final score.
            </p>

            <div className="podium">
              {standings.map((player, index) => (
                <article
                  key={player.id}
                  className={index === 0 ? "is-winner" : ""}
                >
                  <span>{index + 1}</span>
                  <i className="mini-avatar">{player.name.slice(0, 1)}</i>
                  <strong>{player.name}</strong>
                  <b>{player.score}</b>
                  <small>points</small>
                </article>
              ))}
            </div>

            <div className="dialog-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setRulesOpen(true)}
              >
                Review rules
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={resetToSetup}
              >
                Play another game
                <span aria-hidden="true">↻</span>
              </button>
            </div>
          </section>
        </ModalLayer>
      )}

      {rulesOpen && <RulesDialog onClose={() => setRulesOpen(false)} />}
    </main>
  );
}
