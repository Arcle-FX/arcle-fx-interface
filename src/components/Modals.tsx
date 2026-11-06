// ============================================================
//  All modals — rendered via React Portal into <body>
//  This escapes ancestor transform/opacity transitions that
//  would otherwise break position:fixed stacking.
// ============================================================

import { useEffect, useState }                    from 'react';
import { createPortal }                           from 'react-dom';
import { useAppContext }                          from '../context/AppContext';
import { NETWORKS, TOKENS, TOKEN_ADDRESSES }       from '../config/constants';
import NetworkLogo                                from './NetworkLogo';
import { useConnect, useConnectors, useAccount, useDisconnect, useChainId } from 'wagmi';
import { injected, coinbaseWallet }               from 'wagmi/connectors';
import { mainnet }                                from 'wagmi/chains';
import * as sdk                                   from '../lib/sdk';
import { ADD_CHAIN_PARAMS }                       from '../config/constants';

// ── Helper: init SDK adapter from any wagmi connector provider ──
// Coinbase Wallet and WalletConnect don't use window.ethereum, so we
// must fetch their EIP-1193 provider directly from the wagmi connector
// and pass it to the SDK adapter after a successful connection.
async function initSdkAdapterFromConnector(connector: any, address: string) {
  try {
    const provider = await connector.getProvider?.();
    if (provider && address) {
      await sdk.initAdapterFromProvider(provider, address, connector.id);
    }
  } catch {
    // non-fatal — adapter remains null
  }
}
import { useGasFee }                              from '../hooks/useGasFee';
import { safeTxLink }                             from '../lib/formatters';

const wcProjectId = import.meta.env.VITE_WC_PROJECT_ID as string | undefined;

// ── Connector display metadata ───────────────────────────────
const CONNECTOR_META: Record<string, { label: string; logo: string }> = {
  metaMask:      { label: 'MetaMask',       logo: 'https://upload.wikimedia.org/wikipedia/commons/3/36/MetaMask_Fox.svg' },
  injected:      { label: 'MetaMask',       logo: 'https://upload.wikimedia.org/wikipedia/commons/3/36/MetaMask_Fox.svg' },
  walletConnect: { label: 'WalletConnect',  logo: 'https://walletconnect.com/icon.png?14b0dfc4ce526451' },
  coinbaseWalletSDK: { label: 'Coinbase Wallet', logo: 'https://avatars.githubusercontent.com/u/18060234?s=200&v=4' },
  coinbaseWallet:    { label: 'Coinbase Wallet', logo: 'https://avatars.githubusercontent.com/u/18060234?s=200&v=4' },
  circlePaymaster:   { label: 'Circle Paymaster', logo: '/circle-icon.png' },
};

// ── Module-level synchronous lock ────────────────────────────
// This ref is shared across ALL renders of WalletModal and is updated
// SYNCHRONOUSLY (no React batching delay).  It is the first line of
// defence against rapid double-clicks or re-opens while a wallet
// popup is still waiting for user approval.
let _syncLock: string | null = null;

// ── Wallet Modal ─────────────────────────────────────────────
/**
 * Wallet connection modal — MetaMask, WalletConnect, Coinbase Wallet, Circle Paymaster.
 *
 * Locking strategy (three layers):
 *  1. Module-level `_syncLock`         — synchronous, zero-delay, prevents any
 *                                        click handler from running while a
 *                                        connection is already in flight.
 *  2. AppContext `state.connectorLock` — React state, drives UI (spinner, opacity,
 *                                        pending banner). Persists across modal
 *                                        close / re-open because it lives outside
 *                                        the component tree.
 *  3. wagmi `isPending`                — authoritative in-flight signal from wagmi.
 *                                        Combined with (2) so that `isLocked` is
 *                                        true if EITHER source says we are busy.
 */
export function WalletModal() {
  const { state, dispatch }   = useAppContext();
  const { connectAsync, isPending, variables: pendingVars } = useConnect();
  const connectors             = useConnectors();
  const { address, connector: activeConnector } = useAccount();
  const { disconnect }         = useDisconnect();
  const isActive               = state.activeModal === 'wallet';

  // Detect if MetaMask extension is installed and active
  const isMetaMaskInstalled = typeof window !== 'undefined' &&
    Boolean((window as any).ethereum?.isMetaMask);

  // ── isLocked: true when ANY connection is in-flight ──────────
  // Uses wagmi's isPending OR our context lock — whichever is truthy.
  // isPending alone is sufficient to lock the UI — connector id may be absent during handshake.
  const isLocked: boolean = isPending || Boolean(state.connectorLock) || Boolean(_syncLock);

  // ── pendingConnectorId: which wallet is currently active ─────
  // Used only for showing the spinner on the correct row.
  const pendingConnectorId: string | null =
    state.connectorLock ??
    (isPending && pendingVars?.connector && typeof pendingVars.connector === 'object' && 'id' in pendingVars.connector
      ? (pendingVars.connector as { id: string }).id
      : null);

  // ── Helpers ──────────────────────────────────────────────────
  function acquireLock(id: string) {
    _syncLock = id;                                          // synchronous — instant
    dispatch({ type: 'SET_CONNECTOR_LOCK', payload: id });   // async — drives UI
  }
  function releaseLock() {
    _syncLock = null;
    dispatch({ type: 'SET_CONNECTOR_LOCK', payload: null });
  }

  function close() {
    // IMPORTANT: do NOT call releaseLock() here.
    // If a wallet popup is still open, the lock must survive modal close/re-open.
    dispatch({ type: 'CLOSE_MODAL' });
  }

  // ── MetaMask ─────────────────────────────────────────────────
  async function connectMM() {
    // MetaMask not installed — open download page and exit immediately
    if (!isMetaMaskInstalled) {
      window.open('https://metamask.io/download/', '_blank', 'noopener,noreferrer');
      return;
    }
    // Triple-check: sync ref first (instant), then React state, then wagmi
    if (_syncLock || isLocked) return;
    acquireLock('metaMask');
    try {
      // EIP-6963: use the 'metaMask' targeted connector so wagmi selects
      // MetaMask's own provider even when Coinbase Wallet is also installed.
      const mmConnector = connectors.find(c => c.id === 'metaMask') ?? injected();
      await connectAsync({ connector: mmConnector });
      await sdk.ensureAdapter();
      releaseLock();
      close();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      releaseLock();
      if (/provider not found/i.test(msg)) {
        // Extension was removed or disabled after page load — prompt install
        window.open('https://metamask.io/download/', '_blank', 'noopener,noreferrer');
      } else if (/already pending/i.test(msg)) {
        dispatch({ type: 'SET_ERROR', payload: 'MetaMask is already open. Please check your wallet extension and approve or reject the pending request.' });
        dispatch({ type: 'OPEN_MODAL', payload: 'error' });
      } else if (/user (rejected|denied)/i.test(msg)) {
        showToast('info', 'Connection cancelled', 'Wallet connection was rejected.');
        setTimeout(() => close(), 1200);
      } else {
        dispatch({ type: 'SET_ERROR', payload: msg.slice(0, 120) });
        dispatch({ type: 'OPEN_MODAL', payload: 'error' });
      }
    }
  }

  // ── WalletConnect ────────────────────────────────────────────
  async function connectWC() {
    const wcConnector = connectors.find(c => c.id === 'walletConnect');
    if (!wcConnector) {
      dispatch({ type: 'SET_ERROR', payload: 'WalletConnect requires a Project ID. Get a free one at cloud.walletconnect.com, then add VITE_WC_PROJECT_ID to your .env file.' });
      dispatch({ type: 'OPEN_MODAL', payload: 'error' });
      return;
    }
    if (_syncLock || isLocked) return;
    acquireLock('walletConnect');
    try {
      const result = await connectAsync({ connector: wcConnector });
      // Init SDK adapter from WalletConnect provider so swap/bridge works
      await initSdkAdapterFromConnector(wcConnector, result.accounts?.[0] ?? '');
      releaseLock();
      close();
    } catch (e: any) {
      releaseLock();
      const msg = String(e?.message ?? e);
      if (/rejected|closed|cancel/i.test(msg)) {
        showToast('info', 'Connection cancelled', 'Wallet connection was rejected.');
        setTimeout(() => close(), 1200);
      } else {
        dispatch({ type: 'SET_ERROR', payload: msg.slice(0, 120) });
        dispatch({ type: 'OPEN_MODAL', payload: 'error' });
      }
    }
  }

  // ── Coinbase Wallet ──────────────────────────────────────────
  async function connectCB() {
    if (_syncLock || isLocked) return;
    acquireLock('coinbaseWallet');
    try {
      const cbConnector = coinbaseWallet({ appName: 'Arcle FX' });

      // Coinbase Wallet may not know about custom chains (e.g. Arc Network 5042).
      // If wagmi restores a previous session where Arc was active on a different chain ID, it will
      // try to switch to it during the connection handshake and throw
      // "Unrecognized chain ID".  Fix: always connect on Ethereum Mainnet (a chain
      // Coinbase Wallet always knows) then add custom chains via the provider right
      // after. ensureOnChain handles future switches with addEthereumChain.
      const result = await connectAsync({ connector: cbConnector, chainId: mainnet.id });

      // Get live connector to access the actual provider
      const liveCbConnector = connectors.find(c => c.id === 'coinbaseWalletSDK' || c.id === 'coinbaseWallet') ?? cbConnector;

      // Pre-register all custom chains so future chain switches never throw
      // "Unrecognized chain ID" again (no-op if already added).
      try {
        const cbProvider = await (liveCbConnector as any).getProvider?.();
        if (cbProvider?.request) {
          await Promise.allSettled(
            Object.values(ADD_CHAIN_PARAMS).map(params =>
              cbProvider.request({ method: 'wallet_addEthereumChain', params: [params] })
            )
          );
        }
      } catch { /* pre-registration is best-effort */ }

      // Init SDK adapter from Coinbase Wallet provider so swap/bridge works
      await initSdkAdapterFromConnector(liveCbConnector, result.accounts?.[0] ?? '');
      releaseLock();
      close();
    } catch (e: any) {
      releaseLock();
      const msg = String(e?.message ?? e);
      if (/rejected|denied|cancel/i.test(msg)) {
        showToast('info', 'Connection cancelled', 'Wallet connection was rejected.');
        setTimeout(() => close(), 1200);
      } else if (/unrecognized chain|try adding.*chain|unknown chain/i.test(msg)) {
        // Chain registration failed during connect — show actionable message
        dispatch({ type: 'SET_ERROR', payload: 'Coinbase Wallet could not switch network. Please open Coinbase Wallet, add "Arc Network" (Chain ID: 5042) manually, then try connecting again.' });
        dispatch({ type: 'OPEN_MODAL', payload: 'error' });
      } else {
        dispatch({ type: 'SET_ERROR', payload: msg.slice(0, 120) });
        dispatch({ type: 'OPEN_MODAL', payload: 'error' });
      }
    }
  }

  // ── Disconnect ───────────────────────────────────────────────
  function handleDisconnect() {
    disconnect();
    sdk.disconnectWallet();
    releaseLock();
    close();
  }

  // ── Resolve pending connector label for UI ───────────────────
  const pendingMeta = pendingConnectorId ? CONNECTOR_META[pendingConnectorId] : null;

  // ── Connected wallet view ────────────────────────────────────
  if (address && activeConnector && isActive) {
    const connMeta = CONNECTOR_META[activeConnector.id] ?? { label: activeConnector.name, logo: '' };
    const short    = `${address.slice(0, 6)}...${address.slice(-4)}`;

    return createPortal(
      <div
        id="wallet-modal"
        className={`modal-overlay ${isActive ? 'active' : ''}`}
        onClick={e => { if ((e.target as HTMLElement).id === 'wallet-modal') close(); }}
      >
        <div className="modal-content" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h3>Connected Wallet</h3>
            <button className="close-modal" onClick={close}><i className="ph-bold ph-x"></i></button>
          </div>

          {/* ── Active connection card ── */}
          <div style={{ padding: '8px 0 4px' }}>
            <div className="option-item" style={{ cursor: 'default', background: 'rgba(46,230,166,0.06)', border: '1px solid rgba(46,230,166,0.18)', borderRadius: 14, margin: '0 0 8px' }}>
              {connMeta.logo
                ? <img src={connMeta.logo} alt={connMeta.label} style={{ borderRadius: connMeta.logo.endsWith('.svg') ? 0 : '50%' }} />
                : <i className="ph-fill ph-wallet" style={{ fontSize: 28, color: 'var(--teal)' }}></i>
              }
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-main)' }}>{connMeta.label}</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 2, fontFamily: 'monospace' }}>{short}</div>
              </div>
              <span style={{
                display: 'flex', alignItems: 'center', gap: 5,
                fontSize: '0.72rem', fontWeight: 700, color: '#2ee6a6',
                background: 'rgba(46,230,166,0.1)', border: '1px solid rgba(46,230,166,0.25)',
                borderRadius: 20, padding: '3px 10px',
              }}>
                <i className="ph-fill ph-check-circle"></i> Connected
              </span>
            </div>

            {/* Copy address */}
            <div
              className="option-item"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(address);
                  showToast('success', 'Address copied', short);
                } catch {
                  showToast('error', 'Copy failed', 'Please copy manually: ' + short);
                }
                close();
              }}
              style={{ borderRadius: 12, marginBottom: 4 }}
            >
              <i className="ph ph-copy" style={{ fontSize: 22, color: 'var(--text-muted)' }}></i>
              <span>Copy Address</span>
            </div>

            {/* Disconnect */}
            <div
              className="option-item"
              onClick={handleDisconnect}
              style={{ borderRadius: 12, color: '#ef4444', background: 'rgba(239,68,68,0.04)', border: '1px solid rgba(239,68,68,0.12)' }}
            >
              <i className="ph ph-sign-out" style={{ fontSize: 22, color: '#ef4444' }}></i>
              <span style={{ color: '#ef4444' }}>Disconnect</span>
            </div>
          </div>
        </div>
      </div>,
      document.body
    );
  }

  // ── Connector picker view (no active connection) ─────────────
  return createPortal(
    <div
      id="wallet-modal"
      className={`modal-overlay ${isActive ? 'active' : ''}`}
      onClick={e => { if ((e.target as HTMLElement).id === 'wallet-modal') close(); }}
    >
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Connect a Wallet</h3>
          <button className="close-modal" onClick={close}><i className="ph-bold ph-x"></i></button>
        </div>

        {/* ── Pending state banner ─────────────────────────────
             Shown when modal is re-opened while a connection is still
             in-flight (e.g. user navigated away and came back).          */}
        {isLocked && pendingMeta && (
          <div style={{
            margin: '0 0 8px',
            padding: '10px 14px',
            borderRadius: 12,
            background: 'rgba(124,92,255,0.08)',
            border: '1px solid rgba(124,92,255,0.22)',
            display: 'flex', alignItems: 'center', gap: 10,
            fontSize: '0.82rem', color: 'var(--text-main)',
          }}>
            <i className="ph-bold ph-circle-notch spinner" style={{ color: 'var(--teal)', fontSize: '1rem' }}></i>
            <span>
              Connecting to <b>{pendingMeta.label}</b> — please check your wallet extension.
            </span>
          </div>
        )}

        {/* ── Option list ─────────────────────────────────────
             BOTH layers block clicks while any wallet is pending:
             1. pointerEvents:none on each item  (CSS — instant)
             2. Invisible overlay div on top     (DOM — catches any leak) */}
        <div
          className="option-list"
          style={{
            position: 'relative',
            // Whole list becomes non-interactive the moment isLocked is true
            pointerEvents: isLocked ? 'none' : undefined,
          }}
        >
          {isLocked && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 10,
              borderRadius: 'inherit', cursor: 'not-allowed',
            }} />
          )}

          {/* MetaMask */}
          <div
            className={`option-item${pendingConnectorId === 'metaMask' ? ' option-item--pending' : ''}`}
            onClick={connectMM}
            style={{
              opacity:       (isLocked && pendingConnectorId !== 'metaMask') ? 0.3 : 1,
              pointerEvents: isLocked ? 'none' : 'auto',
              transition:    'opacity 0.2s',
            }}
          >
            <img src="https://upload.wikimedia.org/wikipedia/commons/3/36/MetaMask_Fox.svg" alt="MetaMask" />
            <span>MetaMask</span>
            {pendingConnectorId === 'metaMask'
              ? <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <i className="ph-bold ph-circle-notch spinner" style={{ fontSize: '0.85rem' }}></i>Connecting…
                </span>
              : !isMetaMaskInstalled && (
                <span style={{
                  marginLeft: 'auto', fontSize: '0.72rem', fontWeight: 600,
                  color: '#f6851b', background: 'rgba(246,133,27,0.1)',
                  border: '1px solid rgba(246,133,27,0.3)',
                  borderRadius: 20, padding: '3px 9px',
                  display: 'flex', alignItems: 'center', gap: 4,
                }}>
                  Install <i className="ph-bold ph-arrow-up-right" style={{ fontSize: '0.65rem' }}></i>
                </span>
              )
            }
          </div>

          {/* WalletConnect */}
          <div
            className={`option-item${pendingConnectorId === 'walletConnect' ? ' option-item--pending' : ''}`}
            onClick={connectWC}
            style={{
              opacity:       (isLocked && pendingConnectorId !== 'walletConnect') ? 0.3 : 1,
              pointerEvents: isLocked ? 'none' : 'auto',
              transition:    'opacity 0.2s',
            }}
          >
            <img src="https://walletconnect.com/icon.png?14b0dfc4ce526451" alt="WalletConnect" />
            <span>WalletConnect</span>
            {pendingConnectorId === 'walletConnect'
              ? <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <i className="ph-bold ph-circle-notch spinner" style={{ fontSize: '0.85rem' }}></i>Connecting…
                </span>
              : !wcProjectId && (
                <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--text-muted)' }}>Config needed</span>
              )
            }
          </div>

          {/* Coinbase Wallet */}
          <div
            className={`option-item${pendingConnectorId === 'coinbaseWallet' ? ' option-item--pending' : ''}`}
            onClick={connectCB}
            style={{
              opacity:       (isLocked && pendingConnectorId !== 'coinbaseWallet') ? 0.3 : 1,
              pointerEvents: isLocked ? 'none' : 'auto',
              transition:    'opacity 0.2s',
            }}
          >
            <img src="https://avatars.githubusercontent.com/u/18060234?s=200&v=4" alt="Coinbase Wallet" />
            <span>Coinbase Wallet</span>
            {pendingConnectorId === 'coinbaseWallet' && (
              <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <i className="ph-bold ph-circle-notch spinner" style={{ fontSize: '0.85rem' }}></i>Connecting…
              </span>
            )}
          </div>

        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Network Modal ────────────────────────────────────────────
/** Network selection modal — shown when user taps the from/to network selector. */
export function NetworkModal() {
  const { state, dispatch } = useAppContext();
  const isActive            = state.activeModal === 'network';

  function close() { dispatch({ type: 'CLOSE_MODAL' }); }

  function select(net: (typeof NETWORKS)[0]) {
    const target = state.activeTarget;
    if (target === 'from') {
      // If user picks what's already on the "to" side → auto-pick a different "to" network
      if (net.id === state.bridge.to.netId) {
        const alt = NETWORKS.find(n => n.id !== net.id);
        if (alt) dispatch({ type: 'SET_BRIDGE_TO', payload: { network: alt.label, netId: alt.id, netLogo: alt.logo } });
      }
      dispatch({ type: 'SET_BRIDGE_FROM', payload: { network: net.label, netId: net.id, netLogo: net.logo } });
    } else if (target === 'to') {
      // If user picks what's already on the "from" side → auto-pick a different "from" network
      if (net.id === state.bridge.from.netId) {
        const alt = NETWORKS.find(n => n.id !== net.id);
        if (alt) dispatch({ type: 'SET_BRIDGE_FROM', payload: { network: alt.label, netId: alt.id, netLogo: alt.logo } });
      }
      dispatch({ type: 'SET_BRIDGE_TO', payload: { network: net.label, netId: net.id, netLogo: net.logo } });
    } else if (target === 'swap-net') {
      dispatch({ type: 'SET_SWAP_NET', payload: { netId: net.id, network: net.label, netLogo: net.logo } });
    }
    close();
  }

  return createPortal(
    <div
      id="network-modal"
      className={`modal-overlay ${isActive ? 'active' : ''}`}
      onClick={e => { if ((e.target as HTMLElement).id === 'network-modal') close(); }}
    >
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Select a Network</h3>
          <button className="close-modal" onClick={close}><i className="ph-bold ph-x"></i></button>
        </div>
        <div className="option-list">
          {NETWORKS.map(net => (
            <div
              className="option-item"
              key={net.id}
              onClick={() => select(net)}
            >
              <NetworkLogo logo={net.logo} label={net.label} size={32} />
              <span>{net.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Token Modal ──────────────────────────────────────────────
/** Token selection modal — shown when user taps the token selector. */
export function TokenModal() {
  const { state, dispatch } = useAppContext();
  const isActive            = state.activeModal === 'token';

  function close() { dispatch({ type: 'CLOSE_MODAL' }); }

  function select(tok: (typeof TOKENS)[0]) {
    const target = state.activeTarget;
    if (target === 'from' || target === 'to') {
      // CCTP bridges the same token on both sides — update from + to simultaneously
      dispatch({ type: 'SET_BRIDGE_TOKEN', payload: { symbol: tok.symbol, logo: tok.logo } });
    } else if (target === 'from-swap') {
      dispatch({ type: 'SET_SWAP_FROM', payload: { token: tok.symbol, tokLogo: tok.logo } });
    } else if (target === 'to-swap') {
      dispatch({ type: 'SET_SWAP_TO', payload: { token: tok.symbol, tokLogo: tok.logo } });
    }
    close();
  }

  // For bridge token selection: only show tokens available on BOTH selected networks.
  // TOKEN_ADDRESSES[network][token] === null means the token is not deployed there.
  const availableTokens = TOKENS.filter(tok => {
    const target = state.activeTarget;
    if (target === 'from' || target === 'to') {
      const fromAddr = TOKEN_ADDRESSES[state.bridge.from.netId]?.[tok.symbol];
      const toAddr   = TOKEN_ADDRESSES[state.bridge.to.netId]?.[tok.symbol];
      return fromAddr !== null && fromAddr !== undefined
          && toAddr   !== null && toAddr   !== undefined;
    }
    return true; // swap tokens: show all
  });

  return createPortal(
    <div
      id="token-modal"
      className={`modal-overlay ${isActive ? 'active' : ''}`}
      onClick={e => { if ((e.target as HTMLElement).id === 'token-modal') close(); }}
    >
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Select a Token</h3>
          <button className="close-modal" onClick={close}><i className="ph-bold ph-x"></i></button>
        </div>
        <div className="option-list">
          {availableTokens.map(tok => (
            <div className="option-item" key={tok.symbol} onClick={() => select(tok)}>
              <img src={tok.logo} alt={tok.symbol} />
              <span>{tok.symbol}</span>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Gas Modal ────────────────────────────────────────────────
/** Gas fee modal — shows estimated gas and lets user pick transfer speed (Express / Economy). */
export function GasModal() {
  const { state, dispatch }  = useAppContext();
  const { gas, fetchGasFee } = useGasFee();
  const isActive             = state.activeModal === 'gas';

  // Active speed tier — default "normal"
  const [tier, setTier] = useState<'slow'|'normal'|'fast'>('normal');

  // Determine the currently active network label and its RPC URL
  const activeNetwork = state.activeTab === 'swap'
    ? state.swap.network
    : state.bridge.from.network;

  const activeNetId = state.activeTab === 'swap'
    ? state.swap.netId
    : state.bridge.from.netId;

  const activeRpc = NETWORKS.find(n => n.id === activeNetId)?.rpc;

  useEffect(() => {
    if (!isActive) return;
    fetchGasFee(activeNetwork, activeRpc);
    const id = setInterval(() => fetchGasFee(activeNetwork, activeRpc), 20_000);
    return () => clearInterval(id);
    // fetchGasFee is intentionally omitted — it creates a new ref on every render
  }, [isActive, activeNetwork, activeRpc]);

  function close() { dispatch({ type: 'CLOSE_MODAL' }); }

  const tiers = [
    { id: 'slow'   as const, icon: 'ph-duotone ph-hourglass-medium', label: 'Slow',   hint: '~60s'  },
    { id: 'normal' as const, icon: 'ph-duotone ph-gauge',            label: 'Normal', hint: '~15s'  },
    { id: 'fast'   as const, icon: 'ph-duotone ph-lightning',        label: 'Fast',   hint: '~5s'   },
  ];

  return createPortal(
    <div
      id="gas-modal"
      className={`arc-modal ${isActive ? 'open' : ''}`}
      role="dialog"
      aria-modal="true"
      onClick={e => { if ((e.target as HTMLElement).id === 'gas-modal') close(); }}
    >
      <div className="arc-m-box" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="arc-m-head">
          <h3>Network Fee</h3>
          <button className="arc-m-close" onClick={close} aria-label="Close">
            <i className="ph-bold ph-x"></i>
          </button>
        </div>

        {/* Body */}
        <div className="arc-m-body">

          {/* Speed tier grid */}
          <div className="gas-grid">
            {tiers.map(t => (
              <button
                key={t.id}
                className={`gas-option ${tier === t.id ? 'on' : ''}`}
                onClick={() => setTier(t.id)}
              >
                <i className={t.icon}></i>
                <b>{t.label}</b>
                <small>{t.hint}</small>
              </button>
            ))}
          </div>

          {/* Current fee info row — shows the active network's gas */}
          <div className="gas-info-row">
            <span>{gas.network || activeNetwork}</span>
            <span>
              <b>{gas.gwei}</b> · {gas.usd}
            </span>
          </div>

        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Settings Modal ───────────────────────────────────────────
/** Settings modal — slippage tolerance and other user preferences. */
export function SettingsModal() {
  const { state, dispatch } = useAppContext();
  const isActive            = state.activeModal === 'settings';
  const chainId             = useChainId();
  const [gaslessLoading, setGaslessLoading] = useState(false);
  const [smartAddress,   setSmartAddress]   = useState<string | null>(null);

  function close() { dispatch({ type: 'CLOSE_MODAL' }); }

  async function enableGasless() {
    setGaslessLoading(true);
    try {
      const result = await sdk.connectGasless(chainId);
      setSmartAddress(result.smartAddress);
      dispatch({ type: 'SET_GASLESS', payload: true });
      showToast('success', 'Gasless enabled', `Smart Account ready on ${result.chainName}`);
    } catch (e: any) {
      showToast('error', 'Gasless failed', e?.message ?? 'Could not enable gasless mode');
    } finally {
      setGaslessLoading(false);
    }
  }

  async function disableGasless() {
    setGaslessLoading(true);
    try {
      await sdk.exitGaslessMode();
      setSmartAddress(null);
      dispatch({ type: 'SET_GASLESS', payload: false });
      showToast('success', 'Gasless disabled', 'Gas will be paid in ETH');
    } catch (e: any) {
      dispatch({ type: 'SET_GASLESS', payload: false }); // reset UI regardless
      showToast('error', 'Could not disable gasless', e?.message ?? 'Please reconnect your wallet');
    } finally {
      setGaslessLoading(false);
    }
  }

  const presets = ['0.1%', '0.5%', '1.0%'];

  // High slippage warning threshold
  const slipNum    = parseFloat(state.slippage);
  const isHighSlip = slipNum >= 1;

  return createPortal(
    <div
      id="settings-modal"
      className={`arc-modal ${isActive ? 'open' : ''}`}
      role="dialog"
      aria-modal="true"
      onClick={e => { if ((e.target as HTMLElement).id === 'settings-modal') close(); }}
    >
      <div className="arc-m-box" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="arc-m-head">
          <h3>Transaction Settings</h3>
          <button className="arc-m-close" onClick={close} aria-label="Close">
            <i className="ph-bold ph-x"></i>
          </button>
        </div>

        {/* Body */}
        <div className="arc-m-body">

          {/* Slippage field */}
          <div className="settings-field">
            <div className="settings-field-label">
              Max slippage
              <i className="ph ph-info" title="Your swap reverts if the price moves against you by more than this."></i>
            </div>
            {/* Slippage buttons — same border/color style as Network Fee gas-option cards */}
            <div className="slip-segm">
              {presets.map(o => (
                <button
                  key={o}
                  className={state.slippage === o ? 'on' : ''}
                  onClick={() => dispatch({ type: 'SET_SLIPPAGE', payload: o })}
                >
                  {o}
                </button>
              ))}
            </div>

            {/* High slippage warning */}
            {isHighSlip && (
              <div className="settings-notice warn">
                <i className="ph-fill ph-warning"></i>
                <span>High slippage. Your transaction may be frontrun.</span>
              </div>
            )}
          </div>

          {/* Deadline field */}
          <div className="settings-field" style={{ marginBottom: 0 }}>
            <div className="settings-field-label">
              Transaction deadline
              <i className="ph ph-info" title="Reverts if pending longer than this."></i>
            </div>
            <label className="deadline-input">
              <input
                type="text"
                inputMode="numeric"
                value={state.deadline}
                onChange={e => {
                  const v = e.target.value.replace(/[^0-9.]/g, '');
                  dispatch({ type: 'SET_DEADLINE', payload: v });
                }}
                aria-label="Deadline in minutes"
              />
              <span>min</span>
            </label>
            {(() => {
              const d = parseFloat(state.deadline);
              if (state.deadline !== '' && (isNaN(d) || d <= 0)) {
                return (
                  <div className="settings-notice warn" style={{ marginTop: 6 }}>
                    <i className="ph-fill ph-warning"></i>
                    <span>Invalid deadline. Minimum 30 seconds will be used.</span>
                  </div>
                );
              }
              if (!isNaN(d) && d > 0 && d < 1) {
                return (
                  <div className="settings-notice warn" style={{ marginTop: 6 }}>
                    <i className="ph-fill ph-warning"></i>
                    <span>Very short deadline. Transaction may fail.</span>
                  </div>
                );
              }
              return null;
            })()}
          </div>

          {/* Gasless — Circle Paymaster (ERC-4337) */}
          <div className="settings-field" style={{ marginTop: 16 }}>
            <div className="settings-field-label" style={{ marginBottom: 8 }}>
              Gas payment
              <i className="ph ph-info" title="On Ethereum, Arbitrum and Base, gas is paid in ETH by default. Enable gasless to pay in USDC via Circle Paymaster (ERC-4337). On Arc Network, gas is always USDC — no toggle needed."></i>
            </div>
            <div className="slip-segm">
              <button
                className={!state.gasless ? 'on' : ''}
                onClick={() => !state.gasless || gaslessLoading ? undefined : disableGasless()}
                disabled={gaslessLoading}
              >
                <i className="ph-bold ph-currency-eth" style={{ fontSize: '0.8rem' }}></i> ETH
              </button>
              <button
                className={state.gasless ? 'on' : ''}
                onClick={() => state.gasless || gaslessLoading ? undefined : enableGasless()}
                disabled={gaslessLoading}
              >
                {gaslessLoading
                  ? <><i className="ph-bold ph-spinner spinner" style={{ fontSize: '0.8rem' }}></i> Connecting…</>
                  : <><i className="ph-bold ph-coins" style={{ fontSize: '0.8rem' }}></i> USDC</>
                }
              </button>
            </div>
            {state.gasless && (
              <div className="settings-notice" style={{ marginTop: 8, borderColor: 'rgba(45,212,191,0.35)', background: 'rgba(45,212,191,0.06)' }}>
                <i className="ph-fill ph-lightning" style={{ color: 'var(--teal)' }}></i>
                <span style={{ color: 'var(--teal)' }}>
                  Pay gas in <b>USDC</b> via Circle Paymaster <span style={{ whiteSpace: 'nowrap' }}>(ERC‑4337)</span>.
                  <br />
                  Supported on Ethereum, Arbitrum and Base. 10% surcharge applies.
                </span>
              </div>
            )}
            {state.gasless && smartAddress && (
              <div className="settings-notice" style={{ marginTop: 6, borderColor: 'rgba(245,158,11,0.25)', background: 'rgba(245,158,11,0.08)', alignItems: 'flex-start' }}>
                <span style={{ color: '#f59e0b', fontSize: '0.72rem' }}>
                  <b>Smart Account address:</b>
                  <br />
                  <span style={{ fontFamily: 'monospace', fontSize: '0.65rem', wordBreak: 'break-all', marginTop: 6, display: 'block' }}>{smartAddress}</span>
                  <span style={{ display: 'block', marginTop: 0 }}>Your USDC must be in this address to use gasless mode.</span>
                </span>
              </div>
            )}
          </div>

        </div>
      </div>
    </div>,
    document.body
  );
}

// ── TX Progress Modal ────────────────────────────────────────
/** Transaction progress modal — step-by-step status for bridge, swap, and unified spend. */
export function TxProgressModal() {
  const { state, dispatch } = useAppContext();
  const tx   = state.txProgress;
  const busy = tx.status === 'waiting' || tx.status === 'processing';

  function close() {
    // Always allow closing — only block while a real on-chain tx is in flight
    // (busy guard is kept for UX but X button is always clickable in preview)
    dispatch({ type: 'CLOSE_TX_PROGRESS' });
  }

  // "Cancel" — only available while waiting for wallet confirmation (step 0 active)
  // Transaction is irrevocable once broadcast.
  const canCancel = tx.status === 'waiting';
  function cancel() {
    // Close the modal immediately — BridgeTab detects isOpen→false and sets abort flag.
    dispatch({ type: 'CLOSE_TX_PROGRESS' });
  }

  const heroIcon = tx.status === 'success'
    ? <i className="ph-bold ph-check"></i>
    : tx.status === 'error'
    ? <i className="ph-bold ph-warning"></i>
    : <i className="ph-bold ph-circle-notch spinner"></i>;

  const headingText = tx.status === 'success'
    ? (tx.type === 'bridge'       ? 'Bridge complete'
     : tx.type === 'swap'         ? 'Swap complete'
     : tx.type === 'cross-chain'  ? 'Cross-chain swap complete'
     : tx.type === 'send'         ? 'Send complete'
     :                              'Transfer complete')
    : tx.status === 'error'
    ? 'Transaction failed'
    : tx.status === 'processing'
    ? 'Transaction submitted'
    : 'Confirm in your wallet';

  const subText = tx.status === 'success'
    ? `${tx.toLabel} arrived`
    : tx.status === 'error'
    ? (tx.errorMsg || 'Something went wrong.')
    : tx.status === 'processing'
    ? (tx.type === 'bridge' || tx.type === 'cross-chain' ? 'Your assets are on the way' : 'Executing your transaction')
    : `Waiting for approval`;

  const titleText =
    tx.type === 'bridge'      ? 'Bridge'       :
    tx.type === 'swap'        ? 'Swap'         :
    tx.type === 'cross-chain' ? 'Cross-Chain'  :
    tx.type === 'send'        ? 'Send'         : 'Unified';

  return createPortal(
    <div
      id="tx-progress-modal"
      className={`arc-modal ${tx.isOpen ? 'open' : ''}`}
      role="dialog"
      aria-modal="true"
      onClick={e => { if ((e.target as HTMLElement).id === 'tx-progress-modal' && !busy) close(); }}
    >
      <div className="arc-m-box" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="arc-m-head">
          <h3>{titleText}</h3>
          <button
            className="arc-m-close"
            onClick={canCancel ? cancel : close}
            aria-label={canCancel ? 'Cancel transaction' : 'Close'}
          >
            <i className="ph-bold ph-x"></i>
          </button>
        </div>

        {/* Body */}
        <div className="arc-m-body">

          {/* Hero icon + heading */}
          <div className="tx-hero">
            <div className={`tx-icon-circle ${tx.status}`}>{heroIcon}</div>
            <h3 className="tx-hero-heading">{headingText}</h3>
            <p className="tx-hero-sub">{subText}</p>
          </div>

          {/* Amount summary row */}
          {(tx.fromLabel || tx.toLabel) && (
            <div className="tx-summary-row">
              <span className="tx-summary-side">
                <img src={tx.fromLogo} alt="" />
                {tx.fromLabel}
              </span>
              <i className="ph-bold ph-arrow-right" style={{ color: 'var(--text-muted)', flexShrink: 0 }}></i>
              <span className="tx-summary-side">
                <img src={tx.toLogo} alt="" />
                {tx.toLabel}
              </span>
            </div>
          )}

          {/* Steps */}
          <ol className="tx-steps-list">
            {tx.steps.map((step, i) => (
              <li
                key={step.label}
                className={`tx-step-item ${step.status === 'active' ? 'active' : step.status === 'done' ? 'done' : step.status === 'error' ? 'error' : ''}`}
              >
                <span className="tx-step-dot">
                  {step.status === 'done'   && <i className="ph-bold ph-check"></i>}
                  {step.status === 'active' && <i className="ph-bold ph-circle-notch spinner"></i>}
                  {step.status === 'error'  && <i className="ph-bold ph-x"></i>}
                </span>
                {step.label}
              </li>
            ))}
          </ol>

          {/* Actions — shown on success/error */}
          {(tx.status === 'success' || tx.status === 'error') && (
            <div className="tx-modal-actions">
              {tx.status === 'success' && tx.txLink && tx.txLink !== '#' && (
                <a
                  className="btn-action"
                  href={safeTxLink(tx.txLink)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-main)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                >
                  View on Explorer <i className="ph-bold ph-arrow-up-right"></i>
                </a>
              )}
              <button className="btn-action" onClick={close}>
                {tx.status === 'error' ? 'Close' : 'Done'}
              </button>
            </div>
          )}

          {/* Cancel button — visible only while waiting for wallet confirmation */}
          {canCancel && (
            <div className="tx-modal-actions" style={{ marginTop: 12 }}>
              <button
                onClick={cancel}
                style={{
                  width: '100%', padding: '13px', borderRadius: 14,
                  background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.25)',
                  color: '#ef4444', fontWeight: 700, fontSize: '0.93rem',
                  cursor: 'pointer', fontFamily: 'inherit',
                  transition: 'background 0.2s, border-color 0.2s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(239,68,68,0.16)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'rgba(239,68,68,0.08)')}
              >
                <i className="ph-bold ph-x-circle" style={{ marginRight: 6 }}></i>
                Cancel Transaction
              </button>
            </div>
          )}

        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Toast System ─────────────────────────────────────────────
// Singleton toast emitter
type ToastType = 'success' | 'error' | 'info';
interface ToastItem { id: number; type: ToastType; title: string; sub?: string; }

let _toastListeners: ((toasts: ToastItem[]) => void)[] = [];
let _toasts: ToastItem[] = [];
let _toastId = 0;

/** Programmatic toast trigger — call from anywhere to show a non-blocking notification. */
export function showToast(type: ToastType, title: string, sub?: string) {
  const id = ++_toastId;
  _toasts = [..._toasts, { id, type, title, sub }];
  _toastListeners.forEach(fn => fn(_toasts));
  setTimeout(() => {
    _toasts = _toasts.filter(t => t.id !== id);
    _toastListeners.forEach(fn => fn(_toasts));
  }, 4000);
}

/** Renders active toast notifications injected via showToast(). */
export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  useEffect(() => {
    const fn = (t: ToastItem[]) => setToasts([...t]);
    _toastListeners.push(fn);
    return () => { _toastListeners = _toastListeners.filter(l => l !== fn); };
  }, []);

  function dismiss(id: number) {
    _toasts = _toasts.filter(t => t.id !== id);
    _toastListeners.forEach(fn => fn(_toasts));
  }

  return createPortal(
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast-item ${t.type}`}>
          <i className={
            t.type === 'success' ? 'ph-bold ph-check-circle'
            : t.type === 'error' ? 'ph-bold ph-warning-circle'
            : 'ph-bold ph-info'
          }></i>
          <div className="toast-body">
            <strong>{t.title}</strong>
            {t.sub && <span>{t.sub}</span>}
          </div>
          <button className="toast-close" onClick={() => dismiss(t.id)}>
            <i className="ph-bold ph-x"></i>
          </button>
        </div>
      ))}
    </div>,
    document.body
  );
}

// ── Error Modal ──────────────────────────────────────────────
/** Error modal — shown when a transaction or wallet operation fails with a message. */
export function ErrorModal() {
  const { state, dispatch } = useAppContext();
  const isActive            = state.activeModal === 'error';

  function close() { dispatch({ type: 'CLOSE_MODAL' }); }

  return createPortal(
    <div
      id="error-modal"
      className={`modal-overlay ${isActive ? 'active' : ''}`}
      onClick={e => { if ((e.target as HTMLElement).id === 'error-modal') close(); }}
    >
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ textAlign: 'center', padding: '24px 24px 20px' }}>
        <div className="tx-status-icon" style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', margin: '0 auto 12px' }}>
          <i className="ph-bold ph-warning-circle"></i>
        </div>
        <h3 style={{ marginBottom: 8 }}>Transaction Failed</h3>
        <p id="error-message" style={{ color: 'var(--text-muted)', fontSize: '0.93rem', lineHeight: 1.5 }}>
          {state.errorMsg || 'An unexpected error occurred. Please try again.'}
        </p>
        <button className="btn-action" style={{ marginTop: 16, padding: '13px' }} onClick={close}>
          Try Again
        </button>
      </div>
    </div>,
    document.body
  );
}
