// Cloudflare Pages Function: routes every /api/* request to the photo API in worker/index.js.
import worker from '../../worker/index.js';

export const onRequest = ({ request, env }) => worker.fetch(request, env);
