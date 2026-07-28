import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders multiplayer as the High Trump home screen", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(
    html,
    /<title>High Trump — A Rook-style trick-taking game<\/title>/i,
  );
  assert.match(html, /Live multiplayer/);
  assert.match(html, /Create a table/);
  assert.match(html, /Create share code/);
  assert.match(html, /Join a table/);
  assert.match(html, /Join with code/);
  assert.match(html, /six-character code/i);
  assert.match(html, /Play solo/);
  assert.match(html, /href="\/solo"/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("server-renders solo play on its dedicated route", async () => {
  const response = await render("/solo");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Every bid is a promise/);
  assert.match(html, /Set the stakes/);
  assert.match(html, /Play solo/);
  assert.match(html, /Play online with a share code/);
  assert.match(html, /Yellow 2/);
  assert.match(html, /href="\/"/);
});

test("keeps the previous multiplayer route working", async () => {
  const response = await render("/online");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Live multiplayer/);
  assert.match(html, /Create a table/);
  assert.match(html, /Create share code/);
  assert.match(html, /Join a table/);
  assert.match(html, /six-character code/i);
});

test("removes starter-only UI and keeps core accessibility contracts", async () => {
  const [page, soloPage, css, onlineCss, layout, packageJson] =
    await Promise.all([
      readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/solo/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
      readFile(
        new URL("../app/online/online.module.css", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
    ]);

  assert.match(page, /^"use client";/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /getLegalCards/);
  assert.match(page, /window\.scrollTo/);
  assert.match(page, /mobileActionDock/);
  assert.match(page, /data-testid="game-table"/);
  assert.match(page, /data-testid="trump-card"/);
  assert.match(page, /data-testid="bid-console"/);
  assert.match(page, /mobileBidTrump/);
  assert.match(soloPage, /^"use client";/);
  assert.match(soloPage, /aria-modal="true"/);
  assert.match(soloPage, /getTrickWinner/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /@media \(max-width: 480px\)/);
  assert.match(onlineCss, /safe-area-inset-bottom/);
  assert.match(onlineCss, /\.phasePlaying \.myHand/);
  assert.match(
    onlineCss,
    /\.mobileActionDock \.bidControls > div[\s\S]*?flex-wrap:\s*nowrap/,
  );
  assert.doesNotMatch(onlineCss, /max-height:\s*52dvh/);
  assert.match(onlineCss, /min-height:\s*44px/);
  assert.match(layout, /High Trump — A Rook-style trick-taking game/);
  assert.doesNotMatch(
    `${page}\n${soloPage}\n${layout}\n${packageJson}`,
    /SkeletonPreview|react-loading-skeleton|codex-preview/,
  );

  await assert.rejects(
    access(new URL("../app/_sites-preview", templateRoot)),
  );
});
