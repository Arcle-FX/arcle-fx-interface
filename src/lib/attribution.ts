// ============================================================
//  Base Builder Code — ERC-8021 attribution suffix
//
//  Base Builder Codes attribute onchain activity (transactions sent
//  through this app on Base) back to this project, enabling analytics
//  and potential rewards from Base.
//
//  Builder Code registered at: https://dashboard.base.org
//  Only Base (chain ID 8453) transactions carry this suffix.
//  Other networks (Arc, Ethereum, Arbitrum) are unaffected.
// ============================================================

import { Attribution } from 'ox/erc8021';

/**
 * ERC-8021 data suffix for Base Builder Code attribution.
 *
 * Append this to `dataSuffix` on every Base transaction call
 * (writeContract / sendTransaction / sendCalls).
 *
 * Smart contracts ignore the extra bytes completely — zero impact
 * on execution. The suffix is read only by Base's offchain indexer.
 */
export const BASE_BUILDER_SUFFIX = Attribution.toDataSuffix({
  codes: ['bc_sul4tnlx'],
});
