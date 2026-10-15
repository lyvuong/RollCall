import { watchEvents, watchLocations } from '../data.js';
import { esc, $ } from '../lib/dom.js';
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
  virtual: { label: 'Virtual', icon: 'video' },
  'in-person': { label: 'In person', icon: 'building' },
  both: { label: 'Hybrid', icon: 'globe' },
};

const startOfWeek = (d) => addDays(d, -((new Date(d + 'T00:00').getDay() + 6) % 7));
const PRESETS = [
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
  let unsubEvents = () => {};

  root.innerHTML = `
    <section class="bar">
      <h1>${icon('calendar', 'lg')} Events</h1>
      <a class="btn primary fab" href="#/event/new" aria-label="New event" title="New event">${icon('plus')}<span class="wide">New event</span></a>
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
    if (!events.length) {
      list.innerHTML = `
        <div class="card empty">${icon('calendar', 'lg')}
          <p>No events in this range.</p>
          <a class="btn primary" href="#/event/new">${icon('plus')} Create an event</a>
        </div>`;
      return;
    }
    const shown = fixOnly ? events.filter(needsVolunteers) : events;
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
    const todo = events.filter(needsVolunteers).length;
    $('#fixLbl', root).textContent = `Needs volunteers${todo ? ` (${todo})` : ''}`;
    $('#fix', root).setAttribute('aria-pressed', String(fixOnly));
    list.innerHTML = [...days]
      .map(
        ([date, items]) => `
        <h2 class="day ${date === today ? 'today' : ''}">${esc(formatDay(date))}</h2>
        ${items.map(card).join('')}`,
      )
      .join('');
  }

  function card(e) {
    const { volunteers, participants } = countRoles(e.attendees);
    const loc = e.locationId ? locations[e.locationId] : '';
    const f = FORMAT[e.format] || FORMAT['in-person'];
    return `
      <article class="card event ${esc(e.format)}${needsVolunteers(e) ? ' flag' : ''}" data-id="${esc(e.id)}" aria-expanded="${open.has(e.id)}">
        <div class="row">
          <span class="ttl">
            <a class="ibadge edit" href="#/event/${esc(e.id)}" aria-label="Edit ${esc(e.name)}" title="Edit event">${icon('edit')}</a>
            <strong>${esc(e.name)}</strong>
          </span>
          <span class="badge ${esc(e.format)}" title="${f.label}">${icon(f.icon)}<span class="wide">${f.label}</span></span>
        </div>
        <div class="meta">
          <span>${icon('clock')}<span class="wide">${formatTime(e.startTime)} – ${formatTime(e.endTime)}</span><span class="narrow">${formatTimeShort(e.startTime)}–${formatTimeShort(e.endTime)}</span> · ${formatHours(eventHours(e.startTime, e.endTime))}h</span>
          ${loc ? `<span>${icon('pin')}${esc(loc)}</span>` : ''}
        </div>
        <div class="stats">
          <span class="pill vol" title="Volunteers">${icon('heart')}<b>${volunteers}</b><span class="wide">volunteer${volunteers === 1 ? '' : 's'}</span></span>
          <span class="pill mem" title="Participants">${icon('users')}<b>${participants}</b><span class="wide">participant${participants === 1 ? '' : 's'}</span></span>
          <span class="pill hrs" title="Total volunteer hours">${icon('hourglass')}<b>${formatHours(totalVolunteerHours(e))}</b> hrs</span>
          ${needsVolunteers(e) ? `<span class="pill warn" title="Recorded hours, but no volunteers identified">${icon('alert')}<span class="wide">Assign volunteers</span></span>` : ''}
          ${
            e.date <= ymd()
              ? `<a class="ibadge people" href="#/event/${esc(e.id)}/people" aria-label="Update participants of ${esc(e.name)}" title="Update participants">${icon('userEdit')}</a>`
              : ''
          }
        </div>
        ${open.has(e.id) ? `<div class="who">${whoHtml(e)}</div>` : ''}
      </article>`;
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
      renderList();
      return;
    }
    unsubEvents = watchEvents(r.from, r.to, (rows) => {
      events = rows;
      renderList();
    });
  }

  $('#list', root).onclick = (ev) => {
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
  $('#fix', root).onclick = () => ((fixOnly = !fixOnly), subscribe());
  from.onchange = () => ((range = { ...range, from: from.value }), subscribe());
  to.onchange = () => ((range = { ...range, to: to.value }), subscribe());
  $('#chips', root).onclick = (ev) => {
    const b = ev.target.closest('[data-p]');
    if (!b) return;
    range = PRESETS.find((p) => p.key === b.dataset.p).get(ymd());
    subscribe();
  };

  const unsubLoc = watchLocations((rows) => {
    locations = Object.fromEntries(rows.map((l) => [l.id, l.name]));
    renderList();
  });
  subscribe();

  return () => {
    unsubEvents();
    unsubLoc();
  };
}
