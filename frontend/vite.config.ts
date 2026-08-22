import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['repoquill.svg'],
      manifest: {
        id: '/',
        name: 'RepoQuill',
        short_name: 'RepoQuill',
        description: 'Portable Git-backed Markdown notes',
        theme_color: '#18181b',
        background_color: '#09090b',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        categories: ['productivity', 'utilities'],
        icons: [
          {
            src: '/repoquill.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,svg}'],
      },
    }),
  ],
  server: {
    proxy: { '/api': 'http://localhost:8080' },
  },
})
