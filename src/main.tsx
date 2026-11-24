// ============================================================
//  Application entry point — React root mount
// ============================================================

import { StrictMode }        from 'react';
import { createRoot }         from 'react-dom/client';
import { WagmiProvider }      from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { wagmiConfig }        from './config/wagmi';
import { AppProvider }        from './context/AppContext';
import App                    from './App';
import './styles/globals.css';

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <AppProvider>
          <App />
        </AppProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>
);
