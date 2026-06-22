/**
 * Branded identifiers and money units.
 *
 * Money is represented in FROST — the smallest unit of WAL (1 WAL = 1e9 FROST) —
 * as a `bigint`, so the parimutuel maths never touches floating point. superjson
 * carries bigints across the tRPC boundary intact.
 */

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type Wallet = Brand<string, "Wallet">; // Sui address, lower-cased
export type MatchId = Brand<string, "MatchId">;
export type MarketId = Brand<string, "MarketId">;
export type Bucket = Brand<string, "Bucket">;
export type CallId = Brand<string, "CallId">;
export type TakeId = Brand<string, "TakeId">;
export type VerdictId = Brand<string, "VerdictId">;
export type EventId = Brand<string, "EventId">;

export const FROST_PER_WAL = 1_000_000_000n;
/** Money, in FROST. */
export type Frost = bigint;

export const wal = (whole: number): Frost => {
  // Convert a human WAL figure to FROST without float drift on the fraction.
  const s = whole.toString();
  const dot = s.indexOf(".");
  const int = dot === -1 ? s : s.slice(0, dot);
  const frac = dot === -1 ? "" : s.slice(dot + 1);
  const fracPadded = (frac + "000000000").slice(0, 9);
  return BigInt(int) * FROST_PER_WAL + BigInt(fracPadded);
};

export const formatWal = (frost: Frost): string => {
  const neg = frost < 0n;
  const abs = neg ? -frost : frost;
  const int = abs / FROST_PER_WAL;
  const frac = (abs % FROST_PER_WAL).toString().padStart(9, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? "." + frac : ""}`;
};

export const asWallet = (s: string): Wallet => s.trim().toLowerCase() as Wallet;
export const asMatchId = (s: string): MatchId => s as MatchId;
export const asMarketId = (s: string): MarketId => s as MarketId;
export const asBucket = (s: string): Bucket => s as Bucket;

export const newId = <T extends string>(prefix: string): Brand<string, T> =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}` as Brand<string, T>;

export const newCallId = () => newId<"CallId">("call");
export const newTakeId = () => newId<"TakeId">("take");
export const newVerdictId = () => newId<"VerdictId">("vdct");
export const newEventId = () => newId<"EventId">("evt");

/** The per-player Walrus namespace — one player, one continuous owned memory. */
export const playerStream = (w: Wallet): string => `gaffer:${w}`;
/** Shared game state for a single fixture. */
export const matchStream = (m: MatchId): string => `gaffer:match:${m}`;

// ── House liquidity wallets ──────────────────────────────────────────────────
// Synthetic "house" bettors that seed a match's pools so a real player always has
// a counterparty. They are real player streams (settlement treats them like
// anyone else) but are filtered out of the public leaderboards.
export const HOUSE_WALLET_PREFIX = "house:";
export const houseWallet = (i: number): Wallet => `${HOUSE_WALLET_PREFIX}bot:${i}` as Wallet;
export const isHouseWallet = (w: Wallet): boolean => w.startsWith(HOUSE_WALLET_PREFIX);
