// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WS_URL?: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- interface augmentation for Vite
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    /**
     * E2E init-script injection point so a single built bundle can be
     * re-pointed at a different backend per Playwright spec. Wins over
     * build-time VITE_WS_URL but loses to an explicit constructor arg.
     */
    __VITE_WS_URL_OVERRIDE__?: string;
  }
}

export {};
