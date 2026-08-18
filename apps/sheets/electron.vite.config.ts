import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    // @genoffice/* workspace packages ship TS source (no build step, no
    // compiled entry point) — externalizing them makes Node's ESM loader try
    // to resolve their relative imports at runtime and fail. Bundle those;
    // externalize everything else (Electron, zod, node builtins).
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@genoffice/ai-provider',
          '@genoffice/agent-core',
          '@genoffice/ai-search',
          '@genoffice/file-parse',
          '@genoffice/electron-utils',
          '@genoffice/i18n',
        ],
      }),
    ],
  },
  // Keep the sandboxed preload self-contained. The AI request validators are
  // runtime imports, so they must be bundled instead of emitted as a bare
  // workspace-package require that a sandboxed preload cannot resolve.
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@genoffice/ai-provider'] })],
  },
  renderer: {
    plugins: [react()],
  },
})
