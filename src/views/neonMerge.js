import { loadExisting, commitOps, newId, markDuplicate, setNeonSeen } from '../data.js';
import {
  fetchNeonEvents,
  fetchNeonSync,
  searchNeonAccounts,
  createNeonRegistration,
  createNeonEvent,
  searchNeonAccountsByEmail,
  pushNeonSync,
  forgetNeonCache,
  neonInfo,
} from '../lib/neonApi.js';
import { neonSyncPlan, friendlyNeonReason } from '../lib/neon.js';
import { similarNeonEvents, matchParticipants, planMerge, planMove } from '../lib/neonMerge.js';
import { auth } from '../firebase.js';
import { esc, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { addDays, formatDay, formatTime } from '../lib/time.js';

const ACCOUNT_LOOKUPS_AT_ONCE = 3;

/**
 * Fill `slot` with the "Find on OSG" button for a RollCall-only event (it may already exist on the OSG Website),
 * or the Duplicate badge once its roll was moved. Empty for new or already-linked events.
 */
export function renderMergeSlot(slot, event, locationName = '') {
  if (!slot) return;
  if (!event || event.neonEventId) {
    slot.innerHTML = '';
    return;
  }
  if (event.duplicateOf) {
    slot.innerHTML = `<a class="badge unsynced" href="#/event/${esc(event.duplicateOf)}" title="Its roll was moved to the original event. Tap to open it. You can delete this one.">${icon('copy')}<span class="wide">Duplicate</span></a>`;
    return;
  }
  slot.innerHTML = `<button type="button" class="btn small" id="mergeBtn" title="Is this event already on the OSG Website? Find it and merge" aria-label="Find this event on the OSG Website and merge">${icon('swap')}<span class="wide">Find on OSG</span></button>`;
  slot.querySelector('#mergeBtn').onclick = () => openMergeDialog({ event, locationName });
}
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * Merge a RollCall event into the event that already exists on the OSG Website.
 * Staff pick the matching OSG event, review what will change, and confirm. The OSG details win; the roll stays.
 * People on the roll who are registered there are marked Here; the others are registered (needs their OSG
 * account) and marked Here. Everyone on the roll is ticked by default; untick anyone to leave them out.
 *   event  the RollCall event ({id, name, date, startTime, endTime, attendees, ...})
 *   locationName  its place, for matching
 */
export function openMergeDialog({ event, locationName = '' }) {
  const dlg = document.createElement('dialog');
  dlg.className = 'sync-dlg';
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);

  let step = 'search'; // search | preview | running | done
  let candidates = null; // null = loading
  let alsoInRollCall = []; // similar OSG events that already have their own RollCall event: [{neon, local}]
  let existing = null;
  let picked = null; // the chosen OSG event
  let target = null; // set when the roll moves into a RollCall event that is already linked (this event is then marked a duplicate)
  let snap = null; // fresh {event, attendees} for the chosen OSG event
  let rows = []; // participants: {personId, name, role, attendee, include, accounts, choice, lookup}
  let result = null;
  let info = null;
  let staffAccount = null; // the signed-in staff member's OSG account: guests are filed under it
  let error = '';

  const shell = (inner) => {
    dlg.innerHTML = `<form method="dialog" class="sync-body">
      <h2>${icon('swap')} Merge with the OSG Website</h2>
      <p class="muted tiny">${esc(event.name)} · ${esc(formatDay(event.date))}${info?.sandbox ? ' · <b>Sandbox, not live data</b>' : ''}</p>
      ${inner}
    </form>`;
  };
  const close = `<button class="btn ghost" value="cancel">Close</button>`;

  /* ----- step 1: find ----- */

  async function findCandidates() {
    try {
      info = await neonInfo();
      const email = auth.currentUser?.email;
      if (email) staffAccount = (await searchNeonAccountsByEmail(email).catch(() => []))[0] || null;
      const [list, ex] = await Promise.all([fetchNeonEvents(addDays(event.date, -1), addDays(event.date, 1)), loadExisting()]);
      existing = ex;
      if (!list) throw new Error('unreachable');
      const taken = new Set(ex.events.filter((e) => e.neonEventId).map((e) => String(e.neonEventId)));
      candidates = similarNeonEvents(event, list, { locationName, takenIds: taken });
      // Say so when the match exists but is already imported as another RollCall event (it is not offered).
      alsoInRollCall = similarNeonEvents(event, list, { locationName })
        .filter((c) => taken.has(String(c.neon.neonEventId)))
        .map((c) => ({ neon: c.neon, local: ex.events.find((e) => String(e.neonEventId) === String(c.neon.neonEventId) && e.id !== event.id) }))
        .filter((c) => c.local);
    } catch {
      candidates = [];
      error = 'Could not reach the OSG Website. Try again in a moment.';
    }
    render();
  }

  const detail = (n) =>
    `${esc(formatDay(n.date))}${n.startTime ? ` · ${esc(formatTime(n.startTime))}${n.endTime ? ` – ${esc(formatTime(n.endTime))}` : ''}` : ''}${n.location ? ` · ${esc(n.location)}` : ''}`;

  function renderSearch() {
    if (candidates === null) return shell(`<p class="muted">Looking for the same event on the OSG Website…</p><div class="actions">${close}</div>`);
    const list = candidates
      .map(
        (c, i) => `
        <li><button type="button" class="cand" data-i="${i}">
          <strong>${esc(c.neon.name)}</strong>
          <span class="muted tiny">${detail(c.neon)}</span>
          <span class="reasons">${c.reasons.map((r) => `<span class="badge unsynced">${esc(r)}</span>`).join('')}</span>
        </button></li>`,
      )
      .join('');
    shell(`
      ${error ? `<p class="notice warn">${icon('alert')} <span>${esc(error)}</span></p>` : ''}
      ${
        alsoInRollCall.length
          ? `<p>Already in RollCall? Move this roll into that event (its OSG registrations are updated too). This event is then marked as a duplicate, not deleted:</p>
             <ul class="cands">${alsoInRollCall
               .map(
                 (c, i) => `<li><button type="button" class="cand" data-move="${i}">
                   <strong>${esc(c.local.name)}</strong>
                   <span class="muted tiny">${detail(c.neon)} · already linked to the OSG Website</span>
                   <span class="reasons"><span class="badge unsynced">Move the roll here</span></span>
                 </button></li>`,
               )
               .join('')}</ul>`
          : ''
      }
      ${
        candidates.length
          ? `<p>Is this the same event? Pick the match. Its details replace this event's, and your roll is kept.</p><ul class="cands">${list}</ul>`
          : error
            ? ''
            : alsoInRollCall.length
              ? ''
              : `<p>No similar event found on the OSG Website for ${esc(formatDay(event.date))}.</p>`
      }
      ${
        candidates && info?.canWrite !== false
          ? `<p class="muted tiny">Not on the OSG Website yet?</p><div class="actions"><button class="btn" type="button" id="create">${icon('send')} Create it on the OSG Website</button>${close}</div>`
          : `<div class="actions">${close}</div>`
      }`);
    const create = dlg.querySelector('#create');
    if (create) create.onclick = createOnOsg;
    dlg.querySelectorAll('.cand[data-i]').forEach((b) => (b.onclick = () => pick(candidates[+b.dataset.i].neon)));
    dlg.querySelectorAll('.cand[data-move]').forEach((b) => {
      const c = alsoInRollCall[+b.dataset.move];
      b.onclick = () => pick(c.neon, c.local);
    });
  }

  /** Make an unpublished event on the OSG Website from this one, then carry on as if it had been picked. */
  async function createOnOsg() {
    const when = `${formatDay(event.date)}, ${formatTime(event.startTime)} – ${formatTime(event.endTime)}`;
    const where = info?.sandbox ? 'the OSG Website SANDBOX' : 'the live OSG Website';
    if (!confirm(`Create "${event.name}" (${when}) on ${where}? It is not published and has no sign-up form.`)) return;
    const btn = dlg.querySelector('#create');
    btn.disabled = true;
    try {
      const neonEventId = await createNeonEvent({ name: event.name, date: event.date, startTime: event.startTime, endTime: event.endTime, location: locationName });
      await pick({ neonEventId });
    } catch (e) {
      error = `Could not create the event: ${friendlyNeonReason(e.message)}`;
      render();
    }
  }

  /* ----- step 2: review ----- */

  async function pick(n, into = null) {
    picked = n;
    target = into;
    step = 'preview';
    snap = null;
    error = '';
    render();
    try {
      snap = await fetchNeonSync(n.neonEventId);
      rows = matchParticipants(event.attendees, snap.attendees).map((r) => ({ ...r, include: true, accounts: null, choice: null }));
      render();
      await lookUpAccounts();
    } catch {
      error = 'Could not load that event from the OSG Website.';
      render();
    }
  }

  /** Find the OSG account for each person who is not registered yet (a few at a time; Neon rate-limits). */
  async function lookUpAccounts() {
    const todo = rows.filter((r) => !r.attendee);
    let next = 0;
    const run = async () => {
      while (next < todo.length) {
        const r = todo[next++];
        try {
          r.accounts = await searchNeonAccounts(r.name);
          r.choice = r.accounts.length === 1 ? r.accounts[0].accountId : null;
        } catch {
          r.accounts = [];
        }
        if (step === 'preview') render();
      }
    };
    await Promise.all(Array.from({ length: Math.min(ACCOUNT_LOOKUPS_AT_ONCE, todo.length) }, run));
  }

  const summary = () => {
    const mark = rows.filter((r) => r.include && r.attendee);
    const reg = rows.filter((r) => r.include && !r.attendee && r.choice);
    const guests = rows.filter((r) => r.include && !r.attendee && !r.choice && r.accounts && !r.accounts.length && staffAccount);
    const stuck = rows.filter((r) => r.include && !r.attendee && !r.choice && !guests.includes(r));
    return { mark, reg, guests, stuck };
  };

  function personRow(r, i) {
    let what;
    if (r.attendee) what = `<span class="ok-text">${icon('check')} Registered, will be marked Here</span>`;
    else if (r.accounts === null) what = '<span class="muted">Looking up the OSG account…</span>';
    else if (!r.accounts.length) what = staffAccount ? 'No OSG account · added as a <b>Guest</b>' : `<span class="warn-text">${icon('alert')} No OSG account, and none found for your sign-in email, so not added</span>`;
    else if (r.accounts.length === 1) what = `OSG account: <b>${esc(r.accounts[0].name)}</b>`;
    else
      what = `OSG account: <select data-i="${i}" class="input small"${r.include ? '' : ' disabled title="Tick this person to choose an account"'} aria-label="OSG account for ${esc(r.name)}"><option value="">Choose the account…</option>${r.accounts
        .map((a) => `<option value="${esc(a.accountId)}"${r.choice === a.accountId ? ' selected' : ''}>${esc(a.name)}${a.email ? ` (${esc(a.email)})` : ''}</option>`)
        .join('')}</select>`;
    const disabled = !r.attendee && r.accounts !== null && !r.accounts.length && !staffAccount;
    return `<li class="prow merge-row">
      <label><input type="checkbox" data-i="${i}" ${r.include && !disabled ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
      <span class="nm">${r.role === 'volunteer' ? icon('heart') : ''}${esc(r.name)}${r.role === 'volunteer' ? ' <span class="muted tiny">volunteer</span>' : ''}</span></label>
      <span class="what">${what}</span></li>`;
  }

  function renderPreview() {
    if (!snap) {
      shell(`${error ? `<p class="notice warn">${icon('alert')} <span>${esc(error)}</span></p>` : '<p class="muted">Loading that event…</p>'}
        <div class="actions"><button class="btn" type="button" id="back">${icon('back')} Back</button>${close}</div>`);
      dlg.querySelector('#back').onclick = () => ((step = 'search'), (picked = null), render());
      return;
    }
    const n = snap.event;
    const diff = [
      ['Name', event.name, n.name],
      ['Date', event.date, n.date],
      ['Start', event.startTime && formatTime(event.startTime), n.startTime && formatTime(n.startTime)],
      ['End', event.endTime && formatTime(event.endTime), n.endTime && formatTime(n.endTime)],
      ['Location', locationName, n.location],
    ]
      .filter(([, a, b]) => b && String(a || '') !== String(b))
      .map(([k, a, b]) => `<tr><th scope="row">${k}</th><td><s class="old">${esc(a || '—')}</s> <span aria-hidden="true">→</span> <b>${esc(b)}</b></td></tr>`)
      .join('');
    const { mark, reg, guests, stuck } = summary();
    const writable = snap.canWrite !== false && info?.canWrite !== false;
    const nothing = !mark.length && !reg.length && !guests.length;
    shell(`
      <p><strong>${esc(n.name)}</strong><br><span class="muted tiny">${detail(n)}</span></p>
      ${
        target
          ? `<p>${icon('swap')} The roll${event.volunteerHours > 0 ? ' and volunteer hours' : ''} of <b>${esc(event.name)}</b> move into <b>${esc(target.name)}</b>, which keeps its own details. <b>${esc(event.name)}</b> is kept and marked as a duplicate (nothing is deleted), so staff can remove it later.</p>`
          : `<h3>Event details</h3>${diff ? `<table class="sync-tbl"><tbody>${diff}</tbody></table>` : '<p class="muted">Already the same.</p>'}`
      }
      <h3>Participants (${rows.length})</h3>
      ${rows.length ? `<ul class="plist merge-list">${rows.map(personRow).join('')}</ul>` : '<p class="muted">Nobody is on the roll yet.</p>'}
      ${(() => {
        const pick = stuck.filter((r) => r.accounts?.length > 1);
        const wait = stuck.filter((r) => r.accounts === null);
        const names = (l) => l.map((r) => esc(r.name)).join(', ');
        return [
          pick.length ? `<p class="notice warn">${icon('alert')} <span>Choose an OSG account for ${names(pick)}, or untick. Otherwise they are skipped.</span></p>` : '',
          wait.length ? `<p class="notice warn">${icon('alert')} <span>Still looking up accounts for ${names(wait)}. Wait, or they are skipped.</span></p>` : '',
        ].join('');
      })()}
      ${writable ? '' : `<p class="notice warn">${icon('alert')} <span>Sending to the OSG Website is turned off on this site.</span></p>`}
      ${error ? `<p class="notice warn">${icon('alert')} <span>${esc(error)}</span></p>` : ''}
      <div class="actions">
        <button class="btn ghost" type="button" id="back">${icon('back')} Back</button>
        ${close}
        <button class="btn primary" type="button" id="merge" ${writable ? '' : 'disabled'}>${icon('swap')} ${target ? 'Move roll' : 'Merge'}${
          nothing ? '' : ` · register ${reg.length + guests.length}, mark ${mark.length + reg.length + guests.length} Here`
        }</button>
      </div>`);
    dlg.querySelector('#back').onclick = () => ((step = 'search'), (picked = null), render());
    dlg.querySelector('#merge').onclick = doMerge;
    dlg.querySelectorAll('input[type=checkbox]').forEach((c) => (c.onchange = () => ((rows[+c.dataset.i].include = c.checked), render())));
    dlg.querySelectorAll('select[data-i]').forEach((s) => (s.onchange = () => ((rows[+s.dataset.i].choice = s.value || null), render())));
  }

  /* ----- step 3: do it ----- */

  async function doMerge() {
    step = 'running';
    render();
    const out = { registered: 0, here: 0, failed: [], note: '', marked: false };
    try {
      // Look again: someone may have registered since the preview, and the match must not double-register.
      let fresh = await fetchNeonSync(picked.neonEventId);
      const chosen = new Map(rows.filter((r) => r.include).map((r) => [r.personId, r]));
      const roll = Object.fromEntries([...chosen].map(([id, r]) => [id, { name: r.name, role: r.role }]));
      for (const m of matchParticipants(roll, fresh.attendees)) {
        const r = chosen.get(m.personId);
        const acct = r.accounts?.find((a) => a.accountId === r.choice);
        const noAccount = r.accounts && !r.accounts.length && staffAccount;
        if (m.attendee || (!acct && !noAccount)) continue;
        try {
          if (acct) await createNeonRegistration(picked.neonEventId, acct);
          else {
            const [firstName, ...rest] = clean(r.name).split(' ');
            await createNeonRegistration(picked.neonEventId, { registrantAccountId: staffAccount.accountId, firstName, lastName: rest.join(' ') });
          }
          out.registered++;
        } catch (e) {
          out.failed.push({ name: r.name, reason: friendlyNeonReason(e.message) });
        }
      }
      fresh = await fetchNeonSync(picked.neonEventId);
      const here = new Set(matchParticipants(roll, fresh.attendees).filter((m) => m.attendee).map((m) => String(m.attendee.attendeeId)));
      out.here = here.size;

      let local;
      if (target) {
        const { ops, data } = planMove(event, target, fresh.attendees, here);
        await commitOps(ops);
        local = { ...target, registrants: { ...target.registrants, ...data.registrants } };
      } else {
        const { ops, data } = planMerge(event, fresh.event, fresh.attendees, here, existing.locations, newId);
        await commitOps(ops);
        local = { ...event, ...data };
      }

      // Registrations made before today may still say "not attended": send those check-ins.
      const plan = neonSyncPlan(local, fresh.event, fresh.attendees, fresh.event.location);
      if (plan.checkins.length) {
        const sent = await pushNeonSync(picked.neonEventId, { details: [], checkins: plan.checkins }, fresh.event);
        out.failed.push(...sent.failed);
        if (Object.keys(sent.marked).length) setNeonSeen(target?.id || event.id, sent.marked).catch(() => {});
      }
      forgetNeonCache();
      if (target) {
        await markDuplicate(event.id, target.id);
        out.marked = true;
      }
    } catch (e) {
      out.note = `The merge stopped early: ${friendlyNeonReason(e.message)} Nothing is lost; you can run it again.`;
    }
    result = out;
    step = 'done';
    render();
    toast(out.note ? 'Merge did not finish.' : target ? 'Roll moved.' : 'Merged with the OSG Website.');
  }

  function renderDone() {
    const f = result.failed;
    shell(`
      ${result.note ? `<p class="notice warn">${icon('alert')} <span>${esc(result.note)}</span></p>` : target
          ? `<p>${icon('check')} <b>Roll moved</b> into ${esc(target.name)}. This event is marked as a duplicate and kept; delete it whenever you like.</p>`
          : `<p>${icon('check')} <b>Merged.</b> This event now matches the OSG Website.</p>`}
      <ul>
        <li>${result.registered} newly registered on the OSG Website</li>
        <li>${result.here} marked Here</li>
      </ul>
      ${
        f.length
          ? `<p class="notice warn">${icon('alert')} <span><b>${f.length} could not be sent</b> (${esc(f.slice(0, 5).map((x) => x.name).join(', '))}${f.length > 5 ? '…' : ''}).<br>${[...new Set(f.map((x) => x.reason))].map(esc).join('<br>')}</span></p>`
          : ''
      }
      <div class="actions"><button class="btn primary" type="button" id="done">Done</button></div>`);
    dlg.querySelector('#done').onclick = () => {
      // Go to the event that now holds the roll.
      if (result.marked) location.hash = `#/event/${target.id}/people`;
      dlg.close();
    };
  }

  function render() {
    if (step === 'search') renderSearch();
    else if (step === 'preview') renderPreview();
    else if (step === 'running') shell('<p class="muted">Merging… this can take a few seconds.</p>');
    else renderDone();
  }

  render();
  dlg.showModal();
  findCandidates();
}
