import { auth } from '../firebase.js';
import { loadExisting, newId, commitOps } from '../data.js';
import { esc, $, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { ymd, addDays } from '../lib/time.js';
import { planNeonEvents } from '../lib/neon.js';

async function neonApi(path, init = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const token = await user.getIdToken();
  const res = await fetch(`/api/neon/${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  return body;
}

export function neonView(root, ctx) {
  if (!ctx.isAdmin) {
    root.innerHTML = `<section class="card"><p class="error">${icon('alert')} Admins only.</p>
      <a class="btn" href="#/settings">${icon('back')} Settings</a></section>`;
    return () => {};
  }
  const today = ymd();
  let plan = null;
  let busy = false;

  root.innerHTML = `
    <section class="bar"><a class="btn ghost" href="#/settings">${icon('back')} Settings</a></section>
    <h1 style="margin-bottom:14px">${icon('download', 'lg')} Neon One events</h1>
    <section class="card">
      <h2>${icon('calendar')} 1. Choose dates</h2>
      <p class="muted">Pulls events from Neon One into RollCall. Existing events are never changed except to remember their Neon link. Nothing is saved until you press Import.</p>
      <form id="range" class="add">
        <input id="from" class="input" type="date" required aria-label="From date" value="${today}" />
        <input id="to" class="input" type="date" required aria-label="To date" value="${addDays(today, 90)}" />
        <button class="btn" type="submit" id="fetch">${icon('search')} <span>Preview</span></button>
      </form>
    </section>
    <section class="card" id="preview" hidden></section>`;

  const box = $('#preview', root);

  function render() {
    const s = plan.stats;
    const problems = plan.rows.filter((r) => r.status !== 'ok');
    const writes = plan.ops.length;
    box.hidden = false;
    box.innerHTML = `
      <h2>${icon('check')} 2. Preview</h2>
      <div class="stats">
        <span class="pill">${icon('check')}<b>${s.created}</b> new</span>
        <span class="pill">${icon('swap')}<b>${s.linked}</b> linked to existing</span>
        <span class="pill">${icon('copy')}<b>${s.skipped}</b> skipped</span>
        <span class="pill">${icon('alert')}<b>${s.errors}</b> with errors</span>
      </div>
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

  $('#range', root).onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $('#fetch', root);
    btn.disabled = true;
    box.hidden = false;
    box.innerHTML = `<p class="muted">Asking Neon One…</p>`;
    try {
      const from = $('#from', root).value;
      const to = $('#to', root).value;
      const [{ events }, existing] = await Promise.all([
        neonApi(`events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
        loadExisting(),
      ]);
      plan = planNeonEvents(events, existing.events, newId);
      render();
    } catch (e) {
      const msg =
        e.status === 503
          ? 'Neon One is not configured yet (NEON_ORG_ID and NEON_API_KEY).'
          : e.status === 429
            ? 'Neon One is busy. Try again in a moment.'
            : e.status
              ? `Neon One error: ${e.message}`
              : 'Could not reach Neon One. Are you online?';
      box.innerHTML = `<p class="error">${icon('alert')} ${esc(msg)}</p>`;
    }
    btn.disabled = false;
  };

  return () => {};
}
