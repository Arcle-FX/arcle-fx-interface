// ============================================================
//  App — root component, view transitions (Landing ↔ AppView)
// ============================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { useAccount } from 'wagmi';
import Navbar   from './components/Navbar';
import Landing  from './components/Landing';
import AppView  from './components/AppView';
import { WalletModal, ToastContainer } from './components/Modals';
import { useAppContext } from './context/AppContext';

export default function App() {
  const { dispatch } = useAppContext();
  const { address }  = useAccount();

  // Determine starting view synchronously — avoids a flash on app.arclefx.com
  const isAppSubdomain = typeof window !== 'undefined' &&
    window.location.hostname.startsWith('app.');
  // Strip both "app." and "www." prefixes so rootDomain is always the bare domain
  // e.g. www.arclefx.com → arclefx.com, app.arclefx.com → arclefx.com
  const rootDomain = typeof window !== 'undefined'
    ? window.location.hostname.replace(/^(?:app|www)\./, '')
    : '';

  // React-controlled display/class — prevents DOM vs. React conflicts
  const [landingDisplay, setLandingDisplay] = useState<'flex' | 'none'>(isAppSubdomain ? 'none' : 'flex');
  const [appDisplay,     setAppDisplay]     = useState<'flex' | 'none'>(isAppSubdomain ? 'flex' : 'none');
  const [landingCls,     setLandingCls]     = useState(isAppSubdomain ? 'view-section view-hidden' : 'view-section view-active');
  const [appCls,         setAppCls]         = useState(isAppSubdomain ? 'view-section view-active' : 'view-section view-hidden');

  // AppView key — only incremented on first open to avoid unmounting between tab switches
  const [appKey, setAppKey] = useState(0);
  const appMounted = useRef(isAppSubdomain);

  // Local view state — tracks whether the app panel or landing is visible
  const [currentView, setCurrentView] = useState<'landing' | 'app'>(isAppSubdomain ? 'app' : 'landing');

  const openApp = useCallback((tab: 'bridge' | 'swap' | 'unified' = 'bridge') => {
    if (rootDomain && rootDomain !== 'localhost' && !isAppSubdomain) {
      // Smooth exit: scale up + blur + fade before navigating to app.arclefx.com
      document.body.style.transition = 'opacity 0.4s cubic-bezier(0.4,0,1,1), transform 0.4s cubic-bezier(0.4,0,1,1), filter 0.4s cubic-bezier(0.4,0,1,1)';
      document.body.style.opacity    = '0';
      document.body.style.transform  = 'scale(1.03)';
      document.body.style.filter     = 'blur(6px)';
      setTimeout(() => {
        const query = tab !== 'bridge' ? `?tab=${tab}` : '';
        window.location.href = `https://app.${rootDomain}${query}`;
      }, 420);
      return;
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
    dispatch({ type: 'SET_TAB', payload: tab });
    if (!appMounted.current) {
      appMounted.current = true;
      setAppKey(k => k + 1);
    }

    // ── Overlap-free two-phase transition ──────────────────────
    // Phase 1: Mount AppView hidden (position:absolute — out of flow so it
    //          never stacks visually on top of the landing during fade-out).
    //          Then begin landing fade-out (view-exit) one rAF later so the
    //          browser has painted AppView before we start moving classes.
    // Phase 2: After landing finishes fading (320ms), hide landing and bring
    //          AppView into flow as view-active (position:relative).
    setAppDisplay('flex');
    setAppCls('view-section view-hidden');   // position:absolute — stays invisible
    requestAnimationFrame(() => {
      setLandingCls('view-section view-exit');
      setCurrentView('app');
    });
    setTimeout(() => {
      setLandingDisplay('none');
      setLandingCls('view-section view-hidden');
      setAppCls('view-section view-active'); // position:relative — now in flow
    }, 320);
  }, [dispatch, isAppSubdomain, rootDomain]);

  const closeApp = useCallback(() => {
    if (rootDomain && rootDomain !== 'localhost' && isAppSubdomain) {
      window.location.href = `https://${rootDomain}`;
      return;
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
    setAppCls('view-section view-hidden');
    setCurrentView('landing');
    setTimeout(() => {
      setAppDisplay('none');
      setLandingDisplay('flex');
      setLandingCls('view-section view-active');
    }, 260);
  }, [isAppSubdomain, rootDomain]);

  // ── Protocol → "How it works" navigation ─────────────────────
  // Landing view  : smooth-scroll to #features in-page
  // Bridge/App view (same domain) : close app → land on #features
  // Bridge/App view (app subdomain) : navigate to main domain #features
  const navigateToFeatures = useCallback(() => {
    if (currentView === 'landing') {
      document.getElementById('features')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (isAppSubdomain) {
      window.location.href = `https://${rootDomain}/#features`;
    } else {
      // Same-domain local/preview — close app then scroll
      closeApp();
      setTimeout(() => {
        document.getElementById('features')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 350);
    }
  }, [currentView, isAppSubdomain, rootDomain, closeApp]);

  useEffect(() => {
    if (isAppSubdomain) {
      // Fade in the page when arriving from arclefx.com
      document.body.classList.add('page-enter');
      setTimeout(() => document.body.classList.remove('page-enter'), 600);

      // Read ?tab= query param and switch to the correct tab
      const params = new URLSearchParams(window.location.search);
      const tabParam = params.get('tab');
      if (tabParam === 'swap' || tabParam === 'unified' || tabParam === 'bridge') {
        dispatch({ type: 'SET_TAB', payload: tabParam });
      }
      if (tabParam) {
        window.history.replaceState({}, '', window.location.pathname);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auto-open on wallet connect ──────────────────────────────
  const prevAddress    = useRef<string | undefined>(undefined);
  const isInitialMount = useRef(true);

  useEffect(() => {
    if (isInitialMount.current) {
      prevAddress.current    = address;
      isInitialMount.current = false;
      return;
    }
    if (address && !prevAddress.current && currentView === 'landing') {
      dispatch({ type: 'CLOSE_MODAL' });
      openApp('bridge');
    }
    prevAddress.current = address;
  }, [address, currentView, openApp, dispatch]);

  return (
    <>
      <div className="bg-grid"></div>
      <div className="bg-noise"></div>
      <div className="ambient-light light-teal"></div>
      <div className="ambient-light light-purple"></div>
      <div className="light-pink"></div>

      <Navbar
        onConnectClick={() => {
          if (address && currentView === 'landing') {
            openApp('bridge');
            return;
          }
          dispatch({ type: 'OPEN_MODAL', payload: 'wallet' });
        }}
        onClose={closeApp}
        showWallet={currentView === 'app'}
        onScrollToFeatures={navigateToFeatures}
      />

      <main>
        <Landing
          className={landingCls}
          style={{ display: landingDisplay }}
          onOpenApp={(tab) => openApp(tab ?? 'bridge')}
        />
        <AppView
          key={appKey}
          className={appCls}
          style={{ display: appDisplay }}
          onCloseApp={closeApp}
        />
      </main>

      <WalletModal />
      <ToastContainer />
    </>
  );
}
