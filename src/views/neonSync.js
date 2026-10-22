import { fetchNeonSync, pushNeonSync, neonInfo, forgetNeonCache } from '../lib/neonApi.js';
import { neonSyncPlan } from '../lib/neon.js';
import { setNeonSeen } from '../data.js';
import { esc, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { formatTime } from '../lib/time.js';

const SHOW_TIME = new Set(['startTime', 'endTime']);
const show = (field, v) => (!v ? '—' : SHOW_TIME.has(field) ? formatTime(v) : v);

/**
 * "Out of sync" chip for an imported event, plus the dialog that previews and sends the changes to the OSG Website.
 * host: element to render the chip into. getEvent() -> the current local event; getLocationName() -> its place.
 * onSnapshot(attendees) (optional) is told the OSG Website's attendees each time they are fetched.
 * Returns { update(), destroy() }; call update() whenever the event changes (it only re-checks when something
 * that is compared has changed).
 */
export function mountNeonSync(host, { getEvent, getLocationName, onSnapshot }) {
  let state = 'idle'; // idle | checking | ok | out | error
  let snap = null; // {event, attendees, canWrite}
  let plan = null;
  let info = null;
  let sig = '';
  let timer;
  let seq = 0;
  let dlg = null;
  let sending = false;
  let afterSync = null; // set by review(): runs once a send brings the event in sync
  let failures = []; // [{name, reason}] from the last send, shown in the dialog until the next one

  const signature = () => {
    const e = getEvent();
    if (!e?.neonEventId) return '';
    const regs = [...Object.entries(e.registrants || {}).map(([k, r]) => `${k}:${r.status || 'pending'}:${r.neonSeen}`), ...Object.values(e.attendees || {}).map((a) => `a:${a.name}`)].sort();
    return JSON.stringify([e.neonEventId, e.name, e.date, e.startTime, e.endTime, getLocationName(), regs]);
  };

  function renderChip() {
    const e = getEvent();
    if (!e?.neonEventId || state === 'idle' || state === 'error') {
      host.innerHTML = '';
      return;
    }
    const n = plan?.count || 0;
    const map = {
      checking: ['sync', 'Checking…', 'Checking the OSG Website', 'checking'],
      ok: ['check', 'In sync', 'Matches the OSG Website', 'ok'],
      out: ['alert', `Out of sync · ${n}`, `${n} difference${n === 1 ? '' : 's'} from the OSG Website. Tap to review and send.`, 'out'],
    };
    const [ic, label, tip, cls] = map[state];
    host.innerHTML = `<button type="button" class="sync-chip ${cls}" title="${esc(tip)}" aria-label="${esc(tip)}">${icon(ic)}<span class="wide">${esc(label)}</span></button>`;
    host.firstElementChild.onclick = openDialog;
  }

  async function check() {
    const e = getEvent();
    if (!e?.neonEventId) return;
    const mine = ++seq;
    state = 'checking';
    renderChip();
    try {
      info ||= await neonInfo();
      const s = await fetchNeonSync(e.neonEventId);
      if (mine !== seq) return;
      snap = s;
      onSnapshot?.(s.attendees);
      plan = neonSyncPlan(getEvent(), s.event, s.attendees, getLocationName());
      state = plan.inSync ? 'ok' : 'out';
    } catch (err) {
      if (mine !== seq) return;
      console.warn('OSG Website check failed', err);
      state = 'error'; // Neon unreachable or no Worker: stay quiet rather than cry wolf
    }
    renderChip();
    if (dlg && state === 'ok' && afterSync) {
      // Opened by review() and now in sync (for instance after "Check again"): carry on to where the user was headed.
      const next = afterSync;
      dlg.close();
      return next();
    }
    if (dlg) renderDialog();
  }

  function update() {
    const next = signature();
    if (next === sig) return;
    sig = next;
    clearTimeout(timer);
    if (!next) {
      state = 'idle';
      return renderChip();
    }
    timer = setTimeout(check, 500);
  }

  /* ----- dialog ----- */

  function openDialog() {
    if (dlg) return;
    dlg = document.createElement('dialog');
    dlg.className = 'sync-dlg';
    dlg.addEventListener('close', () => {
      afterSync = null;
      dlg.remove();
      dlg = null;
    });
    document.body.append(dlg);
    renderDialog();
    dlg.showModal();
  }

  function renderDialog() {
    if (!dlg) return;
    const e = getEvent();
    const writable = snap?.canWrite !== false && info?.canWrite !== false;
    const detailRows = (plan?.details || [])
      .map(
        (d) =>
          `<tr><th scope="row">${esc(d.label)}</th><td><s class="old">${esc(show(d.field, d.neon))}</s> <span aria-hidden="true">→</span> <b>${esc(show(d.field, d.local))}</b></td></tr>`,
      )
      .join('');
    const names = (list) => list.map((c) => esc(c.name)).join(', ');
    const here = (plan?.checkins || []).filter((c) => c.attended);
    const notHere = (plan?.checkins || []).filter((c) => !c.attended);
    const walk = plan?.walkins || [];
    const reasons = [...new Set(failures.map((f) => f.reason))];
    const failHtml = failures.length
      ? `<div class="notice warn">${icon('alert')} <span><b>${failures.length} could not be sent</b> (${esc(failures.slice(0, 5).map((f) => f.name).join(', '))}${failures.length > 5 ? '…' : ''}).<br>${reasons.map(esc).join('<br>')}</span></div>`
      : '';
    const body =
      state === 'error'
        ? `<p class="notice warn">${icon('alert')} <span>Could not check the OSG Website just now. Your changes are saved in RollCall. Try Check again, or close this and send them later.</span></p>`
        : state === 'checking' && !plan
        ? '<p class="muted">Checking the OSG Website…</p>'
        : plan?.inSync
          ? `<p>${icon('check')} Everything in RollCall matches the OSG Website.</p>`
          : `
        ${detailRows ? `<h3>Event details</h3><table class="sync-tbl"><tbody>${detailRows}</tbody></table>` : ''}
        ${here.length ? `<h3>Mark as here (${here.length})</h3><p>${names(here)}</p>` : ''}
        ${walk.length ? `<h3>Register on the OSG Website and mark as here (${walk.length})</h3><p>${names(walk)}</p><p class="muted tiny">Anyone without an OSG account goes in as a guest under your account.</p>` : ''}
        ${notHere.length ? `<h3>Mark as not here (${notHere.length})</h3><p>${names(notHere)}</p>` : ''}
        ${writable ? '' : `<p class="notice warn">${icon('alert')} <span>Sending to the OSG Website is turned off on this site.</span></p>`}`;
    dlg.innerHTML = `
      <form method="dialog" class="sync-body">
        <h2>${icon('sync')} ${esc(e?.name || 'Event')}</h2>
        <p class="muted tiny">RollCall is the source: these changes would be sent to the OSG Website.${info?.sandbox ? ' <b>Sandbox, not live data.</b>' : ''}</p>
        ${failHtml}
        ${body}
        <div class="actions">
          <button class="btn ghost" value="cancel">Close</button>
          <button class="btn" type="button" id="recheck" ${sending ? 'disabled' : ''}>${icon('sync')} Check again</button>
          ${plan && !plan.inSync && writable ? `<button class="btn primary" type="button" id="send" ${sending ? 'disabled' : ''}>${icon('send')} ${sending ? 'Sending…' : `Send ${plan.count} change${plan.count === 1 ? '' : 's'}`}</button>` : ''}
        </div>
      </form>`;
    dlg.querySelector('#recheck').onclick = () => {
      forgetNeonCache();
      check();
    };
    const send = dlg.querySelector('#send');
    if (send) send.onclick = doSend;
  }

  async function doSend() {
    if (sending || !plan || plan.inSync) return;
    sending = true;
    renderDialog();
    const { sent, failed, marked } = await pushNeonSync(getEvent().neonEventId, plan, snap.event);
    if (Object.keys(marked).length && getEvent()?.id) setNeonSeen(getEvent().id, marked).catch(() => {});
    sending = false;
    failures = failed;
    toast(
      failed.length
        ? `Sent ${sent}; ${failed.length} could not be sent. See the details in the dialog.`
        : `Sent ${sent} change${sent === 1 ? '' : 's'} to the OSG Website.`,
    );
    await check();
    if (dlg && plan?.inSync) {
      const next = afterSync;
      dlg.close();
      next?.();
    } else renderDialog();
  }

  /**
   * Check the OSG Website right now and, when the event differs, open the send dialog. Resolves true when it opened
   * (the caller stays put); onSynced runs if the user then sends and the event ends up in sync. False when the event is
   * not linked, in sync, or the OSG Website could not be reached.
   */
  async function review(onSynced) {
    if (!getEvent()?.neonEventId) return false;
    forgetNeonCache();
    clearTimeout(timer);
    // The page's own check may overtake this one, and the event may still be settling after a save: look again until
    // a check finishes on the same event data we asked about.
    for (let i = 0; i < 4; i++) {
      const asked = signature();
      sig = asked;
      await check();
      for (let wait = 0; state === 'checking' && wait < 50; wait++) await new Promise((r) => setTimeout(r, 200));
      if (signature() === asked) break;
    }
    // When the check itself failed, stay too: leaving would hide changes that were never compared with the OSG Website.
    if (state !== 'out' && state !== 'error') return false;
    openDialog();
    afterSync = onSynced;
    return true;
  }

  return {
    update,
    review,
    destroy() {
      clearTimeout(timer);
      seq++;
      dlg?.close();
    },
  };
}
