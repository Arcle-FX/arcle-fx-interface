// ============================================================
//  wagmi configuration — chains, connectors, transports
// ============================================================

import { createConfig, http } from 'wagmi';
import { mainnet, arbitrum, base } from 'wagmi/chains';
import { injected, walletConnect, coinbaseWallet } from 'wagmi/connectors';
import { defineChain } from 'viem';
import { OFFICIAL_RPC } from './constants';

// ── Arc Mainnet chain definition ─────────────────────────────
/** Arc Mainnet (chain ID 5042) — native gas currency is USDC (18 decimals). */
export const arcMainnet = defineChain({
  id:   5042,
  name: 'Arc Network',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: [OFFICIAL_RPC.Arc] },
  },
  blockExplorers: {
    default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' },
  },
  testnet: false,
});

// ── Connectors ───────────────────────────────────────────────
// WalletConnect project ID — get a free one at cloud.walletconnect.com
const wcProjectId = import.meta.env.VITE_WC_PROJECT_ID as string | undefined;

const connectors = [
  // EIP-6963: target MetaMask specifically so Coinbase Wallet cannot override it
  injected({ target: 'metaMask' }),
  // Generic injected connector — fallback for Brave Wallet, Frame, and other EIP-1193 providers
  injected(),
  coinbaseWallet({ appName: 'Arcle FX' }),

  // WalletConnect v2 — only registered if project ID is provided
  ...(wcProjectId
    ? [walletConnect({ projectId: wcProjectId, showQrModal: true })]
    : []),
];

// ── wagmi config ─────────────────────────────────────────────
/** Shared wagmi config used by WagmiProvider in main.tsx. */
export const wagmiConfig = createConfig({
  chains:     [mainnet, arbitrum, base, arcMainnet],
  connectors,
  transports: {
    // Official RPC endpoints — sourced from OFFICIAL_RPC constants.
    [mainnet.id]:       http(OFFICIAL_RPC.Ethereum),
    [arbitrum.id]:      http(OFFICIAL_RPC.Arbitrum),
    [base.id]:          http(OFFICIAL_RPC.Base),
    [arcMainnet.id]:    http(OFFICIAL_RPC.Arc),
  },
});
