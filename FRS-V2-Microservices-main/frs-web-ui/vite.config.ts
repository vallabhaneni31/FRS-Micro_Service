/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon-32.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Motivity Face Recognition System',
        short_name: 'Motivity FRS',
        description: 'Enterprise attendance intelligence powered by facial recognition.',
        theme_color: '#111419',
        background_color: '#111419',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Live attendance data, uploaded photos, and websocket traffic must never be
        // served from cache — this app has no offline-data story yet, and a stale
        // cached response here means wrong attendance numbers, not just a stale UI.
        // Only the precached app shell (JS/CSS/HTML/icons) is served offline.
        navigateFallbackDenylist: [/\/api\//, /\/uploads\//, /\/socket\.io\//],
        // The MediaPipe WASM runtime + face model is ~26 MB and is only needed
        // on the enrollment portal, so it must stay out of the precache
        // manifest (which every visitor downloads on install). It is fetched
        // on demand when the enrollment camera starts and then cached by the
        // browser normally.
        globIgnores: ['**/mediapipe/**'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [
          { urlPattern: /\/api\//, handler: 'NetworkOnly' },
          { urlPattern: /\/uploads\//, handler: 'NetworkOnly' },
          { urlPattern: /\/socket\.io\//, handler: 'NetworkOnly' },
          {
            urlPattern: /\/mediapipe\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'mediapipe-assets',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },

  build: {
    // nginx (both this host's live config and the repo's infra/nginx template)
    // serves frontend/dist — this must stay Vite's default (relative to this
    // config file, i.e. frontend/dist), NOT '../dist'. A prior '../dist' setting
    // silently built to a stray repo-root dist/ that nothing actually served,
    // so every `npm run build` appeared to succeed while never actually
    // deploying anything — verified and fixed 2026-07-10.
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules/hls.js')) return 'vendor-hls';
          if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-'))
            return 'vendor-charts';
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/') ||
            id.includes('node_modules/react-router') || id.includes('node_modules/scheduler'))
            return 'vendor-react';
          if (id.includes('node_modules/@radix-ui')) return 'vendor-radix';
          if (id.includes('node_modules/lucide-react')) return 'vendor-lucide';
        },
      },
    },
  },

  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],

  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // IAM surface (auth, MFA, session bootstrap, user accounts, RBAC,
      // internal Keycloak/invite provisioning) is served by frs-iam-api
      // exclusively — frs-fe-api no longer has its own copies of these
      // routes. Must be registered before the general '/api' fallback below
      // since Vite's proxy matches by prefix in declaration order.
      '/api/auth': {
        target: 'http://localhost:8082',
        changeOrigin: true,
      },
      // Only session bootstrap is IAM — /api/me/manifest and
      // /api/me/preferences (manifestRoutes.js) stay on frs-fe-api and fall
      // through to the general '/api' rule below, since this is a more
      // specific prefix match.
      '/api/me/bootstrap': {
        target: 'http://localhost:8082',
        changeOrigin: true,
      },
      '/api/users': {
        target: 'http://localhost:8082',
        changeOrigin: true,
      },
      '/api/admin/rbac': {
        target: 'http://localhost:8082',
        changeOrigin: true,
      },
      '/api/internal': {
        target: 'http://localhost:8082',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        ws: true,
      },
      '/uploads': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
    watch: {
      usePolling: true,
    },
  },

  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
