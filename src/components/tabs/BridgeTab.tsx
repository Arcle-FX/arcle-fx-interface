// ============================================================
//  BridgeTab — two modes toggled at the top:
//   • Bridge mode: cross-chain CCTP transfer (same token)
//   • Send mode  : same-chain wallet-to-wallet transfer on Arc
// ============================================================

import { useState, useRef, useEffect } from 'react';
import { useAccount, useChainId, useSwitchChain } from 'wagmi';
import { useAppContext }     from '../../context/AppContext';
import { usePrices }         from '../../hooks/usePrices';
import { TOKENS }            from '../../config/constants';
import type { PriceToken }   from '../../types';
import NetworkLogo           from '../NetworkLogo';
import * as sdk              from '../../lib/sdk';
import { isValidAddress }    from '../../lib/sdk';
import { formatTokenAmount, formatUsdValue, parseAmount, sanitizeAmount, sanitizeError } from '../../lib/formatters';
import { explorerFor, NETWORKS, TOKEN_ADDRESSES } from '../../config/constants';
import { showToast }         from '../Modals';

type BridgeMode = 'bridge' | 'send';

// ── Main component ─────────────────────────────────────────────
export default function BridgeTab() {
  const { state, dispatch } = useAppContext();
  const { address }          = useAccount();
  const currentChainId       = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const prices               = usePrices();

  const { from, to } = state.bridge;
  // Parse slippage string (e.g. "0.5%") → numeric percentage for bridge maxFee
  const slippagePct = parseFloat(state.slippage);

  // Unmount guard — prevents async callbacks from updating state after tab switch
  const isMounted = useRef(true);
  useEffect(() => { return () => { isMounted.current = false; }; }, []);

  // Abort controller for the current bridge operation — lets Cancel interrupt the flow.
  const bridgeAbortRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  // When the modal is closed mid-flight (user hit Cancel), set the abort flag
  // so the bridge success path is skipped even if the SDK resolves afterward.
  useEffect(() => {
    if (!state.txProgress.isOpen && btnLoading) {
      bridgeAbortRef.current.cancelled = true;
      setBtnLoading(false);
      if (approveGuardRef.current) { clearTimeout(approveGuardRef.current); approveGuardRef.current = null; }
      // Wallet popup cannot be closed programmatically — prompt the user to reject it.
      showToast('info', 'Request pending in wallet', 'Reject the pending request in your wallet to dismiss it.');
    }
  }, [state.txProgress.isOpen]);

  // Keep a mutable ref so async callbacks always read the latest progress
  const txProgressRef = useRef(state.txProgress);
  useEffect(() => { txProgressRef.current = state.txProgress; }, [state.txProgress]);

  // ── Mode toggle ─────────────────────────────────────────────
  const [mode, setMode] = useState<BridgeMode>('bridge');

  // ── Bridge state ────────────────────────────────────────────
  const [amount,     setAmount]     = useState('');
  const [toAmount,   setToAmount]   = useState('');
  const [usdFromVal, setUsdFromVal] = useState('');
  const [usdToVal,   setUsdToVal]   = useState('');
  const [balanceF,        setBalanceF]        = useState('—');
  const [balanceT,        setBalanceT]        = useState('—');
  const [balanceLoading,  setBalanceLoading]  = useState(false);
  const [bridgeFee,  setBridgeFee]  = useState('$—');
  const [bridgeTime, setBridgeTime] = useState('~20 Seconds');
  const [btnLoading, setBtnLoading] = useState(false);
  const [switchRotated, setSwitchRotated] = useState(false);
  const [lastBridgeResult, setLastBridgeResult] = useState<any>(null);
  // Express = CCTP v2 fast burn (~20 s, 1–14 bps fee)
  // Economy = CCTP v2 standard / full finality (~20 min, 0 bps fee)
  const [bridgeSpeed, setBridgeSpeed] = useState<'FAST' | 'SLOW'>('FAST');

  function handleBridgeSwitch() {
    setSwitchRotated(true);
    setTimeout(() => setSwitchRotated(false), 300);
    dispatch({ type: 'SWAP_BRIDGE_SIDES' });
  }

  function handleSpeedChange(speed: 'FAST' | 'SLOW') {
    setBridgeSpeed(speed);
    const isEthSrc = from.netId === 'Ethereum';
    setBridgeTime(speed === 'FAST' ? (isEthSrc ? '~13 Minutes' : '~20 Seconds') : '~20 Minutes');
    if (speed === 'SLOW') setBridgeFee(amount ? '$0.00 (free)' : '$—');
    else if (amount) applyLocalEstimate(parseFloat(amount));
  }
  const approveGuardRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Send state ──────────────────────────────────────────────
  const [sendAmount,    setSendAmount]    = useState('');
  const [sendRecipient, setSendRecipient] = useState('');
  const [sendToken,     setSendToken]     = useState('USDC');
  const [sendTokLogo,   setSendTokLogo]   = useState(TOKENS[0].logo);
  const [sendBalance,   setSendBalance]   = useState('—');
  const [sendUsdVal,    setSendUsdVal]    = useState('');
  const [addrError,     setAddrError]     = useState('');
  const [sendLoading,   setSendLoading]   = useState(false);
  const [sendGasEst,    setSendGasEst]    = useState<string>('—');

  // ── Balance helpers ─────────────────────────────────────────
  async function refreshBridgeBalance() {
    if (!address) return;
    setBalanceLoading(true);
    try {
      const [bF, bT] = await Promise.all([
        sdk.fetchTokenBalance(from.netId, from.token, address),
        sdk.fetchTokenBalance(to.netId,   to.token,   address),
      ]);
      if (!isMounted.current) return;
      setBalanceF(bF === 'N/A' ? '—' : bF);
      setBalanceT(bT === 'N/A' ? '—' : bT);
    } finally {
      if (isMounted.current) setBalanceLoading(false);
    }
  }

  async function refreshSendBalance() {
    if (!address) return;
    setBalanceLoading(true);
    try {
      const b = await sdk.fetchTokenBalance('Arc', sendToken, address);
      if (!isMounted.current) return;
      setSendBalance(b === 'N/A' ? '—' : b);
    } finally {
      if (isMounted.current) setBalanceLoading(false);
    }
  }

  // Reset displayed values when the selected pair or network changes
  useEffect(() => {
    setToAmount(''); setUsdFromVal(''); setUsdToVal('');
    setBridgeFee('$—');
    const isEthSrc = from.netId === 'Ethereum';
    setBridgeTime(bridgeSpeed === 'FAST' ? (isEthSrc ? '~13 Minutes' : '~20 Seconds') : '~20 Minutes');
    if (amount) {
      const n = parseAmount(amount);
      if (n !== null && n > 0) applyLocalEstimate(n);
    }
  }, [from.token, from.netId, to.token, to.netId]);

  // Recalculate when live prices arrive
  useEffect(() => {
    if (!prices.ready || !amount) return;
    const n = parseAmount(amount);
    if (n !== null && n > 0) applyLocalEstimate(n);
  }, [prices.ready]);

  // ── Load balances on connect / network / token / mode change ──
  useEffect(() => {
    if (!address) {
      setBalanceF('—'); setBalanceT('—'); setSendBalance('—');
      return;
    }
    if (mode === 'bridge') {
      refreshBridgeBalance();
    } else {
      refreshSendBalance();
    }
  }, [address, mode, from.netId, from.token, to.netId, sendToken]);

  // ── Mode switch — reset inputs ────────────────────────────────
  function switchMode(m: BridgeMode) {
    setMode(m);
    // reset bridge
    setAmount(''); setToAmount('');
    setUsdFromVal(''); setUsdToVal('');
    setBridgeFee('$—'); setBridgeTime('~20 Seconds');
    setBridgeSpeed('FAST');
    // reset send
    setSendAmount(''); setSendRecipient('');
    setSendUsdVal(''); setAddrError('');
    setSendGasEst('—');
  }

  // ════════════════════════════════════════════════════════
  // BRIDGE LOGIC
  // ════════════════════════════════════════════════════════

  function applyLocalEstimate(val: number) {
    if (!prices.ready) return;
    const price = prices[from.token as PriceToken] ?? 1;
    const usdIn = val * price;
    const isFree = bridgeSpeed === 'SLOW';
    const feePct = isFree ? 0 : 0.0005;
    const feeUsd = usdIn * feePct;
    const feeToken = val * feePct;
    setUsdFromVal(`~${formatUsdValue(usdIn)}`);
    setUsdToVal(`~${formatUsdValue(usdIn - feeUsd)}`);
    setBridgeFee(isFree ? '$0.00 (free)' : `~${formatUsdValue(feeUsd)}`);
    setToAmount(formatTokenAmount(val - feeToken));
    // Ethereum SOURCE: CCTP requires 65 block confirmations (~13 min) — Economy mode ~20 min
    const isEthSource = from.netId === 'Ethereum';
    setBridgeTime(
      isFree
        ? isEthSource ? '~20 Minutes' : '~20 Minutes'
        : isEthSource ? '~13 Minutes' : '~20 Seconds'
    );
  }

  function handleAmountChange(val: string) {
    const clean = sanitizeAmount(val);
    setAmount(clean);
    const n = parseAmount(clean);
    if (n === null) {
      setUsdFromVal(''); setUsdToVal('');
      setBridgeFee('$—'); setToAmount('');
      setBridgeTime(bridgeSpeed === 'FAST' ? '~20 Seconds' : '~20 Minutes');
      return;
    }
    applyLocalEstimate(n);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (!address || !isMounted.current) return;
      try {
      const res: any = await sdk.estimateBridge({
        fromNetwork: from.netId, toNetwork: to.netId, token: from.token, amount: clean,
        maxFeePct: isFinite(slippagePct) && slippagePct > 0 ? slippagePct : undefined,
        transferSpeed: bridgeSpeed,
      });
        if (!isMounted.current) return;
        if (res?.fee)           setBridgeFee(`${res.fee} ${from.token}`);
        if (res?.toAmount)      setToAmount(res.toAmount);
        if (res?.fromAmountUsd) setUsdFromVal(`~${formatUsdValue(Number(res.fromAmountUsd))}`);
        if (res?.toAmountUsd)   setUsdToVal(`~${formatUsdValue(Number(res.toAmountUsd))}`);
        if (res?.estimatedTime) setBridgeTime(res.estimatedTime);
      } catch { /* keep local estimate */ }
    }, 600);
  }

  function setMax() {
    const n = parseFloat(balanceF);
    if (!isFinite(n) || n <= 0) return;
    handleAmountChange(n.toFixed(4));
  }

  // ── Bridge inline validation ──────────────────────────────────
  const bridgeAmtNum   = parseFloat(amount);
  const bridgeAmtValid = isFinite(bridgeAmtNum) && bridgeAmtNum > 0;
  const bridgeBalNum   = parseFloat(balanceF);
  const bridgeEnough   = bridgeBalNum >= bridgeAmtNum;
  const sameNetwork    = from.netId === to.netId;

  // Token availability check: both source and destination must have the token deployed.
  // TOKEN_ADDRESSES[network][token] === null means the token is not deployed on that chain.
  // Example: EURC is null on Arbitrum — if the user selects Arc→Arbitrum with EURC, block it.
  const tokenUnavailableFrom = TOKEN_ADDRESSES?.[from.netId]?.[from.token] === null;
  const tokenUnavailableTo   = TOKEN_ADDRESSES?.[to.netId]?.[to.token]   === null;
  const tokenUnavailable     = tokenUnavailableFrom || tokenUnavailableTo;

  // GasLess on Ethereum source: Circle v0.8 Paymaster requires EIP-7702,
  // which MetaMask extension does not support for injected (json-rpc) accounts.
  const fromChainIdBridge    = NETWORKS.find(n => n.id === from.netId)?.chainId ?? 0;
  const gaslessEthBlocked    = sdk.isGaslessMode() && !sdk.isGaslessSupported(fromChainIdBridge) && !/arc/i.test(from.network);

  const bridgeBtnLabel: string =
    !address                           ? 'Connect Wallet'                    :
    gaslessEthBlocked                  ? 'GasLess not available on Ethereum' :
    tokenUnavailable                   ? `${from.token} not available on ${tokenUnavailableFrom ? from.network : to.network}` :
    !amount                            ? 'Enter an amount'                   :
    !bridgeAmtValid                    ? 'Invalid amount'                    :
    sameNetwork                        ? 'Select different network'          :
    !bridgeEnough                      ? 'Insufficient balance'              :
    btnLoading                         ? 'Confirming…'                       :
                                         'Bridge';
  const bridgeBtnDisabled =
    btnLoading ||
    (!!address && (gaslessEthBlocked || tokenUnavailable || !bridgeAmtValid || sameNetwork || !bridgeEnough));

  async function executeBridge() {
    if (!parseAmount(amount)) {
      dispatch({ type: 'SET_ERROR', payload: 'Please enter a valid amount greater than 0.' });
      dispatch({ type: 'OPEN_MODAL', payload: 'error' });
      return;
    }
    if (from.netId === to.netId) {
      dispatch({ type: 'SET_ERROR', payload: 'Source and destination networks must be different.' });
      dispatch({ type: 'OPEN_MODAL', payload: 'error' });
      return;
    }
    // Token availability guard — catches stale state after network switch
    if (TOKEN_ADDRESSES?.[from.netId]?.[from.token] === null) {
      dispatch({ type: 'SET_ERROR', payload: `${from.token} is not available on ${from.network}. Please select USDC or switch networks.` });
      dispatch({ type: 'OPEN_MODAL', payload: 'error' });
      return;
    }
    if (TOKEN_ADDRESSES?.[to.netId]?.[to.token] === null) {
      dispatch({ type: 'SET_ERROR', payload: `${to.token} is not available on ${to.network}. Please select USDC or switch the destination network.` });
      dispatch({ type: 'OPEN_MODAL', payload: 'error' });
      return;
    }
    if (!address) { dispatch({ type: 'OPEN_MODAL', payload: 'wallet' }); return; }

    // Insufficient balance guard
    const bal = parseFloat(balanceF);
    const n   = parseFloat(amount);
    if (isFinite(bal) && isFinite(n) && bal < n) {
      dispatch({ type: 'SET_ERROR', payload: `Insufficient balance. Available: ${balanceF} ${from.token}` });
      dispatch({ type: 'OPEN_MODAL', payload: 'error' });
      return;
    }

    // CCTP requires two on-chain transactions: ERC-20 Approve → CCTP Burn.
    // Wallets without EIP-5792 (wallet_sendCalls) issue two sequential prompts;
    // EIP-5792-capable wallets batch them into one.
    const gaslessActive = sdk.isGaslessMode();

    // Gasless "Fund Smart Account" step only for chains that support it (Arb/Base).
    // Ethereum: bridge uses ETH gas (gasless not active on Ethereum).
    // When source is Ethereum, transactions go via ETH gas automatically.
    const fromChainId = NETWORKS.find(n => n.id === from.netId)?.chainId ?? 0;
    const gaslessForChain = gaslessActive && sdk.isGaslessSupported(fromChainId);

    // Dynamic step indices — gasless inserts a "Fund Smart Account" step.
    const S = {
      network: 0,
      fund:    gaslessForChain ? 1 : -1,   // -1 = step doesn't exist
      approve: gaslessForChain ? 2 : 1,
      burn:    gaslessForChain ? 3 : 2,
      attest:  gaslessForChain ? 4 : 3,
      release: gaslessForChain ? 5 : 4,
    };

    const steps = [
      { label: 'Switch to source network',  status: 'pending' as const },
      ...(gaslessForChain ? [{ label: 'Fund Smart Account (one-time)', status: 'pending' as const }] : []),
      { label: 'Approve token spend',       status: 'pending' as const },
      { label: 'Confirm bridge transfer',   status: 'pending' as const },
      { label: 'Validators attesting',      status: 'pending' as const },
      { label: `Releasing on ${to.network} (auto-relay)`, status: 'pending' as const },
    ];

    dispatch({ type: 'OPEN_TX_PROGRESS', payload: {
      type: 'bridge', status: 'waiting',
      steps,
      fromLabel: `${formatTokenAmount(parseFloat(amount))} ${from.token}`,
      toLabel:   `${formatTokenAmount(parseFloat(toAmount || amount))} ${to.token}`,
      fromLogo:  from.tokLogo,
      toLogo:    to.tokLogo,
      txLink: '#', errorMsg: '',
    }});

    setBtnLoading(true);
    bridgeAbortRef.current = { cancelled: false };

    // ── Step 0: Switch to source network ──────────────────────────────
    // If the wallet is already on the correct chain, this step completes instantly.
    dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 0, status: 'active' } });

    const fromNet = NETWORKS.find(n => n.id === from.netId);
    if (fromNet && currentChainId !== fromNet.chainId) {
      try {
        await sdk.ensureOnChain(fromNet.id, fromNet.chainId, switchChainAsync);
      } catch (switchErr: any) {
        if (bridgeAbortRef.current.cancelled) return;
        const switchMsg = String(switchErr?.message ?? switchErr ?? '');
        // Distinguish user rejection from a technical failure
        const isRejected = /rejected|denied|cancel/i.test(switchMsg);
        dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 0, status: 'error' } });
        dispatch({
          type: 'SET_TX_STATUS',
          payload: {
            status: 'error',
            errorMsg: isRejected
              ? 'Network switch rejected. Please approve the switch in your wallet.'
              : `Could not switch to ${fromNet.label}. Please switch manually in your wallet and try again.`,
          },
        });
        setBtnLoading(false);
        return;
      }
    }
    // Network switch complete (or not needed)
    dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 0, status: 'done' } });

    // ── Deadline strategy ───────────────────────────────────────────────────
    // CRITICAL: We do NOT apply a deadline timeout to the bridge promise.
    //
    // Original bug: Promise.race([bridgePromise, timeoutPromise]) was racing
    // the ENTIRE bridge flow against a 20-min deadline. CCTP attestation polling
    // is up to 600 retries × 2s = ~20 min. So the deadline fired DURING
    // attestation → the burn TX was confirmed on Arbitrum but the mint on Base
    // was never triggered → balance stuck.
    //
    // Fix: Remove Promise.race entirely. Let the SDK run to completion on its
    // own schedule. The SDK has internal timeouts (600 retries × 2s for FAST,
    // 30s retryDelay × N for SLOW transfers from high-confirmation chains) and
    // will return 'error' with a failed fetchAttestation or mint step if it
    // times out — we handle those via the isAttestationTimeout and
    // isForwardFailure paths in sdk.ts executeBridge.
    //
    // The onBurnSubmitted callback + kit.on('bridge.burn') are kept for UI
    // progress updates but are no longer needed for deadline gating.

    try {
      // ── Step (gasless): auto-fund Smart Account ──────────────
      // Only runs on gasless-supported chains (Arb/Base). Skipped for Ethereum source.
      if (gaslessForChain && S.fund >= 0) {
        dispatch({ type: 'UPDATE_TX_STEP', payload: { index: S.fund, status: 'active' } });
        try {
          await sdk.fundGaslessWallet(from.netId, amount);
          dispatch({ type: 'UPDATE_TX_STEP', payload: { index: S.fund, status: 'done' } });
        } catch (fundErr: any) {
          dispatch({ type: 'UPDATE_TX_STEP', payload: { index: S.fund, status: 'error' } });
          throw fundErr; // propagate to outer catch
        }
      }

      // Two-step signing flow for wallets without EIP-5792 (Approve → Burn).
      // Waiting for Approve confirmation.
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: S.approve, status: 'active' } });

      const bridgePromise = sdk.executeBridge({
        fromNetwork: from.netId, toNetwork: to.netId, token: from.token, amount,
        maxFeePct: isFinite(slippagePct) && slippagePct > 0 ? slippagePct : undefined,
        transferSpeed: bridgeSpeed,
        onBurnSubmitted: () => {
          // Burn TX confirmed on-chain — update UI progress steps
          if (!isMounted.current || bridgeAbortRef.current.cancelled) return;
          if (approveGuardRef.current) { clearTimeout(approveGuardRef.current); approveGuardRef.current = null; }
          dispatch({ type: 'UPDATE_TX_STEP', payload: { index: S.approve, status: 'done' } });
          dispatch({ type: 'UPDATE_TX_STEP', payload: { index: S.burn,    status: 'done' } });
          dispatch({ type: 'SET_TX_STATUS',  payload: { status: 'processing' } });
          dispatch({ type: 'UPDATE_TX_STEP', payload: { index: S.attest,  status: 'active' } });
        },
      });

      // Advance to Burn step after Approve is confirmed.
      //
      // Normal mode:  approve(5s) → burn active → burn(5s) → attest active
      //               TXs mine in ~5-10 seconds.
      //
      // Gasless mode: each step is a separate UserOperation — waitForUserOperationReceipt
      //               can take 15-45 seconds per step. Firing the timer too early would
      //               show the attest step as active before the burn TX is mined,
      //               causing error indicators to appear on the wrong step.
      //
      // FIX (2026-10-23): increase timer durations in gasless mode:
      //   • approve timer: 10s  (bundler confirmation time for first UserOp)
      //   • burn timer:    20s  (bundler confirmation time for second UserOp)
      //   The onBurnSubmitted callback (real TX hash) fires before the timer in most
      //   cases — the timer is only a fallback for delayed confirmations.
      //
      // onBurnSubmitted clears this guard — no duplicate dispatches.
      const approveWaitMs = gaslessActive ? 10_000 : 5_000;
      approveGuardRef.current = setTimeout(() => {
        if (bridgeAbortRef.current.cancelled) return;
        dispatch({ type: 'UPDATE_TX_STEP', payload: { index: S.approve, status: 'done' } });
        dispatch({ type: 'UPDATE_TX_STEP', payload: { index: S.burn,    status: 'active' } });
        // Additional wait for Burn step — cancelled by onBurnSubmitted if it fires first.
        const innerTimer = setTimeout(() => {
          if (bridgeAbortRef.current.cancelled) return;
          dispatch({ type: 'SET_TX_STATUS', payload: { status: 'processing' } });
          dispatch({ type: 'UPDATE_TX_STEP', payload: { index: S.burn,   status: 'done' } });
          dispatch({ type: 'UPDATE_TX_STEP', payload: { index: S.attest, status: 'active' } });
        }, gaslessActive ? 20_000 : 5_000);
        // Store inner timer in the same ref so Cancel/onBurnSubmitted can clear it too
        approveGuardRef.current = innerTimer;
      }, approveWaitMs);

      // Await bridge directly — NO timeout race. The SDK handles its own polling.
      const res: any = await bridgePromise;
      clearTimeout(approveGuardRef.current!);

      // User cancelled while the promise was resolving — exit silently.
      if (bridgeAbortRef.current.cancelled) return;

      // Both wallet steps completed.
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: S.approve, status: 'done' } });
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: S.burn,    status: 'done' } });
      dispatch({ type: 'SET_TX_STATUS',  payload: { status: 'processing' } });
      await new Promise(r => setTimeout(r, 600));

      // ── state: 'pending' = Burn TX mined, CCTP attestation in progress ──
      // Circle's attestation service may not respond immediately on Arbitrum, Arc, etc.
      // When SDK returns 'pending', the burn TX was successfully submitted — track via explorer.
      const isPending = res?._submitted === true || res?.state === 'pending';

      // CCTP attestation in progress.
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: S.attest,  status: isPending ? 'done' : 'active' } });
      // Express: ~20 s finality; Economy: ~20 min full finality.
      await new Promise(r => setTimeout(r, bridgeSpeed === 'FAST' ? 700 : 1200));

      // Destination chain release step.
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: S.attest,  status: 'done' } });
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: S.release, status: isPending ? 'done' : 'active' } });
      await new Promise(r => setTimeout(r, 600));

      // All steps complete — TX submitted and CCTP transfer initiated.
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: S.release, status: 'done' } });

      // Use explorerUrl from SDK if available; otherwise derive from txHash.
      // useForwarder:false path: 'mint' step → destination mint TX (Base/Arc explorer)
      const burnStep = res?.steps?.find((s: any) =>
        /burn|transfer|send/i.test(s.name ?? '') && (s.txHash || s.explorerUrl)
      );
      const mintStep = res?.steps?.find((s: any) =>
        (s.name === 'mint' || s.name === 'forward') && (s.txHash || s.data?.forwardTxHash)
      );
      const anyStep   = res?.steps?.find((s: any) => s.txHash || s.explorerUrl);
      // Prefer destination mint TX when bridge is fully settled,
      // otherwise fall back to the burn TX so user can check the source chain.
      const candidate = (!isPending && mintStep) ? mintStep : (burnStep ?? anyStep);
      const mintTxHash = mintStep?.txHash ?? mintStep?.data?.forwardTxHash;
      const txLink =
        candidate?.explorerUrl                                  ? candidate.explorerUrl :
        (!isPending && mintTxHash)                              ? `${explorerFor(to.netId)}/tx/${mintTxHash}` :
        candidate?.txHash                                       ? `${explorerFor(from.netId)}/tx/${candidate.txHash}` :
        res?.hash                                               ? `${explorerFor(from.netId)}/tx/${res.hash}` :
        res?.txHash                                             ? `${explorerFor(from.netId)}/tx/${res.txHash}` :
        '#';
      dispatch({ type: 'SET_TX_STATUS', payload: { status: 'success', txLink } });

      setLastBridgeResult(null);
      setAmount(''); setToAmount(''); setUsdFromVal(''); setUsdToVal('');
      setBridgeFee('$—');
      refreshBridgeBalance();
      // pending = burn submitted, mint will complete automatically; success = fully settled
      // Ethereum SOURCE: ~13 min (65 blocks) attestation is normal — inform the user
      const isEthSrc = from.netId === 'Ethereum';
      const isArbSrc = from.netId === 'Arbitrum';
      const toastMsg = isPending
        ? isEthSrc
          ? `${amount} ${from.token} bridge submitted — Ethereum attestation takes ~13 min. Check the explorer.`
          : isArbSrc
            ? `${amount} ${from.token} bridge submitted — Orbit Relayer is minting to your wallet on ${to.network} (~1-3 min). Balance will update shortly.`
            : `${amount} ${from.token} → ${toAmount || amount} ${to.token} — Orbit Relayer minting to your wallet on ${to.network}. Check back in ~1-3 min.`
        : `${amount} ${from.token} → ${toAmount || amount} ${to.token}`;
      showToast('success', isPending ? 'Bridge submitted' : 'Bridge complete', toastMsg);
    } catch (e) {
      if (approveGuardRef.current) { clearTimeout(approveGuardRef.current); approveGuardRef.current = null; }
      // User already cancelled — swallow the error silently.
      if (bridgeAbortRef.current.cancelled) return;
      // Catch SDK internal chain-switch errors and surface a useful message
      const rawMsg = String((e as any)?.shortMessage ?? (e as any)?.message ?? e ?? '');
      const isSdkSwitchErr = /Failed to switch to chain|Failed to switch.*chain|could not switch network/i.test(rawMsg);
      const isRouteUnavailable = /route.*unavailable|route.*temporarily|CCTPXBridgingProvider|route check|could not be determined/i.test(rawMsg);
      const isInsufficientBalance = /Insufficient.*balance|balance.*insufficient/i.test(rawMsg);
      const isArcMinAmount = /minimum bridge amount|bridge amount too small|max fee must be less than amount/i.test(rawMsg);
      const errMsg = isSdkSwitchErr
          ? `Could not switch network automatically. Please switch to ${from.network} in your wallet and try again.`
          : isArcMinAmount
            ? rawMsg.includes('Bridge amount too small') ? rawMsg : `Bridge amount too small. The Orbit Relayer fee (~0.054 USDC) exceeds your transfer. Please enter at least 0.10 USDC.`
            : isRouteUnavailable
              ? `Bridge route for ${from.token} is temporarily unavailable. Please try with USDC or try again later.`
              : isInsufficientBalance
                ? `Insufficient ${from.token} balance on ${from.network}. Please add funds and try again.`
                : sanitizeError(e);
      // Mark the currently active step as failed.
      const activeIdx = txProgressRef.current.steps.findIndex(s => s.status === 'active');
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: Math.max(activeIdx, 0), status: 'error' } });
      dispatch({ type: 'SET_TX_STATUS', payload: { status: 'error', errorMsg: errMsg } });
      // Set result on error so the Retry button appears for resumable failures.
      if ((e as any)?.result) setLastBridgeResult((e as any).result);
    } finally {
      setBtnLoading(false);
    }
  }

  async function handleRetryBridge() {
    if (!lastBridgeResult) return;
    setBtnLoading(true);
    try {
      const res: any = await sdk.retryBridge(lastBridgeResult);
      setLastBridgeResult(null);
      const retryBurnStep = res?.steps?.find((s: any) =>
        /burn|transfer|send/i.test(s.name ?? '') && (s.txHash || s.explorerUrl)
      );
      const retryAny = res?.steps?.find((s: any) => s.txHash || s.explorerUrl);
      const retryCand = retryBurnStep ?? retryAny;
      const retryLink =
        retryCand?.explorerUrl                          ? retryCand.explorerUrl :
        retryCand?.txHash                               ? `${explorerFor(from.netId)}/tx/${retryCand.txHash}` :
        res?.hash                                       ? `${explorerFor(from.netId)}/tx/${res.hash}` :
        res?.txHash                                     ? `${explorerFor(from.netId)}/tx/${res.txHash}` :
        '#';
      showToast('success', 'Retry successful', `Bridge transaction resubmitted`);
      dispatch({ type: 'SET_TX_LINK', payload: retryLink });
      refreshBridgeBalance();
    } catch (e) {
      dispatch({ type: 'SET_ERROR', payload: sanitizeError(e) });
      dispatch({ type: 'OPEN_MODAL', payload: 'error' });
    } finally {
      setBtnLoading(false);
    }
  }

  // ════════════════════════════════════════════════════════
  // SEND LOGIC
  // ════════════════════════════════════════════════════════

  function handleSendAmountChange(val: string) {
    const clean = sanitizeAmount(val);
    setSendAmount(clean);
    const n = parseAmount(clean);
    if (n === null) { setSendUsdVal(''); setSendGasEst('—'); return; }
    const price = prices.ready ? (prices[sendToken as PriceToken] ?? 1) : 0;
    setSendUsdVal(price ? `~${formatUsdValue(n * price)}` : '');
      // Estimate gas fee via SDK (uses placeholder address if recipient not yet provided)
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (!address || !isMounted.current) return;
      const est = await sdk.estimateSend({ to: sendRecipient || '0x', amount: clean, token: sendToken });
      if (!isMounted.current) return;
      setSendGasEst(est?.gas ? `~${est.gas} gas units` : '—');
    }, 600);
  }

  function handleRecipientChange(val: string) {
    setSendRecipient(val);
    if (val.trim().length > 0 && !isValidAddress(val))
      setAddrError('Invalid address format.');
    else
      setAddrError('');
  }

  function selectSendToken(sym: string, logo: string) {
    setSendToken(sym);
    setSendTokLogo(logo);
    setSendAmount(''); setSendUsdVal('');
  }

  function setSendMax() {
    const n = parseFloat(sendBalance);
    if (!isFinite(n) || n <= 0) return;
    handleSendAmountChange(n.toFixed(4));
  }

  // ── Send inline validation ────────────────────────────────────
  const sendAmtNum   = parseFloat(sendAmount);
  const sendAmtValid = isFinite(sendAmtNum) && sendAmtNum > 0;
  const sendBalNum   = parseFloat(sendBalance);
  const sendEnough   = sendBalNum >= sendAmtNum;
  const sendAddrOk   = isValidAddress(sendRecipient);

  const sendBtnLabel: string =
    !address                          ? 'Connect Wallet'      :
    !sendAmount                       ? 'Enter an amount'     :
    !sendAmtValid                     ? 'Invalid amount'      :
    !sendEnough                       ? 'Insufficient balance':
    sendRecipient && !sendAddrOk      ? 'Invalid address'     :
    !sendRecipient                    ? 'Enter recipient'     :
    sendLoading                       ? 'Sending…'            :
                                        'Send';
  const sendBtnDisabled =
    sendLoading ||
    (!!address && (!sendAmtValid || !sendEnough || !sendAddrOk));

  async function executeSend() {
    if (!parseAmount(sendAmount)) {
      dispatch({ type: 'SET_ERROR', payload: 'Please enter a valid amount.' });
      dispatch({ type: 'OPEN_MODAL', payload: 'error' });
      return;
    }
    if (!isValidAddress(sendRecipient)) {
      dispatch({ type: 'SET_ERROR', payload: 'Please enter a valid recipient address.' });
      dispatch({ type: 'OPEN_MODAL', payload: 'error' });
      return;
    }
    if (!address) { dispatch({ type: 'OPEN_MODAL', payload: 'wallet' }); return; }

    // Insufficient balance guard
    const bal = parseFloat(sendBalance);
    const n   = parseFloat(sendAmount);
    if (isFinite(bal) && isFinite(n) && bal < n) {
      dispatch({ type: 'SET_ERROR', payload: `Insufficient balance. Available: ${sendBalance} ${sendToken}` });
      dispatch({ type: 'OPEN_MODAL', payload: 'error' });
      return;
    }

    const steps = [
      { label: 'Confirm in wallet',        status: 'pending' as const },
      { label: 'Submitting on ARC Network', status: 'pending' as const },
      { label: 'Transfer complete',         status: 'pending' as const },
    ];

    dispatch({ type: 'OPEN_TX_PROGRESS', payload: {
      type: 'send', status: 'waiting',
      steps,
      fromLabel: `${sendAmount} ${sendToken}`,
      toLabel:   `${sendAmount} ${sendToken}`,
      fromLogo:  sendTokLogo,
      toLogo:    sendTokLogo,
      txLink: '#', errorMsg: '',
    }});

    dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 0, status: 'active' } });
    setSendLoading(true);
    try {
      const res: any = await sdk.executeSend({
        to:     sendRecipient.trim(),
        amount: sendAmount,
        token:  sendToken,
      });

      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 0, status: 'done' } });
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 1, status: 'active' } });
      dispatch({ type: 'SET_TX_STATUS',  payload: { status: 'processing' } });
      await new Promise(r => setTimeout(r, 1200));

      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 1, status: 'done' } });
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 2, status: 'active' } });
      await new Promise(r => setTimeout(r, 800));
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 2, status: 'done' } });

      const txHash = res?.hash ?? res?.txHash ?? '';
      const txLink = txHash ? `${explorerFor('Arc')}/tx/${txHash}` : '#';
      dispatch({ type: 'SET_TX_STATUS', payload: { status: 'success', txLink } });

      setSendAmount(''); setSendRecipient(''); setSendUsdVal('');
      refreshSendBalance();
      showToast('success', 'Transfer successful', `${sendAmount} ${sendToken} sent`);
    } catch (e) {
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 0, status: 'error' } });
      dispatch({ type: 'SET_TX_STATUS', payload: { status: 'error', errorMsg: sanitizeError(e) } });
    } finally {
      setSendLoading(false);
    }
  }

  // ════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════

  return (
    <div id="bridge-content">

      {/* Mode Toggle — Bridge | Send */}
      <div className="bridge-speed-toggle" style={{ marginBottom: 16 }}>
        <button
          className={`speed-btn${mode === 'bridge' ? ' active express' : ''}`}
          onClick={() => switchMode('bridge')}
        >
          <i className="ph-bold ph-arrows-left-right"></i> Bridge
        </button>
        <button
          className={`speed-btn${mode === 'send' ? ' active economy' : ''}`}
          onClick={() => switchMode('send')}
        >
          <i className="ph-bold ph-paper-plane-tilt"></i> Send
        </button>
      </div>

      {/* ── BRIDGE MODE ───────────────────────────────────── */}
      {mode === 'bridge' && (
        <>
          {/* Express / Economy speed toggle */}
          <div className="bridge-speed-toggle">
            <button
              className={`speed-btn express${bridgeSpeed === 'FAST' ? ' active' : ''}`}
              onClick={() => handleSpeedChange('FAST')}
            >
              <i className="ph-bold ph-lightning"></i> Express
            </button>
            <button
              className={`speed-btn economy${bridgeSpeed === 'SLOW' ? ' active' : ''}`}
              onClick={() => handleSpeedChange('SLOW')}
            >
              <i className="ph-bold ph-leaf"></i> Economy
            </button>
          </div>

          {/* FROM Section */}
          <div className="bridge-section">
            <div className="section-header">
              <span>From Network</span>
              <div className="balance-container">
                <span id="balance-from">Balance: {balanceLoading ? '…' : balanceF}</span>
                <button className="max-btn" onClick={setMax}>MAX</button>
              </div>
            </div>
            <div
              className="network-selector"
              onClick={() => { dispatch({ type: 'SET_TARGET', payload: 'from' }); dispatch({ type: 'OPEN_MODAL', payload: 'network' }); }}
            >
              <NetworkLogo logo={from.netLogo} label={from.network} size={20} />
              <span>{from.network}</span>
              <i className="ph-bold ph-caret-down" style={{ color: 'var(--text-muted)' }}></i>
            </div>
            <div className="token-input-row">
              <input
                type="text" inputMode="decimal" placeholder="0.0"
                value={amount} onChange={e => handleAmountChange(e.target.value)}
                autoComplete="off"
                maxLength={18}
              />
              <div
                className="token-selector"
                onClick={() => { dispatch({ type: 'SET_TARGET', payload: 'from' }); dispatch({ type: 'OPEN_MODAL', payload: 'token' }); }}
              >
                <img src={from.tokLogo} alt={from.token} />
                <span>{from.token}</span>
                <i className="ph-bold ph-caret-down"></i>
              </div>
            </div>
            <div className="usd-value">{usdFromVal}</div>
          </div>

          {/* Switch */}
          <div className="switch-wrapper">
            <button className="switch-btn" onClick={handleBridgeSwitch}>
              <i className="ph-bold ph-arrow-down" style={{ transform: switchRotated ? 'rotate(180deg)' : 'rotate(0deg)' }}></i>
            </button>
          </div>

          {/* TO Section */}
          <div className="bridge-section">
            <div className="section-header">
              <span>To Network</span>
              <span id="balance-to">Balance: {balanceLoading ? '…' : balanceT}</span>
            </div>
            <div
              className="network-selector"
              onClick={() => { dispatch({ type: 'SET_TARGET', payload: 'to' }); dispatch({ type: 'OPEN_MODAL', payload: 'network' }); }}
            >
              <NetworkLogo logo={to.netLogo} label={to.network} size={20} />
              <span>{to.network}</span>
              <i className="ph-bold ph-caret-down" style={{ color: 'var(--text-muted)' }}></i>
            </div>
            <div className="token-input-row">
              <input type="text" placeholder="0.0" readOnly value={toAmount} />
              {/* CCTP always bridges the same token on both sides.
                  SET_TARGET 'from' triggers SET_BRIDGE_TOKEN which updates
                  both the from and to sides simultaneously. */}
              <div
                className="token-selector"
                onClick={() => { dispatch({ type: 'SET_TARGET', payload: 'from' }); dispatch({ type: 'OPEN_MODAL', payload: 'token' }); }}
                title="CCTP bridges the same token — selecting here updates both sides"
              >
                <img src={to.tokLogo} alt={to.token} />
                <span>{to.token}</span>
                <i className="ph-bold ph-caret-down"></i>
              </div>
            </div>
            <div className="usd-value">{usdToVal}</div>
          </div>

          {/* Route Info */}
          <div className="route-info">
            <div className="route-row">
              <span>Bridge Fee</span>
              <span>{bridgeFee}</span>
            </div>
            <div className="route-row">
              <span>Price Impact</span>
              <span className="text-green">{amount ? '< 0.01%' : '—'}</span>
            </div>
            <div className="route-row">
              <span>Estimated Time ({bridgeSpeed === 'FAST' ? 'CCTP Fast' : 'CCTP Standard'})</span>
              <span>{bridgeTime}</span>
            </div>
            <div className="route-row">
              <span>Gas Fee</span>
              <span style={{ color: (/arc/i.test(from.network) || (sdk.isGaslessMode() && sdk.isGaslessSupported(NETWORKS.find(n => n.id === from.netId)?.chainId ?? 0))) ? 'var(--teal)' : 'var(--text-muted)' }}>
                {/arc/i.test(from.network)
                  ? 'USDC (native)'
                  : (sdk.isGaslessMode() && sdk.isGaslessSupported(NETWORKS.find(n => n.id === from.netId)?.chainId ?? 0))
                    ? <><i className="ph-bold ph-lightning" style={{ fontSize: '0.75rem', marginRight: 4 }}></i>USDC (gasless)</>
                    : 'ETH'
                }
              </span>
            </div>
          </div>

      {/* GasLess + Ethereum source warning */}
      {gaslessEthBlocked && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: 'rgba(239,68,68,0.07)',
              border: '1px solid rgba(239,68,68,0.2)',
              borderRadius: 10, padding: '9px 13px', marginBottom: 12,
              fontSize: '0.82rem', color: 'var(--text-muted)',
            }}>
              <i className="ph-bold ph-warning" style={{ color: '#ef4444', flexShrink: 0 }} />
              GasLess is only supported on <strong style={{ color: 'var(--text-main)', margin: '0 3px' }}>Arbitrum</strong> and <strong style={{ color: 'var(--text-main)', margin: '0 3px' }}>Base</strong>. Switch the source network.
            </div>
          )}

          {/* Bridge action button */}
          <button
            className="btn-action"
            onClick={!address ? () => dispatch({ type: 'OPEN_MODAL', payload: 'wallet' }) : executeBridge}
            disabled={bridgeBtnDisabled}
          >
            {btnLoading
              ? <><i className="ph-bold ph-spinner spinner" /> Confirming in Wallet...</>
              : bridgeBtnLabel}
          </button>

          {lastBridgeResult && !btnLoading && (
            <button
              onClick={handleRetryBridge}
              style={{
                width: '100%', marginTop: 8, padding: '10px 0',
                background: 'rgba(255,180,0,0.10)', border: '1px solid rgba(255,180,0,0.35)',
                borderRadius: 12, color: '#ffb400', fontWeight: 700,
                fontSize: '0.88rem', cursor: 'pointer', fontFamily: 'inherit',
                transition: 'opacity 0.2s',
              }}
            >
              <i className="ph-bold ph-arrow-clockwise" style={{ marginRight: 6 }} />
              Retry Failed Bridge
            </button>
          )}
        </>
      )}

      {/* ── SEND MODE ─────────────────────────────────────── */}
      {mode === 'send' && (
        <>
          {/* Arc Network badge */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 7,
            background: 'rgba(var(--teal-rgb,0,200,200),0.07)',
            border: '1px solid rgba(var(--teal-rgb,0,200,200),0.15)',
            borderRadius: 10, padding: '7px 12px', marginBottom: 14,
            fontSize: '0.8rem', color: 'var(--text-muted)',
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: 'var(--teal)', boxShadow: '0 0 5px var(--teal)', flexShrink: 0,
            }} />
            Sending on <strong style={{ color: 'var(--text-main)', margin: '0 3px' }}>ARC Network</strong>
            — gas paid in USDC, no ETH needed.
          </div>

          {/* Token + Amount */}
          <div className="bridge-section">
            <div className="section-header">
              <span>Token & Amount</span>
              <div className="balance-container">
                <span>Balance: {balanceLoading ? '…' : sendBalance}</span>
                <button className="max-btn" onClick={setSendMax}>MAX</button>
              </div>
            </div>

            {/* Token selector — 3 modern pills */}
            <div className="send-token-pills">
              {TOKENS.map(t => (
                <button
                  key={t.symbol}
                  onClick={() => selectSendToken(t.symbol, t.logo)}
                  className={`send-token-pill${sendToken === t.symbol ? ' active' : ''}`}
                >
                  <img src={t.logo} alt={t.symbol} />
                  <span>{t.symbol}</span>
                </button>
              ))}
            </div>

            <div className="token-input-row" style={{ marginTop: 10 }}>
            <input
              type="text" inputMode="decimal" placeholder="0.0"
              value={sendAmount} onChange={e => handleSendAmountChange(e.target.value)}
              autoComplete="off"
              maxLength={18}
            />
            </div>
            <div className="usd-value">{sendUsdVal}</div>
          </div>

          {/* Arrow indicator */}
          <div className="switch-wrapper" style={{ pointerEvents: 'none' }}>
            <div className="switch-btn" style={{ cursor: 'default', opacity: 0.45 }}>
              <i className="ph-bold ph-arrow-down" />
            </div>
          </div>

          {/* Recipient */}
          <div className="bridge-section">
            <div className="section-header">
              <span>Recipient Address</span>
            </div>
            <input
              type="text" placeholder="0x..."
              value={sendRecipient}
              onChange={e => handleRecipientChange(e.target.value)}
              autoComplete="off"
              style={{
                width: '100%', background: 'rgba(255,255,255,0.04)',
                border: addrError
                  ? '1px solid var(--error-red)'
                  : '1px solid rgba(255,255,255,0.08)',
                borderRadius: 12, padding: '14px 16px',
                color: 'var(--text-main)', fontSize: '0.88rem',
                fontFamily: 'monospace', outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            {addrError && (
              <div style={{ color: 'var(--error-red)', fontSize: '0.75rem', marginTop: 5 }}>
                {addrError}
              </div>
            )}
          </div>

          {/* Route Info */}
          <div className="route-info">
            <div className="route-row">
              <span>Network</span>
              <span style={{ color: 'var(--teal)', fontWeight: 600 }}>ARC Network</span>
            </div>
            <div className="route-row">
              <span>Finality</span>
              <span className="text-green">{'< 1 Second'}</span>
            </div>
            <div className="route-row">
              <span>Gas Token</span>
              <span>USDC (no ETH needed)</span>
            </div>
            <div className="route-row">
              <span>Estimated Fee</span>
              <span>{sendGasEst}</span>
            </div>
          </div>

          {/* Send action button */}
          <button
            className="btn-action"
            onClick={!address ? () => dispatch({ type: 'OPEN_MODAL', payload: 'wallet' }) : executeSend}
            disabled={sendBtnDisabled}
          >
            {sendLoading
              ? <><i className="ph-bold ph-spinner spinner" /> Sending...</>
              : sendBtnLabel}
          </button>
        </>
      )}
    </div>
  );
}
