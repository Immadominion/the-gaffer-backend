/**
 * The event-sourcing spine.
 *
 * Every meaningful thing that ever happens is an immutable event appended to a
 * stream. The Dossier, the Pots, the Leaderboard, the Gaffer's read on you — all
 * of it is a *projection* of these events. The events are the source of truth and
 * they live on Walrus. Nothing is mutated; new facts are only ever appended.
 */

import type {
  Bucket,
  CallId,
  EventId,
  Frost,
  MarketId,
  MatchId,
  TakeId,
  VerdictId,
  Wallet,
} from "./ids.ts";
import type { Fixture, MarketDef, Outcome, Tier, VerdictTrigger } from "./model.ts";

// ── Player stream events (namespace: gaffer:<wallet>) ────────────────────────
// This stream *is* the player's Walrus memory. It is what the judges score.

export interface PlayerSigned {
  type: "PlayerSigned";
  wallet: Wallet;
  handle?: string;
}

export interface Deposited {
  type: "Deposited";
  amount: Frost;
  custodyRef?: string; // tx digest from the Custody port
}

export interface Withdrawn {
  type: "Withdrawn";
  amount: Frost;
  custodyRef?: string;
}

/** One-time starter bonus — spendable on calls, NOT withdrawable. */
export interface WelcomeGranted {
  type: "WelcomeGranted";
  amount: Frost;
}

export interface CallMade {
  type: "CallMade";
  callId: CallId;
  matchId: MatchId;
  marketId: MarketId;
  bucket: Bucket;
  stake: Frost;
  /** Crowd-implied probability of this bucket at the moment of the call (0..1). */
  impliedProbAtCall: number;
  bold: boolean;
  note?: string;
}

export interface HotTakeDeclared {
  type: "HotTakeDeclared";
  takeId: TakeId;
  text: string;
  subject?: string; // best-effort entity the take is about ("France")
}

export interface CallSettled {
  type: "CallSettled";
  callId: CallId;
  matchId: MatchId;
  marketId: MarketId;
  result: "WON" | "LOST";
  stake: Frost;
  payout: Frost; // total returned to the player (0 if lost)
  pnlDelta: Frost; // payout - stake (signed)
  grDelta: number; // change to Gaffer Rating (skill), stake-independent
  difficulty: number; // 0..1, how unlikely the crowd thought this was
}

export interface CallVoided {
  type: "CallVoided";
  callId: CallId;
  matchId: MatchId;
  marketId: MarketId;
  refund: Frost;
  reason: string; // "match abandoned", "thin pool", ...
}

export interface TierChanged {
  type: "TierChanged";
  from: Tier;
  to: Tier;
  direction: "PROMOTION" | "DEMOTION";
  grAt: number;
}

export interface TraitObserved {
  type: "TraitObserved";
  traitKey: string;
  label: string;
  confidence: number;
  evidence: string;
}

export interface VerdictIssued {
  type: "VerdictIssued";
  verdictId: VerdictId;
  text: string;
  trigger: VerdictTrigger;
  quotes: string[]; // past-self lines the Gaffer threw back
}

export type PlayerEvent =
  | PlayerSigned
  | Deposited
  | Withdrawn
  | WelcomeGranted
  | CallMade
  | HotTakeDeclared
  | CallSettled
  | CallVoided
  | TierChanged
  | TraitObserved
  | VerdictIssued;

// ── Match stream events (namespace: gaffer:match:<id>) ───────────────────────
// Shared game state for one fixture: its market, its Pots, its result.

export interface MatchOpened {
  type: "MatchOpened";
  fixture: Fixture;
  markets: MarketDef[];
}

export interface MatchLocked {
  type: "MatchLocked";
  matchId: MatchId;
}

export interface MatchResolved {
  type: "MatchResolved";
  matchId: MatchId;
  score: { home: number; away: number };
  /** marketId -> winning bucket, or VOID. */
  outcomes: Record<string, Outcome>;
  source: string; // provenance: which data feed adjudicated it
}

export interface PotSettled {
  type: "PotSettled";
  matchId: MatchId;
  marketId: MarketId;
  winningBucket: Outcome;
  grossPot: Frost;
  rake: Frost;
  winnersStake: Frost;
  settledCount: number;
}

export type MatchEvent = MatchOpened | MatchLocked | MatchResolved | PotSettled;

// ── Envelope ─────────────────────────────────────────────────────────────────

export type DomainEvent = PlayerEvent | MatchEvent;
export type DomainEventType = DomainEvent["type"];

/** Narrow a DomainEvent union member by its `type` tag. */
export type EventOf<T extends DomainEventType> = Extract<DomainEvent, { type: T }>;

export interface EventMeta {
  id: EventId;
  streamId: string;
  version: number; // 0-based position within its stream
  at: number; // unix ms, assigned at append time
}

/** An event as it lives in the store: payload + position metadata. */
export interface StoredEvent<E extends DomainEvent = DomainEvent> {
  meta: EventMeta;
  payload: E;
}
