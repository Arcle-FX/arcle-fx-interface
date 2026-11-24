// ============================================================
//  UnifiedTab — Deposit into Unified Balance + Spend from it
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useAccount }     from 'wagmi';
import { useSwitchChain } from 'wagmi';
import { useAppContext }  from '../../context/AppContext';
import { usePrices }      from '../../hooks/usePrices';
import NetworkLogo        from '../NetworkLogo';
import * as sdk           from '../../lib/sdk';
import { formatUsdValue, sanitizeAmount, sanitizeError } from '../../lib/formatters';
import { explorerFor, NETWORKS }    from '../../config/constants';
import { showToast }      from '../Modals';
import { isValidAddress } from '../../lib/sdk';
import type { UnifiedBalance } from '../../types';

/** Clean balance display: floor at 2 decimal places so shown amount is always ≤ actual.
 *  e.g. 5.2357 → "5.23" (never shows more than you can actually send) */
function formatBal(v: string | undefined): string {
  if (!v) return '0';
  const n = parseFloat(v);
  if (!isFinite(n) || n === 0) return '0';
  if (n < 0.01) return '<0.01';
  // Floor at 2 decimal places: 5.239 → 5.23 (never overpromises)
  const floored = Math.floor(n * 100) / 100;
  return floored.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Per-chain fee buffers for maxSendable() calculation.
 *
 * Values sourced from Circle SDK's internal GAS_FEE_BY_CHAIN map
 * (node_modules/@circle-fin/unified-balance-kit/index.mjs):
 *   Ethereum: 2.00 USDC  ← confirmed from SDK source
 *   Base:     0.01 USDC
 *   Arbitrum: 0.01 USDC
 *
 * We add a safety margin on top (+0.09 for Base/Arb, +0.10 for ETH).
 * Ethereum buffer = 2.10 means ETH balance needs > 2.10 to contribute to MAX.
 * With 3.04 USDC on ETH: contribution = 3.04 - 2.10 = 0.94 USDC ✅
 *
 * IMPORTANT: These values MUST stay in sync with CHAIN_FEE_BUFFER_SDK in sdk.ts.
 */
const DUST_THRESHOLD = 0.015; // chains below this carry no spendable balance
const MIN_SEND_USDC  = 0.10;  // Circle Gateway minimum spend amount
const MAX_SENDABLE_FEE_RESERVE = 0.20; // kept for guard-check messages only

const CHAIN_FEE_BUFFER: Record<string, number> = {
  Base:      0.10,  // SDK gas fee 0.01 USDC + 0.09 USDC margin
  Arbitrum:  0.10,  // SDK gas fee 0.01 USDC + 0.09 USDC margin
  Ethereum:  2.10,  // SDK gas fee 2.00 USDC + 0.10 USDC margin
  Arc:       0.01,  // SDK gas fee 0.001 USDC + 0.009 USDC margin
};
const DEFAULT_CHAIN_FEE_BUFFER = 2.10; // conservative fallback for unknown chains

/**
 * Returns the maximum sendable amount accounting for per-chain forwarding fees.
 * Uses per-chain fee buffers (not a single global reserve) so ETH's expensive
 * route doesn't over-inflate the MAX for Base-only users, and doesn't
 * under-estimate the MAX when ETH is included (causing Circle 9001 errors).
 *
 * Actual spend uses Circle auto-allocation — this is only for the MAX button.
 */
function maxSendable(ubData: UnifiedBalance | null): string {
  if (!ubData) return '';

  const chains = ubData.chains.filter(c => parseFloat(c.balance) > DUST_THRESHOLD);
  if (chains.length === 0) return '';

  let effectiveTotal = 0;
  for (const c of chains) {
    const balance   = parseFloat(c.balance);
    const feeBuffer = CHAIN_FEE_BUFFER[c.netId] ?? DEFAULT_CHAIN_FEE_BUFFER;
    const effective = balance - feeBuffer;
    if (effective > 0) effectiveTotal += effective;
  }

  // Below Circle's minimum send threshold → nothing sendable
  if (effectiveTotal < MIN_SEND_USDC) return '';
  return effectiveTotal.toFixed(6).replace(/\.?0+$/, '') || '0';
}

// Source chains that support Unified Balance deposits (Circle Gateway)
// — logos pulled from NETWORKS config to stay consistent
const DEPOSIT_CHAIN_IDS = ['Base', 'Ethereum', 'Arbitrum'];

type SubTab = 'deposit' | 'send';

export default function UnifiedTab() {
  const { dispatch }    = useAppContext();
  const { address }     = useAccount();
  const prices          = usePrices();
  const { switchChainAsync } = useSwitchChain();

  // Build deposit chain list from NETWORKS (same logos as rest of the app)
  const DEPOSIT_CHAINS = NETWORKS.filter(n => DEPOSIT_CHAIN_IDS.includes(n.id));

  const [subTab,         setSubTab]         = useState<SubTab>('deposit');
  const [ubData,         setUbData]         = useState<UnifiedBalance | null>(null);
  const [amount,         setAmount]         = useState('');
  const [recipient,      setRecipient]      = useState('');
  const [sourceChain,    setSourceChain]    = useState(DEPOSIT_CHAINS[0].id);
  const [usdVal,         setUsdVal]         = useState('');
  const [btnState,       setBtnState]       = useState<'idle' | 'loading'>('idle');
  const [refreshing,     setRefreshing]     = useState(false);
  const [recipientFocused, setRecipientFocused] = useState(false);

  // ── Shared validation ────────────────────────────────────
  const amtNum    = parseFloat(amount);
  const amtValid  = isFinite(amtNum) && amtNum > 0;
  const addrValid = isValidAddress(recipient);
  const totalBal  = parseFloat(ubData?.total ?? '0');
  const balLoaded = ubData !== null;

  // canSendAnything: true when maxSendable > MIN_SEND_USDC threshold
  // Used to disable the input and hide MAX when fees block all sends.
  const canSendAnything = balLoaded
    ? parseFloat(maxSendable(ubData) || '0') >= MIN_SEND_USDC
    : true; // optimistic until balance loads

  // ── Deposit button label ─────────────────────────────────
  const depositBtnLabel: string =
    !address                      ? 'Connect Wallet'  :
    !amount                       ? 'Enter an amount' :
    !amtValid                     ? 'Invalid amount'  :
    btnState === 'loading'        ? 'Depositing…'     :
                                    'Deposit USDC';
  const depositBtnDisabled =
    btnState === 'loading' ||
    (!!address && !amtValid);

  // ── Send button label ────────────────────────────────────
  const sendBtnLabel: string =
    !address                          ? 'Connect Wallet'           :
    balLoaded && !canSendAnything     ? 'Insufficient for fees'    :
    !amount                           ? 'Enter an amount'          :
    !amtValid                         ? 'Invalid amount'           :
    balLoaded && totalBal < amtNum    ? 'Insufficient balance'     :
    recipient && !addrValid           ? 'Invalid address'          :
    !recipient                        ? 'Enter recipient'          :
    btnState === 'loading'            ? 'Confirming…'              :
                                        'Send USDC';
  const sendBtnDisabled =
    btnState === 'loading' ||
    (!!address && (
      (balLoaded && !canSendAnything) ||
      !amtValid || !addrValid ||
      (balLoaded && totalBal < amtNum)
    ));

  // ── Fetch Unified Balance ────────────────────────────────
  // manualRefresh: shows spinner + is user-triggered
  // silentRefresh: background update after deposit/send (no spinner)
  const refresh = useCallback(async () => {
    if (!address) return;
    setRefreshing(true);
    try {
      const data = await sdk.fetchUnifiedBalance(address);
      setUbData(data);
    } catch {
      /* keep existing data if fetch fails */
    } finally {
      setRefreshing(false);
    }
  }, [address]);

  const silentRefresh = useCallback(async () => {
    if (!address) return;
    try {
      const data = await sdk.fetchUnifiedBalance(address);
      setUbData(data);
    } catch { /* ignore */ }
  }, [address]);

  // ── Auto-poll while pending deposits exist ───────────────
  // If there are pending deposits (CCTP in-flight), poll every 30 s
  // until they confirm — covers the 2–20 min CCTP attestation window.
  useEffect(() => {
    const hasPending = ubData?.pendingTotal && parseFloat(ubData.pendingTotal) > 0;
    if (!hasPending || !address) return;
    const id = setInterval(silentRefresh, 30_000);
    return () => clearInterval(id);
  }, [ubData?.pendingTotal, address, silentRefresh]);

  // Fetch once on mount / wallet connect — no background polling
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // Clear form when switching sub-tabs
  function switchTab(t: SubTab) {
    setSubTab(t);
    setAmount('');
    setUsdVal('');
    setRecipient('');
  }

  function handleAmount(val: string) {
    const clean = sanitizeAmount(val);
    setAmount(clean);
    const n = parseFloat(clean);
    if (isFinite(n) && n > 0) setUsdVal(`~${formatUsdValue(n * (prices.USDC ?? 1))}`);
    else setUsdVal('');
  }

  // ── Deposit execute ──────────────────────────────────────
  async function executeDeposit() {
    if (!address) { dispatch({ type: 'OPEN_MODAL', payload: 'wallet' }); return; }
    const n = parseFloat(amount);
    if (!isFinite(n) || n <= 0) return;

    const srcChain = DEPOSIT_CHAINS.find(c => c.id === sourceChain)!;

    const steps = [
      { label: 'Confirm in wallet',      status: 'pending' as const },
      { label: 'Depositing to Gateway',  status: 'pending' as const },
      { label: 'Deposit complete',       status: 'pending' as const },
    ];

    dispatch({ type: 'OPEN_TX_PROGRESS', payload: {
      type: 'unified', status: 'waiting',
      steps,
      fromLabel: `${amount} USDC (${srcChain.label})`,
      toLabel:   `${amount} USDC (Unified Balance)`,
      fromLogo:  'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
      toLogo:    'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
      txLink: '#', errorMsg: '',
    }});

    dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 0, status: 'active' } });
    setBtnState('loading');

    try {
      const res: any = await sdk.executeUnifiedDeposit({
        sourceChain: srcChain.id,
        amount: String(n),
        token: 'USDC',
        switchAsync: switchChainAsync,
      });

      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 0, status: 'done' } });
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 1, status: 'active' } });
      dispatch({ type: 'SET_TX_STATUS',  payload: { status: 'processing' } });
      await new Promise(r => setTimeout(r, 1000));

      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 1, status: 'done' } });
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 2, status: 'active' } });
      await new Promise(r => setTimeout(r, 700));
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 2, status: 'done' } });

      // deposit() returns DepositResult: { txHash: string, explorerUrl?: string, chain: Blockchain, ... }
      // res.txHash is already extracted as string by executeUnifiedDeposit.
      // explorerUrl from SDK has the correct explorer; fall back to our own construction.
      const depositTxHash: string =
        typeof res === 'string' ? res :
        (res?.txHash ?? res?.hash ?? '');
      const txChain = res?.sourceChainId ?? sourceChain;
      const txLink =
        (res?.explorerUrl && !res.explorerUrl.includes('[object')) ? res.explorerUrl :
        (depositTxHash && depositTxHash.startsWith('0x'))
          ? `${explorerFor(txChain)}/tx/${depositTxHash}`
          : '#';
      dispatch({ type: 'SET_TX_STATUS', payload: { status: 'success', txLink } });

      setAmount(''); setUsdVal('');
      // Silent background refresh: CCTP attestation can take 2–20 min.
      // Poll frequently at first, then taper off to cover slow chains (Ethereum).
      silentRefresh();
      setTimeout(silentRefresh,   5_000);  // 5 s
      setTimeout(silentRefresh,  15_000);  // 15 s
      setTimeout(silentRefresh,  30_000);  // 30 s
      setTimeout(silentRefresh,  60_000);  // 1 min
      setTimeout(silentRefresh, 120_000);  // 2 min
      setTimeout(silentRefresh, 300_000);  // 5 min
      setTimeout(silentRefresh, 600_000);  // 10 min
      showToast('success', 'Deposit submitted', `${amount} USDC depositing — balance updates in 2–20 min (CCTP)`);
    } catch (e: any) {
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 0, status: 'error' } });
      const raw = String(e?.message ?? e ?? '');
      // Friendly message when user picks a chain where they have no USDC
      const friendly =
        /insufficient token balance|insufficient.*balance|balance.*insufficient/i.test(raw)
          ? `No USDC on ${srcChain.label}. Please add USDC to that network first, then try depositing again.`
          : sanitizeError(e);
      dispatch({ type: 'SET_TX_STATUS', payload: { status: 'error', errorMsg: friendly } });
    } finally {
      setBtnState('idle');
    }
  }

  // ── Send execute ─────────────────────────────────────────
  async function executeSend() {
    if (!address) { dispatch({ type: 'OPEN_MODAL', payload: 'wallet' }); return; }
    const n = parseFloat(amount);
    if (!isFinite(n) || n <= 0) return;
    if (!isValidAddress(recipient)) return;

    const bal = parseFloat(ubData?.total ?? '0');
    if (ubData !== null && bal < n) {
      dispatch({ type: 'SET_ERROR', payload: `Insufficient balance. Available: ${formatBal(ubData?.total)} USDC` });
      dispatch({ type: 'OPEN_MODAL', payload: 'error' });
      return;
    }
    // Guard: if amount exceeds max sendable (after fee reserve), warn early.
    if (ubData !== null && bal > 0) {
      const maxAmt      = parseFloat(maxSendable(ubData) || '0');

      if (maxAmt < MIN_SEND_USDC) {
        // Build a helpful message that names the actual per-chain fee requirements
        // instead of the old generic "0.30 USDC" threshold.
        const ethChain  = ubData.chains.find(c => c.netId === 'Ethereum');
        const ethBal    = parseFloat(ethChain?.balance ?? '0');
        // Any chain other than Ethereum with enough balance above its fee buffer
        const cheapSendable = ubData.chains
          .filter(c => c.netId !== 'Ethereum')
          .some(c => parseFloat(c.balance) - (CHAIN_FEE_BUFFER[c.netId] ?? DEFAULT_CHAIN_FEE_BUFFER) > 0);

        let errMsg: string;
        if (!cheapSendable && ethBal > DUST_THRESHOLD && ethBal <= 2.10) {
          errMsg = `ETH network fee is 2.00 USDC · Your ${ethBal.toFixed(2)} USDC is not enough · Deposit on Ethereum (need > 2.10 USDC) or use Base / Arbitrum.`;
        } else {
          errMsg = `Network fees exceed your balance · ETH needs > 2.10 USDC · Base / Arbitrum need > 0.20 USDC.`;
        }
        dispatch({ type: 'SET_ERROR', payload: errMsg });
        dispatch({ type: 'OPEN_MODAL', payload: 'error' });
        return;
      }
      if (n > maxAmt + 0.000001) {
        dispatch({ type: 'SET_ERROR', payload: `Amount too high after network fees. Max sendable: ${maxAmt.toFixed(4)} USDC (use the MAX button)` });
        dispatch({ type: 'OPEN_MODAL', payload: 'error' });
        return;
      }
    }

    const steps = [
      { label: 'Confirm in wallet',      status: 'pending' as const },
      { label: 'Submitting transaction', status: 'pending' as const },
      { label: 'Transfer complete',      status: 'pending' as const },
    ];

    dispatch({ type: 'OPEN_TX_PROGRESS', payload: {
      type: 'unified', status: 'waiting',
      steps,
      fromLabel: `${amount} USDC`,
      toLabel:   `${amount} USDC`,
      fromLogo:  'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
      toLogo:    'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
      txLink: '#', errorMsg: '',
    }});

    dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 0, status: 'active' } });
    setBtnState('loading');

    try {
      const amountStr = String(n);
      const res: any = await sdk.executeUnifiedSpend({
        amount: amountStr,
        token: 'USDC',
        toAddress: recipient,
        cachedUbData: ubData ?? undefined,  // pass UI balance as fallback
      });

      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 0, status: 'done' } });
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 1, status: 'active' } });
      dispatch({ type: 'SET_TX_STATUS',  payload: { status: 'processing' } });
      await new Promise(r => setTimeout(r, 1000));

      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 1, status: 'done' } });
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 2, status: 'active' } });
      await new Promise(r => setTimeout(r, 700));
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 2, status: 'done' } });

      // spend() returns SpendResult: { txHash: string, explorerUrl?: string, ... }
      // explorerUrl from SDK is the most reliable; fall back to our own construction.
      const spendTxHash: string =
        typeof res === 'string' ? res :
        (res?.txHash ?? res?.hash ?? res?.transactionHash ?? '');
      const txLink =
        (res?.explorerUrl && !res.explorerUrl.includes('[object')) ? res.explorerUrl :
        (spendTxHash && spendTxHash.startsWith('0x'))
          ? `${explorerFor('Arc')}/tx/${spendTxHash}`
          : '#';
      dispatch({ type: 'SET_TX_STATUS', payload: { status: 'success', txLink } });

      setAmount(''); setRecipient(''); setUsdVal('');
      // Silent background refresh after send
      silentRefresh();
      setTimeout(silentRefresh, 3_000);
      setTimeout(silentRefresh, 10_000);
      showToast('success', 'Transfer successful', `${amount} USDC sent`);
    } catch (e) {
      dispatch({ type: 'UPDATE_TX_STEP', payload: { index: 0, status: 'error' } });
      // Use the error message directly if it's one we threw ourselves (contains USDC amounts).
      // sanitizeError() maps "insufficient balance" to a generic wallet-funding message
      // which is wrong here — the issue is Circle Gateway balance, not wallet balance.
      const raw = String((e as any)?.message ?? e ?? '');
      const isOurError = /USDC|unified|deposit|gateway|network fee|sendable/i.test(raw);
      const errorMsg = isOurError ? raw : sanitizeError(e);
      dispatch({ type: 'SET_TX_STATUS', payload: { status: 'error', errorMsg } });
    } finally {
      setBtnState('idle');
    }
  }

  // ── Render ───────────────────────────────────────────────
  return (
    <div id="unified-content">

      {/* Total Balance Card */}
      <div className="bridge-section" style={{ marginBottom: 16 }}>
        <div className="section-header" style={{ marginBottom: 12 }}>
          <span>Total USDC Balance</span>
          <button className="max-btn" onClick={refresh} disabled={refreshing}>
            <i className={`ph-bold ph-arrows-clockwise${refreshing ? ' spinner' : ''}`} style={{ fontSize: '0.75rem' }}></i> {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <div style={{ textAlign: 'center', padding: '8px 0 14px' }}>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--teal)', letterSpacing: '-0.5px' }}>
            {ubData ? formatBal(ubData.total) : (address ? '…' : '—')} USDC
          </div>
          {/* Show pending total if there are in-flight deposits */}
          {ubData?.pendingTotal && parseFloat(ubData.pendingTotal) > 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: 4 }}>
              <i className="ph-bold ph-clock" style={{ marginRight: 4, color: '#f59e0b' }}></i>
              <span style={{ color: '#f59e0b' }}>{formatBal(ubData.pendingTotal)} USDC pending</span>
              <span style={{ marginLeft: 4 }}>(confirming…)</span>
            </div>
          )}
          <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: 4 }}>
            Spendable across all networks
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {ubData?.chains.map(c => (
            <div key={c.netId} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '7px 10px', background: 'rgba(255,255,255,0.04)', borderRadius: 8,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <NetworkLogo logo={c.logo} label={c.label} size={18} />
                <span style={{ fontSize: '0.83rem', color: 'var(--text-muted)' }}>{c.label}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>{formatBal(c.balance)} USDC</span>
                {c.pendingBalance && parseFloat(c.pendingBalance) > 0 && (
                  <span style={{ fontSize: '0.72rem', color: '#f59e0b' }}>
                    <i className="ph-bold ph-clock" style={{ marginRight: 2 }}></i>
                    +{formatBal(c.pendingBalance)} pending
                  </span>
                )}
              </div>
            </div>
          ))}
          {!ubData && address && (
            <div style={{ textAlign: 'center', fontSize: '0.85rem', color: 'var(--text-muted)', padding: '8px 0' }}>
              Loading balances…
            </div>
          )}
          {!address && (
            <div style={{ textAlign: 'center', fontSize: '0.85rem', color: 'var(--text-muted)', padding: '8px 0' }}>
              Connect your wallet to see balances
            </div>
          )}
        </div>
      </div>

      {/* Sub-tab switcher: Deposit / Send */}
      <div style={{
        display: 'flex', gap: 4, marginBottom: 14,
        background: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: 4,
      }}>
        {(['deposit', 'send'] as SubTab[]).map(t => (
          <button
            key={t}
            onClick={() => switchTab(t)}
            style={{
              flex: 1, padding: '8px 0', borderRadius: 9, fontWeight: 600,
              fontSize: '0.85rem', border: 'none', cursor: 'pointer', transition: 'all 0.2s',
              background: subTab === t ? 'var(--teal)' : 'transparent',
              color: subTab === t ? '#000' : 'var(--text-muted)',
            }}
          >
            {t === 'deposit' ? '① Deposit' : '② Send'}
          </button>
        ))}
      </div>

      {/* ── DEPOSIT panel ─────────────────────────────────── */}
      {subTab === 'deposit' && (
        <>
          <div className="bridge-section">
            {/* Info banner */}
            <div style={{
              display: 'flex', gap: 8, alignItems: 'flex-start',
              background: 'rgba(0,200,180,0.07)', border: '1px solid rgba(0,200,180,0.18)',
              borderRadius: 10, padding: '10px 12px', marginBottom: 14,
              fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.5,
            }}>
              <i className="ph-bold ph-info" style={{ color: 'var(--teal)', fontSize: '1rem', marginTop: 1 }}></i>
              <span>
                Deposit USDC from any supported chain into your Unified Balance first.
                Then use <strong style={{ color: 'var(--text-main)' }}>② Send</strong> to spend it instantly on Arc Network.
              </span>
            </div>

            <div className="section-header" style={{ marginBottom: 10 }}>
              <span>Source Chain</span>
            </div>

            {/* Source chain selector */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
              {DEPOSIT_CHAINS.map(c => (
                <button
                  key={c.id}
                  onClick={() => setSourceChain(c.id)}
                  style={{
                    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
                    gap: 4, padding: '8px 4px', borderRadius: 10, cursor: 'pointer',
                    border: `1px solid ${sourceChain === c.id ? 'var(--teal)' : 'var(--border-light)'}`,
                    background: sourceChain === c.id ? 'rgba(0,200,180,0.08)' : 'rgba(255,255,255,0.03)',
                    transition: 'all 0.2s',
                  }}
                >
                  <NetworkLogo logo={c.logo} label={c.label} size={20} />
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.2 }}>
                    {c.shortLabel}
                  </span>
                </button>
              ))}
            </div>

            <div className="section-header" style={{ marginBottom: 8 }}>
              <span>Amount</span>
            </div>

            <div className="token-input-row">
              <input
                type="text" inputMode="decimal" placeholder="0.0"
                value={amount} onChange={e => handleAmount(e.target.value)}
                maxLength={18}
              />
              <div className="token-selector" style={{ cursor: 'default' }}>
                <img src="https://assets.coingecko.com/coins/images/6319/small/usdc.png" alt="USDC" />
                <span>USDC</span>
              </div>
            </div>
            <div className="usd-value">{usdVal}</div>
          </div>

          <div className="route-info">
            <div className="route-row">
              <span>Destination</span>
              <span style={{ color: 'var(--teal)' }}>Unified Balance (Gateway)</span>
            </div>
            <div className="route-row">
              <span>Powered by</span>
              <span className="text-green">Circle Gateway</span>
            </div>
          </div>

          <button
            className="btn-action"
            style={{ marginTop: 4 }}
            onClick={!address ? () => dispatch({ type: 'OPEN_MODAL', payload: 'wallet' }) : executeDeposit}
            disabled={depositBtnDisabled}
          >
            {btnState === 'loading'
              ? <><i className="ph-bold ph-spinner spinner" style={{ marginRight: 6 }}></i>Depositing…</>
              : depositBtnLabel
            }
          </button>
        </>
      )}

      {/* ── SEND panel ────────────────────────────────────── */}
      {subTab === 'send' && (
        <>
          <div className="bridge-section">
            <div className="section-header">
              <span>Send USDC</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                  Balance: {ubData ? formatBal(ubData.total) : '—'} USDC
                </span>
                {ubData && canSendAnything && (() => { const max = maxSendable(ubData); return max ? (
                  <button
                    className="max-btn"
                    onClick={() => handleAmount(max)}
                    style={{ padding: '2px 8px', fontSize: '0.72rem' }}
                  >
                    MAX
                  </button>
                ) : null; })()}
              </div>
            </div>

            {/* Warn when balance exists but is spread too thin to send */}
            {ubData && parseFloat(ubData.total) > 0 && !maxSendable(ubData) && (() => {
              const ethChain = ubData.chains.find(c => c.netId === 'Ethereum');
              const ethBal   = parseFloat(ethChain?.balance ?? '0');
              const cheapSendable = ubData.chains
                .filter(c => c.netId !== 'Ethereum')
                .some(c => parseFloat(c.balance) - (CHAIN_FEE_BUFFER[c.netId] ?? DEFAULT_CHAIN_FEE_BUFFER) > 0);

              const msg = (!cheapSendable && ethBal > DUST_THRESHOLD && ethBal <= 2.10)
                ? <>ETH network fee is <strong style={{ color: 'var(--text-main)' }}>2.00 USDC</strong> · Your {ethBal.toFixed(2)} USDC is not enough<br />Try Base or Arbitrum (0.10 USDC fee)</>
                : <>Network fees exceed your balance<br />ETH needs &gt; 2.10 USDC · Base / Arbitrum need &gt; 0.20 USDC</> ;

              return (
                <div style={{
                  fontSize: '0.78rem', color: '#f59e0b',
                  background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)',
                  borderRadius: 8, padding: '7px 10px', marginBottom: 8,
                  display: 'flex', alignItems: 'flex-start', gap: 6,
                }}>
                  <i className="ph-bold ph-warning" style={{ marginTop: 1, flexShrink: 0 }} />
                  <span>{msg}</span>
                </div>
              );
            })()}

            <div className="token-input-row">
              <input
                type="text" inputMode="decimal"
                placeholder="0.0"
                value={amount}
                onChange={e => handleAmount(e.target.value)}
                disabled={!canSendAnything}
                maxLength={18}
                style={!canSendAnything ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
              />
              <div className="token-selector" style={{ cursor: 'default' }}>
                <img src="https://assets.coingecko.com/coins/images/6319/small/usdc.png" alt="USDC" />
                <span>USDC</span>
              </div>
            </div>
            <div className="usd-value">{usdVal}</div>

            <input
              type="text"
              placeholder="Recipient address (0x...)"
              value={recipient}
              onChange={e => setRecipient(e.target.value)}
              autoComplete="off"
              disabled={!canSendAnything}
              style={{
                width: '100%', marginTop: 10, background: 'rgba(255,255,255,0.05)',
                border: `1px solid ${recipientFocused ? 'var(--teal)' : 'var(--border-light)'}`,
                borderRadius: 12,
                padding: '12px 16px', color: 'var(--text-main)', fontSize: '0.9rem',
                outline: 'none', fontFamily: 'inherit', transition: 'border-color 0.2s',
                ...(!canSendAnything ? { opacity: 0.4, cursor: 'not-allowed' } : {}),
              }}
              onFocus={() => setRecipientFocused(true)}
              onBlur={() => setRecipientFocused(false)}
            />
          </div>

          <div className="route-info">
            <div className="route-row">
              <span>Protocol Fee</span>
              <span>0.10% (Unified Balance)</span>
            </div>
            <div className="route-row">
              <span>Powered by</span>
              <span className="text-green">Circle CCTP</span>
            </div>
          </div>

          <button
            className="btn-action"
            style={{ marginTop: 4 }}
            onClick={!address ? () => dispatch({ type: 'OPEN_MODAL', payload: 'wallet' }) : executeSend}
            disabled={sendBtnDisabled}
          >
            {btnState === 'loading'
              ? <><i className="ph-bold ph-spinner spinner" style={{ marginRight: 6 }}></i>Confirming…</>
              : sendBtnLabel
            }
          </button>
        </>
      )}
    </div>
  );
}
