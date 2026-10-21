import { neonApi, fetchRegistrantsFor } from '../lib/neonApi.js';
import { loadExisting, newId, commitOps, eventHasPhotos, deleteEvents } from '../data.js';
import { esc, $, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { ymd, addDays } from '../lib/time.js';
import { planNeonEvents, emptyPastNeonEvents, staleRegistrantEvents } from '../lib/neon.js';

export function neonView(root, ctx) {
  if (!ctx.isAdmin) {
    root.innerHTML = `<section class="card"><p class="error">${icon('alert')} Admins only.</p>
      <a class="btn" href="#/settings">${icon('back')} Settings</a></section>`;
    return () => {};
  }
  const today = ymd();
  let plan = null;
  let busy = false;
  let registrantsFailed = 0;

  root.innerHTML = `
    <section class="bar"><a class="btn ghost" href="#/settings">${icon('back')} Settings</a></section>
    <h1 style="margin-bottom:14px">${icon('download', 'lg')} OSG Website events</h1>
    <section class="card">
      <h2>${icon('calendar')} 1. Choose dates</h2>
      <p class="muted">Pulls events from the OSG Website into RollCall. Existing events are never changed except to remember their link. Nothing is saved until you press Import.</p>
      <form id="range" class="add">
        <input id="from" class="input" type="date" required aria-label="From date" value="${today}" />
        <input id="to" class="input" type="date" required aria-label="To date" value="${addDays(today, 90)}" />
        <button class="btn" type="submit" id="fetch">${icon('search')} <span>Preview</span></button>
      </form>
    </section>
    <section class="card" id="preview" hidden></section>
    <section class="card">
      <h2>${icon('trash')} Clean up unused events</h2>
      <p class="muted">Past events imported from the OSG Website that have no participants, hours or photos. Removing one only deletes RollCall's copy; it stays on the OSG Website.</p>
      <button class="btn" type="button" id="findEmpty">${icon('search')} Find unused events</button>
      <div id="emptyOut" aria-live="polite"></div>
    </section>`;

  const box = $('#preview', root);

  function render() {
    const s = plan.stats;
    const problems = plan.rows.filter((r) => r.status !== 'ok' || /registered name|cancelled/.test(r.message));
    const writes = plan.ops.length;
    box.hidden = false;
    box.innerHTML = `
      <h2>${icon('check')} 2. Preview</h2>
      <div class="stats">
        <span class="pill">${icon('check')}<b>${s.created}</b> new</span>
        <span class="pill">${icon('swap')}<b>${s.linked}</b> linked to existing</span>
        ${s.registrants ? `<span class="pill">${icon('users')}<b>${s.registrants}</b> registered names</span>` : ''}
        ${s.newLocations ? `<span class="pill">${icon('pin')}<b>${s.newLocations}</b> new locations</span>` : ''}
        <span class="pill">${icon('copy')}<b>${s.skipped}</b> skipped</span>
        <span class="pill">${icon('alert')}<b>${s.errors}</b> with errors</span>
      </div>
      ${registrantsFailed ? `<p class="muted">${icon('alert')} Registered names could not be loaded for ${registrantsFailed} event${registrantsFailed === 1 ? '' : 's'}. Preview again to retry.</p>` : ''}
      ${
        problems.length
          ? `<div class="table-wrap"><table class="table"><thead><tr><th>Event</th><th>Result</th></tr></thead><tbody>
          ${problems
            .slice(0, 25)
            .map((r) => `<tr><td>${esc(r.label)}</td><td>${r.status === 'error' ? '⚠ ' : ''}${esc(r.message)}</td></tr>`)
            .join('')}
          </tbody></table></div>${problems.length > 25 ? `<p class="muted">…and ${problems.length - 25} more.</p>` : ''}`
          : ''
      }
      <div class="progress" id="prog" hidden><div></div></div>
      <div class="actions" style="margin-top:14px">
        <button class="btn primary" id="go" type="button" ${writes ? '' : 'disabled'}>${icon('upload')} Import ${writes} event${writes === 1 ? '' : 's'}</button>
      </div>`;

    $('#go', root).onclick = async () => {
      if (busy) return;
      busy = true;
      $('#go', root).disabled = true;
      const prog = $('#prog', root);
      prog.hidden = false;
      try {
        await commitOps(plan.ops, (done, total) => {
          prog.firstElementChild.style.width = `${Math.round((done / total) * 100)}%`;
        });
        toast(`Imported ${writes} event${writes === 1 ? '' : 's'}`);
        box.innerHTML = `<h2>${icon('check')} Done</h2><p>${s.created} new, ${s.linked} linked.</p>
          <a class="btn primary" href="#/">${icon('calendar')} Events</a>`;
        plan = null;
      } catch (e) {
        toast(e.code === 'permission-denied' ? 'Not allowed.' : 'Import failed. Try again.');
        $('#go', root).disabled = false;
      }
      busy = false;
    };
  }

  $('#findEmpty', root).onclick = async () => {
    const out = $('#emptyOut', root);
    const btn = $('#findEmpty', root);
    btn.disabled = true;
    out.innerHTML = `<p class="muted">Checking…</p>`;
    try {
      const { events } = await loadExisting();
      const found = [];
      for (const e of emptyPastNeonEvents(events, today)) if (!(await eventHasPhotos(e.id))) found.push(e);
      if (!found.length) {
        out.innerHTML = `<p class="muted">${icon('check')} Nothing to clean up.</p>`;
      } else {
        const n = found.length;
        out.innerHTML = `
          <div class="table-wrap"><table class="table"><thead><tr><th>Event</th><th>Date</th></tr></thead><tbody>
          ${found.slice(0, 50).map((e) => `<tr><td>${esc(e.name)}</td><td>${esc(e.date)}</td></tr>`).join('')}
          </tbody></table></div>${n > 50 ? `<p class="muted">…and ${n - 50} more.</p>` : ''}
          <button class="btn danger" type="button" id="delEmpty">${icon('trash')} Delete ${n} event${n === 1 ? '' : 's'}</button>`;
        $('#delEmpty', root).onclick = async () => {
          if (!confirm(`Delete ${n} unused event${n === 1 ? '' : 's'} from RollCall? This cannot be undone.`)) return;
          try {
            await deleteEvents(found.map((e) => e.id));
            toast(`Deleted ${n} event${n === 1 ? '' : 's'}`);
            out.innerHTML = `<p class="muted">${icon('check')} Deleted ${n}.</p>`;
          } catch (err) {
            toast(err.code === 'permission-denied' ? 'Not allowed.' : 'Could not delete. Try again.');
          }
        };
      }
    } catch {
      out.innerHTML = `<p class="error">${icon('alert')} Could not check. Are you online?</p>`;
    }
    btn.disabled = false;
  };

  $('#range', root).onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $('#fetch', root);
    btn.disabled = true;
    box.hidden = false;
    box.innerHTML = `<p class="muted">Asking the OSG Website…</p>`;
    try {
      const from = $('#from', root).value;
      const to = $('#to', root).value;
      const [{ events }, existing] = await Promise.all([
        neonApi(`events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
        loadExisting(),
      ]);
      // Registered names, so staff can confirm who came. Skip events whose stored names are up to date with Neon's count.
      const stale = new Set(staleRegistrantEvents(events, existing.events, today).map((n) => String(n.neonEventId)));
      const have = new Set(existing.events.filter((e) => e.registrants && e.neonEventId).map((e) => String(e.neonEventId)));
      const ids = [...new Set(events.map((e) => String(e.neonEventId)))].filter((id) => !have.has(id) || stale.has(id));
      const { byEvent, failed } = await fetchRegistrantsFor(ids, (done, total) => {
        box.innerHTML = `<p class="muted">Loading registered names… ${done} of ${total} events</p>`;
      });
      registrantsFailed = failed;
      plan = planNeonEvents(events, existing, newId, byEvent);
      render();
    } catch (e) {
      const msg =
        e.status === 503
          ? 'The OSG Website connection is not configured yet (NEON_ORG_ID and NEON_API_KEY).'
          : e.status === 429
            ? 'The OSG Website is busy. Try again in a moment.'
            : e.status
              ? `OSG Website error: ${e.message}`
              : 'Could not reach the OSG Website. Are you online?';
      box.innerHTML = `<p class="error">${icon('alert')} ${esc(msg)}</p>`;
    }
    btn.disabled = false;
  };

  return () => {};
}
