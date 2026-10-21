/** iPhones open emailed links in Safari, never in an installed Home Screen app (iPads and other phones can). */
export const isIPhone = (ua = typeof navigator === 'undefined' ? '' : navigator.userAgent) => /iPhone|iPod/.test(ua);

/** The first web link in whatever was pasted (a bare link, or a copied line with the link inside), or ''. */
export const linkFromPaste = (text) => (String(text || '').match(/https?:\/\/[^\s<>"']+/) || [''])[0];
