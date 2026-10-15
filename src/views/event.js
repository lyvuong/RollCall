import {
  watchEvent,
  watchPeople,
  watchLocations,
  createEvent,
  updateEvent,
  deleteEvent,
  setAttendance,
  setRole,
  addPerson,
  fetchRecentEvents,
} from '../data.js';
import { esc, $, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { ymd, eventHours, countRoles, totalVolunteerHours, personKind, roleOf, needsVolunteers, formatHours, formatTime } from '../lib/time.js';

const FORMAT_LABEL = { virtual: 'Virtual', 'in-person': 'In person', both: 'Hybrid' };
const KIND_LABEL = { osg: 'OSG member', community: 'Community' };
const KIND_ICON = { osg: icon('star'), community: icon('users') };
const initials = (name) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const tint = (name) => [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 4;

export function eventView(root, _ctx, eventId) {
  const isNew = !eventId;
  let event = isNew ? null : undefined; // undefined = loading, null = not found
  let people = [];
  let locations = [];
  let search = '';
  let formReady = false;
  let locationId = '';
  let template = null; // past event chosen from suggestions
  let recent = []; // distinct past events, newest first
  let suggestions = [];
  let active = -1;
  const unsubs = [];

  root.innerHTML = `
    <section class="bar">
      <a class="btn ghost" href="#/">${icon('back')} Events</a>
    </section>
    <h1 id="title" style="margin-bottom:14px">${isNew ? 'New event' : 'Event'}</h1>
    <p id="state" class="muted">${isNew ? '' : 'Loading…'}</p>
    <div id="body" hidden>
      <form id="f" class="card form" autocomplete="off">
        <div class="field suggest-wrap">
          <label for="name" class="lbl">${icon('edit')} Name</label>
          <input id="name" class="input" required maxlength="120"
                 ${isNew ? 'role="combobox" aria-expanded="false" aria-controls="sugg" aria-autocomplete="list" placeholder="Start typing to reuse a past event…"' : ''} />
          ${isNew ? '<ul id="sugg" class="suggest" role="listbox" hidden></ul>' : ''}
        </div>
        <div id="prefill" class="notice" hidden></div>
        <label class="field"><span class="lbl">${icon('file')} Description</span>
          <textarea id="desc" class="input" rows="3" maxlength="1000"></textarea></label>
        <div class="grid3">
          <label class="field"><span class="lbl">${icon('calendar')} Date</span>
            <input id="date" type="date" class="input" required /></label>
          <label class="field"><span class="lbl">${icon('clock')} Start</span>
            <input id="start" type="time" class="input" required /></label>
          <label class="field"><span class="lbl">${icon('clock')} End</span>
            <input id="end" type="time" class="input" required /></label>
        </div>
        <label class="field"><span class="lbl">${icon('globe')} Format</span>
          <select id="format" class="input">
            <option value="in-person">In person</option>
            <option value="virtual">Virtual</option>
            <option value="both">Both (hybrid)</option>
          </select>
        </label>
        <label class="field" id="locWrap"><span class="lbl">${icon('pin')} Location</span>
          <select id="location" class="input"></select>
        </label>
        <div class="actions">
          <button class="btn primary" type="submit">${icon('save')} ${isNew ? 'Create event' : 'Save changes'}</button>
          ${isNew ? '' : `<button class="btn danger" type="button" id="del">${icon('trash')} Delete</button>`}
        </div>
      </form>
      ${
        isNew
          ? `<p class="muted">${icon('users')} Save the event, then take roll call.</p>`
          : `
      <section class="card" id="summary" aria-label="Summary"></section>
      <section class="card">
        <h2>${icon('users')} Roll call</h2>
        <div class="inputicon">${icon('search')}
          <input id="search" class="input" type="search" placeholder="Search names…" aria-label="Search names" />
        </div>
        <ul id="people" class="checklist"></ul>
        <form id="addForm" class="add">
          <input id="newName" class="input" placeholder="New person's name" maxlength="80" required aria-label="New person's name" />
          <select id="newType" class="input" aria-label="Type">
            <option value="community">Community member</option>
            <option value="osg">OSG member</option>
          </select>
          <button class="btn" type="submit">${icon('userPlus')} Add &amp; check in</button>
        </form>
      </section>`
      }
    </div>`;

  const f = $('#f', root);

  /* ----- form ----- */

  function renderLocations() {
    const sel = $('#location', root);
    sel.innerHTML =
      `<option value="">— Select —</option>` +
      locations.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
    sel.value = locationId;
    if (sel.value !== locationId) sel.value = '';
  }

  function syncLocationVisibility() {
    $('#locWrap', root).hidden = $('#format', root).value === 'virtual';
  }

  function fillForm(e) {
    $('#name', root).value = e.name;
    $('#desc', root).value = e.description || '';
    $('#date', root).value = e.date;
    $('#start', root).value = e.startTime;
    $('#end', root).value = e.endTime;
    $('#format', root).value = e.format;
    locationId = e.locationId || '';
    renderLocations();
    syncLocationVisibility();
    if (!isNew) $('#title', root).textContent = e.name;
  }

  function showBody() {
    $('#state', root).hidden = true;
    $('#body', root).hidden = false;
  }

  $('#format', root).onchange = syncLocationVisibility;
  $('#location', root).onchange = (ev) => (locationId = ev.target.value);

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
      toast('Saved');
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
          ? `<div class="notice warn">${icon('alert')} <span>${formatHours(event.volunteerHours)} volunteer hours were recorded for this event, but no volunteers are identified. Tap the role button next to each volunteer below.</span></div>`
          : ''
      }
      <div class="summary">
        <div class="stat" title="Hours per event">${icon('clock')}<span>${formatHours(hours)}</span>hrs<span class="wide"> / event</span></div>
        <div class="stat" title="Volunteers">${icon('heart')}<span>${volunteers}</span><span class="wide">volunteers</span><span class="narrow">vols</span></div>
        <div class="stat" title="Participants">${icon('users')}<span>${participants}</span><span class="wide">participants</span><span class="narrow">parts</span></div>
        <div class="stat total" title="Total volunteer hours">${icon('hourglass')}<span>${formatHours(totalVolunteerHours(event))}</span>hrs<span class="wide"> total</span></div>
      </div>`;
  }

  function renderPeople() {
    const ul = $('#people', root);
    if (!ul || !event) return;
    const attendees = event.attendees || {};
    const byId = new Map(people.map((p) => [p.id, p]));
    // Include attendees whose person record was since deleted.
    for (const [id, a] of Object.entries(attendees)) if (!byId.has(id)) byId.set(id, { id, ...a });
    const q = search.trim().toLowerCase();
    const rows = [...byId.values()]
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (!rows.length) {
      ul.innerHTML = `<li class="empty">${
        byId.size ? 'No matching names.' : 'No saved names yet. Add the first person below.'
      }</li>`;
      return;
    }
    ul.innerHTML = rows
      .map((p) => {
        const kind = personKind(p.type);
        const here = attendees[p.id];
        const vol = here && roleOf(here) === 'volunteer';
        return `
      <li class="rowrole">
        <label class="check">
          <input type="checkbox" data-id="${esc(p.id)}" ${here ? 'checked' : ''} />
          <span class="box">${icon('check')}</span>
          <span class="avatar av${tint(p.name)}">${esc(initials(p.name))}</span>
          <span class="nm">${esc(p.name)}</span>
          <span class="badge ${kind}" title="${KIND_LABEL[kind]}">${KIND_ICON[kind]}<span class="wide">${KIND_LABEL[kind]}</span></span>
        </label>
        ${
          here
            ? `<button type="button" class="role ${vol ? 'on' : ''}" data-role="${esc(p.id)}" aria-pressed="${vol}"
                 title="${vol ? 'Volunteer (tap to make Participant)' : 'Participant (tap to make Volunteer)'}">
                 ${icon(vol ? 'heart' : 'users')}<span class="wide">${vol ? 'Volunteer' : 'Participant'}</span></button>`
            : ''
        }
      </li>`;
      })
      .join('');
  }

  const peopleList = $('#people', root);
  if (peopleList) {
    peopleList.onclick = (ev) => {
      const btn = ev.target.closest('button[data-role]');
      if (!btn || !event) return;
      const cur = roleOf((event.attendees || {})[btn.dataset.role]);
      setRole(eventId, btn.dataset.role, cur === 'volunteer' ? 'participant' : 'volunteer').catch(() =>
        toast('Could not update.'),
      );
    };
    peopleList.onchange = (ev) => {
      const box = ev.target.closest('input[type=checkbox]');
      if (!box || !event) return;
      const p =
        people.find((x) => x.id === box.dataset.id) ||
        { id: box.dataset.id, ...(event.attendees || {})[box.dataset.id] };
      setAttendance(eventId, p, box.checked).catch(() => toast('Could not update.'));
    };
    $('#search', root).oninput = (ev) => {
      search = ev.target.value;
      renderPeople();
    };
    $('#addForm', root).onsubmit = (ev) => {
      ev.preventDefault();
      const nameEl2 = $('#newName', root);
      const name = nameEl2.value.trim().replace(/\s+/g, ' ');
      if (!name) return;
      const existing = people.find((p) => p.name.toLowerCase() === name.toLowerCase());
      let person = existing;
      if (!person) {
        const created = addPerson(name, $('#newType', root).value);
        created.done.catch(() => toast('Could not save person.'));
        person = created.person;
      }
      setAttendance(eventId, person, true).catch(() => toast('Could not check in.'));
      toast(existing ? `${existing.name} already saved — checked in` : `${name} added`);
      nameEl2.value = '';
      search = '';
      $('#search', root).value = '';
    };
  }

  /* ----- subscriptions ----- */

  unsubs.push(
    watchLocations((rows) => {
      locations = rows;
      if (formReady || isNew) renderLocations();
    }),
  );

  if (isNew) {
    fillForm({ name: '', date: ymd(), startTime: '09:00', endTime: '11:00', format: 'in-person' });
    formReady = true;
    showBody();
    nameEl.focus();
  } else {
    unsubs.push(
      watchPeople((rows) => {
        people = rows;
        renderPeople();
      }),
    );
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
        renderPeople();
      }),
    );
  }

  return () => unsubs.forEach((u) => u());
}
