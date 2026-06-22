/**
 * Composition root. Assembles the system from config, choosing real vs in-memory
 * adapters at the edges while the core stays identical. With no env set it boots
 * fully self-contained (in-memory log, scripted Gaffer, play-money custody) so it
 * runs anywhere; set keys to light up Walrus, Claude, and real WAL one by one.
 */

import { loadConfig, type AppConfig } from "./config.ts";
import { InMemoryEventStore } from "./core/eventstore/InMemoryEventStore.ts";
import { SqliteEventStore } from "./core/eventstore/SqliteEventStore.ts";
import type { EventStore } from "./core/eventstore/EventStore.ts";
import { InMemoryMemoryStore } from "./core/memory/InMemoryMemoryStore.ts";
import { WalrusMemoryStore } from "./core/memory/WalrusMemoryStore.ts";
import { SdkMemWalClient } from "./core/memory/SdkMemWalClient.ts";
import type { MemoryStore } from "./core/memory/MemoryStore.ts";
import { ReadModel } from "./core/projections/ReadModel.ts";
import { Engine } from "./engine/Engine.ts";
import { MemoryWriter } from "./engine/MemoryWriter.ts";
import { WalrusLedgerMirror } from "./engine/WalrusLedgerMirror.ts";
import { ClaudeGaffer } from "./gaffer/ClaudeGaffer.ts";
import { ScriptedGaffer } from "./gaffer/ScriptedGaffer.ts";
import type { Gaffer } from "./gaffer/Gaffer.ts";
import { PlayLedgerCustody, SuiCustody, type Custody } from "./ports/Custody.ts";
import { PrivyCustody } from "./ports/PrivyCustody.ts";
import type { Auth } from "./auth/Auth.ts";
import { DevAuth } from "./auth/DevAuth.ts";
import { PrivyAuth } from "./auth/PrivyAuth.ts";
import { MockMatchData, type MatchDataProvider } from "./ports/MatchData.ts";
import { ApiFootballProvider } from "./ports/ApiFootballProvider.ts";
import { FootballDataProvider } from "./ports/FootballDataProvider.ts";
import { seedFixtures } from "./data/fixtures.ts";

export interface App {
  config: AppConfig;
  store: EventStore;
  readModel: ReadModel;
  engine: Engine;
  gaffer: Gaffer;
  auth: Auth;
  memory: MemoryStore;
  memoryWriter: MemoryWriter;
  ledgerMirror: WalrusLedgerMirror;
  matchData: MatchDataProvider;
  /** Description of which adapters are live — handy for /health and the demo. */
  wiring: Record<string, string>;
}

export interface CreateAppOptions {
  config?: AppConfig;
  store?: EventStore;
  memory?: MemoryStore;
  gaffer?: Gaffer;
  auth?: Auth;
  custody?: Custody;
  matchData?: MatchDataProvider;
  /** Seed the Mock provider's fixtures (ignored if matchData is supplied). */
  now?: number;
}

export async function createApp(opts: CreateAppOptions = {}): Promise<App> {
  const config = opts.config ?? loadConfig();
  const wiring: Record<string, string> = {};

  const store =
    opts.store ?? (config.eventLogPath ? new SqliteEventStore(config.eventLogPath) : new InMemoryEventStore());
  wiring.eventStore = opts.store ? "custom" : config.eventLogPath ? "sqlite" : "in-memory";

  const readModel = new ReadModel();
  await readModel.hydrate(store); // replay + subscribe before anything writes

  const memory: MemoryStore =
    opts.memory ??
    (config.memwal
      ? new WalrusMemoryStore(new SdkMemWalClient(config.memwal))
      : new InMemoryMemoryStore());
  wiring.memory = opts.memory ? "custom" : config.memwal ? "walrus" : "in-memory";

  const gaffer: Gaffer =
    opts.gaffer ??
    (config.anthropicApiKey
      ? new ClaudeGaffer(config.anthropicApiKey, memory, readModel, {
          model: config.models.default,
          verdictModel: config.models.verdict,
        })
      : new ScriptedGaffer(memory, readModel));
  wiring.gaffer = opts.gaffer ? "custom" : config.anthropicApiKey ? "claude" : "scripted";

  const suiReady = !!(config.sui.sessionsAddress && config.sui.sessionsKey && config.sui.walCoinType);
  // Privy MPC custody (no env-var key): opt-in, needs Privy creds + a WAL coin type.
  const privyCustodyReady = !!(config.sui.privyCustody && config.privy?.appSecret && config.sui.walCoinType);
  if (!opts.custody && config.sui.sessionsKey && !config.sui.walCoinType) {
    console.warn("[custody] SESSIONS_WALLET_* set but WAL_COIN_TYPE missing → staying on play-money");
  }
  let custody: Custody;
  if (opts.custody) {
    custody = opts.custody;
    wiring.custody = "custom";
  } else if (privyCustodyReady) {
    // The Sessions wallet is a Privy server wallet; its key never touches our env.
    custody = await PrivyCustody.create({
      appId: config.privy!.appId,
      appSecret: config.privy!.appSecret!,
      rpcUrl: config.sui.rpcUrl,
      walCoinType: config.sui.walCoinType!,
      ...(config.sui.sessionsExternalId ? { sessionsExternalId: config.sui.sessionsExternalId } : {}),
    });
    wiring.custody = "privy";
  } else if (suiReady) {
    custody = new SuiCustody({
      rpcUrl: config.sui.rpcUrl,
      sessionsAddress: config.sui.sessionsAddress!,
      sessionsKey: config.sui.sessionsKey!,
      walCoinType: config.sui.walCoinType!,
    });
    wiring.custody = "sui";
  } else {
    custody = new PlayLedgerCustody();
    wiring.custody = "play-money";
  }

  const matchData =
    opts.matchData ??
    (config.footballData
      ? new FootballDataProvider(config.footballData)
      : config.football
        ? new ApiFootballProvider(config.football)
        : new MockMatchData(seedFixtures(opts.now ?? Date.now())));
  wiring.matchData = opts.matchData
    ? "custom"
    : config.footballData
      ? "football-data"
      : config.football
        ? "api-football"
        : "mock";

  const auth: Auth =
    opts.auth ??
    (config.privy?.appSecret
      ? new PrivyAuth(config.privy.appId, config.privy.appSecret, config.privy.verificationKey)
      : new DevAuth());
  wiring.auth = opts.auth ? "custom" : config.privy?.appSecret ? "privy" : "dev";

  // Fail closed: real WAL custody with unverified DevAuth would let anyone drain
  // any player's funds via a forged `x-wallet` header. Never boot that combination.
  if ((wiring.custody === "sui" || wiring.custody === "privy") && wiring.auth === "dev") {
    throw new Error(
      "Refusing to boot: real WAL custody requires real auth. Set PRIVY_APP_SECRET, or unset WAL_COIN_TYPE to run play-money.",
    );
  }

  // Memory writer turns events into Walrus memories. Subscribe AFTER the read
  // model so fixture/dossier context is current when a memory is written.
  const memoryWriter = new MemoryWriter(memory, readModel);
  memoryWriter.attach((listener) => store.subscribe(listener));

  // Mirror the money-determining events to Walrus so balances are recoverable,
  // not just a local-sqlite promise (the "money on Walrus" half of the story).
  const ledgerMirror = new WalrusLedgerMirror(memory, `${config.game.namespacePrefix}:ledger`);
  ledgerMirror.attach((listener) => store.subscribe(listener));

  const engine = new Engine({ store, readModel, custody, gaffer, matchData, config: config.game });

  return { config, store, readModel, engine, gaffer, auth, memory, memoryWriter, ledgerMirror, matchData, wiring };
}
