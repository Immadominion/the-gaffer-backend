/**
 * The Engine — the application service. It owns the write side: player commands
 * route to actors; match lifecycle (open → lock → resolve) and the settlement
 * saga run here. The API talks to the Engine for commands and to the ReadModel
 * for queries. Match streams have a single writer (this Engine), player streams a
 * single writer each (their actor), so ordering is guaranteed everywhere.
 */

import type { GameConfig } from "../config.ts";
import type { DomainEvent } from "../domain/events.ts";
import { formatWal, type Frost, type MarketId, type MatchId, type Wallet, matchStream } from "../domain/ids.ts";
import { VOID, type Fixture, type MarketDef, type Outcome, type VerdictTrigger } from "../domain/model.ts";
import { RESULT_MARKET, resolveResult, resultMarket } from "../game/markets.ts";
import { settleParimutuel } from "../game/parimutuel.ts";
import type { Gaffer } from "../gaffer/Gaffer.ts";
import { ActorRegistry } from "../core/actor/ActorRegistry.ts";
import type { EventStore } from "../core/eventstore/EventStore.ts";
import type { ReadModel } from "../core/projections/ReadModel.ts";
import type { Custody } from "../ports/Custody.ts";
import type { MatchDataProvider } from "../ports/MatchData.ts";
import type { MakeCallInput } from "../core/actor/PlayerActor.ts";

export interface EngineDeps {
  store: EventStore;
  readModel: ReadModel;
  custody: Custody;
  gaffer: Gaffer;
  matchData: MatchDataProvider;
  config: GameConfig;
}

export class Engine {
  readonly registry: ActorRegistry;
  private readonly matchVersions = new Map<MatchId, number>();

  constructor(private readonly deps: EngineDeps) {
    this.registry = new ActorRegistry({
      store: deps.store,
      readModel: deps.readModel,
      custody: deps.custody,
      gaffer: deps.gaffer,
      config: deps.config,
    });
  }

  get readModel(): ReadModel {
    return this.deps.readModel;
  }
  get custody(): Custody {
    return this.deps.custody;
  }

  // ── player commands ─────────────────────────────────────────────────────────

  signContract(wallet: Wallet, handle?: string) {
    return this.registry.for(wallet).signContract(handle);
  }
  deposit(wallet: Wallet, amount: Frost, proof?: string) {
    return this.registry.for(wallet).deposit(amount, proof);
  }
  withdraw(wallet: Wallet, amount: Frost) {
    return this.registry.for(wallet).withdraw(amount);
  }
  claimWelcomeGrant(wallet: Wallet) {
    return this.registry.for(wallet).claimWelcomeGrant(this.deps.config.welcomeGrant);
  }
  makeCall(wallet: Wallet, input: MakeCallInput) {
    return this.registry.for(wallet).makeCall(input);
  }
  declareHotTake(wallet: Wallet, text: string) {
    return this.registry.for(wallet).declareHotTake(text);
  }
  requestVerdict(wallet: Wallet, trigger: VerdictTrigger) {
    return this.registry.for(wallet).requestVerdict(trigger);
  }

  chat(wallet: Wallet, message: string) {
    return this.deps.gaffer.chat({ wallet, message });
  }

  /** Re-read a player's memory, distil behavioural traits, and persist them. */
  async refreshTraits(wallet: Wallet) {
    const traits = await this.deps.gaffer.distillTraits(wallet);
    for (const t of traits) await this.registry.for(wallet).observeTrait(t);
    return traits;
  }

  /** The pre-bet coaching read — built from live pot context + the player's memory. */
  async preBetRead(
    wallet: Wallet,
    input: { matchId: MatchId; marketId: MarketId; bucket: string; stake: Frost },
  ): Promise<string> {
    const match = this.deps.readModel.pots.getMatch(input.matchId);
    if (!match) throw new Error("no such match");
    const market = match.markets.find((m) => m.marketId === input.marketId);
    const bucket = market?.buckets.find((b) => b.bucket === input.bucket);
    return this.deps.gaffer.preBetRead({
      wallet,
      fixture: match.fixture,
      marketLabel: market?.label ?? "the call",
      bucketLabel: bucket?.label ?? input.bucket,
      stakeWal: formatWal(input.stake),
      impliedProb: this.deps.readModel.pots.impliedProbFor(input.matchId, input.marketId, input.bucket),
    });
  }

  // ── match lifecycle ──────────────────────────────────────────────────────────

  async openMatch(fixture: Fixture, extraMarkets: MarketDef[] = []): Promise<void> {
    if (this.deps.readModel.pots.getMatch(fixture.matchId)) return; // idempotent
    await this.matchAppend(fixture.matchId, [
      { type: "MatchOpened", fixture, markets: [resultMarket(), ...extraMarkets] },
    ]);
  }

  async lockMatch(matchId: MatchId): Promise<void> {
    const m = this.deps.readModel.pots.getMatch(matchId);
    if (!m || m.status !== "OPEN") return;
    await this.matchAppend(matchId, [{ type: "MatchLocked", matchId }]);
  }

  async resolveMatch(
    matchId: MatchId,
    score: { home: number; away: number },
    source = "mock",
  ): Promise<void> {
    const m = this.deps.readModel.pots.getMatch(matchId);
    if (!m || m.status === "RESOLVED") return;
    if (m.status === "OPEN") await this.lockMatch(matchId);

    const outcomes: Record<string, Outcome> = {};
    for (const mk of m.markets) {
      outcomes[mk.marketId] = mk.marketId === RESULT_MARKET ? resolveResult(score) : VOID;
    }
    await this.matchAppend(matchId, [{ type: "MatchResolved", matchId, score, outcomes, source }]);

    await Promise.all(
      m.markets.map((mk) => this.settleMarket(matchId, mk.marketId, outcomes[mk.marketId] ?? VOID)),
    );
  }

  private async settleMarket(matchId: MatchId, marketId: MarketId, outcome: Outcome): Promise<void> {
    const calls = this.deps.readModel.pots.getMarketCalls(matchId, marketId);
    const grossPot = calls.reduce((s, c) => s + c.stake, 0n);

    if (outcome === VOID) {
      await Promise.all(calls.map((c) => this.registry.for(c.wallet).voidCall(c.callId, "market voided")));
      await this.matchAppend(matchId, [
        {
          type: "PotSettled",
          matchId,
          marketId,
          winningBucket: VOID,
          grossPot,
          rake: 0n,
          winnersStake: 0n,
          settledCount: calls.length,
        },
      ]);
      return;
    }

    const result = settleParimutuel({
      calls,
      winningBucket: outcome,
      rakeBps: this.deps.config.rakeBps,
      minParticipants: this.deps.config.minParticipants,
    });

    if (result.kind === "VOID") {
      await Promise.all(calls.map((c) => this.registry.for(c.wallet).voidCall(c.callId, result.reason)));
      await this.matchAppend(matchId, [
        {
          type: "PotSettled",
          matchId,
          marketId,
          winningBucket: outcome,
          grossPot,
          rake: 0n,
          winnersStake: 0n,
          settledCount: calls.length,
        },
      ]);
      return;
    }

    await Promise.all(
      result.payouts.map((p) => this.registry.for(p.wallet).settleCall(p.callId, p.won, p.payout)),
    );
    await this.matchAppend(matchId, [
      {
        type: "PotSettled",
        matchId,
        marketId,
        winningBucket: outcome,
        grossPot: result.grossPot,
        rake: result.rake,
        winnersStake: result.winnersStake,
        settledCount: result.payouts.length,
      },
    ]);
  }

  // ── ingestion ────────────────────────────────────────────────────────────────

  async syncFixtures(): Promise<void> {
    for (const fixture of await this.deps.matchData.fixtures()) {
      await this.openMatch(fixture);
    }
  }

  /** Lock kicked-off matches; resolve finished ones. Safe to call on a timer. */
  async tick(now: number = Date.now()): Promise<void> {
    const matches = this.deps.readModel.pots.allMatches();
    for (const m of matches) {
      if (m.status === "OPEN" && m.fixture.kickoff <= now) await this.lockMatch(m.fixture.matchId);
    }
    const pending = this.deps.readModel.pots
      .allMatches()
      .filter((m) => m.status !== "RESOLVED")
      .map((m) => m.fixture.matchId);
    for (const r of await this.deps.matchData.results(pending)) {
      if (r.finished) await this.resolveMatch(r.matchId, r.score, "matchdata");
    }
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private async matchAppend(matchId: MatchId, events: DomainEvent[]): Promise<void> {
    const streamId = matchStream(matchId);
    let version = this.matchVersions.get(matchId);
    if (version === undefined) {
      version = (await this.deps.store.readStream(streamId)).length;
    }
    const stored = await this.deps.store.append(streamId, events, { expectedVersion: version });
    this.matchVersions.set(matchId, version + stored.length);
  }
}
