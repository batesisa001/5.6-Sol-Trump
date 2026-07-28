import { getD1 } from "./index";

let initialization: Promise<void> | null = null;

export function ensureRoomSchema(): Promise<void> {
  if (initialization) return initialization;

  initialization = (async () => {
    const d1 = getD1();
    await d1
      .prepare(`
          CREATE TABLE IF NOT EXISTS game_rooms (
            code TEXT PRIMARY KEY NOT NULL,
            state TEXT NOT NULL,
            revision INTEGER DEFAULT 1 NOT NULL,
            creator_hash TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
          )
        `)
      .run();

    const columnInfo = await d1
      .prepare("PRAGMA table_info(game_rooms)")
      .all<{ name: string }>();
    if (
      !columnInfo.results.some((column) => column.name === "creator_hash")
    ) {
      await d1
        .prepare("ALTER TABLE game_rooms ADD COLUMN creator_hash TEXT")
        .run();
    }

    await d1.batch([
      d1.prepare(`
        CREATE INDEX IF NOT EXISTS game_rooms_expires_at_idx
        ON game_rooms (expires_at)
      `),
      d1.prepare(`
        CREATE INDEX IF NOT EXISTS game_rooms_creator_window_idx
        ON game_rooms (creator_hash, created_at)
      `),
    ]);
  })().catch((error) => {
    initialization = null;
    throw error;
  });

  return initialization;
}
