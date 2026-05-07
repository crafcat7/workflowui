// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * File picker utility that works in both Tauri desktop and web browser.
 *
 * In Tauri: uses native file dialog via @tauri-apps/plugin-dialog
 * In browser: uses HTML input[type=file] as fallback
 */

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

interface PickFileOptions {
  title?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  multiple?: boolean;
}

/**
 * Opens a file picker dialog and returns selected file path(s).
 * In Tauri: returns absolute file path(s).
 * In browser: returns filename(s) only (full path not available for security).
 */
export async function pickFile(options: PickFileOptions = {}): Promise<string | null> {
  if (isTauri) {
    return pickFileTauri(options);
  }
  return pickFileBrowser(options);
}

async function pickFileTauri(options: PickFileOptions): Promise<string | null> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({
      title: options.title ?? 'Select File',
      multiple: options.multiple ?? false,
      filters: options.filters,
    });
    if (result === null) return null;
    if (Array.isArray(result)) return result[0] ?? null;
    return result;
  } catch {
    return null;
  }
}

function pickFileBrowser(options: PickFileOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = options.multiple ?? false;

    if (options.filters && options.filters.length > 0) {
      const accept = options.filters
        .flatMap((f) => f.extensions.map((ext) => `.${ext}`))
        .join(',');
      input.accept = accept;
    }

    input.onchange = () => {
      const file = input.files?.[0];
      resolve(file ? file.name : null);
    };

    input.oncancel = () => resolve(null);
    input.click();
  });
}

/**
 * Reads text content from a file.
 * In Tauri: reads file from disk using absolute path.
 * In browser: reads from File object.
 */
export async function readTextFile(pathOrFile: string | File): Promise<string | null> {
  if (typeof pathOrFile === 'string' && isTauri) {
    try {
      const { readTextFile: tauriRead } = await import('@tauri-apps/plugin-fs');
      return await tauriRead(pathOrFile);
    } catch {
      return null;
    }
  }

  if (typeof pathOrFile !== 'string') {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsText(pathOrFile);
    });
  }

  return null;
}

/**
 * Opens file picker and reads text content in one step.
 */
export async function pickAndReadTextFile(
  options: PickFileOptions = {},
): Promise<{ path: string; content: string } | null> {
  if (isTauri) {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const { readTextFile: tauriRead } = await import('@tauri-apps/plugin-fs');
      const result = await open({
        title: options.title ?? 'Select File',
        multiple: false,
        filters: options.filters,
      });
      if (result === null || Array.isArray(result)) return null;
      const content = await tauriRead(result);
      return { path: result, content };
    } catch {
      return null;
    }
  }

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';

    if (options.filters && options.filters.length > 0) {
      const accept = options.filters
        .flatMap((f) => f.extensions.map((ext) => `.${ext}`))
        .join(',');
      input.accept = accept;
    }

    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve({ path: file.name, content: reader.result });
        } else {
          resolve(null);
        }
      };
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };

    input.oncancel = () => resolve(null);
    input.click();
  });
}
