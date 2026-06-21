/**
 * End-to-end through the real tRPC router (createCaller) — exercises the auth
 * context, command mutations, the domain→tRPC error mapping, and the query side,
 * all against an in-memory app (no keys, no network).
 */

import { describe, expect, test } from "bun:test";
import { appRouter } from "../src/api/router.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { asWallet, wal, type MatchId } from "../src/domain/ids.ts";

const FIXED_NOW = 1_750_000_000_000;

async function freshApp() {
  // Empty env → in-memory store/memory, scripted Gaffer, dev auth, mock fixtures.
  const app = await createApp({ config: loadConfig({}), now: FIXED_NOW });
  await app.engine.syncFixtures();
  return app;
}

describe("tRPC API", () => {
  test("full loop through the router: sign → deposit → call → settle → read", async () => {
    const app = await freshApp();
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;

    const alice = appRouter.createCaller({ app, wallet: asWallet("0xalice") });
    const bob = appRouter.createCaller({ app, wallet: asWallet("0xbob") });
    const cara = appRouter.createCaller({ app, wallet: asWallet("0xcara") });

    for (const [caller, name] of [
      [alice, "Alice"],
      [bob, "Bob"],
      [cara, "Cara"],
    ] as const) {
      await caller.signContract({ handle: name });
      await caller.deposit({ amount: wal(100) });
    }

    await alice.makeCall({ matchId, bucket: "HOME", stake: wal(10) });
    await cara.makeCall({ matchId, bucket: "HOME", stake: wal(30) });
    await bob.makeCall({ matchId, bucket: "AWAY", stake: wal(40) });

    // Resolve is a system op (ingestion), not a player command.
    await app.engine.resolveMatch(matchId, { home: 2, away: 0 });
    await app.memoryWriter.drain();

    const me = await alice.me();
    expect(me?.record.won).toBe(1);
    expect(me!.balance).toBeGreaterThan(wal(100)); // got the pot share back

    const ladder = await alice.leaderboard({ by: "gr" });
    expect(ladder.length).toBe(3);
    expect(ladder[0]!.rank).toBe(1);
  });

  test("authed procedures reject a logged-out caller", async () => {
    const app = await freshApp();
    const anon = appRouter.createCaller({ app }); // no wallet
    await expect(anon.me()).rejects.toThrow(/wallet/i);
    await expect(anon.makeCall({ matchId: "x", bucket: "HOME", stake: wal(1) })).rejects.toThrow();
  });

  test("public dossier omits the private money columns", async () => {
    const app = await freshApp();
    const alice = appRouter.createCaller({ app, wallet: asWallet("0xalice") });
    await alice.signContract({});
    const anon = appRouter.createCaller({ app });
    const pub = await anon.dossier({ wallet: "0xalice" });
    expect(pub).not.toBeNull();
    expect(pub as object).not.toHaveProperty("balance");
    expect(pub as object).not.toHaveProperty("openCalls");
  });

  test("domain errors map to tRPC codes (insufficient balance)", async () => {
    const app = await freshApp();
    const matchId = app.readModel.pots.openFixtures()[0]!.matchId as MatchId;
    const dave = appRouter.createCaller({ app, wallet: asWallet("0xdave") });
    await dave.signContract({});
    // no deposit → staking must fail
    await expect(dave.makeCall({ matchId, bucket: "HOME", stake: wal(10) })).rejects.toThrow();
  });
});
