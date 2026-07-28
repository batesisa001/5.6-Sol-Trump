CREATE TABLE `game_rooms` (
	`code` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`creator_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `game_rooms_expires_at_idx` ON `game_rooms` (`expires_at`);--> statement-breakpoint
CREATE INDEX `game_rooms_creator_window_idx` ON `game_rooms` (`creator_hash`,`created_at`);