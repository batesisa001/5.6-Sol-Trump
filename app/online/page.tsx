"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  getLeadColor,
  getLegalCards,
  getMaxHandSize,
  type Bid,
  type Card,
  type Color,
} from "@/lib/game-engine";
import type {
  OnlineRoomAction,
  OnlineRoomView,
} from "@/lib/multiplayer-engine";
import styles from "./online.module.css";

const COLOR_META: Record<
  Color,
  { label: string; symbol: string }
> = {
  black: { label: "Black", symbol: "●" },
  red: { label: "Red", symbol: "◆" },
  green: { label: "Green", symbol: "▲" },
  yellow: { label: "Yellow", symbol: "✦" },
};

type ConnectionState = "connected" | "syncing" | "offline";

class ApiError extends Error {
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
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.room = room;
  }
}

function joinClasses(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(" ");
}

function displayBid(bid: Bid | null): string {
  if (bid === null) return "—";
  return bid === "BOARD" ? "Board" : String(bid);
}

function rotateOrder(playerCount: number, start: number): number[] {
  return Array.from(
    { length: playerCount },
    (_, offset) => (start + offset) % playerCount,
  );
}

function createPlayerToken(): string {
  const values = new Uint8Array(24);
  crypto.getRandomValues(values);
  return Array.from(values, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

function createActionId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function sessionKey(code: string): string {
  return `high-trump:multiplayer:${code}`;
}

async function requestJson<T>(
  path: string,
  playerToken: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "x-high-trump-player": playerToken,
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    room?: OnlineRoomView;
  } & T;

  if (!response.ok) {
    throw new ApiError(
      payload.error ?? "The table could not be reached.",
      response.status,
      payload.code ?? "REQUEST_FAILED",
      payload.room,
    );
  }
  return payload;
}

function CardFace({
  card,
  compact = false,
  disabled = false,
  onPlay,
}: {
  card: Card;
  compact?: boolean;
  disabled?: boolean;
  onPlay?: () => void;
}) {
  const meta = COLOR_META[card.color];
  const isYellowTwo = card.color === "yellow" && card.rank === 2;
  const className = joinClasses(
    styles.card,
    styles[`card${card.color[0].toUpperCase()}${card.color.slice(1)}`],
    compact && styles.cardCompact,
    disabled && styles.cardUnavailable,
    isYellowTwo && styles.cardCrown,
  );
  const content = (
    <>
      <span className={styles.cardCorner}>
        <strong>{card.rank}</strong>
        <i>{meta.symbol}</i>
      </span>
      <span className={styles.cardCenter}>
        {isYellowTwo && <b>♛</b>}
        <i>{meta.symbol}</i>
        <small>{meta.label}</small>
        {isYellowTwo && <em>Highest</em>}
      </span>
      <span className={joinClasses(styles.cardCorner, styles.cardCornerBottom)}>
        <strong>{card.rank}</strong>
        <i>{meta.symbol}</i>
      </span>
    </>
  );

  if (onPlay) {
    return (
      <button
        type="button"
        className={className}
        onClick={onPlay}
        disabled={disabled}
        aria-label={`Play ${meta.label} ${card.rank}`}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className={className}
      role="img"
      aria-label={`${meta.label} ${card.rank}`}
    >
      {content}
    </div>
  );
}

function SuitChip({ color }: { color: Color }) {
  const meta = COLOR_META[color];
  return (
    <span
      className={joinClasses(
        styles.suitChip,
        styles[`suit${color[0].toUpperCase()}${color.slice(1)}`],
      )}
    >
      <i>{meta.symbol}</i>
      {meta.label}
    </span>
  );
}

function EmptySeat({ number }: { number: number }) {
  return (
    <article className={joinClasses(styles.seat, styles.emptySeat)}>
      <span>{number}</span>
      <div>
        <strong>Open seat</strong>
        <small>Waiting for a player</small>
      </div>
    </article>
  );
}

export default function OnlineGame() {
  const [room, setRoom] = useState<OnlineRoomView | null>(null);
  const [playerToken, setPlayerToken] = useState("");
  const [name, setName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [playerCount, setPlayerCount] = useState(4);
  const [maxHand, setMaxHand] = useState(7);
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] =
    useState<ConnectionState>("connected");
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const roomRef = useRef(room);
  const tokenRef = useRef(playerToken);
  const pollInFlight = useRef(false);
  const sessionGenerationRef = useRef(0);

  useEffect(() => {
    roomRef.current = room;
  }, [room]);
  useEffect(() => {
    tokenRef.current = playerToken;
  }, [playerToken]);

  const maxAllowed = Math.min(18, getMaxHandSize(playerCount));

  const acceptRoom = useCallback((nextRoom: OnlineRoomView) => {
    const currentRoom = roomRef.current;
    if (
      currentRoom?.code === nextRoom.code &&
      currentRoom.revision > nextRoom.revision
    ) {
      return false;
    }

    roomRef.current = nextRoom;
    setRoom(nextRoom);
    return true;
  }, []);

  const loadRoom = useCallback(
    async (code: string, token: string, quiet = false) => {
      const sessionGeneration = sessionGenerationRef.current;
      if (!quiet) setConnection("syncing");
      try {
        const payload = await requestJson<{ room: OnlineRoomView }>(
          `/api/rooms/${encodeURIComponent(code)}`,
          token,
        );
        if (
          sessionGeneration !== sessionGenerationRef.current ||
          tokenRef.current !== token
        ) {
          return false;
        }
        acceptRoom(payload.room);
        setMessage("");
        setConnection("connected");
        return true;
      } catch (error) {
        if (sessionGeneration !== sessionGenerationRef.current) {
          return false;
        }
        const apiError =
          error instanceof ApiError
            ? error
            : new ApiError("The table could not be reached.", 500, "OFFLINE");
        if (apiError.status === 401 || apiError.status === 404) {
          localStorage.removeItem(sessionKey(code));
          setPlayerToken("");
          setRoom(null);
          setMessage(apiError.message);
        } else if (!quiet) {
          setMessage(apiError.message);
        }
        setConnection("offline");
        return false;
      }
    },
    [acceptRoom],
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const params = new URLSearchParams(window.location.search);
      const requestedCode = (params.get("room") ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 6);
      if (!requestedCode) return;

      setRoomCode(requestedCode);
      const savedToken = localStorage.getItem(sessionKey(requestedCode));
      if (savedToken) {
        tokenRef.current = savedToken;
        setPlayerToken(savedToken);
        void loadRoom(requestedCode, savedToken);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loadRoom]);

  const activeRoomCode = room?.code;
  useEffect(() => {
    if (!activeRoomCode || !playerToken) return;
    let stopped = false;
    let timer: number | undefined;

    const poll = async () => {
      if (stopped) return;
      if (!pollInFlight.current) {
        pollInFlight.current = true;
        await loadRoom(activeRoomCode, playerToken, true);
        pollInFlight.current = false;
      }
      if (!stopped) {
        timer = window.setTimeout(
          poll,
          document.visibilityState === "visible" ? 900 : 2_500,
        );
      }
    };

    timer = window.setTimeout(poll, 900);
    const refresh = () => {
      if (document.visibilityState === "visible") {
        void loadRoom(activeRoomCode, playerToken, true);
      }
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [activeRoomCode, loadRoom, playerToken]);

  const seatAtTable = useCallback(
    (nextRoom: OnlineRoomView, token: string) => {
      sessionGenerationRef.current += 1;
      localStorage.setItem(sessionKey(nextRoom.code), token);
      tokenRef.current = token;
      roomRef.current = nextRoom;
      setPlayerToken(token);
      setRoom(nextRoom);
      setRoomCode(nextRoom.code);
      setConnection("connected");
      setMessage("");
      window.history.replaceState(
        null,
        "",
        `/online?room=${nextRoom.code}`,
      );
    },
    [],
  );

  const createTable = async () => {
    if (!name.trim()) {
      setMessage("Enter your name first.");
      return;
    }
    setBusy(true);
    setMessage("");
    const token = createPlayerToken();
    try {
      const payload = await requestJson<{ room: OnlineRoomView }>(
        "/api/rooms",
        token,
        {
          method: "POST",
          body: JSON.stringify({ name, playerCount, maxHand }),
        },
      );
      seatAtTable(payload.room, token);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not create the table.",
      );
    } finally {
      setBusy(false);
    }
  };

  const joinTable = async () => {
    const code = roomCode
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 6);
    if (!name.trim()) {
      setMessage("Enter your name first.");
      return;
    }
    if (code.length !== 6) {
      setMessage("Enter the six-character table code.");
      return;
    }
    setBusy(true);
    setMessage("");
    const savedToken = localStorage.getItem(sessionKey(code));
    const token = savedToken ?? createPlayerToken();
    try {
      const payload = await requestJson<{ room: OnlineRoomView }>(
        `/api/rooms/${encodeURIComponent(code)}/join`,
        token,
        {
          method: "POST",
          body: JSON.stringify({ name }),
        },
      );
      seatAtTable(payload.room, token);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not join the table.",
      );
    } finally {
      setBusy(false);
    }
  };

  const sendAction = useCallback(
    async (action: OnlineRoomAction) => {
      const currentRoom = roomRef.current;
      const token = tokenRef.current;
      if (!currentRoom || !token || busy) return;
      const sessionGeneration = sessionGenerationRef.current;

      setBusy(true);
      setMessage("");
      try {
        const payload = await requestJson<{ room: OnlineRoomView }>(
          `/api/rooms/${encodeURIComponent(currentRoom.code)}/actions`,
          token,
          {
            method: "POST",
            body: JSON.stringify({
              actionId: createActionId(),
              expectedRevision: currentRoom.revision,
              action,
            }),
          },
        );
        if (sessionGeneration !== sessionGenerationRef.current) return;
        acceptRoom(payload.room);
        setConnection("connected");
      } catch (error) {
        if (sessionGeneration !== sessionGenerationRef.current) return;
        if (error instanceof ApiError && error.room) {
          acceptRoom(error.room);
        }
        setMessage(
          error instanceof Error ? error.message : "That move was not accepted.",
        );
      } finally {
        if (sessionGeneration === sessionGenerationRef.current) {
          setBusy(false);
        }
      }
    },
    [acceptRoom, busy],
  );

  const copyInvitation = async () => {
    if (!room) return;
    const invitation = `${window.location.origin}/online?room=${room.code}`;
    try {
      await navigator.clipboard.writeText(invitation);
    } catch {
      const textArea = document.createElement("textarea");
      textArea.value = invitation;
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      textArea.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_800);
  };

  const leaveTable = () => {
    sessionGenerationRef.current += 1;
    roomRef.current = null;
    tokenRef.current = "";
    setRoom(null);
    setPlayerToken("");
    setBusy(false);
    setMessage("");
    window.history.replaceState(null, "", "/online");
  };

  if (!room) {
    return (
      <main className={styles.entryPage}>
        <div className={styles.ambientOne} />
        <div className={styles.ambientTwo} />
        <header className={styles.entryHeader}>
          <Link href="/" className={styles.brand}>
            <span className={styles.brandMark}>
              <i />
              <b>2</b>
            </span>
            <span>
              <strong>High Trump</strong>
              <small>Live multiplayer</small>
            </span>
          </Link>
          <Link href="/" className={styles.backLink}>
            Play solo
          </Link>
        </header>

        <section className={styles.entryHero}>
          <div className={styles.heroCopy}>
            <span className={styles.eyebrow}>One table. Every hand live.</span>
            <h1>
              Deal your friends in.
              <em>Keep your cards close.</em>
            </h1>
            <p>
              Create a private table, send the six-character code, and play
              every bid and trick together from your own devices.
            </p>
            <div className={styles.trustRow}>
              <span>Private hands</span>
              <span>Live turns</span>
              <span>Reconnect anytime</span>
            </div>
          </div>

          <div className={styles.entryPanels}>
            <section className={styles.entryPanel}>
              <span className={styles.panelNumber}>01</span>
              <h2>Create a table</h2>
              <p>You host the game and choose when to deal.</p>

              <label className={styles.field}>
                <span>Your name</span>
                <input
                  value={name}
                  maxLength={18}
                  autoComplete="nickname"
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Enter your name"
                />
              </label>

              <fieldset className={styles.field}>
                <legend>Seats</legend>
                <div className={styles.segmented}>
                  {[2, 3, 4, 5, 6].map((count) => (
                    <button
                      type="button"
                      key={count}
                      className={playerCount === count ? styles.active : ""}
                      onClick={() => {
                        setPlayerCount(count);
                        setMaxHand((current) =>
                          Math.min(
                            current,
                            Math.min(18, getMaxHandSize(count)),
                          ),
                        );
                      }}
                    >
                      {count}
                    </button>
                  ))}
                </div>
              </fieldset>

              <label className={styles.rangeField}>
                <span>
                  Maximum hand <b>{maxHand} cards</b>
                </span>
                <input
                  type="range"
                  min="1"
                  max={maxAllowed}
                  value={maxHand}
                  onChange={(event) => setMaxHand(Number(event.target.value))}
                />
                <small>
                  {maxHand * 2 - 1} rounds · 1 → {maxHand} → 1
                </small>
              </label>

              <button
                type="button"
                className={styles.primaryButton}
                disabled={busy}
                onClick={createTable}
              >
                {busy ? "Opening table…" : "Create share code"}
                <span>→</span>
              </button>
            </section>

            <section className={joinClasses(styles.entryPanel, styles.joinPanel)}>
              <span className={styles.panelNumber}>02</span>
              <h2>Join a table</h2>
              <p>Enter the code the host sent you.</p>

              <label className={styles.field}>
                <span>Your name</span>
                <input
                  value={name}
                  maxLength={18}
                  autoComplete="nickname"
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Enter your name"
                />
              </label>

              <label className={styles.field}>
                <span>Table code</span>
                <input
                  className={styles.codeInput}
                  value={roomCode}
                  maxLength={6}
                  autoCapitalize="characters"
                  autoComplete="off"
                  onChange={(event) =>
                    setRoomCode(
                      event.target.value
                        .toUpperCase()
                        .replace(/[^A-Z0-9]/g, ""),
                    )
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void joinTable();
                  }}
                  placeholder="ABC234"
                />
              </label>

              <button
                type="button"
                className={styles.secondaryButton}
                disabled={busy}
                onClick={joinTable}
              >
                {busy ? "Taking your seat…" : "Join table"}
              </button>

              <div className={styles.joinNote}>
                <span>♛</span>
                Your reconnect key stays on this device. It is never included
                in the link you share.
              </div>
            </section>
          </div>
        </section>

        {message && (
          <div className={styles.errorToast} role="alert">
            {message}
          </div>
        )}
      </main>
    );
  }

  const me = room.players.find((player) => player.id === room.myPlayerId)!;
  const currentPlayer = room.players[room.currentPlayerIndex];
  const isMyTurn = currentPlayer?.id === room.myPlayerId;
  const leadColor = getLeadColor(room.trick);
  const legalIds = new Set(
    room.phase === "playing" && isMyTurn && room.trumpCard
      ? getLegalCards(room.myHand, {
          leadColor,
          trumpColor: room.trumpCard.color,
          trumpBroken: room.trumpBroken,
        }).map((card) => card.id)
      : [],
  );
  const visibleTrick =
    room.trick.length > 0 ? room.trick : room.lastTrick;
  const showingLastTrick =
    room.trick.length === 0 && room.lastTrick.length > 0;
  const highScore =
    room.phase === "game-over"
      ? Math.max(...room.players.map((player) => player.score))
      : null;
  const winners =
    highScore === null
      ? []
      : room.players.filter((player) => player.score === highScore);

  return (
    <main className={styles.gamePage}>
      <div className={styles.liveRegion} aria-live="polite">
        {message ||
          (currentPlayer
            ? `${currentPlayer.name}'s turn`
            : "Waiting at the table")}
      </div>

      <header className={styles.gameHeader}>
        <Link href="/" className={styles.brand}>
          <span className={styles.brandMark}>
            <i />
            <b>2</b>
          </span>
          <span>
            <strong>High Trump</strong>
            <small>Table {room.code}</small>
          </span>
        </Link>

        <button
          type="button"
          className={styles.codePill}
          onClick={copyInvitation}
          title="Copy invitation link"
        >
          <small>Share code</small>
          <strong>{room.code}</strong>
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>

        <div className={styles.headerActions}>
          <span
            className={joinClasses(
              styles.connection,
              connection === "offline" && styles.connectionOffline,
            )}
          >
            <i />
            {connection === "connected"
              ? "Live"
              : connection === "syncing"
                ? "Syncing"
                : "Reconnecting"}
          </span>
          <button type="button" onClick={leaveTable}>
            Exit table
          </button>
        </div>
      </header>

      {room.phase === "lobby" ? (
        <section className={styles.lobby}>
          <div className={styles.lobbyIntro}>
            <span className={styles.eyebrow}>The table is open</span>
            <h1>Invite the rest of the table.</h1>
            <p>
              Send the code or invitation link. Each player joins from their
              own device and sees only their own hand.
            </p>

            <div className={styles.shareCard}>
              <span>Table code</span>
              <strong>{room.code}</strong>
              <button type="button" onClick={copyInvitation}>
                {copied ? "Invitation copied" : "Copy invitation link"}
              </button>
            </div>
          </div>

          <div className={styles.lobbyTable}>
            <header>
              <div>
                <span>Players seated</span>
                <strong>
                  {room.players.length} / {room.playerCount}
                </strong>
              </div>
              <small>
                {room.maxHand * 2 - 1} rounds · up to {room.maxHand} cards
              </small>
            </header>

            <div className={styles.seatGrid}>
              {Array.from({ length: room.playerCount }, (_, seat) => {
                const player = room.players.find(
                  (candidate) => candidate.seat === seat,
                );
                return player ? (
                  <article
                    className={joinClasses(
                      styles.seat,
                      player.id === room.myPlayerId && styles.mySeat,
                    )}
                    key={player.id}
                  >
                    <span>{player.name.slice(0, 1).toUpperCase()}</span>
                    <div>
                      <strong>
                        {player.name}
                        {player.id === room.myPlayerId ? " · You" : ""}
                      </strong>
                      <small>
                        {player.id ===
                        room.players.find((entry) => entry.seat === 0)?.id
                          ? "Host"
                          : `Seat ${seat + 1}`}
                      </small>
                    </div>
                    <b>Ready</b>
                  </article>
                ) : (
                  <EmptySeat number={seat + 1} key={seat} />
                );
              })}
            </div>

            {room.isHost ? (
              <button
                type="button"
                className={styles.primaryButton}
                disabled={busy || room.players.length !== room.playerCount}
                onClick={() => void sendAction({ type: "start" })}
              >
                {room.players.length === room.playerCount
                  ? "Deal the first round"
                  : `Waiting for ${
                      room.playerCount - room.players.length
                    } more`}
                <span>→</span>
              </button>
            ) : (
              <div className={styles.waitingHost}>
                <i />
                Waiting for the host to deal
              </div>
            )}
          </div>
        </section>
      ) : (
        <div className={styles.gameGrid}>
          <section className={styles.tableColumn}>
            <div className={styles.roundBar}>
              <span>
                Round <b>{room.roundIndex + 1}</b> / {room.schedule.length}
              </span>
              <i />
              <span>
                <b>{room.handSize}</b> card
                {room.handSize === 1 ? "" : "s"}
              </span>
              {room.trumpCard && (
                <>
                  <i />
                  <SuitChip color={room.trumpCard.color} />
                  <span
                    className={joinClasses(
                      styles.trumpState,
                      room.trumpBroken && styles.trumpBroken,
                    )}
                  >
                    {room.trumpBroken ? "Broken" : "Locked"}
                  </span>
                </>
              )}
            </div>

            <div className={styles.opponents}>
              {room.players
                .filter((player) => player.id !== room.myPlayerId)
                .map((player) => (
                  <article
                    key={player.id}
                    className={joinClasses(
                      styles.opponent,
                      player.seat === room.currentPlayerIndex &&
                        styles.opponentActive,
                    )}
                  >
                    <span>{player.name.slice(0, 1).toUpperCase()}</span>
                    <div>
                      <strong>{player.name}</strong>
                      <small>
                        Bid {displayBid(player.bid)} · {player.tricks} won
                      </small>
                    </div>
                    <b>
                      {player.handCount}
                      <small>cards</small>
                    </b>
                  </article>
                ))}
            </div>

            <div className={styles.felt}>
              <div className={styles.feltPattern} />
              {room.trumpCard && (
                <aside className={styles.trumpCard}>
                  <span>Trump</span>
                  <CardFace card={room.trumpCard} compact />
                </aside>
              )}

              <section className={styles.trickArea}>
                {visibleTrick.length > 0 ? (
                  <>
                    <span className={styles.trickLabel}>
                      {showingLastTrick
                        ? `${room.players[room.lastWinner?.playerIndex ?? 0]?.name} won`
                        : leadColor
                          ? `${COLOR_META[leadColor].label} led`
                          : "Current trick"}
                    </span>
                    <div className={styles.playedCards}>
                      {visibleTrick.map((play) => (
                        <div key={`${play.playerIndex}-${play.card.id}`}>
                          <small>{room.players[play.playerIndex]?.name}</small>
                          <CardFace card={play.card} compact />
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className={styles.emptyTrick}>
                    <span>◇</span>
                    <strong>
                      {isMyTurn ? "Your lead" : `${currentPlayer?.name} leads`}
                    </strong>
                    <small>
                      {!room.trumpBroken && room.trumpCard
                        ? `${COLOR_META[room.trumpCard.color].label} trump is locked`
                        : "Trump is broken — any legal color may lead"}
                    </small>
                  </div>
                )}
              </section>

              {room.phase === "bidding" && (
                <section className={styles.bidConsole}>
                  <span className={styles.phaseChip}>Bidding</span>
                  <h2>
                    {isMyTurn
                      ? "How many tricks will you take?"
                      : `${currentPlayer?.name} is choosing a bid`}
                  </h2>
                  <p>Every earlier bid stays visible. The high bid leads.</p>
                  {isMyTurn ? (
                    <div className={styles.bidControls}>
                      <div>
                        {Array.from(
                          { length: room.handSize + 1 },
                          (_, bid) => (
                            <button
                              type="button"
                              key={bid}
                              disabled={busy}
                              onClick={() =>
                                void sendAction({ type: "bid", bid })
                              }
                            >
                              {bid}
                            </button>
                          ),
                        )}
                      </div>
                      <button
                        type="button"
                        className={styles.boardButton}
                        disabled={busy}
                        onClick={() =>
                          void sendAction({ type: "bid", bid: "BOARD" })
                        }
                      >
                        <b>♛</b>
                        <span>
                          Call Board
                          <small>Every trick · ±20</small>
                        </span>
                      </button>
                    </div>
                  ) : (
                    <div className={styles.waitingTurn}>
                      <i />
                      Your hand is ready. Waiting for your turn.
                    </div>
                  )}

                  <div className={styles.bidOrder}>
                    {rotateOrder(
                      room.players.length,
                      room.firstBidderIndex,
                    ).map((seat, orderIndex) => {
                      const player = room.players[seat];
                      const entry = room.bidLog.find(
                        (bid) => bid.playerIndex === seat,
                      );
                      return (
                        <span
                          key={player.id}
                          className={
                            seat === room.currentPlayerIndex
                              ? styles.currentBidder
                              : ""
                          }
                        >
                          <i>{orderIndex + 1}</i>
                          {player.name}
                          <b>{entry ? displayBid(entry.bid) : "…"}</b>
                        </span>
                      );
                    })}
                  </div>
                </section>
              )}

              {room.phase === "playing" && (
                <div
                  className={joinClasses(
                    styles.turnBanner,
                    isMyTurn && styles.myTurnBanner,
                  )}
                >
                  <i />
                  <strong>
                    {isMyTurn ? "Your turn" : `${currentPlayer?.name}'s turn`}
                  </strong>
                  <small>
                    {leadColor
                      ? `Follow ${COLOR_META[leadColor].label} if you can`
                      : !room.trumpBroken && room.trumpCard
                        ? `${COLOR_META[room.trumpCard.color].label} trump is locked`
                        : "Lead any legal card"}
                  </small>
                </div>
              )}

              {room.phase === "round-result" && (
                <section className={styles.resultPanel}>
                  <span className={styles.phaseChip}>Round complete</span>
                  <h2>Promises kept—and broken.</h2>
                  <div className={styles.resultRows}>
                    {room.roundResults.map((result) => (
                      <div key={result.playerIndex}>
                        <strong>{result.name}</strong>
                        <span>
                          Bid {displayBid(result.bid)} · {result.tricks} won
                        </span>
                        <b className={result.delta >= 0 ? styles.positive : ""}>
                          {result.delta >= 0 ? "+" : ""}
                          {result.delta}
                        </b>
                      </div>
                    ))}
                  </div>
                  {room.isHost ? (
                    <button
                      type="button"
                      className={styles.primaryButton}
                      disabled={busy}
                      onClick={() =>
                        void sendAction({ type: "next-round" })
                      }
                    >
                      {room.roundIndex >= room.schedule.length - 1
                        ? "Show final standings"
                        : "Deal the next round"}
                      <span>→</span>
                    </button>
                  ) : (
                    <div className={styles.waitingHost}>
                      <i />
                      Waiting for the host
                    </div>
                  )}
                </section>
              )}

              {room.phase === "game-over" && (
                <section className={styles.resultPanel}>
                  <span className={styles.phaseChip}>Final standings</span>
                  <h2>
                    {winners.length === 1
                      ? `${winners[0].name} wins the table.`
                      : `${winners.map((winner) => winner.name).join(" & ")} tie.`}
                  </h2>
                  <p className={styles.finalScore}>
                    {highScore} point{highScore === 1 ? "" : "s"}
                  </p>
                  {room.isHost ? (
                    <button
                      type="button"
                      className={styles.primaryButton}
                      disabled={busy}
                      onClick={() => void sendAction({ type: "rematch" })}
                    >
                      Deal a rematch
                      <span>↻</span>
                    </button>
                  ) : (
                    <div className={styles.waitingHost}>
                      <i />
                      Waiting to see if the host calls a rematch
                    </div>
                  )}
                </section>
              )}
            </div>

            <section className={styles.myHand}>
              <header>
                <div>
                  <span className={styles.avatar}>
                    {me.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span>
                    <strong>{me.name} · You</strong>
                    <small>
                      {me.score} pts · Bid {displayBid(me.bid)} · {me.tricks} won
                    </small>
                  </span>
                </div>
                <p>
                  {room.phase === "playing" && isMyTurn
                    ? leadColor &&
                      !room.myHand.some((card) => card.color === leadColor)
                      ? `Void in ${COLOR_META[leadColor].label} — play any legal card`
                      : leadColor
                        ? `You must follow ${COLOR_META[leadColor].label}`
                        : "Choose a card to lead"
                    : room.phase === "bidding"
                      ? isMyTurn
                        ? "Your bid is up"
                        : `Waiting for ${currentPlayer?.name}`
                      : room.phase === "playing"
                        ? `Waiting for ${currentPlayer?.name}`
                        : "Round cards have been played"}
                </p>
              </header>
              <div className={styles.handScroller}>
                {room.myHand.map((card) => {
                  const playable =
                    room.phase === "playing" &&
                    isMyTurn &&
                    legalIds.has(card.id);
                  return (
                    <CardFace
                      key={card.id}
                      card={card}
                      disabled={!playable}
                      onPlay={
                        playable
                          ? () =>
                              void sendAction({
                                type: "play",
                                cardId: card.id,
                              })
                          : undefined
                      }
                    />
                  );
                })}
                {room.myHand.length === 0 && (
                  <div className={styles.emptyHand}>
                    All cards played for this round
                  </div>
                )}
              </div>
            </section>
          </section>

          <aside className={styles.scoreboard}>
            <header>
              <span>Table standings</span>
              <strong>{room.code}</strong>
            </header>
            <div>
              {[...room.players]
                .sort(
                  (left, right) =>
                    right.score - left.score || left.seat - right.seat,
                )
                .map((player, index) => (
                  <article
                    key={player.id}
                    className={
                      player.id === room.myPlayerId ? styles.scoreMe : ""
                    }
                  >
                    <i>{index + 1}</i>
                    <span>
                      <strong>{player.name}</strong>
                      <small>
                        {player.seat === room.dealerIndex
                          ? "Dealer"
                          : player.seat === room.currentPlayerIndex
                            ? "On turn"
                            : `Seat ${player.seat + 1}`}
                      </small>
                    </span>
                    <b>{player.score}</b>
                  </article>
                ))}
            </div>
            <footer>
              <span>Round path</span>
              <div>
                {room.schedule.map((size, index) => (
                  <i
                    key={`${size}-${index}`}
                    className={
                      index === room.roundIndex ? styles.currentRound : ""
                    }
                  >
                    {size}
                  </i>
                ))}
              </div>
            </footer>
          </aside>
        </div>
      )}

      {message && (
        <div className={styles.errorToast} role="alert">
          {message}
        </div>
      )}
    </main>
  );
}
