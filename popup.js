const el = (id) => document.getElementById(id);

function setValue(node, text, cls) {
  node.textContent = text;
  node.title = text; // full value on hover when it is truncated
  node.className = cls || '';
}

async function render() {
  const s = await chrome.storage.local.get([
    'rollNumber',
    'password',
    'gmailEmail',
    'feedAccounts',
    'lastLogin',
    'autoLogin'
  ]);
  const ready = Boolean(s.rollNumber && s.password);

  setValue(el('roll'), s.rollNumber || 'Not set', s.rollNumber ? '' : 'warn');
  const mail = s.gmailEmail || (s.feedAccounts || []).join(', ');
  setValue(el('gmail'), mail || 'Not signed in to Gmail', mail ? 'ok' : 'warn');
  setValue(el('last'), formatLastLogin(s.lastLogin), s.lastLogin ? '' : 'muted');
  el('auto').checked = s.autoLogin !== false;
  el('login').textContent = ready ? 'Log in to ERP' : 'Set up KGP_ERP';
  el('login').dataset.ready = ready ? '1' : '';
}

async function startLogin() {
  if (!el('login').dataset.ready) return chrome.runtime.openOptionsPage();

  const [tab] = await chrome.tabs.query({ url: 'https://erp.iitkgp.ac.in/*' });
  if (!tab) {
    await chrome.storage.local.set({ forceRun: Date.now() });
    await chrome.tabs.create({ url: ERP_URL });
    return window.close();
  }

  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'kgpassRun' });
  } catch (e) {
    // Tab was opened before KGP_ERP was installed: reload it so KGP_ERP loads.
    await chrome.storage.local.set({ forceRun: Date.now() });
    await chrome.tabs.reload(tab.id);
  }
  window.close();
}

el('version').textContent = 'v' + chrome.runtime.getManifest().version;
el('login').addEventListener('click', startLogin);
el('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
el('auto').addEventListener('change', (e) =>
  chrome.storage.local.set({ autoLogin: e.target.checked })
);
chrome.storage.onChanged.addListener(render);
setInterval(render, 30000); // keeps "5 min ago" honest while the popup is open
render();
send({ type: 'gmailAccounts' }); // refreshes the Gmail row via storage
