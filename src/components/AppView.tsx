// ============================================================
//  AppView — main swap card with Bridge / Swap / Unified tabs
// ============================================================

import { useEffect, useRef } from 'react';
import * as React from 'react';
import { useAppContext }  from '../context/AppContext';
import BridgeTab          from './tabs/BridgeTab';
import SwapTab            from './tabs/SwapTab';
import UnifiedTab         from './tabs/UnifiedTab';
import {
  NetworkModal, TokenModal,
  GasModal, SettingsModal, ErrorModal,
  TxProgressModal,
} from './Modals';

interface Props {
  className:   string;
  style:       React.CSSProperties;
  onCloseApp:  () => void;
}

export default function AppView({ className, style, onCloseApp }: Props) {
  const { state, dispatch } = useAppContext();
  const cardRef = useRef<HTMLDivElement>(null);

  // Scroll to top of card on tab switch
  useEffect(() => {
    cardRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [state.activeTab]);

  return (
    <div id="app-view" className={className} style={style}>
      <div className="app-container">

        {/* Back link — pill button (Arc Test 7 style) */}
        <div className="app-header" ref={cardRef}>
          <button type="button" className="back-link" onClick={onCloseApp}>
            <i className="ph-bold ph-arrow-left"></i> Back to Home
          </button>
          <div></div>
        </div>

        {/* Main swap card */}
        <div className="swap-card">

          {/* Tabs + icon buttons */}
          <div className="swap-header">
            <div className="app-tabs" data-active={state.activeTab}>
              {(['bridge', 'swap', 'unified'] as const).map((tab, i) => (
                <button
                  key={tab}
                  className={`app-tab ${state.activeTab === tab ? 'active' : ''}`}
                  onClick={() => dispatch({ type: 'SET_TAB', payload: tab })}
                >
                  {['Bridge', 'Swap', 'Unified'][i]}
                </button>
              ))}
            </div>

            <div className="header-actions">
              <button
                className="icon-btn"
                onClick={() => dispatch({ type: 'OPEN_MODAL', payload: 'gas' })}
              >
                <i className="ph-bold ph-gas-pump"></i>
              </button>
              <button
                className="icon-btn"
                onClick={() => dispatch({ type: 'OPEN_MODAL', payload: 'settings' })}
              >
                <i className="ph-bold ph-sliders-horizontal"></i>
              </button>
            </div>
          </div>

          {/* Tab panels — conditional render to avoid mounting all 3 at once */}
          {state.activeTab === 'bridge'  && <BridgeTab />}
          {state.activeTab === 'swap'    && <SwapTab />}
          {state.activeTab === 'unified' && <UnifiedTab />}

        </div>
      </div>

      {/* Modals — WalletModal and ToastContainer are rendered in App.tsx root */}
      <NetworkModal />
      <TokenModal />
      <GasModal />
      <SettingsModal />
      <ErrorModal />
      <TxProgressModal />
    </div>
  );
}
