# The Gaffer — Roadmap

What's deliberately deferred past the hackathon, and the proof-of-work that de-risks it.
The current build is a working, honest MVP; this is the path to production-grade.

## Status — what's LIVE today (2026-06-22)

This is not a mockup. The following runs on **Sui mainnet**, end-to-end:
- **Auth:** Privy (email / Google / X) → server-custodied Sui wallet. Real-auth gate fails closed.
- **Engine:** event-sourced + CQRS + actor-per-player. Parimutuel settlement with exact
  integer money math. 38 passing tests.
- **AI memory on Walrus:** the Gaffer chats, issues verdicts, and remembers — every call,
  chat, and verdict persisted as Walrus blobs (memwal). This is the hackathon's core.
- **Gameplay:** calls, live settlement, GR rating, tiers, form, leaderboards, match scores.
- **House liquidity** (§7) so a solo player's bet settles for real, not voids.
- **Rate limiting** (§8/§10) on the paid LLM endpoints + a global daily cap.
- **Withdrawals** with a house fee; **welcome grant** (non-withdrawable, idempotent).

**The honest gaps** (the "last mile to real money at scale"), in priority order:
1. **Deposits don't work yet** (§2) — the only way in is the welcome grant. *Top functional gap.*
2. **Custody key lives in an env var** (§1) — the #1 risk before real volume.
3. **The money ledger isn't on Walrus yet** (§3) — only the *memory* is.
Everything below is that path, with the proof-of-work that de-risks each step.

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

## 2. Deposits  *(top functional gap — the product is unusable without it)*

**Today:** the "Add funds" modal calls `deposit(amount)` with **no on-chain proof**, so the
mainnet custody check rejects it. The only way to get WAL into the system is the welcome
grant. The backend half is done (`confirmDeposit` verifies a tx digest: finalized + credits
the Sessions wallet by `amount` + sender check + replay guard); the **on-chain leg + the UI
are missing.**

Two buildable paths (not mutually exclusive):
- **(A) Crypto-native, buildable now — no Privy-signing needed.** User links their own Sui
  address, sends WAL to the Sessions wallet from it, and the deposit is credited once the tx
  is verified (sender-bound, so it can't be front-run). Works today for crypto-native users;
  contradicts the "no-crypto UX" goal but is a real, honest deposit path.
- **(B) Custodial sweep — needs Privy Sui signing (couples to §1).** User funds their own
  Privy wallet (their deposit address); the backend sweeps Privy→Sessions via `rawSign` and
  credits. Cleaner UX, but blocked on the same Sui-signing work as custody hardening.
- **North star (cross-chain):** deposit from any chain, settle on Sui (Wormhole / deBridge /
  Jupiter-style intents). A feature in its own right.

**Fiat/card on-ramp** is a *separate* track — it needs a licensed provider (Transak/Stripe/
etc.) and a registered business entity, so it's a business decision, not just code.

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

## 7. Liquidity & cold-start — house / NPC bettors  ✓ *built 2026-06-22*
Parimutuel needs opponents: with too few players a match voids and refunds (the
`minParticipants` rule). **Shipped:** `HouseLiquidity` seeds each touched match's result
outcomes with float-backed synthetic bets, just-in-time on a real player's first call, so a
solo player always has a counterparty and bets settle for real. Exposure is hard-capped
under the float; bots are hidden from leaderboards. Paired with a key-gated `resolveMatchNow`
(+ `scripts/demo-resolve.ts`) to settle on command in a demo.
**Remaining:** taper bot exposure as organic volume arrives; per-match exposure tuning;
smarter bot sizing so pre-bet odds look natural before the first real call.
**Trade-off (by design):** bots make the **house a counterparty** — it funds the bot's
stake and bears that side's risk — unlike pure player-vs-player where the house only rakes.

## 8. Ops, cost & abuse
- ✓ **Rate-limit chat + verdicts** *(built 2026-06-22)* — per-wallet token buckets + a global
  daily cap on the paid Anthropic endpoints (`RateLimiter`). Closed the HIGH /cso finding.
- **Back up the sqlite ledger volume** until the Walrus mirror (§3) lands.
- **Observability:** structured logs, error alerting, settlement monitoring + reconciliation
  (ledger balances vs. on-chain wallet).
- **Automate the memory loop:** auto-verdicts on big results + scheduled trait distillation
  (today both are on-demand).
- **Idempotent settlement on restart:** the 30s tick is in-process; make sure a redeploy
  mid-settlement can't double-pay (event sourcing + expectedVersion already guards this —
  add a test).

## 10. Security (from /cso audit, 2026-06-22)
- ✓ **Rate-limit LLM endpoints (HIGH)** *(fixed 2026-06-22)* — per-wallet token buckets +
  global daily cap shipped (`RateLimiter`); chat/verdict/pre-bet read all gated.
- **Welcome-grant laundering (MEDIUM):** grant credits non-withdrawable `bonus`, but
  settlement credits winnings to withdrawable `balance`. Two colluding Sybil accounts can
  convert bonus → real withdrawable WAL. Fix: taint bonus-funded winnings (credit back to
  bonus), or gate withdrawal on a prior real deposit, or Sybil-resist signup. **Note:** the
  demo `minParticipants` 3→2 change lowers the collusion bar — raise it before real money.
- **Clean:** secrets gitignored + absent from history and the frontend bundle; deposit
  proofs verified on-chain (finalized + amount + recipient + sender + replay guard); every
  mutation is server-wallet-scoped; the sui-custody + dev-auth combo fails closed at boot.

## 9. UX / platform
- Mobile-responsive pass (the 3D Gaffer + layouts are desktop-first).
- Working search; richer notifications (email/push) beyond the in-app bell + .ics.
- Move the 7×~25 MB `.glb` models to a CDN / Walrus blob (the repo is ~190 MB of binaries).
