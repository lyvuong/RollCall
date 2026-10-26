import { watchEvent, watchReactions, addReaction, deleteReaction } from '../data.js';
import { esc, $, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { formatDay, countRoles } from '../lib/time.js';
import { REACTIONS, tally, percent } from '../lib/poll.js';

const ICON = { up: 'thumbsUp', mid: 'thumbsSide', down: 'thumbsDown' };
const HOLD_MS = 1500;
const THANKS_MS = 1200;

export function pollView(root, ctx, eventId) {
  let event = null;
  let reactions = [];
  let tapMode = false;
  let wakeLock = null;
  let refreshTap = () => {}; // re-draws tap mode when the response count changes (e.g. another phone)
  const unsubs = [];

  root.innerHTML = `
    <section class="bar">
      <a class="btn ghost" href="#/event/${esc(eventId)}">${icon('back')} Event</a>
    </section>
    <h1 style="margin-bottom:4px">${icon('chart', 'lg')} Reactions poll</h1>
    <p id="sub" class="muted" style="margin-top:0"></p>
    <section class="card" id="start">
      <p class="muted">Anonymous: no names are kept. Count how attendees felt about the event.</p>
      <button type="button" class="btn primary block" id="tapBtn">${icon('thumbsUp')} Start tap mode (hand over the phone)</button>
    </section>
    <section class="card" id="results"></section>
    <div id="tap" class="tapmode" hidden></div>`;

  const tapEl = $('#tap', root);

  function renderHeader() {
    $('#sub', root).textContent = event ? `${event.name} · ${formatDay(event.date)}` : '';
  }

  function renderResults() {
    const t = tally(reactions);
    const taps = [...reactions].sort((a, b) => (a.createdAt?.toMillis?.() ?? Infinity) - (b.createdAt?.toMillis?.() ?? Infinity));
    const tapTotal = tally(taps);
    $('#results', root).innerHTML = t.total
      ? `<h2>Results · ${t.total} response${t.total === 1 ? '' : 's'}</h2>
        ${REACTIONS.map(
          (r) => `<div class="poll-row"><span class="poll-ic">${icon(ICON[r.key])}</span>
            <span class="poll-bar"><span style="width:${percent(t[r.key], t.total)}%"></span></span>
            <b>${t[r.key]}</b><span class="muted">${percent(t[r.key], t.total)}%</span></div>`,
        ).join('')}
        <h3 class="muted" style="margin:14px 0 6px">Entries</h3>
        <ul class="poll-list">
          ${
            taps.length
              ? `<li><span>${taps.length} tap${taps.length === 1 ? '' : 's'} (${tapTotal.up} / ${tapTotal.mid} / ${tapTotal.down})</span>
                  <button type="button" class="btn small danger" data-undo="${esc(taps[taps.length - 1].id)}">Undo last tap</button></li>`
              : ''
          }
        </ul>`
      : `<div class="empty">${icon('chart', 'lg')}<p>No reactions yet.</p></div>`;
  }

  /** How many more responses fit: participants on the roll minus responses so far; Infinity when the roll is empty. */
  function remaining() {
    const cap = event ? countRoles(event.attendees).participants : 0;
    return cap > 0 ? Math.max(0, cap - tally(reactions).total) : Infinity;
  }

  /* ----- tap mode ----- */

  async function keepAwake() {
    try {
      wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      wakeLock = null;
    }
  }

  function enterTapMode() {
    tapMode = true;
    let session = 0;
    let thanks = false;
    let holdTimer = null;
    tapEl.hidden = false;
    keepAwake();

    const render = () => {
      tapEl.innerHTML = thanks
        ? `<div class="tap-thanks">Thank you!</div>`
        : remaining() === 0
          ? `<button type="button" class="tap-exit" id="tapExit" aria-label="Hold to finish"></button>
            <div class="tap-thanks">Everyone has responded. Thank you!</div>`
          : `<button type="button" class="tap-exit" id="tapExit" aria-label="Hold to finish"></button>
          <h2 class="tap-q">How was today's event?</h2>
          <div class="tap-btns">
            ${REACTIONS.map((r) => `<button type="button" class="tap-btn ${r.key}" data-k="${r.key}" aria-label="${esc(r.label)}">${icon(ICON[r.key])}</button>`).join('')}
          </div>`;
    };

    const finish = () => {
      if (confirm(`Finish polling? ${session} response${session === 1 ? '' : 's'} this round.`)) leaveTapMode();
    };

    tapEl.onpointerdown = (ev) => {
      if (!ev.target.closest('#tapExit')) return;
      holdTimer = setTimeout(finish, HOLD_MS);
    };
    const cancelHold = () => clearTimeout(holdTimer);
    tapEl.onpointerup = tapEl.onpointercancel = tapEl.onpointerleave = cancelHold;
    tapEl.oncontextmenu = (ev) => ev.preventDefault();
    tapEl.onclick = (ev) => {
      const b = ev.target.closest('[data-k]');
      if (!b || thanks || remaining() === 0) return;
      // Fire and forget: works offline, the write syncs later.
      addReaction(eventId, { up: 0, mid: 0, down: 0, [b.dataset.k]: 1 }, 'tap', ctx.user.uid).done.catch(() => {});
      session++;
      thanks = true;
      render();
      setTimeout(() => {
        thanks = false;
        if (tapMode) render();
      }, THANKS_MS);
    };
    refreshTap = () => !thanks && render();
    render();
  }

  function leaveTapMode() {
    tapMode = false;
    refreshTap = () => {};
    tapEl.hidden = true;
    tapEl.innerHTML = '';
    wakeLock?.release?.().catch(() => {});
    wakeLock = null;
  }

  /* ----- wiring ----- */

  $('#tapBtn', root).onclick = enterTapMode;
  $('#results', root).onclick = (ev) => {
    const id = ev.target.closest('[data-del],[data-undo]');
    if (!id) return;
    const rid = id.dataset.del || id.dataset.undo;
    if (id.dataset.del && !confirm('Delete this entry? Its counts are removed from the results.')) return;
    deleteReaction(eventId, rid).catch(() => toast('Could not delete. Try again.'));
  };

  unsubs.push(
    watchEvent(eventId, (e) => {
      event = e;
      renderHeader();
    }),
    watchReactions(eventId, (rows) => {
      reactions = rows;
      renderResults();
      refreshTap();
    }),
  );
  renderResults();

  return () => {
    unsubs.forEach((u) => u());
    if (tapMode) leaveTapMode();
  };
}
