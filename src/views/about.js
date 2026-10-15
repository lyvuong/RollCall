import { esc } from '../lib/dom.js';
import { icon } from '../lib/icons.js';

const REPO = 'https://github.com/lyvuong/RollCall';

const FEATURES = [
  ['calendar', 'Events', 'Create events with date, time, format (virtual, in-person or hybrid) and a location.'],
  ['users', 'Roll call', 'Record participants and volunteers per event; saved people and OSG / Community types.'],
  ['hourglass', 'Volunteer hours', 'Total hours = event hours × volunteers, with flags for events that still need volunteers identified.'],
  ['upload', 'CSV import', 'Bring in past events and people, including AMS exports.'],
  ['cloudOff', 'Works offline', 'Installable PWA that keeps working with poor venue wifi and syncs later.'],
  ['key', 'Invitation-only access', 'Staff sign in with Google and join with an invitation code.'],
];

const TECH = [
  ['Vite + vanilla JavaScript', 'Fast, dependency-light front end'],
  ['Firebase Auth + Firestore', 'Google sign-in, data and security rules'],
  ['PWA (Workbox)', 'Installable, offline-capable, auto-updating'],
  ['Cloudflare Pages', 'Hosting with deploys from GitHub'],
  ['Vitest', 'Unit tests for hours and import logic'],
];

export function aboutView(root) {
  root.innerHTML = `
    <section class="bar"><h1>${icon('shield', 'lg')} About</h1></section>

    <section class="card">
      <h2>OSG Activity Roll Call</h2>
      <p class="muted">Take roll call at OSG events quickly, track volunteer hours, and keep a history of who took part.</p>
      <p class="muted"><small>Version ${esc(__APP_VERSION__)}</small></p>
    </section>

    <section class="card">
      <h2>${icon('check')} Features</h2>
      <ul class="about-list">
        ${FEATURES.map(([i, t, d]) => `<li>${icon(i)}<div><strong>${esc(t)}</strong><span class="muted">${esc(d)}</span></div></li>`).join('')}
      </ul>
    </section>

    <section class="card">
      <h2>${icon('settings')} Technologies</h2>
      <ul class="about-list">
        ${TECH.map(([t, d]) => `<li><div><strong>${esc(t)}</strong><span class="muted">${esc(d)}</span></div></li>`).join('')}
      </ul>
    </section>

    <section class="card">
      <h2>${icon('user')} Developer</h2>
      <div class="dev">
        <img class="avatar-lg" src="/avatar.png" alt="Ly Vuong" width="72" height="72" onerror="this.style.display='none'" />
        <div>
          <strong>Ly Vuong</strong>
          <span class="muted">Creator &amp; Lead Engineer</span>
        </div>
      </div>
      <p class="muted">Engineered with a focus on privacy, fast performance and a simple experience on phones, so OSG staff can take roll call quickly at events.</p>
      <div class="chips">
        <a class="chip" href="${REPO}" target="_blank" rel="noopener noreferrer">${icon('file')} GitHub repository</a>
        <a class="chip" href="${REPO}/issues" target="_blank" rel="noopener noreferrer">${icon('alert')} Report an issue</a>
      </div>
      <p class="muted"><small>© ${new Date().getFullYear()} Ly Vuong. All rights reserved.</small></p>
    </section>`;
  return () => {};
}
