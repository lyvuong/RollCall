import { watchEvent, watchPeople, setAttendance, setRole, addPerson } from '../data.js';
import { esc, $, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { countRoles, personKind, roleOf, formatDay, formatHours, totalVolunteerHours } from '../lib/time.js';

const KIND = { osg: { label: 'OSG', icon: 'star' }, community: { label: 'Community', icon: 'users' } };
const MAX_RESULTS = 12;

/** Participants editor: remove people from an event, or search saved people and add them. */
export function participantsView(root, _ctx, eventId) {
  let event;
  let people = [];
  let q = '';
  const unsubs = [];

  root.innerHTML = `
    <section class="bar">
      <a class="btn ghost" href="#/">${icon('back')} Events</a>
      <a class="btn ghost" href="#/event/${esc(eventId)}">${icon('edit')} Event details</a>
    </section>
    <p id="state" class="muted">Loading…</p>
    <div id="body" hidden>
      <h1 id="title" style="margin-bottom:4px"></h1>
      <p id="sub" class="muted" style="margin-top:0"></p>
      <section class="card">
        <div class="inputicon">${icon('search')}
          <input id="q" class="input" type="search" placeholder="Search a name to add…" aria-label="Search saved people to add" autocomplete="off" />
        </div>
        <ul id="results" class="plist"></ul>
      </section>
      <section class="card">
        <h2 id="listTitle">${icon('users')} Participants</h2>
        <p class="legend tiny"><span class="osg">OSG</span><span class="community">Community</span><span class="vol">♥ Volunteer</span><span class="muted">Tap a name to switch Participant ↔ Volunteer</span></p>
        <div id="current" class="inl"></div>
      </section>
    </div>`;

  const chip = (p) => {
    const k = KIND[personKind(p.type)];
    return `<span class="badge ${personKind(p.type)}" title="${k.label}">${icon(k.icon)}<span class="wide">${k.label}</span></span>`;
  };

  function render() {
    if (event === undefined) return;
    if (!event) {
      $('#state', root).textContent = 'Event not found (it may have been deleted).';
      return;
    }
    $('#state', root).hidden = true;
    $('#body', root).hidden = false;
    $('#title', root).textContent = event.name;

    const att = event.attendees || {};
    const { volunteers, participants } = countRoles(att);
    $('#sub', root).innerHTML = `${esc(formatDay(event.date))} · ${icon('heart')} ${volunteers} · ${icon('users')} ${participants} · ${icon('hourglass')} ${formatHours(totalVolunteerHours(event))} hrs`;
    $('#listTitle', root).innerHTML = `${icon('users')} Participants (${Object.keys(att).length})`;

    // current attendees
    const cur = Object.entries(att)
      .map(([id, a]) => ({ id, ...a }))
      .sort((a, b) => a.name.localeCompare(b.name));
    $('#current', root).innerHTML = cur.length
      ? cur
          .map((a, i) => {
            const vol = roleOf(a) === 'volunteer';
            const kind = personKind(a.type);
            return `<span class="pn ${kind}${vol ? ' vol' : ''}"><button type="button" class="pname" data-role="${esc(a.id)}" aria-pressed="${vol}"
              title="${esc(KIND[kind].label)} · ${vol ? 'Volunteer (tap for Participant)' : 'Participant (tap for Volunteer)'}">${vol ? icon('heart') : ''}${esc(a.name)}</button><button type="button" class="xbtn" data-del="${esc(a.id)}" aria-label="Remove ${esc(a.name)}" title="Remove">${icon('x')}</button>${i < cur.length - 1 ? '<span class="sep">,</span>' : ''}</span>`;
          })
          .join(' ')
      : `<span class="muted">No participants yet. Search above to add people.</span>`;

    // search results (people not yet on the event)
    const res = $('#results', root);
    const term = q.trim().toLowerCase();
    if (!term) {
      res.innerHTML = '';
      return;
    }
    const hits = people.filter((p) => !att[p.id] && p.name.toLowerCase().includes(term));
    const rows = hits.slice(0, MAX_RESULTS);
    const exact = people.some((p) => p.name.toLowerCase() === term);
    res.innerHTML =
      rows
        .map(
          (p) => `
        <li class="prow">
          <span class="nm">${esc(p.name)}</span>
          ${chip(p)}
          <button type="button" class="ibadge add" data-add="${esc(p.id)}" aria-label="Add ${esc(p.name)}" title="Add">${icon('plus')}</button>
        </li>`,
        )
        .join('') +
      (hits.length > rows.length ? `<li class="muted small">${hits.length - rows.length} more… keep typing to narrow down.</li>` : '') +
      (!hits.length && people.some((p) => p.name.toLowerCase().includes(term)) && !exact
        ? `<li class="muted small">Everyone matching is already on this event.</li>`
        : '') +
      (!exact && !people.some((p) => p.name.toLowerCase().includes(term))
        ? `<li class="prow newp">
            <span class="nm">New: ${esc(q.trim())}</span>
            <button type="button" class="btn small" data-new="community">${icon('userPlus')} Community</button>
            <button type="button" class="btn small" data-new="osg">${icon('userPlus')} OSG</button>
          </li>`
        : '');
  }

  const fail = () => toast('Could not update.');

  $('#body', root).addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t || !event) return;
    const att = event.attendees || {};
    if (t.dataset.del) {
      const a = att[t.dataset.del];
      if (a) setAttendance(eventId, { id: t.dataset.del, ...a }, false).catch(fail);
    } else if (t.dataset.role) {
      const cur = roleOf(att[t.dataset.role]);
      setRole(eventId, t.dataset.role, cur === 'volunteer' ? 'participant' : 'volunteer').catch(fail);
    } else if (t.dataset.add) {
      const p = people.find((x) => x.id === t.dataset.add);
      if (p) setAttendance(eventId, p, true).catch(fail);
    } else if (t.dataset.new) {
      const name = q.trim().replace(/\s+/g, ' ');
      if (!name) return;
      const created = addPerson(name, t.dataset.new);
      created.done.catch(() => toast('Could not save person.'));
      setAttendance(eventId, created.person, true).catch(fail);
      toast(`${name} added`);
      q = '';
      $('#q', root).value = '';
    }
  });

  $('#q', root).oninput = (ev) => {
    q = ev.target.value;
    render();
  };

  unsubs.push(
    watchPeople((rows) => {
      people = rows;
      render();
    }),
    watchEvent(eventId, (e) => {
      event = e;
      render();
    }),
  );

  return () => unsubs.forEach((u) => u());
}
