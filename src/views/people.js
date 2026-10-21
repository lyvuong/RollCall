import { watchEvent, watchPeople, setAttendance, setRole, addPerson, markRegistrant, saveRegistrants, searchNeonPeople, linkPerson } from '../data.js';
import { esc, $, toast } from '../lib/dom.js';
import { fetchNeonRegistrants } from '../lib/neonApi.js';
import { registrantMap } from '../lib/neon.js';
import { icon } from '../lib/icons.js';
import { countRoles, personKind, roleOf, formatDay, eventHours, formatHours, totalVolunteerHours } from '../lib/time.js';

const KIND = { osg: { label: 'OSG', icon: 'star' }, community: { label: 'Community', icon: 'users' } };
const MAX_RESULTS = 12;

/** Participants editor: remove people from an event, or search saved people and add them. */
export function participantsView(root, ctx, eventId) {
  let event;
  let people = [];
  let q = '';
  let neonHits = []; // OSG Website people matching q (Firestore neonPeople), fetched as the user types
  let neonTimer;
  const removed = new Set(); // staged removals, applied on Done
  const roleEdits = new Map(); // staged role changes (id -> role), applied on Done
  const effRole = (id, a) => roleEdits.get(id) || roleOf(a);
  // "Include myself" stages the signed-in staff member as a volunteer (nothing is added automatically).
  let peopleLoaded = false;
  let selfStaged = false;
  const selfName = (ctx?.name || '').trim();
  const selfRole = ctx?.role === 'staff' ? 'participant' : 'volunteer'; // staff are never volunteers
  const selfPerson = () => people.find((x) => x.name.toLowerCase() === selfName.toLowerCase());
  const selfId = () => selfPerson()?.id || '__self__';
  /** Id of the signed-in staff member's entry already saved on the event, if any. */
  const myEntryId = () =>
    selfName ? Object.entries(event?.attendees || {}).find(([, a]) => a.name.toLowerCase() === selfName.toLowerCase())?.[0] : undefined;
  const fullAtt = () => ({
    ...(event?.attendees || {}),
    ...(selfStaged ? { [selfId()]: { name: selfName, type: selfPerson()?.type || 'osg', role: selfRole } } : {}),
  });
  const unsubs = [];
  let regTried = false;

  /** A Neon event with no stored names (imported earlier, or the fetch failed then): fetch and save them once. */
  async function backfillRegistrants() {
    if (regTried || !event?.neonEventId || event.registrants) return;
    regTried = true;
    try {
      const map = registrantMap(await fetchNeonRegistrants(event.neonEventId), event.registrants);
      if (Object.keys(map).length) await saveRegistrants(eventId, map);
    } catch {
      toast('Could not load registered names from the OSG Website.');
    }
  }

  root.innerHTML = `
    <section class="bar">
      <a class="btn ghost" href="#/">${icon('back')} Events</a>
      <a class="btn ghost" href="#/event/${esc(eventId)}">${icon('edit')} Event details</a>
    </section>
    <p id="state" class="muted">Loading…</p>
    <div id="body" hidden>
      <h1 id="title" style="margin-bottom:4px"></h1>
      <p id="sub" class="muted" style="margin-top:0"></p>
      <section class="card" id="regCard" hidden>
        <h2 id="regTitle"></h2>
        <p class="muted tiny">Registered on the OSG Website. Confirm who showed up.</p>
        <ul id="regList" class="plist"></ul>
      </section>
      <section class="card">
        <div class="inputicon">${icon('search')}
          <input id="q" class="input" type="search" placeholder="Search a name to add…" aria-label="Search saved people to add" autocomplete="off" />
        </div>
        <ul id="results" class="plist"></ul>
      </section>
      <section class="card">
        <h2 id="listTitle">${icon('users')} Participants</h2>
        ${selfName ? `<div class="selfrow"><button type="button" class="btn small" id="selfToggle" aria-pressed="false">${icon('heart')} <span>Include myself</span></button></div>` : ''}
        <p class="legend tiny"><span class="osg">OSG</span><span class="community">Community</span><span class="vol">${icon('heart')} Volunteer</span></p>
        <div id="current" class="inl"></div>
        <button type="button" id="done" class="btn primary block">Done</button>
      </section>
    </div>`;

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
    const selfOn = selfStaged || (mine && !removed.has(mine));
    const tog = $('#selfToggle', root);
    if (tog) {
      tog.setAttribute('aria-pressed', String(!!selfOn));
      tog.classList.toggle('primary', !!selfOn);
    }
    const att = fullAtt();
    const kept = Object.fromEntries(
      Object.entries(att)
        .filter(([id]) => !removed.has(id))
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
    const pending = removed.size + roleEdits.size + (selfStaged ? 1 : 0);
    $('#done', root).textContent = pending ? `Save ${pending} change${pending === 1 ? '' : 's'} & done` : 'Done';
    $('#listTitle', root).innerHTML = `${icon('users')} Participants (${Object.keys(att).length})`;

    // registered on Neon One: staff only confirm Here / Missing
    const regs = Object.entries(event.registrants || {})
      .map(([key, r]) => ({ key, ...r }))
      .sort((a, b) => a.name.localeCompare(b.name));
    $('#regCard', root).hidden = !regs.length;
    if (regs.length) {
      const n = (st) => regs.filter((r) => (r.status || 'pending') === st).length;
      $('#regTitle', root).innerHTML = `${icon('check')} Registered (${regs.length}) <span class="muted tiny">${n('present')} here · ${n('missing')} missing · ${n('pending')} to confirm</span>`;
      $('#regList', root).innerHTML = regs
        .map((r) => {
          const st = r.status || 'pending';
          const nm = esc(r.name);
          const btn = (kind, ic, label, cls) =>
            `<button type="button" class="btn small${st === kind ? ` ${cls}` : ' ghost'}" data-reg="${esc(r.key)}" data-st="${kind}" aria-pressed="${st === kind}" aria-label="${label}: ${nm}" title="${st === kind ? 'Tap to undo' : label}">${icon(ic)}<span class="wide">${label}</span></button>`;
          return `<li class="prow"><span class="nm">${nm}</span>${btn('present', 'check', 'Here', 'primary')}${btn('missing', 'x', 'Missing', 'danger')}</li>`;
        })
        .join('');
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
            const gone = removed.has(a.id);
            const nm = esc(a.name);
            return `<span class="pn ${kind}${gone ? ' gone' : ''}"><button type="button" class="pname" data-role="${esc(a.id)}" aria-pressed="${vol}" title="${KIND[kind].label} · ${vol ? 'Volunteer (tap for Participant)' : 'Participant (tap for Volunteer)'}">${vol ? icon('heart') : ''}${nm}</button><button type="button" class="mb del${gone ? ' on' : ''}" data-del="${esc(a.id)}" aria-label="${gone ? 'Keep' : 'Remove'} ${nm}" title="${gone ? 'Undo remove' : 'Remove'}">${icon(gone ? 'plus' : 'minus')}</button>${i < cur.length - 1 ? '<span class="sep">,</span>' : ''}</span>`;
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
    const fromNeon = neonHits.filter((n) => !att[savedFor(n)?.id]);
    const shownAsNeon = new Set(neonHits.map((n) => savedFor(n)?.id).filter(Boolean));
    const hits = people.filter((p) => !att[p.id] && !shownAsNeon.has(p.id) && p.name.toLowerCase().includes(term));
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
      const next = (r.status || 'pending') === t.dataset.st ? 'pending' : t.dataset.st;
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
      markRegistrant(eventId, { key: t.dataset.reg, ...r }, next, person).catch(fail);
      return;
    }
    if (t.dataset.del) {
      const id = t.dataset.del;
      if (selfStaged && id === selfId()) selfStaged = false;
      else if (removed.has(id)) removed.delete(id);
      else removed.add(id);
      render();
    } else if (t.id === 'done') {
      const saved = event.attendees || {};
      const jobs = [...removed].filter((id) => saved[id]).map((id) => setAttendance(eventId, { id, ...saved[id] }, false));
      for (const [id, role] of roleEdits) if (saved[id] && !removed.has(id)) jobs.push(setRole(eventId, id, role));
      if (selfStaged) {
        let me = selfPerson();
        if (!me) {
          const created = addPerson(selfName, 'osg');
          created.done.catch(() => toast('Could not save person.'));
          me = created.person;
        }
        jobs.push(setAttendance(eventId, me, true, roleEdits.get(selfId()) || selfRole));
      }
      removed.clear();
      roleEdits.clear();
      Promise.all(jobs).catch(fail);
      location.hash = '#/';
    } else if (t.dataset.role) {
      const id = t.dataset.role;
      if (ctx?.role === 'staff' && (id === selfId() || id === myEntryId())) {
        toast('Staff take part as participants, not volunteers.');
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
        setAttendance(eventId, p, true).catch(fail);
        toast(`${p.name} added as participant · ${Object.keys(att).length + 1} total`);
      }
    } else if (t.dataset.neon) {
      const n = neonHits.find((x) => x.neonAccountId === t.dataset.neon);
      if (n) {
        let person = savedFor(n);
        if (person) {
          if (!person.neonAccountId) linkPerson(person.id, n.neonAccountId).catch(() => toast('Could not link person.'));
        } else {
          const created = addPerson(n.name, 'community', { neonAccountId: n.neonAccountId });
          created.done.catch(() => toast('Could not save person.'));
          person = created.person;
        }
        setAttendance(eventId, person, true).catch(fail);
        toast(`${n.name} added as participant · ${Object.keys(att).length + 1} total`);
        q = '';
        neonHits = [];
        $('#q', root).value = '';
        render();
      }
    } else if (t.dataset.new) {
      const name = q.trim().replace(/\s+/g, ' ');
      if (!name) return;
      const created = addPerson(name, t.dataset.new);
      created.done.catch(() => toast('Could not save person.'));
      setAttendance(eventId, created.person, true).catch(fail);
      toast(`${name} added as new ${t.dataset.new === 'osg' ? 'OSG' : 'community'} participant · ${Object.keys(att).length + 1} total`);
      q = '';
      $('#q', root).value = '';
    }
  });

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

  unsubs.push(
    watchPeople((rows) => {
      people = rows;
      peopleLoaded = true;
      render();
    }),
    watchEvent(eventId, (e) => {
      event = e;
      render();
    }),
  );

  return () => {
    clearTimeout(neonTimer);
    unsubs.forEach((u) => u());
  };
}
