import { signOut } from 'firebase/auth';
import { auth } from '../firebase.js';
import {
  watchLocations,
  addLocation,
  renameLocation,
  deleteLocation,
  watchPeople,
  updatePerson,
  deletePerson,
  watchInvites,
  createInvite,
  deleteInvite,
  watchMembers,
  removeMember,
} from '../data.js';
import { esc, $, toast, randomCode } from '../lib/dom.js';
import { ymd, addDays } from '../lib/time.js';

const fail = (msg) => () => toast(msg);

export function settingsView(root, ctx) {
  const unsubs = [];
  let locations = [];
  let people = [];
  let invites = [];
  let members = [];

  root.innerHTML = `
    <section class="bar"><h1>Settings</h1></section>

    <section class="card">
      <h2>Locations</h2>
      <ul id="locs" class="rows"></ul>
      <form id="locForm" class="add">
        <input id="locName" class="input" placeholder="New location" maxlength="80" required />
        <button class="btn" type="submit">Add</button>
      </form>
    </section>

    <section class="card">
      <h2>Saved people</h2>
      <p class="muted">Names saved here appear as quick check-boxes on every event.</p>
      <input id="peopleSearch" class="input" type="search" placeholder="Search names…" />
      <ul id="ppl" class="rows"></ul>
    </section>

    ${
      ctx.isAdmin
        ? `
    <section class="card">
      <h2>Invitation codes</h2>
      <p class="muted">New staff sign in with Google, then enter a code. Expired codes stop working for new joiners.</p>
      <form id="invForm" class="add">
        <input id="invLabel" class="input" placeholder="Label (optional)" maxlength="60" />
        <input id="invExp" class="input" type="date" required />
        <button class="btn" type="submit">Create code</button>
      </form>
      <ul id="invs" class="rows"></ul>
    </section>
    <section class="card">
      <h2>Staff with access</h2>
      <ul id="mems" class="rows"></ul>
    </section>`
        : ''
    }

    <section class="card">
      <h2>Account</h2>
      <p class="muted">${esc(ctx.user.email)}${ctx.isAdmin ? ' · admin' : ''}</p>
      <button class="btn" id="signout">Sign out</button>
      <p class="muted"><small>Version ${esc(__APP_VERSION__)}</small></p>
    </section>`;

  $('#signout', root).onclick = () => signOut(auth);

  /* ----- locations ----- */

  const renderLocs = () => {
    $('#locs', root).innerHTML = locations.length
      ? locations
          .map(
            (l) => `<li data-id="${esc(l.id)}"><span class="nm">${esc(l.name)}</span>
              <button class="btn small" data-act="rename">Rename</button>
              <button class="btn small danger" data-act="del">Delete</button></li>`,
          )
          .join('')
      : '<li class="empty">No locations yet.</li>';
  };
  $('#locs', root).onclick = (ev) => {
    const btn = ev.target.closest('button');
    const li = ev.target.closest('li[data-id]');
    if (!btn || !li) return;
    const loc = locations.find((l) => l.id === li.dataset.id);
    if (btn.dataset.act === 'rename') {
      const name = prompt('Rename location', loc.name);
      if (name && name.trim()) renameLocation(loc.id, name).catch(fail('Could not rename.'));
    } else if (confirm(`Delete "${loc.name}"? Events keep their old reference but it will show no name.`)) {
      deleteLocation(loc.id).catch(fail('Could not delete.'));
    }
  };
  $('#locForm', root).onsubmit = (ev) => {
    ev.preventDefault();
    const input = $('#locName', root);
    if (!input.value.trim()) return;
    addLocation(input.value).catch(fail('Could not add.'));
    input.value = '';
  };

  /* ----- people ----- */

  const renderPeople = () => {
    const q = $('#peopleSearch', root).value.trim().toLowerCase();
    const rows = people.filter((p) => !q || p.name.toLowerCase().includes(q));
    $('#ppl', root).innerHTML = rows.length
      ? rows
          .map(
            (p) => `<li data-id="${esc(p.id)}"><span class="nm">${esc(p.name)}</span>
              <select class="input small" data-act="type" aria-label="Type for ${esc(p.name)}">
                <option value="volunteer" ${p.type === 'volunteer' ? 'selected' : ''}>Volunteer</option>
                <option value="member" ${p.type === 'member' ? 'selected' : ''}>Member</option>
              </select>
              <button class="btn small" data-act="rename">Rename</button>
              <button class="btn small danger" data-act="del">Delete</button></li>`,
          )
          .join('')
      : '<li class="empty">No people found.</li>';
  };
  $('#peopleSearch', root).oninput = renderPeople;
  $('#ppl', root).onclick = (ev) => {
    const btn = ev.target.closest('button');
    const li = ev.target.closest('li[data-id]');
    if (!btn || !li) return;
    const p = people.find((x) => x.id === li.dataset.id);
    if (btn.dataset.act === 'rename') {
      const name = prompt('Rename person', p.name);
      if (name && name.trim()) updatePerson(p.id, { name }).catch(fail('Could not rename.'));
    } else if (confirm(`Delete ${p.name}? Past events keep their attendance record.`)) {
      deletePerson(p.id).catch(fail('Could not delete.'));
    }
  };
  $('#ppl', root).onchange = (ev) => {
    const sel = ev.target.closest('select[data-act=type]');
    const li = ev.target.closest('li[data-id]');
    if (sel && li) updatePerson(li.dataset.id, { type: sel.value }).catch(fail('Could not update.'));
  };

  /* ----- admin: invites & members ----- */

  if (ctx.isAdmin) {
    $('#invExp', root).value = addDays(ymd(), 7);

    const renderInvites = () => {
      const now = Date.now();
      $('#invs', root).innerHTML = invites.length
        ? invites
            .map((i) => {
              const exp = i.expiresAt.toDate();
              const expired = exp.getTime() < now;
              return `<li data-id="${esc(i.id)}">
                <span class="nm"><code>${esc(i.id)}</code> ${esc(i.label)}
                  <small class="muted">${expired ? 'expired' : 'expires'} ${exp.toLocaleDateString()}</small></span>
                <button class="btn small" data-act="copy">Copy</button>
                <button class="btn small danger" data-act="del">Delete</button></li>`;
            })
            .join('')
        : '<li class="empty">No invitation codes.</li>';
    };
    $('#invs', root).onclick = (ev) => {
      const btn = ev.target.closest('button');
      const li = ev.target.closest('li[data-id]');
      if (!btn || !li) return;
      if (btn.dataset.act === 'copy') {
        navigator.clipboard?.writeText(li.dataset.id).then(() => toast('Code copied'), fail('Copy failed.'));
      } else {
        deleteInvite(li.dataset.id).catch(fail('Could not delete.'));
      }
    };
    $('#invForm', root).onsubmit = (ev) => {
      ev.preventDefault();
      const code = randomCode();
      createInvite(code, $('#invExp', root).value, $('#invLabel', root).value.trim(), ctx.user.uid).catch(
        fail('Could not create code.'),
      );
      $('#invLabel', root).value = '';
      toast(`Code ${code} created`);
    };

    const renderMembers = () => {
      $('#mems', root).innerHTML = members.length
        ? members
            .map(
              (m) => `<li data-id="${esc(m.id)}"><span class="nm">${esc(m.email || m.id)}</span>
                ${
                  m.id === ctx.user.uid
                    ? '<small class="muted">you</small>'
                    : '<button class="btn small danger" data-act="del">Revoke</button>'
                }</li>`,
            )
            .join('')
        : '<li class="empty">No staff.</li>';
    };
    $('#mems', root).onclick = (ev) => {
      const btn = ev.target.closest('button');
      const li = ev.target.closest('li[data-id]');
      if (!btn || !li) return;
      if (confirm('Revoke this person\'s access?')) removeMember(li.dataset.id).catch(fail('Could not revoke.'));
    };

    unsubs.push(
      watchInvites((rows) => ((invites = rows), renderInvites())),
      watchMembers((rows) => ((members = rows), renderMembers())),
    );
  }

  unsubs.push(
    watchLocations((rows) => ((locations = rows), renderLocs())),
    watchPeople((rows) => ((people = rows), renderPeople())),
  );

  return () => unsubs.forEach((u) => u());
}
