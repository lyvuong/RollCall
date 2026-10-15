import { loadExisting, newId, commitOps } from '../data.js';
import { esc, $, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toCSV } from '../lib/csv.js';
import { planImport, TEMPLATES, isAmsExport, amsToEventsCsv, amsToPeopleCsv } from '../lib/importer.js';

const HELP = {
  people: {
    title: 'People (OSG and community members)',
    columns: [
      ['name', 'Full name (required)'],
      ['type', '"osg" (OSG member) or "community" (required)'],
    ],
  },
  events: {
    title: 'Past events',
    columns: [
      ['name', 'Event name (required)'],
      ['date', 'YYYY-MM-DD or M/D/YYYY (required)'],
      ['start, end', '24h "13:30" or "1:30 PM" (required)'],
      ['format', 'in-person, virtual or both (default in-person)'],
      ['location', 'Created in Settings if new'],
      ['description', 'Optional'],
      ['volunteer hours', 'Optional total, used until volunteers are marked on the event'],
      ['attendees', 'Names separated by ";". For new people add ":osg" or ":community" (default community); add a second ":volunteer" to set the role (default participant), e.g. "Sam Lee:community:volunteer"'],
    ],
  },
};

export function importView(root, _ctx) {
  let kind = 'people';
  let text = '';
  let plan = null;
  let planInput = null;
  let overwrite = false;
  let busy = false;

  root.innerHTML = `
    <section class="bar"><a class="btn ghost" href="#/settings">${icon('back')} Settings</a></section>
    <h1 style="margin-bottom:14px">${icon('upload', 'lg')} Import data</h1>
    <section class="card">
      <div class="seg" role="group" aria-label="What to import">
        <button type="button" data-k="people">${icon('users')} People</button>
        <button type="button" data-k="events">${icon('calendar')} Past events</button>
      </div>
      <div id="help"></div>
    </section>
    <section class="card">
      <h2>${icon('file')} 1. Choose a file</h2>
      <p class="muted">Pick your <b>AMS export</b> CSV (one row per attendee) or an OSG Activity Roll Call template. It is detected automatically, on either tab. Nothing is saved until you press Import in step 2.</p>
      <div class="dropzone">
        <input type="file" id="file" accept=".csv,.tsv,.txt,text/csv" aria-label="CSV file" />
        <span class="muted">or paste CSV text</span>
        <textarea id="paste" class="input" rows="4" placeholder="name,type&#10;Jane Doe,community"></textarea>
      </div>
    </section>
    <section class="card" id="preview" hidden></section>`;

  const segButtons = root.querySelectorAll('[data-k]');

  function renderHelp() {
    const h = HELP[kind];
    segButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.k === kind)));
    $('#help', root).innerHTML = `
      <h2 style="margin-top:16px">${esc(h.title)}</h2>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Column</th><th>Format</th></tr></thead>
        <tbody>${h.columns.map(([c, d]) => `<tr><td><code>${esc(c)}</code></td><td>${esc(d)}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="muted">Column order does not matter. Existing names and events are skipped, so it is safe to re-import.
        ${kind === 'events' ? 'Import people first if you want their type exact.' : ''}</p>
      <button class="btn" id="tpl" type="button">${icon('download')} Download template</button>`;
    $('#tpl', root).onclick = () => {
      const blob = new Blob([toCSV(TEMPLATES[kind])], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `rollcall-${kind}-template.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
  }

  async function buildPreview() {
    const box = $('#preview', root);
    if (!text.trim()) {
      plan = null;
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.innerHTML = `<p class="muted">Checking…</p>`;
    let existing;
    try {
      existing = await loadExisting();
    } catch {
      box.innerHTML = `<p class="error">${icon('alert')} Could not load existing data. Are you online?</p>`;
      return;
    }
    const src = isAmsExport(text) ? (kind === 'events' ? amsToEventsCsv(text) : amsToPeopleCsv(text)) : text;
    planInput = { src, existing };
    replan();
  }

  function replan() {
    plan = planImport(kind, planInput.src, planInput.existing, newId, { overwrite });
    renderPreview();
  }

  function renderPreview() {
    const box = $('#preview', root);
    if (plan.fatal) {
      box.innerHTML = `<h2>${icon('alert')} 2. Preview</h2><p class="error">${icon('alert')} ${esc(plan.fatal)}</p>`;
      return;
    }
    const s = plan.stats;
    const problems = plan.rows.filter((r) => r.status !== 'ok');
    const writes = plan.ops.length;
    box.innerHTML = `
      <h2>${icon('check')} 2. Preview</h2>
      <label class="check-row"><input type="checkbox" id="ow" ${overwrite ? 'checked' : ''} />
        <span>Overwrite existing ${kind === 'people' ? 'people (update their type)' : 'events (replaces attendees, roles and hours)'}</span></label>
      <div class="stats">
        <span class="pill">${icon('check')}<b>${s.ready}</b> ready</span>
        ${s.replaced ? `<span class="pill warn">${icon('alert')}<b>${s.replaced}</b> overwritten</span>` : ''}
        <span class="pill">${icon('copy')}<b>${s.skipped}</b> skipped</span>
        <span class="pill">${icon('alert')}<b>${s.errors}</b> with errors</span>
        ${s.newPeople && kind === 'events' ? `<span class="pill">${icon('userPlus')}<b>${s.newPeople}</b> new people</span>` : ''}
        ${s.newLocations ? `<span class="pill">${icon('pin')}<b>${s.newLocations}</b> new locations</span>` : ''}
      </div>
      ${
        problems.length
          ? `<div class="table-wrap"><table class="table"><thead><tr><th>Line</th><th>Row</th><th>Result</th></tr></thead><tbody>
          ${problems
            .slice(0, 25)
            .map(
              (r) =>
                `<tr><td>${r.line}</td><td>${esc(r.label)}</td><td>${r.status === 'error' ? '⚠ ' : ''}${esc(r.message)}</td></tr>`,
            )
            .join('')}
          </tbody></table></div>${problems.length > 25 ? `<p class="muted">…and ${problems.length - 25} more.</p>` : ''}`
          : ''
      }
      <div class="progress" id="prog" hidden><div></div></div>
      <div class="actions" style="margin-top:14px">
        <button class="btn primary" id="go" type="button" ${writes && !busy ? '' : 'disabled'}>
          ${icon('upload')} Import ${s.ready} ${kind === 'people' ? 'people' : 'events'}</button>
      </div>
      ${s.errors ? `<p class="muted">Rows with errors are left out. Fix them in your file and import again.</p>` : ''}`;

    $('#ow', root).onchange = (ev) => {
      overwrite = ev.target.checked;
      replan();
    };

    $('#go', root).onclick = async () => {
      if (s.replaced && !confirm(`Overwrite ${s.replaced} existing ${kind === 'people' ? 'people' : 'events'}? This replaces their saved data.`)) return;
      busy = true;
      const prog = $('#prog', root);
      prog.hidden = false;
      $('#go', root).disabled = true;
      try {
        await commitOps(plan.ops, (done, total) => {
          prog.firstElementChild.style.width = `${Math.round((done / total) * 100)}%`;
        });
        toast(`Imported ${s.ready} ${kind === 'people' ? 'people' : 'events'}`);
        $('#preview', root).innerHTML = `
          <h2>${icon('check')} Done</h2>
          <p>${s.ready} ${kind === 'people' ? 'people' : 'events'} imported.</p>
          <a class="btn primary" href="${kind === 'people' ? '#/settings' : '#/'}">${icon(kind === 'people' ? 'settings' : 'calendar')} Continue</a>`;
        text = '';
        plan = null;
        overwrite = false;
        $('#paste', root).value = '';
        $('#file', root).value = '';
      } catch (e) {
        toast(e.code === 'permission-denied' ? 'Not allowed.' : 'Import failed. Try again.');
        busy = false;
        $('#go', root).disabled = false;
      }
      busy = false;
    };
  }

  segButtons.forEach((b) => {
    b.onclick = () => {
      kind = b.dataset.k;
      $('#paste', root).placeholder =
        kind === 'people' ? 'name,type\nJane Doe,community' : 'name,date,start,end,format,location,attendees';
      renderHelp();
      buildPreview();
    };
  });

  $('#file', root).onchange = async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    text = await file.text();
    $('#paste', root).value = '';
    buildPreview();
  };
  let timer;
  $('#paste', root).oninput = (ev) => {
    text = ev.target.value;
    clearTimeout(timer);
    timer = setTimeout(buildPreview, 400);
  };

  renderHelp();
  return () => clearTimeout(timer);
}
