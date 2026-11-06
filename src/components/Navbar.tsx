// ============================================================
//  Navbar — floating pill navigation bar
// ============================================================

import { useState, useEffect, useRef } from 'react';
import { useAccount, useDisconnect } from 'wagmi';
import { disconnectWallet } from '../lib/sdk';
import { showToast } from './Modals';

interface Props {
  onConnectClick:      () => void;
  onClose:             () => void;
  showWallet:          boolean;
  onScrollToFeatures?: () => void;
}

export default function Navbar({ onConnectClick, onClose, showWallet, onScrollToFeatures }: Props) {
  const { address }    = useAccount();
  const { disconnect } = useDisconnect();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [mobileOpen,   setMobileOpen]   = useState(false);
  const [scrolled,     setScrolled]     = useState(false);

  const short = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : '';
  const prevAddress = useRef<string | undefined>(address);

  // ── Effects ──────────────────────────────────────────────────
  useEffect(() => {
    if (address && address !== prevAddress.current) {
      showToast('success', 'Wallet connected', short);
    }
    prevAddress.current = address;
  }, [address]);

  useEffect(() => {
    function onScroll() { setScrolled(window.scrollY > 30); }
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    function onClickOutside() { setDropdownOpen(false); }
    if (dropdownOpen) document.addEventListener('click', onClickOutside);
    return () => document.removeEventListener('click', onClickOutside);
  }, [dropdownOpen]);

  function handleWalletClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (address) setDropdownOpen(p => !p);
    else         onConnectClick();
  }

  // ── Protocol link ─────────────────────────────────────────────
  // Landing view  → smooth-scroll to #features (How It Works)
  // Bridge/App view → inactive (no navigation)
  function handleProtocolClick(e: React.MouseEvent) {
    e.preventDefault();
    if (!showWallet) {
      onScrollToFeatures?.();
    }
    // On Bridge/App screen: do nothing
  }

  // ── Wallet actions ───────────────────────────────────────────
  const [copied, setCopied] = useState(false);

  function copyAddr() {
    if (!address) return;
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      showToast('success', 'Address copied', short);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      showToast('error', 'Copy failed', 'Please copy manually');
    });
    setDropdownOpen(false);
  }

  function handleDisconnect() {
    disconnect();
    disconnectWallet();
    setDropdownOpen(false);
  }

  return (
    <>
      {/* ── Floating pill nav shell ── */}
      <div className="nav-shell">
        <header className={`arc-nav${scrolled ? ' scrolled' : ''}`} id="nav">

          {/* Brand */}
          <button className="arc-brand" onClick={onClose} aria-label="Arcle FX home">
            <img src="/center-logo.png" alt="Arcle FX" className="arc-brand-logo" />
            <span>Arcle FX</span>
          </button>

          {/* Center nav links */}
          <nav className="arc-nav-links" aria-label="Main">
            <a href="#features" onClick={handleProtocolClick}>Protocol</a>
            <a href="https://explorer.arc.io/" target="_blank" rel="noopener noreferrer">Explorer</a>
            <a href="https://docs.arc.io" target="_blank" rel="noopener noreferrer">Developers</a>
            <button type="button" className="arc-nav-link-btn" disabled title="Coming soon">Stats</button>
          </nav>

          {/* Right side */}
          <div className="arc-nav-right">

            {!showWallet ? (
              <button className="arc-launch-btn" onClick={onConnectClick}>
                Launch App <i className="ph-bold ph-arrow-right"></i>
              </button>
            ) : (
              <div className="arc-wallet-wrap" onClick={e => e.stopPropagation()}>
                <button
                  className={`arc-wallet-btn${address ? ' connected' : ''}`}
                  onClick={handleWalletClick}
                  aria-haspopup="true"
                  aria-expanded={dropdownOpen}
                >
                  {address
                    ? <><i className="ph-fill ph-check-circle"></i> {short}</>
                    : <><i className="ph-bold ph-wallet"></i> Connect Wallet</>
                  }
                </button>

                <div className={`arc-dropdown${dropdownOpen ? ' open' : ''}`} role="menu">
                  <div className="arc-dd-item copy" onClick={copyAddr}>
                    <i className={copied ? 'ph-fill ph-check' : 'ph ph-copy'} style={copied ? { color: 'var(--teal)' } : {}}></i>
                    {copied ? 'Copied' : 'Copy Address'}
                  </div>
                  <div className="arc-dd-item danger" onClick={handleDisconnect}>
                    <i className="ph ph-sign-out"></i> Disconnect
                  </div>
                </div>
              </div>
            )}

            {/* Mobile hamburger */}
            <button
              className="arc-menu-btn"
              onClick={() => setMobileOpen(p => !p)}
              aria-label="Toggle menu"
              aria-expanded={mobileOpen}
            >
              <i className={`ph-bold ${mobileOpen ? 'ph-x' : 'ph-list'}`}></i>
            </button>

          </div>
        </header>
      </div>

      {/* ── Mobile menu ── */}
      <div className={`arc-mobile-menu${mobileOpen ? ' open' : ''}`} id="mobile-menu">
        <a href="#features" onClick={e => { handleProtocolClick(e); setMobileOpen(false); }}>Protocol</a>
        <a href="https://explorer.arc.io/" target="_blank" rel="noopener noreferrer" onClick={() => setMobileOpen(false)}>Explorer</a>
        <a href="https://docs.arc.io" target="_blank" rel="noopener noreferrer" onClick={() => setMobileOpen(false)}>Developers</a>
        <button type="button" className="arc-nav-link-btn" disabled onClick={() => setMobileOpen(false)}>Stats</button>
        <button
          className="arc-launch-btn"
          style={{ marginTop: '8px', width: '100%', justifyContent: 'center' }}
          onClick={() => { setMobileOpen(false); onConnectClick(); }}
        >
          Launch App <i className="ph-bold ph-arrow-right"></i>
        </button>
      </div>
    </>
  );
}
