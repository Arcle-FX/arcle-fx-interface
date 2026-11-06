// Vite client types + global Window augmentation
/// <reference types="vite/client" />

import type { EIP1193Provider as ViemEIP1193Provider } from 'viem';

declare global {
  interface Window {
    ethereum?: ViemEIP1193Provider;
  }
}
