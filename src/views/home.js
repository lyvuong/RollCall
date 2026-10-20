import { watchEvents, watchLocations, watchAllPhotos, loadExisting, newId, commitOps } from '../data.js';
import { fetchNeonEvents, readNeonCache, fetchRegistrantsFor } from '../lib/neonApi.js';
import { neonOnlyEvents, planNeonEvents, neonSyncPlan } from '../lib/neon.js';
import { photoUrl } from '../lib/photos.js';
import { esc, $, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import {
  ymd,
  addDays,
  formatDay,
  formatTime,
  formatTimeShort,
  formatHours,
  eventHours,
  countRoles,
  personKind,
  roleOf,
  totalVolunteerHours,
  needsVolunteers,
} from '../lib/time.js';

const FORMAT = {
  virtual: { label: 'Virtual', icon: 'video', tip: 'Held online only' },
  'in-person': { label: 'In person', icon: 'building', tip: 'Held at a place, no online option' },
  both: { label: 'Hybrid', icon: 'globe', tip: 'People can join in person or online' },
};

const startOfWeek = (d) => addDays(d, -((new Date(d + 'T00:00').getDay() + 6) % 7));
export const PRESETS = [
  { key: 'default', label: 'Yesterday–tomorrow', get: (t) => ({ from: addDays(t, -1), to: addDays(t, 1) }) },
  { key: 'week', label: 'This week', get: (t) => ({ from: startOfWeek(t), to: addDays(startOfWeek(t), 6) }) },
  {
    key: 'month',
    label: 'This month',
    get: (t) => {
      const [y, m] = t.split('-').map(Number);
      return { from: `${y}-${String(m).padStart(2, '0')}-01`, to: ymd(new Date(y, m, 0)) };
    },
  },
  { key: '30', label: 'Last 30 days', get: (t) => ({ from: addDays(t, -30), to: t }) },
];

// Remembered across navigation within the session.
let range = null;
const open = new Set(); // expanded event cards
let filterOpen = false; // date-range card expanded?
let fixOnly = false; // only events that still need volunteers identified, across all dates
const ALL = { from: '2000-01-01', to: '2099-12-31' };
const defaultRange = () => PRESETS[0].get(ymd());

export function homeView(root, _ctx) {
  range ||= defaultRange();
  let events = [];
  let locations = {};
  let photosByEvent = new Map(); // eventId -> photo metadata[]
  let unsubEvents = () => {};
  let neonRaw = []; // last Neon result for the visible range (cached copy first, then fresh)
  let neonSeq = 0; // ignores answers for a range the user has already moved away from
  const checkinDiff = new Map(); // eventId -> {sig, n}: confirmed check-ins that differ from the OSG Website

  root.innerHTML = `
    <section class="bar">
      <h1>${icon('calendar', 'lg')} Events</h1>
      <span class="bar-actions">
        <a class="btn fab" id="report" href="#/report" aria-label="Report" title="Export events as CSV">${icon('download')}<span class="wide">Report</span></a>
        <a class="btn primary fab" href="#/event/new" aria-label="New event" title="New event">${icon('plus')}<span class="wide">New event</span></a>
      </span>
    </section>
    <section class="card filter" aria-label="Date range">
      <button type="button" class="ftoggle" id="fToggle" aria-expanded="false" aria-controls="fBody">
        ${icon('calendar')}<span id="fSum" class="fsum"></span><span class="fchev">${icon('chevron')}</span>
      </button>
      <div id="fBody" hidden>
      <div class="chips" id="chips"></div>
      <div class="chips"><button type="button" class="chip fix" id="fix" aria-pressed="false">${icon('alert')} <span id="fixLbl">Needs volunteers</span></button></div>
      <div class="dates">
        <label class="field"><span class="lbl">${icon('calendar')} From</span>
          <input type="date" id="from" class="input" /></label>
        <label class="field"><span class="lbl">${icon('calendar')} To</span>
          <input type="date" id="to" class="input" /></label>
      </div>
      </div>
    </section>
    <section id="list" aria-live="polite"></section>`;

  const from = $('#from', root);
  const to = $('#to', root);
  // Carry the visible range into the report page.
  $('#report', root).onclick = (ev) => {
    ev.preventDefault();
    location.hash = `#/report?from=${range.from}&to=${range.to}`;
  };

  const short = (d) => new Date(d + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  function setFilterOpen(on) {
    filterOpen = on;
    $('#fBody', root).hidden = !on;
    $('#fToggle', root).setAttribute('aria-expanded', String(on));
    $('#fToggle', root).classList.toggle('open', on);
  }

  function syncInputs() {
    from.value = range.from;
    to.value = range.to;
    const preset = PRESETS.find((p) => {
      const r = p.get(ymd());
      return r.from === range.from && r.to === range.to;
    });
    $('#fSum', root).textContent = fixOnly
      ? 'All dates · needs volunteers'
      : preset
        ? `${preset.label} · ${short(range.from)} – ${short(range.to)}`
        : `${short(range.from)} – ${short(range.to)}`;
    const today = ymd();
    $('#chips', root).innerHTML = PRESETS.map((p) => {
      const r = p.get(today);
      const on = r.from === range.from && r.to === range.to;
      return `<button type="button" class="chip" data-p="${p.key}" aria-pressed="${on}">${esc(p.label)}</button>`;
    }).join('');
  }

  function renderList() {
    const list = $('#list', root);
    const todo = events.filter(needsVolunteers).length;
    $('#fixLbl', root).textContent = `Needs volunteers${todo ? ` (${todo})` : ''}`;
    $('#fix', root).setAttribute('aria-pressed', String(fixOnly));
    // Nothing to fix in view: hide the chip (kept while the filter is on, so it can be switched off).
    $('#fix', root).parentElement.hidden = !todo && !fixOnly;
    const neon = fixOnly ? [] : neonOnlyEvents(neonRaw, events).map((n) => ({ ...n, fromNeon: true }));
    const merged = neon.length
      ? [...events, ...neon].sort((a, b) => a.date.localeCompare(b.date) || (a.startTime || '').localeCompare(b.startTime || ''))
      : events;
    if (!merged.length) {
      list.innerHTML = `
        <div class="card empty">${icon('calendar', 'lg')}
          <p>No events in this range.</p>
          <a class="btn primary" href="#/event/new">${icon('plus')} Create an event</a>
        </div>`;
      return;
    }
    const shown = fixOnly ? events.filter(needsVolunteers) : merged;
    if (!shown.length) {
      list.innerHTML = `<div class="card empty">${icon('check', 'lg')}<p>${
        fixOnly ? 'No events need volunteers identified.' : 'No events in this range.'
      }</p></div>`;
      return;
    }
    const days = new Map();
    for (const e of shown) {
      if (!days.has(e.date)) days.set(e.date, []);
      days.get(e.date).push(e);
    }
    const today = ymd();
    list.innerHTML = [...days]
      .map(
        ([date, items]) => `
        <h2 class="day ${date === today ? 'today' : ''}">${esc(formatDay(date))}</h2>
        ${items.map((e) => (e.fromNeon ? neonCard(e) : card(e))).join('')}`,
      )
      .join('');
    loadThumbs();
  }

  /** Fill the small photo previews of expanded cards (images need the auth header, so they load async). */
  function loadThumbs() {
    $('#list', root).querySelectorAll('img[data-eid]').forEach((img) => {
      photoUrl(img.dataset.eid, img.dataset.pid, 'thumb').then(
        (u) => (img.src = u),
        () => img.closest('.tn')?.classList.add('broken'),
      );
    });
  }

  const THUMBS_SHOWN = 12;
  function thumbsHtml(e, photos) {
    if (!photos.length) return '';
    const more = photos.length - THUMBS_SHOWN;
    return `<div class="thumbs">
      ${photos
        .slice(0, THUMBS_SHOWN)
        .map(
          (p) => `<a class="tn" href="#/event/${esc(e.id)}/photos" aria-label="Open photos of ${esc(e.name)}"><img alt="" data-eid="${esc(e.id)}" data-pid="${esc(p.id)}" /></a>`,
        )
        .join('')}
      ${more > 0 ? `<a class="tn more" href="#/event/${esc(e.id)}/photos">+${more}</a>` : ''}
    </div>`;
  }

  /** How many compared things differ from the OSG Website for this event (0 = in sync or not yet known). */
  function unsyncedCount(e) {
    if (!e.neonEventId) return 0;
    const n = neonRaw.find((x) => String(x.neonEventId) === String(e.neonEventId));
    const details = n ? neonSyncPlan(e, n, null, e.locationId ? locations[e.locationId] : '').details.length : 0;
    return details + (checkinDiff.get(e.id)?.n || 0);
  }

  /**
   * Compare confirmed check-ins with the OSG Website for events that have any (names are cached, so this is
   * cheap after the first look). Re-runs only for events whose confirmations changed.
   */
  async function checkCheckins() {
    const seq = neonSeq;
    const regSig = (e) => JSON.stringify(Object.entries(e.registrants || {}).map(([k, r]) => [k, r.status || 'pending']).sort());
    const todo = events.filter(
      (e) => e.neonEventId && e.date <= ymd() && Object.values(e.registrants || {}).some((r) => (r.status || 'pending') !== 'pending') && checkinDiff.get(e.id)?.sig !== regSig(e),
    );
    if (!todo.length) return;
    const { byEvent } = await fetchRegistrantsFor(todo.map((e) => String(e.neonEventId)));
    if (seq !== neonSeq) return;
    let changed = false;
    for (const e of todo) {
      const list = byEvent[String(e.neonEventId)];
      if (!list) continue; // Neon unreachable for this one: say nothing
      const n = neonSyncPlan(e, { name: e.name, date: e.date }, list, '').checkins.length;
      if ((checkinDiff.get(e.id)?.n || 0) !== n) changed = true;
      checkinDiff.set(e.id, { sig: regSig(e), n });
    }
    if (changed) renderList();
  }

  function card(e) {
    const photos = photosByEvent.get(e.id) || [];
    const { volunteers, participants } = countRoles(e.attendees);
    const loc = e.locationId ? locations[e.locationId] : '';
    const f = FORMAT[e.format] || FORMAT['in-person'];
    const registered = e.neonEventId ? Object.keys(e.registrants || {}).length : 0;
    return `
      <article class="card event ${esc(e.format)} ${e.date < ymd() ? 'past' : e.date === ymd() ? 'today' : 'future'}${needsVolunteers(e) ? ' flag' : ''}" data-id="${esc(e.id)}" aria-expanded="${open.has(e.id)}">
        <div class="row">
          <span class="ttl">
            <a class="ibadge edit" href="#/event/${esc(e.id)}" aria-label="Edit ${esc(e.name)}" title="Edit event">${icon('edit')}</a>
            <strong>${esc(e.name)}</strong>
          </span>
          <span class="badges">
            ${unsyncedCount(e) ? `<span class="badge unsynced" title="${unsyncedCount(e)} difference${unsyncedCount(e) === 1 ? '' : 's'} from the OSG Website. Open the event to review and send.">${icon('alert')}<span class="wide">Out of sync</span></span>` : ''}
            ${e.neonEventId ? `<span class="badge neon done" title="Imported from the OSG Website">${icon('check')}<span class="wide">OSG</span></span>` : ''}
            <span class="badge ${esc(e.format)}" title="${f.tip}">${icon(f.icon)}<span class="wide">${f.label}</span></span>
          </span>
        </div>
        <div class="meta">
          <span>${icon('clock')}<span class="wide">${formatTime(e.startTime)} – ${formatTime(e.endTime)}</span><span class="narrow">${formatTimeShort(e.startTime)}–${formatTimeShort(e.endTime)}</span> · ${formatHours(eventHours(e.startTime, e.endTime))}h</span>
          ${loc ? `<span>${icon('pin')}${esc(loc)}</span>` : ''}
        </div>
        <div class="stats">
          <span class="pill vol" title="Volunteers">${icon('heart')}<b>${volunteers}</b><span class="wide">volunteer${volunteers === 1 ? '' : 's'}</span></span>
          ${registered ? `<span class="pill reg" title="Registered on the OSG Website">${icon('file')}<b>${registered}</b><span class="wide">registered</span></span>` : ''}
          <span class="pill mem" title="Participants">${icon('users')}<b>${participants}</b><span class="wide">participant${participants === 1 ? '' : 's'}</span></span>
          <span class="pill hrs" title="Total volunteer hours">${icon('hourglass')}<b>${formatHours(totalVolunteerHours(e))}</b> hrs</span>
          ${needsVolunteers(e) ? `<span class="pill warn" title="Recorded hours, but no volunteers identified">${icon('alert')}<span class="wide">Assign volunteers</span></span>` : ''}
          ${
            e.date <= ymd()
              ? `<a class="ibadge photos${photos.length ? ' has-count' : ''}" href="#/event/${esc(e.id)}/photos" aria-label="${photos.length} photo${photos.length === 1 ? '' : 's'} of ${esc(e.name)}" title="Photos">${icon('camera')}${photos.length ? `<b>${photos.length}</b>` : ''}</a><a class="ibadge people" href="#/event/${esc(e.id)}/people" aria-label="Update participants of ${esc(e.name)}" title="Update participants">${icon('userEdit')}</a>`
              : ''
          }
        </div>
        ${open.has(e.id) ? `<div class="who">${whoHtml(e)}${thumbsHtml(e, photos)}</div>` : ''}
      </article>`;
  }

  /** An OSG Website (Neon) event with no RollCall copy yet; importing it creates the event so roll call can start. */
  function neonCard(e) {
    const time = e.startTime
      ? `<span>${icon('clock')}${formatTime(e.startTime)}${e.endTime ? ` – ${formatTime(e.endTime)}` : ''}</span>`
      : '';
    return `
      <article class="card event neon ${e.date < ymd() ? 'past' : e.date === ymd() ? 'today' : 'future'}" data-neon="${esc(e.neonEventId)}">
        <div class="row">
          <span class="ttl"><strong>${esc(e.name)}</strong></span>
          <span class="badges">
          <span class="badge ${esc(e.format)}" title="${FORMAT[e.format].tip}">${icon(FORMAT[e.format].icon)}<span class="wide">${FORMAT[e.format].label}</span></span>
          <button type="button" class="badge neon neon-import" data-nid="${esc(e.neonEventId)}" title="This event is created in OSG Website, tap to open" aria-label="${esc(e.name)}: this event is created in OSG Website, tap to open">${icon('download')}<span class="wide">OSG</span></button>
          </span>
        </div>
        <div class="meta">${time}${e.location ? `<span>${icon('pin')}${esc(e.location)}</span>` : ''}</div>
      </article>`;
  }

  async function importNeon(btn) {
    const ev = neonRaw.find((n) => String(n.neonEventId) === btn.dataset.nid);
    if (!ev || btn.disabled) return;
    btn.disabled = true;
    try {
      const [existing, { byEvent, failed }] = await Promise.all([loadExisting(), fetchRegistrantsFor([String(ev.neonEventId)])]);
      const plan = planNeonEvents([ev], existing, newId, byEvent);
      const op = plan.ops.find((o) => o.col === 'events');
      if (!op) throw new Error('nothing to import');
      await commitOps(plan.ops);
      if (failed) toast('Imported, but registered names could not be loaded. Open Participants to retry.');
      location.hash = `#/event/${op.id}`;
    } catch {
      toast('Could not import that event. Try again.');
      btn.disabled = false;
    }
  }

  /** Show the cached Neon result at once, then refresh it. Any failure leaves the list as it was. */
  async function loadNeon() {
    const seq = ++neonSeq;
    if (fixOnly || !range.from || !range.to || range.from > range.to) {
      neonRaw = [];
      return;
    }
    const { from, to } = range;
    neonRaw = readNeonCache(from, to) || [];
    renderList();
    const fresh = await fetchNeonEvents(from, to);
    if (fresh && seq === neonSeq) {
      neonRaw = fresh;
      renderList();
    }
    checkCheckins();
  }

  function whoHtml(e) {
    const rows = Object.values(e.attendees || {}).sort((a, b) => a.name.localeCompare(b.name));
    if (!rows.length) return '<span class="muted">No participants yet.</span>';
    return rows
      .map((a) => `<span class="pn ${personKind(a.type)}"><span class="pname">${roleOf(a) === 'volunteer' ? icon('heart') : ''}${esc(a.name)}</span></span>`)
      .join('<span class="sep">, </span>');
  }

  function subscribe() {
    unsubEvents();
    syncInputs();
    const r = fixOnly ? ALL : range;
    if (!r.from || !r.to || r.from > r.to) {
      events = [];
      neonRaw = [];
      renderList();
      return;
    }
    unsubEvents = watchEvents(r.from, r.to, (rows) => {
      events = rows;
      renderList();
      checkCheckins();
    });
    loadNeon();
  }

  $('#list', root).onclick = (ev) => {
    const imp = ev.target.closest('.neon-import');
    if (imp) return importNeon(imp);
    if (ev.target.closest('a,button')) return;
    const card = ev.target.closest('[data-id]');
    if (!card) return;
    const id = card.dataset.id;
    if (open.has(id)) open.delete(id);
    else open.add(id);
    renderList();
  };
  $('#fToggle', root).onclick = () => setFilterOpen(!filterOpen);
  setFilterOpen(filterOpen);
  const appbar = document.querySelector('.appbar');
  if (appbar) root.style.setProperty('--ab', `${appbar.offsetHeight}px`);
  $('#fix', root).onclick = () => ((fixOnly = !fixOnly), subscribe(), setFilterOpen(false));
  from.onchange = () => ((range = { ...range, from: from.value }), subscribe());
  to.onchange = () => ((range = { ...range, to: to.value }), subscribe(), setFilterOpen(false));
  $('#chips', root).onclick = (ev) => {
    const b = ev.target.closest('[data-p]');
    if (!b) return;
    range = PRESETS.find((p) => p.key === b.dataset.p).get(ymd());
    subscribe();
    setFilterOpen(false);
  };

  const unsubLoc = watchLocations((rows) => {
    locations = Object.fromEntries(rows.map((l) => [l.id, l.name]));
    renderList();
  });
  const unsubPhotos = watchAllPhotos((rows) => {
    photosByEvent = new Map();
    for (const p of rows) {
      if (!photosByEvent.has(p.eventId)) photosByEvent.set(p.eventId, []);
      photosByEvent.get(p.eventId).push(p);
    }
    renderList();
  });
  subscribe();

  return () => {
    neonSeq++;
    unsubEvents();
    unsubLoc();
    unsubPhotos();
  };
}
