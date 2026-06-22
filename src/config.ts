/**
 * Configuration. One typed object assembled from the environment, with safe
 * defaults so the system boots fully in-memory (no keys, no network) for dev,
 * tests, and the smoke run.
 */

import type { Frost } from "./domain/ids.ts";
import type { RateLimitConfig } from "./engine/RateLimiter.ts";

export interface GameConfig {
  rakeBps: number; // basis points of the losers' pool → Manager's Pot
  minParticipants: number; // thin-pool threshold
  minStake: Frost; // smallest allowed stake (FROST)
  namespacePrefix: string; // Walrus namespace prefix, e.g. "gaffer"
  welcomeGrant: Frost; // one-time NON-withdrawable starter bonus (play, don't cash out)
  withdrawFeeBps: number; // house fee on withdrawals — covers on-chain gas + margin
  withdrawFeeMin: Frost; // flat floor so tiny cash-outs still cover ~fixed gas
  rateLimits: RateLimitConfig; // per-wallet buckets + global daily cap on paid LLM calls
  house: HouseConfig; // synthetic house bettors that seed a counterparty per match
}

export interface HouseConfig {
  enabled: boolean; // master switch for house liquidity seeding
  botCount: number; // distinct house wallets (≥2 so player+bots clears minParticipants)
  seedStake: Frost; // each bot's stake per match (FROST)
  bankrollPerBot: Frost; // one-time, float-backed capital per bot
  liquidityCap: Frost; // hard ceiling on total house capital (clamps bankroll × botCount)
}

export interface AppConfig {
  port: number;
  /** Durable event-log path (SQLite). Unset → in-memory (state lost on restart). */
  eventLogPath?: string;
  /** Secret that gates the demo "resolve match now" endpoint. Unset → disabled. */
  demoAdminKey?: string;
  anthropicApiKey?: string;
  /** The Gaffer's voice. Cheapest capable model by default; verdict can upgrade. */
  models: { default: string; verdict: string };
  memwal?: { privateKey: string; accountId: string; serverUrl?: string };
  football?: {
    apiKey: string;
    baseUrl: string;
    competitions: { league: number; season: number }[];
    cacheTtlMs: number;
  };
  /** football-data.org — free tier covers the live World Cup (code "WC"). */
  footballData?: {
    apiKey: string;
    baseUrl: string;
    competitions: string[];
    cacheTtlMs: number;
  };
  sui: { rpcUrl: string; sessionsAddress?: string; sessionsKey?: string; walCoinType?: string };
  /** Auth / embedded wallets (Privy). Verified server-side; users never see crypto. */
  privy?: { appId: string; appSecret?: string; verificationKey?: string };
  game: GameConfig;
}

const num = (v: string | undefined, fallback: number): number => {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

/** Parse "1:2026,39:2025" → [{league:1,season:2026},{league:39,season:2025}]. */
function parseCompetitions(raw: string | undefined): { league: number; season: number }[] | undefined {
  if (!raw) return undefined;
  const out = raw
    .split(",")
    .map((pair) => pair.split(":").map((n) => Number(n.trim())))
    .filter(([l, s]) => Number.isFinite(l) && Number.isFinite(s))
    .map(([league, season]) => ({ league: league as number, season: season as number }));
  return out.length ? out : undefined;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const cfg: AppConfig = {
    port: num(env.PORT, 8787),
    models: {
      default: env.GAFFER_MODEL ?? "claude-haiku-4-5",
      // The Verdict is the shareable, viral artifact — worth the flagship model.
    verdict: env.GAFFER_VERDICT_MODEL ?? "claude-opus-4-8",
    },
    sui: { rpcUrl: env.SUI_RPC_URL ?? "https://fullnode.mainnet.sui.io:443" },
    game: {
      rakeBps: num(env.RAKE_BPS, 250),
      minParticipants: num(env.MIN_PARTICIPANTS, 3),
      minStake: BigInt(env.MIN_STAKE_FROST ?? "10000000"), // 0.01 WAL
      namespacePrefix: env.MEMWAL_NAMESPACE_PREFIX ?? "gaffer",
      // Non-withdrawable starter bonus. 50 WAL on testnet; set lower on mainnet.
      welcomeGrant: BigInt(env.WELCOME_GRANT_FROST ?? "50000000000"),
      // Withdrawal fee = max(bps%, flat min) → kept by the house to cover gas.
      withdrawFeeBps: num(env.WITHDRAW_FEE_BPS, 200), // 2%
      withdrawFeeMin: BigInt(env.WITHDRAW_FEE_MIN_FROST ?? "50000000"), // 0.05 WAL
      // Rate limits on the paid (Anthropic) endpoints. Buckets are a burst +
      // a slow refill; the global cap is the per-day backstop against Sybils.
      rateLimits: {
        // Chat: 5-message burst, then ~1/min — a real conversation flows, a loop chokes.
        chat: { capacity: num(env.RL_CHAT_BURST, 5), refillMs: num(env.RL_CHAT_REFILL_MS, 60_000) },
        // Verdict: the expensive, deliberate call — 5-minute cooldown (burst of 2).
        verdict: { capacity: num(env.RL_VERDICT_BURST, 2), refillMs: num(env.RL_VERDICT_REFILL_MS, 300_000) },
        // Pre-bet read: fired by the staking UI, so looser — 10 burst, then 1/15s.
        preBetRead: { capacity: num(env.RL_PREBET_BURST, 10), refillMs: num(env.RL_PREBET_REFILL_MS, 15_000) },
        // Hard daily ceiling on ALL model calls, every wallet combined.
        globalDailyCap: num(env.RL_GLOBAL_DAILY_CAP, 3000),
      },
      // House liquidity — seeds a counterparty so solo bets actually settle.
      // Just-in-time (only matches a real player touches) and float-backed.
      house: {
        enabled: (env.HOUSE_LIQUIDITY_ENABLED ?? "true") !== "false",
        botCount: num(env.HOUSE_BOT_COUNT, 3), // one per outcome (HOME/AWAY/DRAW)
        seedStake: BigInt(env.HOUSE_SEED_STAKE_FROST ?? "1000000000"), // 1 WAL per bot per match
        bankrollPerBot: BigInt(env.HOUSE_BANKROLL_FROST ?? "10000000000"), // 10 WAL one-time per bot
        liquidityCap: BigInt(env.HOUSE_LIQUIDITY_CAP_FROST ?? "30000000000"), // 30 WAL total exposure (< float)
      },
    },
  };
  if (env.EVENT_LOG_PATH) cfg.eventLogPath = env.EVENT_LOG_PATH;
  if (env.DEMO_ADMIN_KEY) cfg.demoAdminKey = env.DEMO_ADMIN_KEY;
  if (env.ANTHROPIC_API_KEY) cfg.anthropicApiKey = env.ANTHROPIC_API_KEY;
  if (env.MEMWAL_PRIVATE_KEY && env.MEMWAL_ACCOUNT_ID) {
    cfg.memwal = { privateKey: env.MEMWAL_PRIVATE_KEY, accountId: env.MEMWAL_ACCOUNT_ID };
    if (env.MEMWAL_SERVER_URL) cfg.memwal.serverUrl = env.MEMWAL_SERVER_URL;
  }
  if (env.API_FOOTBALL_KEY) {
    cfg.football = {
      apiKey: env.API_FOOTBALL_KEY,
      baseUrl: env.API_FOOTBALL_BASE ?? "https://v3.football.api-sports.io",
      // World Cup (league 1, season 2026) is the flagship; add more "league:season"
      // pairs (comma-separated) to feature other competitions — it's a platform.
      competitions: parseCompetitions(env.FOOTBALL_COMPETITIONS) ?? [{ league: 1, season: 2026 }],
      cacheTtlMs: num(env.API_FOOTBALL_CACHE_TTL_MS, 900_000), // 15 min — stays under the free tier
    };
  }
  if (env.FOOTBALL_DATA_API_KEY) {
    cfg.footballData = {
      apiKey: env.FOOTBALL_DATA_API_KEY,
      baseUrl: env.FOOTBALL_DATA_BASE ?? "https://api.football-data.org/v4",
      // World Cup ("WC") by default; comma-separated competition codes for more.
      competitions: (env.FOOTBALL_DATA_COMPETITIONS ?? "WC").split(",").map((c) => c.trim()).filter(Boolean),
      cacheTtlMs: num(env.FOOTBALL_DATA_CACHE_TTL_MS, 60_000), // free tier = 10 req/min; cache keeps us ~1/min
    };
  }
  if (env.SESSIONS_WALLET_ADDRESS) cfg.sui.sessionsAddress = env.SESSIONS_WALLET_ADDRESS;
  if (env.SESSIONS_WALLET_KEY) cfg.sui.sessionsKey = env.SESSIONS_WALLET_KEY;
  if (env.WAL_COIN_TYPE) cfg.sui.walCoinType = env.WAL_COIN_TYPE;
  if (env.PRIVY_APP_ID) {
    cfg.privy = { appId: env.PRIVY_APP_ID };
    if (env.PRIVY_APP_SECRET) cfg.privy.appSecret = env.PRIVY_APP_SECRET;
    if (env.PRIVY_VERIFICATION_KEY) cfg.privy.verificationKey = env.PRIVY_VERIFICATION_KEY;
  }
  return cfg;
}
