import { watchEvent, watchLocations, watchPeople, setAttendance, setRole, addPerson, markRegistrant, saveRegistrants, searchNeonPeople, linkPerson, watchRoster } from '../data.js';
import { esc, $, toast } from '../lib/dom.js';
import { fetchNeonRegistrants } from '../lib/neonApi.js';
import { registrantUpdates, isImminent } from '../lib/neon.js';
import { icon } from '../lib/icons.js';
import { mountNeonSync } from './neonSync.js';
import { renderMergeSlot } from './neonMerge.js';
import { mountPresence } from '../lib/presence.js';
import { rosterMap, fixedRole as fixedRoleIn } from '../lib/roster.js';
import { ymd, countRoles, personKind, roleOf, formatDay, eventHours, formatHours, totalVolunteerHours } from '../lib/time.js';

const KIND = { osg: { label: 'OSG', icon: 'star' }, community: { label: 'Community', icon: 'users' } };
const MAX_RESULTS = 12;

/** Participants editor: remove people from an event, or search saved people and add them. */
export function participantsView(root, ctx, eventId) {
  let event;
  let people = [];
  let q = '';
  let neonHits = []; // OSG Website people matching q (Firestore neonPeople), fetched as the user types
  let neonTimer;
  let whoIs = new Map(); // lower-case name -> 'staff' | 'volunteer', for members who said which they are
  const removed = new Set(); // staged removals, applied on Done
  const roleEdits = new Map(); // staged role changes (id -> role), applied on Done
  const regEdits = new Map(); // staged Here / Missing choices for registered names (key -> status), applied on Done
  const addEdits = new Map(); // staged adds from the search box (id 'add:...' -> {name, type, person|neon|isNew}), applied on Done
  let regQ = ''; // filter for a long registered list
  let neonAttended = new Map(); // registrant key (attendeeId) -> attended on the OSG Website, from the latest sync check
  /** On the roll (saved, not staged for removal) under this name? */
  /** Roll entries staged to leave: removed by hand, or named on a registered row just set to Missing. */
  const goneIds = () => {
    const leaving = (k, r) => regEdits.get(k) === 'missing' || (regEdits.get(k) === 'pending' && r.status === 'present'); // staged Missing, or un-confirmed Here
    const missing = new Set(Object.entries(event?.registrants || {}).filter(([k, r]) => leaving(k, r)).map(([, r]) => r.name.toLowerCase()));
    const out = new Set(removed);
    for (const [id, a] of Object.entries(event?.attendees || {})) if (missing.has(a.name.toLowerCase())) out.add(id);
    return out;
  };
  const onRollWith = (gone, name) => Object.entries(event?.attendees || {}).some(([id, a]) => !gone.has(id) && a.name.toLowerCase() === String(name).toLowerCase());
  const onRoll = (name) => onRollWith(goneIds(), name);
  /**
   * The saved status, except: a confirmed Here whose person is no longer on the roll counts as Missing (so the OSG
   * Website gets unchecked), and an unconfirmed name the OSG Website has as attended shows as Here.
   */
  const baseStatus = (r) => {
    if (r.status === 'present' && !onRollWith(removed, r.name)) return 'missing'; // by hand only: a staged tap on this row must not change what it is measured against
    if (!r.status || r.status === 'pending') return neonAttended.get(String(r.key)) === true ? 'present' : 'pending';
    return r.status;
  };
  const regStatus = (r) => regEdits.get(r.key) ?? baseStatus(r);
  /** Attended on the OSG Website, but not confirmed in RollCall (so not on the roll): shown as neither Here nor Missing. */
  const neonOnly = (r) => !regEdits.has(r.key) && (!r.status || r.status === 'pending') && neonAttended.get(String(r.key)) === true;
  const shownStatus = (r) => (neonOnly(r) ? 'pending' : regStatus(r));
  /** Known members have a fixed role at every event: a volunteer is always a volunteer, staff always a participant. */
  const fixedRole = (name) => fixedRoleIn(whoIs, name);
  const effRole = (id, a) => fixedRole(a?.name) || roleEdits.get(id) || roleOf(a);
  // The "Add me" button stages the signed-in staff member as a volunteer (nothing is added automatically).
  let peopleLoaded = false;
  let selfStaged = false;
  const selfName = (ctx?.name || '').trim();
  const selfRole = ctx?.role === 'staff' ? 'participant' : 'volunteer'; // staff are never volunteers
  const selfPerson = () => people.find((x) => x.name.toLowerCase() === selfName.toLowerCase());
  const selfId = () => selfPerson()?.id || '__self__';
  /** Id of the signed-in staff member's entry already saved on the event, if any. */
  const myEntryId = () =>
    selfName ? Object.entries(event?.attendees || {}).find(([, a]) => a.name.toLowerCase() === selfName.toLowerCase())?.[0] : undefined;
  /** Registered names staged as Here but not saved yet, shown among the participants as a preview (id 'reg:<key>'). */
  const stagedHere = () => {
    const have = new Set(Object.values(event?.attendees || {}).map((a) => a.name.toLowerCase()));
    const adds = Object.entries(Object.fromEntries(addEdits))
      .filter(([, a]) => !have.has(a.name.toLowerCase()))
      .map(([id, a]) => [id, { name: a.name, type: a.type, role: 'participant', staged: true }]);
    return Object.fromEntries([
      ...adds,
      ...Object.entries(event?.registrants || {})
        .filter(([key, r]) => !r.cancelled && regEdits.get(key) === 'present' && !have.has(r.name.toLowerCase()))
        .map(([key, r]) => [`reg:${key}`, { name: r.name, type: people.find((x) => x.name.toLowerCase() === r.name.toLowerCase())?.type || 'community', role: 'participant', staged: true }]),
    ]);
  };
  const fullAtt = () => ({
    ...(event?.attendees || {}),
    ...stagedHere(),
    ...(selfStaged ? { [selfId()]: { name: selfName, type: selfPerson()?.type || 'osg', role: selfRole } } : {}),
  });
  const unsubs = [];
  let regTried = false;

  /**
   * Fetch an event's registered names once when the page opens: for an event with none stored (imported earlier, or
   * the fetch failed then), and for today's and tomorrow's events, whose sign-ups and cancellations can change
   * without Neon's counts moving.
   */
  async function backfillRegistrants() {
    if (regTried || !event?.neonEventId) return;
    if (event.registrants && !isImminent(event.date, ymd())) return;
    regTried = true;
    try {
      const map = registrantUpdates(await fetchNeonRegistrants(event.neonEventId), event.registrants);
      if (Object.keys(map).length) await saveRegistrants(eventId, map);
    } catch {
      if (!event.registrants) toast('Could not load registered names from the OSG Website.');
    }
  }

  /** Manual check for sign-ups made on the OSG Website since the names were last fetched. */
  async function refreshRegistrants() {
    const btn = $('#regRefresh', root);
    if (!event?.neonEventId || btn.disabled) return;
    btn.disabled = true;
    try {
      const map = registrantUpdates(await fetchNeonRegistrants(event.neonEventId, { force: true }), event.registrants);
      const added = Object.values(map).filter((r) => r.name).length;
      const dropped = Object.values(map).filter((r) => r.cancelled === true).length;
      if (Object.keys(map).length) await saveRegistrants(eventId, map);
      toast(
        added || dropped
          ? [added && `${added} new registration${added === 1 ? '' : 's'}`, dropped && `${dropped} cancelled`].filter(Boolean).join(', ')
          : 'No changes on the OSG Website',
      );
    } catch {
      toast('Could not reach the OSG Website.');
    }
    btn.disabled = false;
  }

  root.innerHTML = `
    <section class="bar">
      <a class="btn ghost" href="#/">${icon('back')} Events</a>
      <span class="bar-actions">
        <span class="sync-slot"><span id="mergeSlot"></span><span id="syncSlot"></span></span>
        <a class="btn ghost" href="#/event/${esc(eventId)}">${icon('edit')} Event details</a>
      </span>
    </section>
    <div id="presence" class="pres-row"></div>
    <p id="state" class="muted">Loading…</p>
    <div id="body" hidden>
      <h1 id="title" style="margin-bottom:4px"></h1>
      <p id="sub" class="muted" style="margin-top:0"></p>
      <section class="card" id="regCard" hidden>
        <h2 id="regTitle"></h2>
        <p class="muted tiny">Registered on the OSG Website. Confirm who showed up.
          <button type="button" class="btn small ghost" id="regRefresh" title="Check the OSG Website for new registrations">${icon('swap')}<span class="wide">Refresh</span></button></p>
        <div class="inputicon regfind" id="regFind" hidden>${icon('search')}
          <input id="regQ" class="input" type="search" placeholder="Find a registered name…" aria-label="Find a registered name" autocomplete="off" />
        </div>
        <ul id="regList" class="plist scroll"></ul>
      </section>
      <section class="card">
        <div class="inputicon">${icon('search')}
          <input id="q" class="input" type="search" placeholder="Search a name to add…" aria-label="Search saved people to add" autocomplete="off" />
        </div>
        <ul id="results" class="plist"></ul>
      </section>
      <section class="card">
        <div class="sechead">
          <h2 id="listTitle">${icon('users')} Participants</h2>
          ${selfName ? `<button type="button" class="btn small" id="selfToggle" aria-pressed="false" aria-label="Add me to this event" title="Add me to this event">${icon('heart')}<span class="selftxt"> Add me</span></button>` : ''}
        </div>
        <p class="legend tiny"><span class="osg">OSG</span><span class="community">Community</span><span class="vol">${icon('heart')} Volunteer</span><span class="staff">${icon('shield')} Staff</span></p>
        <div id="current" class="inl"></div>
        <button type="button" id="done" class="btn primary block">Done</button>
      </section>
    </div>`;

  $('#regRefresh', root).onclick = refreshRegistrants;

  const chip = (p) => {
    const k = KIND[personKind(p.type)];
    return `<span class="badge ${personKind(p.type)}" title="${k.label}">${icon(k.icon)}<span class="wide">${k.label}</span></span>`;
  };

  /** The saved person an OSG Website person stands for: linked by account id, else the same name not yet linked. */
  const savedFor = (n) =>
    people.find((p) => p.neonAccountId === n.neonAccountId) ||
    people.find((p) => !p.neonAccountId && p.name.toLowerCase() === n.name.toLowerCase());

  function render() {
    if (event === undefined) return;
    if (!event) {
      $('#state', root).textContent = 'Event not found (it may have been deleted).';
      return;
    }
    $('#state', root).hidden = true;
    $('#body', root).hidden = false;
    backfillRegistrants();
    $('#title', root).textContent = event.name;

    const mine = myEntryId();
    const gone = goneIds();
    const selfOn = selfStaged || (mine && !gone.has(mine));
    const tog = $('#selfToggle', root);
    if (tog) {
      tog.setAttribute('aria-pressed', String(!!selfOn));
      tog.classList.toggle('primary', !!selfOn);
    }
    const att = fullAtt();
    const kept = Object.fromEntries(
      Object.entries(att)
        .filter(([id]) => !gone.has(id))
        .map(([id, a]) => [id, { ...a, role: effRole(id, a) }]),
    );
    const { volunteers, participants } = countRoles(kept);
    const saved = totalVolunteerHours(event);
    const next = totalVolunteerHours({ ...event, attendees: kept });
    const hoursHtml =
      next !== saved
        ? `<s class="old">${formatHours(saved)}</s> <b>${formatHours(next)}</b> hrs`
        : `${formatHours(saved)} hrs`;
    $('#sub', root).innerHTML = `${esc(formatDay(event.date))} · ${icon('clock')} ${formatHours(eventHours(event.startTime, event.endTime))} hrs · ${icon('heart')} ${volunteers} · ${icon('users')} ${participants} · ${icon('hourglass')} ${hoursHtml}`;
    const pending = removed.size + roleEdits.size + regEdits.size + addEdits.size + (selfStaged ? 1 : 0);
    $('#done', root).textContent = pending ? `Save ${pending} change${pending === 1 ? '' : 's'} & done` : 'Done';
    $('#listTitle', root).innerHTML = `${icon('users')} Participants (${Object.keys(att).length})`;

    // registered on Neon One: staff only confirm Here / Missing
    const regs = Object.entries(event.registrants || {})
      .map(([key, r]) => ({ key, ...r }))
      .sort((a, b) => a.name.localeCompare(b.name));
    $('#regCard', root).hidden = !regs.length;
    if (regs.length) {
      const live = regs.filter((r) => !r.cancelled);
      const n = (st) => live.filter((r) => shownStatus(r) === st).length;
      const dropped = regs.length - live.length;
      $('#regTitle', root).innerHTML = `${icon('check')} Registered (${live.length}) <span class="muted tiny">${n('present')} here · ${n('missing')} missing · ${n('pending')} to confirm${dropped ? ` · ${dropped} cancelled` : ''}</span>`;
      const LONG = 12; // lists longer than this get a name filter
      $('#regFind', root).hidden = regs.length <= LONG;
      const term = regs.length > LONG ? regQ.trim().toLowerCase() : '';
      const shown = term ? regs.filter((r) => r.name.toLowerCase().includes(term)) : regs;
      const list = $('#regList', root);
      const scrolled = list.scrollTop; // re-rendering must not jump the list back to the top
      list.innerHTML = shown
        .map((r) => {
          const st = shownStatus(r);
          const nm = esc(r.name);
          const btn = (kind, ic, label, cls) =>
            `<button type="button" class="btn small${st === kind ? ` ${cls}` : ' ghost'}" data-reg="${esc(r.key)}" data-st="${kind}" aria-pressed="${st === kind}" aria-label="${label}: ${nm}" title="${st === kind ? 'Tap to undo' : label}">${icon(ic)}<span class="wide">${label}</span></button>`;
          return `<li class="prow${r.cancelled ? ' cancelled' : ''}"><span class="nm">${nm}${r.cancelled ? ' <span class="muted tiny">cancelled on the OSG Website</span>' : neonOnly(r) ? ' <span class="muted tiny" title="Checked in on the OSG Website but not on your roll. Tap Here to add them, or Missing to uncheck them there.">attended on OSG</span>' : ''}</span>${btn('present', 'check', 'Here', 'primary')}${btn('missing', 'x', 'Missing', 'danger')}</li>`;
        })
        .join('') || '<li class="muted tiny">No registered names match.</li>';
      list.scrollTop = scrolled;
    }

    // current attendees
    const cur = Object.entries(att)
      .map(([id, a]) => ({ id, ...a }))
      .sort((a, b) => a.name.localeCompare(b.name));
    $('#current', root).innerHTML = cur.length
      ? cur
          .map((a, i) => {
            const vol = effRole(a.id, a) === 'volunteer';
            const kind = personKind(a.type);
            const isGone = gone.has(a.id);
            const nm = esc(a.name);
            const fixed = fixedRole(a.name);
            const whoIcon = whoIs.get(a.name.toLowerCase()) === 'staff' ? `<span class="who" title="Staff">${icon('shield')}</span>` : '';
            return `<span class="pn ${kind}${whoIs.get(a.name.toLowerCase()) === 'staff' ? ' staff' : ''}${isGone ? ' gone' : ''}${a.staged ? ' staged' : ''}"><button type="button" class="pname" data-role="${esc(a.id)}" aria-pressed="${vol}" title="${KIND[kind].label} · ${fixed ? (vol ? 'Volunteer' : 'Staff') : vol ? 'Volunteer (tap for Participant)' : 'Participant (tap for Volunteer)'}">${vol ? icon('heart') : ''}${whoIcon}${nm}</button><button type="button" class="mb del${isGone ? ' on' : ''}" data-del="${esc(a.id)}" aria-label="${isGone ? 'Keep' : 'Remove'} ${nm}" title="${isGone ? 'Undo remove' : 'Remove'}">${icon(isGone ? 'plus' : 'minus')}</button>${i < cur.length - 1 ? '<span class="sep">,</span>' : ''}</span>`;
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
    // OSG Website people come first; a saved person they stand for is shown once, as the OSG Website row.
    const stagedNames = new Set(Object.values(att).filter((a) => a.staged).map((a) => a.name.toLowerCase()));
    const fromNeon = neonHits.filter((n) => !att[savedFor(n)?.id] && !stagedNames.has(n.name.toLowerCase()));
    const shownAsNeon = new Set(neonHits.map((n) => savedFor(n)?.id).filter(Boolean));
    const hits = people.filter((p) => !att[p.id] && !stagedNames.has(p.name.toLowerCase()) && !shownAsNeon.has(p.id) && p.name.toLowerCase().includes(term));
    const rows = hits.slice(0, MAX_RESULTS);
    const exact = people.some((p) => p.name.toLowerCase() === term);
    res.innerHTML =
      fromNeon
        .map(
          (n) => `
        <li class="prow">
          <span class="nm">${esc(n.name)}${n.email ? ` <span class="muted small">${esc(n.email)}</span>` : ''}</span>
          <span class="muted small">OSG Website</span>
          <button type="button" class="ibadge add" data-neon="${esc(n.neonAccountId)}" aria-label="Add ${esc(n.name)}" title="Add">${icon('plus')}</button>
        </li>`,
        )
        .join('') +
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
      (!hits.length && !fromNeon.length && people.some((p) => p.name.toLowerCase().includes(term)) && !exact
        ? `<li class="muted small">Everyone matching is already on this event.</li>`
        : '') +
      (!exact && !fromNeon.length && !people.some((p) => p.name.toLowerCase().includes(term))
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
    const att = fullAtt();
    if (t.id === 'selfToggle') {
      const mine = myEntryId();
      if (mine) (removed.has(mine) ? removed.delete(mine) : removed.add(mine));
      else selfStaged = !selfStaged;
      render();
      return;
    }
    if (t.dataset.reg) {
      const r = event.registrants?.[t.dataset.reg];
      if (!r) return;
      // Staged only: nothing is saved (or added to the roll) until Done.
      const shown = regStatus({ key: t.dataset.reg, ...r });
      // Here shown only because the OSG Website says so: tapping it confirms them (adds them to the roll).
      const fromNeon = shown === 'present' && !regEdits.has(t.dataset.reg) && (r.status || 'pending') === 'pending';
      // Tapping the choice already staged on this row cancels it, back to what is saved.
      if (regEdits.has(t.dataset.reg) && shown === t.dataset.st) {
        regEdits.delete(t.dataset.reg);
        render();
        return;
      }
      const next = shown === t.dataset.st && !fromNeon ? 'pending' : t.dataset.st;
      if (!fromNeon && next === baseStatus(r)) regEdits.delete(t.dataset.reg);
      else regEdits.set(t.dataset.reg, next);
      render();
      return;
    }
    if (t.dataset.del) {
      const id = t.dataset.del;
      if (id.startsWith('reg:')) regEdits.delete(id.slice(4));
      else if (id.startsWith('add:')) addEdits.delete(id);
      else if (selfStaged && id === selfId()) selfStaged = false;
      else if (removed.has(id)) removed.delete(id);
      else removed.add(id);
      render();
    } else if (t.id === 'done') {
      const saved = event.attendees || {};
      const leaving = goneIds();
      const jobs = [...leaving].filter((id) => saved[id]).map((id) => setAttendance(eventId, { id, ...saved[id] }, false));
      for (const [id, role] of roleEdits) if (saved[id] && !leaving.has(id)) jobs.push(setRole(eventId, id, role));
      // Known staff and volunteers get their fixed role, whatever an earlier roll recorded.
      for (const [id, a] of Object.entries(saved)) {
        const want = fixedRole(a.name);
        if (want && want !== roleOf(a) && !leaving.has(id) && !roleEdits.has(id)) jobs.push(setRole(eventId, id, want));
      }
      if (selfStaged) {
        let me = selfPerson();
        if (!me) {
          const created = addPerson(selfName, 'osg');
          created.done.catch(() => toast('Could not save person.'));
          me = created.person;
        }
        jobs.push(setAttendance(eventId, me, true, roleEdits.get(selfId()) || selfRole));
      }
      for (const a of addEdits.values()) {
        let person = a.person;
        if (a.neon) {
          person = savedFor(a.neon);
          if (person) {
            if (!person.neonAccountId) linkPerson(person.id, a.neon.neonAccountId).catch(() => toast('Could not link person.'));
          } else {
            const created = addPerson(a.name, 'community', { neonAccountId: a.neon.neonAccountId });
            created.done.catch(() => toast('Could not save person.'));
            person = created.person;
          }
        } else if (a.isNew) {
          const created = addPerson(a.name, a.type);
          created.done.catch(() => toast('Could not save person.'));
          person = created.person;
        }
        jobs.push(setAttendance(eventId, person, true, fixedRole(person.name) || 'participant'));
      }
      // A person taken off the roll is no longer confirmed Here: their registered name becomes Missing.
      for (const [key, r] of Object.entries(event.registrants || {})) {
        if (r.status === 'present' && !regEdits.has(key) && !onRoll(r.name)) jobs.push(markRegistrant(eventId, { key, ...r }, 'missing', null));
      }
      for (const [key, next] of regEdits) {
        const r = event.registrants?.[key];
        if (!r) continue;
        let person = null;
        if (next === 'present') {
          const same = (x) => x.name.toLowerCase() === r.name.toLowerCase();
          const there = Object.entries(event.attendees || {}).find(([, a]) => same(a));
          const known = people.find(same);
          if (there) person = { id: there[0], name: there[1].name, alreadyThere: true };
          else if (known) person = known;
          else {
            const created = addPerson(r.name, 'community');
            created.done.catch(() => toast('Could not save person.'));
            person = created.person;
          }
        }
        jobs.push(markRegistrant(eventId, { key, ...r }, next, person));
      }
      removed.clear();
      roleEdits.clear();
      regEdits.clear();
      addEdits.clear();
      const saving = Promise.all(jobs).catch(fail);
      const leave = () => (location.hash = '#/');
      if (!event.neonEventId) return leave();
      // Linked to the OSG Website: if saving left it out of sync, stay so the changes can be sent first.
      t.disabled = true;
      t.textContent = 'Saving…';
      Promise.race([saving, new Promise((r) => setTimeout(r, 1500))])
        .then(() => new Promise((r) => setTimeout(r, 300))) // let the page see its own saved data
        .then(() => sync.review(leave))
        .catch(() => false)
        .then((stayed) => {
          if (stayed) {
            t.disabled = false;
            t.textContent = 'Done';
          } else leave();
        });
      return;
    } else if (t.dataset.role) {
      const id = t.dataset.role;
      if (id.startsWith('reg:') || id.startsWith('add:')) {
        toast('Save first, then change their role.');
        return;
      }
      if (fixedRole(att[id]?.name)) {
        toast(fixedRole(att[id].name) === 'volunteer' ? 'Volunteers are always volunteers.' : 'Staff take part as participants, not volunteers.');
        return;
      }
      const next = effRole(id, att[id]) === 'volunteer' ? 'participant' : 'volunteer';
      if (selfStaged && id === selfId()) {
        if (next === 'volunteer') roleEdits.delete(id);
        else roleEdits.set(id, next);
      } else if (next === roleOf(att[id])) roleEdits.delete(id);
      else roleEdits.set(id, next);
      render();
    } else if (t.dataset.add) {
      const p = people.find((x) => x.id === t.dataset.add);
      if (p) {
        addEdits.set(`add:${p.id}`, { name: p.name, type: p.type, person: p });
        toast(`${p.name} will be added when you save`);
        render();
      }
    } else if (t.dataset.neon) {
      const n = neonHits.find((x) => x.neonAccountId === t.dataset.neon);
      if (n) {
        addEdits.set(`add:n${n.neonAccountId}`, { name: n.name, type: savedFor(n)?.type || 'community', neon: n });
        toast(`${n.name} will be added when you save`);
        q = '';
        neonHits = [];
        $('#q', root).value = '';
        render();
      }
    } else if (t.dataset.new) {
      const name = q.trim().replace(/\s+/g, ' ');
      if (!name) return;
      addEdits.set(`add:new:${name.toLowerCase()}`, { name, type: t.dataset.new, isNew: true });
      toast(`${name} will be added when you save`);
      q = '';
      $('#q', root).value = '';
      render();
    }
  });

  $('#regQ', root).oninput = (ev) => {
    regQ = ev.target.value;
    render();
  };

  $('#q', root).oninput = (ev) => {
    q = ev.target.value;
    render();
    clearTimeout(neonTimer);
    const asked = q;
    if (!asked.trim()) {
      neonHits = [];
      return;
    }
    neonTimer = setTimeout(async () => {
      try {
        const hits = await searchNeonPeople(asked);
        if (q !== asked) return; // typed on since
        neonHits = hits;
        render();
      } catch {
        /* the list is a bonus: saved people still work without it */
      }
    }, 250);
  };

  let locations = [];
  const renderMerge = () => renderMergeSlot($('#mergeSlot', root), event, locations.find((l) => l.id === event?.locationId)?.name || '');
  const sync = mountNeonSync($('#syncSlot', root), {
    getEvent: () => event,
    getLocationName: () => locations.find((l) => l.id === event?.locationId)?.name || '',
    onSnapshot: (list) => {
      neonAttended = new Map((list || []).map((a) => [String(a.attendeeId), a.markedAttended === true]));
      render();
    },
  });

  unsubs.push(
    watchLocations((rows) => {
      locations = rows;
      renderMerge();
      sync.update();
    }),
    watchPeople((rows) => {
      people = rows;
      peopleLoaded = true;
      render();
    }),
    watchRoster((rows) => {
      whoIs = rosterMap(rows);
      render();
    }),
    watchEvent(eventId, (e) => {
      event = e;
      render();
      renderMerge();
      sync.update();
    }),
  );

  const stopPresence = ctx?.user ? mountPresence($('#presence', root), { eventId, uid: ctx.user.uid, name: selfName || ctx.user.email || 'Someone', where: 'participants' }) : () => {};

  return () => {
    stopPresence();
    clearTimeout(neonTimer);
    sync.destroy();
    unsubs.forEach((u) => u());
  };
}
