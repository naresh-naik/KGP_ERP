// KGP_ERP content script. Runs on erp.iitkgp.ac.in and drives the real login
// form, so the session cookies are set by the page itself exactly as in a
// manual login.
(() => {
  if (window.top !== window) return;

  const ATTEMPT_KEY = 'kgpass_attempt'; // set just before the form is submitted
  const SESSION_KEY = 'kgpass_logged_in'; // this tab has had a KGP_ERP login
  const ATTEMPT_TTL = 5 * 60 * 1000;
  const POLL_INTERVAL = 2500;
  const POLL_LIMIT = 40; // ~100 s of waiting for the OTP mail

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const normalizeQ = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

  const send = (msg) =>
    chrome.runtime
      .sendMessage(msg)
      .then((r) => r || { ok: false, reason: 'No response from KGP_ERP' })
      .catch((e) => ({ ok: false, reason: e.message || String(e) }));

  function readAttempt() {
    try {
      const a = JSON.parse(sessionStorage.getItem(ATTEMPT_KEY));
      return a && Date.now() - a.t < ATTEMPT_TTL ? a : null;
    } catch (e) {
      return null;
    }
  }

  // Sets a field the way typing would, so the page's own listeners react.
  function setValue(el, value) {
    el.readOnly = false;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    ).set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function post(path, body) {
    const res = await fetch(new URL(path, location.href), {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body
    });
    if (!res.ok) throw new Error('ERP returned HTTP ' + res.status);
    return res.text();
  }

  // ---------------------------------------------------------------- overlay
  const ui = (() => {
    let root, els;
    const COLORS = { work: '#38bdf8', ok: '#34d399', error: '#f87171', info: '#a5b4fc' };

    function build() {
      const host = document.createElement('div');
      host.id = 'kgpass-overlay';
      host.style.cssText =
        'position:fixed;right:20px;bottom:20px;z-index:2147483647;';
      root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `
        <style>
          :host { all: initial; }
          .card { width: 300px; box-sizing: border-box; padding: 14px 16px;
            background: #0f172a; color: #e2e8f0; border-radius: 12px;
            border: 1px solid #1e293b; border-left: 4px solid var(--accent);
            box-shadow: 0 10px 30px rgba(0,0,0,.35);
            font: 13px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif; }
          .head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
          .brand { font-weight: 700; font-size: 12px; letter-spacing: .04em;
            color: var(--accent); text-transform: uppercase; flex: 1; }
          .close { all: unset; cursor: pointer; color: #64748b; font-size: 16px;
            line-height: 1; padding: 2px 4px; }
          .close:hover { color: #e2e8f0; }
          .title { font-weight: 600; font-size: 14px; color: #f8fafc; }
          .msg { color: #94a3b8; margin-top: 2px; overflow-wrap: anywhere; }
          .spin { width: 12px; height: 12px; border-radius: 50%;
            border: 2px solid #334155; border-top-color: var(--accent);
            animation: r .8s linear infinite; }
          @keyframes r { to { transform: rotate(360deg); } }
          form { display: flex; gap: 6px; margin-top: 10px; }
          input { flex: 1; min-width: 0; padding: 7px 9px; border-radius: 7px;
            border: 1px solid #334155; background: #020617; color: #f8fafc;
            font: inherit; outline: none; }
          input:focus { border-color: var(--accent); }
          .btns { display: flex; gap: 6px; margin-top: 10px; }
          button.b { all: unset; cursor: pointer; padding: 6px 12px;
            border-radius: 7px; font: 600 12px/1.4 inherit; font-family: inherit;
            background: #1e293b; color: #e2e8f0; }
          button.b.primary { background: var(--accent); color: #0f172a; }
          button.b:hover { filter: brightness(1.15); }
          [hidden] { display: none !important; }
        </style>
        <div class="card">
          <div class="head">
            <div class="spin"></div>
            <div class="brand">KGP_ERP</div>
            <button class="close" title="Hide">×</button>
          </div>
          <div class="title"></div>
          <div class="msg"></div>
          <form hidden><input type="password" autocomplete="off">
            <button class="b primary" type="submit">Save</button></form>
          <div class="btns"></div>
        </div>`;
      els = {
        host,
        card: root.querySelector('.card'),
        spin: root.querySelector('.spin'),
        title: root.querySelector('.title'),
        msg: root.querySelector('.msg'),
        form: root.querySelector('form'),
        input: root.querySelector('input'),
        btns: root.querySelector('.btns')
      };
      root.querySelector('.close').addEventListener('click', () => host.remove());
      document.documentElement.appendChild(host);
    }

    function show({ kind = 'work', title, msg = '', buttons = [] }) {
      if (!root) build();
      if (!els.host.isConnected) document.documentElement.appendChild(els.host);
      els.card.style.setProperty('--accent', COLORS[kind]);
      els.spin.hidden = kind !== 'work';
      els.title.textContent = title;
      els.msg.textContent = msg;
      els.form.hidden = true;
      els.btns.replaceChildren(
        ...buttons.map(({ label, primary, onClick }) => {
          const b = document.createElement('button');
          b.className = 'b' + (primary ? ' primary' : '');
          b.textContent = label;
          b.addEventListener('click', onClick);
          return b;
        })
      );
    }

    // Shows a one-line prompt and resolves with what the user typed.
    function ask({ title, msg, placeholder }) {
      show({ kind: 'info', title, msg });
      els.form.hidden = false;
      els.input.value = '';
      els.input.placeholder = placeholder;
      els.input.focus();
      return new Promise((resolve) => {
        els.form.onsubmit = (e) => {
          e.preventDefault();
          const v = els.input.value.trim();
          if (v) resolve(v);
        };
      });
    }

    return { show, ask, hide: () => els?.host.remove() };
  })();

  // ------------------------------------------------------------ login flow
  let running = false;
  let cancelled = false;

  class Cancelled extends Error {}
  const checkpoint = () => {
    if (cancelled) throw new Cancelled();
  };
  const cancelButton = { label: 'Cancel', onClick: () => (cancelled = true) };

  async function run() {
    if (running) return;
    running = true;
    cancelled = false;
    sessionStorage.removeItem(SESSION_KEY);
    try {
      await login();
    } catch (e) {
      if (e instanceof Cancelled) {
        ui.show({
          kind: 'info',
          title: 'Cancelled',
          msg: 'You can finish logging in by hand.',
          buttons: [{ label: 'Start again', primary: true, onClick: run }]
        });
      } else {
        ui.show({
          kind: 'error',
          title: 'Login stopped',
          msg: e.message || String(e),
          buttons: [
            { label: 'Try again', primary: true, onClick: run },
            { label: 'Settings', onClick: () => send({ type: 'openOptions' }) }
          ]
        });
      }
    } finally {
      running = false;
    }
  }

  async function login() {
    const form = $('loginForm');
    const store = await chrome.storage.local.get(['rollNumber', 'password', 'answers']);
    const answers = store.answers || {};

    ui.show({ title: 'Filling in your details…', buttons: [cancelButton] });
    setValue($('user_id'), store.rollNumber);
    setValue($('password'), store.password);

    // 1. Security question
    const question = (
      await post('getSecurityQues.htm', new URLSearchParams({ user_id: store.rollNumber }))
    ).trim();
    checkpoint();
    if (!question || question.includes('FALSE')) {
      throw new Error(
        `ERP does not recognise the roll number "${store.rollNumber}". Check it in KGP_ERP settings.`
      );
    }
    const label = $('question');
    if (label) label.textContent = question;

    const key = normalizeQ(question);
    let answer = answers[key]?.a;
    let learned = false;
    if (!answer) {
      answer = await ui.ask({
        title: 'New security question',
        msg: `${question} — answer it once and KGP_ERP will remember it.`,
        placeholder: 'Your answer'
      });
      learned = true;
      checkpoint();
    }
    setValue($('answer'), answer);

    // 2. Note what is already in the inbox, then ask ERP to send the OTP
    ui.show({ title: 'Requesting OTP…', buttons: [cancelButton] });
    const baseline = await send({ type: 'gmailBaseline' });
    checkpoint();
    const since = Date.now();
    const raw = await post('getEmilOTP.htm', new URLSearchParams(new FormData(form)));
    let reply = raw;
    try {
      reply = JSON.parse(raw).msg || raw;
    } catch (e) {
      // Not JSON — treat the raw text as the message.
    }
    if (/unable to send otp|mismatch|error/i.test(String(reply))) {
      const hint = learned ? ' The answer you typed was not saved.' : '';
      throw new Error(`ERP refused to send the OTP: ${String(reply).slice(0, 160)}${hint}`);
    }
    if (learned) {
      // ERP only sends the OTP when password and answer are right, so it is
      // now safe to remember this answer.
      answers[key] = { q: question, a: answer };
      await chrome.storage.local.set({ answers });
    }
    const otpField = $('email_otp1');
    otpField.readOnly = false;
    $('loginFormSubmitButton')?.classList.remove('d-none');

    const manual = (title, msg) => {
      sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify({ t: Date.now() }));
      ui.show({ kind: 'info', title, msg });
      otpField.focus();
    };

    if (!baseline.ok) {
      const why =
        baseline.reason === 'not_signed_in'
          ? 'You are not signed in to Gmail in this browser, so'
          : `Gmail could not be read (${baseline.reason}), so`;
      manual('OTP sent to your email', `${why} type the OTP and press Log In.`);
      return;
    }

    // 3. Wait for the new OTP mail
    let otp = null;
    let lastError = '';
    for (let i = 0; i < POLL_LIMIT && !otp; i++) {
      ui.show({
        title: 'Waiting for the OTP email…',
        msg: `${Math.round((Date.now() - since) / 1000)} s`,
        buttons: [cancelButton]
      });
      await sleep(POLL_INTERVAL);
      checkpoint();
      const res = await send({
        type: 'gmailCheck',
        baseline: baseline.ids,
        mode: baseline.mode,
        since
      });
      checkpoint();
      if (res.ok) otp = res.otp;
      else lastError = res.reason;
    }
    if (!otp) {
      manual(
        'OTP email not found',
        (lastError ? `Gmail said: ${lastError}. ` : 'It has not shown up as unread mail in your Gmail inbox yet. ') +
          'Type the OTP and press Log In.'
      );
      return;
    }

    // 4. Submit the real form
    setValue(otpField, otp);
    sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify({ t: Date.now() }));
    ui.show({ title: 'Signing in…' });
    HTMLFormElement.prototype.submit.call(form);
  }

  // ------------------------------------------------------------- entrypoint
  async function main() {
    const onLoginPage = Boolean($('loginForm') && $('user_id') && $('email_otp1'));
    const attempt = readAttempt();

    if (!onLoginPage) {
      // First ERP page after a submitted login: that login worked.
      if (attempt && location.pathname.startsWith('/IIT_ERP3')) {
        sessionStorage.removeItem(ATTEMPT_KEY);
        sessionStorage.setItem(SESSION_KEY, '1');
        await chrome.storage.local.set({ lastLogin: Date.now() });
        ui.show({ kind: 'ok', title: 'Logged in', msg: 'Signed in to ERP by KGP_ERP.' });
        setTimeout(ui.hide, 2500);
      }
      return;
    }

    const cfg = await chrome.storage.local.get([
      'rollNumber',
      'password',
      'autoLogin',
      'forceRun'
    ]);
    const forced = cfg.forceRun && Date.now() - cfg.forceRun < 60 * 1000;
    if (cfg.forceRun) await chrome.storage.local.remove('forceRun');
    const start = { label: 'Log in with KGP_ERP', primary: true, onClick: run };

    if (attempt) {
      // We submitted and ERP sent us back to the login page. Never retry on
      // our own: repeated wrong attempts can lock the account.
      sessionStorage.removeItem(ATTEMPT_KEY);
      const pageError = document
        .querySelector('.alert-danger, .text-danger, .error, #errorMsg')
        ?.textContent.replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
      ui.show({
        kind: 'error',
        title: 'The last login did not go through',
        msg: pageError || 'ERP returned to the login page. KGP_ERP will not retry by itself.',
        buttons: [
          { label: 'Try again', primary: true, onClick: run },
          { label: 'Settings', onClick: () => send({ type: 'openOptions' }) }
        ]
      });
      return;
    }

    if (!cfg.rollNumber || !cfg.password) {
      ui.show({
        kind: 'info',
        title: 'KGP_ERP is not set up yet',
        msg: 'Add your roll number and password to log in automatically.',
        buttons: [
          { label: 'Open settings', primary: true, onClick: () => send({ type: 'openOptions' }) }
        ]
      });
      return;
    }

    if (forced) return run();

    if (sessionStorage.getItem(SESSION_KEY)) {
      // Logged in earlier in this tab, so this is a logout or a timeout.
      // Auto-starting here would undo a deliberate logout.
      ui.show({ kind: 'info', title: 'You are logged out', buttons: [start] });
      return;
    }

    if (cfg.autoLogin === false) {
      ui.show({ kind: 'info', title: 'Auto-login is off', buttons: [start] });
      return;
    }

    run();
  }

  // The popup's Login button reaches an already-open login page this way.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'kgpassRun') return;
    const onLoginPage = Boolean($('loginForm'));
    sendResponse({ onLoginPage });
    if (onLoginPage) run();
  });

  main().catch((e) => console.warn('KGP_ERP:', e));
})();
