// Bouclier anti-pub exécuté dans youtube.com / music.youtube.com, avant les scripts de la page.
// Le blocage principal se fait en amont (réécriture des réponses réseau : src/main/netfilter.js,
// et filtres uBlock Origin/EasyList : src/main/adblock.js). Ce script ajoute :
//  - les contre-mesures anti-adblock (minuteur de 17 s, signalement d'anomalie, récupération du
//    player retenu), sur le modèle des règles YouTube de uBlock Origin ;
//  - un filet de sécurité : pub vidéo coupée, masquée et passée si elle arrive quand même ;
//  - la suppression du popup anti-bloqueur et des bannières Premium.
(function adshield() {
  'use strict';
  if (window.__vacuumAdShield) return;
  Object.defineProperty(window, '__vacuumAdShield', { value: true });

  let mutedByUs = false;
  let unstartedTicks = 0;

  // ------------------------------------------------------------------ Contre-mesures anti-adblock
  // (même principe que les règles YouTube actuelles de uBlock Origin / uAssets quick-fixes)
  // Les surcharges utilisent des Proxy : Function.prototype.toString renvoie toujours "[native code]".
  const hook = (obj, key, apply) => {
    try { obj[key] = new Proxy(obj[key], { apply }); } catch {}
  };

  // 1) YouTube retient la lecture par un minuteur natif de 17 s quand il soupçonne un bloqueur : on l'accélère.
  hook(window, 'setTimeout', (target, self, args) => {
    if (args[1] === 17000 && typeof args[0] === 'function' && String(args[0]).includes('[native code]')) args[1] = 17;
    return Reflect.apply(target, self, args);
  });

  // 2) Neutralise le callback "onAbnormalityDetected" (signalement de lecture anormale).
  hook(Promise.prototype, 'then', (target, self, args) => {
    if (typeof args[0] === 'function' && String(args[0]).includes('onAbnormalityDetected')) args[0] = function () {};
    return Reflect.apply(target, self, args);
  });

  // 3) Récupération du player bloqué : on recharge la vidéo en marquant la requête player pour que
  //    le serveur renvoie une version lisible sans pub. Plusieurs variantes, essayées tour à tour.
  const MARKERS = ['channel', 'lactmilli', 'yahi', 'inline'];
  let remaining = MARKERS.slice();
  let stuckSeen = false;
  let originalUA = null;
  let activeMarker = '';
  const cfgClient = () => window.ytcfg && window.ytcfg.data_ && window.ytcfg.data_.INNERTUBE_CONTEXT && window.ytcfg.data_.INNERTUBE_CONTEXT.client;
  function setMarker(m) {
    const c = cfgClient();
    if (!c) return;
    if (originalUA === null) originalUA = c.userAgent || '';
    activeMarker = m || '';
    const head = (originalUA.match && originalUA.match(/Mozilla\/5\.0 \([^)]+/) || [])[0];
    c.userAgent = m && head ? originalUA.replace(head, head + '; ' + m) : originalUA;
  }
  // Modifie la requête player sortante selon le marqueur présent dans le userAgent
  hook(JSON, 'stringify', (target, self, args) => {
    try {
      const o = args[0];
      if (o && typeof o === 'object') {
        const client = o.context && o.context.client;
        if (o.attestationRequest && client && typeof client.userAgent === 'string') {
          const ua = client.userAgent;
          const cpc = o.playbackContext && o.playbackContext.contentPlaybackContext;
          if (/\bchannel\b/.test(ua) && client.clientName === 'WEB') client.clientScreen = 'CHANNEL';
          if (/\blactmilli\b/.test(ua)) o.params = '8AUB';
          if (/\byahi\b/.test(ua)) o.params = 'YAHI';
          if (cpc) {
            if (/\binline\b/.test(ua)) cpc.isInlinePlaybackNoAd = true;
            if (/\b(channel|lactmilli|inline)\b/.test(ua)) cpc.lactMilliseconds = String(Date.now());
            if (/\b(channel|lactmilli|inline|yahi)\b/.test(ua) && typeof cpc.referer === 'string' && !cpc.referer.endsWith('#reloadxhr')) cpc.referer += '#reloadxhr';
          }
        } else if (o.createCommentParams && client && typeof client.userAgent === 'string') {
          client.userAgent = client.userAgent.replace(/; (channel|lactmilli|inline|yahi)\b/, '');
        }
      }
    } catch {}
    return Reflect.apply(target, self, args);
  });

  function playerInfo() {
    const p = document.getElementById('movie_player');
    const call = (f) => { try { return p && typeof p[f] === 'function' ? p[f]() : undefined; } catch { return undefined; } };
    const st = call('getPlayerStateObject');
    return { p, response: call('getPlayerResponse'), stats: call('getStatsForNerds'), progress: call('getProgressState'), buffering: st && st.isBuffering };
  }
  const looksStuck = (buffering, stats) => buffering && stats && stats.buffer_health_seconds === '0.00 s' && stats.resolution === '0x0' && remaining.length > 0;
  function noteStuck() {
    const { p, response, stats, buffering } = playerInfo();
    if (!p || !looksStuck(buffering, stats)) return;
    const url = response && response.playbackTracking && response.playbackTracking.videostatsPlaybackUrl && response.playbackTracking.videostatsPlaybackUrl.baseUrl;
    if (url && url.includes('reloadxhr')) remaining = remaining.slice(1); // la variante courante n'a pas suffi
    stuckSeen = true;
  }
  // Signaux internes émis par le player quand la lecture est retenue
  hook(Map.prototype, 'has', (target, self, args) => {
    if (args[0] === 'onSnackbarMessage' && !stuckSeen) noteStuck();
    return Reflect.apply(target, self, args);
  });
  hook(Array.prototype, 'push', (target, self, args) => {
    const a = args[0];
    if (a && typeof a === 'object' && a.constructor && a.constructor.name === 'Uint8Array' && a.buffer && a.buffer.byteLength === a.length && (a.length === 104 || a.length === 105)) noteStuck();
    return Reflect.apply(target, self, args);
  });

  function recover() {
    const { p, response, stats, progress, buffering } = playerInfo();
    if (!p || !/\/(watch\?|embed\/)/.test(location.href)) { remaining = MARKERS.slice(); return; }
    if (!(progress && progress.duration > 0 && (progress.loaded < progress.duration || progress.duration - progress.current > 1)) &&
        !(response && response.videoDetails && response.videoDetails.isLive)) return;
    if (stats && String(stats.debug_info || '').startsWith('SSAP, AD')) {
      // Pub insérée côté serveur dans le flux : on saute à sa fin
      if (progress && progress.duration > 0) try { p.seekTo(progress.duration); } catch {}
      return;
    }
    if (!response || !response.videoDetails) return;
    const id = response.videoDetails.videoId;
    const start = (response.playerConfig && response.playerConfig.playbackStartConfig && response.playerConfig.playbackStartConfig.startSeconds) ||
      parseInt(new URLSearchParams(location.search).get('t'), 10) || 0;
    const err = response.playabilityStatus && response.playabilityStatus.errorScreen;
    const errText = JSON.stringify((err && err.playerErrorMessageRenderer && err.playerErrorMessageRenderer.subreason && err.playerErrorMessageRenderer.subreason.runs) ||
      (err && err.playerInterstitialRenderer && err.playerInterstitialRenderer.content && err.playerInterstitialRenderer.content.interstitialViewModel &&
        err.playerInterstitialRenderer.content.interstitialViewModel.description && err.playerInterstitialRenderer.content.interstitialViewModel.description.commandRuns)) || '';
    const blockedByAdblockWall = response.playabilityStatus && response.playabilityStatus.status === 'UNPLAYABLE' &&
      !(err && err.playerErrorMessageRenderer && err.playerErrorMessageRenderer.playerCaptchaViewModel) &&
      errText.includes('WEB_PAGE_TYPE_UNKNOWN') && errText.includes('support.google.com/youtube/answer/3037019');
    // Variante refusée par le serveur ("vidéo non disponible") : on passe à la suivante
    const failedVariant = activeMarker && response.playabilityStatus && response.playabilityStatus.status === 'UNPLAYABLE';
    if (blockedByAdblockWall || failedVariant) {
      remaining = remaining.slice(1);
      setMarker(remaining[0] || '');
      stuckSeen = false;
      try { p.loadVideoById(id, start); } catch {}
    } else if (remaining.length === 0) {
      stuckSeen = false;
      setMarker('');
    } else if (stuckSeen && looksStuck(buffering, stats)) {
      setMarker(remaining[0]);
      stuckSeen = false;
      try { p.loadVideoById(id, start); } catch {}
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    let pending = false;
    const throttled = () => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; recover(); }, 150);
    };
    recover();
    new MutationObserver(throttled).observe(document, { childList: true, subtree: true });
    setInterval(throttled, 1000);
  });

  function tick() {
    const player = document.querySelector('#movie_player, .html5-video-player');
    const video = player ? player.querySelector('video') : null;
    const adShowing = !!player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'));

    if (adShowing && video) {
      if (!video.muted) { video.muted = true; mutedByUs = true; }
      if (isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.25) {
        video.currentTime = video.duration - 0.1;
      }
      document.querySelectorAll('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, button[id^="skip-button"], .ytp-ad-overlay-close-button')
        .forEach((b) => { try { b.click(); } catch {} });
    } else if (mutedByUs && video) {
      video.muted = false;
      mutedByUs = false;
    }

    // Player resté "non démarré" alors que la vidéo est prête (pause volontaire = état 2, non concerné)
    if (!adShowing && player && video && /^\/(watch|shorts)/.test(location.pathname) && typeof player.getPlayerState === 'function') {
      if (player.getPlayerState() === -1 && video.paused && video.currentTime === 0) {
        if (++unstartedTicks >= 6) { unstartedTicks = 0; try { player.playVideo(); } catch {} }
      } else unstartedTicks = 0;
    }

    // Popup anti-bloqueur de pub
    const enforcement = document.querySelector('ytd-enforcement-message-view-model');
    if (enforcement) {
      (enforcement.closest('tp-yt-paper-dialog') || enforcement).remove();
      document.querySelectorAll('tp-yt-iron-overlay-backdrop').forEach((b) => b.remove());
      if (video && video.paused) video.play().catch(() => {});
    }
    // Bannières Premium
    document.querySelectorAll('ytmusic-mealbar-promo-renderer, ytd-mealbar-promo-renderer, yt-mealbar-promo-renderer, ytmusic-statement-banner-renderer')
      .forEach((n) => n.remove());
  }

  function start() {
    const obs = new MutationObserver(tick);
    setInterval(() => {
      const player = document.querySelector('#movie_player, .html5-video-player');
      if (player && !player.__vacuumObserved) {
        player.__vacuumObserved = true;
        obs.observe(player, { attributes: true, attributeFilter: ['class'] });
      }
      tick();
    }, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
