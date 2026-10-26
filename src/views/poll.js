import { watchEvent, watchReactions, addReaction, deleteReaction, addPhotoDoc, PHOTO_RETENTION_DAYS } from '../data.js';
import { esc, $, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { formatDay, countRoles } from '../lib/time.js';
import { shrink, FULL, THUMB, uploadVariant, deletePhotoFiles } from '../lib/photos.js';
import { REACTIONS, MAX_COUNT, clampCount, tally, percent } from '../lib/poll.js';

const ICON = { up: 'thumbsUp', mid: 'thumbsSide', down: 'thumbsDown' };
const newPhotoId = () => crypto.randomUUID().replace(/-/g, '');
const HOLD_MS = 1500;
const THANKS_MS = 1200;

export function pollView(root, ctx, eventId) {
  let event = null;
  let reactions = [];
  let draft = null; // photo entry being filled in: { id, url, width, height, counts }
  let busy = false;
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
      <div class="poll-start">
        <label class="btn primary block" id="photoBtn">${icon('camera')} Photo of thumbs
          <input type="file" id="file" accept="image/*" capture="environment" hidden />
        </label>
        <button type="button" class="btn block" id="tapBtn">${icon('thumbsUp')} Tap mode (hand over the phone)</button>
      </div>
      <p class="muted" id="status" aria-live="polite"></p>
    </section>
    <section class="card" id="draft" hidden></section>
    <section class="card" id="results"></section>
    <div id="tap" class="tapmode" hidden></div>`;

  const tapEl = $('#tap', root);

  function renderHeader() {
    $('#sub', root).textContent = event ? `${event.name} · ${formatDay(event.date)}` : '';
  }

  function renderResults() {
    const t = tally(reactions);
    const rows = [...reactions].sort((a, b) => (a.createdAt?.toMillis?.() ?? Infinity) - (b.createdAt?.toMillis?.() ?? Infinity));
    const taps = rows.filter((r) => r.source === 'tap');
    const photos = rows.filter((r) => r.source !== 'tap');
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
          ${photos
            .map(
              (r, i) => `<li><span>${icon('camera')} Photo ${i + 1}: ${r.up} / ${r.mid} / ${r.down}</span>
                <button type="button" class="ibadge del" data-del="${esc(r.id)}" aria-label="Delete this entry" title="Delete">${icon('trash')}</button></li>`,
            )
            .join('')}
        </ul>`
      : `<div class="empty">${icon('chart', 'lg')}<p>No reactions yet.</p></div>`;
  }

  /** How many more responses fit: participants on the roll minus responses so far; Infinity when the roll is empty. */
  function remaining() {
    const cap = event ? countRoles(event.attendees).participants : 0;
    return cap > 0 ? Math.max(0, cap - tally(reactions).total) : Infinity;
  }

  /* ----- photo flow ----- */

  function renderDraft() {
    const el = $('#draft', root);
    el.hidden = !draft;
    $('#start', root).hidden = !!draft;
    if (!draft) return;
    el.innerHTML = `
      <img class="poll-photo" src="${draft.url}" alt="Photo of thumbs" />
      <p class="muted">Count the thumbs you see in the photo. The photo is kept with the event for ${PHOTO_RETENTION_DAYS} days.</p>
      ${REACTIONS.map(
        (r) => `<div class="stepper">
          <span class="poll-ic">${icon(ICON[r.key])}</span><span class="grow">${esc(r.label)}</span>
          <button type="button" class="btn small" data-step="${r.key}" data-d="-1" aria-label="Fewer ${esc(r.label)}">${icon('minus')}</button>
          <b id="n-${r.key}">${draft.counts[r.key]}</b>
          <button type="button" class="btn small" data-step="${r.key}" data-d="1" aria-label="More ${esc(r.label)}">${icon('plus')}</button>
        </div>`,
      ).join('')}
      <div class="actions">
        <button type="button" class="btn primary" id="saveDraft">${icon('check')} Save</button>
        <button type="button" class="btn ghost" id="cancelDraft">Cancel</button>
      </div>`;
  }

  async function startPhoto(file) {
    if (!file || busy) return;
    if (!navigator.onLine) return toast('You are offline. Connect to upload the photo, or use tap mode.');
    busy = true;
    const status = $('#status', root);
    status.textContent = 'Uploading photo…';
    try {
      const id = newPhotoId();
      const full = await shrink(file, FULL);
      const thumb = await shrink(file, THUMB);
      await uploadVariant(eventId, id, 'full', full.blob);
      await uploadVariant(eventId, id, 'thumb', thumb.blob);
      draft = { id, url: URL.createObjectURL(full.blob), width: full.width, height: full.height, counts: { up: 0, mid: 0, down: 0 } };
      status.textContent = '';
      renderDraft();
    } catch (e) {
      console.error('poll photo failed', e);
      status.textContent = '';
      toast('Could not upload the photo. Try again.');
    }
    busy = false;
  }

  async function discardDraft() {
    const d = draft;
    draft = null;
    renderDraft();
    if (!d) return;
    URL.revokeObjectURL(d.url);
    deletePhotoFiles(eventId, d.id).catch(() => {});
  }

  async function saveDraft() {
    const d = draft;
    if (!d || busy) return;
    busy = true;
    try {
      await addPhotoDoc(eventId, d.id, { uploadedBy: ctx.user.uid, uploadedByName: ctx.name || '', width: d.width, height: d.height });
      addReaction(eventId, d.counts, 'photo', ctx.user.uid, d.id).done.catch(() => toast('Could not save the counts.'));
      draft = null;
      URL.revokeObjectURL(d.url);
      renderDraft();
      toast('Saved');
    } catch {
      toast('Could not save. Try again.');
    }
    busy = false;
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

  $('#file', root).onchange = (ev) => {
    const f = ev.target.files[0];
    ev.target.value = '';
    startPhoto(f);
  };
  $('#tapBtn', root).onclick = enterTapMode;
  $('#draft', root).onclick = (ev) => {
    const s = ev.target.closest('[data-step]');
    if (s && draft) {
      const k = s.dataset.step;
      const d = Number(s.dataset.d);
      const used = REACTIONS.reduce((n, r) => n + draft.counts[r.key], 0);
      if (d > 0 && used >= remaining()) return toast('That is everyone on the roll.');
      draft.counts[k] = clampCount(Math.min(MAX_COUNT, draft.counts[k] + d));
      $(`#n-${k}`, root).textContent = draft.counts[k];
    } else if (ev.target.closest('#saveDraft')) saveDraft();
    else if (ev.target.closest('#cancelDraft')) discardDraft();
  };
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
    if (draft) {
      URL.revokeObjectURL(draft.url);
      deletePhotoFiles(eventId, draft.id).catch(() => {});
    }
  };
}
