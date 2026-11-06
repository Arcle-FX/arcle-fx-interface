// ============================================================
//  Circle Paymaster — Gasless (ERC-4337) Integration
// ============================================================
//  Lets users pay gas in USDC — NO ETH required for bridge ops.
//
//  Architecture:
//    • All chains use EntryPoint v0.7 + Circle v0.7 Paymaster (0x31BE...)
//      with standard CREATE2 SimpleAccount (eip7702: false).
//
//    • Paymaster data: mode=1 allowance (NO permit signature needed)
//        encodePacked(["uint8","address","uint256"],
//                     [1, usdcAddress, maxCost])
//
//      Circle v0.7 Paymaster validatePaymasterUserOp:
//        → reads mode byte; mode=1 → calls USDC.transferFrom(SA, paymaster, actualCost)
//        → requires SA to have prior USDC allowance for the paymaster
//        → sdk.ts autoFundSmartAccount deploys SA + sets maxUint256 allowance (one-time ETH tx)
//
//    • EIP-7702 path (mode=0 permit) is available for v0.8 paymaster chains only.
//      Currently NO v0.8-only testnet chain is configured — all use v0.7.
//
//  ROOT CAUSE (AA33 reverted ERC20: transfer amount exceeds allowance):
//
//  Previously getPaymasterData sent mode=0 permit to Circle v0.7 Paymaster.
//  v0.7 Paymaster does NOT parse a permit signature from paymasterData —
//  it calls transferFrom directly. The permit was ignored → allowance stayed 0
//  → transferFrom reverted → AA33.
//
//  Fix: use mode=1 for all v0.7 chains. Allowance is pre-set by sdk.ts.
//
//  Sources:
//    developers.circle.com/paymaster
//    developers.circle.com/paymaster/addresses-and-events
// ============================================================

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  encodePacked,
  encodeFunctionData,
  parseUnits,
  maxUint256,
  hexToBigInt,
  parseErc6492Signature,
  type Chain,
  type Hex,
} from 'viem';
import { arbitrum, base, mainnet }                                          from 'viem/chains';
import { entryPoint07Address, entryPoint08Address }                        from 'viem/account-abstraction';
import { createBundlerClient }                                            from 'viem/account-abstraction';
import { toSimpleSmartAccount }                                           from 'permissionless/accounts';
import { getSenderAddress }                                               from 'permissionless/actions';
import { OFFICIAL_RPC }                                                   from '../config/constants';

// ── v0.7 factory address (Arbitrum, Base, Ethereum) ──
const SA_FACTORY_V07_ADDR = '0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985' as `0x${string}`;

// ── Compute SA address for Ethereum Mainnet ───────────────────
// Uses v0.7 factory (EOA-callable) + v0.8 EntryPoint getSenderAddress.
// Returns the CREATE2 SA address for a given EOA on Ethereum Mainnet.
async function computeEthMainnetSmartAccountAddress(
  publicClient: ReturnType<typeof createPublicClient>,
  eoaAddress: `0x${string}`,
  epAddress: `0x${string}`,
): Promise<`0x${string}` | undefined> {
  try {
    const factoryData = encodeFunctionData({
      abi: [{
        name: 'createAccount', type: 'function', stateMutability: 'nonpayable',
        inputs: [{ type: 'address', name: 'owner' }, { type: 'uint256', name: 'salt' }],
        outputs: [{ type: 'address' }],
      }],
      functionName: 'createAccount',
      args: [eoaAddress, 0n],
    });
    const saAddr = await getSenderAddress(publicClient, {
      factory:          SA_FACTORY_V07_ADDR,
      factoryData,
      entryPointAddress: epAddress,
    } as any);
    return saAddr as `0x${string}`;
  } catch (e: any) {
    return undefined;
  }
}

// ── Circle Paymaster addresses ───────────────────────────────
//    Source: developers.circle.com/paymaster/addresses-and-events
//    v0.7 mainnet: Arbitrum One, Base, Ethereum
//    v0.8 mainnet: Arbitrum One, Base, Ethereum
export const CIRCLE_PAYMASTER = {
  v07:         '0x31BE08D380A21fc740883c0BC434FcFc88740b58' as `0x${string}`,
  v08:         '0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966' as `0x${string}`,
  v07_mainnet: '0x6C973eBe80dCD8660841D4356bf15c32460271C9' as `0x${string}`,
  v08_mainnet: '0x0578cFB241215b77442a541325d6A4E6dFE700Ec' as `0x${string}`,
} as const;

// ── Per-chain EntryPoint + Paymaster ─────────────────────────
type EntryPointConfig = {
  address:      `0x${string}`;
  version:      '0.7' | '0.8';
  paymaster:    `0x${string}`;
  // eip7702=false (all current chains):
  //   Standard CREATE2 SimpleAccount.
  //   v0.7 chains (Arb/Base): SA deployed by v0.7 factory (EOA-callable), mode=1 allowance.
  //   v0.8 chains (Eth Sep):  SA deployed by EntryPoint atomically (v0.8 factory), mode=0 permit (ERC-1271).
  //
  // eip7702=true (reserved for future chains where MetaMask supports signAuthorization):
  //   SA address = EOA address, code delegated. mode=0 permit (plain ecrecover, no ERC-1271).
  //   NOT used on any current testnet — MetaMask json-rpc accounts don't support signAuthorization.
  eip7702:      boolean;
};

const CHAIN_ENTRYPOINT: Record<number, EntryPointConfig> = {
  //  Arbitrum One — v0.7 EntryPoint + v0.7 Circle Paymaster
  //  SA: CREATE2 SimpleAccount (v0.7 factory, EOA-callable)
  //  Paymaster data: mode=1 allowance (SA pre-approves paymaster in sdk.ts)
  [arbitrum.id]: { address: entryPoint07Address, version: '0.7', paymaster: CIRCLE_PAYMASTER.v07_mainnet, eip7702: false },
  //  Base Mainnet — v0.7 EntryPoint + v0.7 Circle Paymaster
  //  SA: CREATE2 SimpleAccount (v0.7 factory, EOA-callable)
  //  Paymaster data: mode=1 allowance (SA pre-approves paymaster in sdk.ts)
  [base.id]:     { address: entryPoint07Address, version: '0.7', paymaster: CIRCLE_PAYMASTER.v07_mainnet, eip7702: false },
  //
  //  Ethereum Mainnet: Circle v0.7 Paymaster uses mode=1 allowance.
  //  Bridge FROM Ethereum: transactions routed through regular ETH gas (_rawProvider) in sdk.ts.
  //  See: EIP-1193 shim → isGaslessChain check → _rawProvider.request fallthrough.
};

// ── USDC addresses on gasless-supported mainnets ─────────────
// Ethereum Mainnet excluded — ETH gas used for bridge transactions.
const USDC_ADDRESS: Record<number, `0x${string}`> = {
  [arbitrum.id]: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  [base.id]:     '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};

// ── Supported chains ─────────────────────────────────────────
// Ethereum Mainnet excluded — ETH gas is used for bridge transactions.
const SUPPORTED_CHAINS: Record<number, Chain> = {
  [arbitrum.id]: arbitrum,
  [base.id]:     base,
};

// ── Bundler RPC (Alchemy ERC-4337) ───────────────────────────
// Alchemy is the official ERC-4337 bundler used for Circle Paymaster gasless flow.
// Docs: https://docs.alchemy.com/reference/bundler-api-quickstart
const ALCHEMY_API_KEY = import.meta.env.VITE_ALCHEMY_API_KEY as string;

// Chain ID → Alchemy bundler network slug
// Source: https://docs.alchemy.com/reference/bundler-api-quickstart
const ALCHEMY_NETWORK: Record<number, string> = {
  [arbitrum.id]: 'arb-mainnet',
  [base.id]:     'base-mainnet',
};

function bundlerRpc(chainId: number): string {
  const network = ALCHEMY_NETWORK[chainId];
  if (!network) throw new Error(`Gasless mode not supported on chain ${chainId}`);
  return `https://${network}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
}

// ── EIP-2612 ABI (nonces + name + version) ───────────────────
const EIP2612_READ_ABI = [
  { name: 'nonces',  type: 'function' as const, stateMutability: 'view' as const, inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'name',    type: 'function' as const, stateMutability: 'view' as const, inputs: [], outputs: [{ type: 'string'  }] },
  { name: 'version', type: 'function' as const, stateMutability: 'view' as const, inputs: [], outputs: [{ type: 'string'  }] },
] as const;

// ── signPermitViaSmartAccount — EOA ECDSA signature via patched smartAccount ──────
//
//  ONLY used for v0.8 / EIP-7702 chains (mode=0 permit paymasterData).
//  v0.7 chains use mode=1 allowance — this function is NOT called for them.
//
//  v0.8 + EIP-7702: SA address = EOA address.
//  USDC.permit(owner=EOA, eoaSig):
//    ecrecover(hash, eoaSig) → EOA == owner → permit passes ✓
//  No ERC-1271 / isValidSignature needed.
//
//  smartAccount.signTypedData is PATCHED to route through
//  chainWalletClient.signTypedData (EOA ECDSA).
//
async function signPermitViaSmartAccount(params: {
  usdcAddress:      `0x${string}`;
  smartAccount:     any;            // toSimpleSmartAccount with patched signTypedData
  spenderAddress:   `0x${string}`;
  chainId:          number;
  publicClient:     ReturnType<typeof createPublicClient>;
  permitAmount:     bigint;
}): Promise<Hex> {
  const {
    usdcAddress, smartAccount, spenderAddress,
    chainId, publicClient, permitAmount,
  } = params;

  const saAddress = smartAccount.address as `0x${string}`;

  // Read permit parameters from USDC contract
  const [nonce, tokenName, tokenVersion] = await Promise.all([
    publicClient.readContract({ address: usdcAddress, abi: EIP2612_READ_ABI, functionName: 'nonces', args: [saAddress] }),
    publicClient.readContract({ address: usdcAddress, abi: EIP2612_READ_ABI, functionName: 'name' }),
    publicClient.readContract({ address: usdcAddress, abi: EIP2612_READ_ABI, functionName: 'version' }).catch(() => '2'),
  ]);

  // NOTE: EIP712Domain is NOT included in types — viem derives it from the domain object.
  // Circle official permit.js also omits EIP712Domain from types when calling walletClient.signTypedData.
  // Including EIP712Domain can cause MetaMask to double-hash the domain separator.
  const permitData = {
    types: {
      Permit: [
        { name: 'owner',    type: 'address' },
        { name: 'spender',  type: 'address' },
        { name: 'value',    type: 'uint256' },
        { name: 'nonce',    type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit' as const,
    domain: {
      name:              tokenName as string,
      version:           String(tokenVersion),
      chainId,
      verifyingContract: usdcAddress,
    },
    message: {
      owner:    saAddress,
      spender:  spenderAddress,
      // Circle official permit.js: convert bigint to string for EIP-712 JSON schema compat
      value:    permitAmount.toString(),
      nonce:    (nonce as bigint).toString(),
      // The paymaster cannot access block.timestamp due to 4337 opcode restrictions
      // so the deadline MUST be MAX_UINT256.
      deadline: maxUint256.toString(),
    },
  };

  // smartAccount.signTypedData is PATCHED → routes through EOA walletClient ✓
  const wrappedPermitSignature: Hex = await smartAccount.signTypedData(permitData);

  // ERC-6492: If the SA is not yet deployed (counterfactual), the signature must be
  // wrapped in ERC-6492 format so the paymaster can validate it by simulating the
  // SA deployment first. Without this, USDC.permit(owner=SA) → SA.isValidSignature
  // has no code → permit fails → AA33.
  //
  // The smartAccount object from toSimpleSmartAccount includes factory details when
  // the SA is counterfactual. signMessage / signTypedData on permissionless accounts
  // returns an ERC-6492 wrapped sig automatically. We parse it back here.
  let sig65: Hex;
  try {
    const parsed = parseErc6492Signature(wrappedPermitSignature);
    sig65 = parsed.signature as Hex;
  } catch {
    // Not ERC-6492 wrapped — raw ECDSA sig (SA already deployed)
    sig65 = wrappedPermitSignature;
  }

  return sig65;
}

// ── Public result type ────────────────────────────────────────
export interface GaslessClientResult {
  smartAccountAddress: `0x${string}`;
  chainId:   number;
  chainName: string;
  // EIP-7702 only (v0.8 chains): initial authorization for the first sendUserOperation.
  // null for v0.7 chains (all current testnet chains).
  authorization: any | null;
  // EIP-7702 only: call this before EACH sendUserOperation to get a fresh authorization
  // with the latest nonce (one-time-use — stale nonce causes "nonce already used").
  // null for v0.7 chains.
  signFreshAuthorization: (() => Promise<any>) | null;
}

// ── Module-level state ────────────────────────────────────────
// NOTE: We store the bundler client (viem/account-abstraction createBundlerClient)
// This aligns with Circle's official quickstart which uses createBundlerClient.
let _bundlerClient: any          = null;
// Saved for reinitForChain — reused when user bridges from a different source chain.
let _provider: any               = null;
let _eoaAddress: `0x${string}` | null = null;
let _bundlerChainId: number | null = null;  // chain the current _bundlerClient was built for

// ── Internal helper: build smartAccount + bundlerClient for a chain ───────
// Extracted so both initGaslessClient (first connect) and reinitForChain
// (source-chain switch) can reuse the same logic without duplication.
//
// All chains use eip7702=false (v0.7 EntryPoint + v0.7 Paymaster):
//   toSimpleSmartAccount() → standard CREATE2 SimpleAccount
//   SA deployed by v0.7 factory (EOA-callable) via sdk.ts autoFundSmartAccount.
//   getPaymasterData sends mode=1 allowance (no permit).
//   sdk.ts pre-approves USDC → paymaster allowance before first UserOp.
//
async function buildBundlerForChain(
  chainId:  number,
  eoaAddress: `0x${string}`,
  provider: any,
): Promise<{ bundlerClient: any; smartAccountAddress: `0x${string}`; authorization: any | null; signFreshAuthorization: (() => Promise<any>) | null }> {
  const chain       = SUPPORTED_CHAINS[chainId];
  const usdcAddress = USDC_ADDRESS[chainId];
  const epConfig    = CHAIN_ENTRYPOINT[chainId];

  if (!chain || !usdcAddress || !epConfig) {
    throw new Error(
      `Gasless not supported on chain ${chainId}. ` +
      `Switch to Arbitrum One, Base Mainnet, or Ethereum Mainnet.`
    );
  }

  const rpcUrl       = chain.rpcUrls.default.http[0];
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  // Chain-specific WalletClient — recreated for each chain to avoid stale chain
  // context from the original initGaslessClient call (critical for reinitForChain).
  const chainWalletClient = createWalletClient({
    account:   eoaAddress,
    chain,
    transport: custom(provider),
  });

// ── Smart Account ─────────────────────────────────────────────────────────
  //
  // All chains: eip7702=false → standard CREATE2 SimpleAccount.
  //   v0.7 (Arb/Base): v0.7 factory (EOA-callable), mode=1 allowance.
  //   v0.8 (Eth Sep):  v0.8 factory (SenderCreator, deployed by EntryPoint on first UserOp), mode=0 permit.
  //
  // v0.7 paymaster mode=1: SA must have prior USDC allowance (sdk.ts autoFundSmartAccount).
  // v0.8 paymaster mode=0 permit: allowance set inline via USDC.permit (ERC-1271 via deployed SA).
  let smartAccount: any;

  if (epConfig.eip7702) {
    // EIP-7702 (reserved, not currently used): SA address = EOA address.
    smartAccount = await toSimpleSmartAccount({
      client:     publicClient,
      owner:      chainWalletClient as any,
      entryPoint: { address: epConfig.address, version: epConfig.version as any },
      eip7702:    true,
    } as any);
  } else {
    // Standard CREATE2 SimpleAccount (v0.7 factory for Arb/Base, v0.8 factory for Eth Sep).
    // permissionless toSimpleSmartAccount picks the correct factory based on entryPoint version.
    smartAccount = await toSimpleSmartAccount({
      client:     publicClient,
      owner:      chainWalletClient as any,
      entryPoint: { address: epConfig.address, version: epConfig.version as any },
    } as any);
  }

  // PATCH signTypedData: override "Simple account isn't 1271 compliant" throw.
  // Route through chainWalletClient.signTypedData (EOA ECDSA) instead.
  //
  // Used only for v0.8 / EIP-7702 chains (mode=0 permit path).
  // For v0.7 (mode=1 allowance), signTypedData is not called by getPaymasterData.
  smartAccount = {
    ...smartAccount,
    signTypedData: async (typedData: any) => chainWalletClient.signTypedData({ account: eoaAddress, ...typedData }),
  };


  // ── EIP-7702 Authorization ──────────────────────────────────────────────
  // Reserved for future chains where EIP-7702 is supported.
  // Currently not used — all mainnet chains use v0.7 Paymaster (mode=1 allowance).
  // sdk.ts calls this before each sendUserOperation (see eth_sendTransaction shim).
  let authorization: any = null;
  const _saAuthContractAddress: `0x${string}` | null = epConfig.eip7702
    ? (smartAccount as any).authorization?.address ?? null
    : null;

  // Helper: sign a fresh EIP-7702 authorization with the latest nonce.
  // Must be called before every sendUserOperation on v0.8 chains.
  const signFreshAuthorization = epConfig.eip7702
    ? async (): Promise<any> => {
        const freshNonce = await publicClient.getTransactionCount({ address: eoaAddress });
        const auth = await chainWalletClient.signAuthorization({
          account:         eoaAddress,
          chainId,
          nonce:           freshNonce,
          contractAddress: _saAuthContractAddress,
        } as any);
        return auth;
      }
    : null;

  if (epConfig.eip7702) {
    // Sign initial authorization for connection validation
    authorization = await signFreshAuthorization!();
  }

  // ── Paymaster module ────────────────────────────────────────────────────
  //  Only define getPaymasterData (NOT getPaymasterStubData).
  //  → single paymaster interaction per UserOp ✓
  //
  //  ROOT CAUSE FIX (Ethereum→Base / Ethereum→Arbitrum AA33):
  //
  //  Circle Paymaster v0.7 (0x31BE...) is allowance-based:
  //    validatePaymasterUserOp calls USDC.transferFrom(SA, paymaster, amount).
  //    It does NOT accept a permit signature in paymasterData (mode=0 with sig).
  //    Sending mode=0+permit to v0.7 paymaster → paymaster cannot decode → AA33.
  //
  //  Circle Paymaster v0.8 (0x3BA9...) is permit-based:
  //    validatePaymasterUserOp decodes paymasterData as
  //    [uint8 mode=0, address token, uint256 amount, bytes sig65] and calls permit.
  //    Source: developers.circle.com/paymaster/pay-gas-fees-usdc.md
  //
  //  Strategy per chain:
  //    v0.7 (Arbitrum One, Base Mainnet):
  //      → mode=1 allowance (no permit sig). SA must have prior USDC allowance
  //        for the paymaster (set by sdk.ts autoFundSmartAccount).
  //      → paymasterData: encodePacked([uint8, address, uint256], [1, usdc, maxAmount])
  //    v0.8 (reserved — not active on any mainnet chain currently):
  //      → mode=0 permit: encodePacked([uint8, address, uint256, bytes], [0, usdc, amount, sig65])
  //
  //  FIX (Base→Arb AA33): always use the chainId captured in the
  //  buildBundlerForChain closure — NOT provider.request('eth_chainId').
  const circlePaymasterModule = {
    async getPaymasterData(_userOp: any) {
      const currentChainId = chainId;
      const currentChain   = SUPPORTED_CHAINS[currentChainId];
      const currentUsdc    = USDC_ADDRESS[currentChainId];
      const currentEp      = CHAIN_ENTRYPOINT[currentChainId];

      if (!currentChain || !currentUsdc || !currentEp) {
        throw new Error(
          `Gasless not supported on chain ${currentChainId}. ` +
          `Switch to Arbitrum One, Base Mainnet, or Ethereum Mainnet.`
        );
      }

      // ── v0.7 chains (Arb/Base): mode=1 allowance ─────────────────────────
      //
      //  Circle v0.7 Paymaster validatePaymasterUserOp:
      //    • mode=1 → calls USDC.transferFrom(userOp.sender, paymaster, actualGasCost)
      //    • Requires SA to have pre-approved allowance for the paymaster.
      //  sdk.ts autoFundSmartAccount: deploy SA + approve + transfer USDC.
      //  encodePacked([uint8, address, uint256]): 1 + 20 + 32 = 53 bytes ✓
      const maxCost = parseUnits('10', 6); // 10 USDC ceiling — covers any mainnet gas fee
      const paymasterData = encodePacked(
        ['uint8', 'address', 'uint256'],
        [1, currentUsdc, maxCost],
      ) as Hex;

      return {
        paymaster:                     currentEp.paymaster,
        paymasterData,
        paymasterVerificationGasLimit: 200_000n,
        paymasterPostOpGasLimit:        35_000n,
        isFinal: true,
      };
    },
    // NOTE: getPaymasterStubData intentionally NOT defined (avoids double signature / AA33).
  };

  // ── Bundler Client (Alchemy ERC-4337) ───────────────────────────────────
  const bundlerClient = createBundlerClient({
    account:   smartAccount,
    client:    publicClient,
    paymaster: circlePaymasterModule,
    chain,
    userOperation: {
      // ERC-4337 gas price estimation via Alchemy bundler RPC.
      // `pimlico_getUserOperationGasPrice` is supported by Alchemy's bundler
      // as a standard ERC-4337 extension method.
      estimateFeesPerGas: async ({ bundlerClient: bc }: { bundlerClient: any }) => {
        try {
          const { standard: fees } = await bc.request({
            method: 'pimlico_getUserOperationGasPrice',
          });
          return {
            maxFeePerGas:         hexToBigInt(fees.maxFeePerGas),
            maxPriorityFeePerGas: hexToBigInt(fees.maxPriorityFeePerGas),
          };
        } catch {
          // Fallback: publicClient fee estimation with a safe buffer
          const f = await publicClient.estimateFeesPerGas();
          return {
            maxFeePerGas:         ((f.maxFeePerGas         ?? 2_000_000_000n) * 15n) / 10n,
            maxPriorityFeePerGas: ((f.maxPriorityFeePerGas ?? 1_000_000_000n) * 15n) / 10n,
          };
        }
      },
    },
    transport: http(bundlerRpc(chainId)),
  });

  return { bundlerClient, smartAccountAddress: smartAccount.address, authorization, signFreshAuthorization };
}

// ── Main initialiser ──────────────────────────────────────────
//   No ETH required. The only user interaction is a MetaMask Sign popup
//   for the EIP-2612 permit when a transaction is submitted.
export async function initGaslessClient(chainId?: number): Promise<GaslessClientResult> {
  const provider = window.ethereum;
  if (!provider) throw new Error('No injected wallet found. Please install MetaMask.');

  // 1. Get connected EOA
  const accounts   = await provider.request({ method: 'eth_requestAccounts' }) as string[];
  const eoaAddress = accounts?.[0] as `0x${string}`;
  if (!eoaAddress) throw new Error('No account returned from wallet.');

  // 2. Detect / switch to supported chain
  const hexChainId      = await provider.request({ method: 'eth_chainId' }) as string;
  const detectedChainId = parseInt(hexChainId, 16);
  let targetChainId     = chainId ?? detectedChainId;

  if (!SUPPORTED_CHAINS[targetChainId]) {
    const fallback = arbitrum.id;
    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${fallback.toString(16)}` }],
      });
      targetChainId = fallback;
    } catch (err: any) {
      if (err?.code === 4902) {
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId:           `0x${fallback.toString(16)}`,
            chainName:         'Arbitrum One',
            nativeCurrency:    { name: 'Ethereum', symbol: 'ETH', decimals: 18 },
            rpcUrls:           [OFFICIAL_RPC.Arbitrum],
            blockExplorerUrls: ['https://arbiscan.io'],
          }],
        });
        targetChainId = fallback;
      } else {
        throw new Error('Please switch MetaMask to Arbitrum One, Base, or Ethereum Mainnet.');
      }
    }
  }

  // 3. Build smart account + bundler for the initial chain
  // buildBundlerForChain creates its own chain-specific WalletClient internally.
  const { bundlerClient, smartAccountAddress, authorization, signFreshAuthorization } =
    await buildBundlerForChain(targetChainId, eoaAddress, provider);

  // Save module-level state for reinitForChain
  _bundlerClient     = bundlerClient;
  _provider          = provider;
  _eoaAddress        = eoaAddress;
  _bundlerChainId    = targetChainId;

  return {
    smartAccountAddress,
    chainId:       targetChainId,
    chainName:     SUPPORTED_CHAINS[targetChainId].name,
    authorization,
    signFreshAuthorization,
  };
}

// ── Chain-switch reinit ───────────────────────────────────────
//
//  Called by sdk.ts when the source chain changes between gasless bridge
//  operations (e.g. user first bridges Arb→Base then Base→Arb).
//
//  The bundlerClient is keyed to a specific chain's Alchemy endpoint.
//  Submitting a Base Mainnet UserOp to the Arbitrum bundler is rejected
//  immediately → "chain mismatch" / "account not found on this chain".
//
//  reinitForChain recreates the smart account + bundler for the new chain
//  WITHOUT asking the user to reconnect (no new eth_requestAccounts popup).
//  Only a permit sign popup will appear when the actual UserOp is submitted.
//
/** Reinitialises the bundler client for a new source chain. Call before submitting UserOps when the active chain differs from the chain the bundler was built for. */
export async function reinitForChain(
  chainId: number,
): Promise<{ smartAccountAddress: `0x${string}`; authorization: any | null; signFreshAuthorization: (() => Promise<any>) | null }> {
  if (_bundlerChainId === chainId) {
    // Already on the correct chain — nothing to do
    return {
      smartAccountAddress: (_bundlerClient?.account?.address ?? '') as `0x${string}`,
      authorization: null,
      signFreshAuthorization: null,
    };
  }

  if (!_provider || !_eoaAddress) {
    throw new Error('Gasless client not initialised. Call initGaslessClient first.');
  }

  // buildBundlerForChain creates a fresh chain-specific WalletClient for the new chain.  // buildBundlerForChain creates a fresh chain-specific WalletClient for the new chain.
  const { bundlerClient, smartAccountAddress, authorization, signFreshAuthorization } =
    await buildBundlerForChain(chainId, _eoaAddress, _provider);

  _bundlerClient  = bundlerClient;
  _bundlerChainId = chainId;

  return { smartAccountAddress, authorization, signFreshAuthorization };
}

// ── Accessors used by sdk.ts ──────────────────────────────────
export function getSmartAccountClient(): any { return _bundlerClient; }
export function clearSmartAccountClient(): void {
  _bundlerClient     = null;
  _provider          = null;
  _eoaAddress        = null;
  _bundlerChainId    = null;
}

// ── Utility helpers ───────────────────────────────────────────
export function isGaslessSupported(chainId: number): boolean {
  return chainId in SUPPORTED_CHAINS;
}
export function getChainLabel(chainId: number): string {
  return SUPPORTED_CHAINS[chainId]?.name ?? `Chain ${chainId}`;
}
