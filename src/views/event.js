import {
  watchEvent,
  watchPeople,
  watchLocations,
  createEvent,
  updateEvent,
  deleteEvent,
  setAttendance,
  addPerson,
} from '../data.js';
import { esc, $, toast } from '../lib/dom.js';
import { ymd, eventHours, countByType, formatHours } from '../lib/time.js';

export function eventView(root, _ctx, eventId) {
  const isNew = !eventId;
  let event = isNew ? null : undefined; // undefined = loading, null = not found
  let people = [];
  let locations = [];
  let search = '';
  let formReady = false;
  let locationId = '';
  const unsubs = [];

  root.innerHTML = `
    <section class="bar">
      <a class="btn link" href="#/">← Events</a>
      <h1 id="title">${isNew ? 'New event' : 'Event'}</h1>
    </section>
    <p id="state" class="muted">${isNew ? '' : 'Loading…'}</p>
    <div id="body" hidden>
      <form id="f" class="card form">
        <label>Name <input id="name" class="input" required maxlength="120" /></label>
        <label>Description <textarea id="desc" class="input" rows="3" maxlength="1000"></textarea></label>
        <div class="grid3">
          <label>Date <input id="date" type="date" class="input" required /></label>
          <label>Start <input id="start" type="time" class="input" required /></label>
          <label>End <input id="end" type="time" class="input" required /></label>
        </div>
        <label>Format
          <select id="format" class="input">
            <option value="in-person">In person</option>
            <option value="virtual">Virtual</option>
            <option value="both">Both (hybrid)</option>
          </select>
        </label>
        <label id="locWrap">Location
          <select id="location" class="input"></select>
        </label>
        <div class="actions">
          <button class="btn primary" type="submit">${isNew ? 'Create event' : 'Save changes'}</button>
          ${isNew ? '' : '<button class="btn danger" type="button" id="del">Delete</button>'}
        </div>
      </form>
      ${
        isNew
          ? '<p class="muted">Save the event, then take roll call.</p>'
          : `
      <section class="card" id="summary"></section>
      <section class="card">
        <h2>Roll call</h2>
        <input id="search" class="input" type="search" placeholder="Search names…" autocomplete="off" />
        <ul id="people" class="checklist"></ul>
        <form id="addForm" class="add">
          <input id="newName" class="input" placeholder="New person's name" maxlength="80" required />
          <select id="newType" class="input">
            <option value="volunteer">Volunteer</option>
            <option value="member">OSG member</option>
          </select>
          <button class="btn" type="submit">Add &amp; check in</button>
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
    $('#title', root).textContent = e.name;
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

  /* ----- roll call ----- */

  function renderSummary() {
    const el = $('#summary', root);
    if (!el || !event) return;
    const hours = eventHours(event.startTime, event.endTime);
    const { volunteers, members } = countByType(event.attendees);
    el.innerHTML = `
      <div class="summary">
        <div><span>${formatHours(hours)}</span>hrs / event</div>
        <div><span>${volunteers}</span>volunteers</div>
        <div><span>${members}</span>members</div>
        <div class="total"><span>${formatHours(hours * volunteers)}</span>total volunteer hrs</div>
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
      .map(
        (p) => `
      <li>
        <label class="check">
          <input type="checkbox" data-id="${esc(p.id)}" ${attendees[p.id] ? 'checked' : ''} />
          <span class="nm">${esc(p.name)}</span>
          <span class="badge ${p.type}">${p.type === 'volunteer' ? 'Volunteer' : 'Member'}</span>
        </label>
      </li>`,
      )
      .join('');
  }

  const peopleList = $('#people', root);
  if (peopleList) {
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
      const nameEl = $('#newName', root);
      const name = nameEl.value.trim().replace(/\s+/g, ' ');
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
      nameEl.value = '';
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
    const today = ymd();
    fillForm({ name: '', date: today, startTime: '09:00', endTime: '11:00', format: 'in-person' });
    $('#title', root).textContent = 'New event';
    formReady = true;
    showBody();
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
