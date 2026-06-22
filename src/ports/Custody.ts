/**
 * Custody — the money seam. The in-app balance/Pots are a pure event-sourced
 * ledger; real WAL only crosses the chain on deposit and withdraw. This port is
 * the *only* place that knows whether stakes are real WAL settled by the
 * dedicated Sessions wallet, or a play-money season token.
 *
 *   - PlayLedgerCustody:  no chain. Deposits are granted, withdrawals are notional.
 *                          Runs the whole game end-to-end with zero on-chain risk.
 *   - SuiCustody:          real WAL via the Sessions wallet on Sui. Verifies inbound
 *                          deposits and signs outbound payouts. The Sessions wallet
 *                          key never leaves this adapter.
 */

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import type { Frost, Wallet } from "../domain/ids.ts";

export interface CustodyRef {
  ref: string; // tx digest or notional id
}

export interface Custody {
  /** The dedicated Sessions wallet address (a hackathon requirement). */
  sessionsAddress(): string;

  /**
   * Confirm an inbound deposit (player → Sessions wallet). For real WAL this
   * verifies the on-chain transfer (identified by `proof`); for play money it
   * simply grants the credit.
   */
  confirmDeposit(wallet: Wallet, amount: Frost, proof?: string): Promise<CustodyRef>;

  /** Execute a withdrawal (Sessions wallet → player). */
  withdraw(wallet: Wallet, amount: Frost): Promise<CustodyRef>;
}

let notionalSeq = 0;

export class PlayLedgerCustody implements Custody {
  constructor(private readonly address = "play-money-season-token") {}

  sessionsAddress(): string {
    return this.address;
  }

  async confirmDeposit(_wallet: Wallet, _amount: Frost, _proof?: string): Promise<CustodyRef> {
    return { ref: `play_deposit_${++notionalSeq}` };
  }

  async withdraw(_wallet: Wallet, _amount: Frost): Promise<CustodyRef> {
    return { ref: `play_withdraw_${++notionalSeq}` };
  }
}

const SUI_COIN_TYPE = "0x2::sui::SUI";

/** Derive the Sui network label from an RPC URL (required by the v2 client options). */
function networkOf(url: string): "mainnet" | "testnet" | "devnet" | "localnet" {
  if (url.includes("testnet")) return "testnet";
  if (url.includes("devnet")) return "devnet";
  if (url.includes("localhost") || url.includes("127.0.0.1")) return "localnet";
  return "mainnet";
}

export interface SuiCustodyConfig {
  rpcUrl: string;
  sessionsAddress: string;
  sessionsKey: string; // bech32 "suiprivkey…" secret for the Sessions wallet
  walCoinType: string; // 0x<pkg>::wal::WAL on the target network
}

/** Pull the address out of a Sui balanceChange owner, lower-cased, if it has one. */
function ownerAddress(owner: unknown): string | undefined {
  if (owner && typeof owner === "object" && "AddressOwner" in owner) {
    return String((owner as { AddressOwner: string }).AddressOwner).toLowerCase();
  }
  return undefined;
}

/**
 * Real-WAL custody via Sui. The Sessions wallet is the escrow/resolver: deposits
 * are verified against the chain, payouts are signed locally. Everything in/out
 * is denominated in FROST (1 WAL = 1e9 FROST), matching the in-app ledger.
 */
export class SuiCustody implements Custody {
  private readonly client: SuiJsonRpcClient;
  private readonly keypair: Ed25519Keypair;
  private readonly address: string;
  private readonly walCoinType: string;

  constructor(cfg: SuiCustodyConfig) {
    this.client = new SuiJsonRpcClient({ network: networkOf(cfg.rpcUrl), url: cfg.rpcUrl });
    this.keypair = Ed25519Keypair.fromSecretKey(cfg.sessionsKey.trim());
    this.walCoinType = cfg.walCoinType;
    this.address = cfg.sessionsAddress.toLowerCase();
    // Fail fast on a key/address mismatch — never sign payouts with the wrong key.
    const derived = this.keypair.getPublicKey().toSuiAddress().toLowerCase();
    if (derived !== this.address) {
      throw new Error(
        `SuiCustody key/address mismatch: key derives ${derived}, but SESSIONS_WALLET_ADDRESS is ${this.address}`,
      );
    }
  }

  sessionsAddress(): string {
    return this.address;
  }

  /**
   * Verify a player's inbound WAL deposit. `proof` is the digest of the transfer
   * the player (or their embedded wallet) submitted to the Sessions wallet. We
   * confirm on-chain that it finalised successfully, moved at least `amount` WAL
   * INTO the Sessions wallet, and that the WAL left the *player's own* address —
   * so one player can't credit themselves with another's deposit digest. The
   * digest is returned as the ref; the actor dedups it per player against replay.
   */
  async confirmDeposit(wallet: Wallet, amount: Frost, proof?: string): Promise<CustodyRef> {
    if (!proof) {
      throw new Error("on-chain deposit requires a proof (the WAL transfer's tx digest)");
    }
    const tx = await this.client.waitForTransaction({
      digest: proof,
      options: { showBalanceChanges: true, showEffects: true },
    });
    if (tx.effects?.status?.status !== "success") {
      throw new Error(`deposit tx ${proof} did not finalise successfully`);
    }
    const player = wallet.toLowerCase();
    const changes = tx.balanceChanges ?? [];
    const credited = changes.find(
      (c) => c.coinType === this.walCoinType && ownerAddress(c.owner) === this.address && BigInt(c.amount) > 0n,
    );
    const debitedFromPlayer = changes.some(
      (c) => c.coinType === this.walCoinType && ownerAddress(c.owner) === player && BigInt(c.amount) < 0n,
    );
    if (!credited || BigInt(credited.amount) < amount) {
      throw new Error(`deposit tx ${proof} does not credit ${amount} FROST of WAL to the Sessions wallet`);
    }
    if (!debitedFromPlayer) {
      throw new Error(`deposit tx ${proof} did not move WAL out of ${player}`);
    }
    return { ref: proof };
  }

  /** Pay `amount` FROST of WAL from the Sessions wallet to the player. */
  async withdraw(wallet: Wallet, amount: Frost): Promise<CustodyRef> {
    // Pre-flight: surface a clear "paused" message rather than an opaque chain
    // failure if the Sessions wallet can't cover the payout or the gas. Gameplay
    // and the (ledger-only) welcome grant are unaffected by an empty float.
    const { sui, wal } = await this.balances();
    if (wal < amount) {
      throw new Error("Withdrawals are temporarily paused — the Sessions wallet float is being topped up. Try again shortly.");
    }
    if (sui < 10_000_000n) {
      throw new Error("Withdrawals are temporarily paused — the Sessions wallet is low on gas. Try again shortly.");
    }
    const tx = new Transaction();
    tx.setSender(this.address);
    // coinWithBalance selects/merges/splits the Sessions wallet's WAL coins to
    // exactly `amount`; gas is paid separately in SUI by the sender.
    tx.transferObjects(
      [coinWithBalance({ balance: amount, type: this.walCoinType })],
      tx.pure.address(wallet),
    );
    const res = await this.client.signAndExecuteTransaction({
      signer: this.keypair,
      transaction: tx,
      options: { showEffects: true },
    });
    await this.client.waitForTransaction({ digest: res.digest });
    if (res.effects?.status?.status !== "success") {
      throw new Error(`withdrawal tx ${res.digest} failed: ${res.effects?.status?.error ?? "unknown"}`);
    }
    return { ref: res.digest };
  }

  /** Ops helper (not part of the port): current Sessions balances in base units. */
  async balances(): Promise<{ sui: bigint; wal: bigint }> {
    const [sui, wal] = await Promise.all([
      this.client.getBalance({ owner: this.address, coinType: SUI_COIN_TYPE }),
      this.client.getBalance({ owner: this.address, coinType: this.walCoinType }),
    ]);
    return { sui: BigInt(sui.totalBalance), wal: BigInt(wal.totalBalance) };
  }
}
