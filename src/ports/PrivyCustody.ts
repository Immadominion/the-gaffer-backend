/**
 * Privy MPC custody — the Sessions wallet's key never exists as a raw secret.
 *
 * Where SuiCustody loads an Ed25519Keypair from an env var (the #1 production
 * risk), here the Sessions wallet is a Privy server wallet and outbound payouts
 * are signed via Privy `rawSign` — the key is held in Privy's MPC, never in our
 * process or environment. Deposit verification is byte-for-byte the same as
 * SuiCustody (read-only chain reads, no signing); only the *signing* seam differs.
 *
 * Proven end-to-end on testnet (scripts/privy-sui-sign-testnet.ts): the wallet's
 * public key derives its address, and rawSign over the Sui intent digest yields a
 * signature that verifies under that pubkey.
 */

import { PrivyClient } from "@privy-io/node";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { Signer } from "@mysten/sui/cryptography";
import type { Frost, Wallet } from "../domain/ids.ts";
import { networkOf, ownerAddress, type Custody, type CustodyRef } from "./Custody.ts";

const SUI_COIN_TYPE = "0x2::sui::SUI";

/** A Sui Signer backed by a Privy server wallet — sign() delegates to rawSign. */
export class PrivySuiSigner extends Signer {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly wallets: any,
    private readonly walletId: string,
    private readonly pubkey: Ed25519PublicKey,
  ) {
    super();
  }
  getKeyScheme() {
    return "ED25519" as const;
  }
  getPublicKey(): Ed25519PublicKey {
    return this.pubkey;
  }
  async sign(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    // The SDK hands us the 32-byte blake2b intent digest; Privy signs it (Ed25519).
    const hash = "0x" + Buffer.from(bytes).toString("hex");
    const res = (await this.wallets.rawSign(this.walletId, { params: { hash } })) as { signature: string };
    const sig = Buffer.from(res.signature.replace(/^0x/, ""), "hex");
    const out = new Uint8Array(sig.length); // a fresh ArrayBuffer-backed array (Signer's exact type)
    out.set(sig);
    return out;
  }
}

/** Build a Sui signer for any Privy wallet from its id + flag-prefixed pubkey hex. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildPrivySuiSigner(wallets: any, walletId: string, publicKeyHex: string): PrivySuiSigner {
  const pub = new Ed25519PublicKey(Uint8Array.from(Buffer.from(publicKeyHex, "hex").subarray(1)));
  return new PrivySuiSigner(wallets, walletId, pub);
}

export interface PrivyCustodyConfig {
  appId: string;
  appSecret: string;
  rpcUrl: string;
  walCoinType: string;
  /** Deterministic external_id for the Sessions Privy wallet. */
  sessionsExternalId?: string;
}

export class PrivyCustody implements Custody {
  private constructor(
    private readonly client: SuiJsonRpcClient,
    private readonly signer: PrivySuiSigner,
    private readonly address: string,
    private readonly walCoinType: string,
  ) {}

  /** Provision (get-or-create) the Sessions Privy wallet, then build the adapter. */
  static async create(cfg: PrivyCustodyConfig): Promise<PrivyCustody> {
    const privy = new PrivyClient({ appId: cfg.appId, appSecret: cfg.appSecret });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wallets = privy.wallets() as any;
    const ext = cfg.sessionsExternalId ?? "gaffer_sessions";
    const w = (await wallets.create({
      chain_type: "sui",
      external_id: ext,
      idempotency_key: `gaffer:${ext}`,
    })) as { id: string; address: string; public_key: string };

    // public_key is 33 bytes: the ED25519 scheme flag (0x00) + the 32-byte key.
    const pubkey = new Ed25519PublicKey(Uint8Array.from(Buffer.from(w.public_key, "hex").subarray(1)));
    if (pubkey.toSuiAddress() !== w.address) {
      throw new Error("PrivyCustody: sessions wallet pubkey does not derive its address");
    }
    const client = new SuiJsonRpcClient({ network: networkOf(cfg.rpcUrl), url: cfg.rpcUrl });
    return new PrivyCustody(
      client,
      new PrivySuiSigner(wallets, w.id, pubkey),
      w.address.toLowerCase(),
      cfg.walCoinType,
    );
  }

  sessionsAddress(): string {
    return this.address;
  }

  /** Identical to SuiCustody — read-only on-chain verification, no signing. */
  async confirmDeposit(wallet: Wallet, amount: Frost, proof?: string): Promise<CustodyRef> {
    if (!proof) throw new Error("on-chain deposit requires a proof (the WAL transfer's tx digest)");
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
    if (!debitedFromPlayer) throw new Error(`deposit tx ${proof} did not move WAL out of ${player}`);
    return { ref: proof };
  }

  /** Pay `amount` FROST of WAL from the Sessions wallet to the player — Privy-signed. */
  async withdraw(wallet: Wallet, amount: Frost): Promise<CustodyRef> {
    const { sui, wal } = await this.balances();
    if (wal < amount) {
      throw new Error("Withdrawals are temporarily paused — the Sessions wallet float is being topped up. Try again shortly.");
    }
    if (sui < 10_000_000n) {
      throw new Error("Withdrawals are temporarily paused — the Sessions wallet is low on gas. Try again shortly.");
    }
    const tx = new Transaction();
    tx.setSender(this.address);
    tx.transferObjects([coinWithBalance({ balance: amount, type: this.walCoinType })], tx.pure.address(wallet));
    const res = await this.client.signAndExecuteTransaction({
      signer: this.signer,
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
