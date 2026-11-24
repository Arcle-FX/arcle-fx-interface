import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    // ── Dev server: serve public sub-folder HTML files at clean URLs ──
    // Mirrors S3 + CloudFront production behaviour so /blog, /docs, /legal
    // and all their sub-pages work locally without the .html extension.
    {
      name: 'static-html-rewrite',
      configureServer(server) {
        // ── Security headers (dev) ─────────────────────────────────
        // Applied on every response — mirrors production CloudFront headers.
        server.middlewares.use((_req, res, next) => {
          res.setHeader('X-Frame-Options',        'DENY');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Referrer-Policy',        'strict-origin-when-cross-origin');
          res.setHeader('Permissions-Policy',     'camera=(), microphone=(), geolocation=()');
          res.setHeader(
            'Content-Security-Policy',
            [
              "default-src 'self'",
              // Scripts: self + inline (React) + Phosphor Icons CDN
              "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net",
              // Styles: self + inline (Vite HMR, styled-components, Phosphor)
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
              // Fonts
              "font-src 'self' https://fonts.gstatic.com https://unpkg.com",
              // Images: self + data URIs + CoinGecko CDN (network/token logos)
              "img-src 'self' data: https://assets.coingecko.com https://walletconnect.com https://avatars.githubusercontent.com https://upload.wikimedia.org",
              // Connect: RPC nodes, Circle SDK, Alchemy, Binance, CoinCap, WalletConnect relay
              "connect-src 'self' https://*.arc.io https://*.arc.network https://sepolia-rollup.arbitrum.io https://sepolia.base.org https://rpc.sepolia.org https://*.g.alchemy.com https://api.circle.com https://api.binance.com https://api.coincap.io https://*.walletconnect.com wss://*.walletconnect.com https://*.walletconnect.org wss://*.walletconnect.org",
              // Frame: deny all
              "frame-src 'none'",
              "frame-ancestors 'none'",
              // Object/base/form
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; ')
          );
          next();
        });

        server.middlewares.use((req, _res, next) => {
          const url = req.url?.split('?')[0] ?? '';

          // Top-level clean routes: /blog → /blog/index.html, /legal → /legal/index.html
          const topRoutes = ['/blog', '/legal'];
          const topMatch = topRoutes.find(r => url === r || url === r + '/');
          if (topMatch) {
            const htmlPath = path.resolve(__dirname, `public${topMatch}/index.html`);
            if (fs.existsSync(htmlPath)) { req.url = `${topMatch}/index.html`; return next(); }
          }

          // Docs sub-pages: /docs → index, /docs/bridge → bridge.html, etc.
          if (url === '/docs' || url === '/docs/') {
            req.url = '/docs/index.html'; return next();
          }
          if (url.startsWith('/docs/') && !url.endsWith('.html') && !url.includes('.')) {
            const slug = url.replace('/docs/', '');
            const htmlPath = path.resolve(__dirname, `public/docs/${slug}.html`);
            if (fs.existsSync(htmlPath)) { req.url = `/docs/${slug}.html`; return next(); }
          }

          next();
        });
      },
    },
  ],
  envPrefix: 'VITE_',
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          // React core — loaded first, cached aggressively
          'react-vendor': ['react', 'react-dom'],
          // Wagmi + viem + TanStack Query
          'wagmi-vendor': ['wagmi', 'viem', '@tanstack/react-query'],
          // Circle App Kit SDK
          'circle-sdk': ['@circle-fin/app-kit', '@circle-fin/adapter-viem-v2'],
          // WalletConnect
          'wallet-connect': ['@walletconnect/modal'],
        },
      },
    },
  },
  server: {
    port: 3000,
    open: true,
    // Serve public/blog/index.html, public/docs/index.html etc. at clean URLs
    // during development — mirrors the S3 / CloudFront production behaviour.
    fs: { strict: false },
  },
})
