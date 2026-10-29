import { watchEvents, watchLocations, watchAllPhotos, watchAllReactions, watchRoster, loadExisting, newId, commitOps } from '../data.js';
import { fetchNeonEvents, readNeonCache, fetchRegistrantsFor, neonInfo } from '../lib/neonApi.js';
import { neonOnlyEvents, planNeonEvents, neonSyncPlan, staleRegistrantEvents } from '../lib/neon.js';
import { similarNeonEvents } from '../lib/neonMerge.js';
import { openMergeDialog } from './neonMerge.js';
import { photoUrl } from '../lib/photos.js';
import { esc, $, toast } from '../lib/dom.js';
import { rosterMap, fixedRole } from '../lib/roster.js';
import { icon } from '../lib/icons.js';
import { tally } from '../lib/poll.js';
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
const refreshing = new Set(); // registrant refreshes already tried this session (see refreshRegistrants)
const RANGE_KEY = 'rollcall.range';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The date range last chosen in this tab (kept across reloads and app updates, not across tabs). */
function savedRange() {
  try {
    const r = JSON.parse(sessionStorage.getItem(RANGE_KEY) || 'null');
    return r && DAY.test(r.from) && DAY.test(r.to) ? { from: r.from, to: r.to } : null;
  } catch {
    return null;
  }
}
/** Remember a range the user picked; the default (yesterday to tomorrow) is not remembered, so it keeps following today. */
const saveRange = (r) => {
  try {
    const d = defaultRange();
    if (r.from === d.from && r.to === d.to) sessionStorage.removeItem(RANGE_KEY);
    else sessionStorage.setItem(RANGE_KEY, JSON.stringify({ from: r.from, to: r.to }));
  } catch {
    /* storage unavailable: the range is still remembered while the page stays open */
  }
};
let range = null;
const open = new Map(); // expanded event cards: id -> 'all' | 'vol' | 'mem' | 'reg' (which names to list)
const dayToggled = new Map(); // date -> open?, for day groups the user opened or closed (others use the default)
let filterOpen = false; // date-range card expanded?
let fixOnly = false; // only events that still need volunteers identified, across all dates
const ALL = { from: '2000-01-01', to: '2099-12-31' };
const defaultRange = () => PRESETS[0].get(ymd());

export function homeView(root, _ctx) {
  range ||= savedRange() || defaultRange();
  let events = [];
  let locations = {};
  let photosByEvent = new Map(); // eventId -> photo metadata[]
  let reactionsByEvent = new Map(); // eventId -> reaction docs[]
  let unsubEvents = () => {};
  let roster = new Map(); // lower-case name -> 'staff' | 'volunteer'
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

  /** A day's group is open unless it is yesterday or tomorrow (or the user toggled it). "Needs volunteers" shows everything. */
  function dayIsOpen(date, today) {
    if (fixOnly) return true;
    if (dayToggled.has(date)) return dayToggled.get(date);
    return date !== addDays(today, -1) && date !== addDays(today, 1);
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
      .map(([date, items]) => {
        const on = dayIsOpen(date, today);
        return `
        <h2 class="day ${date === today ? 'today' : ''}"><button type="button" class="day-toggle${on ? ' open' : ''}" data-day="${esc(date)}" aria-expanded="${on}">
          <span class="dchev">${icon('chevron')}</span><span class="dlbl">${esc(formatDay(date))}</span>${on ? '' : `<span class="dcount">${items.length}</span>`}
        </button></h2>
        ${on ? items.map((e) => (e.fromNeon ? neonCard(e) : card(e))).join('') : ''}`;
      })
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

  /** The likeliest OSG Website twin of a RollCall-only event, or null. Uses the Neon list already on screen. */
  function osgTwin(e) {
    if (e.neonEventId || e.duplicateOf || !neonRaw.length) return null;
    const taken = new Set(events.filter((x) => x.neonEventId).map((x) => String(x.neonEventId)));
    return similarNeonEvents(e, neonRaw, { locationName: e.locationId ? locations[e.locationId] : '', takenIds: taken })[0] || null;
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
    const regSig = (e) => JSON.stringify([Object.entries(e.registrants || {}).map(([k, r]) => [k, r.status || 'pending']).sort(), Object.values(e.attendees || {}).map((a) => a.name).sort()]);
    const todo = events.filter(
      (e) => e.neonEventId && e.date <= ymd() && (Object.keys(e.attendees || {}).length || Object.values(e.registrants || {}).some((r) => (r.status || 'pending') !== 'pending')) && checkinDiff.get(e.id)?.sig !== regSig(e),
    );
    if (!todo.length) return;
    const { byEvent } = await fetchRegistrantsFor(todo.map((e) => String(e.neonEventId)), undefined, 4, { force: true });
    if (seq !== neonSeq) return;
    let changed = false;
    for (const e of todo) {
      const list = byEvent[String(e.neonEventId)];
      if (!list) continue; // Neon unreachable for this one: say nothing
      const p = neonSyncPlan(e, { name: e.name, date: e.date }, list, '');
      const n = p.checkins.length + p.walkins.length;
      if ((checkinDiff.get(e.id)?.n || 0) !== n) changed = true;
      checkinDiff.set(e.id, { sig: regSig(e), n });
    }
    if (changed) renderList();
  }

  /** A count pill; with a count above zero it is a button that lists those names under the card. */
  function pill(e, which, n, title, ic, label) {
    const body = `${ic}<b>${n}</b><span class="wide">${label}</span>`;
    if (!n) return `<span class="pill ${which}" title="${title}">${body}</span>`;
    const on = open.get(e.id) === which;
    return `<button type="button" class="pill ${which}" data-who="${which}" aria-pressed="${on}" title="${title}: tap to ${on ? 'hide' : 'show'} the names">${body}</button>`;
  }

  function card(e) {
    const photos = photosByEvent.get(e.id) || [];
    const poll = tally(reactionsByEvent.get(e.id) || []);
    const { volunteers, participants } = countRoles(e.attendees);
    const loc = e.locationId ? locations[e.locationId] : '';
    const f = FORMAT[e.format] || FORMAT['in-person'];
    const registered = e.neonEventId ? Object.values(e.registrants || {}).filter((r) => !r.cancelled).length : 0;
    return `
      <article class="card event ${esc(e.format)} ${e.date < ymd() ? 'past' : e.date === ymd() ? 'today' : 'future'}${needsVolunteers(e) ? ' flag' : ''}" data-id="${esc(e.id)}" aria-expanded="${open.has(e.id)}">
        <div class="row">
          <span class="ttl">
            <a class="ibadge edit" href="#/event/${esc(e.id)}" aria-label="Edit ${esc(e.name)}" title="Edit event">${icon('edit')}</a>
            <strong>${esc(e.name)}</strong>
          </span>
          <span class="badges">
            ${e.duplicateOf ? `<a class="badge unsynced" href="#/event/${esc(e.duplicateOf)}" title="Duplicate: its roll was moved to the original event. Tap to open the original. You can delete this one." aria-label="${esc(e.name)} is a duplicate. Open the original.">${icon('copy')}<span class="wide">Duplicate</span></a>` : ''}
            ${osgTwin(e) ? `<button type="button" class="badge unsynced merge-hint" data-merge="${esc(e.id)}" title="This may already be on the OSG Website. Tap to find it and merge." aria-label="${esc(e.name)} may already be on the OSG Website. Tap to merge.">${icon('swap')}<span class="wide">On OSG?</span></button>` : ''}
            ${unsyncedCount(e) ? `<button type="button" class="badge unsynced outsync" data-outsync="${esc(e.id)}" title="${unsyncedCount(e)} difference${unsyncedCount(e) === 1 ? '' : 's'} from the OSG Website. Tap for details." aria-label="${esc(e.name)} is out of sync with the OSG Website. Tap for details.">${icon('alert')}<span class="wide">Out of sync</span></button>` : ''}
            ${e.neonEventId ? `<span class="badge neon done" title="Imported from the OSG Website">${icon('check')}<span class="wide">OSG</span></span>` : ''}
            <span class="badge ${esc(e.format)}" title="${f.tip}">${icon(f.icon)}<span class="wide">${f.label}</span></span>
          </span>
        </div>
        <div class="meta">
          <span>${icon('clock')}<span class="wide">${formatTime(e.startTime)} – ${formatTime(e.endTime)}</span><span class="narrow">${formatTimeShort(e.startTime)}–${formatTimeShort(e.endTime)}</span> · ${formatHours(eventHours(e.startTime, e.endTime))}h</span>
          ${loc ? `<span>${icon('pin')}${esc(loc)}</span>` : ''}
        </div>
        <div class="stats">
          ${pill(e, 'vol', volunteers, 'Volunteers', icon('heart'), `volunteer${volunteers === 1 ? '' : 's'}`)}
          ${registered ? pill(e, 'reg', registered, 'Registered on the OSG Website', icon('file'), 'registered') : ''}
          ${pill(e, 'mem', participants, 'Participants', icon('users'), `participant${participants === 1 ? '' : 's'}`)}
          <span class="pill hrs" title="Total volunteer hours">${icon('hourglass')}<b>${formatHours(totalVolunteerHours(e))}</b> hrs</span>
          ${needsVolunteers(e) ? `<span class="pill warn" title="Recorded hours, but no volunteers identified">${icon('alert')}<span class="wide">Assign volunteers</span></span>` : ''}
          ${
            poll.total
              ? `<a class="pill poll" href="#/event/${esc(e.id)}/poll" title="Reactions: ${poll.up} up, ${poll.mid} sideways, ${poll.down} down" aria-label="Reactions poll of ${esc(e.name)}: ${poll.up} up, ${poll.mid} sideways, ${poll.down} down">${icon('thumbsUp')}<b>${poll.up}</b>${icon('thumbsSide')}<b>${poll.mid}</b>${icon('thumbsDown')}<b>${poll.down}</b></a>`
              : ''
          }
          ${
            e.date <= ymd()
              ? `<a class="ibadge photos${photos.length ? ' has-count' : ''}" href="#/event/${esc(e.id)}/photos" aria-label="${photos.length} photo${photos.length === 1 ? '' : 's'} of ${esc(e.name)}" title="Photos">${icon('camera')}${photos.length ? `<b>${photos.length}</b>` : ''}</a><a class="ibadge people" href="#/event/${esc(e.id)}/people" aria-label="Update participants of ${esc(e.name)}" title="Update participants">${icon('userEdit')}</a>`
              : ''
          }
        </div>
        ${open.has(e.id) ? `<div class="who">${whoHtml(e, open.get(e.id))}${thumbsHtml(e, photos)}</div>` : ''}
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
      const [existing, { byEvent, failed }] = await Promise.all([loadExisting(), fetchRegistrantsFor([String(ev.neonEventId)], undefined, 1, { force: true })]);
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
      refreshRegistrants(fresh);
    }
  }

  /** Imported events whose Neon attendee count changed: fetch their names again and add the new ones. Best effort. */
  async function refreshRegistrants(neonRows) {
    // At most one attempt per event and count every 5 minutes (matching the cache), so failures cannot loop.
    const slot = Math.floor(Date.now() / 300_000);
    const key = (n) => `${n.neonEventId}|${n.registered}|${n.registrations}|${slot}`;
    const stale = staleRegistrantEvents(neonRows, events, ymd()).filter((n) => !refreshing.has(key(n)));
    if (!stale.length) return;
    for (const n of stale) refreshing.add(key(n));
    try {
      const { byEvent } = await fetchRegistrantsFor(stale.map((n) => String(n.neonEventId)));
      const plan = planNeonEvents(stale, { events, locations: [] }, newId, byEvent);
      if (plan.ops.length) await commitOps(plan.ops);
    } catch {
      /* the next refresh tries again */
    }
    checkCheckins();
  }

  function whoHtml(e, which = 'all') {
    if (which === 'reg') {
      const regs = Object.values(e.registrants || {}).filter((r) => !r.cancelled && r.name).sort((x, y) => x.name.localeCompare(y.name));
      if (!regs.length) return '<span class="muted">Nobody registered.</span>';
      return regs
        .map((r) => `<span class="pn"><span class="pname">${r.status === 'present' ? icon('check') : ''}${esc(r.name)}</span></span>`)
        .join('<span class="sep">, </span>');
    }
    const rows = Object.values(e.attendees || {})
      .filter((a) => which === 'all' || (which === 'vol') === (roleOf(a) === 'volunteer'))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!rows.length) return '<span class="muted">No participants yet.</span>';
    return rows
      .map((a) => {
        const staff = roster.get(a.name.toLowerCase()) === 'staff';
        const vol = (fixedRole(roster, a.name) || roleOf(a)) === 'volunteer';
        return `<span class="pn ${personKind(a.type)}${staff ? ' staff' : ''}"><span class="pname">${staff ? `<span class="who" title="Staff">${icon('shield')}</span>` : vol ? icon('heart') : ''}${esc(a.name)}</span></span>`;
      })
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

  /** Say what "Out of sync" means for this event, and whether the differences can be sent from here. */
  async function explainOutOfSync(e) {
    if (!e) return;
    const n = unsyncedCount(e);
    const info = await neonInfo().catch(() => null);
    const dlg = document.createElement('dialog');
    dlg.className = 'sync-dlg';
    dlg.innerHTML = `
      <form method="dialog" class="sync-body">
        <h2>${icon('alert')} ${esc(e.name)}</h2>
        <p>${n} difference${n === 1 ? '' : 's'} between RollCall and the OSG Website. RollCall is the source, so the OSG Website is the one that is behind.</p>
        ${info?.canWrite === false ? `<p class="notice warn">${icon('alert')} <span><b>Sending is turned off.</b> Your changes are saved in RollCall, but they can't be sent to the OSG Website from here for now. There is nothing you need to do.</span></p>` : '<p class="muted">Open the event to see what would change and send it.</p>'}
        <div class="actions">
          <button class="btn ghost" value="cancel">Close</button>
          <a class="btn primary" href="#/event/${esc(e.id)}">Open event</a>
        </div>
      </form>`;
    dlg.addEventListener('close', () => dlg.remove());
    dlg.querySelector('a').onclick = () => dlg.close();
    document.body.append(dlg);
    dlg.showModal();
  }

  $('#list', root).onclick = (ev) => {
    const dayBtn = ev.target.closest('.day-toggle');
    if (dayBtn) {
      dayToggled.set(dayBtn.dataset.day, dayBtn.getAttribute('aria-expanded') !== 'true');
      return renderList();
    }
    const imp = ev.target.closest('.neon-import');
    if (imp) return importNeon(imp);
    const mrg = ev.target.closest('.merge-hint');
    if (mrg) {
      const e = events.find((x) => x.id === mrg.dataset.merge);
      return e && openMergeDialog({ event: e, locationName: e.locationId ? locations[e.locationId] || '' : '' });
    }
    const out = ev.target.closest('.outsync');
    if (out) return explainOutOfSync(events.find((x) => x.id === out.dataset.outsync));
    const who = ev.target.closest('[data-who]');
    if (who) {
      const id = who.closest('[data-id]').dataset.id;
      if (open.get(id) === who.dataset.who) open.delete(id);
      else open.set(id, who.dataset.who);
      return renderList();
    }
    if (ev.target.closest('a,button')) return;
    const card = ev.target.closest('[data-id]');
    if (!card) return;
    const id = card.dataset.id;
    if (open.has(id)) open.delete(id);
    else open.set(id, 'all');
    renderList();
  };
  $('#fToggle', root).onclick = () => setFilterOpen(!filterOpen);
  setFilterOpen(filterOpen);
  const appbar = document.querySelector('.appbar');
  if (appbar) root.style.setProperty('--ab', `${appbar.offsetHeight}px`);
  $('#fix', root).onclick = () => ((fixOnly = !fixOnly), subscribe(), setFilterOpen(false));
  // Setting the start date waits for the end date: nothing is loaded until To is set, or the user leaves the date fields.
  let endPending = false;
  const applyDates = () => {
    endPending = false;
    if (!from.value || !to.value) return;
    range = { from: from.value, to: to.value };
    saveRange(range);
    subscribe();
    setFilterOpen(false);
  };
  from.onchange = () => {
    if (!from.value) return;
    endPending = true;
    if (!to.value || to.value < from.value) to.value = from.value; // the end picker opens on the start date
    to.focus();
    try {
      to.showPicker?.();
    } catch {
      /* the browser wants a real click for the picker; the field is focused for typing */
    }
  };
  to.onchange = applyDates;
  $('#fBody', root).addEventListener('focusout', () =>
    setTimeout(() => {
      if (endPending && !$('#fBody', root)?.contains(document.activeElement)) applyDates();
    }, 300),
  );
  $('#chips', root).onclick = (ev) => {
    const b = ev.target.closest('[data-p]');
    if (!b) return;
    range = PRESETS.find((p) => p.key === b.dataset.p).get(ymd());
    saveRange(range);
    subscribe();
    setFilterOpen(false);
  };

  const unsubLoc = watchLocations((rows) => {
    locations = Object.fromEntries(rows.map((l) => [l.id, l.name]));
    renderList();
  });
  const unsubRoster = watchRoster((rows) => {
    roster = rosterMap(rows);
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
  const unsubReactions = watchAllReactions((rows) => {
    reactionsByEvent = new Map();
    for (const r of rows) {
      if (!reactionsByEvent.has(r.eventId)) reactionsByEvent.set(r.eventId, []);
      reactionsByEvent.get(r.eventId).push(r);
    }
    renderList();
  });
  subscribe();

  return () => {
    neonSeq++;
    unsubEvents();
    unsubLoc();
    unsubPhotos();
    unsubReactions();
    unsubRoster();
  };
}
