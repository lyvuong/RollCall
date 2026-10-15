import { watchEvents, watchLocations } from '../data.js';
import { esc, $ } from '../lib/dom.js';
import {
  ymd,
  addDays,
  formatDay,
  formatTime,
  formatHours,
  eventHours,
  countByType,
  totalVolunteerHours,
} from '../lib/time.js';

const FORMAT_LABEL = { virtual: 'Virtual', 'in-person': 'In person', both: 'Hybrid' };

// Remembered across navigation within the session.
let range = null;
const defaultRange = () => ({ from: addDays(ymd(), -1), to: addDays(ymd(), 1) });

export function homeView(root, _ctx) {
  range ||= defaultRange();
  let events = [];
  let locations = {};
  let unsubEvents = () => {};

  root.innerHTML = `
    <section class="bar">
      <h1>Events</h1>
      <a class="btn primary" href="#/event/new">+ New event</a>
    </section>
    <section class="card filter">
      <label>From <input type="date" id="from" class="input" /></label>
      <label>To <input type="date" id="to" class="input" /></label>
      <button class="btn" id="reset">Yesterday–tomorrow</button>
    </section>
    <section id="list" aria-live="polite"></section>`;

  const from = $('#from', root);
  const to = $('#to', root);
  from.value = range.from;
  to.value = range.to;

  function renderList() {
    const list = $('#list', root);
    if (!events.length) {
      list.innerHTML = `<p class="empty">No events in this range.</p>`;
      return;
    }
    const days = new Map();
    for (const e of events) {
      if (!days.has(e.date)) days.set(e.date, []);
      days.get(e.date).push(e);
    }
    list.innerHTML = [...days]
      .map(
        ([date, items]) => `
        <h2 class="day">${esc(formatDay(date))}</h2>
        ${items.map(card).join('')}`,
      )
      .join('');
  }

  function card(e) {
    const { volunteers, members } = countByType(e.attendees);
    const loc = e.locationId ? locations[e.locationId] : '';
    return `
      <a class="card event" href="#/event/${esc(e.id)}">
        <div class="row">
          <strong>${esc(e.name)}</strong>
          <span class="badge ${esc(e.format)}">${FORMAT_LABEL[e.format] || esc(e.format)}</span>
        </div>
        <div class="muted">${formatTime(e.startTime)} – ${formatTime(e.endTime)}
          (${formatHours(eventHours(e.startTime, e.endTime))} h)${loc ? ` · ${esc(loc)}` : ''}</div>
        <div class="stats">
          <span>${volunteers} volunteer${volunteers === 1 ? '' : 's'}</span>
          <span>${members} member${members === 1 ? '' : 's'}</span>
          <span><b>${formatHours(totalVolunteerHours(e))}</b> volunteer hrs</span>
        </div>
      </a>`;
  }

  function subscribe() {
    unsubEvents();
    if (!range.from || !range.to || range.from > range.to) {
      events = [];
      renderList();
      return;
    }
    unsubEvents = watchEvents(range.from, range.to, (rows) => {
      events = rows;
      renderList();
    });
  }

  from.onchange = () => ((range = { ...range, from: from.value }), subscribe());
  to.onchange = () => ((range = { ...range, to: to.value }), subscribe());
  $('#reset', root).onclick = () => {
    range = defaultRange();
    from.value = range.from;
    to.value = range.to;
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
