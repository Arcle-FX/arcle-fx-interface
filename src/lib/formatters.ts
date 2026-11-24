// ============================================================
//  Formatting and input sanitisation utilities
// ============================================================

/** Parse a user-entered amount string into a number, or null if invalid. */
export function parseAmount(v: string): number | null {
  if (!v || v === '.' || v === '0.') return null;
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : null;
}

/** Strip non-numeric chars (keep digits + one decimal point). */
export function sanitizeAmount(v: string): string {
  let out = v.replace(/[^0-9.]/g, '');
  const idx = out.indexOf('.');
  if (idx !== -1) out = out.slice(0, idx + 1) + out.slice(idx + 1).replace(/\./g, '');
  return out;
}

/** Turn an unknown error into a short, user-friendly string — Uniswap / Aave style. */
export function sanitizeError(e: unknown): string {
  const raw = String((e as any)?.shortMessage ?? (e as any)?.message ?? e);

  // ── Circle SDK KitError (code-based) ─────────────────────────
  // Circle SDK classifies its thrown errors by code/type.
  // Match those before falling back to raw message parsing for more specific output.
  // Note: "Insufficient balance after fees" / "No Unified Balance" are thrown by executeUnifiedSpend
  // with proper context — let those pass through unchanged so the UI shows the right message.
  if (
    /Insufficient.*balance|balance.*insufficient/i.test(raw) &&
    !/after fees|unified balance|deposit.*tab|gateway|source chains|smaller amount/i.test(raw)
  )
    return 'Insufficient token balance on source network. Fund your wallet with USDC on the source chain.';
  if (/BALANCE_INSUFFICIENT|code.*9001|type.*BALANCE/i.test(raw))
    return 'Insufficient token balance. Please check your USDC balance on the source network.';
  if (/route.*could not be determined|CCTPXBridgingProvider|route check/i.test(raw))
    return 'Bridge route temporarily unavailable — try USDC or try again in a moment.';

  // ── Wallet / connection ──────────────────────────────────────
  if (/no provider selected|provider.*not.*found|no.*provider/i.test(raw))
    return 'Connect your wallet to continue';
  if (/Failed to switch.*chain|failed.*switch.*chain/i.test(raw))
    return 'Network switch failed — switch to the source network in your wallet and retry';
  if (/Bridge pending|Bridge error/i.test(raw))
    return 'Bridge submitted — CCTP relay in progress. Check the explorer for status.';
  if (/user (rejected|denied)|user cancel/i.test(raw))
    return 'Transaction rejected';
  if (/window.*closed|popup.*closed|user.*closed|request.*cancelled/i.test(raw))
    return 'Transaction rejected';
  if (/already pending/i.test(raw))
    return 'Open your wallet and confirm or reject the pending request';

  // ── Balance / funds ──────────────────────────────────────────
  if (/insufficient funds|insufficient balance/i.test(raw))
    return 'Insufficient balance';

  // ── Network ──────────────────────────────────────────────────
  if (/could not switch network|network switch (failed|rejected)/i.test(raw))
    return 'Could not switch network — please switch manually in your wallet and retry';
  if (/network.*changed|chain.*changed/i.test(raw))
    return 'Network changed — please try again';
  if (/nonce too low|replacement.*underpriced/i.test(raw))
    return 'Transaction conflict — wait a moment and try again';

  // ── Gas ──────────────────────────────────────────────────────
  if (/gas.*required.*exceeds/i.test(raw))
    return 'Not enough gas — try a smaller amount';
  if (/fee cap.*lower than.*base fee|maxFeePerGas.*lower|max fee per gas.*block base/i.test(raw))
    return 'Gas price too low — the network base fee rose. Please try again.';
  if (/underpriced|transaction.*underpriced/i.test(raw))
    return 'Transaction underpriced — network fees rose. Please try again.';

  // ── Swap-specific ────────────────────────────────────────────
  if (/Simulation failed.*reverted|Simulation failed.*revert/i.test(raw))
    return 'This swap cannot be completed — try a different amount';
  if (/Simulation failed/i.test(raw))
    return 'Transaction would fail on-chain — try adjusting the amount or token pair';
  if (/Route or resource not found|No route available/i.test(raw))
    return 'No route found — try a different amount (e.g. 3–8 EURC or 1–9 USDC for cirBTC)';
  if (/createSwap failed|Stablecoin Service/i.test(raw))
    return 'Swap unavailable right now — try again shortly';
  if (/unsupported.*route|unsupported.*swap|not supported on.*by SDK|INPUT_UNSUPPORTED_TOKEN/i.test(raw))
    return 'This token pair is not supported on the selected network';

  // ── Contract / execution ─────────────────────────────────────
  if (/execution reverted/i.test(raw))
    return 'Transaction would revert — try adjusting the amount';

  // ── Timeout ──────────────────────────────────────────────────
  if (/timeout|timed out/i.test(raw))
    return 'Request timed out — check your connection and try again';

  // ── Slippage ─────────────────────────────────────────────────
  if (/slippage|price impact/i.test(raw))
    return 'Price moved too much — increase slippage tolerance in settings';

  // Fallback: trim to 120 chars
  return raw.slice(0, 120);
}

/**
 * Validates that a URL is safe to use as an href.
 * Accepts only https:// URLs — blocks javascript:, data:, vbscript: and any other scheme.
 * Returns the URL unchanged if safe, '#' otherwise.
 */
export function safeTxLink(url: string | undefined | null): string {
  if (!url || url === '#') return '#';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? url : '#';
  } catch {
    return '#';
  }
}

/**
 * Format a token amount — Uniswap / Aave convention:
 *   ≥ 1,000     → thousands separator + 2 decimals   (7,393,823.21)
 *   ≥ 1         → 2–4 significant decimals            (91.46)
 *   ≥ 0.0001    → enough decimals to show first 4 sig digits (0.001468)
 *   < 0.0001    → "< 0.0001"
 */
export function formatTokenAmount(n: number): string {
  if (!isFinite(n) || n === 0) return '0';

  // ≥ 1,000 → use thousands separator, 2 decimals
  if (n >= 1_000) {
    return n.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  // ≥ 1 → 2 decimals
  if (n >= 1) {
    return parseFloat(n.toFixed(2)).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  // < 1 → show enough decimals for 4 significant digits (max 8)
  // This handles cirBTC (8 decimals) like 0.00000574 → "0.00000574"
  if (n < 0.0001) {
    const decimals = Math.min(Math.max(4, -Math.floor(Math.log10(n)) + 3), 8);
    return parseFloat(n.toFixed(decimals)).toString();
  }

  const decimals = Math.min(Math.max(2, -Math.floor(Math.log10(n)) + 3), 8);
  return parseFloat(n.toFixed(decimals)).toString();
}

/**
 * Format a USD value — Uniswap / Aave convention:
 *   ≥ 0.01  → "$1,234.56" with thousands separator
 *   < 0.01  → "< $0.01"
 */
export function formatUsdValue(n: number): string {
  if (!isFinite(n)) return '$—';
  if (n > 0 && n < 0.01) return '< $0.01';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
