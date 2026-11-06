// ============================================================
//  SwapTab — two modes: Swap (same-chain) | Cross-Chain
//   • Same-chain:  instant USDC↔EURC swap on one network
//   • Cross-Chain: swap + CCTP bridge to another network
// ============================================================

import { useState, useRef, useEffect } from 'react';
import { useAccount, useChainId, useSwitchChain } from 'wagmi';
import { useAppContext }     from '../../context/AppContext';
import { usePrices }         from '../../hooks/usePrices';
import NetworkLogo           from '../NetworkLogo';
import type { PriceToken }   from '../../types';
import * as sdk              from '../../lib/sdk';
import { formatTokenAmount, formatUsdValue, parseAmount, sanitizeAmount, sanitizeError } from '../../lib/formatters';
import { explorerFor, NETWORKS } from '../../config/constants';
import { showToast }         from '../Modals';

// ── Sub-tab type ─────────────────────────────────────────────
type SwapMode = 'swap' | 'cross-chain';

export default function SwapTab() {
  const { state, dispatch } = useAppContext();
  const { address }         = useAccount();
  const chainId             = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const prices              = usePrices();

  const { netId, network, netLogo, from, to } = state.swap;

  // ── Sub-tab mode ─────────────────────────────────────────────
  const [swapMode, setSwapMode] = useState<SwapMode>('swap');
  const isCrossChain = swapMode === 'cross-chain';

  // Cross-chain destination network state
  const [toNetId, setToNetId] = useState<string>(netId);
  const [toNet,   setToNet]   = useState(() => NETWORKS.find(n => n.id === netId) ?? NETWORKS[0]);

  // Sync destination to source when switching back to same-chain mode.
  // When entering cross-chain mode, auto-select first network that differs from source.
  useEffect(() => {
    if (swapMode === 'swap') {
      setToNetId(netId);
      setToNet(NETWORKS.find(n => n.id === netId) ?? NETWORKS[0]);
    } else {
      // Auto-select first network that isn't the source
      const firstOther = NETWORKS.find(n => n.id !== netId);
      if (firstOther) { setToNetId(firstOther.id); setToNet(firstOther); }
    }
  }, [swapMode, netId]);

  const slippageBps = Math.round(parseFloat(state.slippage) * 100);

  // Unmount guard
  const isMounted = useRef(true);
  useEffect(() => { return () => { isMounted.current = false; }; }, []);

  // ── Balances ────────────────────────────────────────────────
  const [balance,        setBalance]        = useState('—');
  const [balanceTo,      setBalanceTo]      = useState('—');
  const [balanceLoading, setBalanceLoading] = useState(false);

  useEffect(() => {
    if (!address) { setBalance('—'); setBalanceTo('—'); return; }
    setBalanceLoading(true);
    Promise.all([
      sdk.fetchTokenBalance(netId, from.token, address),
      sdk.fetchTokenBalance(netId, to.token,   address),
    ]).then(([bFrom, bTo]) => {
      if (!isMounted.current) return;
      setBalance(bFrom === 'N/A' ? '—' : bFrom);
      setBalanceTo(bTo  === 'N/A' ? '—' : bTo);
      setBalanceLoading(false);
    }).catch(() => {
      if (!isMounted.current) return;
      setBalance('0.00'); setBalanceTo('0.00');
      setBalanceLoading(false);
    });
  }, [address, netId, from.token, to.token]);

  // ── UI state ─────────────────────────────────────────────────
  const [amount,      setAmount]      = useState('');
  const [receiveAmt,  setReceiveAmt]  = useState('');
  const [usdFromVal,  setUsdFromVal]  = useState('');
  const [usdToVal,    setUsdToVal]    = useState('');
  const [priceImpact, setPriceImpact] = useState('');
  const [impactNum,   setImpactNum]   = useState(0);
  const [sdkImpact,   setSdkImpact]   = useState<number | null>(null);
  const [rateStr,     setRateStr]     = useState('');
  const [switchRotated, setSwitchRotated] = useState(false);
  const [btnLoading,  setBtnLoading]  = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleSwapSwitch() {
    setSwitchRotated(true);
    setTimeout(() => setSwitchRotated(false), 300);
    dispatch({ type: 'SWAP_SWAP_TOKENS' });
  }

  // ── Local estimate (immediate) ─────────────────────────────
  function applyLocalEstimate(val: number) {
    if (!prices.ready) return;
    const priceIn  = prices[from.token as PriceToken] ?? 1;
    const priceOut = prices[to.token   as PriceToken] ?? 1;
    if (!priceIn || !priceOut) return;
    const usdIn    = val * priceIn;
    const amtOut   = (usdIn * 0.997) / (priceOut || 1);

    setUsdFromVal(`~${formatUsdValue(usdIn)}`);
    setUsdToVal(`~${formatUsdValue(usdIn * 0.997)}`);
    setReceiveAmt(formatTokenAmount(amtOut));

    const impact = (usdIn / (usdIn + 500_000)) * 100;
    if (impact < 0.01)     setPriceImpact('< 0.01%');
    else if (impact < 0.1) setPriceImpact(`~${impact.toFixed(3)}%`);
    else                   setPriceImpact(`~${impact.toFixed(2)}%`);
    setImpactNum(impact);

    const rate     = priceIn / (priceOut || 1);
    const rDec     = priceOut > 100 ? 8 : 4;
    setRateStr(`1 ${from.token} = ${rate.toFixed(rDec)} ${to.token}`);
  }

  function clearEstimates() {
    setReceiveAmt(''); setUsdFromVal(''); setUsdToVal('');
    setPriceImpact(''); setRateStr(''); setImpactNum(0); setSdkImpact(null);
  }

  // Reset displayed values when the selected pair changes
  useEffect(() => {
    clearEstimates();
    if (amount) {
      const n = parseAmount(amount);
      if (n !== null && n > 0) applyLocalEstimate(n);
    }
  }, [from.token, to.token, netId]);

  // Recalculate when live prices arrive
  useEffect(() => {
    if (!prices.ready || !amount) return;
    const n = parseAmount(amount);
    if (n !== null && n > 0) applyLocalEstimate(n);
  }, [prices.ready]);

  function handleAmountChange(val: string) {
    const clean = sanitizeAmount(val);
    setAmount(clean);

    const n = parseAmount(clean);
    if (n === null) { clearEstimates(); return; }

    applyLocalEstimate(n);

    // Debounced SDK estimate
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (!address || !isMounted.current) return;
      try {
        const res: any = await sdk.estimateSwap({
          network: netId, tokenIn: from.token, tokenOut: to.token, amountIn: clean,
          slippageBps,
          // Cross-chain: only pass toChain when destination has a valid SwapChain value.
          // sdkBridge values (e.g. "Ethereum") are NOT valid SwapChain identifiers.
          ...(isCrossChain && toNet.sdkSwap
            ? { toChain: toNet.sdkSwap, toRecipientAddress: address }
            : {}),
        });
        if (!isMounted.current) return;

        // Circle AppKit returns: { estimatedOutput: { amount, token }, ... }
        // Fall back to legacy field names used by other providers.
        const sdkOutAmt: string | null =
          res?.estimatedOutput?.amount ??
          res?.amountOut               ??
          res?.toAmount                ??
          null;
        if (sdkOutAmt != null && sdkOutAmt !== '') {
          // estimatedOutput.amount is already a decimal string from the SDK
          // (e.g. "0.00000574" for 574 satoshi cirBTC).
          // Format it through formatTokenAmount so the input field shows a
          // human-readable value (e.g. "0.00000574") rather than a raw decimal.
          const n = parseFloat(sdkOutAmt);
          setReceiveAmt(isFinite(n) ? formatTokenAmount(n) : String(sdkOutAmt));
        }
        if (res?.fromAmountUsd) setUsdFromVal(`~${formatUsdValue(Number(res.fromAmountUsd))}`);
        if (res?.toAmountUsd)   setUsdToVal(`~${formatUsdValue(Number(res.toAmountUsd))}`);
        if (res?.priceImpact)         { const v = Number(res.priceImpact);    setPriceImpact(`~${v.toFixed(2)}%`); setImpactNum(v); setSdkImpact(v); }
        else if (res?.priceImpactPct) { const v = Number(res.priceImpactPct); setPriceImpact(`~${v.toFixed(2)}%`); setImpactNum(v); setSdkImpact(v); }
      } catch { /* keep local estimate */ }
    }, 600);
  }

  function setMax() {
    const n = parseFloat(balance);
    if (!isFinite(n) || n <= 0) return;
    handleAmountChange(n.toFixed(4));
  }

  // ── Validation ──────────────────────────────────────────────
  const amtNum    = parseFloat(amount);
  const amtValid  = isFinite(amtNum) && amtNum > 0;
  const balNum    = parseFloat(balance);
  const enoughBal = balNum >= amtNum;
  const sameToken = from.token === to.token;

  // Same-chain swap is limited to Arc (USDC ↔ EURC / cirBTC liquidity lives there).
  // Cross-chain swap works on any network that carries a valid sdkSwap value,
  // which is now all four supported networks after the root-cause fix.
  const currentNet    = NETWORKS.find(n => n.id === netId);
  const swapSupported = isCrossChain
    ? Boolean(currentNet?.sdkSwap)  // any SwapChain-enabled network is valid as source
    : netId === 'Arc';              // same-chain liquidity is only available on Arc

  const isHighImpact     = impactNum >= 5  && impactNum < 15;
  const isVeryHighImpact = impactNum >= 15 && impactNum < 50;
  const isExtremeImpact  = sdkImpact !== null && sdkImpact >= 50;

  // Cross-chain: prevent swapping to the same network
  const sameNetCrossChain = isCrossChain && toNetId === netId;

  const btnLabel: string =
    !address           ? 'Connect Wallet'                      :
    !swapSupported     ? (isCrossChain
                          ? 'Cross-Chain Swap not available on this network'
                          : 'Same-Chain Swap is only available on ARC Network') :
    sameToken          ? 'Select different token'              :
    sameNetCrossChain  ? 'Select a different destination network' :
    !amount            ? 'Enter an amount'                     :
    !amtValid          ? 'Invalid amount'                      :
    !enoughBal         ? 'Insufficient balance'                :
    isExtremeImpact    ? 'Price impact too high'               :
    btnLoading         ? 'Confirming…'                         :
    isCrossChain       ? 'Cross-Chain Swap'                    :
                         'Swap';

  const btnDisabled =
    btnLoading ||
    (!!address && (!swapSupported || sameToken || sameNetCrossChain || !amtValid || !enoughBal || isExtremeImpact));

  // ── Execute ─────────────────────────────────────────────────
  async function execute() {
    if (from.token === to.token) {
      dispatch({ type: 'SET_ERROR', payload: `Cannot swap ${from.token} for ${to.token}. Select a different output token.` });
      dispatch({ type: 'OPEN_MODAL', payload: 'error' });
      return;
    }
    if (!parseAmount(amount)) {
      dispatch({ type: 'SET_ERROR', payload: 'Please enter a valid amount greater than 0.' });
      dispatch({ type: 'OPEN_MODAL', payload: 'error' });
      return;
    }
    if (!address) { dispatch({ type: 'OPEN_MODAL', payload: 'wallet' }); return; }

    const bal = parseFloat(balance);
    const n   = parseFloat(amount);
    if (isFinite(bal) && isFinite(n) && bal < n) {
      dispatch({ type: 'SET_ERROR', payload: `Insufficient balance. Available: ${bal.toFixed(4)} ${from.token}` });
      dispatch({ type: 'OPEN_MODAL', payload: 'error' });
      return;
    }

    // Network switch guard — auto-add the chain if the wallet doesn't know it yet.
    const swapNet = NETWORKS.find(n => n.id === netId);
    if (swapNet && chainId !== swapNet.chainId) {
      try {
        showToast('info', 'Switching network…', `Switching to ${swapNet.label}`);
        await sdk.ensureOnChain(swapNet.id, swapNet.chainId, switchChainAsync);
      } catch {
        dispatch({ type: 'SET_ERROR', payload: `Could not switch to ${swapNet.label} — please switch manually in your wallet.` });
        dispatch({ type: 'OPEN_MODAL', payload: 'error' });
        return;
      }
    }

    const steps = isCrossChain ? [
      { label: 'Confirm in wallet',    status: 'pending' as const },
      { label: 'Submitting swap',      status: 'pending' as const },
      { label: 'Cross-chain transfer', status: 'pending' as const },
      { label: 'Finalizing',           status: 'pending' as const },
    ] : [
      { label: 'Confirm in wallet', status: 'pending' as const },
      { label: 'Submitting swap',   status: 'pending' as const },
      { label: 'Finalizing',        status: 'pending' as const },
    ];

    dispatch({ type: 'OPEN_TX_PROGRESS', payload: {
      type: isCrossChain ? 'cross-chain' : 'swap', status: 'waiting', steps,
      fromLabel: `${formatTokenAmount(parseFloat(amount))} ${from.token}`,
      toLabel:   `${(() => {
        if (!receiveAmt) return '—';
        const n = parseFloat(receiveAmt);
        // receiveAmt may be a pre-formatted string like '< 0.0001' — keep as-is if parseFloat fails
        return isFinite(n) ? formatTokenAmount(n) : receiveAmt;
      })()} ${to.token}${isCrossChain ? ` on ${toNet.label}` : ''}`,
      fromLogo: from.tokLogo,
      toLogo:   to.tokLogo,
      txLink: '#', errorMsg: '',
    }});

    dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 0, status: 'active' } });
    setBtnLoading(true);

    try {
      const res: any = await sdk.executeSwap({
        network: netId, tokenIn: from.token, tokenOut: to.token, amountIn: amount,
        slippageBps,
        // Cross-chain: only pass toChain when destination has a valid SwapChain value.
        // sdkBridge values (e.g. "Ethereum") are NOT valid SwapChain identifiers.
        ...(isCrossChain && toNet.sdkSwap
          ? { toChain: toNet.sdkSwap, toRecipientAddress: address }
          : {}),
      });

      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 0, status: 'done' } });
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 1, status: 'active' } });
      dispatch({ type: 'SET_TX_STATUS',  payload: { status: 'processing' } });

      const deadlineMs = Math.max((parseFloat(state.deadline) || 20) * 60_000, 30_000);
      try {
        await sdk.waitForSwap(res, deadlineMs);
      } catch (waitErr: any) {
        const isTimeout = /timeout|TIMEOUT/i.test(String(waitErr?.message ?? waitErr));
        const txHash = res?.hash ?? res?.txHash ?? '';
        const txLink = txHash ? `${explorerFor(netId)}/tx/${txHash}` : '#';
        const errMsg = isTimeout
          ? `Deadline of ${state.deadline} min exceeded. Your swap may still complete — check the explorer.`
          : sanitizeError(waitErr);
        dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 1, status: 'error' } });
        dispatch({ type: 'SET_TX_STATUS', payload: { status: 'error', txLink, errorMsg: errMsg } });
        return;
      }

      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 1, status: 'done' } });
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 2, status: 'active' } });

      if (isCrossChain) {
        // Brief delay between progress steps for readability.
        await new Promise(r => setTimeout(r, 2000));
        dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 2, status: 'done' } });
        dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 3, status: 'active' } });
        await new Promise(r => setTimeout(r, 600));
        dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 3, status: 'done' } });
      } else {
        await new Promise(r => setTimeout(r, 600));
        dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 2, status: 'done' } });
      }

      const txHash = res?.hash ?? res?.txHash ?? '';
      const txLink = txHash ? `${explorerFor(netId)}/tx/${txHash}` : '#';
      dispatch({ type: 'SET_TX_STATUS', payload: { status: 'success', txLink } });

      setAmount(''); clearEstimates();
      const toLabel = isCrossChain
        ? `${receiveAmt || '—'} ${to.token} on ${toNet.label}`
        : `${receiveAmt || '—'} ${to.token}`;
      showToast('success', 'Swap successful', `${amount} ${from.token} → ${toLabel}`);

    } catch (e) {
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 0, status: 'error' } });
      dispatch({ type: 'SET_TX_STATUS', payload: { status: 'error', errorMsg: sanitizeError(e) } });
    } finally {
      setBtnLoading(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────
  return (
    <div id="swap-content">

      {/* Mode toggle: Swap | Cross-Chain */}
      <div className="bridge-speed-toggle" style={{ marginBottom: 16 }}>
        <button
          className={`speed-btn${swapMode === 'swap' ? ' active express' : ''}`}
          onClick={() => setSwapMode('swap')}
        >
          <i className="ph-bold ph-arrows-left-right"></i>
          Swap
        </button>
        <button
          className={`speed-btn${swapMode === 'cross-chain' ? ' active economy' : ''}`}
          onClick={() => setSwapMode('cross-chain')}
        >
          <i className="ph-bold ph-planet"></i>
          Cross-Chain
        </button>
      </div>

      {/* Network selector — same-chain: single selector; cross-chain: from + to */}
      {swapMode === 'swap' ? (
        /* Same-chain: single network selector */
        <div className="bridge-section" style={{ marginBottom: 16, padding: '12px 16px' }}>
          <div className="section-header" style={{ marginBottom: 8 }}>
            <span>Network</span>
          </div>
            <div
              className="network-selector"
              id="network-select-swap"
              onClick={() => { dispatch({ type: 'SET_TARGET', payload: 'swap-net' }); dispatch({ type: 'OPEN_MODAL', payload: 'network' }); }}
              style={{ marginBottom: 0, width: '100%', justifyContent: 'space-between' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <NetworkLogo logo={netLogo} label={network} size={20} />
                <span>{network}</span>
              </div>
            <i className="ph-bold ph-caret-down" style={{ color: 'var(--text-muted)' }}></i>
          </div>
        </div>
      ) : (
        /* Cross-chain: from network (clickable) + to network (pill grid) */
        <div className="bridge-section" style={{ marginBottom: 16, padding: '12px 16px' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
            {/* From network */}
            <div style={{ flex: 1 }}>
              <div className="section-header" style={{ marginBottom: 8 }}>
                <span>From</span>
              </div>
              <div
                className="network-selector"
                onClick={() => { dispatch({ type: 'SET_TARGET', payload: 'swap-net' }); dispatch({ type: 'OPEN_MODAL', payload: 'network' }); }}
                style={{ justifyContent: 'space-between' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <NetworkLogo logo={netLogo} label={network} size={18} />
                  <span style={{ fontSize: '0.84rem' }}>{network}</span>
                </div>
                <i className="ph-bold ph-caret-down" style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}></i>
              </div>
            </div>

            {/* Arrow divider */}
            <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 10 }}>
              <i className="ph-bold ph-arrow-right" style={{ color: 'var(--text-muted)', fontSize: '1rem' }}></i>
            </div>

            {/* To network — pill selection */}
            <div style={{ flex: 1 }}>
              <div className="section-header" style={{ marginBottom: 8 }}>
                <span>To</span>
              </div>
              <div className="swap-to-net-grid">
                {NETWORKS.filter(n => n.id !== netId).map(n => {
                  const isSelected = n.id === toNetId;
                  return (
                    <button
                      key={n.id}
                      onClick={() => { setToNetId(n.id); setToNet(n); }}
                      className={`speed-btn${isSelected ? ' active economy' : ''}`}
                      title={n.label}
                      style={{ fontSize: '0.75rem', gap: 4, height: 38, borderRadius: 10 }}
                    >
                      <NetworkLogo logo={n.logo ?? null} label={n.label} size={14} />
                      <span>{n.shortLabel}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Same-network warning removed — source network is disabled in To pills */}
        </div>
      )}

      {/* Pay (FROM token) */}
      <div className="bridge-section">
        <div className="section-header">
          <span>Pay</span>
          <div className="balance-container">
            <span id="balance-from-swap">Balance: {balanceLoading ? '…' : balance}</span>
            <button className="max-btn" onClick={setMax}>MAX</button>
          </div>
        </div>
        <div className="token-input-row">
          <input
            type="text" inputMode="decimal" id="input-from-swap" placeholder="0.0"
            value={amount} onChange={e => handleAmountChange(e.target.value)}
            autoComplete="off" maxLength={18}
          />
          <div
            className="token-selector"
            id="token-select-from-swap"
            onClick={() => { dispatch({ type: 'SET_TARGET', payload: 'from-swap' }); dispatch({ type: 'OPEN_MODAL', payload: 'token' }); }}
          >
            <img src={from.tokLogo} alt={from.token} />
            <span>{from.token}</span>
            <i className="ph-bold ph-caret-down"></i>
          </div>
        </div>
        <div className="usd-value" id="usd-from-swap">{usdFromVal}</div>
      </div>

      {/* Switch button */}
      <div className="switch-wrapper">
        <button className="switch-btn" onClick={handleSwapSwitch}>
          <i className="ph-bold ph-arrow-down" style={{ transform: switchRotated ? 'rotate(180deg)' : 'rotate(0deg)' }}></i>
        </button>
      </div>

      {/* Receive (TO token) */}
      <div className="bridge-section">
        <div className="section-header">
          <span>Receive</span>
          <span id="balance-to-swap">Balance: {balanceLoading ? '…' : balanceTo}</span>
        </div>
        <div className="token-input-row">
          <input
            type="text" id="input-to-swap" placeholder="0.0" readOnly
            value={receiveAmt}
            style={{ color: receiveAmt ? 'var(--text-main)' : 'rgba(255,255,255,0.15)' }}
          />
          <div
            className="token-selector"
            id="token-select-to-swap"
            onClick={() => { dispatch({ type: 'SET_TARGET', payload: 'to-swap' }); dispatch({ type: 'OPEN_MODAL', payload: 'token' }); }}
          >
            <img src={to.tokLogo} alt={to.token} />
            <span>{to.token}</span>
            <i className="ph-bold ph-caret-down"></i>
          </div>
        </div>
        <div className="usd-value" id="usd-to-swap">{usdToVal}</div>
      </div>

      {/* Unsupported network notice */}
      {!swapSupported && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'rgba(239,68,68,0.07)',
          border: '1px solid rgba(239,68,68,0.2)',
          borderRadius: 10, padding: '9px 13px', marginBottom: 12,
          fontSize: '0.82rem', color: 'var(--text-muted)',
        }}>
          <i className="ph-bold ph-warning" style={{ color: '#ef4444', flexShrink: 0 }} />
          {isCrossChain
            ? 'Cross-Chain Swap is not available on this network.'
            : <>Swap is only supported on <strong style={{ color: 'var(--text-main)', margin: '0 3px' }}>ARC Network</strong>. Switch the network to swap.</>
          }
        </div>
      )}

      {/* Route info */}
      <div className="route-info">
        {isCrossChain && (
          <div className="route-row">
            <span>Route</span>
            <span style={{ color: 'var(--teal)', fontWeight: 600 }}>
              {network} → {toNet.label} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(CCTP)</span>
            </span>
          </div>
        )}
        {rateStr && (
          <div className="route-row">
            <span>Rate</span>
            <span style={{ color: 'var(--teal)', fontWeight: 600 }}>{rateStr}</span>
          </div>
        )}
        <div className="route-row">
          <span>Liquidity Provider Fee</span>
          <span>0.02%</span>
        </div>
        <div className="route-row">
          <span>Price Impact</span>
          <span className={
            !priceImpact || impactNum < 5 ? 'text-green'
            : impactNum < 15              ? 'text-yellow'
            :                               'text-red'
          }>
            {priceImpact || '< 0.01%'}
          </span>
        </div>
        <div className="route-row">
          <span>Gas Fee</span>
          <span style={{ color: (/arc/i.test(network) || state.gasless) ? 'var(--teal)' : 'var(--text-muted)' }}>
            {/arc/i.test(network)
              ? 'USDC (native)'
              : state.gasless
                ? <><i className="ph-bold ph-lightning" style={{ fontSize: '0.75rem', marginRight: 4 }}></i>USDC (gasless)</>
                : 'ETH'
            }
          </span>
        </div>
      </div>

      {/* Price impact warnings */}
      {isHighImpact && (
        <div className="settings-notice warn" style={{ marginBottom: 8 }}>
          <i className="ph-fill ph-warning"></i>
          <span>High price impact. You may receive significantly less.</span>
        </div>
      )}
      {isVeryHighImpact && (
        <div className="settings-notice warn" style={{ marginBottom: 8 }}>
          <i className="ph-fill ph-warning"></i>
          <span>Very high price impact. Consider a smaller amount.</span>
        </div>
      )}
      {isExtremeImpact && (
        <div className="settings-notice warn" style={{ marginBottom: 8, borderColor: 'var(--error-red)', color: 'var(--error-red)' }}>
          <i className="ph-fill ph-x-circle"></i>
          <span>Price impact too high. Swap is blocked to protect your funds.</span>
        </div>
      )}

      {/* Cross-chain notice */}
      {isCrossChain && !sameNetCrossChain && (
        <div className="settings-notice" style={{ marginBottom: 8, borderColor: 'rgba(45,212,191,0.35)', background: 'rgba(45,212,191,0.06)' }}>
          <i className="ph-fill ph-planet" style={{ color: 'var(--teal)' }}></i>
          <span style={{ color: 'var(--teal)' }}>
            Funds arrive on <strong>{toNet.label}</strong> via CCTP — approximately 20 seconds.
          </span>
        </div>
      )}

      {/* Action button */}
      <button
        className="btn-action"
        id="main-action-btn-swap"
        onClick={!address ? () => dispatch({ type: 'OPEN_MODAL', payload: 'wallet' }) : execute}
        disabled={btnDisabled}
      >
        {btnLoading
          ? <><i className="ph-bold ph-spinner spinner"></i> Confirming in Wallet...</>
          : btnLabel
        }
      </button>
    </div>
  );
}
