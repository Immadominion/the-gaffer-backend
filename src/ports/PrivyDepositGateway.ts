/**
 * Deposit gateway — turns "WAL arrived in a player's Privy wallet" into a credited
 * ledger balance, the custodial way.
 *
 * A player's deposit address is their own Privy (server-custodied) Sui wallet.
 * They send WAL to it from anywhere; this sweeps that WAL into the central
 * Sessions float (signed by the player's Privy wallet via MPC) so the float can
 * back withdrawals, and returns the sweep tx digests + amounts for the engine to
 * credit. The sweep tx moves WAL *out of the player's wallet into Sessions*, so
 * the existing SuiCustody/PrivyCustody.confirmDeposit verification accepts the
 * digest unchanged.
 *
 * Robustness:
 *  - **Idempotent.** Each credit is keyed by the sweep tx digest; the player
 *    actor's replay guard credits a digest at most once.
 *  - **Reconciled.** Every call first re-collects recent player→Sessions WAL
 *    transfers, so a sweep that executed but crashed before crediting is healed on
 *    the next attempt (the digest is re-presented; already-credited ones no-op).
 *  - **Gas-safe.** A fresh player wallet has no SUI for gas, so the Sessions wallet
 *    tops it up before the sweep; the top-up dust stays for the next sweep.
 */

import { PrivyClient } from "@privy-io/node";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { networkOf, ownerAddress } from "./Custody.ts";
import { buildPrivySuiSigner, type PrivySuiSigner } from "./PrivyCustody.ts";

const SUI_COIN_TYPE = "0x2::sui::SUI";
const GAS_MIN = 10_000_000n; // 0.01 SUI — below this, top the player wallet up
const GAS_TOPUP = 20_000_000n; // 0.02 SUI sent for gas (dust stays for next time)

export interface DepositCredit {
  digest: string; // the sweep tx — also the custody proof
  amount: bigint; // WAL (FROST) swept into Sessions
}

export interface PrivyPlayer {
  address: string; // the player's Privy Sui wallet = their deposit address
  walletId: string;
  publicKey: string; // flag-prefixed hex, as Privy returns it
}

/** The capability the Engine depends on — sweep + reconcile a player's deposits. */
export interface DepositGateway {
  collect(player: PrivyPlayer): Promise<DepositCredit[]>;
}

export interface PrivyDepositGatewayConfig {
  appId: string;
  appSecret: string;
  rpcUrl: string;
  walCoinType: string;
  sessionsExternalId?: string;
}

export class PrivyDepositGateway {
  private constructor(
    private readonly client: SuiJsonRpcClient,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly wallets: any,
    private readonly sessionsSigner: PrivySuiSigner,
    private readonly sessionsAddress: string,
    private readonly walCoinType: string,
  ) {}

  static async create(cfg: PrivyDepositGatewayConfig): Promise<PrivyDepositGateway> {
    const privy = new PrivyClient({ appId: cfg.appId, appSecret: cfg.appSecret });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wallets = privy.wallets() as any;
    const ext = cfg.sessionsExternalId ?? "gaffer_sessions";
    const s = (await wallets.create({
      chain_type: "sui",
      external_id: ext,
      idempotency_key: `gaffer:${ext}`,
    })) as { id: string; address: string; public_key: string };
    const sessionsSigner = buildPrivySuiSigner(wallets, s.id, s.public_key);
    if (new Ed25519PublicKey(Uint8Array.from(Buffer.from(s.public_key, "hex").subarray(1))).toSuiAddress() !== s.address) {
      throw new Error("PrivyDepositGateway: sessions pubkey does not derive its address");
    }
    const client = new SuiJsonRpcClient({ network: networkOf(cfg.rpcUrl), url: cfg.rpcUrl });
    return new PrivyDepositGateway(client, wallets, sessionsSigner, s.address.toLowerCase(), cfg.walCoinType);
  }

  /**
   * Collect everything depositable for a player: recent (possibly uncredited)
   * sweeps plus a fresh sweep of whatever WAL is sitting in their wallet now.
   * Never throws on a single failure mid-batch — returns what it could collect.
   */
  async collect(player: PrivyPlayer): Promise<DepositCredit[]> {
    const credits: DepositCredit[] = [];

    // 1. Reconcile: recent WAL transfers player → Sessions (heal crashed credits).
    try {
      const recent = await this.client.queryTransactionBlocks({
        filter: { FromAddress: player.address },
        options: { showBalanceChanges: true },
        limit: 25,
        order: "descending",
      });
      for (const tx of recent.data) {
        const credited = (tx.balanceChanges ?? []).find(
          (c) => c.coinType === this.walCoinType && ownerAddress(c.owner) === this.sessionsAddress && BigInt(c.amount) > 0n,
        );
        if (credited) credits.push({ digest: tx.digest, amount: BigInt(credited.amount) });
      }
    } catch (err) {
      console.error("[deposit] reconcile query failed:", err);
    }

    // 2. Sweep whatever WAL is in the player's wallet right now.
    try {
      const walBal = BigInt((await this.client.getBalance({ owner: player.address, coinType: this.walCoinType })).totalBalance);
      if (walBal > 0n) {
        await this.ensureGas(player.address);
        const digest = await this.sweep(player, walBal);
        if (digest) credits.push({ digest, amount: walBal });
      }
    } catch (err) {
      console.error("[deposit] sweep failed:", err);
    }

    // De-dup by digest (the reconcile + fresh sweep can't overlap, but be safe).
    const seen = new Set<string>();
    return credits.filter((c) => (seen.has(c.digest) ? false : (seen.add(c.digest), true)));
  }

  /** Top the player's wallet up with gas if it can't cover a sweep. */
  private async ensureGas(playerAddress: string): Promise<void> {
    const sui = BigInt((await this.client.getBalance({ owner: playerAddress })).totalBalance);
    if (sui >= GAS_MIN) return;
    const tx = new Transaction();
    tx.setSender(this.sessionsAddress);
    const [gas] = tx.splitCoins(tx.gas, [GAS_TOPUP]);
    tx.transferObjects([gas], tx.pure.address(playerAddress));
    const res = await this.client.signAndExecuteTransaction({ signer: this.sessionsSigner, transaction: tx, options: { showEffects: true } });
    await this.client.waitForTransaction({ digest: res.digest });
  }

  /** Move all the player's WAL into the Sessions wallet; returns the tx digest. */
  private async sweep(player: PrivyPlayer, _amount: bigint): Promise<string | null> {
    const playerSigner = buildPrivySuiSigner(this.wallets, player.walletId, player.publicKey);
    const walCoins = (await this.client.getCoins({ owner: player.address, coinType: this.walCoinType })).data;
    if (walCoins.length === 0) return null;
    const tx = new Transaction();
    tx.setSender(player.address);
    tx.transferObjects(walCoins.map((c) => tx.object(c.coinObjectId)), tx.pure.address(this.sessionsAddress));
    const res = await this.client.signAndExecuteTransaction({ signer: playerSigner, transaction: tx, options: { showEffects: true } });
    await this.client.waitForTransaction({ digest: res.digest });
    if (res.effects?.status?.status !== "success") {
      throw new Error(`sweep ${res.digest} failed: ${res.effects?.status?.error ?? "unknown"}`);
    }
    return res.digest;
  }
}
