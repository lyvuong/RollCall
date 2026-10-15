import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import { auth } from './firebase.js';
import { getMembership, getIsAdmin, redeemInvite } from './data.js';
import { esc, $, toast } from './lib/dom.js';
import { homeView } from './views/home.js';
import { eventView } from './views/event.js';
import { settingsView } from './views/settings.js';

// Auto-update: a new deploy produces a new service worker. Installed phones
// check on launch, when the app returns to the foreground, and hourly; the new
// version activates and the page reloads itself (data is safe in Firestore).
const UPDATE_CHECK_MS = 60 * 60 * 1000;
registerSW({
  immediate: true,
  onRegisteredSW(_url, reg) {
    if (!reg) return;
    const check = () => navigator.onLine && reg.update().catch(() => {});
    setInterval(check, UPDATE_CHECK_MS);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
  },
});
if ('serviceWorker' in navigator) {
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('Updating to the latest version…');
    hadController = true;
  });
}

const app = document.getElementById('app');
let ctx = null; // { user, isAdmin } when signed in and a member
let cleanup = null;

/* ---------- auth gate ---------- */

function renderCard(html) {
  app.innerHTML = `<main class="center"><div class="card gate">${html}</div></main>`;
}

function showLogin(error = '') {
  renderCard(`
    <h1>RollCall</h1>
    <p class="muted">Staff roll call for OSG events.</p>
    ${error ? `<p class="error">${esc(error)}</p>` : ''}
    <button class="btn primary block" id="signin">Sign in with Google</button>`);
  $('#signin').onclick = async () => {
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (e) {
      if (e.code !== 'auth/popup-closed-by-user') showLogin(`Sign-in failed: ${e.code || e.message}`);
    }
  };
}

function showJoin(user, error = '') {
  renderCard(`
    <h1>Enter invitation code</h1>
    <p class="muted">Signed in as ${esc(user.email)}. Ask an admin for a code.</p>
    ${error ? `<p class="error">${esc(error)}</p>` : ''}
    <form id="join">
      <input id="code" class="input code" autocomplete="off" autocapitalize="characters"
             maxlength="16" placeholder="CODE" required />
      <button class="btn primary block" type="submit">Join</button>
    </form>
    <button class="btn link" id="signout">Use a different account</button>`);
  $('#signout').onclick = () => signOut(auth);
  $('#join').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await redeemInvite(user, $('#code').value);
      await enter(user);
    } catch (err) {
      const denied = err.code === 'permission-denied';
      showJoin(user, denied ? 'That code is invalid or has expired.' : `Could not join: ${err.message}`);
    }
  };
}

async function enter(user) {
  if (!(await getMembership(user.uid))) return showJoin(user);
  ctx = { user, isAdmin: await getIsAdmin(user.uid) };
  renderShell();
  route();
}

onAuthStateChanged(auth, (user) => {
  ctx = null;
  if (cleanup) cleanup(), (cleanup = null);
  if (!user) return showLogin();
  renderCard('<p class="muted">Loading…</p>');
  enter(user);
});

/* ---------- shell & router ---------- */

function renderShell() {
  app.innerHTML = `
    <header class="top">
      <a href="#/" class="brand">RollCall</a>
      <nav>
        <a href="#/" data-nav="home">Events</a>
        <a href="#/settings" data-nav="settings">Settings</a>
      </nav>
    </header>
    <div id="offline" class="offline" hidden>Offline — changes will sync when you reconnect.</div>
    <main id="view"></main>`;
  syncOffline();
}

function syncOffline() {
  const el = $('#offline');
  if (el) el.hidden = navigator.onLine;
}
window.addEventListener('online', syncOffline);
window.addEventListener('offline', syncOffline);

function route() {
  if (!ctx) return;
  const view = $('#view');
  if (!view) return;
  if (cleanup) cleanup(), (cleanup = null);
  view.innerHTML = '';

  const hash = location.hash.replace(/^#/, '') || '/';
  let m;
  let nav = 'home';
  if (hash === '/settings') {
    nav = 'settings';
    cleanup = settingsView(view, ctx);
  } else if (hash === '/event/new') {
    cleanup = eventView(view, ctx, null);
  } else if ((m = hash.match(/^\/event\/([^/]+)$/))) {
    cleanup = eventView(view, ctx, m[1]);
  } else {
    cleanup = homeView(view, ctx);
  }
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);

window.addEventListener('unhandledrejection', (e) => {
  if (ctx) toast(e.reason?.code === 'permission-denied' ? 'Not allowed.' : 'Something went wrong.');
});
