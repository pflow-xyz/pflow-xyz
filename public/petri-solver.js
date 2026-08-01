/**
 * psolver.js - ES Module for ODE Solving with Petri Nets
 * 
 * Provides ODE solver functionality for Petri net simulation
 * Compatible with JSON-LD schema from pflow.xyz
 * Implements Tsit5 (5th order Runge-Kutta) solver
 */

import { expandColors, expandState } from './petri-colors.js';

// ============================================================================
// Data Structures
// ============================================================================

/**
 * Place in a Petri net
 */
export class Place {
  constructor(label, initial = [], capacity = [], x = 0, y = 0, labelText = null) {
    this.label = label;
    this.initial = Array.isArray(initial) ? initial : [initial];
    this.capacity = Array.isArray(capacity) ? capacity : [capacity];
    this.x = x;
    this.y = y;
    this.labelText = labelText;
  }

  getTokenCount() {
    return this.initial.length === 0 ? 0 : this.initial.reduce((a, b) => a + b, 0);
  }
}

/**
 * Transition in a Petri net
 */
export class Transition {
  constructor(label, role = "default", x = 0, y = 0, labelText = null) {
    this.label = label;
    this.role = role;
    this.x = x;
    this.y = y;
    this.labelText = labelText;
  }
}

/**
 * Arc connecting places and transitions
 */
export class Arc {
  constructor(source, target, weight = [1], inhibitTransition = false) {
    this.source = source;
    this.target = target;
    this.weight = Array.isArray(weight) ? weight : [weight];
    this.inhibitTransition = inhibitTransition;
  }

  getWeightSum() {
    return this.weight.length === 0 ? 1 : this.weight.reduce((a, b) => a + b, 0);
  }
}

/**
 * Petri Net model
 */
export class PetriNet {
  constructor() {
    this.places = new Map();
    this.transitions = new Map();
    this.arcs = [];
    this.token = [];
  }

  addPlace(label, initial, capacity, x, y, labelText) {
    const place = new Place(label, initial, capacity, x, y, labelText);
    this.places.set(label, place);
    return place;
  }

  addTransition(label, role, x, y, labelText) {
    const transition = new Transition(label, role, x, y, labelText);
    this.transitions.set(label, transition);
    return transition;
  }

  addArc(source, target, weight, inhibitTransition = false) {
    const arc = new Arc(source, target, weight, inhibitTransition);
    this.arcs.push(arc);
    return arc;
  }
}

/**
 * Parse JSON-LD format to PetriNet
 */
export function fromJSON(data) {
  if (typeof data === 'string') {
    data = JSON.parse(data);
  }

  const net = new PetriNet();

  // Parse token colors if present
  if (data.token) {
    net.token = data.token;
  }

  // Parse places
  if (data.places) {
    for (const [label, placeData] of Object.entries(data.places)) {
      const initial = placeData.initial || [];
      const capacity = placeData.capacity || [];
      const x = placeData.x || 0;
      const y = placeData.y || 0;
      const labelText = placeData.label || null;
      net.addPlace(label, initial, capacity, x, y, labelText);
    }
  }

  // Parse transitions
  if (data.transitions) {
    for (const [label, transData] of Object.entries(data.transitions)) {
      const role = transData.role || "default";
      const x = transData.x || 0;
      const y = transData.y || 0;
      const labelText = transData.label || null;
      net.addTransition(label, role, x, y, labelText);
    }
  }

  // Parse arcs
  if (data.arcs) {
    for (const arcData of data.arcs) {
      const source = arcData.source;
      const target = arcData.target;
      const weight = arcData.weight || [1];
      const inhibitTransition = arcData.inhibitTransition || false;
      net.addArc(source, target, weight, inhibitTransition);
    }
  }

  return net;
}

/**
 * Set initial state from Petri net.
 *
 * Keys are the net's own place names, and the value is that place's TOTAL
 * across colors. On a multi-color net, ODEProblem maps this through
 * expandState to recover the per-color split.
 *
 * @param {PetriNet} net
 * @param {Object<string, number>|null} customState
 * @returns {Object<string, number>}
 */
export function setState(net, customState = null) {
  /** @type {Object<string, number>} */
  const state = {};
  for (const [label, place] of net.places) {
    if (customState && customState[label] !== undefined) {
      state[label] = customState[label];
    } else {
      state[label] = place.getTokenCount();
    }
  }
  return state;
}

/**
 * Set transition rates
 * @param {PetriNet} net
 * @param {Object<string, number>|null} customRates
 * @returns {Object<string, number>}
 */
export function setRates(net, customRates = null) {
  /** @type {Object<string, number>} */
  const rates = {};
  for (const [label, _] of net.transitions) {
    if (customRates && customRates[label] !== undefined) {
      rates[label] = customRates[label];
    } else {
      rates[label] = 1.0;
    }
  }
  return rates;
}

// ============================================================================
// ODE System from Petri Net
// ============================================================================

/**
 * Build ODE derivative function from Petri net
 */
function buildODEFunction(net, rates) {
  return function(t, u) {
    const du = {};
    
    // Initialize derivatives to zero
    for (const label of net.places.keys()) {
      du[label] = 0.0;
    }

    // Compute derivatives for each transition
    for (const [transLabel, _] of net.transitions) {
      const rate = rates[transLabel];
      
      // Calculate flux using mass action kinetics
      let flux = rate;
      
      // Multiply by input place concentrations raised to their stoichiometric coefficients
      for (const arc of net.arcs) {
        if (arc.target === transLabel && net.places.has(arc.source)) {
          // This is an input arc (place -> transition)
          const placeState = u[arc.source];
          const weight = arc.getWeightSum();
          
          if (placeState <= 0) {
            flux = 0;
            break;
          }
          
          // For mass action kinetics: flux *= [S]^weight
          flux *= placeState;
        }
      }

      // Apply flux to all connected places
      if (flux > 0) {
        for (const arc of net.arcs) {
          const weight = arc.getWeightSum();
          
          if (arc.target === transLabel && net.places.has(arc.source)) {
            // Input arc: consume tokens
            du[arc.source] -= flux * weight;
          } else if (arc.source === transLabel && net.places.has(arc.target)) {
            // Output arc: produce tokens
            du[arc.target] += flux * weight;
          }
        }
      }
    }

    return du;
  };
}

// ============================================================================
// ODE Solver - Tsit5 (5th order Runge-Kutta)
// ============================================================================

/**
 * ODE Problem definition
 */
export class ODEProblem {
  /**
   * Multi-color nets are unfolded first (expandColors), so mass-action
   * kinetics run per color: a transition's flux depends only on the colors its
   * input arcs actually name, and consumes only those. Without the unfolding a
   * place holding [red:10, blue:5] would drive a red-only reaction at
   * concentration 15 and pay for it out of a summed pool.
   *
   * initialState is mapped through expandState, so the usual
   * `new ODEProblem(net, setState(net), …)` call reproduces each place's
   * declared per-color vector exactly. ODESolution.getFinalState and getState
   * still report per-place totals under the original names, so existing
   * readers are unaffected; getVariable and stateLabels expose the per-color
   * series.
   *
   * `net` is the unfolded net; `colorMap` is null when nothing was unfolded.
   * Mirrors go-pflow's solver.NewProblem.
   */
  constructor(net, initialState, tspan, rates) {
    const { net: expanded, colorMap } = expandColors(net);
    if (colorMap !== null) {
      initialState = expandState(net, initialState);
      net = expanded;
    }
    this.net = net;
    this.colorMap = colorMap;
    this.u0 = initialState;
    this.tspan = tspan;
    this.rates = rates;
    this.f = buildODEFunction(net, rates);
  }
}

/**
 * ODE Solution
 */
export class ODESolution {
  /**
   * On a color-unfolded problem `u` and `stateLabels` use the expanded
   * per-color place names ("pool.red"); getFinalState and getState fold them
   * back to per-place totals under the original names, and getVariable accepts
   * either. Mirrors go-pflow's solver.Solution.
   */
  constructor(t, u, stateLabels, colorMap = null) {
    this.t = t;
    this.u = u;  // Array of state objects
    this.stateLabels = stateLabels;
    this.colorMap = colorMap;
  }

  /**
   * Get values for a specific state variable.
   *
   * On a color-unfolded solution an expanded name ("pool.red") selects that
   * color and a base name ("pool") sums across colors, so a caller that
   * plotted "pool" before the unfolding still gets the same total series.
   *
   * @param {number|string} index - Index or label of state variable
   * @returns {Array<number>}
   */
  getVariable(index) {
    let label;
    if (typeof index === 'number') {
      label = this.stateLabels[index];
    } else {
      label = index;
    }
    const labels = this.colorMap ? this.colorMap.lookup(label) : [label];
    return this.u.map(state => {
      let sum = 0;
      for (const l of labels) sum += state[l] ?? 0;
      return sum;
    });
  }

  /**
   * Per-color time series for a base place, index-aligned with
   * colorMap.colors. On a single-color solution this is the one series.
   * @param {string} place
   * @returns {Array<Array<number>>}
   */
  getVariableByColor(place) {
    const labels = this.colorMap ? this.colorMap.lookup(place) : [place];
    return labels.map(l => this.u.map(state => state[l] ?? 0));
  }

  /**
   * Get final state, keyed by the original place names — on a color-unfolded
   * solution the colors of each place are summed. See getFinalStateByColor.
   */
  getFinalState() {
    const last = this.u[this.u.length - 1];
    if (last === undefined) return last;
    return this.colorMap ? this.colorMap.sumByBase(last) : last;
  }

  /**
   * Get final state keyed by expanded per-color place names. Identical to
   * getFinalState on a single-color solution.
   */
  getFinalStateByColor() {
    return this.u[this.u.length - 1];
  }

  /**
   * Get state at specific index, keyed by the original place names (colors
   * summed). See getStateByColor.
   */
  getState(index) {
    const s = this.u[index];
    if (s === undefined) return s;
    return this.colorMap ? this.colorMap.sumByBase(s) : s;
  }

  /**
   * Get state at specific index keyed by expanded per-color place names.
   */
  getStateByColor(index) {
    return this.u[index];
  }
}

/**
 * Tsit5 Solver - 5th order Runge-Kutta method
 * Based on Tsitouras 2011 scheme
 */
export function Tsit5() {
  return {
    name: "Tsit5",
    order: 5,
    
    // Butcher tableau coefficients for Tsit5 (7 stages)
    c: [0, 0.161, 0.327, 0.9, 0.9800255409045097, 1, 1],
    a: [
      [],
      [0.161],
      [-0.008480655492356924, 0.335480655492357],
      [2.8971530571054935, -6.359448489975075, 4.362295432869581],
      [5.325864828439257, -11.748883564062828, 7.4955393428898365, -0.09249506636175525],
      [5.86145544294642, -12.92096931784711, 8.159367898576159, -0.071584973281401, -0.028269050394068383],
      [0.09646076681806523, 0.01, 0.4798896504144996, 1.379008574103742, -3.290069515436081, 2.324710524099774, 0]
    ],
    b: [0.09646076681806523, 0.01, 0.4798896504144996, 1.379008574103742, -3.290069515436081, 2.324710524099774, 0],
    bhat: [0.001780011052226, 0.000816434459657, -0.007880878010262, 0.144711007173263, -0.582357165452555, 0.458082105929187, 1.0 / 66.0]
  };
}

/**
 * Solve ODE problem
 */
export function solve(prob, solver = Tsit5(), options = {}) {
  const {
    dt = 0.01,
    dtmin = 1e-6,
    dtmax = 0.1,
    abstol = 1e-6,
    reltol = 1e-3,
    maxiters = 100000,
    adaptive = true
  } = options;

  const [t0, tf] = prob.tspan;
  const u0 = prob.u0;
  const f = prob.f;

  const t = [t0];
  const u = [{ ...u0 }];
  const stateLabels = Object.keys(u0);

  let tcur = t0;
  let ucur = { ...u0 };
  let dtcur = dt;
  let nsteps = 0;

  while (tcur < tf && nsteps < maxiters) {
    // Don't overshoot final time
    if (tcur + dtcur > tf) {
      dtcur = tf - tcur;
    }

    // Tsit5 stages
    const k = [];
    k[0] = f(tcur, ucur);
    
    for (let stage = 1; stage < solver.c.length; stage++) {
      const tstage = tcur + solver.c[stage] * dtcur;
      const ustage = {};
      
      for (const key of stateLabels) {
        ustage[key] = ucur[key];
        for (let j = 0; j < stage; j++) {
          ustage[key] += dtcur * solver.a[stage][j] * k[j][key];
        }
      }
      
      k[stage] = f(tstage, ustage);
    }

    // Compute 5th order solution
    const unext = {};
    for (const key of stateLabels) {
      unext[key] = ucur[key];
      for (let j = 0; j < solver.b.length; j++) {
        unext[key] += dtcur * solver.b[j] * k[j][key];
      }
    }

    // Compute error estimate if adaptive
    let err = 0;
    if (adaptive) {
      for (const key of stateLabels) {
        let errest = 0;
        for (let j = 0; j < solver.bhat.length; j++) {
          errest += dtcur * solver.bhat[j] * k[j][key];
        }
        const scale = abstol + reltol * Math.max(Math.abs(ucur[key]), Math.abs(unext[key]));
        err = Math.max(err, Math.abs(errest) / scale);
      }
    }

    // Accept or reject step
    if (!adaptive || err <= 1.0 || dtcur <= dtmin) {
      // Accept step
      tcur += dtcur;
      ucur = unext;
      t.push(tcur);
      u.push({ ...ucur });
      nsteps++;

      // Adapt step size
      if (adaptive && err > 0) {
        const factor = 0.9 * Math.pow(1.0 / err, 1.0 / (solver.order + 1));
        dtcur = Math.min(dtmax, Math.max(dtmin, dtcur * Math.min(factor, 5.0)));
      }
    } else {
      // Reject step and reduce step size
      const factor = 0.9 * Math.pow(1.0 / err, 1.0 / (solver.order + 1));
      dtcur = Math.max(dtmin, dtcur * Math.max(factor, 0.1));
    }
  }

  return new ODESolution(t, u, stateLabels, prob.colorMap ?? null);
}

// ============================================================================
// Plotting Functionality
// ============================================================================

// Categorical palette: 8 slots in fixed order, each with a light-surface and a
// dark-surface step. Slots are assigned by series index, never re-ordered when
// series are hidden; past 8 the hue repeats with a dash pattern as the
// secondary encoding. Chrome (surface/ink/grid) rides the same mechanism.
// Every color is emitted as var(--pv-viz-*, <light fallback>) so the SVG picks
// up the host page's theme (petri-view.css defines the dark values) while a
// standalone export still renders the validated light palette.
const VIZ_SERIES = [
  { slot: 'blue',    light: '#2a78d6', dark: '#3987e5' },
  { slot: 'orange',  light: '#eb6834', dark: '#d95926' },
  { slot: 'aqua',    light: '#1baf7a', dark: '#199e70' },
  { slot: 'yellow',  light: '#eda100', dark: '#c98500' },
  { slot: 'magenta', light: '#e87ba4', dark: '#d55181' },
  { slot: 'green',   light: '#008300', dark: '#008300' },
  { slot: 'violet',  light: '#4a3aa7', dark: '#9085e9' },
  { slot: 'red',     light: '#e34948', dark: '#e66767' },
];

const VIZ_CHROME = {
  surface: { light: '#fcfcfb', dark: '#1a1a19' },
  ink:     { light: '#0b0b0b', dark: '#ffffff' },
  muted:   { light: '#898781', dark: '#898781' },
  grid:    { light: '#e1e0d9', dark: '#2c2c2a' },
  axis:    { light: '#c3c2b7', dark: '#383835' },
};

const VIZ_FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

function vizVar(name, fallback) {
  return `var(--pv-viz-${name}, ${fallback})`;
}

function seriesColor(i) {
  const s = VIZ_SERIES[i % VIZ_SERIES.length];
  return vizVar(`series-${(i % VIZ_SERIES.length) + 1}`, s.light);
}

function escXML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Format an axis tick / tooltip value: trims noise, survives tiny and huge. */
function fmtNum(v) {
  if (!isFinite(v)) return String(v);
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-3) return v.toExponential(2).replace('e+', 'e');
  if (a >= 1000) return String(Math.round(v));
  if (a >= 100) return String(+v.toFixed(1));
  if (a >= 1) return String(+v.toFixed(2));
  return String(+v.toFixed(4));
}

/** Pick a 1-2-5 step giving roughly `target` ticks over [min,max]. */
function niceTicks(min, max, target = 5) {
  const span = max - min;
  if (!(span > 0)) return [min];
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  let step = mag;
  for (const m of [1, 2, 5, 10]) {
    if (raw <= m * mag) { step = m * mag; break; }
  }
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) {
    ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  }
  return ticks;
}

/**
 * SVG line/scatter plotter used for all analysis charts.
 *
 * API kept stable for downstream vendored copies: constructor(width, height),
 * chainable setTitle/setXLabel/setYLabel/addSeries, render() -> svg string,
 * static setupInteractivity(plotData), static plotSolution(sol, vars, opts).
 */
export class SVGPlotter {
  constructor(width = 600, height = 400, options = {}) {
    this.width = width || 600;
    this.height = height || 400;
    this.title = "";
    this.xlabel = "Time";
    this.ylabel = "Value";
    this.series = [];
    // 'crosshair' (monotonic x, e.g. time series) or 'point' (nearest sample,
    // e.g. phase portraits where x is not monotonic)
    this.hoverMode = options.hoverMode || 'crosshair';
    this.clampYZero = options.clampYZero !== false; // token counts: baseline at 0
  }

  setTitle(title) { this.title = title; return this; }
  setXLabel(label) { this.xlabel = label; return this; }
  setYLabel(label) { this.ylabel = label; return this; }

  addSeries(x, y, label = "", color = null, opts = {}) {
    const i = this.series.length;
    this.series.push({
      x, y, label,
      color: color || seriesColor(i),
      dash: opts.dash || (i >= VIZ_SERIES.length ? '5,3' : null),
      markers: !!opts.markers,
    });
    return this;
  }

  render() {
    // Data ranges
    let xmin = Infinity, xmax = -Infinity;
    let ymin = Infinity, ymax = -Infinity;
    for (const s of this.series) {
      for (let i = 0; i < s.x.length; i++) {
        if (!isFinite(s.x[i]) || !isFinite(s.y[i])) continue;
        xmin = Math.min(xmin, s.x[i]); xmax = Math.max(xmax, s.x[i]);
        ymin = Math.min(ymin, s.y[i]); ymax = Math.max(ymax, s.y[i]);
      }
    }
    if (!isFinite(xmin)) { xmin = 0; xmax = 1; ymin = 0; ymax = 1; }
    if (this.clampYZero && ymin >= 0) ymin = 0;
    const xpad = (xmax - xmin || 1) * 0.02;
    const ypad = (ymax - ymin || 1) * 0.06;
    xmin -= xpad; xmax += xpad;
    if (!(this.clampYZero && ymin === 0)) ymin -= ypad;
    ymax += ypad;

    const xTicks = niceTicks(xmin, xmax, 6);
    const yTicks = niceTicks(ymin, ymax, 5);

    // Dynamic margins: left fits the widest y label, top fits title + legend.
    const yLabelW = Math.max(...yTicks.map(t => fmtNum(t).length), 1) * 6.6;
    const margin = {
      top: this.title ? 34 : 14,
      right: 14,
      bottom: this.xlabel ? 44 : 28,
      left: Math.ceil(yLabelW) + (this.ylabel ? 34 : 16),
    };

    // Legend: horizontal rows above the plot (only for >= 2 labeled series —
    // a single series is named by the title).
    const labeled = this.series.filter(s => s.label);
    const showLegend = labeled.length >= 2;
    const legendItems = [];
    let legendRows = 0;
    if (showLegend) {
      const availW = this.width - margin.left - margin.right;
      let lx = 0, row = 0;
      for (let i = 0; i < this.series.length; i++) {
        const s = this.series[i];
        if (!s.label) continue;
        const w = 22 + s.label.length * 6.6 + 14;
        if (lx + w > availW && lx > 0) { lx = 0; row++; }
        legendItems.push({ i, x: lx, row, label: s.label, color: s.color, dash: s.dash });
        lx += w;
      }
      legendRows = row + 1;
      margin.top += legendRows * 18 + 4;
    }

    const plotWidth = Math.max(10, this.width - margin.left - margin.right);
    const plotHeight = Math.max(10, this.height - margin.top - margin.bottom);
    const sx = (x) => margin.left + ((x - xmin) / (xmax - xmin)) * plotWidth;
    const sy = (y) => margin.top + plotHeight - ((y - ymin) / (ymax - ymin)) * plotHeight;

    const plotId = 'plot_' + Math.random().toString(36).substr(2, 9);
    const ink = vizVar('ink', VIZ_CHROME.ink.light);
    const muted = vizVar('muted', VIZ_CHROME.muted.light);
    const grid = vizVar('grid', VIZ_CHROME.grid.light);
    const axis = vizVar('axis', VIZ_CHROME.axis.light);
    const surface = vizVar('surface', VIZ_CHROME.surface.light);

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${this.width} ${this.height}" ` +
      `width="${this.width}" height="${this.height}" id="${plotId}" role="img" ` +
      `aria-label="${escXML(this.title || 'Chart')}" ` +
      `style="background:${surface};max-width:100%;height:auto;font-family:${VIZ_FONT};">`;
    if (this.title) {
      svg += `<text x="${margin.left}" y="20" font-size="13" font-weight="600" fill="${ink}">${escXML(this.title)}</text>`;
    }

    // Legend (click-to-toggle wired in setupInteractivity)
    for (const it of legendItems) {
      const ly = (this.title ? 34 : 14) + it.row * 18 + 9;
      const dashAttr = it.dash ? ` stroke-dasharray="${it.dash}"` : '';
      svg += `<g id="${plotId}_leg_${it.i}" style="cursor:pointer;">` +
        `<rect x="${margin.left + it.x - 2}" y="${ly - 9}" width="${20 + it.label.length * 6.6 + 4}" height="17" fill="transparent"/>` +
        `<line x1="${margin.left + it.x}" y1="${ly}" x2="${margin.left + it.x + 16}" y2="${ly}" stroke="${it.color}" stroke-width="2.5"${dashAttr}/>` +
        `<text x="${margin.left + it.x + 21}" y="${ly + 4}" font-size="11" fill="${ink}">${escXML(it.label)}</text></g>`;
    }

    // Gridlines (hairline) + ticks, recessive
    for (const t of xTicks) {
      const px = sx(t);
      svg += `<line x1="${px}" y1="${margin.top}" x2="${px}" y2="${margin.top + plotHeight}" stroke="${grid}" stroke-width="1"/>`;
      svg += `<text x="${px}" y="${margin.top + plotHeight + 16}" text-anchor="middle" font-size="10" fill="${muted}" style="font-variant-numeric:tabular-nums;">${fmtNum(t)}</text>`;
    }
    for (const t of yTicks) {
      const py = sy(t);
      svg += `<line x1="${margin.left}" y1="${py}" x2="${margin.left + plotWidth}" y2="${py}" stroke="${grid}" stroke-width="1"/>`;
      svg += `<text x="${margin.left - 6}" y="${py + 3.5}" text-anchor="end" font-size="10" fill="${muted}" style="font-variant-numeric:tabular-nums;">${fmtNum(t)}</text>`;
    }
    // Baseline axes
    svg += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}" stroke="${axis}" stroke-width="1"/>`;
    svg += `<line x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${margin.left + plotWidth}" y2="${margin.top + plotHeight}" stroke="${axis}" stroke-width="1"/>`;

    if (this.xlabel) {
      svg += `<text x="${margin.left + plotWidth / 2}" y="${this.height - 10}" text-anchor="middle" font-size="11" fill="${muted}">${escXML(this.xlabel)}</text>`;
    }
    if (this.ylabel) {
      const cy = margin.top + plotHeight / 2;
      svg += `<text x="14" y="${cy}" text-anchor="middle" font-size="11" fill="${muted}" transform="rotate(-90, 14, ${cy})">${escXML(this.ylabel)}</text>`;
    }

    // Series (clipped to the plot area)
    svg += `<clipPath id="${plotId}_clip"><rect x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}"/></clipPath>`;
    svg += `<g clip-path="url(#${plotId}_clip)">`;
    for (let si = 0; si < this.series.length; si++) {
      const s = this.series[si];
      let path = '';
      for (let i = 0; i < s.x.length; i++) {
        if (!isFinite(s.x[i]) || !isFinite(s.y[i])) continue;
        path += (path ? ' L' : 'M') + sx(s.x[i]).toFixed(2) + ',' + sy(s.y[i]).toFixed(2);
      }
      const dashAttr = s.dash ? ` stroke-dasharray="${s.dash}"` : '';
      svg += `<g id="${plotId}_s_${si}">`;
      svg += `<path d="${path}" stroke="${s.color}" stroke-width="2" fill="none" stroke-linejoin="round"${dashAttr}/>`;
      if (s.markers) {
        for (let i = 0; i < s.x.length; i++) {
          if (!isFinite(s.x[i]) || !isFinite(s.y[i])) continue;
          svg += `<circle cx="${sx(s.x[i]).toFixed(2)}" cy="${sy(s.y[i]).toFixed(2)}" r="4" fill="${s.color}" stroke="${surface}" stroke-width="2"/>`;
        }
      }
      svg += `</g>`;
    }
    svg += `</g>`;

    // Hover layer: crosshair line, per-series dots, tooltip
    svg += `<g id="${plotId}_crosshair" style="display:none;pointer-events:none;">`;
    svg += `<line id="${plotId}_line" x1="0" y1="${margin.top}" x2="0" y2="${margin.top + plotHeight}" stroke="${muted}" stroke-width="1" stroke-dasharray="4,4"/>`;
    for (let si = 0; si < this.series.length; si++) {
      svg += `<circle id="${plotId}_dot_${si}" r="4" fill="${this.series[si].color}" stroke="${surface}" stroke-width="2" style="display:none;"/>`;
    }
    svg += `<rect id="${plotId}_tooltip_bg" x="0" y="0" rx="5" ry="5" fill="${surface}" stroke="${axis}" stroke-width="1" opacity="0.97"/>`;
    svg += `<text id="${plotId}_tooltip_text" x="0" y="0" font-size="11" fill="${ink}" style="font-variant-numeric:tabular-nums;"></text>`;
    svg += `</g>`;
    svg += `<rect id="${plotId}_overlay" x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}" fill="transparent" style="cursor:crosshair;"/>`;
    svg += '</svg>';

    this.lastPlotData = {
      plotId, margin, plotWidth, plotHeight,
      xmin, xmax, ymin, ymax,
      series: this.series,
      hoverMode: this.hoverMode,
      hidden: new Set(),
    };
    return svg;
  }

  /**
   * Setup interactivity for a plot after it's been inserted into the DOM:
   * crosshair + tooltip + nearest-point dots, and click-to-toggle legend.
   * Call after setting plotDiv.innerHTML = svg.
   * @param {Object} plotData - Plot data from plotter.lastPlotData
   */
  static setupInteractivity(plotData) {
    const { plotId, margin, plotWidth, plotHeight, xmin, xmax, ymin, ymax, series } = plotData;
    const hidden = plotData.hidden || (plotData.hidden = new Set());

    const svg = document.getElementById(plotId);
    if (!svg) { console.error('SVG not found:', plotId); return; }
    const crosshair = document.getElementById(plotId + '_crosshair');
    const line = document.getElementById(plotId + '_line');
    const tooltipBg = document.getElementById(plotId + '_tooltip_bg');
    const tooltipText = document.getElementById(plotId + '_tooltip_text');
    const overlay = document.getElementById(plotId + '_overlay');
    if (!crosshair || !overlay) { console.error('Crosshair or overlay elements not found'); return; }

    // Legend toggling
    for (let si = 0; si < series.length; si++) {
      const leg = document.getElementById(`${plotId}_leg_${si}`);
      if (!leg) continue;
      leg.addEventListener('click', () => {
        const g = document.getElementById(`${plotId}_s_${si}`);
        if (hidden.has(si)) {
          hidden.delete(si);
          if (g) g.style.display = '';
          leg.style.opacity = '';
        } else {
          hidden.add(si);
          if (g) g.style.display = 'none';
          leg.style.opacity = '0.35';
          const dot = document.getElementById(`${plotId}_dot_${si}`);
          if (dot) dot.style.display = 'none';
        }
      });
    }

    function lerp(x, x0, y0, x1, y1) {
      if (x1 === x0) return y0;
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
    function getYAtX(s, xval) {
      if (xval <= s.x[0]) return s.y[0];
      const n = s.x.length;
      if (xval >= s.x[n - 1]) return s.y[n - 1];
      // binary search: x is monotonic in crosshair mode
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (s.x[mid] <= xval) lo = mid; else hi = mid;
      }
      return lerp(xval, s.x[lo], s.y[lo], s.x[hi], s.y[hi]);
    }

    // Convert client coords to viewBox coords (SVG may be scaled by CSS)
    function toLocal(e) {
      const rect = svg.getBoundingClientRect();
      const vb = svg.viewBox && svg.viewBox.baseVal;
      const w = vb && vb.width ? vb.width : rect.width;
      const h = vb && vb.height ? vb.height : rect.height;
      return {
        x: (e.clientX - rect.left) * (w / rect.width),
        y: (e.clientY - rect.top) * (h / rect.height),
      };
    }

    const sx = (x) => margin.left + ((x - xmin) / (xmax - xmin)) * plotWidth;
    const sy = (y) => margin.top + plotHeight - ((y - ymin) / (ymax - ymin)) * plotHeight;

    overlay.addEventListener('mousemove', function (e) {
      const pos = toLocal(e);
      crosshair.style.display = 'block';

      let tooltipLines = [];
      const dotPos = [];

      if (plotData.hoverMode === 'point') {
        // Nearest sample across all visible series (phase portraits)
        line.style.display = 'none';
        let best = null;
        for (let si = 0; si < series.length; si++) {
          if (hidden.has(si)) continue;
          const s = series[si];
          for (let i = 0; i < s.x.length; i++) {
            const dx = sx(s.x[i]) - pos.x, dy = sy(s.y[i]) - pos.y;
            const d2 = dx * dx + dy * dy;
            if (!best || d2 < best.d2) best = { d2, si, i };
          }
        }
        if (!best) return;
        const s = series[best.si];
        tooltipLines.push((s.label ? s.label + '  ' : '') + '#' + best.i);
        tooltipLines.push('x: ' + fmtNum(s.x[best.i]));
        tooltipLines.push('y: ' + fmtNum(s.y[best.i]));
        dotPos.push({ si: best.si, px: sx(s.x[best.i]), py: sy(s.y[best.i]) });
      } else {
        line.style.display = '';
        const dataX = xmin + (pos.x - margin.left) / plotWidth * (xmax - xmin);
        line.setAttribute('x1', pos.x);
        line.setAttribute('x2', pos.x);
        tooltipLines.push('t = ' + fmtNum(dataX));
        for (let si = 0; si < series.length; si++) {
          if (hidden.has(si)) continue;
          const s = series[si];
          const yval = getYAtX(s, dataX);
          tooltipLines.push((s.label || 'y') + ': ' + fmtNum(yval));
          dotPos.push({ si, px: pos.x, py: sy(yval) });
        }
      }

      for (let si = 0; si < series.length; si++) {
        const dot = document.getElementById(`${plotId}_dot_${si}`);
        if (!dot) continue;
        const p = dotPos.find(d => d.si === si);
        if (p) {
          dot.style.display = '';
          dot.setAttribute('cx', p.px);
          dot.setAttribute('cy', p.py);
        } else {
          dot.style.display = 'none';
        }
      }

      const pad = 8, lineHeight = 14;
      const tooltipWidth = Math.max(...tooltipLines.map(l => l.length)) * 6.6 + pad * 2;
      const tooltipHeight = tooltipLines.length * lineHeight + pad * 2;
      let tx = pos.x + 12, ty = Math.max(margin.top + 4, pos.y - tooltipHeight - 8);
      if (tx + tooltipWidth > margin.left + plotWidth) tx = pos.x - tooltipWidth - 12;
      if (ty + tooltipHeight > margin.top + plotHeight) ty = margin.top + plotHeight - tooltipHeight;

      tooltipBg.setAttribute('x', tx);
      tooltipBg.setAttribute('y', ty);
      tooltipBg.setAttribute('width', tooltipWidth);
      tooltipBg.setAttribute('height', tooltipHeight);
      tooltipText.innerHTML = '';
      for (let i = 0; i < tooltipLines.length; i++) {
        const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
        tspan.textContent = tooltipLines[i];
        tspan.setAttribute('x', tx + pad);
        tspan.setAttribute('y', ty + pad + 11 + i * lineHeight);
        if (i === 0) tspan.setAttribute('font-weight', 'bold');
        tooltipText.appendChild(tspan);
      }
    });

    overlay.addEventListener('mouseleave', function () {
      crosshair.style.display = 'none';
      for (let si = 0; si < series.length; si++) {
        const dot = document.getElementById(`${plotId}_dot_${si}`);
        if (dot) dot.style.display = 'none';
      }
    });
  }

  /**
   * Plot solution from ODE solver
   */
  static plotSolution(sol, variables = null, options = {}) {
    const plotter = new SVGPlotter(options.width, options.height, options);

    if (options.title) plotter.setTitle(options.title);
    if (options.xlabel) plotter.setXLabel(options.xlabel);
    if (options.ylabel) plotter.setYLabel(options.ylabel);

    // Determine which variables to plot
    const varsToPlot = variables || sol.stateLabels;

    for (const varName of varsToPlot) {
      const y = sol.getVariable(varName);
      plotter.addSeries(sol.t, y, varName);
    }

    const svg = plotter.render();

    // Return both SVG and plot data for interactivity
    return {
      svg: svg,
      plotData: plotter.lastPlotData,
      setupInteractivity: () => SVGPlotter.setupInteractivity(plotter.lastPlotData)
    };
  }
}

// ============================================================================
// Exports
// ============================================================================

export default {
  Place,
  Transition,
  Arc,
  PetriNet,
  fromJSON,
  setState,
  setRates,
  ODEProblem,
  ODESolution,
  Tsit5,
  solve,
  SVGPlotter
};
