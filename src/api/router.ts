/**
 * The API surface — typed RPC, not REST. Commands are mutations, reads are
 * queries, and the live views (a match's Pot, your Dossier, your settlement feed)
 * are subscriptions pushed over WebSocket. The exported AppRouter type is the
 * contract the frontend imports — no codegen, no drift.
 */

import { z } from "zod";
import type { StoredEvent } from "../domain/events.ts";
import {
  asMarketId,
  asMatchId,
  asWallet,
  playerStream,
  type MatchId,
} from "../domain/ids.ts";
import type { DossierView } from "../core/projections/DossierProjection.ts";
import { DomainError } from "../domain/errors.ts";
import { streamEvents } from "./eventStream.ts";
import { authedProcedure, guard, publicProcedure, router } from "./trpc.ts";

const TRIGGER = z.enum(["BIG_RESULT", "PROMOTION", "DEMOTION", "ON_DEMAND", "SEASON_REVIEW"]);
const amount = z.bigint().positive();

const matchIdOf = (e: StoredEvent): string | undefined => {
  const p = e.payload;
  if (p.type === "MatchOpened") return p.fixture.matchId;
  if ("matchId" in p) return p.matchId;
  return undefined;
};

/** Public Dossier: the memory in action, minus the private money columns. */
function toPublic(d: DossierView) {
  const { balance: _b, locked: _l, bonus: _bonus, openCalls: _o, ...rest } = d;
  return rest;
}

export const appRouter = router({
  // ── health / meta ────────────────────────────────────────────────────────
  health: publicProcedure.query(({ ctx }) => ({
    ok: true,
    wiring: ctx.app.wiring,
    sessionsWallet: ctx.app.engine.custody.sessionsAddress(),
    managersPot: ctx.app.readModel.managersPotTotal(),
    houseRevenue: ctx.app.readModel.houseRevenueTotal(),
    ledgerOnWalrus: ctx.app.ledgerMirror.count, // money events mirrored to Walrus this run
  })),

  // ── reads ──────────────────────────────────────────────────────────────────
  matchday: publicProcedure.query(({ ctx }) => ctx.app.readModel.pots.allMatches()),

  match: publicProcedure
    .input(z.object({ matchId: z.string() }))
    .query(({ ctx, input }) => ctx.app.readModel.pots.getMatch(asMatchId(input.matchId)) ?? null),

  leaderboard: publicProcedure
    .input(z.object({ by: z.enum(["gr", "pnl"]).default("gr"), limit: z.number().min(1).max(200).default(50) }))
    .query(({ ctx, input }) =>
      input.by === "pnl"
        ? ctx.app.readModel.leaderboardByPnl(input.limit)
        : ctx.app.readModel.leaderboardByGr(input.limit),
    ),

  managersPot: publicProcedure.query(({ ctx }) => ctx.app.readModel.managersPotTotal()),

  dossier: publicProcedure
    .input(z.object({ wallet: z.string() }))
    .query(({ ctx, input }) => {
      const d = ctx.app.readModel.getDossier(asWallet(input.wallet));
      return d ? toPublic(d) : null;
    }),

  me: authedProcedure.query(({ ctx }) => ctx.app.readModel.getDossier(ctx.wallet) ?? null),

  settledCalls: authedProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(50) }).optional())
    .query(({ ctx, input }) => ctx.app.readModel.settledCalls(ctx.wallet, input?.limit ?? 50)),

  chatHistory: authedProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(50) }).optional())
    .query(({ ctx, input }) => ctx.app.readModel.chatHistory(ctx.wallet, input?.limit ?? 50)),

  touchline: authedProcedure.query(({ ctx }) => {
    const dossier = ctx.app.readModel.getDossier(ctx.wallet) ?? null;
    return {
      dossier,
      openFixtures: ctx.app.readModel.pots.openFixtures(),
      openCalls: dossier?.openCalls ?? [],
      managersPot: ctx.app.readModel.managersPotTotal(),
      leaderboardTop: ctx.app.readModel.leaderboardByGr(5),
    };
  }),

  preBetRead: authedProcedure
    .input(z.object({ matchId: z.string(), marketId: z.string(), bucket: z.string(), stake: z.bigint() }))
    .query(({ ctx, input }) =>
      guard(() =>
        ctx.app.engine.preBetRead(ctx.wallet, {
          matchId: asMatchId(input.matchId),
          marketId: asMarketId(input.marketId),
          bucket: input.bucket,
          stake: input.stake,
        }),
      ),
    ),

  // ── commands ─────────────────────────────────────────────────────────────
  signContract: authedProcedure
    .input(z.object({ handle: z.string().max(40).optional() }))
    .mutation(({ ctx, input }) =>
      guard(() => ctx.app.engine.signContract(ctx.wallet, input.handle)),
    ),

  deposit: authedProcedure
    .input(z.object({ amount, proof: z.string().optional() }))
    .mutation(({ ctx, input }) => guard(() => ctx.app.engine.deposit(ctx.wallet, input.amount, input.proof))),

  claimWelcomeGrant: authedProcedure.mutation(({ ctx }) =>
    guard(() => ctx.app.engine.claimWelcomeGrant(ctx.wallet)),
  ),

  withdraw: authedProcedure
    .input(z.object({ amount }))
    .mutation(({ ctx, input }) => guard(() => ctx.app.engine.withdraw(ctx.wallet, input.amount))),

  makeCall: authedProcedure
    .input(
      z.object({
        matchId: z.string(),
        marketId: z.string().default("RESULT"),
        bucket: z.string(),
        stake: amount,
        note: z.string().max(280).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      guard(() =>
        ctx.app.engine.makeCall(ctx.wallet, {
          matchId: asMatchId(input.matchId),
          marketId: asMarketId(input.marketId),
          bucket: input.bucket,
          stake: input.stake,
          ...(input.note ? { note: input.note } : {}),
        }),
      ),
    ),

  declareHotTake: authedProcedure
    .input(z.object({ text: z.string().min(1).max(280) }))
    .mutation(({ ctx, input }) => guard(() => ctx.app.engine.declareHotTake(ctx.wallet, input.text))),

  requestVerdict: authedProcedure
    .input(z.object({ trigger: TRIGGER.default("ON_DEMAND") }))
    .mutation(({ ctx, input }) => guard(() => ctx.app.engine.requestVerdict(ctx.wallet, input.trigger))),

  chat: authedProcedure
    .input(z.object({ message: z.string().min(1).max(500) }))
    .mutation(({ ctx, input }) => guard(() => ctx.app.engine.chat(ctx.wallet, input.message))),

  // ── demo / ops ─────────────────────────────────────────────────────────────
  // Resolve a match on command so settlement can be shown live without waiting
  // for the real final whistle. Gated by DEMO_ADMIN_KEY; disabled if it's unset.
  resolveMatchNow: publicProcedure
    .input(
      z.object({
        matchId: z.string(),
        home: z.number().int().min(0).max(99),
        away: z.number().int().min(0).max(99),
        key: z.string(),
      }),
    )
    .mutation(({ ctx, input }) =>
      guard(async () => {
        const expected = ctx.app.config.demoAdminKey;
        if (!expected || input.key !== expected) {
          throw new DomainError("INVALID", "not authorized to resolve matches");
        }
        const mid = asMatchId(input.matchId);
        // Seed a counterparty first (no-op if already seeded or locked), so even a
        // solo bet placed before house liquidity existed settles for real, not void.
        await ctx.app.engine.house.ensureSeeded(mid);
        await ctx.app.engine.resolveMatch(mid, { home: input.home, away: input.away }, "demo");
        return { ok: true, matchId: input.matchId, score: { home: input.home, away: input.away } };
      }),
    ),

  // ── live subscriptions (pushed over WS) ────────────────────────────────────
  onMatch: publicProcedure
    .input(z.object({ matchId: z.string() }))
    .subscription(async function* ({ ctx, input, signal }) {
      const id = asMatchId(input.matchId);
      yield ctx.app.readModel.pots.getMatch(id) ?? null;
      for await (const e of streamEvents(ctx.app.store, signal, (ev) => matchIdOf(ev) === id)) {
        void e;
        yield ctx.app.readModel.pots.getMatch(id) ?? null;
      }
    }),

  onDossier: authedProcedure.subscription(async function* ({ ctx, signal }) {
    const stream = playerStream(ctx.wallet);
    yield ctx.app.readModel.getDossier(ctx.wallet) ?? null;
    for await (const e of streamEvents(ctx.app.store, signal, (ev) => ev.meta.streamId === stream)) {
      void e;
      yield ctx.app.readModel.getDossier(ctx.wallet) ?? null;
    }
  }),

  onFeed: authedProcedure.subscription(async function* ({ ctx, signal }) {
    const stream = playerStream(ctx.wallet);
    const watched = new Set(["CallSettled", "CallVoided", "TierChanged", "VerdictIssued"]);
    for await (const e of streamEvents(
      ctx.app.store,
      signal,
      (ev) => ev.meta.streamId === stream && watched.has(ev.payload.type),
    )) {
      yield { type: e.payload.type, at: e.meta.at, payload: e.payload };
    }
  }),
});

export type AppRouter = typeof appRouter;
