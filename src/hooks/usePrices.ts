// ============================================================
//  usePrices — live USD price feed
// ============================================================
//
//  Sources tried in order (first success wins):
//
//  1. Binance REST API — natively CORS-enabled, no proxy needed.
//     Returns BTC/USDT and EUR/USDT (EUR ≈ EURC peg).
//     Endpoint: api.binance.com/api/v3/ticker/price
//
//  2. CoinCap — fully CORS-enabled, no proxy needed.
//     Endpoint: api.coincap.io/v2/assets/bitcoin
//
//  3. Hardcoded fallback — reasonable prices so the UI never blocks.
//     BTC ≈ $81 000  |  EURC ≈ $1.09  |  USDC = $1.00
//
//  Why we removed CORS proxies (corsproxy.io / allorigins.win / thingproxy):
//  Those services have recurring ERR_CERT_AUTHORITY_INVALID failures in
//  environments with SSL inspection / corporate firewalls.
//  Using direct CORS-enabled APIs avoids the problem entirely.
//
// ============================================================

import { useState, useEffect, useRef } from 'react';
import type { Prices } from '../types';

const POLL_INTERVAL = 60_000;  // 60 s normal polling
const RETRY_DELAY   = 15_000;  // 15 s retry on failure

// ── Source 1: Binance batch ticker (CORS-enabled, no API key) ─
const BINANCE_URL =
  'https://api.binance.com/api/v3/ticker/price?symbols=%5B%22BTCUSDT%22,%22EURUSDT%22%5D';

async function fetchFromBinance(): Promise<{ btc: number; eurc: number } | null> {
  const r = await fetch(BINANCE_URL);
  if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
  const arr: { symbol: string; price: string }[] = await r.json();
  const btc  = parseFloat(arr.find(x => x.symbol === 'BTCUSDT')?.price  ?? '0');
  const eurc = parseFloat(arr.find(x => x.symbol === 'EURUSDT')?.price  ?? '0');
  if (btc > 0) return { btc, eurc: eurc || 1.09 };
  return null;
}

// ── Source 2: CoinCap (CORS-enabled, no API key) ──────────────
const COINCAP_BTC_URL  = 'https://api.coincap.io/v2/assets/bitcoin';

async function fetchFromCoinCap(): Promise<{ btc: number; eurc: number } | null> {
  const r = await fetch(COINCAP_BTC_URL);
  if (!r.ok) throw new Error(`CoinCap HTTP ${r.status}`);
  const d = await r.json();
  const btc = parseFloat(d?.data?.priceUsd ?? '0');
  if (btc > 0) return { btc, eurc: 1.09 }; // EURC not in CoinCap — use peg
  return null;
}

/**
 * Fetches live USD prices for EURC and cirBTC.
 * USDC is pegged at $1.00.
 * `ready` turns true after the first successful fetch (or immediate fallback).
 */
export function usePrices(): Prices {
  const [prices, setPrices] = useState<Prices>({
    USDC: 1.00, EURC: 0, cirBTC: 0, ready: false,
  });

  const retryCount = useRef(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    async function fetchPrices() {
      // Try each source in order
      const sources = [fetchFromBinance, fetchFromCoinCap];

      for (const source of sources) {
        try {
          const result = await source();
          if (cancelled) return;

          if (result && result.btc > 0) {
            setPrices({
              USDC:   1.00,
              cirBTC: result.btc,
              EURC:   result.eurc || 1.09,
              ready:  true,
            });
            retryCount.current = 0;
            if (!cancelled) timer = setTimeout(fetchPrices, POLL_INTERVAL);
            return; // success
          }
        } catch (_err) {
          // Continue to next source
        }
      }

      // All sources failed — use hardcoded fallback so UI is never blocked
      if (!cancelled) {
        setPrices(prev => ({
          USDC:   1.00,
          cirBTC: prev.cirBTC || 81000,
          EURC:   prev.EURC   || 1.09,
          ready:  true,
        }));
        // Exponential backoff: 15 s, 30 s, 60 s … max 120 s
        retryCount.current = Math.min(retryCount.current + 1, 3);
        const delay = RETRY_DELAY * Math.pow(2, retryCount.current - 1);
        timer = setTimeout(fetchPrices, delay);
      }
    }

    fetchPrices();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  return prices;
}
