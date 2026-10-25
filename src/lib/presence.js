import { watchPresence, setPresence, clearPresence } from '../data.js';
import { esc } from './dom.js';

const BEAT_MS = 20_000; // how often an open page says it is still there
export const STALE_MS = 60_000; // someone who has not said so for this long is gone (closed laptop, lost signal)

/** Who is still around: not me, and seen within STALE_MS (a doc the server has not stamped yet is new). */
export function activeOthers(rows, myUid, now = Date.now()) {
  return rows
    .filter((r) => r.uid !== myUid && r.name && (!r.at || now - r.at.getTime() < STALE_MS))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Show who else has this event open, and announce that I do. host: element to render into.
 * where: 'participants' | 'details'. Returns a function that stops everything and takes my marker down.
 */
export function mountPresence(host, { eventId, uid, name, where }) {
  let rows = [];
  let beat;
  const render = () => {
    const others = activeOthers(rows, uid);
    host.innerHTML = others
      .map(
        (o) =>
          `<span class="pres" role="status" title="${esc(o.name)} has this event open. Changes you both make are saved separately; the last save of the same thing wins."><span class="dot" aria-hidden="true"></span>${esc(o.name)} is editing ${o.where === 'details' ? 'the details' : 'participants'}</span>`,
      )
      .join('');
  };
  const announce = () => {
    if (document.visibilityState === 'hidden') return; // a tab nobody is looking at is not editing
    setPresence(eventId, uid, name, where).catch(() => {});
  };
  const unwatch = watchPresence(eventId, (r) => ((rows = r), render()));
  const tick = setInterval(render, 15_000); // let departed people fade out
  announce();
  beat = setInterval(announce, BEAT_MS);
  const onVisible = () => document.visibilityState === 'visible' && announce();
  const leave = () => clearPresence(eventId, uid).catch(() => {});
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pagehide', leave);
  return () => {
    clearInterval(beat);
    clearInterval(tick);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pagehide', leave);
    unwatch();
    leave();
    host.innerHTML = '';
  };
}
