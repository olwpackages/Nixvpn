let appState = { profiles: [], logs: [], mode: 'Proxy', connection: 'Disconnected', connectionStartedAt: null, activeServerId: null };
let currentPage = 'home';
let uptimeTimer;

const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const cleanLocationName = (value) => String(value ?? '').replace(/^(?:[\u{1F1E6}-\u{1F1FF}]{2}\s*)+/u, '').trim();
const formatDate = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value)) : 'No expiry date';
const formatTime = (value) => value ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : '—';
const logLevel = (value) => String(value || 'info').trim().toLowerCase();
const flag = (country) => /^[a-z]{2}$/.test(country || '') && country !== 'un'
  ? `<span class="flag-frame"><img class="flag" loading="eager" decoding="async" data-country="${escapeHTML(country)}" src="https://flagcdn.com/${country}.svg" alt="${escapeHTML(country)} flag"></span>`
  : '<span class="flag flag-unknown" aria-label="Unknown location">🌐</span>';
const allServers = () => appState.profiles.flatMap((profile) => (profile.servers || []).map((server) => ({ ...server, profileName: profile.name })));
const pingClass = (value) => value == null ? '' : value < 100 ? 'good' : value < 220 ? 'medium' : 'bad';
const pingText = (value) => {
  if (value == null) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(2).replace(/\.00$/, '').replace(/0$/, '')} s`;
  const precise = value < 10 ? value.toFixed(2).replace(/\.?0+$/, '') : String(Math.round(value));
  return `${precise} ms`;
};
const durationText = (milliseconds) => {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
};

function updateUptime() {
  const value = $('#uptime-value');
  if (!value) return;
  const startedAt = Number(appState.connectionStartedAt);
  value.textContent = appState.connection === 'Connected' && Number.isFinite(startedAt)
    ? durationText(Date.now() - startedAt)
    : '00:00:00';
}

function syncUptimeTimer() {
  if (uptimeTimer) clearInterval(uptimeTimer);
  uptimeTimer = null;
  updateUptime();
  if (appState.connection === 'Connected' && appState.connectionStartedAt) uptimeTimer = setInterval(updateUptime, 1000);
}

function bindFlagFallbacks() {
  document.querySelectorAll('img.flag').forEach((image) => image.addEventListener('error', () => {
    const code = image.dataset.country || '';
    const fallback = document.createElement('span');
    fallback.className = 'flag flag-fallback';
    fallback.textContent = /^[a-z]{2}$/.test(code)
      ? [...code.toUpperCase()].map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0))).join('')
      : '•';
    fallback.setAttribute('aria-label', `${code || 'Unknown'} flag`);
    image.closest('.flag-frame')?.replaceWith(fallback);
  }, { once: true }));
}

function bindNavigationIconFallbacks() {
  document.querySelectorAll('img.tab-icon-image').forEach((image) => image.addEventListener('error', () => {
    const fallback = document.createElement('span');
    fallback.className = `tab-icon ${image.dataset.fallback || 'ri-shape-line'}`;
    fallback.setAttribute('aria-hidden', 'true');
    image.replaceWith(fallback);
  }, { once: true }));
}

function bindUptimeIconFallback() {
  document.querySelectorAll('img.uptime-icon-image').forEach((image) => image.addEventListener('error', () => {
    const fallback = document.createElement('span');
    fallback.className = `uptime-icon-fallback ${image.dataset.fallback || 'ri-timer-2-line'}`;
    fallback.setAttribute('aria-hidden', 'true');
    image.replaceWith(fallback);
  }, { once: true }));
}

function bindPingIconFallback() {
  document.querySelectorAll('img.check-ping-icon').forEach((image) => image.addEventListener('error', () => {
    const fallback = document.createElement('span');
    fallback.className = `check-ping-icon-fallback ${image.dataset.fallback || 'ri-wifi-line'}`;
    fallback.setAttribute('aria-hidden', 'true');
    image.replaceWith(fallback);
  }, { once: true }));
}

function bindServersIconFallback() {
  document.querySelectorAll('img.available-servers-icon').forEach((image) => image.addEventListener('error', () => {
    const fallback = document.createElement('div');
    fallback.className = `comment-icon ${image.dataset.fallback || 'ri-database-2-line'}`;
    fallback.setAttribute('aria-hidden', 'true');
    image.replaceWith(fallback);
  }, { once: true }));
}

function bindConnectionStickerFallback() {
  document.querySelectorAll('img.connection-sticker').forEach((image) => image.addEventListener('error', () => {
    const fallback = document.createElement('span');
    fallback.className = 'connection-sticker-fallback ri-shield-line';
    fallback.setAttribute('aria-hidden', 'true');
    image.replaceWith(fallback);
  }, { once: true }));
}

function serverCard(server) {
  const name = cleanLocationName(server.name);
  const pingTitle = server.pingSource === 'proxy'
    ? 'Latency measured through the VPN tunnel'
    : server.pingSource === 'tcp'
      ? 'Tunnel probe unavailable; showing direct TCP latency'
      : server.pingSource === 'timeout'
        ? 'The VPN server did not respond to the tunnel probe'
      : 'Latency unavailable';
  const pingLabel = server.pingSource === 'proxy'
    ? pingText(server.ping)
    : server.pingSource === 'tcp'
      ? `TCP ${pingText(server.ping)}`
      : server.pingSource === 'timeout'
        ? 'Timeout'
      : pingText(server.ping);
  return `<article class="server-card ${server.id === appState.activeServerId ? 'is-active' : ''}" data-server-id="${escapeHTML(server.id)}">
    <div class="server-card-top"><div class="server-name">${flag(server.country)}<div><strong title="${escapeHTML(name)}">${escapeHTML(name)}</strong><small>${escapeHTML(server.host)}:${escapeHTML(server.port)}</small></div></div><div class="ping ${pingClass(server.ping)}" title="${pingTitle}">${pingLabel}</div></div>
  </article>`;
}

function renderHome() {
  const servers = allServers();
  const active = servers.find((server) => server.id === appState.activeServerId) || servers[0];
  const profileGroups = appState.profiles.map((profile) => {
    const profileServers = profile.servers || [];
    return `<section class="home-profile-group"><div class="home-profile-heading"><div class="profile-title"><div class="profile-icon ri-links-line" aria-hidden="true"></div><div><span class="eyebrow">Profile</span><h3 title="${escapeHTML(profile.name)}">${escapeHTML(profile.name)}</h3></div></div><span class="muted-label">${profileServers.length} locations</span></div>${profileServers.length ? `<div class="server-cards-grid">${profileServers.map((server) => serverCard(server)).join('')}</div>` : emptyState('ri-server-line', 'No locations', 'This profile has no available servers.')}</section>`;
  }).join('');
  return `<div class="stat-grid">
    <div class="stat-card"><span class="muted-label">Subscriptions</span><span class="stat-value">${appState.profiles.length}</span></div>
    <div class="stat-card"><span class="muted-label">Available servers</span><span class="stat-value">${servers.length}</span></div>
  </div>
  <div class="page-grid">
    <section class="connection-panel panel"><img class="connection-sticker" src="../assets/vpn-sticker.svg" alt="" aria-hidden="true"><div class="connection-top"><div class="connection-server-title">${active ? `${flag(active.country)}<strong>${escapeHTML(cleanLocationName(active.name))}</strong>` : '<strong>No server selected</strong>'}</div><select id="mode-select" class="mode-select" aria-label="Connection mode"><option ${appState.mode === 'Proxy' ? 'selected' : ''}>Proxy</option><option ${appState.mode === 'TUN' ? 'selected' : ''}>TUN</option><option ${appState.mode === 'Proxy + TUN' ? 'selected' : ''}>Proxy + TUN</option></select></div><div class="connection-server"><span>${active ? `${escapeHTML(active.country.toUpperCase())} · ${escapeHTML(active.protocol)}` : 'Add a profile to get started'}</span>${appState.mode === 'Proxy' || appState.mode === 'Proxy + TUN' ? `<small>Local proxy port: ${escapeHTML(appState.runtimeProxyPort || appState.settings?.proxyPort || 2080)}</small>` : ''}</div><div class="connection-actions"><button id="connection-button" class="button ${appState.connection === 'Connected' ? 'secondary' : 'primary'}">${appState.connection === 'Connected' ? '<span class="ri-stop-circle-line" aria-hidden="true"></span> Disconnect' : '<span class="ri-play-circle-line" aria-hidden="true"></span> Connect'}</button><div class="uptime-box"><div class="uptime-clock" title="Connection uptime"><img class="uptime-icon-image" data-fallback="ri-timer-2-line" src="https://cdn-icons-png.flaticon.com/512/2421/2421935.png" alt=""></div><div><small>Uptime</small><strong id="uptime-value">00:00:00</strong></div></div></div></section>
    <section class="server-list home-server-list"><div class="panel-comment"><img class="available-servers-icon" data-fallback="ri-database-2-line" src="https://cdn-icons-png.flaticon.com/512/8028/8028666.png" alt=""><div><h2>Locations by profile</h2><p>Choose a location from the subscription you want to use.</p></div><div class="panel-comment-actions"><span class="muted-label">${servers.length} total</span><button id="check-pings" class="button secondary"><img class="check-ping-icon" data-fallback="ri-wifi-line" src="https://cdn-icons-png.flaticon.com/512/1176/1176875.png" alt=""> Check ping</button></div></div>${profileGroups || emptyState('ri-server-line', 'No servers yet', 'Add a subscription in Profiles to see available servers.')}</section>
  </div>`;
}

function emptyState(icon, title, copy) { return `<div class="empty-state"><div><div class="empty-icon ${icon.includes('-') ? icon : ''}">${icon.includes('-') ? '' : icon}</div><strong>${title}</strong><span>${copy}</span></div></div>`; }
function daysLeft(expiresAt) { if (!expiresAt) return 'No expiry'; return `${Math.max(0, Math.ceil((expiresAt - Date.now()) / 86400000))} days left`; }

function renderProfiles() {
  return `<div class="panel-heading" style="padding: 4px 0 18px"><div><span class="eyebrow">Your subscriptions</span><h2>Profiles</h2><p>Import and keep your server lists up to date.</p></div><button id="open-add-profile" class="button primary"><span class="ri-add-line" aria-hidden="true"></span> Add profile</button></div><div class="profiles-list">${appState.profiles.length ? appState.profiles.map((profile) => `<article class="profile-card"><div class="profile-top"><div class="profile-title"><div class="profile-icon ri-links-line" aria-hidden="true"></div><div><h3>${escapeHTML(profile.name)}</h3><div class="profile-meta"><span>${(profile.servers || []).length} servers</span><span>${daysLeft(profile.expiresAt)}</span><span>Updated ${formatDate(profile.updatedAt)}</span></div></div></div><div class="profile-actions"><button class="icon-button rename-profile" data-profile-id="${escapeHTML(profile.id)}" title="Rename profile" aria-label="Rename profile"><span class="ri-edit-line" aria-hidden="true"></span></button><button class="icon-button update-profile" data-profile-id="${escapeHTML(profile.id)}" title="Update profile" aria-label="Update profile"><span class="ri-refresh-line" aria-hidden="true"></span></button><button class="icon-button remove-profile" data-profile-id="${escapeHTML(profile.id)}" title="Remove profile" aria-label="Remove profile"><span class="ri-delete-bin-6-line" aria-hidden="true"></span></button></div></div><button type="button" class="profile-source" data-source="${escapeHTML(profile.sourceURL)}" title="Hover to reveal. Click to copy.">${escapeHTML(profile.sourceURL)}</button><div class="profile-servers"><div class="server-cards-grid">${(profile.servers || []).map((server) => serverCard(server)).join('')}</div></div></article>`).join('') : `<div class="panel">${emptyState('ri-links-line', 'No profiles yet', 'Add your first subscription link to load its servers.')}</div>`}</div>`;
}

function renderLogs() {
  const rows = appState.logs.slice().reverse().map((entry) => { const level = logLevel(entry.level); return `<div class="log-row"><span class="log-time">${formatTime(entry.timestamp)}</span><span class="log-level ${escapeHTML(level)}">${escapeHTML(level)}</span><div><span>${escapeHTML(entry.message)}</span>${entry.detail ? `<span class="log-detail">${escapeHTML(entry.detail)}</span>` : ''}</div></div>`; }).join('');
  return `<div class="panel-heading" style="padding: 4px 0 18px"><div><span class="eyebrow">Activity</span><h2>Logs</h2><p>Important events and errors from the current device.</p></div><button id="clear-logs" class="button secondary"><span class="ri-delete-bin-line" aria-hidden="true"></span> Clear logs</button></div><section class="panel logs-list">${rows || `<div class="empty-state empty-state-horizontal"><div class="empty-icon ri-file-list-3-line" aria-hidden="true"></div><div><strong>No events yet</strong><span>Application events will appear here.</span></div></div>`}</section>`;
}

function renderSettings() {
  const settings = appState.settings || { proxyPort: 2080, autoStart: false, autoUpdate: false, updateOnLaunch: false, updateIntervalHours: 24, autoRecover: false, pingOnLaunch: false, autoPing: false, pingIntervalHours: 1 };
  return `<div class="panel-heading settings-heading" style="padding: 4px 0 18px"><div><span class="eyebrow">Application preferences</span><h2>Settings</h2><p>Configure how NixVPN starts and refreshes subscriptions.</p></div></div>
  <section class="panel settings-panel">
    <div class="setting-row"><div><strong>Proxy port</strong><p>Preferred local port for Proxy mode.</p></div><div class="setting-control"><input id="proxy-port" class="number-input" type="number" min="1024" max="65535" value="${escapeHTML(settings.proxyPort)}"><span class="field-hint">If busy, the next free port is selected automatically.</span></div></div>
    <label class="setting-row toggle-row"><div><strong>Start with system</strong><p>Launch NixVPN when you sign in to Linux.</p></div><span class="switch"><input id="auto-start" type="checkbox" ${settings.autoStart ? 'checked' : ''}><span class="switch-track"></span></span></label>
    <label class="setting-row toggle-row"><div><strong>Auto-update subscriptions</strong><p>Refresh saved subscriptions in the background.</p></div><span class="switch"><input id="auto-update" type="checkbox" ${settings.autoUpdate ? 'checked' : ''}><span class="switch-track"></span></span></label>
    <label class="setting-row toggle-row"><div><strong>Update on launch</strong><p>Fully reload all subscription data when NixVPN starts.</p></div><span class="switch"><input id="update-on-launch" type="checkbox" ${settings.updateOnLaunch ? 'checked' : ''}><span class="switch-track"></span></span></label>
    <label class="setting-row toggle-row"><div><strong>Check ping on launch</strong><p>Measure server latency once when NixVPN starts.</p></div><span class="switch"><input id="ping-on-launch" type="checkbox" ${settings.pingOnLaunch ? 'checked' : ''}><span class="switch-track"></span></span></label>
    <label class="setting-row toggle-row"><div><strong>Auto-check ping</strong><p>Measure server latency automatically at the selected interval.</p></div><span class="switch"><input id="auto-ping" type="checkbox" ${settings.autoPing ? 'checked' : ''}><span class="switch-track"></span></span></label>
    <label class="setting-row toggle-row"><div><strong>Recover connection after failure</strong><p>Update the active subscription, choose the best server, and reconnect automatically.</p></div><span class="switch"><input id="auto-recover" type="checkbox" ${settings.autoRecover ? 'checked' : ''}><span class="switch-track"></span></span></label>
    <div class="setting-row"><div><strong>Update interval</strong><p>How often enabled subscriptions are refreshed.</p></div><select id="update-interval" class="settings-select"><option value="1" ${settings.updateIntervalHours === 1 ? 'selected' : ''}>Every hour</option><option value="6" ${settings.updateIntervalHours === 6 ? 'selected' : ''}>Every 6 hours</option><option value="12" ${settings.updateIntervalHours === 12 ? 'selected' : ''}>Every 12 hours</option><option value="24" ${settings.updateIntervalHours === 24 ? 'selected' : ''}>Every day</option><option value="168" ${settings.updateIntervalHours === 168 ? 'selected' : ''}>Every week</option></select></div>
    <div class="setting-row"><div><strong>Ping check interval</strong><p>How often automatic ping checks are performed.</p></div><select id="ping-interval" class="settings-select"><option value="1" ${settings.pingIntervalHours === 1 ? 'selected' : ''}>Every hour</option><option value="6" ${settings.pingIntervalHours === 6 ? 'selected' : ''}>Every 6 hours</option><option value="12" ${settings.pingIntervalHours === 12 ? 'selected' : ''}>Every 12 hours</option><option value="24" ${settings.pingIntervalHours === 24 ? 'selected' : ''}>Every day</option><option value="168" ${settings.pingIntervalHours === 168 ? 'selected' : ''}>Every week</option></select></div>
    <div class="settings-actions"><button id="save-settings" class="button primary"><span class="ri-save-3-line" aria-hidden="true"></span> Save settings</button></div>
  </section>`;
}

function renderView() {
  const pages = { home: ['Overview', 'Home', renderHome], profiles: ['Subscriptions', 'Profiles', renderProfiles], logs: ['Activity', 'Logs', renderLogs], settings: ['Preferences', 'Settings', renderSettings] };
  const [eyebrow, title, view] = pages[currentPage];
  $('#page-eyebrow').textContent = eyebrow; $('#page-title').textContent = title; $('#app-content').innerHTML = view();
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.page === currentPage));
  bindPageEvents();
  bindUptimeIconFallback();
  bindPingIconFallback();
  bindServersIconFallback();
  bindConnectionStickerFallback();
  syncUptimeTimer();
  updateTabIndicator();
}

let pageTransitionTimer;
function render(animate = false) {
  const content = $('#app-content');
  if (!animate || !content?.innerHTML) {
    if (pageTransitionTimer) clearTimeout(pageTransitionTimer);
    content?.classList.remove('page-leave', 'page-enter');
    renderView();
    return;
  }
  if (pageTransitionTimer) clearTimeout(pageTransitionTimer);
  content.classList.remove('page-enter');
  content.classList.add('page-leave');
  pageTransitionTimer = setTimeout(() => {
    pageTransitionTimer = null;
    renderView();
    content.classList.remove('page-leave');
    content.classList.add('page-enter');
    requestAnimationFrame(() => content.classList.remove('page-enter'));
  }, 70);
}

function updateTabIndicator() {
  const tabs = $('.tabs');
  const active = tabs?.querySelector('.tab.is-active');
  if (!tabs || !active) return;
  tabs.style.setProperty('--active-tab-y', `${active.offsetTop}px`);
  tabs.style.setProperty('--active-tab-height', `${active.offsetHeight}px`);
}

let renderFrame;
function scheduleRender() {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = null;
    render();
  });
}

function showError(message) { const error = $('#modal-error'); error.textContent = message; error.hidden = false; }
function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.disabled = true;
    button.dataset.originalHTML = button.innerHTML;
    button.innerHTML = '<span class="ri-loader-4-line ri-spin" aria-hidden="true"></span>';
  } else {
    button.disabled = false;
    button.innerHTML = button.dataset.originalHTML || label;
    delete button.dataset.originalHTML;
  }
}

function bindPageEvents() {
  bindFlagFallbacks();
  $('#open-add-profile')?.addEventListener('click', () => { $('#modal-error').hidden = true; $('#profile-url').value = ''; $('#add-profile-dialog').showModal(); $('#profile-url').focus(); });
  $('#close-add-profile')?.addEventListener('click', () => $('#add-profile-dialog').close());
  $('#cancel-add-profile')?.addEventListener('click', () => $('#add-profile-dialog').close());
  document.querySelectorAll('.profile-source').forEach((source) => source.addEventListener('click', async () => {
    await window.nixvpn.copyText(source.dataset.source);
    const original = source.textContent;
    source.textContent = 'Copied to clipboard';
    source.classList.add('is-copied');
    setTimeout(() => { source.textContent = original; source.classList.remove('is-copied'); }, 1200);
  }));
  document.querySelectorAll('.update-profile').forEach((button) => button.addEventListener('click', async () => { setBusy(button, true, ''); try { appState = await window.nixvpn.updateProfile(button.dataset.profileId); render(); } catch (error) { alert(error.message); setBusy(button, false, ''); } }));
  document.querySelectorAll('.rename-profile').forEach((button) => button.addEventListener('click', async () => {
    const profile = appState.profiles.find((item) => item.id === button.dataset.profileId);
    if (!profile) return;
    const dialog = $('#rename-profile-dialog');
    $('#rename-profile-error').hidden = true;
    $('#rename-profile-input').value = profile.name;
    dialog.dataset.profileId = profile.id;
    dialog.showModal();
    $('#rename-profile-input').focus();
    $('#rename-profile-input').select();
  }));
  document.querySelectorAll('.remove-profile').forEach((button) => button.addEventListener('click', async () => { if (confirm('Are you sure you want to delete this subscription?')) { appState = await window.nixvpn.removeProfile(button.dataset.profileId); render(); } }));
  $('#clear-logs')?.addEventListener('click', async () => { appState = await window.nixvpn.clearLogs(); render(); });
  $('#save-settings')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    setBusy(button, true, 'Save settings');
    try {
      appState = await window.nixvpn.updateSettings({
        proxyPort: Number($('#proxy-port').value),
        autoStart: $('#auto-start').checked,
        autoUpdate: $('#auto-update').checked,
        updateOnLaunch: $('#update-on-launch').checked,
        pingOnLaunch: $('#ping-on-launch').checked,
        autoPing: $('#auto-ping').checked,
        updateIntervalHours: Number($('#update-interval').value),
        pingIntervalHours: Number($('#ping-interval').value),
        autoRecover: $('#auto-recover').checked
      });
      render();
    } catch (error) { alert(error.message); setBusy(button, false, 'Save settings'); }
  });
  $('#check-pings')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    setBusy(button, true, 'Check ping');
    try { appState = await window.nixvpn.checkPings(); render(); }
    catch (error) { alert(error.message); render(); }
  });
  document.querySelectorAll('.server-card').forEach((card) => card.addEventListener('click', async (event) => {
    appState = await window.nixvpn.selectServer(card.dataset.serverId);
    render();
  }));
  $('#mode-select')?.addEventListener('change', async (event) => { try { appState = await window.nixvpn.setMode(event.target.value); render(); } catch (error) { alert(error.message); } });
  $('#connection-button')?.addEventListener('click', async (event) => { const button = event.currentTarget; setBusy(button, true, 'Connect'); try { appState = await window.nixvpn.toggleConnection(); render(); } catch (error) { alert(error.message); render(); } });
}

$('#add-profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#add-profile-button'); setBusy(button, true, 'Add profile'); $('#modal-error').hidden = true;
  try { appState = await window.nixvpn.addProfile($('#profile-url').value); $('#add-profile-dialog').close(); currentPage = 'profiles'; render(); }
  catch (error) { showError(error.message); }
  finally { setBusy(button, false, 'Add profile'); }
});
$('#rename-profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const dialog = $('#rename-profile-dialog');
  const input = $('#rename-profile-input');
  const errorBox = $('#rename-profile-error');
  const button = $('#save-rename-profile');
  setBusy(button, true, 'Save name');
  errorBox.hidden = true;
  try {
    appState = await window.nixvpn.renameProfile(dialog.dataset.profileId, input.value);
    dialog.close();
    render();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    setBusy(button, false, 'Save name');
  }
});
$('#close-rename-profile').addEventListener('click', () => $('#rename-profile-dialog').close());
$('#cancel-rename-profile').addEventListener('click', () => $('#rename-profile-dialog').close());
$('#minimize-button').addEventListener('click', () => window.nixvpn.minimize());
$('#close-button').addEventListener('click', () => window.nixvpn.close());
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => { if (currentPage === tab.dataset.page) return; currentPage = tab.dataset.page; render(true); }));
bindNavigationIconFallbacks();
window.nixvpn.onStateChanged((nextState) => { appState = nextState; scheduleRender(); });
window.nixvpn.onLogsChanged((logs) => { appState.logs = logs; if (currentPage === 'logs') scheduleRender(); });
window.nixvpn.getState().then((nextState) => { appState = nextState; render(); });
window.addEventListener('resize', updateTabIndicator);
