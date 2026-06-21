/**
 * Commands are *intents* — what a player asks to do. The player actor validates
 * a command against current state and, if it holds, appends one or more events.
 * Commands can be rejected; events never are (they already happened).
 */

import type { Bucket, Frost, MarketId, MatchId, TakeId, Wallet } from "./ids.ts";
import type { VerdictTrigger } from "./model.ts";

export interface SignContract {
  type: "SignContract";
  wallet: Wallet;
  handle?: string;
}

export interface Deposit {
  type: "Deposit";
  wallet: Wallet;
  amount: Frost;
}

export interface Withdraw {
  type: "Withdraw";
  wallet: Wallet;
  amount: Frost;
}

export interface MakeCall {
  type: "MakeCall";
  wallet: Wallet;
  matchId: MatchId;
  marketId: MarketId;
  bucket: Bucket;
  stake: Frost;
  note?: string;
}

export interface DeclareHotTake {
  type: "DeclareHotTake";
  wallet: Wallet;
  text: string;
}

export interface RequestVerdict {
  type: "RequestVerdict";
  wallet: Wallet;
  trigger: VerdictTrigger;
}

export type Command =
  | SignContract
  | Deposit
  | Withdraw
  | MakeCall
  | DeclareHotTake
  | RequestVerdict;

export type CommandType = Command["type"];
export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;
