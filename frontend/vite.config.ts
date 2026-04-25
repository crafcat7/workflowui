// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Surface the package.json version to the runtime UI (bottom toolbar
// status strip) without forcing every developer to set an env var
// before `npm run dev`. Reading at config-load time means HMR sees
// version bumps after restart but not mid-session — acceptable since
// the version only changes on release.
const pkg = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), 'package.json'),
    'utf-8',
  ),
) as { version: string };

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // String-literal injection: Vite replaces every reference to
    // import.meta.env.VITE_APP_VERSION with the JSON-stringified value
    // at build time. The JSON.stringify is required — define values
    // are pasted verbatim, so a bare 0.1.0 would parse as a number.
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
})
