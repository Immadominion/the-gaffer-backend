/**
 * Auth port — turns a client credential into the player identity (their Sui
 * address). The API depends on this, not on any one provider, so swapping
 * dev-mode for Privy is a composition-root change, not an API change.
 *
 * verify() returns null for a missing/invalid credential (caller treats the
 * request as logged-out) and throws only on genuine server errors.
 */

import type { Wallet } from "../domain/ids.ts";

export interface AuthedUser {
  userId: string; // provider identity (e.g. Privy user id)
  wallet: Wallet; // the player's Sui address — the in-app identity
}

export interface Auth {
  verify(token: string): Promise<AuthedUser | null>;
}
