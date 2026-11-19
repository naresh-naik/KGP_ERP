const el = (id) => document.getElementById(id);

function note(node, text, cls = 'muted') {
  node.textContent = text;
  node.className = 'note ' + cls + (node.id === 'accountNote' ? ' grow' : '');
}

function setValue(node, text, cls) {
  node.textContent = text;
  node.title = text;
  node.className = cls || '';
}

// ------------------------------------------------------------------ account
async function loadAccount() {
  const s = await chrome.storage.local.get(['rollNumber', 'password']);
  el('roll').value = s.rollNumber || '';
  el('password').value = s.password || '';
}

el('account').addEventListener('submit', async (e) => {
  e.preventDefault();
  const rollNumber = el("roll").value.trim();
  const password = el('password').value;
  if (!rollNumber || !password) return;
  const before = await chrome.storage.local.get('rollNumber');
  const update = { rollNumber, password };
  // Saved answers belong to one account; do not carry them to another.
  if (before.rollNumber && before.rollNumber !== rollNumber) update.answers = {};
  await chrome.storage.local.set(update);
  el('roll').value = rollNumber;
  note(el('accountNote'), 'Saved.', 'ok');
});

el('showPassword').addEventListener('click', () => {
  const field = el('password');
  const show = field.type === 'password';
  field.type = show ? 'text' : 'password';
  el('showPassword').textContent = show ? 'Hide password' : 'Show password';
});

// ------------------------------------------------------------------ answers
async function renderAnswers() {
  const { answers = {} } = await chrome.storage.local.get('answers');
  const keys = Object.keys(answers);
  el('noAnswers').hidden = keys.length > 0;

  el('answers').replaceChildren(
    ...keys.map((key) => {
      const row = document.createElement('div');
      row.className = 'qa';

      const q = document.createElement('div');
      q.className = 'q';
      q.textContent = answers[key].q;

      const a = document.createElement('input');
      a.type = 'password';
      a.value = answers[key].a;
      a.setAttribute('aria-label', 'Answer');
      a.placeholder = 'Type your answer';
      a.autocomplete = 'off';
      a.addEventListener('focus', () => (a.type = 'text'));
      a.addEventListener('blur', () => (a.type = 'password'));
      a.addEventListener('change', async () => {
        const value = a.value.trim();
        if (!value) return renderAnswers();
        const { answers: current = {} } = await chrome.storage.local.get('answers');
        if (current[key]) current[key].a = value;
        await chrome.storage.local.set({ answers: current });
        note(el('answersNote'), 'Answer saved.', 'ok');
      });

      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = 'Remove';
      del.addEventListener('click', async () => {
        const { answers: current = {} } = await chrome.storage.local.get('answers');
        delete current[key];
        await chrome.storage.local.set({ answers: current });
      });

      row.append(q, a, del);
      return row;
    })
  );
}

// Must match the key used by content.js when it looks an answer up.
const normalizeQ = (q) => String(q).replace(/\s+/g, ' ').trim().toLowerCase();

async function addQuestions(questions, answer = '') {
  const { answers = {} } = await chrome.storage.local.get('answers');
  let added = 0;
  for (const q of questions) {
    const key = normalizeQ(q);
    if (!key) continue;
    if (!answers[key]) added++;
    if (!answers[key] || answer) answers[key] = { q: q.trim(), a: answer || answers[key]?.a || '' };
  }
  await chrome.storage.local.set({ answers });
  return added;
}

// ERP shows one of the account's three questions at random, so ask until all
// three have been seen.
el('fetchQuestions').addEventListener('click', async () => {
  const { rollNumber } = await chrome.storage.local.get('rollNumber');
  if (!rollNumber) {
    return note(el('answersNote'), 'Save your roll number above first.', 'warn');
  }
  const button = el('fetchQuestions');
  button.disabled = true;
  note(el('answersNote'), 'Asking ERP for your questions…');
  try {
    const found = new Set();
    for (let i = 0; i < 15 && found.size < 3; i++) {
      const res = await fetch('https://erp.iitkgp.ac.in/SSOAdministration/getSecurityQues.htm', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({ user_id: rollNumber })
      });
      if (!res.ok) throw new Error('ERP returned HTTP ' + res.status);
      const text = (await res.text()).trim();
      if (!text || text.includes('FALSE')) {
        throw new Error(`ERP does not recognise the roll number "${rollNumber}".`);
      }
      if (text.length > 300 || text.includes('<')) {
        throw new Error('ERP sent an unexpected reply instead of a question.');
      }
      found.add(text);
    }
    await addQuestions([...found]);
    note(
      el('answersNote'),
      `Found ${found.size} question${found.size === 1 ? '' : 's'}. Type each answer in its box.`,
      'ok'
    );
  } catch (e) {
    note(el('answersNote'), 'Could not fetch questions: ' + (e.message || e), 'bad');
  } finally {
    button.disabled = false;
  }
});

el('showAdd').addEventListener('click', () => {
  el('addForm').hidden = !el('addForm').hidden;
  if (!el('addForm').hidden) el('newQuestion').focus();
});

el('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = el('newQuestion').value.trim();
  const a = el('newAnswer').value.trim();
  if (!q || !a) return;
  await addQuestions([q], a);
  el('addForm').reset();
  el('addForm').hidden = true;
  note(el('answersNote'), 'Question saved.', 'ok');
});

// -------------------------------------------------------------------- gmail
async function renderGmail() {
  const { gmailEmail, feedAccounts = [] } = await chrome.storage.local.get([
    'gmailEmail',
    'feedAccounts'
  ]);
  if (feedAccounts.length) setValue(el('gmailStatus'), feedAccounts.join(', '), 'ok');
  else setValue(el('gmailStatus'), 'Not signed in to Gmail in this browser', 'warn');

  const configured = clientIdConfigured();
  el('extId').textContent = chrome.runtime.id;
  el('connect').hidden = Boolean(gmailEmail);
  el('connect').disabled = !configured;
  el('disconnect').hidden = !gmailEmail;
  if (gmailEmail) setValue(el('apiStatus'), 'Connected: ' + gmailEmail, 'ok');
  else setValue(el('apiStatus'), configured ? 'Not connected' : 'Not set up', 'muted');
}

el('connect').addEventListener('click', async () => {
  note(el('gmailNote'), 'Waiting for Google…');
  const res = await send({ type: 'gmailConnect' });
  if (res.ok) note(el('gmailNote'), 'Gmail API connected as ' + res.email, 'ok');
  else note(el('gmailNote'), 'Could not connect: ' + res.reason, 'bad');
});

el('disconnect').addEventListener('click', async () => {
  await send({ type: 'gmailDisconnect' });
  note(el('gmailNote'), 'Gmail API disconnected.');
});

el('test').addEventListener('click', async () => {
  note(el('gmailNote'), 'Checking Gmail…');
  const res = await send({ type: 'feedTest' });
  if (!res.ok) return note(el('gmailNote'), 'Gmail check failed: ' + res.reason, 'bad');
  if (!res.accounts.length) {
    return note(
      el('gmailNote'),
      'KGP_ERP could not read Gmail. Open mail.google.com in this browser, sign in, and check again.',
      'bad'
    );
  }
  const extra = res.unreadOtpMails
    ? res.parsed
      ? ' An unread ERP OTP email is there and KGP_ERP can read the OTP from it.'
      : ' An unread ERP email is there, but KGP_ERP could not read an OTP from it.'
    : '';
  note(
    el('gmailNote'),
    `Gmail is readable for ${res.accounts.join(', ')}.${extra}`,
    res.unreadOtpMails && !res.parsed ? 'warn' : 'ok'
  );
});

// ---------------------------------------------------------------- behaviour
async function renderBehaviour() {
  const s = await chrome.storage.local.get(['autoLogin', 'lastLogin']);
  el('auto').checked = s.autoLogin !== false;
  setValue(el('last'), formatLastLogin(s.lastLogin), s.lastLogin ? '' : 'muted');
}

el('auto').addEventListener('change', (e) =>
  chrome.storage.local.set({ autoLogin: e.target.checked })
);

el('reset').addEventListener('click', async () => {
  const button = el('reset');
  if (!button.dataset.armed) {
    button.dataset.armed = '1';
    button.textContent = 'Click again to erase everything';
    setTimeout(() => {
      delete button.dataset.armed;
      button.textContent = 'Erase everything';
    }, 4000);
    return;
  }
  await send({ type: 'gmailDisconnect' });
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ autoLogin: true });
  await loadAccount();
  note(el('accountNote'), 'Everything erased.');
});

// --------------------------------------------------------------------- init
function renderAll() {
  renderAnswers();
  renderGmail();
  renderBehaviour();
}

el('version').textContent = 'v' + chrome.runtime.getManifest().version;
chrome.storage.onChanged.addListener(renderAll);
setInterval(renderBehaviour, 30000);
loadAccount();
renderAll();
send({ type: 'gmailAccounts' }); // refreshes the signed-in Gmail row
