// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * SVG icon components for node types.
 *
 * Every icon is 24×24, stroke-based, and uses `currentColor` so it
 * inherits the text colour from its parent.  No external icon library
 * dependency — these are self-contained inline SVGs that match the
 * Lucide/Heroicons visual weight.
 */

import type { ReactNode } from 'react';

const svgProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/** Input Image — landscape/photo */
export function ImageIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  );
}

/** Input Tensor — grid/matrix */
export function TensorIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

/** Create Net — brain/network node */
export function BrainIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z" />
      <path d="M10 21h4" />
      <path d="M9 9h6" />
      <path d="M12 9v4" />
    </svg>
  );
}

/** Inference — zap/lightning */
export function ZapIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

/** Benchmark — trending up */
export function TrendingUpIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
      <polyline points="16 7 22 7 22 13" />
    </svg>
  );
}

/** Postprocess — wrench/settings */
export function WrenchIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

/** Save Text — download/file-down */
export function SaveTextIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="18" x2="12" y2="12" />
      <polyline points="9 15 12 18 15 15" />
    </svg>
  );
}

/** Save Image — image + download */
export function SaveImageIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
      <path d="M12 12v6" />
      <path d="m9 15 3 3 3-3" />
    </svg>
  );
}

/** Condition — git branch/fork */
export function BranchIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </svg>
  );
}

/** Output — upload/export */
export function OutputIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

/** Debug/Inspect — search/magnifier */
export function InspectIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

/** Tensor to Image — gradient/heatmap bar */
export function HeatmapIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <rect x="3" y="5" width="18" height="3" rx="1" />
      <rect x="3" y="10" width="18" height="3" rx="1" opacity="0.6" />
      <rect x="3" y="15" width="18" height="3" rx="1" opacity="0.3" />
    </svg>
  );
}

/** Annotate Image — image with text lines */
export function TagIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <path d="M7 8h6" />
      <path d="M7 12h10" />
      <path d="M7 16h4" />
    </svg>
  );
}
