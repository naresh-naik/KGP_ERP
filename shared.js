// Helpers shared by the popup and the settings page.
const ERP_URL = 'https://erp.iitkgp.ac.in/IIT_ERP3/';

const send = (msg) =>
  chrome.runtime
    .sendMessage(msg)
    .then((r) => r || { ok: false, reason: 'No response' })
    .catch((e) => ({ ok: false, reason: e.message || String(e) }));

function clientIdConfigured() {
  const id = chrome.runtime.getManifest().oauth2?.client_id || '';
  return id.endsWith('.apps.googleusercontent.com') && !id.startsWith('YOUR_');
}

function relativeTime(ts, now = Date.now()) {
  const mins = Math.floor((now - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

// Always an unambiguous date with the time, e.g. "13 Nov 2026, 9:32 pm · 5 min ago".
function formatLastLogin(ts, now = Date.now()) {
  if (!ts) return 'Never';
  const when = new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(new Date(ts));
  return `${when} · ${relativeTime(ts, now)}`;
}

if (typeof module !== 'undefined') module.exports = { formatLastLogin, relativeTime };
