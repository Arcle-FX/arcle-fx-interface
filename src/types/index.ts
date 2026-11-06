// ============================================================
//  Shared TypeScript types used across the application
// ============================================================

// ── Union types ──────────────────────────────────────────────

export type TabType     = 'bridge' | 'swap' | 'unified';
export type ModalType   = 'wallet' | 'network' | 'token' | 'gas' | 'settings' | 'success' | 'error';
export type TargetType  = 'from' | 'to' | 'swap-net' | 'from-swap' | 'to-swap';

// ── Gasless / Circle Paymaster ───────────────────────────────

/** UI state for the Circle Paymaster gasless wallet option. */
export interface GaslessState {
  active:       boolean;
  smartAddress: string | null;  // ERC-4337 Smart Account address
  chainName:    string | null;  // e.g. "Arbitrum One"
  loading:      boolean;
  error:        string | null;
}

// ── Transaction progress ─────────────────────────────────────

export type StepStatus = 'pending' | 'active' | 'done' | 'error';

/** A single step shown in the TxProgressModal step list. */
export interface TxStep {
  label:  string;
  status: StepStatus;
}

/** Full state for the transaction progress overlay modal. */
export interface TxProgress {
  isOpen:    boolean;
  type:      'bridge' | 'swap' | 'send' | 'unified' | 'cross-chain';
  status:    'waiting' | 'processing' | 'success' | 'error';
  steps:     TxStep[];
  fromLabel: string;   // e.g. "2.48 USDC"
  toLabel:   string;   // e.g. "2.47 USDC"
  fromLogo:  string;
  toLogo:    string;
  txLink:    string;
  errorMsg:  string;
}

// ── Network & token info ─────────────────────────────────────

/** Static metadata for a supported network. */
export interface NetworkInfo {
  id:         string;
  label:      string;
  shortLabel: string;          // compact display name (e.g. "Ethereum", "ARC")
  chainId:    number;
  logo:       string | null;   // null = Arc gradient "A" fallback div
  rpc:        string;
  explorer:   string;
  sdkBridge:  string;          // BridgeChain enum value for Circle SDK
  sdkSwap:    string | null;   // SwapChain enum value — null if swap not supported
}

/** Static metadata for a supported token. */
export interface TokenInfo {
  symbol: string;
  logo:   string;
}

/** Selected network + token pair stored in app state. */
export interface NetworkToken {
  network: string;
  netId:   string;
  netLogo: string | null;
  token:   string;
  tokLogo: string;
}

// ── Unified Balance ──────────────────────────────────────────

/** Balance of a single chain within the unified balance view. */
export interface UnifiedChainBalance {
  netId:          string;
  label:          string;
  logo:           string | null;
  balance:        string;            // confirmed spendable balance
  pendingBalance?: string;           // in-flight deposit (not yet spendable)
}

/** Aggregated unified balance across all chains. */
export interface UnifiedBalance {
  chains:        UnifiedChainBalance[];
  total:         string;             // confirmed spendable total
  pendingTotal?: string;             // sum of all pending deposits
}

// ── Prices ───────────────────────────────────────────────────

/** Live USD prices fetched from CoinGecko. */
export interface Prices {
  USDC:   number;
  EURC:   number;
  cirBTC: number;
  ready:  boolean;
}

/** Token-only price keys (excludes the `ready` flag). */
export type PriceToken = 'USDC' | 'EURC' | 'cirBTC';
