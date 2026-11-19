// KGP_ERP service worker: the only place that talks to Gmail.
// It is stateless on purpose — the page polls it one request at a time, so it
// does not matter if Chrome suspends and restarts the worker mid-login.

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const OTP_QUERY = 'from:erpkgp@adm.iitkgp.ac.in newer_than:1d';
// Tolerance between this computer's clock and Gmail's when judging "new mail".
const CLOCK_SKEW_MS = 90 * 1000;

function clientIdConfigured() {
  const id = chrome.runtime.getManifest().oauth2?.client_id || '';
  return id.endsWith('.apps.googleusercontent.com') && !id.startsWith('YOUR_');
}

async function getToken(interactive) {
  const result = await chrome.identity.getAuthToken({ interactive });
  return typeof result === 'string' ? result : result?.token;
}

async function gmailFetch(path, retry = true) {
  let token;
  try {
    token = await getToken(false);
  } catch (e) {
    throw new Error('GMAIL_NOT_CONNECTED');
  }
  if (!token) throw new Error('GMAIL_NOT_CONNECTED');

  const res = await fetch(GMAIL_API + path, {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (res.status === 401 && retry) {
    // Cached token expired or was revoked: drop it and let Chrome mint a new one.
    await chrome.identity.removeCachedAuthToken({ token });
    return gmailFetch(path, false);
  }
  if (!res.ok) throw new Error('Gmail API error ' + res.status);
  return res.json();
}

async function listOtpMessages() {
  const data = await gmailFetch(
    'messages?maxResults=5&q=' + encodeURIComponent(OTP_QUERY)
  );
  return (data.messages || []).map((m) => m.id);
}

function decodeBase64Url(data) {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function collectText(part, out) {
  if (!part) return;
  if (part.body?.data && /^text\//.test(part.mimeType || 'text/plain')) {
    let text = decodeBase64Url(part.body.data);
    if (part.mimeType === 'text/html') text = text.replace(/<[^>]+>/g, ' ');
    out.push(text);
  }
  (part.parts || []).forEach((p) => collectText(p, out));
}

function extractOtp(text) {
  const patterns = [
    /\bis\s*:?\s*(\d{4,8})\b/i, // "... OTP ... is 123456"
    /\bOTP\b[^0-9]{0,80}?(\d{4,8})\b/i, // "OTP: 123456"
    /\b(\d{6})\b/ // any standalone 6-digit number
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  const all = text.match(/\b\d{4,8}\b/g);
  return all ? all[all.length - 1] : null;
}

async function readOtp(id) {
  const msg = await gmailFetch('messages/' + id + '?format=full');
  const subject =
    (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === 'subject')
      ?.value || '';
  const bodies = [];
  collectText(msg.payload, bodies);
  // Body first (most specific), then subject, then Gmail's snippet as a fallback.
  const otp =
    extractOtp(bodies.join('\n')) ||
    extractOtp(subject) ||
    extractOtp(msg.snippet || '');
  return { otp, date: Number(msg.internalDate) || 0 };
}

// Finds an OTP mail that arrived after `since` and was not in the inbox before
// the OTP was requested (`baseline`). Both checks together guarantee that a
// leftover OTP from an earlier login is never used.
async function checkForOtp(baseline, since) {
  const known = new Set(baseline || []);
  const ids = await listOtpMessages();
  for (const id of ids) {
    if (known.has(id)) continue;
    const { otp, date } = await readOtp(id);
    if (date && date < since - CLOCK_SKEW_MS) continue;
    if (otp) return otp;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Zero-setup mode: Gmail's inbox feed, read with the browser's own Gmail
// sign-in. No Google Cloud project or permission screen is needed. It lists
// the newest unread inbox mail for each signed-in account.
const FEED_URL = (u) => `https://mail.google.com/mail/u/${u}/feed/atom`;
const MAX_ACCOUNTS = 5;
const OTP_SENDER = 'erpkgp@adm.iitkgp.ac.in';

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function parseFeed(xml) {
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
    return m ? unescapeXml(m[1].trim()) : '';
  };
  const head = xml.split('<entry>')[0];
  const email = (tag(head, 'title').match(/[^\s@]+@[^\s@]+/) || [''])[0];
  const entries = (xml.match(/<entry>[\s\S]*?<\/entry>/g) || []).map((e) => ({
    id: tag(e, 'id'),
    title: tag(e, 'title'),
    summary: tag(e, 'summary'),
    from: tag(e, 'email').toLowerCase(),
    date: Date.parse(tag(e, 'issued') || tag(e, 'modified')) || 0
  }));
  return { email, entries };
}

async function readFeed(u) {
  let res;
  try {
    res = await fetch(FEED_URL(u), { credentials: 'include', cache: 'no-store' });
  } catch (e) {
    return null;
  }
  if (!res.ok) return null; // 401 = not signed in at this account slot
  const feed = parseFeed(await res.text());
  return feed.email || feed.entries.length ? feed : null;
}

// Every Gmail account signed in to this browser, in account-switcher order.
async function readAllFeeds() {
  const feeds = [];
  for (let u = 0; u < MAX_ACCOUNTS; u++) {
    const feed = await readFeed(u);
    if (!feed) break;
    if (feeds.some((f) => f.email === feed.email)) break; // slot wrapped around
    feeds.push(feed);
  }
  await chrome.storage.local.set({ feedAccounts: feeds.map((f) => f.email) });
  return feeds;
}

const isOtpMail = (e) => e.from === OTP_SENDER || /\bOTP\b/i.test(e.title);

async function feedBaseline() {
  const feeds = await readAllFeeds();
  if (!feeds.length) return { ok: false, reason: 'not_signed_in' };
  return { ok: true, mode: 'feed', ids: feeds.flatMap((f) => f.entries.map((e) => e.id)) };
}

async function feedCheck(baseline, since) {
  const known = new Set(baseline || []);
  for (const feed of await readAllFeeds()) {
    for (const e of feed.entries) {
      if (known.has(e.id) || !isOtpMail(e)) continue;
      if (e.date && e.date < since - CLOCK_SKEW_MS) continue;
      const otp = extractOtp(e.summary) || extractOtp(e.title);
      if (otp) return otp;
    }
  }
  return null;
}

async function feedTest() {
  const feeds = await readAllFeeds();
  const mails = feeds.flatMap((f) => f.entries).filter((e) => e.from === OTP_SENDER);
  return {
    ok: true,
    accounts: feeds.map((f) => f.email),
    unreadOtpMails: mails.length,
    parsed: mails.some((e) => extractOtp(e.summary) || extractOtp(e.title))
  };
}
// ---------------------------------------------------------------------------

async function connectGmail() {
  if (!clientIdConfigured()) throw new Error('CLIENT_ID_MISSING');
  const token = await getToken(true);
  if (!token) throw new Error('Google did not return an access token.');
  const profile = await gmailFetch('profile');
  await chrome.storage.local.set({ gmailEmail: profile.emailAddress });
  return profile.emailAddress;
}

async function disconnectGmail() {
  try {
    const token = await getToken(false);
    if (token) {
      await chrome.identity.removeCachedAuthToken({ token });
      // Best effort: also withdraw the grant on Google's side.
      fetch('https://oauth2.googleapis.com/revoke?token=' + token, {
        method: 'POST'
      }).catch(() => {});
    }
  } catch (e) {
    // Nothing cached — already disconnected as far as Chrome is concerned.
  }
  await chrome.storage.local.remove('gmailEmail');
}

async function gmailReady() {
  const { gmailEmail } = await chrome.storage.local.get('gmailEmail');
  return Boolean(gmailEmail) && clientIdConfigured();
}

const handlers = {
  // Uses the Gmail API when the optional OAuth connection exists, otherwise
  // the browser's own Gmail sign-in.
  async gmailBaseline() {
    if (await gmailReady()) {
      try {
        return { ok: true, mode: 'api', ids: await listOtpMessages() };
      } catch (e) {
        // Fall through to the feed if the API connection has gone bad.
      }
    }
    return feedBaseline();
  },
  async gmailCheck({ baseline, since, mode }) {
    const otp =
      mode === 'api' ? await checkForOtp(baseline, since) : await feedCheck(baseline, since);
    return { ok: true, otp };
  },
  async gmailAccounts() {
    return { ok: true, accounts: (await readAllFeeds()).map((f) => f.email) };
  },
  async feedTest() {
    return feedTest();
  },
  async gmailConnect() {
    return { ok: true, email: await connectGmail() };
  },
  async gmailDisconnect() {
    await disconnectGmail();
    return { ok: true };
  },
  async gmailTest() {
    const ids = await listOtpMessages();
    if (!ids.length) return { ok: true, found: false };
    const { otp, date } = await readOtp(ids[0]);
    return { ok: true, found: true, parsed: Boolean(otp), date };
  },
  async openOptions() {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, reason: e.message || String(e) }));
  return true; // keep the channel open for the async reply
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { autoLogin } = await chrome.storage.local.get('autoLogin');
  if (autoLogin === undefined) await chrome.storage.local.set({ autoLogin: true });
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

// Exposed for the unit test only (ignored by Chrome).
if (typeof module !== 'undefined') module.exports = { extractOtp, parseFeed };
