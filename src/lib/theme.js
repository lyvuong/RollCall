const KEY = 'rollcall-theme'; // 'system' | 'light' | 'dark'
const COLORS = { light: '#f6f4ff', dark: '#15131f' };

export function getPref() {
  try {
    return localStorage.getItem(KEY) || 'system';
  } catch {
    return 'system';
  }
}

export function effective(pref = getPref()) {
  if (pref === 'system') return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return pref;
}

export function applyTheme(pref = getPref()) {
  const t = effective(pref);
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', COLORS[t]);
  window.dispatchEvent(new CustomEvent('themechange', { detail: t }));
}

export function setPref(pref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* storage unavailable: theme applies for this session only */
  }
  applyTheme(pref);
}

export function toggleTheme() {
  setPref(effective() === 'dark' ? 'light' : 'dark');
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (getPref() === 'system') applyTheme('system');
});
