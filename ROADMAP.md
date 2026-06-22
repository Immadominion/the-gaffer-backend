# The Gaffer — Roadmap

What's deliberately deferred past the hackathon, and the proof-of-work that de-risks it.
The current build is a working, honest MVP; this is the path to production-grade.

## 1. Custody hardening — get the key out of an env var  *(highest priority)*

**Today:** the Sessions wallet is a raw Sui keypair with the private key in a Railway
env var, controlling real mainnet funds. Fine for a demo with a tiny float; not for scale.

**Proof of work (verified, 2026-06-22):** Privy *can* custody a Sui wallet with MPC —
- Server wallets created with `chain_type: "sui"` (already used for player wallets).
- Signing via `wallets().rawSign(walletId, { params: { hash }, authorization_context })`,
  authorized by a P-256 key (`generateP256KeyPair()` → `owner.public_key` at create time).
- Sui-aware **policies** exist (`sui_transaction_command`, `sui_transfer_objects_command`)
  to constrain spend.
- Caveat: Privy has **no high-level Sui signer** (only EVM/Solana). Sui = build tx →
  BLAKE2b intent digest → `rawSign` (Ed25519) → assemble the serialized Sui signature →
  submit. Finicky and must be byte-exact.

**Plan:** build a `PrivyCustody` adapter → **verify end-to-end on testnet** (Privy-managed
wallet signs + sends a real WAL transfer) → only then create the mainnet managed wallet,
move the float, swap `SESSIONS_WALLET_ADDRESS`, delete the env key.

**Strong alternative:** **Turnkey** has first-class, documented Sui MPC signing — likely the
cleaner long-term custody. Keep Privy purely for auth (what it's best at).

## 2. Deposits
- **MVP (Sui-native):** user's Privy Sui wallet → transfer WAL to the Sessions wallet →
  pass the tx digest as `proof` to `deposit` (backend already verifies proofs).
- **North star (cross-chain):** deposit from any chain, settle on Sui (Wormhole / deBridge /
  Jupiter-style intents). A feature in its own right.

## 3. Ledger durability + verifiability — the Walrus event mirror
The off-chain sqlite event log is the source of truth for who owns what WAL. Mirror it to
Walrus so balances are **independently verifiable and recoverable**, not just a promise.
This is what makes "on Walrus" true for the *money*, not only the memory.

## 4. Settlement integrity
- **Multi-oracle results:** currently a single source (football-data.org). Add a second
  source + a dispute window before payout.
- **Scheduler robustness:** the 30s in-process tick works, but move ingestion/settlement to
  a dedicated scheduler (Railway cron / queue) so it survives process restarts and scales.

## 5. Product / UX
- Email + push notifications (today: in-app bell + .ics calendar export only).
- Working search.
- Performance profiling on the production build.

## 6. Business + compliance
- Tune the economics (rake split, withdrawal fee, WAL volatility, the float).
- **Custody / money-transmission review** before holding real user funds at scale — a
  deliberate legal/business decision, not a code change.

## 7. Liquidity & cold-start — house / NPC bettors
Parimutuel needs opponents: with too few players a match voids and refunds (the
`minParticipants` rule). Seed each match's pools with synthetic "house" bettors so a real
user always has a counterparty and bets settle for real — also the cleanest **demo** (no
need to coordinate a second tester).
**Trade-off:** bots make the **house a counterparty** — it funds the bot's stake and bears
that side's risk — unlike pure player-vs-player where the house only takes rake. So cap and
manage the house's bot exposure per match, and taper it as organic volume arrives.

## 8. Ops, cost & abuse
- **Rate-limit chat + verdicts** — every call hits the Anthropic API (real $); cap per user.
- **Back up the sqlite ledger volume** until the Walrus mirror (§3) lands.
- **Observability:** structured logs, error alerting, settlement monitoring + reconciliation
  (ledger balances vs. on-chain wallet).
- **Automate the memory loop:** auto-verdicts on big results + scheduled trait distillation
  (today both are on-demand).
- **Idempotent settlement on restart:** the 30s tick is in-process; make sure a redeploy
  mid-settlement can't double-pay (event sourcing + expectedVersion already guards this —
  add a test).

## 9. UX / platform
- Mobile-responsive pass (the 3D Gaffer + layouts are desktop-first).
- Working search; richer notifications (email/push) beyond the in-app bell + .ics.
- Move the 7×~25 MB `.glb` models to a CDN / Walrus blob (the repo is ~190 MB of binaries).
