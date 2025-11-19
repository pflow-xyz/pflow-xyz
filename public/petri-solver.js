/**
 * psolver.js - ES Module for ODE Solving with Petri Nets
 * 
 * Provides ODE solver functionality for Petri net simulation
 * Compatible with JSON-LD schema from pflow.xyz
 * Implements Tsit5 (5th order Runge-Kutta) solver
 */

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
 * Set initial state from Petri net
 */
export function setState(net, customState = null) {
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
 */
export function setRates(net, customRates = null) {
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
  constructor(net, initialState, tspan, rates) {
    this.net = net;
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
  constructor(t, u, stateLabels) {
    this.t = t;
    this.u = u;  // Array of state objects
    this.stateLabels = stateLabels;
  }

  /**
   * Get values for a specific state variable
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
    return this.u.map(state => state[label]);
  }

  /**
   * Get final state
   */
  getFinalState() {
    return this.u[this.u.length - 1];
  }

  /**
   * Get state at specific index
   */
  getState(index) {
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

  return new ODESolution(t, u, stateLabels);
}

// ============================================================================
// Plotting Functionality
// ============================================================================

/**
 * Simple SVG plotter
 */
export class SVGPlotter {
  constructor(width = 600, height = 400) {
    this.width = width;
    this.height = height;
    this.margin = { top: 40, right: 30, bottom: 50, left: 60 };
    this.plotWidth = width - this.margin.left - this.margin.right;
    this.plotHeight = height - this.margin.top - this.margin.bottom;
    this.title = "";
    this.xlabel = "Time";
    this.ylabel = "Value";
    this.series = [];
  }

  setTitle(title) {
    this.title = title;
    return this;
  }

  setXLabel(label) {
    this.xlabel = label;
    return this;
  }

  setYLabel(label) {
    this.ylabel = label;
    return this;
  }

  addSeries(x, y, label = "", color = null) {
    if (!color) {
      const colors = ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#ffff33', '#a65628', '#f781bf'];
      color = colors[this.series.length % colors.length];
    }
    this.series.push({ x, y, label, color });
    return this;
  }

  render() {
    // Compute data ranges
    let xmin = Infinity, xmax = -Infinity;
    let ymin = Infinity, ymax = -Infinity;

    for (const s of this.series) {
      for (let i = 0; i < s.x.length; i++) {
        xmin = Math.min(xmin, s.x[i]);
        xmax = Math.max(xmax, s.x[i]);
        ymin = Math.min(ymin, s.y[i]);
        ymax = Math.max(ymax, s.y[i]);
      }
    }

    // Add padding
    const xrange = xmax - xmin || 1;
    const yrange = ymax - ymin || 1;
    xmin -= xrange * 0.05;
    xmax += xrange * 0.05;
    ymin -= yrange * 0.1;
    ymax += yrange * 0.1;

    // Scale functions
    const sx = (x) => this.margin.left + ((x - xmin) / (xmax - xmin)) * this.plotWidth;
    const sy = (y) => this.margin.top + this.plotHeight - ((y - ymin) / (ymax - ymin)) * this.plotHeight;

    // Generate unique ID for this plot
    const plotId = 'plot_' + Math.random().toString(36).substr(2, 9);

    // Build SVG
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" style="background: white;" id="${plotId}">`;
    
    // Title
    if (this.title) {
      svg += `<text x="${this.width / 2}" y="25" text-anchor="middle" font-family="Arial, sans-serif" font-size="16" font-weight="bold">${this.title}</text>`;
    }

    // Axes
    svg += `<line x1="${this.margin.left}" y1="${this.margin.top}" x2="${this.margin.left}" y2="${this.margin.top + this.plotHeight}" stroke="#333" stroke-width="2"/>`;
    svg += `<line x1="${this.margin.left}" y1="${this.margin.top + this.plotHeight}" x2="${this.margin.left + this.plotWidth}" y2="${this.margin.top + this.plotHeight}" stroke="#333" stroke-width="2"/>`;

    // X-axis label
    svg += `<text x="${this.margin.left + this.plotWidth / 2}" y="${this.height - 10}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12">${this.xlabel}</text>`;

    // Y-axis label
    svg += `<text x="15" y="${this.margin.top + this.plotHeight / 2}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" transform="rotate(-90, 15, ${this.margin.top + this.plotHeight / 2})">${this.ylabel}</text>`;

    // Grid lines and ticks
    const numXTicks = 5;
    const numYTicks = 5;

    for (let i = 0; i <= numXTicks; i++) {
      const x = xmin + (xmax - xmin) * i / numXTicks;
      const px = sx(x);
      svg += `<line x1="${px}" y1="${this.margin.top + this.plotHeight}" x2="${px}" y2="${this.margin.top + this.plotHeight + 5}" stroke="#333" stroke-width="1"/>`;
      svg += `<text x="${px}" y="${this.margin.top + this.plotHeight + 20}" text-anchor="middle" font-family="Arial, sans-serif" font-size="10">${x.toFixed(1)}</text>`;
      svg += `<line x1="${px}" y1="${this.margin.top}" x2="${px}" y2="${this.margin.top + this.plotHeight}" stroke="#ddd" stroke-width="0.5"/>`;
    }

    for (let i = 0; i <= numYTicks; i++) {
      const y = ymin + (ymax - ymin) * i / numYTicks;
      const py = sy(y);
      svg += `<line x1="${this.margin.left - 5}" y1="${py}" x2="${this.margin.left}" y2="${py}" stroke="#333" stroke-width="1"/>`;
      svg += `<text x="${this.margin.left - 10}" y="${py + 4}" text-anchor="end" font-family="Arial, sans-serif" font-size="10">${y.toFixed(1)}</text>`;
      svg += `<line x1="${this.margin.left}" y1="${py}" x2="${this.margin.left + this.plotWidth}" y2="${py}" stroke="#ddd" stroke-width="0.5"/>`;
    }

    // Plot series
    for (const s of this.series) {
      let path = 'M';
      for (let i = 0; i < s.x.length; i++) {
        const px = sx(s.x[i]);
        const py = sy(s.y[i]);
        if (i === 0) {
          path += `${px},${py}`;
        } else {
          path += ` L${px},${py}`;
        }
      }
      svg += `<path d="${path}" stroke="${s.color}" stroke-width="2" fill="none"/>`;
    }

    // Legend
    if (this.series.some(s => s.label)) {
      let legendY = this.margin.top + 10;
      for (const s of this.series) {
        if (s.label) {
          svg += `<line x1="${this.width - this.margin.right - 50}" y1="${legendY}" x2="${this.width - this.margin.right - 30}" y2="${legendY}" stroke="${s.color}" stroke-width="2"/>`;
          svg += `<text x="${this.width - this.margin.right - 25}" y="${legendY + 4}" font-family="Arial, sans-serif" font-size="10">${s.label}</text>`;
          legendY += 20;
        }
      }
    }

    // Interactive crosshair elements
    svg += `<g id="${plotId}_crosshair" style="display: none;">`;
    svg += `<line id="${plotId}_line" x1="0" y1="${this.margin.top}" x2="0" y2="${this.margin.top + this.plotHeight}" stroke="#666" stroke-width="1" stroke-dasharray="4,4"/>`;
    svg += `<rect id="${plotId}_tooltip_bg" x="0" y="0" rx="4" ry="4" fill="white" stroke="#666" stroke-width="1" opacity="0.95"/>`;
    svg += `<text id="${plotId}_tooltip_text" x="0" y="0" font-family="Arial, sans-serif" font-size="11" fill="#333"></text>`;
    svg += `</g>`;
    
    // Transparent overlay for mouse events
    svg += `<rect id="${plotId}_overlay" x="${this.margin.left}" y="${this.margin.top}" width="${this.plotWidth}" height="${this.plotHeight}" fill="transparent" style="cursor: crosshair;"/>`;

    svg += '</svg>';

    // Store plot data for later initialization
    this.lastPlotData = {
      plotId: plotId,
      margin: this.margin,
      plotWidth: this.plotWidth,
      plotHeight: this.plotHeight,
      xmin: xmin,
      xmax: xmax,
      ymin: ymin,
      ymax: ymax,
      series: this.series
    };

    return svg;
  }

  /**
   * Setup interactivity for a plot after it's been inserted into the DOM
   * Call this method after setting plotDiv.innerHTML = svg
   * @param {Object} plotData - Plot data from plotter.lastPlotData
   */
  static setupInteractivity(plotData) {
    const { plotId, margin, plotWidth, plotHeight, xmin, xmax, ymin, ymax, series } = plotData;
    
    const svg = document.getElementById(plotId);
    if (!svg) {
      console.error('SVG not found:', plotId);
      return;
    }
    
    const crosshair = document.getElementById(plotId + '_crosshair');
    const line = document.getElementById(plotId + '_line');
    const tooltipBg = document.getElementById(plotId + '_tooltip_bg');
    const tooltipText = document.getElementById(plotId + '_tooltip_text');
    const overlay = document.getElementById(plotId + '_overlay');
    
    if (!crosshair || !overlay) {
      console.error('Crosshair or overlay elements not found');
      return;
    }
    
    function lerp(x, x0, y0, x1, y1) {
      if (x1 === x0) return y0;
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
    
    function getYAtX(s, xval) {
      if (xval <= s.x[0]) return s.y[0];
      if (xval >= s.x[s.x.length - 1]) return s.y[s.y.length - 1];
      
      for (let i = 0; i < s.x.length - 1; i++) {
        if (xval >= s.x[i] && xval <= s.x[i + 1]) {
          return lerp(xval, s.x[i], s.y[i], s.x[i + 1], s.y[i + 1]);
        }
      }
      return s.y[s.y.length - 1];
    }
    
    overlay.addEventListener('mousemove', function(e) {
      const rect = svg.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      crosshair.style.display = 'block';
      line.setAttribute('x1', mouseX);
      line.setAttribute('x2', mouseX);
      
      const dataX = xmin + (mouseX - margin.left) / plotWidth * (xmax - xmin);
      
      let tooltipLines = ['T = ' + dataX.toFixed(3)];
      for (const s of series) {
        const yval = getYAtX(s, dataX);
        tooltipLines.push(s.label + ': ' + yval.toFixed(3));
      }
      
      const tooltipPadding = 8;
      const lineHeight = 14;
      const tooltipWidth = 120;
      const tooltipHeight = tooltipLines.length * lineHeight + tooltipPadding * 2;
      
      let tooltipX = mouseX + 10;
      let tooltipY = margin.top + 10;
      
      if (tooltipX + tooltipWidth > margin.left + plotWidth) {
        tooltipX = mouseX - tooltipWidth - 10;
      }
      
      tooltipBg.setAttribute('x', tooltipX);
      tooltipBg.setAttribute('y', tooltipY);
      tooltipBg.setAttribute('width', tooltipWidth);
      tooltipBg.setAttribute('height', tooltipHeight);
      
      tooltipText.setAttribute('x', tooltipX + tooltipPadding);
      tooltipText.setAttribute('y', tooltipY + tooltipPadding + 12);
      
      tooltipText.innerHTML = '';
      for (let i = 0; i < tooltipLines.length; i++) {
        const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
        tspan.textContent = tooltipLines[i];
        tspan.setAttribute('x', tooltipX + tooltipPadding);
        tspan.setAttribute('dy', i === 0 ? '0' : '1.2em');
        if (i === 0) {
          tspan.setAttribute('font-weight', 'bold');
        }
        tooltipText.appendChild(tspan);
      }
    });
    
    overlay.addEventListener('mouseleave', function() {
      crosshair.style.display = 'none';
    });
  }

  /**
   * Plot solution from ODE solver
   */
  static plotSolution(sol, variables = null, options = {}) {
    const plotter = new SVGPlotter(options.width, options.height);
    
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
