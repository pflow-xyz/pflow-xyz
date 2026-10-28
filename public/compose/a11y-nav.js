// Moving between things with the arrow keys. Pure: items are {x, y} centres (the
// DOM glue measures them), and each function returns an index.

/**
 * The item to move to from `from` when an arrow key is pressed: the nearest in
 * that direction, preferring items that lie straight ahead (a sideways offset
 * costs double). Returns -1 when nothing lies that way.
 */
export function moveSpatial(items, from, key) {
  const a = items[from];
  if (!a) return -1;
  const eps = 1;
  let best = -1, bs = Infinity;
  for (let i = 0; i < items.length; i++) {
    if (i === from) continue;
    const dx = items[i].x - a.x, dy = items[i].y - a.y;
    let main, side;
    if (key === 'ArrowRight') { main = dx; side = Math.abs(dy); }
    else if (key === 'ArrowLeft') { main = -dx; side = Math.abs(dy); }
    else if (key === 'ArrowDown') { main = dy; side = Math.abs(dx); }
    else if (key === 'ArrowUp') { main = -dy; side = Math.abs(dx); }
    else return -1;
    if (main <= eps) continue;
    const score = main + 2 * side;
    if (score < bs) { bs = score; best = i; }
  }
  return best;
}

/**
 * The index a roving group moves to on `key` (arrows by position when `items`
 * carry centres, Home/End by order). -1: the key does not move the group.
 */
export function rovingTarget(items, from, key) {
  if (!items.length) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return items.length - 1;
  if (from < 0) return /^Arrow/.test(key) ? 0 : -1;
  return moveSpatial(items, from, key);
}

/** The next tab of a tablist (wrapping) on Arrow/Home/End; -1 for any other key. */
export function tabTarget(n, from, key) {
  if (!n) return -1;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (from + 1) % n;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (from - 1 + n) % n;
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return -1;
}

/** Which of a group's keys is the Tab stop: the remembered one if it is still there, else the first. */
export function tabStop(keys, remembered) {
  if (!keys.length) return -1;
  const i = remembered == null ? -1 : keys.indexOf(remembered);
  return i < 0 ? 0 : i;
}
