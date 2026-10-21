import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import {
  onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut,
  isSignInWithEmailLink, sendSignInLinkToEmail, signInWithEmailLink,
} from 'firebase/auth';
import { auth } from './firebase.js';
import { getMember, getMembership, getIsAdmin, redeemInvite, setMyName, syncRoster } from './data.js';
import { esc, $, toast } from './lib/dom.js';
import { icon, logo } from './lib/icons.js';
import { isIPhone, linkFromPaste } from './lib/emailLink.js';
import { applyTheme, toggleTheme, effective } from './lib/theme.js';
import { homeView } from './views/home.js';
import { eventView } from './views/event.js';
import { participantsView } from './views/people.js';
import { settingsView } from './views/settings.js';
import { importView } from './views/import.js';
import { neonView } from './views/neon.js';
import { aboutView } from './views/about.js';
import { reportView } from './views/report.js';
import { photosView } from './views/photos.js';

applyTheme();

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

const EMAIL_KEY = 'rollcall.emailForSignIn';
const store = {
  get: () => { try { return localStorage.getItem(EMAIL_KEY) || ''; } catch { return ''; } },
  set: (v) => { try { localStorage.setItem(EMAIL_KEY, v); } catch { /* private mode */ } },
  clear: () => { try { localStorage.removeItem(EMAIL_KEY); } catch { /* private mode */ } },
};

async function finishEmailLink(email, link = location.href) {
  try {
    await signInWithEmailLink(auth, email, link);
    store.clear();
    history.replaceState(null, '', location.pathname + location.hash);
  } catch (e) {
    history.replaceState(null, '', location.pathname + location.hash);
    showLogin(`That sign-in link is invalid or has expired (${e.code || e.message}). Request a new one.`);
  }
}

function showConfirmEmail() {
  renderCard(`
    ${logo(64)}
    <h1>Confirm your email</h1>
    <p class="muted">Enter the email address you requested the sign-in link with.</p>
    <form id="confirm" class="form">
      <input id="email" class="input" type="email" autocomplete="email" placeholder="you@example.org" aria-label="Email" required />
      <button class="btn primary block" type="submit">${icon('login')} Continue</button>
    </form>`);
  $('#confirm').onsubmit = (e) => {
    e.preventDefault();
    finishEmailLink($('#email').value.trim());
  };
}

function showLogin(error = '', sentTo = '') {
  if (isSignInWithEmailLink(auth, location.href)) {
    const email = store.get();
    return email ? finishEmailLink(email) : showConfirmEmail();
  }
  // On an iPhone the emailed link opens in Safari, not this app, so offer pasting it here. Shown while a link is
  // pending (the app may have been closed while the user fetched it from their mail).
  const pending = sentTo || store.get();
  const paste = isIPhone() && pending;
  renderCard(`
    ${logo(72)}
    <h1>OSG Activity Roll Call</h1>
    <p class="muted">Roll call and volunteer hours for OSG events.</p>
    ${error ? `<p class="error">${icon('alert')}${esc(error)}</p>` : ''}
    ${sentTo ? `<p class="muted">${icon('check')} Link sent to ${esc(sentTo)}. ${paste ? 'Check your email.' : 'Open it on this device to sign in.'}</p>` : ''}
    ${
      paste
        ? `<form id="pasteForm" class="form">
      <p class="muted">On iPhone, tapping the link opens Safari instead of this app. Instead, press and hold the link in your email, choose <b>Copy Link</b>, then paste it here.</p>
      <input id="pasteLink" class="input" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste the sign-in link" aria-label="Sign-in link" required />
      <button class="btn primary block" type="submit">${icon('login')} Sign in with this link</button>
    </form>
    <p class="muted">or</p>`
        : ''
    }
    <button class="btn ${paste ? '' : 'primary '}block" id="signin">${icon('login')} Sign in with Google</button>
    <p class="muted">or</p>
    <form id="emailForm" class="form">
      <input id="email" class="input" type="email" autocomplete="email" placeholder="Email address" aria-label="Email address" value="${esc(pending && !sentTo ? pending : '')}" required />
      <button class="btn block" type="submit">${icon('login')} ${paste ? 'Send a new link' : 'Email me a sign-in link'}</button>
    </form>`);
  if (paste) {
    $('#pasteForm').onsubmit = (e) => {
      e.preventDefault();
      const link = linkFromPaste($('#pasteLink').value);
      if (!isSignInWithEmailLink(auth, link)) return showLogin('That does not look like the sign-in link from the email. Copy the whole link and try again.');
      finishEmailLink(store.get() || pending, link);
    };
  }
  $('#signin').onclick = async () => {
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (e) {
      if (e.code !== 'auth/popup-closed-by-user') showLogin(`Sign-in failed: ${e.code || e.message}`);
    }
  };
  $('#emailForm').onsubmit = async (e) => {
    e.preventDefault();
    const email = $('#email').value.trim();
    try {
      await sendSignInLinkToEmail(auth, email, { url: location.origin + location.pathname, handleCodeInApp: true });
      store.set(email);
      showLogin('', email);
    } catch (err) {
      showLogin(`Could not send the link: ${err.code || err.message}`);
    }
  };
}

function showJoin(user, error = '') {
  renderCard(`
    ${logo(64)}
    <h1>Enter invitation code</h1>
    <p class="muted">Signed in as ${esc(user.email)}. Ask an admin for a code.</p>
    ${error ? `<p class="error">${icon('alert')}${esc(error)}</p>` : ''}
 <form id="join" class="form">
      <input id="yourName" class="input" autocomplete="name" maxlength="80" value="${esc(user.displayName || '')}"
             placeholder="Your name (shown on event rosters)" aria-label="Your name" required />
      <input id="code" class="input code" autocomplete="off" autocapitalize="characters"
             maxlength="16" placeholder="CODE" aria-label="Invitation code" required />
      <button class="btn primary block" type="submit">${icon('key')} Join</button>
    </form>
    <button class="btn ghost" id="signout">${icon('logout')} Use a different account</button>`);
  $('#signout').onclick = () => signOut(auth);
  if (import.meta.env.VITE_USE_EMULATOR === '1') {
    // Local mode: scripts/local.mjs grants membership a moment after sign-in.
    const timer = setInterval(async () => {
      if (!document.getElementById('join')) return clearInterval(timer);
      if (await getMembership(user.uid)) (clearInterval(timer), enter(user));
    }, 1500);
  }
  $('#join').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await redeemInvite(user, $('#code').value, $('#yourName').value);
      await enter(user);
    } catch (err) {
      const denied = err.code === 'permission-denied';
      showJoin(user, denied ? 'That code is invalid or has expired.' : `Could not join: ${err.message}`);
    }
  };
}

function showName(user) {
  renderCard(`
    ${logo(64)}
    <h1>What's your name?</h1>
    <p class="muted">Used to add you to event rosters as a volunteer.</p>
    <form id="nameForm" class="form">
      <input id="yourName" class="input" autocomplete="name" maxlength="80" value="${esc(user.displayName || '')}"
             placeholder="Your name" aria-label="Your name" required />
      <button class="btn primary block" type="submit">${icon('check')} Continue</button>
    </form>`);
  $('#nameForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await setMyName(user.uid, $('#yourName').value);
      await enter(user);
    } catch (err) {
      toast(`Could not save your name (${err.code || err.message}).`);
    }
  };
}

async function enter(user) {
  const member = await getMember(user.uid);
  if (!member) return showJoin(user);
  if (!member.name) return showName(user);
  ctx = { user, name: member.name, role: member.role || null, isAdmin: await getIsAdmin(user.uid) };
  if (member.role) syncRoster(user.uid, member.name, member.role).catch(() => {});
  renderShell();
  route();
}

onAuthStateChanged(auth, (user) => {
  ctx = null;
  if (cleanup) cleanup(), (cleanup = null);
  if (!user) return showLogin();
  renderCard(`${logo(56)}<p class="muted">Loading…</p>`);
  enter(user);
});

/* ---------- shell & router ---------- */

const NAV = [
  { key: 'home', href: '#/', label: 'Events', icon: 'calendar' },
  { key: 'settings', href: '#/settings', label: 'Settings', icon: 'settings' },
];
const navHtml = NAV.map(
  (n) => `<a class="navlink" href="${n.href}" data-nav="${n.key}">${icon(n.icon)}<span>${n.label}</span></a>`,
).join('');

function themeButton() {
  const dark = effective() === 'dark';
  const btn = $('#themeBtn');
  if (!btn) return;
  btn.innerHTML = icon(dark ? 'sun' : 'moon');
  btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  btn.title = btn.getAttribute('aria-label');
}

function renderShell() {
  app.innerHTML = `
    <header class="appbar">
      <a href="#/" class="brand">${logo(36)}<span>OSG Activity Roll Call</span></a>
      <nav class="topnav" aria-label="Main">${navHtml}</nav>
      <span class="spacer"></span>
      <button class="icon-btn" id="themeBtn" type="button"></button>
    </header>
    <div id="offline" class="offline" role="status" hidden>${icon('cloudOff')} Offline — changes will sync when you reconnect.</div>
    <main id="view"></main>
    <footer class="site-foot"><a class="info-badge" href="#/about" aria-label="About this app" title="About">${icon('info')}</a> v${esc(__APP_VERSION__)} · © ${new Date().getFullYear()} OSG. All rights reserved.</footer>
    <nav class="tabbar" aria-label="Main">${navHtml}</nav>`;
  $('#themeBtn').onclick = toggleTheme;
  themeButton();
  syncOffline();
}
window.addEventListener('themechange', themeButton);

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
  } else if (hash === '/about') {
    nav = 'settings';
    cleanup = aboutView(view);
  } else if (hash === '/report' || hash.startsWith('/report?')) {
    cleanup = reportView(view, ctx);
  } else if (hash === '/import') {
    nav = 'settings';
    cleanup = importView(view, ctx);
  } else if (hash === '/neon') {
    nav = 'settings';
    cleanup = neonView(view, ctx);
  } else if (hash === '/event/new') {
    cleanup = eventView(view, ctx, null);
  } else if ((m = hash.match(/^\/event\/([^/]+)\/photos$/))) {
    cleanup = photosView(view, ctx, m[1]);
  } else if ((m = hash.match(/^\/event\/([^/]+)\/people$/))) {
    cleanup = participantsView(view, ctx, m[1]);
  } else if ((m = hash.match(/^\/event\/([^/]+)$/))) {
    cleanup = eventView(view, ctx, m[1]);
  } else {
    cleanup = homeView(view, ctx);
  }
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === nav;
    a.classList.toggle('active', on);
    on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);

window.addEventListener('unhandledrejection', (e) => {
  if (ctx) toast(e.reason?.code === 'permission-denied' ? 'Not allowed.' : 'Something went wrong.');
});
