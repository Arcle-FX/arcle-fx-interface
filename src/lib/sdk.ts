// ============================================================
//                   Circle App Kit SDK
// ============================================================
// TypeScript wrapper — migrated from sdk.js
// ============================================================

/// <reference types="vite/client" />

import { AppKit } from '@circle-fin/app-kit';
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2';
import { createPublicClient, http, formatUnits, custom, encodeFunctionData, parseUnits } from 'viem';
import { arbitrum, base, mainnet } from 'viem/chains';
import { NETWORKS, TOKEN_ADDRESSES, ADD_CHAIN_PARAMS, OFFICIAL_RPC, FALLBACK_RPC } from '../config/constants';
import { clearSmartAccountClient } from './gasless';
import { BASE_BUILDER_SUFFIX } from './attribution';
import type { UnifiedBalance } from '../types';

// ── Validation ──────────────────────────────────────────────
const VALID_NETWORK_IDS = new Set(NETWORKS.map(n => n.id));
const MAX_FEE_BPS = 1000;

/** Returns true if `addr` is a valid EVM address (0x + 40 hex chars). */
export function isValidAddress(addr: unknown): addr is `0x${string}` {
  return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

// ── Resolve MetaMask provider (EIP-6963) ────────────────────
// When multiple wallets are installed (MetaMask + Coinbase), iterate the
// window.ethereum.providers[] array to unambiguously select MetaMask.
function getMetaMaskProvider(): any {
  const eth = (window as any).ethereum;
  if (!eth) return null;
  // EIP-6963 multi-provider array — prefer MetaMask, exclude Coinbase Wallet
  if (Array.isArray(eth.providers)) {
    return eth.providers.find((p: any) => p.isMetaMask && !p.isCoinbaseWallet) ?? eth;
  }
  return eth;
}

// ── Intercept wrapper: chain-switch + gas-buffer ─────────────
//
// This wrapper solves three separate problems:
//
// 1) wallet_switchEthereumChain → pre-register with wallet_addEthereumChain
//    The Circle SDK errors when switching to an unknown chain.
//    The wrapper registers the chain first (no-op if already added), then switches.
//
// 2) eth_feeHistory / eth_gasPrice → boost at source (extra safety margin)
//    Fixes stale baseFee values in viem's fee estimation for legacy code paths.
//
// 3) eth_sendTransaction → universal EIP-1559 gas protection               ← MAIN FIX
//
//    ROOT CAUSE (confirmed via viem source + mainnet analysis):
//    Circle SDK walletClient.sendTransaction → JSON-RPC account path → viem
//    skips prepareTransactionRequest; no fee estimation is performed. MetaMask
//    computes its own baseFee × 1.0–1.2 buffer. Arbitrum baseFee oscillates
//    ±1-2% per second. The time gap between Approve confirmation (~3-5 s) and
//    the Burn TX submission causes MetaMask's maxFeePerGas to go stale,
//    dropping below the current block baseFee →
//    node rejects: "max fee per gas less than block base fee".
//
//    Why Base works: Base Mainnet baseFee stays near-constant (OP Stack
//    predictive EIP-1559). Arbitrum oscillates ±2% per fast block.
//
//    Fix: for eth_sendTransaction on any chain in _CHAIN_RPC_MAP, fetch a FRESH
//    baseFee directly from the chain's RPC, then inject baseFee × 2 + 2 gwei
//    priority into the transaction. Never touch other chains.
//
// JavaScript Proxy is used instead of spread { ...provider } because MetaMask /
// Coinbase providers are Proxy/class instances whose non-enumerable properties
// cannot be copied with Object spread.

// Chain IDs — hex and decimal (used by gas protection logic)
const _ARB_CHAIN_ID         = 42161;
const _ARB_CHAIN_ID_HEX     = `0x${_ARB_CHAIN_ID.toString(16)}`;     // '0xa4b1'
const _ETH_CHAIN_ID         = 1;
const _ETH_CHAIN_ID_HEX     = `0x${_ETH_CHAIN_ID.toString(16)}`;     // '0x1'
const _ARC_CHAIN_ID         = 5042;
const _ARC_CHAIN_ID_HEX     = `0x${_ARC_CHAIN_ID.toString(16)}`;     // '0x13b2'

// RPC URL map — chain ID → RPC endpoint (used for fresh baseFee reads).
// Single source of truth: pulled from OFFICIAL_RPC constants.
const _CHAIN_RPC_MAP: Record<number, string> = {
  [_ARB_CHAIN_ID]: OFFICIAL_RPC.Arbitrum,  // https://arb1.arbitrum.io/rpc
  [_ETH_CHAIN_ID]: OFFICIAL_RPC.Ethereum,  // https://ethereum.publicnode.com
  [_ARC_CHAIN_ID]: OFFICIAL_RPC.Arc,       // https://rpc.mainnet.arc.io
  8453:            OFFICIAL_RPC.Base,       // https://mainnet.base.org
};

function wrapProviderWithAutoAdd(provider: any): any {
  if (!provider?.request) return provider;

  // Bind original request — preserve this context
  const originalRequest = provider.request.bind(provider);

  // ── Helper: fetch a FRESH baseFeePerGas for the given chain ────────────────
  // Bypasses the wallet provider cache — always reads directly from the node.
  // chainId: numeric chain ID (e.g. 42161, 1, 5042)
  async function fetchFreshBaseFee(chainId: number): Promise<bigint | null> {
    const rpcUrl = _CHAIN_RPC_MAP[chainId];
    const endpoints: string[] = rpcUrl ? [rpcUrl] : [];

    for (const url of endpoints) {
      try {
        const resp = await fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method:  'eth_getBlockByNumber',
            params:  ['latest', false],
          }),
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        if (data?.result?.baseFeePerGas) return BigInt(data.result.baseFeePerGas);
      } catch { /* try next endpoint */ }
    }
    return null;
  }

  // ── Helper: get the active MetaMask chain ID ───────────────────────────────
  // Direct eth_chainId call — bypasses any cached value.
  let _cachedChainId: string | null = null;
  let _chainIdExpiry = 0;
  async function getActiveChainId(): Promise<string> {
    const now = Date.now();
    if (_cachedChainId && now < _chainIdExpiry) return _cachedChainId;
    try {
      _cachedChainId = await originalRequest({ method: 'eth_chainId' });
      _chainIdExpiry = now + 5_000; // cache for 5 seconds
    } catch { _cachedChainId = '0x0'; }
    return _cachedChainId!;
  }

  const wrappedRequest = async (args: { method: string; params?: any[] }) => {

    // ── 1) wallet_switchEthereumChain intercept ────────────────
    if (args.method === 'wallet_switchEthereumChain' && Array.isArray(args.params)) {
      const switchParam = args.params[0] as { chainId: string };
      const targetChainId = parseInt(switchParam?.chainId ?? '0', 16);

      const addParams = Object.values(ADD_CHAIN_PARAMS).find((p: any) =>
        parseInt((p as any).chainId ?? '0', 16) === targetChainId
      );
      if (addParams) {
        try {
          await originalRequest({ method: 'wallet_addEthereumChain', params: [addParams] });
        } catch { /* chain already registered */ }
      }

      try {
        return await originalRequest(args);
      } catch (switchErr: any) {
        const errMsg = String(switchErr?.message ?? switchErr ?? '');
        const isUnrecognized = /unrecognized chain|try adding.*chain|unknown chain/i.test(errMsg);
        if (isUnrecognized && addParams) {
          try { await originalRequest({ method: 'wallet_addEthereumChain', params: [addParams] }); } catch { /* ignore */ }
          return await originalRequest(args);
        }
        throw switchErr;
      }
    }

    // ── 2) eth_feeHistory → boost baseFeePerGas values ──────────
    // Corrects viem's maxFeePerGas estimate — intervenes at the source of the problem.
    if (args.method === 'eth_feeHistory') {
      try {
        const result: any = await originalRequest(args);
        if (result?.baseFeePerGas && Array.isArray(result.baseFeePerGas)) {
          // Boost each baseFee value by 150% (×2.5) — ensures maxFeePerGas stays
          // above baseFee even on fast-moving chains like Arbitrum.
          // Actual cost is always baseFee + priorityFee; 2.5× is safe.
          result.baseFeePerGas = result.baseFeePerGas.map((fee: string) => {
            try {
              const boosted = (BigInt(fee) * 5n) / 2n; // × 2.5
              return `0x${boosted.toString(16)}`;
            } catch { return fee; }
          });
        }
        return result;
      } catch { /* fallback: return original response */ }
    }

    // ── 3) eth_gasPrice → boost legacy gas price ────────────────
    // Prevents the same stale-fee problem on type-0 (legacy) transactions.
    if (args.method === 'eth_gasPrice') {
      try {
        const price: string = await originalRequest(args);
        const boosted = (BigInt(price) * 5n) / 2n; // × 2.5
        return `0x${boosted.toString(16)}`;
      } catch { /* fallback: return original response */ }
    }

    // ── 4) eth_sendTransaction → universal gas protection (all supported chains) ───────
    //
    // SCOPE: Arbitrum One, Ethereum Mainnet, Arc — activates for every
    // chain registered in _CHAIN_RPC_MAP. Base has a stable baseFee
    // (OP-Stack predictive EIP-1559) so the boosted eth_feeHistory is sufficient,
    // but it will also benefit automatically if added to _CHAIN_RPC_MAP.
    //
    // WHY NEEDED:
    //  • The Circle SDK JSON-RPC account path skips viem's prepareTransactionRequest.
    //  • MetaMask applies a baseFee × 1.0–1.2 buffer; on Arbitrum / Ethereum / Arc
    //    the baseFee can rise enough during the Approve confirmation delay (~3-10 s)
    //    that the Burn TX's maxFeePerGas falls below the current block baseFee.
    //  • Arc source is especially sensitive: the CCTPv2 Burn TX is sent
    //    as an EIP-1559 type-2 transaction under Arc's USDC-native gas model.
    //
    // WHAT IT DOES:
    //  a) Read the active chain ID and look it up in _CHAIN_RPC_MAP.
    //  b) Fetch a FRESH baseFeePerGas from that chain's RPC (bypasses MetaMask cache).
    //  c) Set maxFeePerGas = baseFee × 2 + priorityFee (safe buffer).
    //  d) Keep the existing value if it is already higher (never lower the fee).
    if (args.method === 'eth_sendTransaction' && Array.isArray(args.params) && args.params[0]) {
      try {
        const activeChainId = await getActiveChainId();
        const activeChainIdNum = parseInt(activeChainId, 16);

        // Only apply boost on chains registered in the RPC map
        const hasRpc = activeChainIdNum in _CHAIN_RPC_MAP;

        if (hasRpc) {
          const tx = args.params[0] as Record<string, string | undefined>;
          // Skip legacy (type 0x0) transactions — EIP-1559 only
          if (tx.type !== '0x0') {
            const freshBaseFee = await fetchFreshBaseFee(activeChainIdNum);
            if (freshBaseFee !== null) {
              // Arc: USDC-native gas, low but volatile baseFee
              // Arbitrum: ±1-2% per second — 2× baseFee provides a reliable buffer
              // Ethereum Mainnet: 12 s block time, slower drift but still safe
              const PRIORITY_FEE = 2_000_000_000n; // 2 gwei — sufficient for all supported chains
              const safeMaxFee = freshBaseFee * 2n + PRIORITY_FEE; // 2× baseFee + 2 gwei buffer

              // Preserve the existing maxFeePerGas if it is already higher
              const existingMaxFee = tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : 0n;
              const finalMaxFee = safeMaxFee > existingMaxFee ? safeMaxFee : existingMaxFee;

              // Preserve the existing priority fee if it is already higher
              const existingPriority = tx.maxPriorityFeePerGas
                ? BigInt(tx.maxPriorityFeePerGas) : 0n;
              const finalPriority = existingPriority > PRIORITY_FEE
                ? existingPriority : PRIORITY_FEE;

              // Base Builder Code (ERC-8021): append attribution suffix to Base txs.
              // Contracts ignore the extra bytes; Base's offchain indexer reads it.
              const builderData = activeChainIdNum === 8453
                ? ((tx.data ?? '0x') + BASE_BUILDER_SUFFIX.slice(2)) as `0x${string}`
                : tx.data;

              const patchedTx: Record<string, string | undefined> = {
                ...tx,
                maxFeePerGas:         `0x${finalMaxFee.toString(16)}`,
                maxPriorityFeePerGas: `0x${finalPriority.toString(16)}`,
                ...(builderData !== undefined ? { data: builderData } : {}),
              };
              return originalRequest({ ...args, params: [patchedTx, ...args.params.slice(1)] });
            }
          }
        }
      } catch { /* best-effort — fall through to original tx on any error */ }
    }

    // Forward all other requests through the original bound provider
    return originalRequest(args);
  };

  // Proxy: delegate every property access to the original provider;
  // intercept only the 'request' property.
  return new Proxy(provider, {
    get(target: any, prop: string | symbol) {
      if (prop === 'request') return wrappedRequest;
      const val = target[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
}

let _kit: AppKit | null = null;

/** Destroys the current AppKit instance so the next getKit() call creates a fresh one.
 *  Used before spend() to avoid Circle SDK's internal balance cache causing
 *  BALANCE_INSUFFICIENT_TOKEN on consecutive transfers.
 */
export function resetKit(): void {
  _kit = null;
}
/**
 * Returns the App Kit singleton, creating it on first call.
 * Applies custom fee policies for bridge, swap, and unified balance
 * operations when a contract address is set in the environment.
 */
export function getKit(): AppKit {
  if (_kit) return _kit;

  const contractAddr = import.meta.env.VITE_CONTRACT_ADDRESS ?? '';
  const bridgeFeeBps = Math.min(Math.max(0, Number(import.meta.env.VITE_BRIDGE_FEE_BPS  ?? 5)),  MAX_FEE_BPS);
  const swapFeeBps   = Math.min(Math.max(0, Number(import.meta.env.VITE_SWAP_FEE_BPS    ?? 30)), MAX_FEE_BPS);
  const ubFeeBps     = Math.min(Math.max(0, Number(import.meta.env.VITE_UNIFIED_BALANCE_FEE_BPS ?? 10)), MAX_FEE_BPS);

  // NOTE: apiKey / kitKey are SERVER-ONLY secrets in the Circle SDK.
  // Passing them in a browser context throws a validation error:
  //   "apiKey must not be provided in a browser environment"
  // The bridge uses the permissionless (keyless) IRIS path in the browser,
  // which works for all CCTPv2 routes (Ethereum, Base,
  // Arbitrum, Arc) without any credential.
  _kit = new AppKit();

  if (isValidAddress(contractAddr)) {
    // Per-network contract addresses — each chain has its own deployed contract.
    // Falls back to the global VITE_CONTRACT_ADDRESS if a specific one is not set.
    const contractByNetwork: Record<string, string> = {
      Ethereum: import.meta.env.VITE_CONTRACT_ADDRESS_ETH  || contractAddr,
      Arbitrum: import.meta.env.VITE_CONTRACT_ADDRESS_ARB  || contractAddr,
      Base:     import.meta.env.VITE_CONTRACT_ADDRESS_BASE || contractAddr,
      Arc:      import.meta.env.VITE_CONTRACT_ADDRESS_ARC  || contractAddr,
    };

    // Helper: resolve the right contract address for the source chain.
    //
    // SDK calls each callback with DIFFERENT argument shapes:
    //
    //   computeFee(humanReadableParams)
    //     → humanReadableParams = { source: { chain: { chain: 'Arc', ... } }, amount: '...', ... }
    //     → chain ID lives at:  params?.source?.chain?.chain
    //
    //   resolveFeeRecipientAddress(sourceChainObj, providerParams)
    //     → 1st arg is the chain definition object directly: { chain: 'Arc', ... }
    //     → chain ID lives at: params?.chain  (params IS the chain object here)
    //
    //   swap / unifiedBalance contexts may still carry params.from.chain or params.chain.
    //
    // We try all known paths so that one helper covers all three fee policies.
    const resolveContractAddr = (params: any): string => {
      const chainId: string | null =
        params?.source?.chain?.chain ??  // computeFee: humanReadableParams.source.chain.chain
        params?.chain ??                  // resolveFeeRecipientAddress: 1st arg IS the chain obj, .chain = string
        params?.from?.chain?.chain ??    // legacy / swap path
        null;
      if (chainId && contractByNetwork[chainId]) return contractByNetwork[chainId];
      // Fallback: return global contract
      return contractAddr;
    };

    // ── CRITICAL: minimum fee floor ────────────────────────────────────────────
    // Circle SDK adapter validates: if feeRecipient is set, protocolFee MUST be > 0.
    // (adapter-viem-v2: validateProtocolFeeParams throws when feeRecipient ≠ undefined
    //  but protocolFee === 0n).
    //
    // Problem: computeFee('0.001 USDC') → fee = 0.0000005 → toFixed(6) = '0.000000'
    //   SDK then does: if ('0.000000') → BigInt('0') = 0n → feeRecipient set + 0 fee → THROWS.
    //
    // Fix: enforce a minimum of 1 micro-USDC (0.000001) so protocolFee is never 0n
    // when feeRecipient is attached. The user effectively pays 0.0001¢ minimum —
    // this is imperceptible but satisfies the SDK contract invariant.
    const MIN_FEE = '0.000001'; // 1 micro-USDC = 1 unit in smallest units

    const safeComputeFee = (rawFee: number): string => {
      if (!isFinite(rawFee) || rawFee < 0) return MIN_FEE;
      // toFixed(6) can produce '0.000000' for very small amounts → enforce minimum
      const result = rawFee.toFixed(6);
      return result === '0.000000' ? MIN_FEE : result;
    };

    // Single typed call covers bridge, swap, and unifiedBalance fee policies.
    // computeFee always receives human-readable amounts and returns a
    // human-readable fee string (always ≥ MIN_FEE to satisfy SDK invariant).
    _kit.setCustomFeePolicy({
      bridge: {
        // params.amount is human-readable (e.g. "100.00" for 100 USDC)
        computeFee: (params: any) => {
          const fee = parseFloat(params.amount) * bridgeFeeBps / 10_000;
          return safeComputeFee(fee);
        },
        resolveFeeRecipientAddress: (params: any) => resolveContractAddr(params),
      },
      swap: {
        // ctx is SwapFeeContext — discriminated by ctx.type ('input'|'output')
        // ctx.amountIn is human-readable for input-type fee context
        computeFee: (ctx: any) => {
          const amt = ctx.type === 'output'
            ? (parseFloat(ctx.estimatedAmount ?? ctx.amountIn ?? '0'))
            : (parseFloat(ctx.amountIn ?? '0'));
          const fee = amt * swapFeeBps / 10_000;
          return safeComputeFee(fee);
        },
        resolveFeeRecipientAddress: (params: any) => resolveContractAddr(params),
      },
      // unifiedBalance: NOT configured here.
      // Official docs (docs.arc.io/app-kit/tutorials/unified-balance/collect-custom-spend-fees)
      // show that the correct pattern for Unified Balance fees is config.customFee per-spend,
      // not setCustomFeePolicy. Per-spend is used in executeUnifiedSpend below.
    } as any);
  }

  return _kit;
}

// ── Reliable public client factory ─────────────────────────────────────────
// The Circle SDK's default publicClient uses `retryCount: 0` (no retry).
// Also: fee estimation (eth_feeHistory / eth_gasPrice) on Arbitrum returns
// low values that are sometimes BELOW the block baseFee by the time the
// signed transaction reaches the node — causing:
//   "max fee per gas less than block base fee: maxFeePerGas X baseFee Y"
//
// Root cause: viem calls eth_feeHistory on the publicClient (not the wallet
// provider). Our wrapProviderWithAutoAdd proxy only covers the wallet provider
// (MetaMask), so the publicClient's fee history is NOT boosted.
//
// Fix: wrap the Alchemy/RPC HTTP fetch in a thin interceptor that
//   • Boosts every baseFeePerGas in eth_feeHistory responses by 2.5×
//   • Boosts eth_gasPrice responses by 2.5×
// This guarantees viem always sets maxFeePerGas well above the real baseFee.

const _publicClientCache = new Map<number, ReturnType<typeof createPublicClient>>();

/** Build an EIP-1193-compatible provider that fetches via fetch() and boosts gas fees. */
function makeBoostedProvider(rpcUrl: string) {
  let _reqId = 0;
  return {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      const id = ++_reqId;
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? [] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${rpcUrl}`);
      const data = await res.json() as { result?: unknown; error?: { message: string } };
      if (data.error) throw new Error(data.error.message);

      // ── Boost eth_feeHistory baseFees by 2.5× ──
      if (method === 'eth_feeHistory' && data.result && typeof data.result === 'object') {
        const fh = data.result as { baseFeePerGas?: string[] };
        if (Array.isArray(fh.baseFeePerGas)) {
          fh.baseFeePerGas = fh.baseFeePerGas.map(f => {
            try { return `0x${((BigInt(f) * 5n) / 2n).toString(16)}`; } catch { return f; }
          });
        }
      }

      // ── Boost eth_gasPrice by 2.5× ──
      if (method === 'eth_gasPrice' && typeof data.result === 'string') {
        try { data.result = `0x${((BigInt(data.result) * 5n) / 2n).toString(16)}`; } catch { /* keep */ }
      }

      return data.result;
    },
  };
}

// Known viem chain objects — used when constructing a publicClient so that
// RPC calls include the correct chain context (nonce, receipts, etc.).
const VIEM_CHAIN_MAP: Record<number, any> = {
  [mainnet.id]:  mainnet,
  [base.id]:     base,
  [arbitrum.id]: arbitrum,
};

function getReliablePublicClient({ chain }: { chain: { id: number } }): any {
  const cached = _publicClientCache.get(chain.id);
  if (cached) return cached;

  const net = NETWORKS.find(n => n.chainId === chain.id);
  const rpcUrl = net?.rpc ?? '';

  // Use a boosted custom transport so fee estimates are always safe
  const transport = rpcUrl
    ? custom(makeBoostedProvider(rpcUrl), { retryCount: 3 })
    : http(undefined, { retryCount: 3, retryDelay: 500 });

  // Pass the viem chain object so createPublicClient knows the correct chainId.
  // Without this, readContract / waitForTransactionReceipt can target wrong chain.
  const viemChain = VIEM_CHAIN_MAP[chain.id];
  const client = createPublicClient({ chain: viemChain, transport }) as any;
  _publicClientCache.set(chain.id, client);
  return client;
}


let _adapter: Awaited<ReturnType<typeof createViemAdapterFromProvider>> | null = null;
// Raw EOA adapter — set once on wallet connect, never overwritten by connectGasless.
// Used by executeSwap / estimateSwap so permit signing always goes through the EOA,
// not the Smart Account (SA address is unknown to MetaMask → "not authorized" error).
let _rawAdapter: Awaited<ReturnType<typeof createViemAdapterFromProvider>> | null = null;
let _account: string | null = null;
// Track whether the active wallet is Coinbase Wallet.
// Coinbase opens a popup tab per step — batchTransactions must be disabled.
let _isCoinbaseWallet = false;
// Raw EIP-1193 provider for the active wallet — used by ensureOnChain so that
// wallet_addEthereumChain / wallet_switchEthereumChain always go to the correct
// wallet (important for Coinbase Wallet which does NOT use window.ethereum).
let _rawProvider: any = null;
// Wrapped version of _rawProvider — has gas-boost proxy applied.
// Used by autoFundSmartAccount so the funding tx also gets the same
// baseFee × 2 protection that normal SDK operations get.
let _wrappedProvider: any = null;

// ── Gasless mode ────────────────────────────────────────────
// When gasless mode is active, _gaslessMode is true and the adapter was built
// from a Smart Account client (Circle Paymaster) instead of window.ethereum.
let _gaslessMode    = false;
let _gaslessAddress: string | null = null;
// EOA address saved when gasless mode is activated.
// Bridge/swap operations use this as the DESTINATION recipient so USDC lands
// in the user's MetaMask wallet, not in the Smart Account on the destination chain.
let _eoaAddress: string | null = null;

/** Returns the active wallet address (Smart Account when gasless, EOA otherwise). */
export function getAccount():        string | null { return _gaslessMode ? _gaslessAddress : _account; }
/** Returns true when any wallet (EOA or Smart Account) is connected. */
export function isConnected():       boolean       { return Boolean(_account) || _gaslessMode; }
/** Returns true when the Circle Paymaster gasless mode is active. */
export function isGaslessMode():     boolean       { return _gaslessMode; }
/** Returns the ERC-4337 Smart Account address when in gasless mode, otherwise null. */
export function getGaslessAddress(): string | null { return _gaslessAddress; }
/**
 * Returns true when the given chain supports gasless mode (Circle Paymaster).
 * Currently supported: Arbitrum One (42161), Base Mainnet (8453).
 * Ethereum excluded: ETH gas is used for bridge transactions (v0.8 Paymaster path not used).
 */
export function isGaslessSupported(chainId: number): boolean {
  return chainId in GASLESS_USDC;
}

// ── Ensure adapter is ready ─────────────────────────────────
// Called before any SDK operation that needs _adapter.
// If wagmi has already connected the wallet (window.ethereum has accounts)
// but connectMetaMask() was never called, we auto-initialize _adapter here.
/** Ensures the viem adapter is initialised before SDK operations. Auto-inits from window.ethereum if wagmi already connected. */
export async function ensureAdapter(): Promise<void> {
  if (_adapter) return;                              // already set
  if (_gaslessMode) return;          // gasless — adapter already configured
  const provider = getMetaMaskProvider();
  if (!provider) return;                             // no injected wallet
  try {
    const accounts = await provider.request({ method: 'eth_accounts' }) as string[];
    const addr = accounts?.[0];
    if (!isValidAddress(addr)) return;
    _account     = addr;
    _rawProvider     = provider;  // save for ensureOnChain
    _wrappedProvider = wrapProviderWithAutoAdd(provider); // gas-boosted version
    // Wrap provider so the SDK's internal switch calls register the chain first
    _adapter    = await createViemAdapterFromProvider({ provider: _wrappedProvider, getPublicClient: getReliablePublicClient });
    _rawAdapter = _adapter; // EOA adapter — preserved for swap permit signing
  } catch { /* silent — ops will fail gracefully with their own errors */ }
}

/**
 * Initialises the SDK adapter from any EIP-1193 provider (wagmi connector).
 * Called after a successful wallet connection for non-MetaMask wallets
 * (Coinbase Wallet, WalletConnect, etc.) so that swap/bridge operations work.
 */
export async function initAdapterFromProvider(provider: any, address: string, connectorId?: string): Promise<void> {
  if (!isValidAddress(address)) return;
  try {
    // Wrap provider so the SDK's internal wallet_switchEthereumChain calls
    // pre-register the chain via wallet_addEthereumChain first.
    const wrapped   = wrapProviderWithAutoAdd(provider);
    _adapter        = await createViemAdapterFromProvider({ provider: wrapped, getPublicClient: getReliablePublicClient });
    _rawAdapter     = _adapter; // EOA adapter — preserved for swap permit signing
    _account        = address;
    _gaslessMode    = false;
    _gaslessAddress = null;
    // Save the raw provider so ensureOnChain can send wallet_addEthereumChain /
    // wallet_switchEthereumChain directly to this wallet (not window.ethereum).
    _rawProvider     = provider;
    _wrappedProvider = wrapped; // gas-boosted version for funding transactions
    // Coinbase Wallet opens a popup tab for each step — flag it so batchTransactions
    // is disabled, making popup dismissal a proper rejection.
    _isCoinbaseWallet = Boolean(
      provider?.isCoinbaseWallet ||
      provider?.isCoinbaseBrowser ||
      /coinbase/i.test(connectorId ?? '')
    );
  } catch {
    // non-fatal — adapter remains null; UB features will be disabled
  }
}

/** Connects MetaMask (injected wallet) and initialises the viem adapter. Returns the EOA address. */
export async function connectMetaMask(): Promise<string> {
  const eth = getMetaMaskProvider();
  if (!eth) throw new Error('MetaMask not found. Please install it.');

  const accounts = await eth.request({ method: 'eth_requestAccounts' }) as string[];
  const addr = accounts?.[0];
  if (!isValidAddress(addr)) throw new Error('Invalid wallet address returned by provider.');

  _account        = addr;
  _gaslessMode    = false;
  _gaslessAddress = null;
  _isCoinbaseWallet = false;  // MetaMask is not Coinbase Wallet
  _rawProvider     = eth;      // save for ensureOnChain (raw — used by wallet_switch calls)
  _wrappedProvider = wrapProviderWithAutoAdd(eth); // gas-boosted — used by funding txs
  // Wrap provider so the SDK's internal wallet_switchEthereumChain calls register the chain first
  _adapter        = await createViemAdapterFromProvider({ provider: _wrappedProvider, getPublicClient: getReliablePublicClient });
  return _account;
}

// ── Connect via Circle Paymaster (Gasless Smart Account) ────
// Initialises a SimpleSmartAccount backed by MetaMask as owner,
// then wraps it in a viem adapter so App Kit SDK works transparently.
/** Connects via Circle Paymaster Smart Account. MetaMask is the EOA owner; gas is paid in USDC. */
export async function connectGasless(chainId?: number): Promise<{ smartAddress: string; chainName: string }> {
  const { initGaslessClient, getSmartAccountClient } = await import('./gasless');

  const result   = await initGaslessClient(chainId);
  const saClient = getSmartAccountClient();

  if (!saClient) throw new Error('Smart account client could not be initialised.');

  // saClient is now a viem/account-abstraction createBundlerClient instance (Circle official pattern).
  // It is NOT a bare EIP-1193 provider — build a thin EIP-1193 shim that:
  //   • Answers wallet methods (eth_accounts, eth_requestAccounts) with the SA address
  //   • Routes eth_sendTransaction through BundlerClient.sendUserOperation()
  //     which submits a UserOperation to the bundler with Circle Paymaster attached
  //   • Falls through all read calls / chain queries to the raw EOA provider
  //
  // CHAIN-SWITCH SUPPORT (fix for Base→Arb and any cross-chain gasless bridge):
  //   The bundlerClient is keyed to a specific chain's Alchemy RPC endpoint.
  //   When user bridges Base→Arb, MetaMask switches to Base Mainnet but bundlerClient
  //   still points to Arbitrum's bundler → UserOps immediately rejected.
  //   The shim detects the active chain before each sendUserOperation and calls
  //   reinitForChain() to rebuild the bundler for the new chain if needed.
  //   reinitForChain() is a no-op when the chain hasn't changed.
  let currentSaClient    = saClient;
  let currentAuth        = result.authorization;   // null for v0.7, signed for v0.8
  let currentSignFresh   = result.signFreshAuthorization;  // null for v0.7
  let lastBundlerChainId = result.chainId;

  const smartAccountEIP1193 = {
    request: async ({ method, params = [] as readonly unknown[] }: { method: string; params?: readonly unknown[] }) => {
      // ── Account queries → smart account address ───────────────────────────
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
        return [result.smartAccountAddress];
      }

      // ── Writes → submit as UserOperation via bundler + Circle Paymaster ──
      if (method === 'eth_sendTransaction') {
        const tx = (params as any[])[0] ?? {};

        // ── Chain-switch guard ────────────────────────────────────────────
        // Detect current MetaMask chain before each UserOp. Rebuild bundler
        // if it changed (handles Base→Arb, Arb→Base, etc.).
        // If the active chain is NOT gasless-supported (e.g. Ethereum Mainnet),
        // fall through to _rawProvider for regular ETH gas.
        try {
          const activeHex     = await _rawProvider.request({ method: 'eth_chainId' }) as string;
          const activeChainId = parseInt(activeHex, 16);

          // ── Non-gasless chain guard ───────────────────────────────────────
          // Ethereum: Circle v0.8 Paymaster permit requires EIP-7702 which
          // MetaMask doesn't support. Route all transactions through ETH gas instead.
          const GASLESS_CHAIN_IDS = new Set([42161, 8453]); // Arbitrum One, Base Mainnet
          if (!GASLESS_CHAIN_IDS.has(activeChainId)) {
            if (_rawProvider) return _rawProvider.request({ method, params } as any);
            throw new Error(`Chain ${activeChainId} not supported for gasless. Please use ETH gas mode.`);
          }

          if (activeChainId !== lastBundlerChainId) {
            const { reinitForChain, getSmartAccountClient: getClient } = await import('./gasless');
            const reinitResult = await reinitForChain(activeChainId);
            currentSaClient    = getClient();
            currentAuth        = reinitResult.authorization;
            currentSignFresh   = reinitResult.signFreshAuthorization;
            lastBundlerChainId = activeChainId;
            if (reinitResult.smartAccountAddress) {
              (result as any).smartAccountAddress = reinitResult.smartAccountAddress;
              // CRITICAL: update _gaslessAddress so fundGaslessWallet / autoFundSmartAccount
              // use the correct SA address for the new chain.
              _gaslessAddress = reinitResult.smartAccountAddress;
            }
          }
        } catch {
          // Non-fatal: proceed; UserOp submission will surface the real error
        }

        try {
          // EIP-7702 (v0.8 — reserved): sign a FRESH authorization before EACH
          // sendUserOperation. The nonce in the authorization is one-time-use — reusing
          // the same authorization across multiple UserOps (approve + burn) causes the
          // second one to fail with "nonce already used" / "invalid authorization".
          // signFreshAuthorization() fetches the latest nonce and re-signs each time.
          // v0.7 (Arbitrum / Base): currentSignFresh is null — auth block is skipped.
          let authForThisOp: any = null;
          if (currentSignFresh) {
            try {
              authForThisOp = await currentSignFresh();
            } catch {
              authForThisOp = currentAuth; // last resort fallback
            }
          }

          const userOpHash = await currentSaClient.sendUserOperation({
            calls: [{
              to:    tx.to   as `0x${string}`,
              data:  (tx.data ?? '0x') as `0x${string}`,
              value: tx.value != null ? BigInt(tx.value) : 0n,
            }],
            ...(authForThisOp ? { authorization: authForThisOp } : {}),
          });

          const receipt = await currentSaClient.waitForUserOperationReceipt({ hash: userOpHash });
          const txHash = receipt.receipt.transactionHash;
          return txHash;
        } catch (err: any) {
          throw err;
        }
      }

      // ── Everything else (reads, chain info, gas estimates) ────────────────
      if (_rawProvider) return _rawProvider.request({ method, params } as any);
      throw new Error(`Unsupported RPC method in gasless mode: ${method}`);
    },
  };

  _adapter        = await createViemAdapterFromProvider({ provider: smartAccountEIP1193 as any, getPublicClient: getReliablePublicClient });
  // NOTE: _rawAdapter is intentionally NOT overwritten here.
  // Swap permit signing must always use the EOA adapter, not the Smart Account adapter.
  _gaslessMode    = true;
  _gaslessAddress = result.smartAccountAddress;
  _account        = null; // clear EOA account — smart account takes over

  // CRITICAL: Ensure _rawProvider is always set to the MetaMask provider in gasless mode.
  // connectGasless can be called without a prior connectMetaMask (e.g. page reload + direct
  // gasless connect). In that case _rawProvider is null, causing crashes on:
  //   - eth_chainId reads in the smartAccountEIP1193 chain-switch guard
  //   - _rawProvider.request({method:'eth_accounts'}) at line below
  //   - autoFundSmartAccount using _rawProvider for funding tx
  // Fix: always (re)set _rawProvider from the current MetaMask provider here.
  if (!_rawProvider) {
    const mmProvider = getMetaMaskProvider();
    if (mmProvider) {
      _rawProvider     = mmProvider;
      _wrappedProvider = wrapProviderWithAutoAdd(mmProvider);
    }
  }

  // Save EOA address for use as destination recipient in bridge/swap calls.
  // In gasless mode _adapter reports the SA address, so without this the Orbit
  // Relayer would mint USDC to the SA address on the destination chain instead
  // of the user's MetaMask wallet.
  try {
    const eoaAccts: string[] = await _rawProvider.request({ method: 'eth_accounts' });
    _eoaAddress = eoaAccts[0]?.toLowerCase() ?? null;
  } catch { _eoaAddress = null; }

  return {
    smartAddress: result.smartAccountAddress,
    chainName:    result.chainName,
  };
}

/**
 * Disables gasless mode and rebuilds the regular viem adapter from the saved raw provider.
 * Call this when the user switches Gas Payment back to ETH.
 */
export async function exitGaslessMode(): Promise<void> {
  if (!_gaslessMode) return; // already in normal mode
  if (!_rawProvider) throw new Error('No wallet provider found. Please reconnect your wallet.');

  // Rebuild regular viem adapter from the saved raw EIP-1193 provider
  _adapter    = await createViemAdapterFromProvider({
    provider:        _rawProvider,
    getPublicClient: getReliablePublicClient,
  });
  _rawAdapter = _adapter; // resync rawAdapter now that EOA adapter is restored

  // Restore EOA account address
  try {
    const accounts: string[] = await _rawProvider.request({ method: 'eth_accounts' });
    _account = accounts[0]?.toLowerCase() ?? null;
  } catch { _account = null; }

  _gaslessMode    = false;
  _gaslessAddress = null;
  _eoaAddress     = null;
  clearSmartAccountClient();
}

/** Clears all wallet state — EOA, gasless mode, and Smart Account client. */
export function disconnectWallet(): void {
  _adapter          = null;
  _account          = null;
  _gaslessMode      = false;
  _gaslessAddress   = null;
  _eoaAddress       = null;
  _isCoinbaseWallet = false;
  _rawProvider      = null;
  _wrappedProvider  = null;
  clearSmartAccountClient();
}

// ── USDC addresses on gasless-supported mainnet chains ──────
// Ethereum excluded — gasless not active (ETH gas is used for bridge).
const GASLESS_USDC: Record<number, `0x${string}`> = {
  42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Arbitrum One
  8453:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base Mainnet
};

// Circle Paymaster v0.7 address (requires prior USDC allowance from SA)
const CIRCLE_PAYMASTER_V07 = '0x31BE08D380A21fc740883c0BC434FcFc88740b58' as `0x${string}`;
// Circle Paymaster v0.8 address (same requirement — prior USDC allowance from SA)
const CIRCLE_PAYMASTER_V08 = '0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966' as `0x${string}`;

// SimpleAccountFactory addresses per EntryPoint version
// v0.7 factory → Arbitrum One + Base Mainnet
const SA_FACTORY_V07 = '0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985' as `0x${string}`;
// v0.8 factory → reserved (not used on mainnet currently)
const SA_FACTORY_V08 = '0x13E9ed32155810FDbd067D4522C492D6f68E5944' as `0x${string}`;

// SimpleAccountFactory ABI (createAccount)
const SA_FACTORY_ABI = [
  { name: 'createAccount', type: 'function' as const, stateMutability: 'nonpayable' as const,
    inputs: [{ name: 'owner', type: 'address' }, { name: 'salt', type: 'uint256' }],
    outputs: [{ name: 'ret', type: 'address' }] },
] as const;

// SimpleAccount execute ABI (callable by owner EOA directly — no UserOp needed)
const SA_EXECUTE_ABI = [
  { name: 'execute', type: 'function' as const, stateMutability: 'nonpayable' as const,
    inputs: [
      { name: 'dest',  type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'func',  type: 'bytes'   },
    ], outputs: [] },
] as const;

// ERC-20 approve ABI (used inside SA.execute to approve Circle Paymaster)
const ERC20_APPROVE_ABI = [
  { name: 'approve', type: 'function' as const, stateMutability: 'nonpayable' as const,
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }] },
] as const;

// ERC-20 allowance ABI
const ERC20_ALLOWANCE_ABI = [
  { name: 'allowance', type: 'function' as const, stateMutability: 'view' as const,
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ type: 'uint256' }] },
] as const;

const ERC20_BALANCE_ABI = [
  { name: 'balanceOf', type: 'function' as const, stateMutability: 'view' as const,
    inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const ERC20_TRANSFER_ABI = [
  { name: 'transfer', type: 'function' as const, stateMutability: 'nonpayable' as const,
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }] },
] as const;

/**
 * Ensures the ERC-4337 Smart Account has enough USDC to execute a gasless
 * bridge/swap of `bridgeAmount` USDC.
 *
 * HOW IT WORKS:
 *   The Smart Account (SA) is a different address from the user's EOA.
 *   For gasless mode, USDC must be in the SA, not the EOA.
 *   This function checks the SA balance and, when insufficient, automatically
 *   transfers the deficit + a 0.2 USDC Paymaster-fee buffer from the EOA to
 *   the SA — using the raw EOA provider (one ETH-gas transaction).
 *   Subsequent operations from the SA are fully gasless via Circle Paymaster.
 *
 * @param chainId            - Source chain numeric ID (e.g. 42161 for Arbitrum One)
 * @param rpc                - Source chain RPC URL for balance reads
 * @param smartAccountAddress - ERC-4337 Smart Account address
 * @param bridgeAmount       - Amount the user wants to bridge/swap (USDC, decimal string)
 */
async function autoFundSmartAccount(
  chainId: number,
  rpc: string,
  smartAccountAddress: `0x${string}`,
  bridgeAmount: string,
): Promise<void> {
  if (!_rawProvider) {
    return;
  }

  // CRITICAL: Use _wrappedProvider (gas-boosted) for the funding eth_sendTransaction.
  // _rawProvider is the bare MetaMask provider WITHOUT the wrapProviderWithAutoAdd proxy.
  // On Arbitrum One the baseFee changes every ~250ms — MetaMask's fee estimate can
  // be stale by the time eth_sendRawTransaction reaches the node → "max fee per gas
  // less than block base fee" (code -32603).
  //
  // _wrappedProvider has the baseFee × 2 boost interceptor applied, which guarantees
  // maxFeePerGas is always well above the real baseFee even after a few blocks.
  //
  // Falls back to _rawProvider if _wrappedProvider is somehow not set (should not happen).
  const fundProvider = _wrappedProvider ?? _rawProvider;

  const usdcAddress = GASLESS_USDC[chainId];
  if (!usdcAddress) return; // arc mainnet or unsupported — skip

  const publicClient = getReliablePublicClient({ chain: { id: chainId } });

  // ── 1. One-time setup (v0.7 chains): Deploy SA + approve Circle Paymaster ─
  //
  //  ROOT CAUSE FIX (AA33 reverted ERC20: transfer amount exceeds allowance):
  //
  //  Circle Paymaster v0.7 validatePaymasterUserOp calls
  //  USDC.transferFrom(SA, paymaster, amount) directly — it does NOT call
  //  USDC.permit() to set the allowance. The SA must have a prior approved
  //  allowance for the Circle Paymaster before any gasless UserOp succeeds.
  //
  //  This step runs BEFORE the balance check so it always executes — even when
  //  the SA already has enough USDC from a previous funding transfer.
  //
  //  SimpleAccount.execute() can be called by the owner EOA directly
  //  (see _requireFromEntryPointOrOwner in SimpleAccount.sol) — no bundler needed.
  //
  //  These are one-time ETH transactions per chain per SA.
  // All supported gasless chains need SA deploy + paymaster allowance setup.
  //
  //  PAYMASTER ADDRESS SELECTION:
  //  ─────────────────────────────
  //  gasless.ts CHAIN_ENTRYPOINT defines per-chain paymaster:
  //    Arbitrum One  (42161): CIRCLE_PAYMASTER.v07_mainnet (v0.7)
  //    Base Mainnet  (8453):  CIRCLE_PAYMASTER.v07_mainnet (v0.7)
  //    Ethereum Mainnet (1):  ETH gas — skips this block entirely.
  //      SA = EOA address, permit mode, no deploy or allowance setup needed.
  //
  //  Only Arbitrum and Base need the one-time SA deploy + allowance setup.
  //  Ethereum uses ETH gas — skip gasless setup entirely.
  const paymasterForChain = CIRCLE_PAYMASTER_V07; // 0x31BE... — v0.7 chains only (Arb/Base)
  const needsSetup = chainId === 42161 || chainId === 8453; // NOT Ethereum Mainnet
  if (needsSetup) {
    // Read EOA address early (needed for deploy + approve)
    const eoaAccountsSetup: string[] = await _rawProvider.request({ method: 'eth_accounts' });
    const eoaAddressSetup = eoaAccountsSetup[0] as `0x${string}`;

    if (eoaAddressSetup) {
      // a) Deploy SA if not yet deployed (v0.7 factory is EOA-callable on all chains)
      const saCode = await publicClient.getBytecode({ address: smartAccountAddress }).catch(() => null);
      const saDeployed = saCode && saCode.length > 2;
      if (!saDeployed) {
        const deployData = encodeFunctionData({
          abi:          SA_FACTORY_ABI,
          functionName: 'createAccount',
          args:         [eoaAddressSetup, 0n],
        });
        const saFactoryAddress = SA_FACTORY_V07;
        const deployTx: `0x${string}` = await ((_wrappedProvider ?? _rawProvider) as any).request({
          method: 'eth_sendTransaction',
          params: [{ from: eoaAddressSetup, to: saFactoryAddress, data: deployData }],
        });
        await publicClient.waitForTransactionReceipt({ hash: deployTx });
      }

      // b) Set USDC allowance: SA → Circle Paymaster (if below threshold)
      const MIN_ALLOWANCE = parseUnits('100', 6);
      const currentAllowance = await publicClient.readContract({
        address:      usdcAddress,
        abi:          ERC20_ALLOWANCE_ABI,
        functionName: 'allowance',
        args:         [smartAccountAddress, paymasterForChain],
      }) as bigint;

      if (currentAllowance < MIN_ALLOWANCE) {
        const approveData = encodeFunctionData({
          abi:          ERC20_APPROVE_ABI,
          functionName: 'approve',
          args:         [paymasterForChain, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')],
        });
        const executeData = encodeFunctionData({
          abi:          SA_EXECUTE_ABI,
          functionName: 'execute',
          args:         [usdcAddress, 0n, approveData],
        });
        const approveTx: `0x${string}` = await ((_wrappedProvider ?? _rawProvider) as any).request({
          method: 'eth_sendTransaction',
          params: [{ from: eoaAddressSetup, to: smartAccountAddress, data: executeData }],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
      } else {
        // allowance already sufficient — skip
      }
    }
  }

  // ── 2. Read Smart Account USDC balance ────────────────────
  //
  //  For all chains (excluding Ethereum):
  //    SA address may be counterfactual (not yet deployed).
  //    ERC-20 balanceOf works on counterfactual addresses — USDC is just a mapping entry.
  //    Sending USDC to a counterfactual SA address works fine.
  const saBalance = await publicClient.readContract({
    address:      usdcAddress,
    abi:          ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args:         [smartAccountAddress],
  }) as bigint;

  // ── Gas buffer per chain ──────────────────────────────────
  //   v0.7 (Arb/Base): 2 UserOps (approve + burn), each ~0.05–0.15 USDC. Buffer: 0.3 USDC.
  //   v0.8 (Eth Sep):  permit path, gas deducted via USDC.permit inline. Buffer: 0.5 USDC.
  const isEthereumChain = chainId === 1;
  const GAS_BUFFER_USDC = isEthereumChain
    ? parseUnits('0.5', 6)
    : parseUnits('0.3', 6);
  const needed = parseUnits(parseFloat(bridgeAmount).toFixed(6), 6) + GAS_BUFFER_USDC;

  if (saBalance >= needed) return; // SA already funded — nothing to do

  const deficit = needed - saBalance;

  // ── 3. Read EOA USDC balance and transfer deficit ─────────
  const eoaAccounts: string[] = await _rawProvider.request({ method: 'eth_accounts' });
  const eoaAddress = eoaAccounts[0] as `0x${string}`;
  if (!eoaAddress) throw new Error('No wallet account found. Please reconnect your wallet.');

  const eoaBalance = await publicClient.readContract({
    address:      usdcAddress,
    abi:          ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args:         [eoaAddress],
  }) as bigint;

  if (eoaBalance < deficit) {
    throw new Error(
      `Insufficient USDC for gasless mode: need ${formatUnits(deficit, 6)} USDC ` +
      `(${formatUnits(parseUnits(parseFloat(bridgeAmount).toFixed(6), 6), 6)} bridge + ` +
      `${formatUnits(GAS_BUFFER_USDC, 6)} gas buffer) to fund Smart Account, ` +
      `but your wallet only has ${formatUnits(eoaBalance, 6)} USDC on this chain.`,
    );
  }

  // EOA balance check — ensure EOA has enough after transfer.
  const MIN_EOA_RESERVE = parseUnits('0.01', 6);
  if (eoaBalance - deficit < MIN_EOA_RESERVE) {
    throw new Error(
      `Not enough USDC in wallet. After funding the Smart Account with ` +
      `${formatUnits(deficit, 6)} USDC, your wallet would have ` +
      `${formatUnits(eoaBalance - deficit, 6)} USDC remaining. ` +
      `Please ensure your wallet has at least ${formatUnits(needed + MIN_EOA_RESERVE, 6)} USDC total.`,
    );
  }

  // ── 4. Transfer deficit from EOA → Smart Account ──────────
  //    Works for all chains (v0.7 Arb/Base AND v0.8 Eth Sep).
  //    Ethereum: SA may be counterfactual — USDC transfer to undeployed address works.
  //    The SA will be deployed atomically by the EntryPoint in the first UserOp.
  //
  //    CRITICAL: Use fundProvider (= _wrappedProvider) — NOT _rawProvider.
  //    The wrapProviderWithAutoAdd interceptor boosts maxFeePerGas = baseFee × 2.
  const transferData = encodeFunctionData({
    abi:          ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args:         [smartAccountAddress, deficit],
  });

  const txHash: `0x${string}` = await fundProvider.request({
    method: 'eth_sendTransaction',
    params: [{ from: eoaAddress, to: usdcAddress, data: transferData }],
  });

  // ── 4. Wait for the funding transfer to be confirmed ──────
  await publicClient.waitForTransactionReceipt({ hash: txHash });
}

/**
 * Public wrapper around autoFundSmartAccount.
 * Call this from the UI layer (BridgeTab / SwapTab) before executeBridge /
 * executeSwap so the UI can show a progress step for the funding transfer.
 * Safe to call even when gasless mode is inactive — returns immediately.
 */
export async function fundGaslessWallet(networkId: string, amount: string): Promise<void> {
  if (!_gaslessMode || !_gaslessAddress) return;
  const net = NETWORKS.find(n => n.id === networkId);
  if (!net?.chainId || !net?.rpc) return;

  // Proactively reinit the bundler for the target chain so _gaslessAddress reflects
  // the correct SA address for that chain BEFORE autoFundSmartAccount runs.
  // Without this, _gaslessAddress could hold a different chain's SA address
  // (set when gasless was first connected) and autoFundSmartAccount would
  // deploy/fund/approve the WRONG SA — leaving the actual UserOp sender with 0 allowance.
  if (net.chainId && [42161, 8453, 1].includes(net.chainId)) {
    try {
      const { reinitForChain } = await import('./gasless');
      const reinitResult = await reinitForChain(net.chainId);
      if (reinitResult.smartAccountAddress) {
        _gaslessAddress = reinitResult.smartAccountAddress;
      }
    } catch {
      // Non-fatal — continue with existing SA address
    }
  }

  await autoFundSmartAccount(net.chainId, net.rpc, _gaslessAddress as `0x${string}`, amount);
}

/**
 * Switch the connected wallet to the target chain.
 *
 * Strategy:
 *  1) Resolve the correct provider: prefer _rawProvider, fall back to window.ethereum.
 *     Coinbase Wallet uses its own provider — NOT window.ethereum.
 *  2) Register the chain via wallet_addEthereumChain (no-op if already added).
 *  3) Switch via wallet_switchEthereumChain.
 *     wagmi switchChainAsync can behave unreliably for Coinbase Wallet —
 *     we go directly through the EIP-1193 provider first.
 *  4) If the switch fails (4902, "unrecognized chain", etc.) re-add and retry once.
 *  5) If both attempts fail, throw a user-friendly error.
 *
 * @param networkId   - Application network ID (e.g. 'Arc')
 * @param chainId     - Numeric EVM chain ID
 * @param switchAsync - switchChainAsync from wagmi useSwitchChain()
 * @param provider    - Optional EIP-1193 provider; defaults to _rawProvider
 */
export async function ensureOnChain(
  networkId: string,
  chainId: number,
  switchAsync: (args: { chainId: number }) => Promise<unknown>,
  provider?: any,
): Promise<void> {
  // Priority: explicitly provided provider > connection-saved _rawProvider > window.ethereum
  const eip1193 = provider ?? _rawProvider ?? (window as any).ethereum;
  const params  = ADD_CHAIN_PARAMS[networkId];

  // ── Step 1: Pre-register the chain ──────────────────────────────────────────
  // wallet_addEthereumChain is a no-op for chains the wallet already knows — always safe.
  if (params && eip1193?.request) {
    try {
      await eip1193.request({ method: 'wallet_addEthereumChain', params: [params] });
    } catch { /* chain already registered — ignore */ }
  }

  // ── Step 2: First switch attempt ────────────────────────────────────────────
  // Try the EIP-1193 provider directly first (more reliable for Coinbase Wallet).
  // Fall back to wagmi switchAsync if the direct call fails.
  const chainIdHex = `0x${chainId.toString(16)}`;

  const tryDirectSwitch = async (): Promise<boolean> => {
    if (!eip1193?.request) return false;
    try {
      await eip1193.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: chainIdHex }],
      });
      return true;
    } catch (err: any) {
      const code = err?.code ?? err?.cause?.code ?? err?.data?.originalError?.code;
      const msg  = String(err?.message ?? err?.shortMessage ?? err ?? '');
      // User rejected — do not retry
      if (
        code === 4001 ||
        /user (rejected|denied|cancel)/i.test(msg) ||
        /request.*rejected/i.test(msg)
      ) {
        throw new Error('Network switch rejected by user.');
      }
      return false; // other errors — try wagmi
    }
  };

  const tryWagmiSwitch = async (): Promise<void> => {
    try {
      await switchAsync({ chainId });
    } catch (err: any) {
      const code = err?.code ?? err?.cause?.code ?? err?.data?.originalError?.code;
      const msg  = String(err?.message ?? err?.shortMessage ?? err ?? '');
      // User rejected
      if (
        code === 4001 ||
        /user (rejected|denied|cancel)/i.test(msg) ||
        /request.*rejected/i.test(msg)
      ) {
        throw new Error('Network switch rejected by user.');
      }
      const isSwitchFailure =
        code === 4902 ||
        /could not switch network|unrecognized chain|chain.*not.*added|unknown chain|try adding|switch.*network/i.test(msg);
      if (!isSwitchFailure) throw err;
      // isSwitchFailure → proceed to Step 3 below
      throw Object.assign(new Error(msg), { _isSwitchFailure: true });
    }
  };

  // Try direct EIP-1193 first
  try {
    const directOk = await tryDirectSwitch();
    if (directOk) return; // success — early exit
  } catch (directErr: any) {
    const msg = String(directErr?.message ?? directErr ?? '');
    if (/rejected by user/i.test(msg)) throw directErr; // user rejected — stop
    // Other errors → try wagmi
  }

  // Try wagmi
  try {
    await tryWagmiSwitch();
    return; // success
  } catch (wagmiErr: any) {
    if (!(wagmiErr as any)?._isSwitchFailure) throw wagmiErr;
    // isSwitchFailure → continue to Step 3
  }

  // ── Step 3: Re-add chain if unknown, then retry ──────────────────────────────
  if (!params) {
    throw new Error(
      `Could not switch to ${networkId} — please switch manually in your wallet.`
    );
  }
  if (!eip1193?.request) {
    throw new Error('No EIP-1193 provider found. Please reconnect your wallet.');
  }

  try {
    await eip1193.request({ method: 'wallet_addEthereumChain', params: [params] });
  } catch { /* ignore add error — switch may still succeed */ }

  // Final attempt: direct EIP-1193 switch
  try {
    await eip1193.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }],
    });
    return;
  } catch { /* try wagmi as last resort */ }

  try {
    await switchAsync({ chainId });
  } catch (retryErr: any) {
    const retryMsg = String(
      retryErr?.shortMessage ?? retryErr?.message ?? retryErr ?? ''
    );
    throw new Error(
      retryMsg.length > 0 && retryMsg.length < 200
        ? retryMsg
        : `Could not switch to ${networkId} — please switch manually in your wallet.`
    );
  }
}

// ── ERC-20 balance ───────────────────────────────────────────
const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'decimals',  type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

/** Fetches the ERC-20 token balance for the connected account on the given network. Returns '0.00' on failure.
 *  @param networkId   - one of the configured network IDs (e.g. 'Ethereum', 'Arbitrum')
 *  @param tokenSymbol - token symbol (e.g. 'USDC')
 *  @param overrideAddress - optional wallet address; overrides SDK internal state (use wagmi address here)
 */
export async function fetchTokenBalance(networkId: string, tokenSymbol: string, overrideAddress?: string): Promise<string> {
  await ensureAdapter();
  // Prefer the explicitly passed address (wagmi) over SDK internal state
  // Works for all wallet types (MetaMask, Coinbase Wallet, WalletConnect).
  const activeAddr = overrideAddress ?? getAccount();
  if (!activeAddr) return '0.00';
  if (!isValidAddress(activeAddr)) return '0.00';
  if (!VALID_NETWORK_IDS.has(networkId)) return '0.00';

  const network   = NETWORKS.find(n => n.id === networkId);
  if (!network) return '0.00';

  const tokenAddr = TOKEN_ADDRESSES[networkId]?.[tokenSymbol];
  if (!tokenAddr) return 'N/A';

  // Fallback RPC list — Ethereum has multiple endpoints
  // because public Ethereum nodes can be rate-limited at times.
  const rpcList = FALLBACK_RPC[networkId] ?? [network.rpc];

  // Try each RPC endpoint in order — use the first successful response.
  // Each attempt has a 5-second timeout.
  const TIMEOUT_MS = 5_000;

  for (const rpcUrl of rpcList) {
    try {
      const client = createPublicClient({
        transport: http(rpcUrl, { timeout: TIMEOUT_MS, retryCount: 1, retryDelay: 300 }),
      });

      const [balance, decimals] = await Promise.all([
        client.readContract({ address: tokenAddr as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [activeAddr as `0x${string}`] }),
        client.readContract({ address: tokenAddr as `0x${string}`, abi: ERC20_ABI, functionName: 'decimals' }),
      ]);
      return Number(formatUnits(balance as bigint, decimals as number)).toFixed(4);
    } catch {
      // This endpoint failed — try the next URL in the list
    }
  }

  // All endpoints failed
  return '0.00';
}

// ── Send (same-chain, Arc Testnet only) ─────────────────────
/** Estimates gas for a same-chain send on Arc Mainnet. Returns null when estimation is not possible. */
export async function estimateSend(p: { to: string; amount: string; token: string }): Promise<{ gas: string } | null> {
  if (!_adapter) return null;
  const kit = getKit();

  // Use a placeholder address when recipient is not yet provided
  // so gas can be estimated early
  const recipient = isValidAddress(p.to) ? p.to : '0x0000000000000000000000000000000000000001';

  // Circle SDK send() only recognises 4 built-in aliases: 'USDC', 'USDT', 'NATIVE', 'EURC'.
  // For cirBTC and other ERC-20s we must pass the contract address directly.
  const SEND_TOKEN_ALIASES_EST = new Set(['USDC', 'USDT', 'NATIVE', 'EURC']);
  const resolvedTokenEst: string = SEND_TOKEN_ALIASES_EST.has(p.token)
    ? p.token
    : (TOKEN_ADDRESSES['Arc']?.[p.token] ?? p.token);

  try {
    const est: any = await (kit as any).estimateSend({
      from:   { adapter: _adapter, chain: 'Arc' as const },
      to:     recipient as `0x${string}`,
      amount: p.amount,
      token:  resolvedTokenEst as any,
    });
    const raw = est?.gas ?? est?.gasLimit ?? est?.estimatedGas ?? null;
    return raw != null ? { gas: String(raw) } : null;
  } catch {
    return null;
  }
}

/** Executes a same-chain send on Arc Mainnet. */
export async function executeSend(p: { to: string; amount: string; token: string }) {
  if (!_adapter) throw new Error('Wallet not connected.');
  if (!isValidAddress(p.to)) throw new Error('Invalid recipient address.');

  const kit = getKit();

  // Circle SDK send() only recognises 4 built-in aliases: 'USDC', 'USDT', 'NATIVE', 'EURC'.
  // 'cirBTC' is NOT in that list, so we must pass the contract address directly instead.
  const SEND_TOKEN_ALIASES = new Set(['USDC', 'USDT', 'NATIVE', 'EURC']);
  const resolvedToken: string = SEND_TOKEN_ALIASES.has(p.token)
    ? p.token
    : (TOKEN_ADDRESSES['Arc']?.[p.token] ?? p.token);

  return kit.send({
    from:   { adapter: _adapter, chain: 'Arc' as const },
    to:     p.to as `0x${string}`,
    amount: p.amount,
    token:  resolvedToken as any,
  });
}

// ── Bridge ──────────────────────────────────────────────────
/** Estimates the fee and time for a CCTP cross-chain bridge transfer. */
export async function estimateBridge(p: { fromNetwork: string; toNetwork: string; token: string; amount: string; maxFeePct?: number; transferSpeed?: 'FAST' | 'SLOW' }) {
  await ensureAdapter();
  if (!_adapter) throw new Error('Wallet not connected.');
  if (!VALID_NETWORK_IDS.has(p.fromNetwork) || !VALID_NETWORK_IDS.has(p.toNetwork))
    throw new Error('Invalid network selection.');

  const kit  = getKit();
  const from = NETWORKS.find(n => n.id === p.fromNetwork);
  const to   = NETWORKS.find(n => n.id === p.toNetwork);

  if (!from?.sdkBridge || !to?.sdkBridge)
    throw new Error('Bridge not supported on selected network.');

  // The wrapProviderWithAutoAdd proxy already intercepts wallet_switchEthereumChain
  // and pre-registers the chain. No extra calls needed here — avoids redundant popups.

  const amt = parseFloat(p.amount);
  const maxFee = p.maxFeePct != null && isFinite(amt) && amt > 0
    ? (amt * p.maxFeePct / 100).toFixed(6)
    : undefined;

  // ── maxFee strategy ─────────────────────────────────────────────────────
  //
  // NEVER pass config.maxFee to the SDK. When provided, the SDK sets:
  //   getMaxFee() → providerFee = config.maxFee, forwarderFee = 0n
  // Orbit Relayer fee is NOT included → forwardState: FAILED (INSUFFICIENT_FEE).
  //
  // Fee structure per chain (IRIS API, auto-computed when maxFee = undefined):
  //   Arb→Base FAST:  burnFee ≈ 0.0003 USDC + relayerFee ≈ 0.054 USDC ≈ 0.054 total
  //   Arc→Base FAST:  burnFee = 0 USDC    + relayerFee ≈ 0.054 USDC ≈ 0.054 total
  //   Any→Eth  FAST:  burnFee ≈ 0.0003    + relayerFee ≈ 3.44 USDC  ≈ 3.44 total
  //
  // Previous mistake: Arc source passed effectiveMaxFee='1.5' (thinking CCTPv2
  // required it). Arc minimumFee = 0 bps — no such requirement. Passing 1.5 USDC
  // caused the relayer to charge the FULL 1.5 USDC as feeExecuted (bridge loss).
  //
  // Fix: always undefined → SDK auto-computes from IRIS (providerFee + forwarderFee).
  const effectiveMaxFee = undefined; // Always let SDK auto-compute for all chains

  try {
    // Gasless mode: use EOA as recipient so estimate matches actual bridge call
    const estDestRecipient = _gaslessMode && _eoaAddress ? _eoaAddress as `0x${string}` : undefined;
    return await kit.estimateBridge({
      from:   { adapter: _adapter, chain: from.sdkBridge },
      // useForwarder: true — estimate must match the actual bridge() call parameters.
      to: {
        adapter: _adapter,
        chain:   to.sdkBridge,
        useForwarder: true,
        ...(estDestRecipient ? { recipientAddress: estDestRecipient } : {}),
      },
      token:  p.token as any,
      amount: p.amount,
      config: {
        transferSpeed: p.transferSpeed ?? 'FAST',
        // batchTransactions is disabled for:
        //  1. Coinbase Wallet — EIP-5792 wallet_sendCalls reports popup dismiss as
        //     success, producing a false-positive result.
        //  2. Arbitrum SOURCE — L1+L2 gas model causes forceAtomic simulation to fail.
        //  3. Arc SOURCE — USDC-native gas + EIP-1559 model; MetaMask batch
        //     simulation can time out waiting for Arc RPC's gas estimation.
        //  4. Ethereum SOURCE — 65-block confirmation (~13 min finality) causes
        //     batch TX simulation to time out in MetaMask. Sequential approve→burn required.
        //  5. Gasless mode — ERC-4337 Smart Account adapter bypasses EIP-5792
        //     wallet_sendCalls; batch must be disabled when gasless is active.
        batchTransactions: !_gaslessMode
          && !_isCoinbaseWallet
          && p.fromNetwork !== 'Arbitrum'
          && p.fromNetwork !== 'Arc'
          && p.fromNetwork !== 'Ethereum',
          // NOTE: Base intentionally omitted — OP Stack stable baseFee
          // makes EIP-5792 batch simulation safe. In gasless mode the
          // !_gaslessMode guard above already disables batch automatically.
        ...(effectiveMaxFee ? { maxFee: effectiveMaxFee } : {}),
      },
    } as any);
  } catch (err: any) {
    const msg = String(err?.message ?? err ?? '');
    // CCTPX route error — surface a meaningful message to the user
    if (/route.*could not be determined|CCTPXBridgingProvider|route check/i.test(msg)) {
      throw new Error(
        `Bridge route for ${p.token} between ${from.label} and ${to.label} is temporarily unavailable. ` +
        `Please try USDC or try again later.`
      );
    }
    throw err;
  }
}

/** Executes a CCTP cross-chain bridge transfer. */
export async function executeBridge(p: { fromNetwork: string; toNetwork: string; token: string; amount: string; maxFeePct?: number; transferSpeed?: 'FAST' | 'SLOW'; onBurnSubmitted?: () => void }) {
  await ensureAdapter();
  if (!_adapter) throw new Error('Wallet not connected.');
  if (!VALID_NETWORK_IDS.has(p.fromNetwork) || !VALID_NETWORK_IDS.has(p.toNetwork))
    throw new Error('Invalid network selection.');

  const kit  = getKit();
  const from = NETWORKS.find(n => n.id === p.fromNetwork);
  const to   = NETWORKS.find(n => n.id === p.toNetwork);

  if (!from?.sdkBridge || !to?.sdkBridge)
    throw new Error('Bridge not supported on selected network.');

  // The wrapProviderWithAutoAdd proxy already intercepts every wallet_switchEthereumChain
  // call and pre-registers the chain via wallet_addEthereumChain.
  // ensureOnChain() in BridgeTab.tsx handles the explicit source-chain switch.
  // No extra wallet_addEthereumChain / switchEthereumChain calls are made here
  // to avoid redundant MetaMask popups.

  const amt = parseFloat(p.amount);
  const maxFee = p.maxFeePct != null && isFinite(amt) && amt > 0
    ? (amt * p.maxFeePct / 100).toFixed(6)
    : undefined;

  // ── maxFee strategy ─────────────────────────────────────────────────────
  //
  // NEVER pass config.maxFee to the SDK. When provided, the SDK sets:
  //   getMaxFee() → providerFee = config.maxFee, forwarderFee = 0n
  // Orbit Relayer fee is NOT included → forwardState: FAILED (INSUFFICIENT_FEE).
  //
  // Fee structure per chain (IRIS API, auto-computed when maxFee = undefined):
  //   Arb→Base FAST:  burnFee ≈ 0.0003 USDC + relayerFee ≈ 0.054 USDC ≈ 0.054 total
  //   Arc→Base FAST:  burnFee = 0 USDC    + relayerFee ≈ 0.054 USDC ≈ 0.054 total
  //   Any→Eth  FAST:  burnFee ≈ 0.0003    + relayerFee ≈ 3.44 USDC  ≈ 3.44 total
  //
  // Previous mistake: Arc source passed effectiveMaxFee='1.5' (thinking CCTPv2
  // required it). Arc minimumFee = 0 bps — no such requirement. Passing 1.5 USDC
  // caused the relayer to charge the FULL 1.5 USDC as feeExecuted (bridge loss).
  //
  // Fix: always undefined → SDK auto-computes from IRIS (providerFee + forwarderFee).
  const effectiveMaxFee = undefined; // Always let SDK auto-compute for all chains

  // batchTransactions disabled for:
  //  1. Coinbase Wallet — EIP-5792 wallet_sendCalls returns success immediately
  //     on popup dismiss, producing a false-positive result.
  //  2. Arbitrum One as SOURCE — Arbitrum's L1+L2 gas model makes atomic
  //     batch simulation fail in MetaMask (forceAtomic=true hits a gas-check
  //     mismatch). The wallet auto-rejects with "user rejected" even though
  //     the user never touched the popup. Sequential approve→burn works fine.
  //  3. Arc as SOURCE — USDC-native gas + EIP-1559 model; MetaMask
  //     batch simulation can time-out waiting for Arc RPC's gas estimation.
  //     Sequential approve→burn is more reliable for Arc source transfers.
  //  4. Ethereum as SOURCE — CCTP v1/v2 requires 65 block confirmations
  //     (~13 min finality on Ethereum). MetaMask's atomic batch simulation
  //     times out waiting for the approval receipt before submitting the burn.
  //     Sequential approve→burn is required for Ethereum source transfers.
  const isArbitrumSource = from?.id === 'Arbitrum';
  const isArcSource      = from?.id === 'Arc';
  const isEthereumSource = from?.id === 'Ethereum';
  // When gasless mode is active, batchTransactions MUST be false.
  // batchTransactions:true routes through MetaMask EIP-5792 wallet_sendCalls, which
  // uses a batch-executor contract and pays gas in ETH — it completely bypasses the
  // ERC-4337 Smart Account adapter.  With batchTransactions:false each step goes
  // through the adapter individually, allowing the bundler to submit a UserOperation
  // and the Circle Paymaster to cover gas in USDC.
  //
  // Base is intentionally NOT in this list:
  //   • OP Stack predictive EIP-1559 keeps baseFee stable (~2 wei constant) so
  //     MetaMask's atomic batch simulation never fails due to gas mismatch.
  //   • In gasless mode the !_gaslessMode guard above already forces false,
  //     so adding !isBaseSource would be redundant and would break the normal
  //     (non-gasless) UX by showing 2 popups instead of 1.
  const useBatch = !_gaslessMode && !_isCoinbaseWallet && !isArbitrumSource && !isArcSource && !isEthereumSource;

  // ── Auto-fund Smart Account when gasless is active ──────────────────────
  // The Smart Account (SA) is a different address from the user's MetaMask EOA.
  // Circle SDK bridge uses the SA as "from", so the USDC must be in the SA.
  // autoFundSmartAccount checks the SA balance and, if insufficient, transfers
  // the required USDC from the EOA to the SA automatically (one ETH-gas tx).
  // After the initial funding, all bridge ops from the SA are gasless.
  if (_gaslessMode && _gaslessAddress && from?.chainId && from?.rpc) {
    await autoFundSmartAccount(
      from.chainId,
      from.rpc,
      _gaslessAddress as `0x${string}`,
      p.amount,
    );
  }

  // ── Burn-submitted signal ────────────────────────────────────────────────
  // AppKit v1.16: kit.on() uses namespaced events — 'bridge.burn' (not 'burn').
  // kit.on() returns void (not an unsubscribe fn). Use kit.off() to remove.
  // The handler fires as soon as the burn TX is confirmed on-chain, allowing
  // BridgeTab's phase-aware deadline to disable itself after burn is submitted.
  let _burnHandler: ((payload: any) => void) | null = null;
  if (p.onBurnSubmitted) {
    const onBurnSubmitted = p.onBurnSubmitted;
    _burnHandler = (payload: any) => {
      // bridge.burn event payload carries .values.txHash on success
      if (payload?.values?.txHash || payload?.values?.state === 'success') {
        onBurnSubmitted();
      }
    };
    (kit as any).on?.('bridge.burn', _burnHandler);
  }

  let result: any;

  // ── Destination recipient address ─────────────────────────────────────────
  // IMPORTANT — Gasless mode recipient resolution:
  //
  //   In gasless mode, _adapter is built from smartAccountEIP1193 which reports
  //   the Smart Account (SA) address. Without an explicit recipientAddress, the
  //   Circle SDK uses the adapter address as the CCTP mintRecipient, so the Orbit
  //   Relayer mints USDC to the SA address on the destination chain — not the EOA.
  //
  //   SA address (deterministic CREATE2) is the same on all chains, but the SA
  //   may never be deployed on the destination chain and the user's MetaMask
  //   balance (EOA) will never show the bridged USDC.
  //
  //   Fix: pass _eoaAddress as recipientAddress for the destination so USDC lands
  //   in the user's regular MetaMask wallet on Base/Ethereum/Arc etc.
  //
  //   Normal mode: _adapter already reports EOA address → no recipientAddress needed.
  //
  // Gasless EOA guard:
  //   If gasless mode is active but _eoaAddress is null (eth_accounts failed silently
  //   during connectGasless), we must NOT proceed — without a recipientAddress override
  //   the SDK would mint to the Smart Account on Base, making funds invisible in MetaMask.
  //   Throw an explicit error so the user knows to re-connect rather than lose funds.
  if (_gaslessMode && !_eoaAddress) {
    throw new Error(
      'Gasless mode is active but your wallet address (EOA) could not be resolved. ' +
      'Please disable Gasless mode in Settings → Gas Payment → ETH and try again, ' +
      'or reconnect your wallet.'
    );
  }
  const destRecipient = _gaslessMode && _eoaAddress ? _eoaAddress as `0x${string}` : undefined;

  try {
    result = await kit.bridge({
      from:   { adapter: _adapter, chain: from.sdkBridge },
      // useForwarder: true → Circle's Orbit Relayer handles attestation + mint automatically.
      // The relayer monitors burns on the source chain, fetches Circle's attestation from IRIS,
      // and submits receiveMessage on the destination chain — no user signature needed on dest.
      //
      // IRIS API confirms mainnet forwarding IS active for all domains (domain 3→6 etc.):
      //   GET /v2/burn/USDC/fees/3/6?forward=true → returns forwardFee ~0.054 USDC ✓
      //
      // Previous attempts with useForwarder:true failed due to 2 now-fixed bugs:
      //   1. Promise.race timeout cancelled the bridge before relayer confirmed (20 min race)
      //   2. kit.on('burn') was wrong — AppKit v1.16 requires kit.on('bridge.burn')
      //      → burnSubmitted flag never fired → Promise.race always timed out
      // Both bugs are now fixed. Orbit Relayer works correctly for all mainnet routes.
      to: {
        adapter:    _adapter,
        chain:      to.sdkBridge,
        useForwarder: true,
        // Gasless mode: SA address would be the recipient without this override.
        // Explicit EOA address ensures USDC lands in the user's MetaMask wallet.
        ...(destRecipient ? { recipientAddress: destRecipient } : {}),
      },
      token:  p.token as any,
      amount: p.amount,
      config: {
        transferSpeed: p.transferSpeed ?? 'FAST',
        batchTransactions: useBatch,
        ...(effectiveMaxFee ? { maxFee: effectiveMaxFee } : {}),
      },
    } as any);
  } catch (err: any) {
    if (_burnHandler) (kit as any).off?.('bridge.burn', _burnHandler);
    const msg = String(err?.message ?? err?.shortMessage ?? err ?? '');
    // Circle SDK KitError: BALANCE (code 9001) — insufficient balance.
    // In gasless mode this typically means the SA's USDC balance dropped below
    // the bridge amount after the Paymaster gas deduction.
    if (/Insufficient.*balance|balance.*insufficient/i.test(msg) || err?.code === 9001) {
      const chainLabel = from?.label ?? p.fromNetwork;
      const isGasless = !!_gaslessAddress;
      if (isGasless) {
        throw new Error(
          `Insufficient USDC balance on ${chainLabel}. ` +
          `In gasless mode the Smart Account needs the bridge amount PLUS Paymaster gas fees (~0.3 USDC). ` +
          `Please add at least 0.3 USDC extra to your wallet and try again.`
        );
      }
      throw new Error(
        `Insufficient ${p.token} balance on ${chainLabel}. ` +
        `Please add funds and try again.`
      );
    }
    // "Max fee must be less than amount" → transfer amount too small to cover relay fee
    // Arc: relay fee ~0.054 USDC, so minimum bridge amount = ~0.06 USDC
    // Any chain: if this fires, the amount is smaller than the relay fee
    if (/max fee must be less than amount/i.test(msg)) {
      const chainLabel = from?.label ?? p.fromNetwork;
      throw new Error(
        `Bridge amount too small. The Orbit Relayer fee (~0.054 USDC) exceeds your transfer amount on ${chainLabel}. ` +
        `Please enter at least 0.10 USDC and try again.`
      );
    }
    // CCTPX route error — surface a meaningful message to the user
    if (/route.*could not be determined|CCTPXBridgingProvider|route check/i.test(msg)) {
      throw new Error(
        `Bridge route for ${p.token} between ${from?.label ?? p.fromNetwork} and ${to?.label ?? p.toNetwork} is temporarily unavailable. ` +
        `Please try USDC or try again later.`
      );
    }
    // Allowance / approve error — instruct the user to approve token spending
    if (/insufficient allowance|approve.*required|allowance/i.test(msg)) {
      throw new Error(
        `Token approval required. Please approve ${p.token} spending in your wallet and try again.`
      );
    }
    throw err;
  } finally {
    // Always clean up the burn event subscription
    if (_burnHandler) (kit as any).off?.('bridge.burn', _burnHandler);
  }

  // ── Transaction evidence check ──────────────────────────────
  // A step with txHash = burn TX was submitted to the blockchain.
  // In gasless mode, the UserOperation hash is returned as the top-level hash.
  // No evidence at all = wallet signed nothing (popup dismissed / rejected).
  const hasEvidence =
    result?.steps?.some((s: any) => s.txHash || s.explorerUrl) ||
    Boolean(result?.hash) ||   // gasless: top-level UserOp hash
    Boolean(result?.txHash);   // some SDK versions return txHash at root

  if (!hasEvidence) {
    // Nothing was submitted — treat as user rejection regardless of reported state.
    const err: any = new Error('User rejected the request.');
    err.result = result;
    throw err;
  }

  // ── state: 'pending' + evidence → Bridge submitted, CCTP attestation in progress ──
  // This is the NORMAL outcome for Arbitrum, Arc, and other non-Base chains:
  // the burn TX was mined but the Circle attestation service hasn't relayed the mint
  // yet. The SDK returns 'pending' instead of blocking indefinitely.
  // Callers should treat this as a successful submission — the mint completes
  // automatically via Circle's CCTP relayer (no user action needed).
  if (result?.state === 'pending') {
    // Mark it so BridgeTab can show the right UI
    result._submitted = true;
    return result;
  }

  // ── state: 'error' → a step failed after TX was submitted ───
  if (result?.state === 'error') {
    const failedStep = result?.steps?.find((s: any) => s.state === 'error');
    const rawReason  = failedStep?.error?.message ?? failedStep?.errorMessage ?? failedStep?.error ?? '';
    const reason     = String(rawReason);

    // ── Mint / Forward failed → retry UI ────────────────────────────────────
    // With useForwarder: true, the Orbit Relayer handles mint automatically.
    // Possible failures:
    //   - forwardState: 'FAILED' → code 3003 NETWORK_RELAYER_FORWARD_FAILED
    //   - fetchRelayerMint poll timeout → code 3002 NETWORK_TIMEOUT
    //   - manual retry if relayer didn't confirm
    const isForwardFailure =
      (failedStep?.name === 'mint' || failedStep?.name === 'forward') &&
      (
        /relayer.*failed.*forward|NETWORK_RELAYER_FORWARD_FAILED/i.test(reason) ||
        failedStep?.error?.name  === 'NETWORK_RELAYER_FORWARD_FAILED' ||
        failedStep?.error?.code  === 3003 ||
        String(failedStep?.error?.code) === '3003' ||
        failedStep?.errorCategory === 'failed_offchain' ||
        /insufficient.*funds|out of gas|gas.*required|gas.*limit/i.test(reason) ||
        /user rejected|rejected the request/i.test(reason)
      );

    // Attestation OR forward poll timed out but burn TX is confirmed on-chain.
    // The relayer may still deliver — surface as a pending bridge, not an error.
    //
    // With useForwarder:true, there are TWO possible timeout steps:
    //   1. 'fetchAttestation' step: IRIS API didn't return attestation in time (code 3002)
    //   2. 'forward' step: relayer was processing but didn't reach CONFIRMED in time (code 3002)
    // Both mean the burn is on-chain and the relayer IS still working server-side.
    // Treating either as _submitted keeps the UI in "relay in progress" state.
    const isAttestationTimeout =
      (failedStep?.name === 'fetchAttestation' || failedStep?.name === 'forward') &&
      (
        failedStep?.errorCategory === 'polling_timeout' ||
        failedStep?.error?.code   === 3002 ||
        String(failedStep?.error?.code) === '3002' ||
        /NETWORK_TIMEOUT|timeout/i.test(reason)
      );

    if (isAttestationTimeout && hasEvidence) {
      // Burn is on-chain but attestation poll timed out.
      // Mark as _submitted so BridgeTab shows "relay in progress" toast, not error.
      result._submitted = true;
      return result;
    }

    if (isForwardFailure && hasEvidence) {
      // Burn TX confirmed on-chain, relayer failed to deliver the mint.
      // SDK retryBridge() resumes from the forward/attestation step automatically.
      // AppKit v1.16: retryContext = { from: adapter, to: adapter } bare adapter instances
      try {
        const retryResult: any = await kit.retryBridge(result, {
          from: _adapter,
          to:   _adapter,
        } as any);
        // Retry succeeded → use retryResult for the rest of the flow
        result = retryResult;
      } catch (retryErr: any) {
        const retryMsg = String(retryErr?.message ?? retryErr ?? '');
        // Inform user they need gas on destination for manual mint
        const isGas = /insufficient.*funds|out of gas|gas.*required|gas.*limit/i.test(retryMsg);
        const chainLabel = to?.label ?? p.toNetwork;
        // Preserve result so BridgeTab Retry button can surface it
        const autoRetryErr: any = new Error(
          isGas
            ? `Bridge submitted ✅ but auto-relay failed. To complete the bridge, you need ETH for gas on ${chainLabel}. Please add ETH to your ${chainLabel} wallet and use Retry.`
            : retryMsg.length > 0 && retryMsg.length < 300
              ? retryMsg
              : `Bridge submitted ✅ but mint on ${chainLabel} failed. Use the Retry button to complete the transfer.`,
        );
        autoRetryErr.result = result;
        throw autoRetryErr;
      }
    } else if (!isForwardFailure && !isAttestationTimeout) {
      const errMsg = reason.length > 0 ? reason : 'Bridge transaction failed';
      const err: any = new Error(errMsg);
      err.result = result;
      throw err;
    }
  }

  return result;
}

// ── Bridge retry ────────────────────────────────────────────
/** Retries a previously failed or stuck bridge transfer using the original result object. */
export async function retryBridge(result: any) {
  if (!_adapter) throw new Error('Wallet not connected.');
  const kit = getKit();
  // AppKit v1.16 retryBridge expects { from: adapter, to: adapter } — bare adapters, not wrapped objects.
  // In gasless mode we pass the same adapter for both sides; the SDK re-uses the burn TX context
  // and the recipientAddress was already encoded in the original depositForBurn call on-chain,
  // so retryBridge only needs to re-submit receiveMessage — recipient doesn't change here.
  return kit.retryBridge(result, {
    from: _adapter,
    to:   _adapter,
  } as any);
}

// ── Swap ────────────────────────────────────────────────────
/** Estimates the output and fee for a same-chain or cross-chain swap. */
export async function estimateSwap(p: {
  network: string; tokenIn: string; tokenOut: string; amountIn: string;
  slippageBps?: number;
  toChain?: string;
  toRecipientAddress?: string;
}) {
  await ensureAdapter();
  if (!_adapter) throw new Error('Wallet not connected.');
  if (!VALID_NETWORK_IDS.has(p.network)) throw new Error('Invalid network selection.');

  const kit = getKit();
  const net = NETWORKS.find(n => n.id === p.network);
  if (!net?.sdkSwap) throw new Error(`Swap not supported on ${net?.label ?? p.network}.`);

  // Always use the EOA adapter for swap estimation — permit signing must go through
  // the EOA (MetaMask account), not the Smart Account address.
  const swapAdapter = _rawAdapter ?? _adapter;

  const toField = p.toChain
    ? { to: { chain: p.toChain as any, ...(p.toRecipientAddress ? { recipientAddress: p.toRecipientAddress as `0x${string}` } : {}) } }
    : {};

  return kit.estimateSwap({
    from:     { adapter: swapAdapter, chain: net.sdkSwap },
    tokenIn:  p.tokenIn  as any,
    tokenOut: p.tokenOut as any,
    amountIn: p.amountIn,
    config:   { slippageBps: p.slippageBps ?? 50 },
    ...toField,
  } as any);
}

/** Executes a same-chain or cross-chain token swap. */
export async function executeSwap(p: {
  network: string; tokenIn: string; tokenOut: string; amountIn: string;
  slippageBps?: number;
  toChain?: string;
  toRecipientAddress?: string;
}) {
  await ensureAdapter();
  if (!_adapter) throw new Error('Wallet not connected.');
  if (!VALID_NETWORK_IDS.has(p.network)) throw new Error('Invalid network selection.');

  const kit = getKit();
  const net = NETWORKS.find(n => n.id === p.network);
  if (!net?.sdkSwap) throw new Error(`Swap not supported on ${net?.label ?? p.network}.`);

  // ── Auto-fund Smart Account when gasless is active ────────
  if (_gaslessMode && _gaslessAddress && net?.chainId && net?.rpc) {
    await autoFundSmartAccount(
      net.chainId,
      net.rpc,
      _gaslessAddress as `0x${string}`,
      p.amountIn,
    );
  }

  // Always use the EOA adapter for swap execution — Circle SDK generates an
  // EIP-2612 permit during kit.swap(). The permit owner must be the EOA address.
  // In gasless mode, _adapter reports the Smart Account address which MetaMask
  // doesn't control → "Permit generation failed: not authorized".
  // _rawAdapter is set on wallet connect and never overwritten by connectGasless.
  const swapAdapter = _rawAdapter ?? _adapter;

  const toField = p.toChain
    ? { to: { chain: p.toChain as any, ...(p.toRecipientAddress ? { recipientAddress: p.toRecipientAddress as `0x${string}` } : {}) } }
    : {};

  return kit.swap({
    from:     { adapter: swapAdapter, chain: net.sdkSwap },
    tokenIn:  p.tokenIn  as any,
    tokenOut: p.tokenOut as any,
    amountIn: p.amountIn,
    config:   { slippageBps: p.slippageBps ?? 50 },
    ...toField,
  } as any);
}

// ── Wait for swap completion ────────────────────────────────
// Wraps kit.waitForSwap — polls until terminal status or timeoutMs elapses.
// On timeout the SDK throws a RETRYABLE KitError; callers should inform the
// user and offer a retry with the same txHash.
/** Polls until the swap reaches a terminal status or timeoutMs elapses. On timeout the SDK throws a retryable KitError. */
export async function waitForSwap(swapResult: any, timeoutMs: number): Promise<any> {
  const kit = getKit();
  return (kit as any).waitForSwap({
    ...swapResult,
    timeoutMs,
  });
}

// ── Unified Balance ──────────────────────────────────────────
// Uses kit.unifiedBalance.getBalances() (Circle SDK official API) when adapter
// is available, otherwise falls back to per-chain ERC-20 RPC reads.
/** Fetches aggregated USDC balances across all supported chains. Falls back to per-chain RPC reads when SDK adapter is unavailable.
 *  @param overrideAddress - optional wallet address from wagmi; used in fallback path when SDK adapter is not available
 */
export async function fetchUnifiedBalance(overrideAddress?: string): Promise<UnifiedBalance> {
  await ensureAdapter();

  // ── Resolve wallet address ─────────────────────────────────────────────────
  // Priority: overrideAddress → provider eth_accounts → adapter.address sync → adapter.getAddress()
  let resolvedAddress: string | null = overrideAddress ?? null;

  if (!resolvedAddress) {
    try {
      const provider = getMetaMaskProvider();
      if (provider?.request) {
        const accounts: string[] = await provider.request({ method: 'eth_accounts' });
        resolvedAddress = accounts?.[0] ?? null;
      }
    } catch { /* ignore */ }
  }

  if (!resolvedAddress && _adapter) {
    if (typeof (_adapter as any).address === 'string') {
      resolvedAddress = (_adapter as any).address;
    } else if (typeof (_adapter as any).getAddress === 'function') {
      try {
        const r = (_adapter as any).getAddress();
        resolvedAddress = r instanceof Promise ? await r : r;
      } catch { /* ignore */ }
    }
  }

  if (!resolvedAddress && !_adapter) {
    return { chains: [], total: '0.000000' };
  }

  // ── Query Gateway with explicit deposit chains ─────────────────────────────
  // depositChains: all networks with a Gateway bridge EXCEPT Arc
  // (Arc is the destination, not a source for deposits)
  const depositChains = NETWORKS
    .filter(net => net.sdkBridge && net.id !== 'Arc')
    .map(net => net.id);  // ['Ethereum', 'Arbitrum', 'Base']

  try {
    const kit = getKit();

    // Build sources: prefer adapter+chains (adapter resolves address via getAddress(chain) internally)
    // over address+chains. Both paths ultimately hit the same Gateway API,
    // but adapter path avoids any kit-level address validation that could throw.
    // Fall back to address+chains only when adapter is unavailable.
    const sources = _adapter
      ? { adapter: _adapter, chains: depositChains }
      : { address: resolvedAddress!, chains: depositChains };

    const result = await (kit.unifiedBalance as any).getBalances({
      token:          'USDC',
      sources,
      networkType:    'mainnet',
      includePending: true,
    });

    // VISIBLE log — shows confirmed vs pending breakdown
    // SDK returns:
    //   totalConfirmedBalance: string   — spendable (confirmed) total
    //   totalPendingBalance?:  string   — in-flight deposits
    //   breakdown: [{
    //     depositor, totalConfirmed, totalPending?,
    //     breakdown: [{ chain, confirmedBalance, pendingBalance? }]
    //   }]
    const totalConfirmed = parseFloat(result?.totalConfirmedBalance ?? '0') || 0;
    const totalPending   = parseFloat(result?.totalPendingBalance   ?? '0') || 0;
    const depositorRows: any[] = Array.isArray(result?.breakdown) ? result.breakdown : [];

    // Flatten per-chain balances (confirmed + pending) across all depositors
    const chainConfirmed = new Map<string, number>();
    const chainPending   = new Map<string, number>();
    for (const dep of depositorRows) {
      for (const cb of (dep.breakdown ?? [])) {
        const chainId: string = cb.chain ?? '';
        const conf  = parseFloat(cb.confirmedBalance ?? '0') || 0;
        const pend  = parseFloat(cb.pendingBalance   ?? '0') || 0;
        chainConfirmed.set(chainId, (chainConfirmed.get(chainId) ?? 0) + conf);
        chainPending.set(chainId,   (chainPending.get(chainId)   ?? 0) + pend);
      }
    }

    const chains = NETWORKS
      .filter(net => net.sdkBridge && net.id !== 'Arc')
      .map(net => {
        const conf = chainConfirmed.get(net.id) ?? chainConfirmed.get(net.sdkBridge ?? '') ?? 0;
        const pend = chainPending.get(net.id)   ?? chainPending.get(net.sdkBridge   ?? '') ?? 0;
        return {
          netId:         net.id,
          label:         net.label,
          logo:          net.logo,
          balance:       conf.toFixed(6),
          pendingBalance: pend > 0 ? pend.toFixed(6) : undefined,
        };
      });

    return {
      chains,
      total:          totalConfirmed.toFixed(6),
      pendingTotal:   totalPending > 0 ? totalPending.toFixed(6) : undefined,
    };
  } catch {
    return {
      chains: NETWORKS
        .filter(net => net.sdkBridge && net.id !== 'Arc')
        .map(net => ({ netId: net.id, label: net.label, logo: net.logo, balance: '0.000000' })),
      total: '0.000000',
    };
  }
}

/**
 * Deposits USDC from the connected wallet on the given source chain into the
 * Unified Balance (Circle Gateway).  Must be called before spend().
 *
 * The wallet is switched to the source chain before depositing so the
 * SDK does not receive a chain-mismatch error.
 *
 * @param sourceChain     - App network ID, e.g. 'Base'
 * @param amount          - Human-readable amount string, e.g. "5.00"
 * @param token           - Token symbol, e.g. 'USDC'
 * @param switchAsync     - wagmi switchChainAsync helper (passed from UI)
 */
export async function executeUnifiedDeposit(p: {
  sourceChain: string;
  amount: string;
  token: string;
  switchAsync: (args: { chainId: number }) => Promise<unknown>;
}) {
  await ensureAdapter();
  if (!_adapter) throw new Error('Wallet not connected.');

  const kit = getKit();
  const n = parseFloat(p.amount);
  if (!isFinite(n) || n <= 0) throw new Error('Invalid amount.');
  const amountStr = n.toFixed(6).replace(/\.?0+$/, '');

  // Switch wallet to the source chain BEFORE depositing.
  // deposit() requires the adapter to be on the same chain as `from.chain`.
  const srcNet = NETWORKS.find(net => net.id === p.sourceChain);
  if (!srcNet) throw new Error(`Unknown source chain: ${p.sourceChain}`);
  await ensureOnChain(srcNet.id, srcNet.chainId, p.switchAsync);

  const rawDeposit: any = await kit.unifiedBalance.deposit({
    from:   { adapter: _adapter, chain: srcNet.sdkBridge as any },
    amount: amountStr,
    token:  p.token as any,
  } as any);

  // deposit() may return a txHash string OR an object like { txHash, hash, ... }
  const txHash =
    typeof rawDeposit === 'string' ? rawDeposit :
    (rawDeposit?.txHash ?? rawDeposit?.hash ?? rawDeposit?.transactionHash ?? '');

  return { txHash, sourceChainId: srcNet.id };
}

/** Executes a unified balance spend — pulls USDC from Gateway and sends to Arc Network. */
export async function executeUnifiedSpend(p: {
  amount:       string;
  token:        string;
  toAddress:    string;
  cachedUbData?: import('../types').UnifiedBalance;
}) {
  await ensureAdapter();
  if (!_adapter) throw new Error('Wallet not connected.');
  if (!isValidAddress(p.toAddress)) throw new Error('Invalid recipient address.');

  const kit = getKit();

  const nRaw = parseFloat(p.amount);
  if (!isFinite(nRaw) || nRaw <= 0) throw new Error('Invalid amount.');
  const microTotal = Math.round(nRaw * 1_000_000);
  const amountStr  = (microTotal / 1_000_000).toFixed(6);

  // ── Unified Balance fee ───────────────────────────────────────────────────
  // Per Circle docs: customFee.amount is in micro-USDC (6 decimals).
  // Formula: fee = amount × ubFeeBps / 10_000
  // Minimum: 1 micro-USDC (0.000001) to satisfy SDK invariant when recipient is set.
  const contractAddr = import.meta.env.VITE_CONTRACT_ADDRESS ?? '';
  const ubFeeBps     = Math.min(Math.max(0, Number(import.meta.env.VITE_UNIFIED_BALANCE_FEE_BPS ?? 10)), MAX_FEE_BPS);
  const ubFeeAmount  = Math.max(1, Math.round(nRaw * ubFeeBps / 10_000 * 1_000_000)); // in micro-USDC

  // ── Step 1: Resolve wallet address ────────────────────────────────────────
  // Use eth_accounts directly — adapter.getAddress() requires a ChainDefinition
  // param and throws without it. eth_accounts always works regardless of chain.
  let walletAddr: string | null = null;
  try {
    const provider = getMetaMaskProvider();
    if (provider?.request) {
      const accounts: string[] = await provider.request({ method: 'eth_accounts' });
      walletAddr = accounts?.[0] ?? null;
    }
  } catch { /* ignore — fall through to cachedUbData */ }

  // ── Step 2: Fetch fresh per-chain Gateway balance ─────────────────────────
  // fetchUnifiedBalance resolves address via eth_accounts internally too,
  // so passing walletAddr makes the resolution explicit and avoids double-fetch.
  let ubData = await fetchUnifiedBalance(walletAddr ?? undefined);

  // Fallback: if fresh fetch returns all zeros, use UI-cached balance
  // (this covers the case where Gateway API is temporarily unavailable)
  const freshHasChainBal = ubData.chains.some(
    c => Math.round(parseFloat(c.balance) * 1_000_000) > 0
  );
  if (!freshHasChainBal && p.cachedUbData) {
    const cachedHasBal = p.cachedUbData.chains.some(
      c => Math.round(parseFloat(c.balance) * 1_000_000) > 0
    );
    if (cachedHasBal) ubData = p.cachedUbData;
  }

  if (parseFloat(ubData.total) < nRaw - 0.000001) {
    const avail = parseFloat(ubData.total);
    const pendingStr = ubData.pendingTotal && parseFloat(ubData.pendingTotal) > 0
      ? ` (${parseFloat(ubData.pendingTotal).toFixed(2)} USDC still confirming — wait a minute and try again)`
      : '';
    throw new Error(
      avail <= 0
        ? `No Unified Balance available. Please deposit USDC using the ① Deposit tab first, then try again.${pendingStr}`
        : `Insufficient Unified Balance. Available: ${avail.toFixed(2)} USDC, required: ${nRaw.toFixed(2)} USDC${pendingStr}`
    );
  }

  // ── Step 3: Validate balance exists (Gateway API check) ──────────────────
  // ── Step 3: Validate balance exists (fast-fail before MetaMask) ─────────
  const chainsWithBal = ubData.chains
    .filter(c => Math.round(parseFloat(c.balance) * 1_000_000) > 0);

  if (chainsWithBal.length === 0) {
    throw new Error(
      'No Unified Balance available. Please deposit USDC using the ① Deposit tab first, then try again.'
    );
  }

  // ── Step 4: Re-fetch balance right before spend (fast-fail before MetaMask) ──
  // Guards against spending stale cached balance that was already spent.
  //
  // IMPORTANT: Circle Gateway transiently returns totalConfirmedBalance:"0" for
  // a few seconds right after a previous spend settles. To avoid a false-positive
  // block we compare BOTH the fresh result AND the cached ubData:
  //   • If fresh > 0           → use fresh (authoritative)
  //   • If fresh = 0, cache > 0 → Circle still settling → trust cache, proceed
  //   • If both = 0            → genuinely empty → block with clear message
  const preSpendUb    = await fetchUnifiedBalance(walletAddr ?? undefined);
  const preSpendFresh = parseFloat(preSpendUb.total);
  const preSpendCache = parseFloat(ubData.total);
  // Use whichever is higher — avoids false block during Circle settle window
  const effectiveTotal = Math.max(preSpendFresh, preSpendCache);
  if (effectiveTotal <= 0) {
    throw new Error(
      'No Unified Balance available. Please deposit USDC using the ① Deposit tab first, then try again.'
    );
  }
  if (effectiveTotal < nRaw - 0.000001) {
    throw new Error(
      `Insufficient balance. Available: ${effectiveTotal.toFixed(4)} USDC, required: ${nRaw.toFixed(4)} USDC`
    );
  }

  // ── Pre-spend fee check (fast-fail before MetaMask) ──────────────────────
  // Circle auto-allocation returns 9001 BEFORE MetaMask if the amount exceeds
  // the chain-fee-adjusted maximum. We replicate the same per-chain fee
  // estimates used by maxSendable() in UnifiedTab to catch this early.
  //
  // Fee buffers MUST match UnifiedTab.tsx CHAIN_FEE_BUFFER exactly.
  //
  // Ethereum → Arc CCTP fee: highly variable L1 gas cost.
  // Observed range: 1.00–2.00+ USDC depending on Ethereum gas price.
  //
  // STRATEGY: set Ethereum buffer > typical ETH balance so ETH contributes 0
  // to maxSendable(). This forces Circle auto-allocation to use ONLY Base and
  // Arbitrum (cheap routes, ~0.06 USDC fee each) and never touch Ethereum as a
  // source. The user can bridge ETH Sepolia USDC to Base first if they want to
  // use it.
  //
  // If a user has > 5 USDC on Ethereum, it will start contributing again.
  // Fee buffers sourced directly from Circle SDK's GAS_FEE_BY_CHAIN map
  // (node_modules/@circle-fin/unified-balance-kit/index.mjs):
  //   Ethereum: 2.00 USDC  ← confirmed from SDK source
  //   Base:     0.01 USDC
  //   Arbitrum: 0.01 USDC
  //
  // We add a safety margin on top: Base/Arb +0.09, Ethereum +0.10.
  // IMPORTANT: These values MUST stay in sync with CHAIN_FEE_BUFFER in UnifiedTab.tsx.
  const CHAIN_FEE_BUFFER_SDK: Record<string, number> = {
    Base:      0.10,  // SDK gas fee 0.01 USDC + 0.09 USDC margin
    Arbitrum:  0.10,  // SDK gas fee 0.01 USDC + 0.09 USDC margin
    Ethereum:  2.10,  // SDK gas fee 2.00 USDC + 0.10 USDC margin
    Arc:       0.01,  // SDK gas fee 0.001 USDC + 0.009 USDC margin
  };
  const DEFAULT_FEE_SDK = 2.10;
  const effectiveMax = ubData.chains
    .filter(c => parseFloat(c.balance) > 0.015)
    .reduce((sum, c) => {
      const fee = CHAIN_FEE_BUFFER_SDK[c.netId] ?? DEFAULT_FEE_SDK;
      return sum + Math.max(0, parseFloat(c.balance) - fee);
    }, 0);
  if (nRaw > effectiveMax + 0.000001) {
    throw new Error(
      `Amount too high. Max sendable after network fees: ${effectiveMax.toFixed(4)} USDC. Use the MAX button.`
    );
  }

  // ── Step 5: Call spend() with auto-allocation ───────────────────────────
  // ── Auto-allocation: Circle chooses source chains ────────────────────────
  // We previously used explicit allocations to control per-chain amounts, but
  // this caused 9001 BALANCE_INSUFFICIENT errors because different routes have
  // very different maxFee requirements:
  //   - Base → Arc: maxFee ≈ 0.06 USDC  (cheap route)
  //   - Ethereum → Arc: maxFee ≈ 1.00–1.30 USDC (expensive route)
  //
  // With explicit allocation we'd request 2.94 USDC from ETH but Circle
  // reserved 2.94 + 1.30 = 4.24 USDC — exceeding ETH's 3.04 USDC balance → 9001.
  //
  // Auto-allocation delegates this entirely to Circle: the SDK knows each
  // route's fee structure and allocates optimally without 9001 errors.
  // Official docs: https://docs.arc.io/app-kit/unified-balance (Quick look)
  //
  // CRITICAL: `to` MUST include `adapter` per official SDK docs:
  //   https://docs.arc.io/app-kit/quickstarts/unified-balance-deposit-and-spend
  //   The `to` field requires { adapter, chain, recipientAddress }.
  //   Without adapter, spend() may fail with "missing adapter" or silently misroute.

  // Reset AppKit singleton before each spend to clear any stale internal state.
  resetKit();
  const freshKit = getKit();

  try {
    return await freshKit.unifiedBalance.spend({
      amount: amountStr,
      from: { adapter: _adapter },
      to: {
        adapter:          _adapter,
        chain:            'Arc' as const,
        recipientAddress: p.toAddress as `0x${string}`,
      },
      token: (p.token || 'USDC') as any,
      // Per-spend custom fee: collected by ArcleFX contract on Arc Mainnet.
      // Only applied when a valid contract address is configured.
      ...(isValidAddress(contractAddr) && ubFeeBps > 0 ? {
        config: {
          customFee: {
            amount:           String(ubFeeAmount),  // micro-USDC (6 decimals)
            recipientAddress: contractAddr,
          },
        },
      } : {}),
    } as any);
  } catch (err: any) {
    const msg = String(err?.message ?? err?.cause?.message ?? err ?? '');
    const isBalanceInsufficient =
      err?.code === 9001 ||
      /BALANCE_INSUFFICIENT|insufficient.*balance|balance.*insufficient/i.test(msg);

    if (isBalanceInsufficient) {
      const available = msg.match(/Available:\s*([\d.]+)\s*USDC/i)?.[1];
      const required  = msg.match(/required:\s*([\d.]+)\s*USDC/i)?.[1];
      if (available && required) {
        const avail = parseFloat(available);
        const req   = parseFloat(required);
        throw new Error(
          `Insufficient balance on one of the source chains (available: ${avail.toFixed(4)} USDC, needed: ${req.toFixed(4)} USDC). ` +
          `Try a smaller amount or use the MAX button.`
        );
      }
      // BALANCE_INSUFFICIENT without exact breakdown — likely Ethereum fee underestimate.
      // Guide user to use MAX button which already accounts for per-chain fee buffers.
      throw new Error(
        `Insufficient balance to cover network fees. The Ethereum route requires ~1.30+ USDC in fees. ` +
        `Try a smaller amount or use the MAX button for the safe maximum.`
      );
    }
    throw err;
  }
}
