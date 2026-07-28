import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const gameRooms = sqliteTable(
  "game_rooms",
  {
    code: text("code").primaryKey(),
    state: text("state").notNull(),
    revision: integer("revision").notNull().default(1),
    creatorHash: text("creator_hash"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("game_rooms_expires_at_idx").on(table.expiresAt),
    index("game_rooms_creator_window_idx").on(
      table.creatorHash,
      table.createdAt,
    ),
  ],
);
