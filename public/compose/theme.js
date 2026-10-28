// Colors and shapes shared by every view.
//
// Link kinds use go-pflow RenderDOT's colors and glyphs (composedot.go:28-33),
// so a drawing here agrees with `RenderDOT | dot -Tsvg`. Ports are colored by
// their wire type: the port schema for a place port (ROADMAP Phase 6, "Wire
// types are port schemas"); transition ports carry no schema and are drawn as
// squares in one neutral color. Shape tells place (circle) from transition
// (square), as in a Petri net.

import { LINK_STYLE } from './model.js';

export { LINK_STYLE };

export const SCHEMA_COLOR = {
  'queue:items': '#2f6fb3',
  'queue:payload': '#6b7f99',
  resource: '#c47a12',
  account: '#7b4cc2',
  'saga:outcome': '#178f7f',
};
export const TRANSITION_PORT_COLOR = '#3c4656';

export function schemaColor(schema) {
  return SCHEMA_COLOR[schema] || '#777';
}
export function portColor(port) {
  return port.target === 'transition' ? TRANSITION_PORT_COLOR : schemaColor(port.schema);
}
export function portTypeLabel(port) {
  return port.target === 'transition' ? 'transition (no schema)' : port.schema;
}

// Pattern instance tints (box headers).
export const PATTERN_TINT = {
  queue: '#e8f0fa',
  'resource-pool': '#fbf0e0',
  saga: '#f1ebfa',
};

// Search wire types (ROADMAP Phase 6 ns:WireType: Position, Value, Value⊥, MoveList) and piece kinds.
export const SEARCH_TYPE_COLOR = {
  Position: '#2f6fb3',
  Value: '#b0413e',
  'Value⊥': '#b0413e',
  MoveList: '#c47a12',
  Window: '#7b4cc2',
  Table: '#178f7f',
  Cutoff: '#8a6d3b',
};
export const PIECE_KIND_COLOR = {
  Order: '#c47a12',
  Driver: '#2f6fb3',
  Memo: '#178f7f',
  Filter: '#b0413e',
  Heuristic: '#a8457f',
  Bound: '#888',
  Engine: '#888',
};

export const INK = '#2b2f36';
export const MUTED = '#6a717c';
export const PAPER = '#fafafa'; // diagram-viewer.js background
export const LEAK = '#c0392b';
