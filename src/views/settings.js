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
import { icon } from '../lib/icons.js';
import { ymd, addDays } from '../lib/time.js';
import { getPref, setPref } from '../lib/theme.js';

const fail = (msg) => () => toast(msg);

export function settingsView(root, ctx) {
  const unsubs = [];
  let locations = [];
  let people = [];
  let invites = [];
  let members = [];

  root.innerHTML = `
    <section class="bar"><h1>${icon('settings', 'lg')} Settings</h1></section>

    <section class="card">
      <h2>${icon('sun')} Appearance</h2>
      <div class="seg" id="themeSeg" role="group" aria-label="Theme">
        <button type="button" data-t="light">${icon('sun')} Light</button>
        <button type="button" data-t="dark">${icon('moon')} Dark</button>
        <button type="button" data-t="system">${icon('monitor')} System</button>
      </div>
    </section>

    <section class="card">
      <h2>${icon('pin')} Locations</h2>
      <ul id="locs" class="rows"></ul>
      <form id="locForm" class="add">
        <input id="locName" class="input" placeholder="New location" maxlength="80" required aria-label="New location" />
        <button class="btn" type="submit">${icon('plus')} Add</button>
      </form>
    </section>

    <section class="card">
      <h2>${icon('users')} Saved people</h2>
      <p class="muted">Names saved here appear as quick check-boxes on every event.</p>
      <div class="inputicon">${icon('search')}
        <input id="peopleSearch" class="input" type="search" placeholder="Search names…" aria-label="Search names" />
      </div>
      <div id="pplCounts" class="counts"></div>
      <ul id="ppl" class="rows"></ul>
      <a class="btn" href="#/import" style="margin-top:14px">${icon('upload')} Import people or past events</a>
    </section>

    ${
      ctx.isAdmin
        ? `
    <section class="card">
      <h2>${icon('key')} Invitation codes</h2>
      <p class="muted">New staff sign in with Google, then enter a code. Expired codes stop working for new joiners.</p>
      <form id="invForm" class="add">
        <input id="invLabel" class="input" placeholder="Label (optional)" maxlength="60" aria-label="Label" />
        <input id="invExp" class="input" type="date" required aria-label="Expiry date" />
        <button class="btn" type="submit">${icon('plus')} Create code</button>
      </form>
      <ul id="invs" class="rows"></ul>
    </section>
    <section class="card">
      <h2>${icon('shield')} Staff with access</h2>
      <ul id="mems" class="rows"></ul>
    </section>`
        : ''
    }

    <section class="card">
      <h2>${icon('user')} Account</h2>
      <p class="muted">${esc(ctx.user.email)}${ctx.isAdmin ? ' · admin' : ''}</p>
      <button class="btn" id="signout">${icon('logout')} Sign out</button>
      <p class="muted"><small>Version ${esc(__APP_VERSION__)}</small></p>
    </section>`;

  /* ----- appearance ----- */
  const segs = root.querySelectorAll('#themeSeg [data-t]');
  const syncSeg = () => segs.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.t === getPref())));
  segs.forEach((b) => (b.onclick = () => (setPref(b.dataset.t), syncSeg())));
  syncSeg();

  $('#signout', root).onclick = () => signOut(auth);

  /* ----- locations ----- */

  const renderLocs = () => {
    $('#locs', root).innerHTML = locations.length
      ? locations
          .map(
            (l) => `<li data-id="${esc(l.id)}">${icon('pin')}<span class="nm">${esc(l.name)}</span>
              <button class="btn small" data-act="rename" aria-label="Rename ${esc(l.name)}">${icon('edit')}</button>
              <button class="btn small danger" data-act="del" aria-label="Delete ${esc(l.name)}">${icon('trash')}</button></li>`,
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
    const n = (t) => people.filter((p) => p.type === t).length;
    $('#pplCounts', root).innerHTML = `
      <span class="pill mem" title="Members">${icon('star')}<b>${n('member')}</b> members</span>
      <span class="pill vol" title="Volunteers">${icon('heart')}<b>${n('volunteer')}</b> volunteers</span>
      <span class="pill hrs" title="Both member and volunteer">${icon('users')}<b>${n('both')}</b> both</span>`;
    const q = $('#peopleSearch', root).value.trim().toLowerCase();
    if (!q) {
      $('#ppl', root).innerHTML = `<li class="empty">${
        people.length ? `${people.length} saved. Search a name to find, edit or remove someone.` : 'No people saved yet.'
      }</li>`;
      return;
    }
    const rows = people.filter((p) => p.name.toLowerCase().includes(q));
    $('#ppl', root).innerHTML = rows.length
      ? rows
          .map(
            (p) => `<li data-id="${esc(p.id)}"><span class="nm">${esc(p.name)}</span>
              <select class="input small" data-act="type" aria-label="Type for ${esc(p.name)}">
                <option value="volunteer" ${p.type === 'volunteer' ? 'selected' : ''}>Volunteer</option>
                <option value="member" ${p.type === 'member' ? 'selected' : ''}>Member</option>
                <option value="both" ${p.type === 'both' ? 'selected' : ''}>Both</option>
              </select>
              <button class="btn small" data-act="rename" aria-label="Rename ${esc(p.name)}">${icon('edit')}</button>
              <button class="btn small danger" data-act="del" aria-label="Delete ${esc(p.name)}">${icon('trash')}</button></li>`,
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
              return `<li data-id="${esc(i.id)}">${icon('key')}
                <span class="nm"><code>${esc(i.id)}</code> ${esc(i.label)}
                  <small class="muted">${expired ? 'expired' : 'expires'} ${exp.toLocaleDateString()}</small></span>
                <button class="btn small" data-act="copy" aria-label="Copy code">${icon('copy')}</button>
                <button class="btn small danger" data-act="del" aria-label="Delete code">${icon('trash')}</button></li>`;
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
              (m) => `<li data-id="${esc(m.id)}">${icon('user')}<span class="nm">${esc(m.email || m.id)}</span>
                ${
                  m.id === ctx.user.uid
                    ? '<small class="muted">you</small>'
                    : `<button class="btn small danger" data-act="del">${icon('x')} Revoke</button>`
                }</li>`,
            )
            .join('')
        : '<li class="empty">No staff.</li>';
    };
    $('#mems', root).onclick = (ev) => {
      const btn = ev.target.closest('button');
      const li = ev.target.closest('li[data-id]');
      if (!btn || !li) return;
      if (confirm("Revoke this person's access?")) removeMember(li.dataset.id).catch(fail('Could not revoke.'));
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
