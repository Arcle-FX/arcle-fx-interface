// ============================================================
//  useGasFee — live gas price hook
// ============================================================

import { useState } from 'react';

interface GasInfo { gwei: string; usd: string; network: string }

// ── Internal helpers ─────────────────────────────────────────

/** Fetches the current ETH/USD price from Binance (CORS-enabled, no API key); returns 3200 on failure. */
async function fetchEthPriceUsd(): Promise<number> {
  try {
    const r = await fetch(
      'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT'
    );
    if (!r.ok) return 3200;
    const d = await r.json();
    const price = parseFloat(d?.price ?? '0');
    return price > 0 ? price : 3200;
  } catch {
    return 3200;
  }
}

/** Formats a Gwei value with adaptive decimal precision; no trailing zeros. */
function formatGwei(gwei: number): string {
  if (gwei < 0.001)  return `${gwei.toFixed(6)} Gwei`;
  if (gwei < 0.1)    return `${gwei.toFixed(4)} Gwei`;
  if (gwei < 1)      return `${gwei.toFixed(3)} Gwei`;
  if (gwei < 10)     return `${gwei.toFixed(2)} Gwei`;
  if (gwei < 1000)   return `${gwei.toFixed(1)} Gwei`;
  return `${gwei.toFixed(0)} Gwei`;
}

/** Formats a USD cost with a "~" prefix; shows "<$0.0001" for very small values. */
function formatUsd(usd: number, token = '$'): string {
  if (usd <= 0)       return `~${token}0`;
  if (usd < 0.0001)   return `<${token}0.0001`;
  if (usd < 0.001)    return `~${token}${usd.toFixed(5)}`;
  if (usd < 0.01)     return `~${token}${usd.toFixed(4)}`;
  if (usd < 1)        return `~${token}${usd.toFixed(3)}`;
  return `~${token}${usd.toFixed(2)}`;
}

// ── Hook ─────────────────────────────────────────────────────

/**
 * Fetches the current gas price for a given network.
 * Uses the network's own RPC endpoint when provided; falls back to
 * the connected wallet's current network otherwise.
 * On Arc Network, gas is denominated in USDC so ETH price is not needed.
 */
export function useGasFee() {
  const [gas, setGas] = useState<GasInfo>({ gwei: '—', usd: 'fetching…', network: '' });

  async function fetchGasFee(networkLabel: string, rpcUrl?: string) {
    setGas({ gwei: '…', usd: '…', network: networkLabel });
    try {
      let gweiRaw: number;

      if (rpcUrl) {
        // Always prefer the network's own RPC — accurate for the selected chain
        const r = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_gasPrice', params: [], id: 1 }),
        });
        if (!r.ok) throw new Error('rpc error');
        const d = await r.json();
        if (typeof d?.result !== 'string') throw new Error('bad result');
        gweiRaw = parseInt(d.result, 16) / 1e9;
      } else {
        // Fallback: use the current network of the connected wallet.
        const provider = window.ethereum ?? null;
        if (!provider) throw new Error('no provider');
        const hex = await provider.request({ method: 'eth_gasPrice' }) as string;
        if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error('bad hex');
        gweiRaw = parseInt(hex, 16) / 1e9;
      }

      if (!isFinite(gweiRaw) || gweiRaw < 0) throw new Error('invalid gwei');

      // Arc Network: gas is paid in USDC (1 USDC ≈ $1) — no ETH price needed
      const isArc = /arc/i.test(networkLabel);
      let usdDisplay: string;

      if (isArc) {
        const usdc = gweiRaw * 21000 * 1e-9;
        usdDisplay = formatUsd(usdc, '') + ' USDC';
      } else {
        const ethPrice = await fetchEthPriceUsd();
        usdDisplay = formatUsd(gweiRaw * 21000 * 1e-9 * ethPrice);
      }

      setGas({
        gwei:    formatGwei(gweiRaw),
        usd:     usdDisplay,
        network: networkLabel,
      });
    } catch {
      setGas({ gwei: '—', usd: '—', network: networkLabel });
    }
  }

  return { gas, fetchGasFee };
}
