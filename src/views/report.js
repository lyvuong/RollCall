import { fetchEventsInRange, fetchLocations } from '../data.js';
import { esc, $, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { ymd } from '../lib/time.js';
import { eventsToCsv } from '../lib/exporter.js';
import { PRESETS } from './home.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function reportView(root, _ctx) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const fallback = PRESETS[2].get(ymd()); // this month
  let range = {
    from: ISO.test(q.get('from') || '') ? q.get('from') : fallback.from,
    to: ISO.test(q.get('to') || '') ? q.get('to') : fallback.to,
  };
  let events = [];
  let seq = 0; // drops stale responses when the range changes quickly

  root.innerHTML = `
    <section class="bar"><a class="btn ghost" href="#/">${icon('back')} Events</a></section>
    <h1 style="margin-bottom:14px">${icon('download', 'lg')} Report</h1>
    <section class="card">
      <p class="muted">Choose a date range. The CSV uses the same columns as the import file, so it can be imported again.</p>
      <div class="chips" id="chips"></div>
      <div class="dates">
        <label class="field"><span class="lbl">${icon('calendar')} From</span>
          <input type="date" id="from" class="input" /></label>
        <label class="field"><span class="lbl">${icon('calendar')} To</span>
          <input type="date" id="to" class="input" /></label>
      </div>
      <p id="count" class="muted" aria-live="polite"></p>
      <div class="actions">
        <button class="btn primary" id="go" type="button" disabled>${icon('download')} Download CSV</button>
      </div>
    </section>`;

  const from = $('#from', root);
  const to = $('#to', root);
  const go = $('#go', root);
  const count = $('#count', root);

  async function refresh() {
    from.value = range.from;
    to.value = range.to;
    const today = ymd();
    $('#chips', root).innerHTML = PRESETS.filter((p) => p.key !== 'default')
      .map((p) => {
        const r = p.get(today);
        return `<button type="button" class="chip" data-p="${p.key}" aria-pressed="${r.from === range.from && r.to === range.to}">${esc(p.label)}</button>`;
      })
      .join('');
    events = [];
    go.disabled = true;
    if (!range.from || !range.to || range.from > range.to) {
      count.textContent = 'Pick a valid range (From must not be after To).';
      return;
    }
    const mine = ++seq;
    count.textContent = 'Counting…';
    try {
      const rows = await fetchEventsInRange(range.from, range.to);
      if (mine !== seq) return;
      events = rows;
      count.textContent = `${rows.length} event${rows.length === 1 ? '' : 's'} in this range.`;
      go.disabled = !rows.length;
    } catch {
      if (mine === seq) count.textContent = 'Could not load events. Are you online?';
    }
  }

  from.onchange = () => ((range = { ...range, from: from.value }), refresh());
  to.onchange = () => ((range = { ...range, to: to.value }), refresh());
  $('#chips', root).onclick = (ev) => {
    const b = ev.target.closest('[data-p]');
    if (!b) return;
    range = PRESETS.find((p) => p.key === b.dataset.p).get(ymd());
    refresh();
  };

  go.onclick = async () => {
    go.disabled = true;
    try {
      const locations = await fetchLocations();
      // BOM so Excel reads UTF-8 names correctly; the importer strips it again.
      const blob = new Blob(['﻿' + eventsToCsv(events, locations)], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `rollcall-events-${range.from}_to_${range.to}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`Exported ${events.length} event${events.length === 1 ? '' : 's'}`);
    } catch {
      toast('Export failed. Try again.');
    }
    go.disabled = !events.length;
  };

  refresh();
  return () => {
    seq++;
  };
}
