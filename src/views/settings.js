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
  mergePeople,
  watchInvites,
  createInvite,
  deleteInvite,
  watchMembers,
  removeMember,
  loadExisting,
  markNotSame,
  clearNotSame,
  getNeonPeople,
  applyPeopleSync,
  watchPeopleSync,
  setMemberRole,
  watchRoster,
  syncRoster,
  ROLES,
} from '../data.js';
import { esc, $, toast, randomCode } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { ymd, addDays, personKind } from '../lib/time.js';
import { getPref, setPref } from '../lib/theme.js';
import { planPeopleSync, daysSince } from '../lib/peopleSync.js';
import { fetchAllNeonAccounts } from '../lib/neonApi.js';
import { findDuplicateGroups, attendanceStats, inactivePeople, ignoredPairs } from '../lib/people.js';

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
      <h2>${icon('user')} My role</h2>
      <p class="muted">Staff can take part in events but are not volunteers, so their time never counts toward volunteer hours. Volunteers can do both.</p>
      <div class="seg" id="roleSeg" role="group" aria-label="My role">
        <button type="button" data-r="staff">${icon('shield')} Staff</button>
        <button type="button" data-r="volunteer">${icon('heart')} Volunteer</button>
      </div>
      <p class="muted" id="roleNote"></p>
    </section>

    <section class="card">
      <h2>${icon('pin')} Locations</h2>
      <div id="locs" class="tags"></div>
      <form id="locForm" class="add">
        <input id="locName" class="input" placeholder="New location" maxlength="80" required aria-label="New location" />
        <button class="btn" type="submit">${icon('plus')} Add</button>
      </form>
    </section>

    <section class="card">
      <h2>${icon('users')} Saved Members</h2>
      <div class="inputicon">${icon('search')}
        <input id="peopleSearch" class="input" type="search" placeholder="Search names…" aria-label="Search names" />
      </div>
      <div id="pplCounts" class="counts"></div>
      <div id="ppl" class="tags"></div>
      <form id="mergeBar" class="add" hidden>
        <select id="mergeKeep" class="input" aria-label="Name to keep"></select>
        <button class="btn" type="submit">${icon('users')} <span id="mergeLbl"></span></button>
        <button class="btn ghost" type="button" id="mergeClear" aria-label="Clear selection" title="Clear selection">${icon('x')}</button>
      </form>
      ${
        ctx.isAdmin
          ? `<div class="review">
        <button class="btn" type="button" id="revBtn">${icon('search')} Review names</button>
        <div id="revOut" aria-live="polite"></div>
      </div>`
          : ''
      }
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
      <h2>${icon('download')} OSG Website</h2>
      <p class="muted">Bring events from the OSG Website into RollCall.</p>
      <a class="btn" href="#/neon">${icon('download')} Import events from the OSG Website</a>
      <p class="muted" id="psStatus">Checking the last people sync…</p>
      <button class="btn" id="psSync">${icon('userPlus')} Update people from the OSG Website</button>
    </section>
    <section class="card">
      <h2>${icon('shield')} People who sign in</h2>
      <div id="mems"></div>
    </section>`
        : ''
    }

    <section class="card">
      <h2>${icon('user')} Account</h2>
      <p class="muted">${esc(ctx.name || '')} · ${esc(ctx.user.email)}${ctx.isAdmin ? ' · admin' : ''}</p>
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
            (l) => `<span class="tag" data-id="${esc(l.id)}">${icon('pin')}<button type="button" class="tname" data-act="rename" title="Tap to rename">${esc(l.name)}</button><button type="button" class="mb del" data-act="del" aria-label="Delete ${esc(l.name)}" title="Delete">${icon('x')}</button></span>`,
          )
          .join('')
      : '<span class="muted">No locations yet.</span>';
  };
  $('#locs', root).onclick = (ev) => {
    const btn = ev.target.closest('button');
    const li = ev.target.closest('[data-id]');
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

  const picked = new Set(); // person ids selected for merging

  const renderMerge = () => {
    for (const id of picked) if (!people.some((p) => p.id === id)) picked.delete(id);
    const sel = people.filter((p) => picked.has(p.id));
    const bar = $('#mergeBar', root);
    bar.hidden = sel.length === 0;
    if (!sel.length) return;
    const keepEl = $('#mergeKeep', root);
    const prev = keepEl.value;
    keepEl.innerHTML = sel.map((p) => `<option value="${esc(p.id)}">Keep: ${esc(p.name)}</option>`).join('');
    keepEl.value = sel.some((p) => p.id === prev) ? prev : [...sel].sort((a, b) => b.name.length - a.name.length)[0].id;
    $('#mergeLbl', root).innerHTML =
      sel.length > 1 ? `Merge ${sel.length} <span class="wide">into one</span>` : 'Select another to merge';
    bar.querySelector('button[type=submit]').disabled = sel.length < 2;
  };

  const renderPeople = () => {
    renderMerge();
    const n = (t) => people.filter((p) => personKind(p.type) === t).length;
    $('#pplCounts', root).innerHTML = `
      <span class="pill mem" title="OSG">${icon('star')}<b>${n('osg')}</b> OSG</span>
      <span class="pill vol" title="Community members">${icon('users')}<b>${n('community')}</b> community</span>`;
    const q = $('#peopleSearch', root).value.trim().toLowerCase();
    if (!q) {
      $('#ppl', root).innerHTML = `<span class="muted">${
        people.length ? `${people.length} saved. Search a name to find, edit or remove someone.` : 'No people saved yet.'
      }</span>`;
      return;
    }
    const rows = people.filter((p) => p.name.toLowerCase().includes(q));
    $('#ppl', root).innerHTML = rows.length
      ? rows
          .map((p) => {
            const k = personKind(p.type);
            const on = picked.has(p.id);
            return `<span class="tag ${k}" data-id="${esc(p.id)}"><button type="button" class="mb sel${on ? ' on' : ''}" data-act="pick" aria-pressed="${on}" aria-label="Select ${esc(p.name)} to merge" title="Select to merge">${icon('check')}</button><button type="button" class="tname" data-act="rename" title="${k === 'osg' ? 'OSG' : 'Community'} · tap to rename">${esc(p.name)}</button><button type="button" class="mb" data-act="kind" aria-label="Switch ${esc(p.name)} to ${k === 'osg' ? 'Community' : 'OSG'}" title="Switch to ${k === 'osg' ? 'Community' : 'OSG'}">${icon('swap')}</button><button type="button" class="mb del" data-act="del" aria-label="Delete ${esc(p.name)}" title="Delete">${icon('x')}</button></span>`;
          })
          .join('')
      : '<span class="muted">No people found.</span>';
  };
  $('#peopleSearch', root).oninput = renderPeople;
  $('#ppl', root).onclick = (ev) => {
    const btn = ev.target.closest('button');
    const li = ev.target.closest('[data-id]');
    if (!btn || !li) return;
    const p = people.find((x) => x.id === li.dataset.id);
    if (btn.dataset.act === 'pick') {
      if (!picked.delete(p.id)) picked.add(p.id);
      renderPeople();
    } else if (btn.dataset.act === 'kind') {
      updatePerson(p.id, { type: personKind(p.type) === 'osg' ? 'community' : 'osg' }).catch(fail('Could not update.'));
    } else if (btn.dataset.act === 'rename') {
      const name = prompt('Rename person', p.name);
      if (name && name.trim()) updatePerson(p.id, { name }).catch(fail('Could not rename.'));
    } else if (confirm(`Delete ${p.name}? Past events keep their attendance record.`)) {
      deletePerson(p.id).catch(fail('Could not delete.'));
    }
  };
  $('#mergeClear', root).onclick = () => (picked.clear(), renderPeople());
  $('#mergeBar', root).onsubmit = async (ev) => {
    ev.preventDefault();
    const keep = people.find((p) => p.id === $('#mergeKeep', root).value);
    const ids = [...picked];
    if (!keep || ids.length < 2) return;
    const others = people.filter((p) => ids.includes(p.id) && p.id !== keep.id);
    if (!confirm(`Merge ${others.map((p) => `"${p.name}"`).join(', ')} into "${keep.name}"? Their past attendance moves to "${keep.name}" and the other names are deleted.`)) return;
    const btn = ev.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const n = await mergePeople(keep, ids);
      picked.clear();
      toast(`Merged into ${keep.name} · ${n} event${n === 1 ? '' : 's'} updated`);
    } catch {
      toast('Could not merge.');
    }
    renderPeople();
  };

  /* ----- review: possible duplicates and people who no longer attend (admins) ----- */

  if (ctx.isAdmin) {
    let stats = new Map();
    const pending = new Set(); // inactive people ticked for deletion
    const fmt = (d) => (d ? new Date(d + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'never');
    const label = (p) => {
      const s = stats.get(p.id);
      const last = s?.last ? `last ${fmt(s.last)}` : s?.upcoming ? 'upcoming only' : 'never attended';
      return `${esc(p.name)} <small class="muted">${personKind(p.type) === 'osg' ? 'OSG' : 'Community'} · ${s?.past || 0} event${s?.past === 1 ? '' : 's'} · ${last}</small>`;
    };

    const renderReview = (since) => {
      const groups = findDuplicateGroups(people);
      const ignored = ignoredPairs(people);
      const cutoff = since ? addDays(ymd(), -Number(since)) : null;
      const idle = inactivePeople(people, stats, cutoff);
      for (const id of pending) if (!idle.some((p) => p.id === id)) pending.delete(id);
      $('#revOut', root).innerHTML = `
        <div class="actions rev-top"><button type="button" class="btn ghost small" data-close>${icon('x')} Close review</button></div>
        <h3>Possible duplicates <small class="muted">(${groups.length})</small></h3>
        ${
          groups.length
            ? groups
                .map(
                  (g, i) => `<div class="rev-group">
              <ul>${g
                .map(
                  (p) => `<li>${label(p)} <button type="button" class="btn small ghost" data-distinct="${esc(p.id)}" data-group="${i}" title="Mark ${esc(p.name)} as a different person from the others in this group">${icon('x')} Different person</button></li>`,
                )
                .join('')}</ul>
              <button type="button" class="btn small" data-merge="${i}">${icon('users')} Select to merge</button></div>`,
                )
                .join('')
            : '<p class="muted">No look-alike names found.</p>'
        }
        ${
          ignored.length
            ? `<details class="rev-ignored"><summary>Marked as different people <small class="muted">(${ignored.length})</small></summary>
          <ul>${ignored
            .map(
              ([a, b], i) => `<li>${esc(a.name)} <span class="muted">and</span> ${esc(b.name)}
              <button type="button" class="btn small ghost" data-undo="${i}">${icon('swap')} Undo</button></li>`,
            )
            .join('')}</ul></details>`
            : ''
        }
        <h3>Not attending</h3>
        <label class="field"><span class="lbl">Show people who have</span>
          <select id="revSince" class="input">
            <option value="">never attended an event</option>
            <option value="365">not attended in the last year</option>
            <option value="730">not attended in 2 years</option>
            <option value="1095">not attended in 3 years</option>
          </select></label>
        <p class="muted">${idle.length} ${idle.length === 1 ? 'person' : 'people'}. People on an upcoming event are never listed.</p>
        ${
          idle.length
            ? `<ul class="rev-list">${idle
                .map(
                  (p) => `<li><label><input type="checkbox" data-del="${esc(p.id)}" ${pending.has(p.id) ? 'checked' : ''} /> ${label(p)}</label></li>`,
                )
                .join('')}</ul>
          <div class="actions">
            <button type="button" class="btn ghost" id="revAll">Select all</button>
            <button type="button" class="btn danger" id="revDelete" ${pending.size ? '' : 'disabled'}>${icon('trash')} Delete ${pending.size || ''} selected</button>
          </div>`
            : ''
        }
        <div class="actions"><button type="button" class="btn ghost" data-close>${icon('x')} Close review</button></div>`;
      $('#revSince', root).value = since || '';
      $('#revOut', root).querySelectorAll('[data-close]').forEach((b) => {
        b.onclick = () => {
          pending.clear();
          $('#revOut', root).innerHTML = '';
          $('#revBtn', root).focus();
        };
      });
      $('#revSince', root).onchange = (e) => (pending.clear(), renderReview(e.target.value));
      $('#revOut', root).querySelectorAll('[data-merge]').forEach((b) => {
        b.onclick = () => {
          groups[Number(b.dataset.merge)].forEach((p) => picked.add(p.id));
          renderPeople();
          $('#mergeBar', root).scrollIntoView({ block: 'center', behavior: 'smooth' });
          toast('Selected. Choose the name to keep, then merge.');
        };
      });
      $('#revOut', root).querySelectorAll('[data-distinct]').forEach((b) => {
        b.onclick = async () => {
          const group = groups[Number(b.dataset.group)];
          const person = group.find((p) => p.id === b.dataset.distinct);
          b.disabled = true;
          try {
            await markNotSame(person, group.filter((p) => p.id !== person.id));
            toast(`${person.name} marked as a different person`);
          } catch {
            toast('Could not save that. Try again.');
          }
          renderReview(since);
        };
      });
      $('#revOut', root).querySelectorAll('[data-undo]').forEach((b) => {
        b.onclick = async () => {
          const [x, y] = ignored[Number(b.dataset.undo)];
          b.disabled = true;
          try {
            await clearNotSame(x, y);
            toast(`${x.name} and ${y.name} may be suggested again`);
          } catch {
            toast('Could not undo that. Try again.');
          }
          renderReview(since);
        };
      });
      $('#revOut', root).querySelectorAll('[data-del]').forEach((c) => {
        c.onchange = () => {
          c.checked ? pending.add(c.dataset.del) : pending.delete(c.dataset.del);
          renderReview(since);
        };
      });
      const all = $('#revAll', root);
      if (all) all.onclick = () => (idle.forEach((p) => pending.add(p.id)), renderReview(since));
      const del = $('#revDelete', root);
      if (del) {
        del.onclick = async () => {
          const doomed = idle.filter((p) => pending.has(p.id));
          if (!doomed.length || !confirm(`Delete ${doomed.length} saved ${doomed.length === 1 ? 'name' : 'names'}? Past events keep their attendance record.`)) return;
          del.disabled = true;
          try {
            await Promise.all(doomed.map((p) => deletePerson(p.id)));
            toast(`Deleted ${doomed.length}`);
            pending.clear();
          } catch {
            toast('Could not delete everyone. Try again.');
          }
          renderReview(since);
        };
      }
    };

    $('#revBtn', root).onclick = async () => {
      const btn = $('#revBtn', root);
      btn.disabled = true;
      $('#revOut', root).innerHTML = '<p class="muted">Reading event history…</p>';
      try {
        const { events } = await loadExisting();
        stats = attendanceStats(events, ymd());
        pending.clear();
        renderReview('');
      } catch {
        $('#revOut', root).innerHTML = '<p class="error">Could not load event history. Are you online?</p>';
      }
      btn.disabled = false;
    };
  }

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

    // Roles chosen before the roster existed: record them once so participants lists can show them.
    let roster;
    const backfillRoster = () => {
      if (!roster) return;
      const have = new Map(roster.map((r) => [r.id, r]));
      for (const m of members) {
        const r = have.get(m.id);
        if (m.role && m.name && (!r || r.role !== m.role || r.name !== m.name)) syncRoster(m.id, m.name, m.role).catch(() => {});
      }
    };
    const memberTag = (m) =>
      `<span class="tag" data-id="${esc(m.id)}">${icon('user')}<span class="tname" title="${esc(m.email || '')}">${esc(m.name || m.email || m.id)}</span>${
        m.id === ctx.user.uid
          ? '<small class="muted">you</small>'
          : `<button type="button" class="mb del" data-act="del" aria-label="Revoke access" title="Revoke access">${icon('x')}</button>`
      }${['staff', 'volunteer']
        .filter((r) => r !== m.role)
        .map((r) => `<button type="button" class="mb" data-act="role" data-r="${r}" aria-label="Make ${ROLES[r]}" title="Make ${ROLES[r]}">${icon(r === 'staff' ? 'shield' : 'heart')}</button>`)
        .join('')}</span>`;
    const renderMembers = () => {
      const group = (title, rows) =>
        rows.length ? `<h3>${title} (${rows.length})</h3><div class="tags">${rows.map(memberTag).join('')}</div>` : '';
      $('#mems', root).innerHTML = members.length
        ? group('Staff', members.filter((m) => m.role === 'staff')) +
          group('Volunteers', members.filter((m) => m.role === 'volunteer')) +
          group('Not chosen yet', members.filter((m) => m.role !== 'staff' && m.role !== 'volunteer'))
        : '<span class="muted">Nobody yet.</span>';
    };
    $('#mems', root).onclick = (ev) => {
      const btn = ev.target.closest('button');
      const li = ev.target.closest('[data-id]');
      if (!btn || !li) return;
      if (btn.dataset.act === 'role') {
        setMemberRole(li.dataset.id, btn.dataset.r, members.find((m) => m.id === li.dataset.id)?.name || 'Unnamed').catch(fail('Could not change the role.'));
        return;
      }
      if (confirm("Revoke this person's access?")) removeMember(li.dataset.id).catch(fail('Could not revoke.'));
    };

    /* ----- people list from the OSG Website: weekly copy for name search ----- */
    const WEEK_DAYS = 7;
    let lastSync; // undefined = loading, null = never
    const renderSync = () => {
      const days = lastSync ? daysSince(lastSync.at?.toMillis?.()) : null;
      const stale = days === null || days >= WEEK_DAYS;
      $('#psStatus', root).innerHTML =
        lastSync === undefined
          ? 'Checking the last people sync…'
          : days === null
            ? 'The people list has not been copied from the OSG Website yet. Name search there needs it.'
            : `${stale ? '<strong>Due:</strong> ' : ''}People list last updated ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`} (${lastSync.added} added, ${lastSync.deactivated} no longer registered).`;
    };
    let syncing = false;
    $('#psSync', root).onclick = async () => {
      if (syncing) return;
      syncing = true;
      const btn = $('#psSync', root);
      btn.disabled = true;
      try {
        const accounts = await fetchAllNeonAccounts((done, total) => ($('#psStatus', root).textContent = `Reading the OSG Website… ${done} of ${total}`));
        $('#psStatus', root).textContent = 'Comparing with the saved list…';
        const plan = planPeopleSync(accounts, await getNeonPeople());
        if (plan.suspicious) {
          toast(`Stopped: ${plan.deactivate.length} people would be removed. Nothing changed.`);
        } else {
          await applyPeopleSync(plan);
          toast(`People updated · ${plan.add.length} added, ${plan.update.length} changed, ${plan.deactivate.length} removed`);
        }
      } catch (e) {
        toast(e?.status === 429 ? 'The OSG Website is busy. Try again in a minute.' : 'Could not update people.');
      } finally {
        syncing = false;
        btn.disabled = false;
        renderSync();
      }
    };

    unsubs.push(
      watchPeopleSync((s) => ((lastSync = s), renderSync())),
      watchInvites((rows) => ((invites = rows), renderInvites())),
      watchMembers((rows) => ((members = rows), renderMembers(), backfillRoster())),
      watchRoster((rows) => ((roster = rows), backfillRoster())),
    );
  }

  /* ----- my role: staff or volunteer ----- */
  const renderRole = () => {
    for (const b of $('#roleSeg', root).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.r === ctx.role));
    $('#roleNote', root).textContent = ctx.role ? `You are signed in as ${ROLES[ctx.role]}.` : 'Choose one so events count your time correctly.';
  };
  $('#roleSeg', root).onclick = (ev) => {
    const r = ev.target.closest('button')?.dataset.r;
    if (!r || r === ctx.role) return;
    setMemberRole(ctx.user.uid, r, ctx.name).then(
      () => ((ctx.role = r), renderRole(), toast(`Saved: ${ROLES[r]}`)),
      fail('Could not save your role.'),
    );
  };
  renderRole();

  unsubs.push(
    watchLocations((rows) => ((locations = rows), renderLocs())),
    watchPeople((rows) => ((people = rows), renderPeople())),
  );

  return () => unsubs.forEach((u) => u());
}
