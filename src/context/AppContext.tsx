// ============================================================
//  App-wide React context — state management via useReducer
// ============================================================

import { createContext, useContext, useReducer, type ReactNode } from 'react';
import type { TabType, ModalType, TargetType, NetworkToken, TxProgress } from '../types';

// ── State ────────────────────────────────────────────────────
export interface AppState {
  activeTab:    TabType;
  activeModal:  ModalType | null;
  activeTarget: TargetType | null;
  errorMsg:     string;
  txLink:       string;
  slippage:     string;
  deadline:     string;         // tx deadline in minutes (persisted across Settings modal opens)
  gasless:      boolean;        // pay gas in USDC via Circle Paymaster (ERC-4337)
  txProgress:   TxProgress;
  /**
   * Global connector lock — set to the connector id (e.g. "metaMask", "walletConnect")
   * while a connection attempt is in-flight.  Cleared on success, error, or cancel.
   * Persists across modal close/re-open so the user always sees the pending state.
   */
  connectorLock: string | null;
  bridge: {
    from: NetworkToken;
    to:   NetworkToken;
  };
  swap: {
    netId:   string;
    network: string;
    netLogo: string | null;
    from: { token: string; tokLogo: string };
    to:   { token: string; tokLogo: string };
  };
}

// ── Actions ──────────────────────────────────────────────────
export type AppAction =
  | { type: 'SET_TAB';              payload: TabType }
  | { type: 'OPEN_MODAL';           payload: ModalType }
  | { type: 'CLOSE_MODAL' }
  | { type: 'SET_TARGET';           payload: TargetType }
  | { type: 'SET_ERROR';            payload: string }
  | { type: 'SET_TX_LINK';          payload: string }
  | { type: 'SET_SLIPPAGE';         payload: string }
  | { type: 'SET_DEADLINE';         payload: string }
  | { type: 'SET_GASLESS';          payload: boolean }
  | { type: 'SET_BRIDGE_FROM';      payload: Partial<NetworkToken> }
  | { type: 'SET_BRIDGE_TO';        payload: Partial<NetworkToken> }
  | { type: 'SWAP_BRIDGE_SIDES' }
  | { type: 'SET_BRIDGE_TOKEN';     payload: { symbol: string; logo: string } }
  | { type: 'SET_SWAP_NET';         payload: { netId: string; network: string; netLogo: string | null } }
  | { type: 'SET_SWAP_FROM';        payload: { token: string; tokLogo: string } }
  | { type: 'SET_SWAP_TO';          payload: { token: string; tokLogo: string } }
  | { type: 'SWAP_SWAP_TOKENS' }
  | { type: 'OPEN_TX_PROGRESS';     payload: Omit<TxProgress, 'isOpen'> }
  | { type: 'UPDATE_TX_STEP';       payload: { index: number; status: TxProgress['steps'][0]['status'] } }
  | { type: 'SET_TX_STATUS';        payload: { status: TxProgress['status']; txLink?: string; errorMsg?: string } }
  | { type: 'CLOSE_TX_PROGRESS' }
  /** Claim the global connector lock before starting a connection attempt. */
  | { type: 'SET_CONNECTOR_LOCK';   payload: string | null };

// ── Initial state ────────────────────────────────────────────
const DEFAULT_TX_PROGRESS: TxProgress = {
  isOpen: false, type: 'bridge', status: 'waiting',
  steps: [], fromLabel: '', toLabel: '', fromLogo: '', toLogo: '', txLink: '#', errorMsg: '',
};

const initialState: AppState = {
  activeTab:     'bridge',
  activeModal:   null,
  activeTarget:  null,
  errorMsg:      '',
  txLink:        '#',
  slippage:      '0.5%',
  deadline:      '20',
  gasless:       false,
  txProgress:    DEFAULT_TX_PROGRESS,
  connectorLock: null,
  bridge: {
    from: {
      network: 'Ethereum',
      netId:   'Ethereum',
      netLogo: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
      token:   'USDC',
      tokLogo: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
    },
    to: {
      network: 'ARC Network',
      netId:   'Arc',
      netLogo: '/arc-logo.svg',
      token:   'USDC',
      tokLogo: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
    },
  },
  swap: {
    netId:   'Arc',
    network: 'ARC Network',
    netLogo: '/arc-logo.svg',
    from: { token: 'USDC', tokLogo: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png' },
    to:   { token: 'EURC', tokLogo: 'https://assets.coingecko.com/coins/images/26045/small/euro-coin.png' },
  },
};

// ── Reducer ──────────────────────────────────────────────────
function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_TAB':         return { ...state, activeTab: action.payload };
    case 'OPEN_MODAL':      return { ...state, activeModal: action.payload };
    case 'CLOSE_MODAL':     return { ...state, activeModal: null };
    case 'SET_TARGET':      return { ...state, activeTarget: action.payload };
    case 'SET_ERROR':       return { ...state, errorMsg: action.payload };
    case 'SET_TX_LINK':     return { ...state, txLink: action.payload };
    case 'SET_SLIPPAGE':    return { ...state, slippage: action.payload };
    case 'SET_DEADLINE':    return { ...state, deadline: action.payload };
    case 'SET_GASLESS':     return { ...state, gasless: action.payload };
    case 'SET_CONNECTOR_LOCK': return { ...state, connectorLock: action.payload };
    case 'SET_BRIDGE_FROM': return { ...state, bridge: { ...state.bridge, from: { ...state.bridge.from, ...action.payload } } };
    case 'SET_BRIDGE_TO':   return { ...state, bridge: { ...state.bridge, to:   { ...state.bridge.to,   ...action.payload } } };
    case 'SWAP_BRIDGE_SIDES': return {
      ...state,
      bridge: { from: { ...state.bridge.to }, to: { ...state.bridge.from } },
    };
    case 'SET_BRIDGE_TOKEN': return {
      ...state,
      bridge: {
        from: { ...state.bridge.from, token: action.payload.symbol, tokLogo: action.payload.logo },
        to:   { ...state.bridge.to,   token: action.payload.symbol, tokLogo: action.payload.logo },
      },
    };
    case 'SET_SWAP_NET': return {
      ...state,
      swap: { ...state.swap, netId: action.payload.netId, network: action.payload.network, netLogo: action.payload.netLogo },
    };
    case 'SET_SWAP_FROM': {
      // If user picks the same token that's already on the "to" side → swap the pair
      const sameAsTo = action.payload.token === state.swap.to.token;
      return {
        ...state,
        swap: {
          ...state.swap,
          from: sameAsTo ? { ...state.swap.to }   : action.payload,
          to:   sameAsTo ? { ...state.swap.from }  : state.swap.to,
        },
      };
    }
    case 'SET_SWAP_TO': {
      // If user picks the same token that's already on the "from" side → swap the pair
      const sameAsFrom = action.payload.token === state.swap.from.token;
      return {
        ...state,
        swap: {
          ...state.swap,
          from: sameAsFrom ? { ...state.swap.to }   : state.swap.from,
          to:   sameAsFrom ? { ...state.swap.from }  : action.payload,
        },
      };
    }
    case 'SWAP_SWAP_TOKENS': return {
      ...state,
      swap: { ...state.swap, from: { ...state.swap.to }, to: { ...state.swap.from } },
    };
    case 'OPEN_TX_PROGRESS':  return { ...state, txProgress: { ...action.payload, isOpen: true } };
    case 'UPDATE_TX_STEP': return {
      ...state,
      txProgress: {
        ...state.txProgress,
        steps: state.txProgress.steps.map((s, i) =>
          i === action.payload.index ? { ...s, status: action.payload.status } : s
        ),
      },
    };
    case 'SET_TX_STATUS': return {
      ...state,
      txProgress: {
        ...state.txProgress,
        status:   action.payload.status,
        txLink:   action.payload.txLink   ?? state.txProgress.txLink,
        errorMsg: action.payload.errorMsg ?? state.txProgress.errorMsg,
      },
    };
    case 'CLOSE_TX_PROGRESS': return { ...state, txProgress: { ...state.txProgress, isOpen: false } };
    default: return state;
  }
}

// ── Context ──────────────────────────────────────────────────
interface AppContextValue {
  state:    AppState;
  dispatch: React.Dispatch<AppAction>;
}

const AppContext = createContext<AppContextValue | null>(null);

/** Wraps the component tree with the shared application state. */
export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
}

/** Hook that returns the app context value; throws if used outside AppProvider. */
export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppContext must be used within AppProvider');
  return ctx;
}
