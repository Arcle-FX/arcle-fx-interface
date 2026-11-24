// ============================================================
//  Application constants — networks, tokens, addresses
// ============================================================
import { BridgeChain, SwapChain } from '@circle-fin/app-kit';
import type { NetworkInfo, TokenInfo } from '../types';

// ── Official RPC Endpoints ───────────────────────────────────
// Primary official RPC for each supported mainnet network.
export const OFFICIAL_RPC = {
  Ethereum: 'https://ethereum.publicnode.com',  // Ethereum Foundation / PublicNode
  Arbitrum: 'https://arb1.arbitrum.io/rpc',     // Offchain Labs official
  Base:     'https://mainnet.base.org',          // Coinbase / Base official
  Arc:      'https://rpc.mainnet.arc.io',        // Arc Network official
} as const;

// ── Fallback RPC list (balance reads) ────────────────────────
// Endpoints are tried in order; the first successful response is used.
// Each attempt has a 5-second timeout.
export const FALLBACK_RPC: Record<string, readonly string[]> = {
  Ethereum: [
    'https://ethereum.publicnode.com',  // PublicNode official
    'https://cloudflare-eth.com',       // Cloudflare official
  ],
  Arbitrum: [
    'https://arb1.arbitrum.io/rpc',     // Offchain Labs official
  ],
  Base: [
    'https://mainnet.base.org',         // Coinbase official
  ],
  Arc: [
    'https://rpc.mainnet.arc.io',       // Arc official
  ],
};

// ── Networks ──────────────────────────────────────────────
// sdkSwap: non-null  → network supports swap as source (same-chain) and as
//                      source/destination for cross-chain swap via CCTP.
// sdkSwap: null      → bridge-only; swap not supported on this network.
//
// Root-cause fix: Ethereum, Arbitrum and Base previously had sdkSwap: null,
// which blocked them from being used in cross-chain swap (both as source and
// as destination). All four supported networks now carry their correct
// SwapChain enum value so the Circle SDK can route cross-chain swaps between
// any combination of Arc, Ethereum, Base and Arbitrum.
/** All supported networks with their SDK chain IDs, RPC URLs, and explorer links. */
export const NETWORKS: NetworkInfo[] = [
  {
    id:         'Arc',
    sdkBridge:  BridgeChain.Arc,
    sdkSwap:    SwapChain.Arc,       // same-chain swap source + cross-chain source/destination
    label:      'ARC Network',
    shortLabel: 'ARC',
    chainId:    5042,
    logo:       '/arc-logo.svg',
    rpc:        OFFICIAL_RPC.Arc,
    explorer:   'https://explorer.arc.io',
  },
  {
    id:         'Ethereum',
    sdkBridge:  BridgeChain.Ethereum,
    sdkSwap:    SwapChain.Ethereum,  // fixed: was null — cross-chain source/destination enabled
    label:      'Ethereum',
    shortLabel: 'ETH',
    chainId:    1,
    logo:       'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
    rpc:        OFFICIAL_RPC.Ethereum,
    explorer:   'https://etherscan.io',
  },
  {
    id:         'Base',
    sdkBridge:  BridgeChain.Base,
    sdkSwap:    SwapChain.Base,      // fixed: was null — cross-chain source/destination enabled
    label:      'Base',
    shortLabel: 'BASE',
    chainId:    8453,
    logo:       'https://assets.coingecko.com/asset_platforms/images/131/small/base.png',
    rpc:        OFFICIAL_RPC.Base,
    explorer:   'https://basescan.org',
  },
  {
    id:         'Arbitrum',
    sdkBridge:  BridgeChain.Arbitrum,
    sdkSwap:    SwapChain.Arbitrum,  // fixed: was null — cross-chain source/destination enabled
    label:      'Arbitrum',
    shortLabel: 'ARB',
    chainId:    42161,
    logo:       'https://assets.coingecko.com/coins/images/16547/small/photo_2023-03-29_21.47.00.jpeg',
    rpc:        OFFICIAL_RPC.Arbitrum,
    explorer:   'https://arbiscan.io',
  },
];

// ── Tokens ────────────────────────────────────────────────
/** Supported tokens with their display symbol and logo URL. */
export const TOKENS: TokenInfo[] = [
  { symbol: 'USDC',   logo: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png' },
  { symbol: 'EURC',   logo: 'https://assets.coingecko.com/coins/images/26045/small/euro-coin.png' },
  { symbol: 'cirBTC', logo: '/cirbtc.svg' },
];

// ── Token Addresses (mainnet) ──────────────────────────────
/** ERC-20 contract addresses for each token on each supported mainnet. Null means not deployed. */
export const TOKEN_ADDRESSES: Record<string, Record<string, string | null>> = {
  Arc: {
    USDC:   '0x3600000000000000000000000000000000000000',
    EURC:   '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
    cirBTC: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0',
  },
  Ethereum: {
    USDC:   '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    EURC:   '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c',
    cirBTC: '0x72DFB2E44f59C5AD2bAFE84314E5b99a7cd5075E',
  },
  Base: {
    USDC:   '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    EURC:   '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
    cirBTC: null,
  },
  Arbitrum: {
    USDC:   '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    EURC:   null,
    cirBTC: null,
  },
};

// ── ArcleFXCore Contract Addresses (Mainnet) ─────────────
export const ARCLEFX_CORE_ADDRESS: Record<string, string> = {
  Ethereum: '0x0C4618fC1cE49C0b4b4D3328799c1248d577c257',
  Arbitrum: '0x0C4618fC1cE49C0b4b4D3328799c1248d577c257',
  Base:     '0x6beD8B11b39Ed27d402De6728654B10CC25a39F5',
  Arc:      '0x0C4618fC1cE49C0b4b4D3328799c1248d577c257',
};

// ── TimelockController Addresses (Mainnet) ───────────────
export const TIMELOCK_ADDRESS: Record<string, string> = {
  Ethereum: '0xd6DaB151B1AdA4f84A9BC023F7e8430697c439E2',
  Arbitrum: '0xd6DaB151B1AdA4f84A9BC023F7e8430697c439E2',
  Base:     '0xE7041ecCC779a5c97b7652232aFc4CE1C91a79a1',
  Arc:      '0xd6DaB151B1AdA4f84A9BC023F7e8430697c439E2',
};

// ── Gnosis Safe Multisig Address ─────────────────────────
// Same address on all networks (CREATE2 deterministic deployment).
export const GNOSIS_SAFE_ADDRESS = '0x80de28827B6774bd4C9e04D15D72632A97C2f490';

// ── Explorer helper ───────────────────────────────────────
/** Returns the block explorer base URL for the given network ID, or '#' if not found. */
export function explorerFor(netId: string): string {
  return NETWORKS.find(n => n.id === netId)?.explorer ?? '#';
}

// ── wallet_addEthereumChain params per network ────────────
// Used as a fallback when wallet_switchEthereumChain fails with error 4902
// (chain not yet added to wallet). Chain IDs are expressed as hex strings
// to match the EIP-3085 spec.
export const ADD_CHAIN_PARAMS: Record<string, object> = {
  Arc: {
    chainId:           `0x${(5042).toString(16)}`,
    chainName:         'Arc Network',
    // Arc Network uses USDC as its native gas token with 18 decimals.
    nativeCurrency:    { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
    rpcUrls:           [OFFICIAL_RPC.Arc],
    blockExplorerUrls: ['https://explorer.arc.io'],
  },
  Ethereum: {
    chainId:           `0x${(1).toString(16)}`,
    chainName:         'Ethereum',
    nativeCurrency:    { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls:           [OFFICIAL_RPC.Ethereum],
    blockExplorerUrls: ['https://etherscan.io'],
  },
  Base: {
    chainId:           `0x${(8453).toString(16)}`,
    chainName:         'Base',
    nativeCurrency:    { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls:           [OFFICIAL_RPC.Base],
    blockExplorerUrls: ['https://basescan.org'],
  },
  Arbitrum: {
    chainId:           `0x${(42161).toString(16)}`,
    chainName:         'Arbitrum One',
    nativeCurrency:    { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls:           [OFFICIAL_RPC.Arbitrum],
    blockExplorerUrls: ['https://arbiscan.io'],
  },
};
