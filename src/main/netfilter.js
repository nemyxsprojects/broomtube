// Filtrage des réponses réseau, à la manière de uBlock Origin sous Firefox (filterResponseData).
// Via le protocole DevTools (domaine Fetch), les réponses du player YouTube sont réécrites AVANT
// que la page ne les reçoive : les champs publicitaires sont renommés, donc ignorés par le player.
// Rien n'est modifié dans le JavaScript de la page, ce qui rend la technique indétectable côté page.

const PATTERNS = [
  { urlPattern: '*://www.youtube.com/watch*', resourceType: 'Document', requestStage: 'Response' },
  { urlPattern: '*://www.youtube.com/shorts/*', resourceType: 'Document', requestStage: 'Response' },
  { urlPattern: '*://music.youtube.com/watch*', resourceType: 'Document', requestStage: 'Response' },
  { urlPattern: '*://*.youtube.com/youtubei/v1/player*', requestStage: 'Response' },
  { urlPattern: '*://*.youtube.com/youtubei/v1/get_watch*', requestStage: 'Response' },
  { urlPattern: '*://*.youtube.com/youtubei/v1/reel/reel_watch_sequence*', requestStage: 'Response' },
];

// Renommer (plutôt que supprimer) garde un JSON valide et une taille quasi identique.
const AD_FIELDS = /"(adPlacements|adSlots|playerAds|adBreakHeartbeatParams)"/g;

let isEnabled = () => true;

function rewrite(body) {
  return body.replace(AD_FIELDS, '"no_$1"');
}

const wired = new WeakSet();

function attach(wc) {
  const dbg = wc.debugger;
  const first = !wired.has(wc);
  wired.add(wc);
  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
  } catch (e) {
    console.warn('[netfilter] attach impossible', e.message);
    return;
  }
  const send = (method, params) => dbg.sendCommand(method, params).catch(() => {});
  send('Fetch.enable', { patterns: PATTERNS });

  if (!first) return;
  dbg.on('message', async (_e, method, params) => {
    if (method !== 'Fetch.requestPaused') return;
    const { requestId, responseStatusCode, responseHeaders = [] } = params;
    if (!isEnabled() || !responseStatusCode || responseStatusCode < 200 || responseStatusCode >= 300) {
      return send('Fetch.continueRequest', { requestId });
    }
    try {
      const r = await dbg.sendCommand('Fetch.getResponseBody', { requestId });
      const text = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
      const out = rewrite(text);
      if (out === text) return send('Fetch.continueRequest', { requestId });
      const headers = responseHeaders.filter((h) => !/^(content-length|content-encoding)$/i.test(h.name));
      await dbg.sendCommand('Fetch.fulfillRequest', {
        requestId,
        responseCode: responseStatusCode,
        responseHeaders: headers,
        body: Buffer.from(out, 'utf8').toString('base64'),
      });
    } catch {
      send('Fetch.continueRequest', { requestId });
    }
  });

  dbg.on('detach', (_e, reason) => {
    // Réattache si la vue existe encore (ex. crash du renderer) ; pas si l'utilisateur ouvre DevTools
    if (reason !== 'target closed' && !wc.isDestroyed()) setTimeout(() => { if (!wc.isDestroyed()) attach(wc); }, 500);
  });
}

function init(enabledFn) { isEnabled = enabledFn; }

module.exports = { init, attach, rewrite };
