import {
  watchEvent,
  watchLocations,
  createLocation,
  createEvent,
  updateEvent,
  deleteEvent,
  fetchRecentEvents,
} from '../data.js';
import { esc, $, toast } from '../lib/dom.js';
import { mountNeonSync } from './neonSync.js';
import { renderMergeSlot } from './neonMerge.js';
import { mountPresence } from '../lib/presence.js';
import { icon } from '../lib/icons.js';
import { matchLocation } from '../lib/locations.js';
import { ymd, eventHours, countRoles, totalVolunteerHours, personKind, roleOf, needsVolunteers, formatHours, formatTime } from '../lib/time.js';

const NEW_LOC = '__new__';
const FORMAT_LABEL = { virtual: 'Virtual', 'in-person': 'In person', both: 'Hybrid' };
const KIND_LABEL = { osg: 'OSG member', community: 'Community' };
const KIND_ICON = { osg: icon('star'), community: icon('users') };
const initials = (name) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const tint = (name) => [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 4;

export function eventView(root, ctx, eventId) {
  const isNew = !eventId;
  let event = isNew ? null : undefined; // undefined = loading, null = not found
  let locations = [];
  let formReady = false;
  let locationId = '';
  let addingLocation = false; // "+ New location…" chosen: the typed name is saved with the event
  let template = null; // past event chosen from suggestions
  let recent = []; // distinct past events, newest first
  let suggestions = [];
  let active = -1;
  const unsubs = [];

  root.innerHTML = `
    <section class="bar">
      <a class="btn ghost" href="#/">${icon('back')} Events</a>
      <span class="sync-slot"><span id="mergeSlot"></span><span id="syncSlot"></span></span>
    </section>
    <div id="presence" class="pres-row"></div>
    <h1 id="title" class="evt-title" ${isNew ? '' : 'hidden'}>${isNew ? 'New event' : 'Event'}</h1>
    <p id="state" class="muted">${isNew ? '' : 'Loading…'}</p>
    <div id="body" class="${isNew ? '' : 'evt'}" hidden>
      <form id="f" class="card form" autocomplete="off">
        <div class="field suggest-wrap">
          <label for="name" class="lbl">${icon('edit')} Name</label>
          <input id="name" class="input" required maxlength="120"
                 ${isNew ? 'role="combobox" aria-expanded="false" aria-controls="sugg" aria-autocomplete="list" placeholder="Start typing to reuse a past event…"' : ''} />
          ${isNew ? '<ul id="sugg" class="suggest" role="listbox" hidden></ul>' : ''}
        </div>
        <div id="prefill" class="notice" hidden></div>
        <label class="field"><span class="lbl">${icon('file')} Description</span>
          <textarea id="desc" class="input" rows="2" maxlength="1000"></textarea></label>
        <div class="grid3">
          <label class="field"><span class="lbl">${icon('calendar')} Date</span>
            <input id="date" type="date" class="input" required /></label>
          <label class="field"><span class="lbl">${icon('clock')} Start</span>
            <input id="start" type="time" step="900" class="input" required /></label>
          <label class="field"><span class="lbl">${icon('clock')} End</span>
            <input id="end" type="time" step="900" class="input" required /></label>
        </div>
        <div class="grid2">
        <label class="field"><span class="lbl">${icon('globe')} Format</span>
          <select id="format" class="input">
            <option value="in-person">In person</option>
            <option value="virtual">Virtual</option>
            <option value="both">Both (hybrid)</option>
          </select>
        </label>
        <label class="field" id="locWrap"><span class="lbl">${icon('pin')} Location</span>
          <select id="location" class="input"></select>
          <input id="newLocation" class="input" maxlength="80" placeholder="New location name" aria-label="New location name" hidden />
        </label>
        </div>
        <div class="actions">
          <button class="btn primary" type="submit">${icon('save')} ${isNew ? 'Create event' : 'Save changes'}</button>
          ${isNew ? '' : `<button class="btn danger" type="button" id="del">${icon('trash')} Delete</button>`}
        </div>
      </form>
      ${
        isNew
          ? `<p class="muted">${icon('users')} Save the event, then take roll call.</p>`
          : `
      <section class="card compact" id="summary" aria-label="Summary"></section>`
      }
    </div>`;

  const f = $('#f', root);

  /* ----- form ----- */

  function renderLocations() {
    const sel = $('#location', root);
    sel.innerHTML =
      `<option value="">— Select —</option>` +
      locations.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('') +
      `<option value="${NEW_LOC}">+ New location…</option>`;
    sel.value = addingLocation ? NEW_LOC : locationId;
    if (sel.value !== (addingLocation ? NEW_LOC : locationId)) sel.value = '';
  }

  function syncLocationVisibility() {
    const virtual = $('#format', root).value === 'virtual';
    $('#locWrap', root).hidden = virtual;
    $('#newLocation', root).required = addingLocation && !virtual; // a hidden required field would block saving
  }

  function fillForm(e) {
    $('#name', root).value = e.name;
    $('#desc', root).value = e.description || '';
    $('#date', root).value = e.date;
    $('#start', root).value = e.startTime;
    $('#end', root).value = e.endTime;
    $('#format', root).value = e.format;
    locationId = e.locationId || '';
    addingLocation = false;
    $('#newLocation', root).hidden = true;
    renderLocations();
    syncLocationVisibility();
    if (!isNew) $('#title', root).textContent = e.name;
  }

  function showBody() {
    $('#state', root).hidden = true;
    $('#body', root).hidden = false;
  }

  $('#format', root).onchange = syncLocationVisibility;
  $('#location', root).onchange = (ev) => {
    addingLocation = ev.target.value === NEW_LOC;
    locationId = addingLocation ? '' : ev.target.value;
    const input = $('#newLocation', root);
    input.hidden = !addingLocation;
    syncLocationVisibility();
    if (addingLocation) input.focus();
  };

  f.onsubmit = (ev) => {
    ev.preventDefault();
    const data = {
      name: $('#name', root).value.trim(),
      description: $('#desc', root).value.trim(),
      date: $('#date', root).value,
      startTime: $('#start', root).value,
      endTime: $('#end', root).value,
      format: $('#format', root).value,
    };
    data.locationId = data.format === 'virtual' ? null : locationId || null;
    if (data.endTime <= data.startTime) return toast('End time must be after start time.');
    // A typed new location joins the saved list (reusing a look-alike that already exists instead of duplicating it).
    const typed = $('#newLocation', root).value.trim();
    if (addingLocation && data.format !== 'virtual' && typed) {
      const known = matchLocation(locations, typed);
      if (known) data.locationId = known.id;
      else {
        const loc = createLocation(typed);
        loc.done.catch(() => toast('Could not save the new location.'));
        data.locationId = loc.id;
      }
    }

    if (isNew) {
      const copy = template && $('#copyAttendees', root)?.checked;
      if (copy) {
        data.attendees = Object.fromEntries(
          Object.entries(template.attendees || {}).map(([id, a]) => [id, { name: a.name, type: personKind(a.type), role: roleOf(a) }]),
        );
        if (!Object.values(data.attendees).some((a) => a.role === 'volunteer') && template.volunteerHours) {
          data.volunteerHours = template.volunteerHours;
        }
      }
      const { id, done } = createEvent(data);
      done.catch(() => toast('Could not save event.'));
      location.hash = `#/event/${id}`;
    } else {
      updateEvent(eventId, data).catch(() => toast('Could not save changes.'));
      location.hash = '#/';
    }
  };

  const del = $('#del', root);
  if (del) {
    del.onclick = () => {
      if (!confirm('Delete this event and its attendance? This cannot be undone.')) return;
      deleteEvent(eventId).catch(() => toast('Could not delete.'));
      location.hash = '#/';
    };
  }

  /* ----- suggestions from past events (new events only) ----- */

  const nameEl = $('#name', root);
  const suggEl = $('#sugg', root);

  function closeSuggestions() {
    if (!suggEl) return;
    suggEl.hidden = true;
    nameEl.setAttribute('aria-expanded', 'false');
    active = -1;
  }

  function renderSuggestions() {
    if (!isNew) return;
    const q = nameEl.value.trim().toLowerCase();
    if (!q) return closeSuggestions();
    suggestions = recent
      .filter((e) => e.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const as = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bs = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return as - bs || b.date.localeCompare(a.date);
      })
      .slice(0, 6);
    if (!suggestions.length) return closeSuggestions();
    const locName = (id) => locations.find((l) => l.id === id)?.name;
    suggEl.innerHTML = suggestions
      .map(
        (e, i) => `
        <li role="option" id="s${i}" data-i="${i}" aria-selected="${i === active}">
          <strong>${icon('history')} ${esc(e.name)}</strong>
          <span class="sub">
            <span>${formatTime(e.startTime)} – ${formatTime(e.endTime)}</span>
            <span>${esc(FORMAT_LABEL[e.format] || e.format)}</span>
            ${e.locationId && locName(e.locationId) ? `<span>${esc(locName(e.locationId))}</span>` : ''}
            <span>last on ${esc(e.date)}</span>
          </span>
        </li>`,
      )
      .join('');
    suggEl.hidden = false;
    nameEl.setAttribute('aria-expanded', 'true');
  }

  function pickSuggestion(i) {
    const e = suggestions[i];
    if (!e) return;
    template = e;
    // Reuse everything except the date, which is usually the only thing that changes.
    $('#name', root).value = e.name;
    $('#desc', root).value = e.description || '';
    $('#start', root).value = e.startTime;
    $('#end', root).value = e.endTime;
    $('#format', root).value = e.format;
    locationId = e.locationId || '';
    addingLocation = false;
    $('#newLocation', root).hidden = true;
    renderLocations();
    syncLocationVisibility();
    closeSuggestions();

    const n = Object.keys(e.attendees || {}).length;
    const box = $('#prefill', root);
    box.hidden = false;
    box.innerHTML = `
      <span>${icon('history')} Filled in from “${esc(e.name)}” (${esc(e.date)}). Just pick the new date.</span>
      ${
        n
          ? `<label><input type="checkbox" id="copyAttendees" /> Also check in the same ${n} attendee${n === 1 ? '' : 's'}</label>`
          : ''
      }`;
    $('#date', root).focus();
  }

  if (isNew) {
    nameEl.addEventListener('input', () => {
      active = -1;
      renderSuggestions();
    });
    nameEl.addEventListener('blur', () => setTimeout(closeSuggestions, 120));
    nameEl.addEventListener('keydown', (ev) => {
      if (suggEl.hidden) return;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const n = suggestions.length;
        active = (active + (ev.key === 'ArrowDown' ? 1 : -1) + n) % n;
        renderSuggestions();
      } else if (ev.key === 'Enter' && active >= 0) {
        ev.preventDefault();
        pickSuggestion(active);
      } else if (ev.key === 'Escape') closeSuggestions();
    });
    // mousedown (not click) so it fires before the input loses focus.
    suggEl.addEventListener('mousedown', (ev) => {
      const li = ev.target.closest('li[data-i]');
      if (li) (ev.preventDefault(), pickSuggestion(+li.dataset.i));
    });
    fetchRecentEvents()
      .then((rows) => {
        const seen = new Set();
        recent = rows.filter((e) => {
          const k = e.name.trim().toLowerCase();
          return seen.has(k) ? false : (seen.add(k), true);
        });
        if (document.activeElement === nameEl) renderSuggestions();
      })
      .catch(() => {});
  }

  /* ----- roll call ----- */

  function renderSummary() {
    const el = $('#summary', root);
    if (!el || !event) return;
    const hours = eventHours(event.startTime, event.endTime);
    const { volunteers, participants } = countRoles(event.attendees);
    el.innerHTML = `
      ${
        needsVolunteers(event)
          ? `<div class="notice warn">${icon('alert')} <span>${formatHours(event.volunteerHours)} volunteer hrs recorded, but no volunteers identified.</span></div>`
          : ''
      }
      <div class="summary">
        <div class="stat" title="Hours per event">${icon('clock')}<span>${formatHours(hours)}</span><span class="wide">hrs / event</span></div>
        <div class="stat" title="Volunteers">${icon('heart')}<span>${volunteers}</span><span class="wide">volunteer${volunteers === 1 ? '' : 's'}</span></div>
        <div class="stat" title="Participants">${icon('users')}<span>${participants}</span><span class="wide">participant${participants === 1 ? '' : 's'}</span></div>
        <div class="stat total" title="Total volunteer hours">${icon('hourglass')}<span>${formatHours(totalVolunteerHours(event))}</span><span class="wide">hrs total</span></div>
      </div>
      <a class="btn primary block" href="#/event/${esc(eventId)}/people">${icon('userEdit')} Participants (${volunteers + participants})</a>`;
  }

  /* ----- subscriptions ----- */

  const renderMerge = () =>
    renderMergeSlot($('#mergeSlot', root), isNew ? null : event, locations.find((l) => l.id === event?.locationId)?.name || '');

  const sync = isNew
    ? null
    : mountNeonSync($('#syncSlot', root), {
        getEvent: () => event,
        getLocationName: () => locations.find((l) => l.id === event?.locationId)?.name || '',
      });

  unsubs.push(
    watchLocations((rows) => {
      locations = rows;
      if (formReady || isNew) renderLocations();
      sync?.update();
    }),
  );

  if (isNew) {
    fillForm({ name: '', date: ymd(), startTime: '09:00', endTime: '11:00', format: 'in-person' });
    formReady = true;
    showBody();
    nameEl.focus();
  } else {
    unsubs.push(
      watchEvent(eventId, (e) => {
        event = e;
        if (!e) {
          $('#state', root).hidden = false;
          $('#state', root).textContent = 'Event not found (it may have been deleted).';
          $('#body', root).hidden = true;
          return;
        }
        // Fill the form once so live updates never clobber in-progress edits.
        if (!formReady) {
          fillForm(e);
          formReady = true;
        }
        showBody();
        renderSummary();
        renderMerge();
        sync?.update();
      }),
    );
  }

  const stopPresence =
    !isNew && ctx?.user ? mountPresence($('#presence', root), { eventId, uid: ctx.user.uid, name: (ctx.name || '').trim() || ctx.user.email || 'Someone', where: 'details' }) : () => {};

  return () => (stopPresence(), sync?.destroy(), unsubs.forEach((u) => u()));
}
