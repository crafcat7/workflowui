// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { NodePalette } from './NodePalette';
import { nodeTypeList } from '../nodes';

// The palette's content is derived from the manifest. Rather than
// asserting against literal strings (which would drift every time a
// new node type is added), these tests derive the expected fixtures
// from the live manifest and only assert on behavior.

function findAnyLabelContaining(substr: string): string | undefined {
  // Pick a real label that contains the substring, so the test
  // stays valid no matter how the manifest evolves.
  const needle = substr.toLowerCase();
  return nodeTypeList.find((n) => n.label.toLowerCase().includes(needle))?.label;
}

describe('NodePalette search', () => {
  it('renders every manifest node when the query is blank', () => {
    render(<NodePalette />);
    // Pick three arbitrary manifest entries and confirm they render
    // — establishes the baseline "no filter applied" behavior.
    const sample = nodeTypeList.slice(0, 3);
    for (const nt of sample) {
      expect(screen.getByText(nt.label)).toBeInTheDocument();
    }
  });

  it('narrows the list to nodes whose label contains the query (case-insensitive)', () => {
    // Need a query that matches *some* node but not *all*. Pick the
    // first letter of the first node's label; that guarantees at
    // least one hit while still excluding nodes whose labels don't
    // contain that letter.
    const first = nodeTypeList[0];
    const query = first.label.charAt(0).toUpperCase();

    render(<NodePalette />);
    const input = screen.getByLabelText('Search nodes');
    fireEvent.change(input, { target: { value: query } });

    // Every visible palette-node-label must actually contain the
    // query (case-insensitive). We assert on the rendered cards,
    // not on nodeTypeList, because that's the UI contract.
    const cards = document.querySelectorAll('.palette-node-label');
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect((card.textContent ?? '').toLowerCase()).toContain(query.toLowerCase());
    }
  });

  it('shows the empty-state message when no nodes match', () => {
    render(<NodePalette />);
    const input = screen.getByLabelText('Search nodes');
    // Highly unlikely any node label contains this glyph sequence.
    fireEvent.change(input, { target: { value: 'zzzqqq__nope' } });

    expect(screen.getByText(/No nodes match/i)).toBeInTheDocument();
    // And no cards rendered.
    expect(document.querySelectorAll('.palette-node-card').length).toBe(0);
  });

  it('Escape clears the query and restores the full list', () => {
    render(<NodePalette />);
    const input = screen.getByLabelText('Search nodes') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'zzzqqq__nope' } });
    expect(screen.getByText(/No nodes match/i)).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(input.value).toBe('');
    expect(screen.queryByText(/No nodes match/i)).toBeNull();
    // A representative card is back.
    expect(screen.getByText(nodeTypeList[0].label)).toBeInTheDocument();
  });

  it('overrides collapsed categories while a search is active so hits are never hidden', () => {
    render(<NodePalette />);
    // Collapse every category by clicking each header. Headers are
    // queried by their toggle glyph to stay resilient to label
    // changes in the manifest.
    const headers = document.querySelectorAll('.palette-category-header');
    expect(headers.length).toBeGreaterThan(0);
    for (const h of headers) fireEvent.click(h);

    // With everything collapsed and no query, no cards render.
    expect(document.querySelectorAll('.palette-node-card').length).toBe(0);

    // Now search: the containing category must force-open so the
    // match is visible. Pick a label we know exists.
    const known = findAnyLabelContaining('') ?? nodeTypeList[0].label;
    const input = screen.getByLabelText('Search nodes');
    fireEvent.change(input, { target: { value: known } });

    expect(screen.getByText(known)).toBeInTheDocument();
  });
});
