// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * Pure presentational component for image previews. The fetch logic
 * lives in `useImagePreview.ts`.
 */
import type { ImagePreviewState } from './useImagePreview';

export function ImagePreviewView({
  state,
  alt,
  testIdPrefix,
}: {
  state: ImagePreviewState;
  alt: string;
  testIdPrefix?: string;
}) {
  const { preview, loading, error } = state;
  if (loading) {
    return (
      <div className="node-preview-loading" data-testid={testIdPrefix && `${testIdPrefix}-loading`}>
        Loading preview…
      </div>
    );
  }
  if (error) {
    return (
      <div className="node-preview-error" data-testid={testIdPrefix && `${testIdPrefix}-error`}>
        Cannot preview file
      </div>
    );
  }
  if (preview) {
    return (
      <img
        src={preview}
        alt={alt}
        className="node-preview-thumb"
        data-testid={testIdPrefix && `${testIdPrefix}-img`}
      />
    );
  }
  return null;
}
