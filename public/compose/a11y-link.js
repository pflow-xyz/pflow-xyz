// The keyboard way to link: a state machine from the registry's verdicts and key
// presses to the next state, what to say, and what the page should do. Pure: no
// DOM, no registry. snap.js feeds it the targets of bundle.candidates (or
// plan.slot_candidates) through verdicts.js and carries out its effects; the
// legality of every target is the registry's, decided before the machine runs.
//
// A target is {key, label, ok, kind, reason}: ok targets are the "lit" ones.
//
//   begin({noun, originKey, originLabel, targets}) -> {state, announce, effects}
//                                                     (state.phase is 'ended' when no target is drawn)
//   press(state, {key, shiftKey, ...})              -> {state, announce, effects, handled}
//
// effects: {type: 'focus', key}   move focus to that target (and draw the band to it)
//          {type: 'commit', key}  make the link / drop the piece (the page asks the registry)
//          {type: 'end', focus}   leave link mode; return focus to `focus` (the origin)
//
// Keys, in link mode (documented in ACCESSIBILITY.md):
//   Tab, Shift+Tab, Arrow keys   the next / previous LIT target (wrapping)
//   Home, End                    the first / last lit target
//   r, Shift+R                   the next / previous REFUSED target: it says why
//   Enter, Space                 link to the focused lit target (a refused one explains itself again)
//   ?                            say the instructions again
//   Escape                       cancel and return to the origin

const NEXT = new Set(['Tab', 'ArrowRight', 'ArrowDown']);
const PREV = new Set(['ArrowLeft', 'ArrowUp']);

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** What is said on entering link mode. */
export function beginText(s) {
  const n = s.legal.length, m = s.refused.length;
  const head = `Linking from ${s.originLabel}. ${n ? `${plural(n, `legal ${s.noun}`)} lit${m ? `, ${m} refused` : ''}.` : `No legal ${s.noun}: the rules refuse ${m ? (m === 1 ? 'the only one' : `all ${m}`) : 'every one'}.`}`;
  const keys = [
    n ? 'Arrow keys or Tab choose a target, Enter links' : null,
    m ? `${n ? 'R' : 'Press R'} says why a refused ${s.noun} is refused` : null,
    'Escape cancels',
  ].filter(Boolean).join('; ');
  return `${head} ${keys}.`;
}

/** What is said when a target takes focus. */
export function targetText(s, key) {
  const t = s.byKey[key];
  if (!t) return '';
  if (t.ok) {
    const i = s.legal.indexOf(key) + 1;
    return `${t.label}: legal${t.kind ? `, ${t.kind} link` : ''}. ${t.reason}. Target ${i} of ${s.legal.length}. Press Enter to link.`;
  }
  const j = s.refused.indexOf(key) + 1;
  return `${t.label}: refused. ${t.reason}. Refused ${s.noun} ${j} of ${s.refused.length}.`;
}

/**
 * What is said when a view draws nothing to link to (the Flat net draws palette pieces and no slots):
 * the registry may well accept the piece somewhere, the view just does not show it, so "the rules
 * refuse every slot" would be false.
 */
export function noTargetsText(noun, originLabel) {
  return `${originLabel}: this view draws no ${noun === 'port' ? 'other ports' : `${noun}s`} to link to, so there is nothing to light. Another view may draw them.`;
}

/**
 * Enter link mode. With no target drawn at all there is no mode to enter: the state is already
 * 'ended' and the announcement says why, so the page lights nothing.
 */
export function begin({ noun = 'port', originKey, originLabel, targets }) {
  if (!targets.length) {
    return { state: { phase: 'ended', noun, originKey, originLabel, byKey: {}, legal: [], refused: [], at: null }, announce: noTargetsText(noun, originLabel), effects: [] };
  }
  const byKey = Object.fromEntries(targets.map((t) => [t.key, t]));
  const state = {
    phase: 'linking',
    noun,
    originKey,
    originLabel,
    byKey,
    legal: targets.filter((t) => t.ok).map((t) => t.key),
    refused: targets.filter((t) => !t.ok).map((t) => t.key),
    at: null, // the key of the focused target; null = still on the origin
  };
  return { state, announce: beginText(state), effects: [] };
}

function stepIn(list, at, dir) {
  if (!list.length) return null;
  const i = list.indexOf(at);
  if (i < 0) return dir > 0 ? list[0] : list[list.length - 1];
  return list[(i + dir + list.length) % list.length];
}

const goto = (state, key) => ({
  state: { ...state, at: key },
  announce: targetText(state, key),
  effects: [{ type: 'focus', key }],
  handled: true,
});

/** One key press in link mode. `handled` false: the page may treat the key as it would anyway. */
export function press(state, ev) {
  if (state.phase !== 'linking') return { state, announce: '', effects: [], handled: false };
  const { key, shiftKey = false } = ev;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return { state, announce: '', effects: [], handled: false };

  if (key === 'Escape') {
    return { state: { ...state, phase: 'ended' }, announce: 'Linking cancelled.', effects: [{ type: 'end', focus: state.originKey }], handled: true };
  }

  const forward = NEXT.has(key) && !(key === 'Tab' && shiftKey);
  const backward = PREV.has(key) || (key === 'Tab' && shiftKey);
  if (forward || backward) {
    // Moving among the lit targets, but if the walk is on a refused one, start from the lit end.
    const dir = forward ? 1 : -1;
    const from = state.legal.includes(state.at) ? state.at : null;
    const to = stepIn(state.legal, from, dir);
    if (to === null) {
      return { state, announce: `No legal ${state.noun}. ${state.refused.length ? `Press R to hear why each is refused. ` : ''}Escape cancels.`, effects: [], handled: true };
    }
    return goto(state, to);
  }

  if (key === 'Home' || key === 'End') {
    const to = state.legal.length ? (key === 'Home' ? state.legal[0] : state.legal[state.legal.length - 1]) : null;
    if (to === null) return { state, announce: `No legal ${state.noun}.`, effects: [], handled: true };
    return goto(state, to);
  }

  if (key === 'r' || key === 'R') {
    const dir = key === 'R' || shiftKey ? -1 : 1;
    const from = state.refused.includes(state.at) ? state.at : null;
    const to = stepIn(state.refused, from, dir);
    if (to === null) return { state, announce: `Every ${state.noun} is legal: nothing is refused.`, effects: [], handled: true };
    return goto(state, to);
  }

  if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
    const t = state.at === null ? null : state.byKey[state.at];
    if (!t) {
      return { state, announce: state.legal.length ? `Choose a target first: arrow keys or Tab. ${plural(state.legal.length, `legal ${state.noun}`)}.` : `No legal ${state.noun} to link to. Escape cancels.`, effects: [], handled: true };
    }
    if (!t.ok) {
      return { state, announce: `Cannot link to ${t.label}: ${t.reason}.`, effects: [], handled: true };
    }
    return { state: { ...state, phase: 'ended' }, announce: '', effects: [{ type: 'commit', key: t.key }, { type: 'end', focus: state.originKey }], handled: true };
  }

  if (key === '?') return { state, announce: beginText(state), effects: [], handled: true };

  return { state, announce: '', effects: [], handled: false };
}

/**
 * Run `f` once no gesture is going on: at once, or when the drag or keyboard link mode has ended. A redraw cancels
 * both (the elements they hold are replaced), so a redraw nobody asked for (a view's background work finishing)
 * waits for the person to finish. `active()` says whether a gesture is on; the timer is injectable.
 * @param {() => boolean} active
 * @param {() => void} f
 * @param {(f: () => void, ms: number) => unknown} [setTimer]
 * @param {number} [pollMs]
 */
export function afterGesture(active, f, setTimer = (g, ms) => setTimeout(g, ms), pollMs = 150) {
  if (!active()) { f(); return; }
  setTimer(() => afterGesture(active, f, setTimer, pollMs), pollMs);
}
