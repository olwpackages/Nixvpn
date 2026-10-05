const { app, BrowserWindow, ipcMain, net, session, clipboard, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const tcp = require('node:net');
const http = require('node:http');
const tls = require('node:tls');
const dns = require('node:dns').promises;
const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

const isLinux = process.platform === 'linux';
let mainWindow;
let state;
let coreProcess;
let coreConfigPath;
let coreUsesPrivilege = false;
let logBroadcastTimer;
let subscriptionTimer;
let subscriptionStartupTimer;
let pingTimer;
let pingStartupTimer;
let pingCheckPromise;
let systemProxyBackup;
let quitting = false;
let shutdownPromise;
let recoveryInProgress = false;
let connectionOperation = Promise.resolve();
const pingPortReservations = new Set();
const pingCoreProcesses = new Set();
const geoCountryCache = new Map();
const compatibleSubscriptionUserAgent = 'Koala Clash/1.3.1';

function serializeConnectionOperation(operation) {
  const current = connectionOperation.then(operation, operation);
  connectionOperation = current.catch(() => {});
  return current;
}

if (isLinux) {
  app.commandLine.appendSwitch('disable-gpu');
  const chromeSandbox = path.join(path.dirname(process.execPath), 'chrome-sandbox');
  try {
    if ((fs.statSync(chromeSandbox).mode & 0o4000) === 0) {
      app.commandLine.appendSwitch('no-sandbox');
      app.commandLine.appendSwitch('disable-setuid-sandbox');
    }
  } catch {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-setuid-sandbox');
  }
}

const defaultSettings = () => ({
  settingsVersion: 1,
  proxyPort: 2080,
  autoStart: false,
  autoUpdate: false,
  updateOnLaunch: false,
  updateIntervalHours: 24,
  autoRecover: false,
  pingOnLaunch: false,
  autoPing: false,
  pingIntervalHours: 1
});

const defaultState = () => ({
  profiles: [],
  logs: [],
  clientHwid: randomUUID(),
  mode: 'Proxy',
  connection: 'Disconnected',
  connectionStartedAt: null,
  activeServerId: null,
  runtimeProxyPort: 2080,
  settings: defaultSettings()
});

function statePath() {
  return path.join(app.getPath('userData'), 'state.json');
}

function proxyBackupPath() {
  return path.join(app.getPath('userData'), 'system-proxy-backup.json');
}

function sourceKey(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  try {
    const url = new URL(source);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}${url.search}`.toLowerCase();
  } catch {
    return source.toLowerCase().replace(/\/$/, '');
  }
}

function unwrapSubscriptionURL(value) {
  const raw = String(value || '').trim();
  try {
    const url = new URL(raw);
    const installConfig = url.hostname.toLowerCase() === 'install-config' || url.pathname.toLowerCase() === '/install-config';
    if (['koala-clash:', 'clash:'].includes(url.protocol.toLowerCase()) && installConfig) {
      const nested = url.searchParams.get('url');
      if (nested) return nested.trim();
    }
  } catch {}
  return raw;
}

function cleanLocationName(value) {
  return String(value || '').replace(/^(?:[\u{1F1E6}-\u{1F1FF}]{2}\s*)+/u, '').trim();
}

function readableTitle(value) {
  let title = String(value || '').trim();
  if (!title) return '';
  try { title = decodeURIComponent(title); } catch {}
  const encoded = title.match(/^base64:\s*(.+)$/i);
  if (encoded) {
    const decoded = decodeBase64(encoded[1]).trim();
    if (decoded && /^[\p{L}\p{N}\s._+()\-]+$/u.test(decoded)) title = decoded;
  }
  return title.replace(/^['"]|['"]$/g, '').trim();
}

function normalizePing(value) {
  if (value == null || value === '') return null;
  const ping = Number(value);
  return Number.isFinite(ping) && ping >= 0 ? ping : null;
}

function normalizeServer(server, profileSource = '') {
  const outbound = server.outbound || null;
  const host = server.host || server.server || server.ip || '';
  const protocolName = server.protocol || outbound?.type || 'Proxy';
  const explicitCountry = String(server.countryCode || server.country || '').trim().toLowerCase();
  const country = explicitCountry.length === 2 && explicitCountry !== 'un'
    ? explicitCountry
    : countryFromName(server.name || '', host);
  return {
    id: server.id || randomUUID(),
    name: cleanLocationName(server.name || host || 'Unnamed server'),
    host,
    port: Number(server.port || server.server_port) || 443,
    protocol: protocolName,
    country,
    ping: normalizePing(server.ping),
    pingSource: server.pingSource || null,
    source: server.source || profileSource,
    ...(outbound ? { outbound } : {})
  };
}

function isPrivateAddress(address) {
  if (tcp.isIP(address) === 4) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 169 && parts[1] === 254
      || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
  }
  if (tcp.isIP(address) === 6) return address === '::1' || /^f[cd]/i.test(address) || /^fe8/i.test(address);
  return true;
}

async function resolvePublicAddress(host) {
  if (tcp.isIP(host)) return isPrivateAddress(host) ? '' : host;
  try {
    const result = await dns.lookup(host, { family: 4 });
    return result?.address && !isPrivateAddress(result.address) ? result.address : '';
  } catch {
    return '';
  }
}

async function countryFromIP(host) {
  const address = await resolvePublicAddress(host);
  if (!address) return '';
  if (geoCountryCache.has(address)) return geoCountryCache.get(address);
  const sources = [
    `https://ipapi.co/${encodeURIComponent(address)}/json/`,
    `https://ipwho.is/${encodeURIComponent(address)}`
  ];
  for (const source of sources) {
    let timer;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), 3500);
      const response = await net.fetch(source, {
        signal: controller.signal,
        headers: { 'User-Agent': 'NixVPN/0.1', Accept: 'application/json' }
      });
      if (!response.ok) continue;
      const data = await response.json();
      const country = String(data.country_code || '').trim().toLowerCase();
      const result = /^[a-z]{2}$/.test(country) && country !== 'xx' ? country : '';
      if (result) {
        geoCountryCache.set(address, result);
        return result;
      }
    } catch {}
    finally {
      if (timer) clearTimeout(timer);
    }
  }
  return '';
}

async function enrichProfileCountries(profile) {
  const servers = [];
  for (const server of profile.servers) {
    const address = await resolvePublicAddress(server.host);
    const country = address ? await countryFromIP(address) : '';
    const stored = /^[a-z]{2}$/.test(server.country || '') && server.country !== 'un' ? server.country : '';
    const fallback = stored || countryFromName(server.name || '', server.host || '');
    servers.push({ ...server, country: country || fallback || 'un' });
    if (servers.length < profile.servers.length) await new Promise((resolve) => setTimeout(resolve, 220));
  }
  return { ...profile, servers };
}

function normalizeState(raw) {
  const next = { ...defaultState(), ...raw };
  next.clientHwid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(next.clientHwid || ''))
    ? next.clientHwid
    : randomUUID();
  const connectionStartedAt = Number(next.connectionStartedAt);
  next.connectionStartedAt = Number.isFinite(connectionStartedAt) && connectionStartedAt > 0 ? connectionStartedAt : null;
  const storedSettings = raw?.settings || {};
  const hasCurrentSettings = storedSettings.settingsVersion === 1;
  const currentSettings = hasCurrentSettings ? {
    proxyPort: storedSettings.proxyPort,
    autoStart: storedSettings.autoStart,
    autoUpdate: storedSettings.autoUpdate,
    updateOnLaunch: storedSettings.updateOnLaunch,
    updateIntervalHours: storedSettings.updateIntervalHours,
    autoRecover: storedSettings.autoRecover,
    pingOnLaunch: storedSettings.pingOnLaunch,
    autoPing: storedSettings.autoPing,
    pingIntervalHours: storedSettings.pingIntervalHours
  } : {};
  next.settings = { ...defaultSettings(), ...currentSettings };
  next.settings.proxyPort = Number(next.settings.proxyPort) || 2080;
  next.settings.autoStart = Boolean(next.settings.autoStart);
  next.settings.autoUpdate = Boolean(next.settings.autoUpdate);
  next.settings.updateOnLaunch = Boolean(next.settings.updateOnLaunch);
  next.settings.updateIntervalHours = Number(next.settings.updateIntervalHours) || 24;
  next.settings.autoRecover = Boolean(next.settings.autoRecover);
  next.settings.pingOnLaunch = Boolean(next.settings.pingOnLaunch);
  next.settings.autoPing = Boolean(next.settings.autoPing);
  next.settings.pingIntervalHours = [1, 6, 12, 24, 168].includes(Number(next.settings.pingIntervalHours))
    ? Number(next.settings.pingIntervalHours)
    : 1;
  const profiles = Array.isArray(raw?.profiles) ? raw.profiles.map((profile) => {
    const legacyServers = Array.isArray(profile.servers) ? profile.servers : Array.isArray(profile.locations) ? profile.locations : (profile.server || profile.host || profile.ip ? [profile] : []);
    const sourceURL = profile.sourceURL || profile.source || legacyServers[0]?.source || '';
    return {
      id: profile.id || randomUUID(),
      name: readableTitle(profile.name) || titleFromURL(sourceURL),
      customName: Boolean(profile.customName),
      sourceURL,
      expiresAt: profile.expiresAt || null,
      updatedAt: profile.updatedAt || profile.addedAt || Date.now(),
      servers: legacyServers.map((server) => normalizeServer(server, sourceURL))
        .filter((server) => server.host)
    };
  }).filter((profile) => profile.servers.length) : [];
  const uniqueProfiles = new Map();
  for (const profile of profiles) {
    const key = sourceKey(profile.sourceURL) || `profile:${profile.id}`;
    const previous = uniqueProfiles.get(key);
    if (!previous || profile.updatedAt >= previous.updatedAt) uniqueProfiles.set(key, profile);
  }
  next.profiles = [...uniqueProfiles.values()];
  next.logs = Array.isArray(raw?.logs) ? raw.logs.filter((entry) => entry.message !== 'NixVPN is ready') : [];
  return next;
}

function readState() {
  const target = statePath();
  let file;
  try {
    file = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return defaultState();
    throw error;
  }
  try {
    const parsed = JSON.parse(file);
    if (parsed.profilesEncrypted) {
      if (!safeStorage.isEncryptionAvailable()) {
        const error = new Error('Encrypted profile storage is unavailable on this system');
        error.code = 'NIXVPN_STORAGE_UNAVAILABLE';
        throw error;
      }
      try {
        const encrypted = Buffer.from(String(parsed.profilesEncrypted), 'base64');
        parsed.profiles = JSON.parse(safeStorage.decryptString(encrypted));
        delete parsed.profilesEncrypted;
      } catch (error) {
        const wrapped = new Error(`Could not decrypt saved profiles: ${error.message}`);
        wrapped.code = 'NIXVPN_STORAGE_UNAVAILABLE';
        throw wrapped;
      }
    }
    return normalizeState(parsed);
  } catch (error) {
    if (error.code === 'NIXVPN_STORAGE_UNAVAILABLE') throw error;
    const backup = `${target}.corrupt-${Date.now()}-${process.pid}`;
    try {
      fs.renameSync(target, backup);
    } catch (backupError) {
      throw new Error(`Could not preserve invalid state file: ${backupError.message}`);
    }
    console.error(`[state] Invalid state moved to ${backup}: ${error.message}`);
    return defaultState();
  }
}

function writeState() {
  const target = statePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    const diskState = { ...state };
    if (safeStorage.isEncryptionAvailable()) {
      diskState.profilesEncrypted = safeStorage.encryptString(JSON.stringify(state.profiles)).toString('base64');
      delete diskState.profiles;
    } else {
      console.warn('[state] OS secure storage is unavailable; profiles remain protected only by file permissions');
    }
    fs.writeFileSync(temporary, JSON.stringify(diskState, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function log(level, message, detail = '') {
  const entry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    level,
    message,
    detail
  };
  state.logs = [...state.logs, entry].slice(-500);
  writeState();
  if (!logBroadcastTimer) {
    logBroadcastTimer = setTimeout(() => {
      logBroadcastTimer = null;
      mainWindow?.webContents.send('logs:changed', state.logs);
    }, 80);
  }
}

function publicState() {
  const { clientHwid, ...safeState } = state;
  return {
    ...safeState,
    system: systemDiagnostics(),
    profiles: state.profiles.map((profile) => ({
      ...profile,
      servers: profile.servers.map(({ source, outbound, ...server }) => server)
    }))
  };
}

function sendStateChanged() {
  mainWindow?.webContents.send('state:changed', publicState());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 960,
    minHeight: 650,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    title: 'NixVPN',
    icon: path.join(__dirname, '..', 'assets', 'nixvpn.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.webContents.on('console-message', (_event, details) => {
    console.error(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer-gone] ${details.reason}`);
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[renderer-load-failed] ${code} ${description} ${url}`);
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

function decodeBase64(value) {
  const clean = value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  try {
    return Buffer.from(clean, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function safeDecodeURIComponent(value) {
  try { return decodeURIComponent(String(value || '')); } catch { return String(value || ''); }
}

function isProbablyBase64(value) {
  return value.length > 20 && /^[A-Za-z0-9+/=_-]+$/.test(value.replace(/\s/g, ''));
}

const countryCodes = {
  russia: 'ru', ru: 'ru', moscow: 'ru', germany: 'de', de: 'de', frankfurt: 'de',
  netherlands: 'nl', nl: 'nl', amsterdam: 'nl', finland: 'fi', fi: 'fi', helsinki: 'fi',
  sweden: 'se', se: 'se', stockholm: 'se', france: 'fr', fr: 'fr', paris: 'fr',
  uk: 'gb', gb: 'gb', britain: 'gb', london: 'gb', england: 'gb', usa: 'us', us: 'us',
  america: 'us', newyork: 'us', canada: 'ca', ca: 'ca', toronto: 'ca', japan: 'jp',
  jp: 'jp', tokyo: 'jp', singapore: 'sg', sg: 'sg', turkey: 'tr', tr: 'tr', istanbul: 'tr',
  poland: 'pl', pl: 'pl', warsaw: 'pl', switzerland: 'ch', ch: 'ch', austria: 'at', at: 'at',
  hongkong: 'hk', hk: 'hk', korea: 'kr', kr: 'kr', australia: 'au', au: 'au',
  india: 'in', in: 'in', italy: 'it', it: 'it', spain: 'es', es: 'es', ukraine: 'ua', ua: 'ua',
  нидерланды: 'nl', германия: 'de', великобритания: 'gb', россия: 'ru', финляндия: 'fi',
  чехия: 'cz', норвегия: 'no', польша: 'pl', франция: 'fr', швейцария: 'ch', австрия: 'at',
  турция: 'tr', япония: 'jp', сингапур: 'sg', канада: 'ca', сша: 'us', испания: 'es', италия: 'it',
  москва: 'ru', питер: 'ru', 'санкт петербург': 'ru', 'обход бс': 'ru',
  нидерланд: 'nl', голландия: 'nl',
  великобритания: 'gb', англия: 'gb', швеция: 'se', финляндия: 'fi',
  корея: 'kr', южнаякорея: 'kr', гонконг: 'hk', австралия: 'au', индия: 'in', украина: 'ua',
  бразилия: 'br', мексика: 'mx', португалия: 'pt', бельгия: 'be', датания: 'dk', дания: 'dk',
  ирландия: 'ie', израиль: 'il', оаэ: 'ae', эмираты: 'ae', румыния: 'ro', болгария: 'bg',
  сербия: 'rs', греция: 'gr', вьетнам: 'vn', тайланд: 'th', тайвань: 'tw',
  китай: 'cn', монголия: 'mn', казахстан: 'kz', киргизия: 'kg', узбекистан: 'uz'
};

const normalizedCountryEntries = Object.entries(countryCodes)
  .sort(([left], [right]) => right.length - left.length)
  .map(([key, code]) => [key.toLowerCase().replace(/[^a-zа-я0-9]+/g, ' ').trim(), code]);

function countryFromName(name, host = '') {
  const haystack = `${name} ${host}`.toLowerCase().replace(/[^a-zа-я0-9]+/g, ' ').trim();
  const paddedHaystack = ` ${haystack} `;
  for (const [normalizedKey, code] of normalizedCountryEntries) {
    if (normalizedKey && paddedHaystack.includes(` ${normalizedKey} `)) return code;
  }
  const tld = host.toLowerCase().split('.').pop();
  return /^[a-z]{2}$/.test(tld) && Object.values(countryCodes).includes(tld) ? tld : 'un';
}

function hostFromURL(value) {
  try { return new URL(value).hostname; } catch { return ''; }
}

function titleFromURL(value) {
  const host = hostFromURL(value).replace(/^www\./, '');
  return host ? host.split('.')[0].replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'New subscription';
}

function parseVmess(value) {
  const decoded = decodeBase64(value.replace(/^vmess:\/\//i, ''));
  try {
    const data = JSON.parse(decoded);
    const host = data.add || data.host || '';
    return { id: randomUUID(), name: data.ps || host || 'VMess server', host, port: Number(data.port) || 443, protocol: 'VMess', country: countryFromName(data.ps || '', host), ping: null, source: value };
  } catch { return null; }
}

function parseNode(value) {
  const raw = value.trim();
  if (/^vmess:\/\//i.test(raw)) return parseVmess(raw);
  let url;
  try { url = new URL(raw); } catch { return null; }
  const scheme = url.protocol.replace(':', '').toLowerCase();
  const supported = {
    vless: 'VLESS', vmess: 'VMess', trojan: 'Trojan', ss: 'Shadowsocks',
    hysteria2: 'Hysteria 2', hy2: 'Hysteria 2', tuic: 'TUIC', socks: 'SOCKS',
    socks5: 'SOCKS', http: 'HTTP'
  };
  if (!supported[scheme] || !url.hostname) return null;
  const name = safeDecodeURIComponent(url.hash.slice(1)) || url.hostname;
  return {
    id: randomUUID(), name, host: url.hostname, port: Number(url.port) || 443,
    protocol: supported[scheme], country: countryFromName(name, url.hostname),
    ping: null, source: raw
  };
}

function outboundFromObject(item) {
  const scheme = String(item?.type || '').toLowerCase();
  const server = item?.server || item?.host || '';
  const serverPort = Number(item?.server_port || item?.port) || 443;
  if (!server) return null;
  const tlsEnabled = item.tls && !['false', 'none', '0'].includes(String(item.tls).toLowerCase());
  const insecureTLS = ['true', '1', 'yes'].includes(String(item['skip-cert-verify'] || '').toLowerCase());
  const alpn = item.alpn ? (Array.isArray(item.alpn) ? item.alpn : String(item.alpn).split(',').map((value) => value.trim()).filter(Boolean)) : undefined;
  const fingerprint = item['client-fingerprint'] || item.fingerprint;
  const tls = item.tls && typeof item.tls === 'object'
    ? { ...item.tls }
    : tlsEnabled
      ? { enabled: true, server_name: item.sni || item.servername || server, ...(insecureTLS ? { insecure: true } : {}), ...(alpn?.length ? { alpn } : {}), ...(fingerprint ? { utls: { enabled: true, fingerprint } } : {}) }
      : undefined;
  const transport = item.transport && typeof item.transport === 'object'
    ? { ...item.transport }
    : String(item.network || '').toLowerCase() === 'ws'
      ? { type: 'ws', path: item.path || item['ws-opts']?.path || '/', headers: item.host ? { Host: item.host } : undefined }
      : String(item.network || '').toLowerCase() === 'grpc'
        ? { type: 'grpc', service_name: item.service_name || item.serviceName || item.servicename || item['grpc-service-name'] || '' }
      : undefined;
  const base = { tag: 'proxy', server, server_port: serverPort };
  if (scheme === 'vless' && item.uuid) return { ...base, type: 'vless', uuid: item.uuid, flow: item.flow || undefined, tls, transport };
  if (scheme === 'vmess' && item.uuid) return { ...base, type: 'vmess', uuid: item.uuid, security: item.security || item.cipher || 'auto', tls, transport };
  if (scheme === 'trojan' && item.password) return { ...base, type: 'trojan', password: item.password, tls };
  if ((scheme === 'hysteria2' || scheme === 'hy2') && item.password) return { ...base, type: 'hysteria2', password: item.password, tls, ...(item.obfs ? { obfs: { type: item.obfs, password: item['obfs-password'] || '' } } : {}) };
  if (scheme === 'tuic' && item.uuid && item.password) return { ...base, type: 'tuic', uuid: item.uuid, password: item.password, tls, congestion_control: item.congestion_control || item['congestion-control'] || 'cubic' };
  if (scheme === 'ss' && (item.password || item.method || item.cipher)) return { ...base, type: 'shadowsocks', method: item.method || item.cipher, password: item.password || '' };
  if (scheme === 'socks' || scheme === 'socks5') return { ...base, type: 'socks', username: item.username || undefined, password: item.password || undefined };
  if (scheme === 'http') return { ...base, type: 'http', username: item.username || undefined, password: item.password || undefined };
  if ((scheme === 'wireguard' || scheme === 'wg') && (item.local_address || item.address)
      && item.private_key && (item.peer_public_key || item.public_key)) {
    return {
      ...base,
      type: 'wireguard',
      local_address: item.local_address || item.address,
      private_key: item.private_key,
      peer_public_key: item.peer_public_key || item.public_key,
      ...(item.pre_shared_key ? { pre_shared_key: item.pre_shared_key } : {}),
      ...(item.mtu ? { mtu: Number(item.mtu) || item.mtu } : {}),
      ...(item.reserved ? { reserved: item.reserved } : {})
    };
  }
  return null;
}

function parseJSON(text) {
  try {
    const value = JSON.parse(text);
    const items = value.outbounds || value.proxies || value.servers || (Array.isArray(value) ? value : []);
    return items.map((item) => {
      if (typeof item === 'string') return parseNode(item);
      if (!item || !item.server) return null;
      const outbound = outboundFromObject(item);
      if (['wireguard', 'wg'].includes(String(item.type || '').toLowerCase()) && !outbound) return null;
      const port = Number(item.server_port || item.port) || 443;
      return {
        id: randomUUID(), name: item.name || item.tag || item.server, host: item.server,
        port, protocol: item.type || 'Proxy',
        country: countryFromName(item.name || item.tag || '', item.server), ping: null,
        source: `${item.type || 'proxy'}://${item.server}:${port}`,
        ...(outbound ? { outbound } : {})
      };
    }).filter(Boolean);
  } catch { return []; }
}

function parseClashYAML(text) {
  const entries = [];
  let current;
  const clean = (value) => value.trim().replace(/^['"]|['"]$/g, '');
  for (const line of text.split(/\r?\n/)) {
    const itemStart = line.match(/^\s*-\s*name\s*:\s*(.+)$/i);
    if (itemStart) {
      if (current?.server) entries.push(current);
      current = { name: clean(itemStart[1]) };
      continue;
    }
    if (!current) continue;
    const field = line.match(/^\s*(type|server|server_port|port|uuid|password|username|cipher|method|tls|sni|servername|network|path|host|flow|service_name|serviceName|grpc-service-name|congestion_control|congestion-control|skip-cert-verify|client-fingerprint|alpn|obfs|obfs-password)\s*:\s*(.+)$/i);
    if (field) current[field[1].toLowerCase()] = clean(field[2]);
  }
  if (current?.server) entries.push(current);
  return entries.map((item) => {
    const outbound = outboundFromObject(item);
    if (['wireguard', 'wg'].includes(String(item.type || '').toLowerCase()) && !outbound) return null;
    return {
    id: randomUUID(), name: item.name || item.server, host: item.server, port: Number(item.server_port || item.port) || 443,
    protocol: item.type || 'Proxy', country: countryFromName(item.name || '', item.server), ping: null,
    source: `${String(item.type || 'socks').toLowerCase()}://${item.server}:${Number(item.server_port || item.port) || 443}`,
    ...(outbound ? { outbound } : {})
    };
  }).filter(Boolean);
}

function parseSubscription(text, fallbackURL) {
  let payload = String(text || '').replace(/^\uFEFF/, '').trim();
  const parseStructured = (value) => {
    if (value.startsWith('{') || value.startsWith('[')) return parseJSON(value);
    if (/^proxies\s*:/im.test(value)) return parseClashYAML(value);
    return [];
  };
  const candidates = [];
  const visitedPayloads = new Set();
  for (let depth = 0; depth < 3 && payload && !visitedPayloads.has(payload); depth += 1) {
    visitedPayloads.add(payload);
    candidates.push(...parseStructured(payload));
    for (const line of payload.split(/[\r\n]+/)) {
      const trimmed = line.trim().replace(/^[-*]\s+/, '');
      if (!trimmed || /^#/.test(trimmed)) continue;
      const node = parseNode(trimmed);
      if (node) candidates.push(node);
    }

    const encodedPayload = payload.replace(/^base64\s*:\s*/i, '');
    if (!isProbablyBase64(encodedPayload) || encodedPayload.includes('://')) break;
    const decoded = decodeBase64(encodedPayload).replace(/^\uFEFF/, '').trim();
    if (!decoded || decoded === payload) break;
    payload = decoded;
  }
  const isPlaceholder = (node) => {
    const source = String(node.source || '').toLowerCase();
    const name = String(node.name || '').toLowerCase();
    return (node.host === '0.0.0.0' && Number(node.port) === 1)
      || /00000000-0000-0000-0000-000000000000/.test(source)
      || /application unsupported|приложение не поддерживается/.test(name);
  };
  const placeholders = candidates.filter(isPlaceholder);
  if (placeholders.length && placeholders.length === candidates.length) {
    throw new Error('The subscription provider returned an unsupported-client placeholder instead of server nodes');
  }
  const unique = new Map(candidates.filter((node) => node && !isPlaceholder(node)).map((node) => [`${node.host}:${node.port}:${node.protocol}`, node]));
  return [...unique.values()];
}

const maxSubscriptionBytes = 10 * 1024 * 1024;

async function readResponseText(response) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxSubscriptionBytes) {
    throw new Error('Subscription response is too large');
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxSubscriptionBytes) throw new Error('Subscription response is too large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxSubscriptionBytes) {
      await reader.cancel();
      throw new Error('Subscription response is too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function fetchText(url, userAgent = 'NixVPN/0.1', includeHwid = false) {
  return new Promise(async (resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await net.fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': userAgent,
          Accept: '*/*',
          ...(includeHwid && state?.clientHwid ? { 'x-hwid': state.clientHwid } : {})
        }
      });
      if (!response.ok) throw new Error(`Subscription returned HTTP ${response.status}`);
      resolve({ text: await readResponseText(response), headers: response.headers });
    } catch (error) { reject(error); }
    finally { clearTimeout(timer); }
  });
}

async function fetchSubscription(url) {
  const first = await fetchText(url);
  if (first.headers?.get('x-hwid-not-supported')?.toLowerCase() !== 'true') return first;

  return fetchText(url, compatibleSubscriptionUserAgent, true);
}

function profileTitle(headers, sourceURL) {
  const headerTitle = headers?.get('profile-title') || headers?.get('content-disposition');
  if (headerTitle) {
    const title = headerTitle.replace(/^.*filename\s*=\s*["']?([^"';]+).*$/i, '$1').trim();
    return readableTitle(title) || titleFromURL(sourceURL);
  }
  return titleFromURL(sourceURL);
}

function subscriptionExpiry(headers) {
  const info = headers?.get('subscription-userinfo') || '';
  const match = info.match(/(?:^|;)\s*expire=(\d+)/i);
  return match ? Number(match[1]) * 1000 : null;
}

function measureSinglePing(host, port) {
  return new Promise((resolve) => {
    let settled = false;
    const started = monotonicMilliseconds();
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const socket = tcp.createConnection({ host, port }, () => {
      const value = monotonicMilliseconds() - started;
      socket.destroy();
      finish(value);
    });
    socket.setNoDelay(true);
    socket.setTimeout(1500, () => { socket.destroy(); finish(null); });
    socket.on('error', () => finish(null));
  });
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const pingTargets = [
  'https://cp.cloudflare.com/generate_204',
  'https://www.gstatic.com/generate_204'
];
const pingSamples = 3;
const pingRequestTimeout = 4500;
const pingConcurrency = 2;
const monotonicMilliseconds = () => Number(process.hrtime.bigint()) / 1e6;

async function reservePingPort() {
  for (let port = 25000; port < 25100; port += 1) {
    if (pingPortReservations.has(port)) continue;
    pingPortReservations.add(port);
    if (await portIsFree(port, '127.0.0.1')) return port;
    pingPortReservations.delete(port);
  }
  throw new Error('No temporary port is available for ping');
}

function requestThroughPingProxy(proxyPort, targetURL) {
  return new Promise((resolve) => {
    const started = monotonicMilliseconds();
    const target = new URL(targetURL);
    let finished = false;
    let secureSocket;
    const timeout = setTimeout(() => finish(null), pingRequestTimeout);
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      secureSocket?.destroy();
      resolve(value);
    };
    if (target.protocol === 'https:') {
      const request = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        method: 'CONNECT',
        path: `${target.hostname}:${target.port || 443}`,
        headers: { Host: `${target.hostname}:${target.port || 443}` },
        timeout: pingRequestTimeout
      });
      request.once('connect', (response, socket, head) => {
        if (response.statusCode !== 200) { socket.destroy(); finish(null); return; }
        secureSocket = tls.connect({ socket, servername: target.hostname }, () => {
          const requestPath = `${target.pathname || '/'}${target.search || ''}`;
          secureSocket.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\nCache-Control: no-cache\r\nUser-Agent: NixVPN/0.1\r\n\r\n`);
        });
        if (head?.length) secureSocket.unshift(head);
        secureSocket.setTimeout(pingRequestTimeout, () => finish(null));
        let responseHead = '';
        secureSocket.on('data', (chunk) => {
          responseHead += String(chunk);
          const headerEnd = responseHead.indexOf('\r\n\r\n');
          if (headerEnd < 0) {
            if (responseHead.length > 16384) finish(null);
            return;
          }
          const status = responseHead.slice(0, headerEnd).match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
          const statusCode = Number(status?.[1]);
          finish(statusCode >= 200 && statusCode < 400 ? monotonicMilliseconds() - started : null);
        });
        secureSocket.once('error', () => finish(null));
      });
      request.once('timeout', () => { request.destroy(); finish(null); });
      request.once('error', () => finish(null));
      request.end();
      return;
    }
    const request = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: target.href,
      headers: {
        Host: target.host,
        Connection: 'close',
        'Cache-Control': 'no-cache',
        'User-Agent': 'NixVPN/0.1'
      },
      timeout: pingRequestTimeout
    }, (response) => {
      const successful = response.statusCode >= 200 && response.statusCode < 400;
      response.once('data', () => finish(successful ? monotonicMilliseconds() - started : null));
      response.once('error', () => finish(null));
      response.once('end', () => finish(successful ? monotonicMilliseconds() - started : null));
      response.resume();
    });
    request.once('timeout', () => { request.destroy(); finish(null); });
    request.once('error', () => finish(null));
    request.end();
  });
}

async function waitForPingCore(child, port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Ping core stopped before it became ready');
    if (await proxyPortReady(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Ping core did not open its local proxy');
}

async function measureViaProxy(server) {
  const proxyPort = await reservePingPort();
  const configPath = path.join(app.getPath('userData'), `ping-${randomUUID()}.json`);
  let child;
  let lastError = '';
  try {
    const config = {
      log: { level: 'error', timestamp: false },
      inbounds: [{ type: 'mixed', tag: 'ping-in', listen: '127.0.0.1', listen_port: proxyPort }],
      outbounds: [buildOutbound(server), { type: 'direct', tag: 'direct' }],
      route: { final: 'proxy', auto_detect_interface: true }
    };
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    child = spawn(singBoxBinary(), ['run', '--config', configPath], { stdio: ['ignore', 'ignore', 'pipe'], detached: isLinux });
    pingCoreProcesses.add(child);
    child.stderr.on('data', (chunk) => {
      lastError = String(chunk).replace(/\x1b\[[0-9;]*m/g, '').trim().slice(-1000);
    });
    await waitForPingCore(child, proxyPort);
    let samples = [];
    for (const target of pingTargets) {
      samples = (await Promise.all(Array.from({ length: pingSamples }, () => requestThroughPingProxy(proxyPort, target))))
        .filter((sample) => sample != null && Number.isFinite(sample));
      if (samples.length) break;
    }
    if (!samples.length) throw new Error(lastError || 'Ping requests through proxy failed');
    return Math.round(median(samples) * 100) / 100;
  } finally {
    if (child) {
      signalCoreProcess(child, 'SIGTERM');
      await waitForCoreExit(child, 1500);
      if (child.exitCode === null) signalCoreProcess(child, 'SIGKILL');
      pingCoreProcesses.delete(child);
    }
    pingPortReservations.delete(proxyPort);
    try { fs.unlinkSync(configPath); } catch {}
  }
}

async function stopPingCores() {
  const processes = [...pingCoreProcesses];
  for (const child of processes) signalCoreProcess(child, 'SIGTERM');
  await Promise.all(processes.map((child) => waitForCoreExit(child, 1000)));
  for (const child of processes) {
    if (child.exitCode === null) signalCoreProcess(child, 'SIGKILL');
    pingCoreProcesses.delete(child);
  }
}

async function measurePing(server) {
  let proxyError;
  try {
    const proxyPing = await measureViaProxy(server);
    if (proxyPing != null) return { ping: proxyPing, pingSource: 'proxy' };
  } catch (error) {
    proxyError = error;
  }
  let supportedBySingBox = true;
  try { buildOutbound(server); } catch { supportedBySingBox = false; }
  if (supportedBySingBox) {
    if (proxyError) log('warning', `Tunnel ping failed for ${server.name}`, removeSecretsFromError(proxyError));
    return { ping: null, pingSource: 'timeout' };
  }
  const tcpSamples = await Promise.all(Array.from({ length: pingSamples }, (_, index) => new Promise((resolve) => {
    setTimeout(async () => resolve(await measureSinglePing(server.host, server.port)), index * 100);
  })));
  const valid = tcpSamples.filter((sample) => sample != null && Number.isFinite(sample));
  if (proxyError) log('warning', `Tunnel ping unavailable for ${server.name}; TCP fallback used`, removeSecretsFromError(proxyError));
  return valid.length
    ? { ping: Math.round(median(valid) * 100) / 100, pingSource: 'tcp' }
    : { ping: null, pingSource: null };
}

function parseSource(source) {
  try { return new URL(source); } catch { return null; }
}

function tlsOptions(url) {
  const security = url.searchParams.get('security') || url.searchParams.get('tls');
  if (!security || security === 'none') return undefined;
  const tls = { enabled: true };
  const serverName = url.searchParams.get('sni') || url.searchParams.get('peer');
  if (serverName) tls.server_name = serverName;
  const alpn = url.searchParams.get('alpn');
  if (alpn) tls.alpn = alpn.split(',');
  if (url.searchParams.get('allowInsecure') === '1' || url.searchParams.get('insecure') === '1') tls.insecure = true;
  if (security.toLowerCase() === 'reality') {
    tls.reality = { enabled: true, public_key: url.searchParams.get('pbk') || '', short_id: url.searchParams.get('sid') || '' };
    tls.utls = {
      enabled: true,
      fingerprint: url.searchParams.get('fp') || url.searchParams.get('fingerprint') || 'chrome'
    };
  }
  return tls;
}

function buildOutbound(server) {
  if (server.outbound) return { ...server.outbound, tag: 'proxy' };
  const source = server.source || '';
  const url = parseSource(source);
  if (!url) throw new Error(`Unsupported server source for ${server.name}`);
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme === 'vmess') {
    const data = JSON.parse(decodeBase64(source.replace(/^vmess:\/\//i, '')));
    const outbound = { type: 'vmess', tag: 'proxy', server: data.add, server_port: Number(data.port) || 443, uuid: data.id, security: data.scy || 'auto' };
    const tls = data.tls ? { enabled: true, server_name: data.sni || data.host || data.add } : undefined;
    if (tls) outbound.tls = tls;
    if (data.net === 'ws') outbound.transport = { type: 'ws', path: data.path || '/', headers: data.host ? { Host: data.host } : undefined };
    return outbound;
  }
  if (scheme === 'vless') {
    const outbound = { type: 'vless', tag: 'proxy', server: url.hostname, server_port: Number(url.port) || 443, uuid: safeDecodeURIComponent(url.username), flow: url.searchParams.get('flow') || undefined, tls: tlsOptions(url) };
    const type = url.searchParams.get('type') || url.searchParams.get('network');
    if (type === 'ws') outbound.transport = { type: 'ws', path: url.searchParams.get('path') || '/', headers: url.searchParams.get('host') ? { Host: url.searchParams.get('host') } : undefined };
    if (type === 'grpc') outbound.transport = { type: 'grpc', service_name: url.searchParams.get('serviceName') || '' };
    return outbound;
  }
  if (scheme === 'trojan') return { type: 'trojan', tag: 'proxy', server: url.hostname, server_port: Number(url.port) || 443, password: safeDecodeURIComponent(url.username), tls: tlsOptions(url) };
  if (scheme === 'hysteria2' || scheme === 'hy2') return { type: 'hysteria2', tag: 'proxy', server: url.hostname, server_port: Number(url.port) || 443, password: safeDecodeURIComponent(url.username), tls: tlsOptions(url), obfs: url.searchParams.get('obfs') ? { type: url.searchParams.get('obfs'), password: url.searchParams.get('obfs-password') || '' } : undefined };
  if (scheme === 'tuic') return { type: 'tuic', tag: 'proxy', server: url.hostname, server_port: Number(url.port) || 443, uuid: safeDecodeURIComponent(url.username), password: safeDecodeURIComponent(url.password), congestion_control: url.searchParams.get('congestion_control') || 'cubic', tls: tlsOptions(url) };
  if (scheme === 'socks' || scheme === 'socks5' || scheme === 'http') return { type: scheme === 'http' ? 'http' : 'socks', tag: 'proxy', server: url.hostname, server_port: Number(url.port) || 443, username: safeDecodeURIComponent(url.username) || undefined, password: safeDecodeURIComponent(url.password) || undefined };
  if (scheme === 'ss') {
    let method = safeDecodeURIComponent(url.username); let password = safeDecodeURIComponent(url.password);
    if (!password) {
      const decoded = decodeBase64(url.username);
      if (decoded.includes(':')) [method, password] = decoded.split(/:(.*)/s);
    }
    return { type: 'shadowsocks', tag: 'proxy', server: url.hostname, server_port: Number(url.port) || 443, method, password };
  }
  throw new Error(`${server.protocol} is imported, but its sing-box outbound mapping is not available yet`);
}

function singBoxBinary() {
  const configured = process.env.NIXVPN_SING_BOX;
  const candidates = configured ? [configured] : ['/run/current-system/sw/bin/sing-box', '/usr/bin/sing-box', '/usr/local/bin/sing-box', 'sing-box'];
  return candidates.find((candidate) => candidate === 'sing-box' || fs.existsSync(candidate)) || 'sing-box';
}

function ipBinary() {
  const candidates = ['/run/current-system/sw/bin/ip', '/usr/bin/ip', '/bin/ip', 'ip'];
  return candidates.find((candidate) => candidate === 'ip' || fs.existsSync(candidate)) || 'ip';
}

function shellBinary() {
  const candidates = ['/run/current-system/sw/bin/sh', '/bin/sh', '/usr/bin/sh', 'sh'];
  return candidates.find((candidate) => candidate === 'sh' || fs.existsSync(candidate)) || 'sh';
}

function systemBinary(name) {
  const candidates = [`/run/current-system/sw/bin/${name}`, `/usr/bin/${name}`, `/bin/${name}`, name];
  return candidates.find((candidate) => candidate === name || fs.existsSync(candidate)) || name;
}

function installedNixvpnBinary(name) {
  const launcher = '/run/current-system/sw/bin/nixvpn';
  try {
    const packageRoot = path.dirname(path.dirname(fs.realpathSync(launcher)));
    const candidate = path.join(packageRoot, 'libexec', name);
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function nixosConfigPath() {
  const configured = process.env.NIXOS_CONFIG;
  const candidates = configured && path.isAbsolute(configured)
    ? [configured]
    : ['/etc/nixos/configuration.nix'];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function nixvpnModulePath() {
  const candidates = [
    path.join(app.getAppPath(), 'nix', 'module.nix'),
    path.join(__dirname, '..', 'nix', 'module.nix')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function hasNixvpnModuleImport(config, modulePath) {
  return Boolean(modulePath && (
    config.includes(modulePath) ||
    /(?:nixvpn|NixVpn)[^\"\n]*module\.nix/.test(config) ||
    /\/nix\/module\.nix/.test(config)
  ));
}

function activeTunConflict() {
  if (!isLinux) return null;
  if (fs.existsSync('/sys/class/net/throne-tun')) return { name: 'Throne', interface: 'throne-tun' };
  return null;
}

function systemDiagnostics() {
  const nixos = isLinux && (fs.existsSync('/etc/NIXOS') || fs.existsSync('/run/current-system/sw/bin/nixos-version'));
  const configPath = nixosConfigPath();
  const modulePath = nixvpnModulePath();
  let config = '';
  try { if (configPath) config = fs.readFileSync(configPath, 'utf8'); } catch {}
  const hasImport = hasNixvpnModuleImport(config, modulePath);
  const hasEnable = /programs\.nixvpn\.enable\s*=\s*true\s*;/.test(config);
  const helperPath = tunHelperBinary();
  const supervisorPath = tunSupervisorBinary();
  const hasHelper = Boolean(helperPath);
  const hasSupervisor = Boolean(supervisorPath);
  const tunConflict = activeTunConflict();
  let hasSessionSupervisor = false;
  try { hasSessionSupervisor = Boolean(supervisorPath && fs.readFileSync(supervisorPath, 'utf8').includes('NIXVPN_CORE_PAUSED')); } catch {}
  const missing = [];
  if (!configPath) missing.push('NixOS configuration');
  if (!modulePath) missing.push('NixVPN module');
  if (configPath && modulePath && !hasImport) missing.push('NixVPN module import');
  if (configPath && !hasEnable) missing.push('programs.nixvpn.enable');
  if (!hasHelper || !hasSupervisor) missing.push('installed TUN helpers');
  if (!hasSessionSupervisor) missing.push('updated TUN supervisor');
  return {
    nixos,
    configPath,
    modulePath,
    ready: nixos && hasImport && hasEnable && hasHelper && hasSupervisor && hasSessionSupervisor,
    needsSetup: nixos && missing.length > 0,
    canSetup: Boolean(nixos && configPath && modulePath && fs.existsSync('/run/current-system/sw/bin/nixos-rebuild') && fs.existsSync('/run/wrappers/bin/pkexec')),
    missing,
    tunConflict
  };
}

function prepareNixosConfiguration(source, modulePath) {
  let next = String(source || '');
  const moduleImport = JSON.stringify(modulePath);
  if (!hasNixvpnModuleImport(next, modulePath)) {
    const imports = /\bimports\s*=\s*\[/m.exec(next);
    if (imports) {
      const close = next.indexOf(']', imports.index + imports[0].length);
      if (close < 0) throw new Error('Could not locate the end of the NixOS imports list');
      next = `${next.slice(0, close).replace(/\s*$/, '')}\n      ${moduleImport}\n    ${next.slice(close)}`;
    } else {
      const open = next.indexOf('{');
      if (open < 0) throw new Error('Could not locate the NixOS configuration body');
      next = `${next.slice(0, open + 1)}\n  imports = [\n    ${moduleImport}\n  ];\n${next.slice(open + 1)}`;
    }
  }
  const enable = /programs\.nixvpn\.enable\s*=\s*(?:true|false)\s*;/m;
  if (enable.test(next)) next = next.replace(enable, 'programs.nixvpn.enable = true;');
  else {
    const close = next.lastIndexOf('}');
    if (close < 0) throw new Error('Could not locate the end of the NixOS configuration');
    next = `${next.slice(0, close).replace(/\s*$/, '')}\n\n  programs.nixvpn.enable = true;\n${next.slice(close)}`;
  }
  return next;
}

async function setupNixosIntegration() {
  const diagnostics = systemDiagnostics();
  if (!diagnostics.nixos) throw new Error('This automatic setup is available only on NixOS');
  if (!diagnostics.configPath || !diagnostics.modulePath || !diagnostics.canSetup) {
    throw new Error('NixOS configuration, NixVPN module, or required system tools were not found');
  }
  const source = fs.readFileSync(diagnostics.configPath, 'utf8');
  const prepared = prepareNixosConfiguration(source, diagnostics.modulePath);
  const candidatePath = path.join(app.getPath('userData'), `configuration.nixvpn-${process.pid}.tmp`);
  const backupPath = `${diagnostics.configPath}.nixvpn-backup-${Date.now()}`;
  fs.writeFileSync(candidatePath, prepared, { mode: 0o600 });
  const shell = shellBinary();
  const cp = systemBinary('cp');
  const install = systemBinary('install');
  const rebuild = systemBinary('nixos-rebuild');
  const command = [
    'set -eu',
    `config=${shellQuote(diagnostics.configPath)}`,
    `candidate=${shellQuote(candidatePath)}`,
    `backup=${shellQuote(backupPath)}`,
    `${shellQuote(cp)} -p -- "$config" "$backup"`,
    `${shellQuote(install)} -o root -g root -m 0644 -- "$candidate" "$config"`,
    `if ${shellQuote(rebuild)} switch; then exit 0; else status=$?; ${shellQuote(cp)} -p -- "$backup" "$config"; exit "$status"; fi`
  ].join('\n');
  try {
    await runCommand('pkexec', [shell, '-c', command]);
  } finally {
    try { fs.unlinkSync(candidatePath); } catch {}
  }
  log('success', 'NixOS integration configured', 'The NixVPN module was enabled and the system was rebuilt');
  return publicState();
}

function tunHelperBinary() {
  const configured = process.env.NIXVPN_TUN_HELPER;
  const candidates = configured
    ? [configured]
    : [installedNixvpnBinary('nixvpn-tun-helper'), '/run/current-system/sw/bin/nixvpn-tun-helper', '/usr/bin/nixvpn-tun-helper'];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function tunSupervisorBinary() {
  const configured = process.env.NIXVPN_TUN_SUPERVISOR;
  const candidates = configured
    ? [configured]
    : [installedNixvpnBinary('nixvpn-tun-supervisor'), '/run/current-system/sw/bin/nixvpn-tun-supervisor', path.join(__dirname, '..', 'nix', 'nixvpn-tun-supervisor.sh')];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function coreProcessExists(configPath) {
  if (!configPath) return false;
  try {
    await commandOutput('pgrep', ['-f', `[s]ing-box.*${configPath}`]);
    return true;
  } catch { return false; }
}

async function terminateOrphanedCore() {
  const configPath = coreConfigPath;
  if (!configPath || !(await coreProcessExists(configPath))) return;
  const helper = coreUsesPrivilege && tunHelperBinary();
  if (helper) {
    await runCommand('pkexec', [helper, 'stop-core', configPath]);
    const deadline = Date.now() + 3000;
    while (await coreProcessExists(configPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 120));
    if (await coreProcessExists(configPath)) throw new Error('sing-box process is still active after disconnect');
    return;
  }
  const pattern = shellQuote(`[s]ing-box.*${configPath}`);
  const command = `pkill -TERM -f -- ${pattern} 2>/dev/null || true; sleep 1; pkill -KILL -f -- ${pattern} 2>/dev/null || true`;
  if (coreUsesPrivilege) await runCommand('pkexec', [shellBinary(), '-c', command]);
  else await runCommand('pkill', ['-TERM', '-f', `[s]ing-box.*${configPath}`]);
  const deadline = Date.now() + 3000;
  while (await coreProcessExists(configPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 120));
  if (await coreProcessExists(configPath)) throw new Error('sing-box process is still active after disconnect');
}

async function tunRoutingNeedsCleanup() {
  if (!isLinux) return false;
  if (!fs.existsSync('/sys/class/net/nixvpn0')) return false;
  try {
    const details = await commandOutput(ipBinary(), ['-details', 'link', 'show', 'nixvpn0']);
    return /alias NixVPN/.test(details);
  } catch { return false; }
}

async function cleanupTunNetworking() {
  if (!(await tunRoutingNeedsCleanup())) return;
  const helper = tunHelperBinary();
  if (helper) {
    await runCommand('pkexec', [helper, 'cleanup']);
    const deadline = Date.now() + 2000;
    while (fs.existsSync('/sys/class/net/nixvpn0') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    if (fs.existsSync('/sys/class/net/nixvpn0')) throw new Error('TUN interface nixvpn0 is still active after cleanup');
    return;
  }
  const ip = ipBinary();
  const shell = shellBinary();
  const cleanup = [
    `details=$(${ip} -details link show nixvpn0 2>/dev/null || true); case "$details" in *"alias NixVPN"*) ;; *) exit 0 ;; esac`,
    `${ip} rule del pref 9020 2>/dev/null || true`,
    `${ip} -6 rule del pref 9020 2>/dev/null || true`,
    `${ip} route flush table 20220 2>/dev/null || true`,
    `${ip} -6 route flush table 20220 2>/dev/null || true`,
    `${ip} link delete nixvpn0 2>/dev/null || true`
  ].join('; ');
  await runCommand('pkexec', [shell, '-c', cleanup]);
  const deadline = Date.now() + 2000;
  while ((fs.existsSync('/sys/class/net/nixvpn0') || Date.now() < deadline) && Date.now() < deadline) {
    if (!fs.existsSync('/sys/class/net/nixvpn0')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (fs.existsSync('/sys/class/net/nixvpn0')) throw new Error('TUN interface nixvpn0 is still active after cleanup');
}

async function markTunNetworking(configPath) {
  const helper = tunHelperBinary();
  if (!helper) return;
  await runCommand('pkexec', [helper, 'mark', configPath]);
}

async function removeStaleTunInterface() {
  await cleanupTunNetworking();
}

function coreConfig(server, mode, proxyPort) {
  const inbounds = [];
  if (mode === 'Proxy' || mode === 'Proxy + TUN') inbounds.push({ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: proxyPort });
  if (mode === 'TUN' || mode === 'Proxy + TUN') inbounds.push({
    type: 'tun', tag: 'tun-in', interface_name: 'nixvpn0', address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
    auto_route: true, auto_redirect: true, strict_route: true,
    route_address: ['0.0.0.0/1', '128.0.0.0/1', '::/1', '8000::/1'],
    route_exclude_address: ['10.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
    stack: 'gvisor',
    iproute2_table_index: 20220, iproute2_rule_index: 9020
  });
  return {
    log: { level: 'warn', timestamp: true },
    inbounds,
    outbounds: [buildOutbound(server), { type: 'direct', tag: 'direct' }],
    route: { final: 'proxy', auto_detect_interface: true }
  };
}

async function startProxyCore(server, mode) {
  const proxyPort = mode === 'TUN' ? null : await findAvailablePort(state.settings.proxyPort);
  const needsAdmin = mode !== 'Proxy';
  if (needsAdmin) {
    const conflict = activeTunConflict();
    if (conflict) throw new Error(`Another full-device TUN is active (${conflict.name}, ${conflict.interface}). Disconnect it before starting NixVPN TUN.`);
  }
  const pausedSupervisor = needsAdmin && coreProcess?.stdin?.writable && coreProcess.__nixvpnPaused && coreConfigPath;
  if (pausedSupervisor) {
    const config = coreConfig(server, mode, proxyPort);
    if (proxyPort) {
      state.runtimeProxyPort = proxyPort;
      writeState();
    }
    fs.writeFileSync(coreConfigPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    await sendSupervisorCommand(coreProcess, 'restart');
    await waitForCoreReady(coreProcess, mode, proxyPort);
    coreProcess.__nixvpnPaused = false;
    return;
  }
  if (needsAdmin && await tunRoutingNeedsCleanup()) {
    await removeStaleTunInterface();
  }
  if (proxyPort && proxyPort !== Number(state.settings.proxyPort)) {
    log('warning', 'Proxy port was busy', `Using free port ${proxyPort} instead`);
  }
  if (proxyPort) {
    state.runtimeProxyPort = proxyPort;
    writeState();
  }
  return new Promise((resolve, reject) => {
    let config;
    try { config = coreConfig(server, mode, proxyPort); } catch (error) { reject(error); return; }
    const configPath = path.join(app.getPath('userData'), 'runtime-config.json');
    if (needsAdmin && !isLinux) { reject(new Error('TUN is supported on Linux only')); return; }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    coreConfigPath = configPath;
    coreUsesPrivilege = needsAdmin;
    const binary = singBoxBinary();
    const supervisor = needsAdmin && tunSupervisorBinary();
    const command = needsAdmin ? 'pkexec' : binary;
    const args = needsAdmin
      ? supervisor ? [supervisor, configPath] : [binary, 'run', '--config', configPath]
      : ['run', '--config', configPath];
    const child = spawn(command, args, { stdio: [supervisor ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: isLinux });
    coreProcess = child;
    let settled = false;
    let runtimeFailed = false;
    let lastError = '';
    const clearFailedStart = () => {
      try { fs.unlinkSync(configPath); } catch {}
      if (coreConfigPath === configPath) coreConfigPath = null;
      coreUsesPrivilege = false;
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (coreProcess === child) coreProcess = null;
      signalCoreProcess(child, 'SIGTERM');
      clearFailedStart();
      reject(error);
    };
    const runtimeFailure = (error) => {
      if (runtimeFailed) return;
      runtimeFailed = true;
      if (!settled) { fail(error); return; }
      if (coreProcess === child) coreProcess = null;
      signalCoreProcess(child, 'SIGTERM');
      state.connection = 'Disconnected';
      state.connectionStartedAt = null;
      writeState();
      log('error', 'sing-box stopped unexpectedly', error.message);
      sendStateChanged();
      void recoverConnectionAfterFailure(child);
    };
    child.stdout.on('data', (chunk) => log('info', 'sing-box', String(chunk).trim().slice(-600)));
    child.stderr.on('data', (chunk) => {
      lastError = String(chunk).replace(/\x1b\[[0-9;]*m/g, '').trim().slice(-600);
      const criticalError = /not pollable|fatal|start service|permission denied|add route .*file exists|configure tun interface/i.test(lastError);
      if (!(runtimeFailed && criticalError)) log('warning', 'sing-box', lastError);
      if (criticalError) {
        const message = /not pollable/i.test(lastError)
          ? 'TUN device is not usable on this system (sing-box reported “not pollable”)'
          : /add route .*file exists/i.test(lastError)
            ? 'TUN routes are already used by another VPN or stale system rules'
            : lastError;
        runtimeFailure(new Error(message));
      }
    });
    child.once('error', (error) => fail(new Error(`Could not start sing-box: ${error.message}`)));
    child.once('close', (code) => {
      if (!settled) {
        if (needsAdmin && /add route .*file exists|set routes/i.test(lastError)) fail(new Error('TUN route is already used by another VPN or a stale route. Disconnect the other VPN and try again.'));
        else if (needsAdmin && (code === 126 || code === 127)) fail(new Error('Privileged authorization was cancelled or denied'));
        else fail(new Error(`sing-box exited with code ${code}${lastError ? `: ${lastError}` : ''}`));
      } else {
        if (coreProcess === child) coreProcess = null;
        if (child.__nixvpnStopping || runtimeFailed) log('info', 'sing-box stopped');
        else {
          runtimeFailure(new Error(lastError || `exit code ${code}`));
        }
      }
    });
    waitForCoreReady(child, mode, proxyPort).then(async () => {
      if (needsAdmin) await markTunNetworking(configPath);
      if (!settled) { settled = true; resolve(); }
    }).catch(fail);
  });
}

function proxyPortReady(port) {
  return new Promise((resolve) => {
    const socket = tcp.createConnection({ host: '127.0.0.1', port });
    const finish = (ready) => { socket.destroy(); resolve(ready); };
    socket.setTimeout(250, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitForCoreReady(child, mode, proxyPort) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.killed) throw new Error('sing-box stopped before the connection became ready');
    const proxyReady = mode === 'TUN' || await proxyPortReady(proxyPort);
    const tunReady = mode === 'Proxy' || fs.existsSync('/sys/class/net/nixvpn0');
    if (proxyReady && tunReady) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(mode === 'Proxy' ? 'Proxy core did not open its local port' : 'TUN interface was not created');
}

function signalCoreProcess(child, signal) {
  if (!child || child.exitCode !== null) return;
  if (isLinux && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try { child.kill(signal); } catch {}
}

function waitForCoreExit(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once('close', finish);
  });
}

async function stopProxyCore() {
  const child = coreProcess;
  if (!child) return;
  coreProcess = null;
  child.__nixvpnStopping = true;
  if (coreUsesPrivilege && child.stdin?.writable) {
    try { child.stdin.write('stop\n'); } catch { signalCoreProcess(child, 'SIGINT'); }
  } else {
    signalCoreProcess(child, 'SIGINT');
  }
  await waitForCoreExit(child, 2500);
  if (child.exitCode === null) {
    signalCoreProcess(child, 'SIGTERM');
    await waitForCoreExit(child, 3000);
  }
  if (child.exitCode === null) {
    signalCoreProcess(child, 'SIGKILL');
    await waitForCoreExit(child, 2000);
  }
}

async function pauseSupervisedCore() {
  const child = coreProcess;
  if (!child?.stdin?.writable || !coreConfigPath || !coreUsesPrivilege) throw new Error('TUN supervisor is not available');
  await sendSupervisorCommand(child, 'pause', 'NIXVPN_CORE_PAUSED');
  child.__nixvpnPaused = true;
}

async function stopCoreCompletely() {
  const configPath = coreConfigPath;
  let stopError;
  try { await stopProxyCore(); } catch (error) { stopError = error; }
  try { await terminateOrphanedCore(); }
  finally {
    if (configPath) {
      try { fs.unlinkSync(configPath); } catch {}
    }
    coreConfigPath = null;
    coreUsesPrivilege = false;
  }
  if (stopError) throw stopError;
}

async function disconnectConnection() {
  const errors = [];
  try {
    if (state.mode !== 'Proxy' && coreProcess?.stdin?.writable) await pauseSupervisedCore();
    else await stopCoreCompletely();
  } catch (error) { errors.push(`Core stop failed: ${error.message}`); }
  const hadProxyBackup = Boolean(systemProxyBackup) || fs.existsSync(proxyBackupPath());
  try {
    const restored = await restoreKDEProxy();
    if (hadProxyBackup && !restored) errors.push('System proxy could not be restored');
  } catch (error) { errors.push(`System proxy restore failed: ${error.message}`); }
  try { await cleanupTunNetworking(); }
  catch (error) { errors.push(`TUN cleanup failed: ${error.message}`); }
  state.connection = 'Disconnected';
  state.connectionStartedAt = null;
  writeState();
  if (errors.length) {
    const detail = errors.join('; ');
    log('error', 'Disconnect cleanup failed', detail);
    throw new Error(`VPN stopped, but cleanup needs attention: ${detail}`);
  }
  log('info', 'Connection stopped');
  return state;
}

async function configureSystemProxyForMode(mode) {
  if (mode === 'Proxy' || mode === 'Proxy + TUN') {
    try {
      const applied = await setKDEProxy(state.runtimeProxyPort || state.settings.proxyPort);
      if (!applied) log('info', 'Local proxy is ready', `127.0.0.1:${state.runtimeProxyPort || state.settings.proxyPort}`);
    } catch (error) {
      log('warning', 'System proxy was not configured', error.message);
    }
  } else {
    const disabled = await disableKDEProxy();
    if (!disabled) log('info', 'System proxy is not managed', 'TUN mode routes traffic through the tunnel directly');
  }
}

async function connectCoreForServer(server, mode) {
  await startProxyCore(server, mode);
  if (!coreProcess) throw new Error('sing-box stopped before the connection was confirmed');
  await configureSystemProxyForMode(mode);
}

function sendSupervisorCommand(child, command, acknowledgement = 'NIXVPN_CORE_RESTARTED') {
  return new Promise((resolve, reject) => {
    if (!child?.stdin?.writable || !child.stdout) {
      reject(new Error('TUN supervisor control channel is unavailable'));
      return;
    }
    let output = '';
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('TUN supervisor did not acknowledge the command')), 10000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('close', onClose);
      child.stdin.off('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk) => {
      output += String(chunk);
      if (output.includes(acknowledgement)) finish();
    };
    const onClose = (code) => finish(new Error(`TUN supervisor exited with code ${code}`));
    const onError = (error) => finish(new Error(`TUN supervisor control failed: ${error.message}`));
    child.stdout.on('data', onData);
    child.once('close', onClose);
    child.stdin.once('error', onError);
    try { child.stdin.write(`${command}\n`); } catch (error) { finish(error); }
  });
}

async function switchSupervisedTunServer(server, mode) {
  const child = coreProcess;
  if (!child?.stdin?.writable || !coreConfigPath) throw new Error('TUN supervisor is not available');
  const proxyPort = mode === 'TUN' ? null : Number(state.runtimeProxyPort) || await findAvailablePort(state.settings.proxyPort);
  const config = coreConfig(server, mode, proxyPort);
  fs.writeFileSync(coreConfigPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  await sendSupervisorCommand(child, 'restart');
  await waitForCoreReady(child, mode, proxyPort);
}

async function recoverConnectionAfterFailure(failedChild) {
  if (!state.settings.autoRecover || recoveryInProgress || quitting) return;
  recoveryInProgress = true;
  try {
    await waitForCoreExit(failedChild, 5000);
    if (failedChild.exitCode === null) {
      signalCoreProcess(failedChild, 'SIGKILL');
      await waitForCoreExit(failedChild, 2000);
    }

    const profile = state.profiles.find((item) => item.servers.some((server) => server.id === state.activeServerId)) || state.profiles[0];
    if (!profile) throw new Error('No subscription is available for automatic recovery');
    log('info', 'Automatic recovery started', `Updating profile “${profile.name}” and checking servers`);
    await updateSubscription(profile.id, { measurePings: true });

    const refreshed = state.profiles.find((item) => item.id === profile.id);
    const candidates = (refreshed?.servers || []).filter((server) => server.host);
    if (!candidates.length) throw new Error('The updated subscription has no available servers');
    const reachable = candidates.filter((server) => server.ping != null && Number.isFinite(Number(server.ping)));
    const best = (reachable.length ? reachable : candidates).reduce((winner, server) => {
      if (!winner) return server;
      if (!reachable.length) return winner;
      return Number(server.ping) < Number(winner.ping) ? server : winner;
    }, null);

    state.activeServerId = best.id;
    writeState();
    await startProxyCore(best, state.mode);
    if (!coreProcess) throw new Error('sing-box stopped before automatic recovery completed');
    if (state.mode === 'Proxy' || state.mode === 'Proxy + TUN') {
      await setKDEProxy(state.runtimeProxyPort || state.settings.proxyPort);
    }
    state.connection = 'Connected';
    state.connectionStartedAt = Date.now();
    writeState();
    log('success', `Connection recovered on ${best.name}`, `${best.ping == null ? 'Ping unavailable' : `${best.ping} ms`} · ${best.protocol}`);
    sendStateChanged();
  } catch (error) {
    state.connection = 'Disconnected';
    state.connectionStartedAt = null;
    writeState();
    log('error', 'Automatic recovery failed', removeSecretsFromError(error));
    sendStateChanged();
  } finally {
    recoveryInProgress = false;
  }
}

function portIsFree(port, host) {
  return new Promise((resolve) => {
    const probe = tcp.createServer();
    probe.once('error', (error) => resolve(error.code === 'EADDRNOTAVAIL'));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen({ port, host, exclusive: true });
  });
}

async function findAvailablePort(preferredPort) {
  const start = Math.min(65535, Math.max(1024, Number(preferredPort) || 2080));
  for (let offset = 0; offset < 100; offset += 1) {
    const candidate = start + offset;
    if (candidate > 65535) break;
    const [ipv4Free, ipv6Free] = await Promise.all([
      portIsFree(candidate, '127.0.0.1'),
      portIsFree(candidate, '::1')
    ]);
    if (ipv4Free && ipv6Free) return candidate;
  }
  throw new Error(`Could not find a free proxy port near ${start}`);
}

function autostartFile() {
  return path.join(app.getPath('appData'), 'autostart', 'nixvpn.desktop');
}

function desktopQuote(value) {
  return `"${String(value).replace(/([\\"])/g, '\\$1')}"`;
}

function commandOutput(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || '').trim());
    });
  });
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve(String(stdout || '').trim());
    });
  });
}

async function setKDEProxy(port) {
  const kwrite = ['/run/current-system/sw/bin/kwriteconfig6', '/usr/bin/kwriteconfig6', 'kwriteconfig6'].find((candidate) => candidate === 'kwriteconfig6' || fs.existsSync(candidate));
  const kread = ['/run/current-system/sw/bin/kreadconfig6', '/usr/bin/kreadconfig6', 'kreadconfig6'].find((candidate) => candidate === 'kreadconfig6' || fs.existsSync(candidate));
  if (!kwrite || !kread || !String(process.env.XDG_CURRENT_DESKTOP || '').toLowerCase().includes('kde')) return false;
  if (!systemProxyBackup) {
    try {
      systemProxyBackup = {
        proxyType: await commandOutput(kread, ['--file', 'kioslaverc', '--group', 'Proxy Settings', '--key', 'ProxyType']),
        httpProxy: await commandOutput(kread, ['--file', 'kioslaverc', '--group', 'Proxy Settings', '--key', 'httpProxy']),
        httpsProxy: await commandOutput(kread, ['--file', 'kioslaverc', '--group', 'Proxy Settings', '--key', 'httpsProxy']),
        noProxy: await commandOutput(kread, ['--file', 'kioslaverc', '--group', 'Proxy Settings', '--key', 'NoProxy'])
      };
      fs.writeFileSync(proxyBackupPath(), JSON.stringify(systemProxyBackup), { mode: 0o600 });
    } catch (error) {
      log('error', 'Could not save current system proxy settings', error.message);
      throw new Error('Could not save current system proxy settings before enabling VPN proxy');
    }
  }
  await runCommand(kwrite, ['--file', 'kioslaverc', '--group', 'Proxy Settings', '--key', 'ProxyType', '1']);
  await runCommand(kwrite, ['--file', 'kioslaverc', '--group', 'Proxy Settings', '--key', 'httpProxy', '127.0.0.1  ' + port]);
  await runCommand(kwrite, ['--file', 'kioslaverc', '--group', 'Proxy Settings', '--key', 'httpsProxy', '127.0.0.1  ' + port]);
  await runCommand(kwrite, ['--file', 'kioslaverc', '--group', 'Proxy Settings', '--key', 'NoProxy', '<local>']);
  return true;
}

async function disableKDEProxy() {
  const kwrite = ['/run/current-system/sw/bin/kwriteconfig6', '/usr/bin/kwriteconfig6', 'kwriteconfig6'].find((candidate) => candidate === 'kwriteconfig6' || fs.existsSync(candidate));
  const kread = ['/run/current-system/sw/bin/kreadconfig6', '/usr/bin/kreadconfig6', 'kreadconfig6'].find((candidate) => candidate === 'kreadconfig6' || fs.existsSync(candidate));
  if (!kwrite || !kread || !String(process.env.XDG_CURRENT_DESKTOP || '').toLowerCase().includes('kde')) return false;
  if (!systemProxyBackup) {
    try {
      systemProxyBackup = {
        proxyType: await commandOutput(kread, ['--file', 'kioslaverc', '--group', 'Proxy Settings', '--key', 'ProxyType']),
        httpProxy: await commandOutput(kread, ['--file', 'kioslaverc', '--group', 'Proxy Settings', '--key', 'httpProxy']),
        httpsProxy: await commandOutput(kread, ['--file', 'kioslaverc', '--group', 'Proxy Settings', '--key', 'httpsProxy']),
        noProxy: await commandOutput(kread, ['--file', 'kioslaverc', '--group', 'Proxy Settings', '--key', 'NoProxy'])
      };
      fs.writeFileSync(proxyBackupPath(), JSON.stringify(systemProxyBackup), { mode: 0o600 });
    } catch (error) {
      log('error', 'Could not save current system proxy settings', error.message);
      throw new Error('Could not save current system proxy settings before starting TUN');
    }
  }
  await runCommand(kwrite, ['--file', 'kioslaverc', '--group', 'Proxy Settings', '--key', 'ProxyType', '0']);
  return true;
}

async function restoreKDEProxy() {
  if (!systemProxyBackup) {
    try { systemProxyBackup = JSON.parse(fs.readFileSync(proxyBackupPath(), 'utf8')); } catch { return false; }
  }
  const kwrite = ['/run/current-system/sw/bin/kwriteconfig6', '/usr/bin/kwriteconfig6', 'kwriteconfig6'].find((candidate) => candidate === 'kwriteconfig6' || fs.existsSync(candidate));
  if (!kwrite) return false;
  const backup = systemProxyBackup;
  const write = async (key, value) => {
    if (value) await runCommand(kwrite, ['--file', 'kioslaverc', '--group', 'Proxy Settings', '--key', key, value]);
    else await runCommand(kwrite, ['--file', 'kioslaverc', '--group', 'Proxy Settings', '--key', key, '--delete']);
  };
  try {
    await write('ProxyType', backup.proxyType || '0');
    await write('httpProxy', backup.httpProxy);
    await write('httpsProxy', backup.httpsProxy);
    await write('NoProxy', backup.noProxy);
    try { fs.unlinkSync(proxyBackupPath()); } catch {}
    systemProxyBackup = null;
    return true;
  } catch (error) {
    log('warning', 'System proxy restore failed', error.message);
    return false;
  }
}

function applyAutostart(enabled) {
  const target = autostartFile();
  if (!enabled) {
    try { fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const exec = `${desktopQuote(process.execPath)} --no-sandbox --disable-setuid-sandbox --in-process-gpu ${desktopQuote(app.getAppPath())}`;
  fs.writeFileSync(target, `[Desktop Entry]\nType=Application\nName=NixVPN\nExec=${exec}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`, { mode: 0o644 });
}

function scheduleSubscriptionUpdates() {
  if (subscriptionTimer) clearInterval(subscriptionTimer);
  if (subscriptionStartupTimer) clearTimeout(subscriptionStartupTimer);
  subscriptionTimer = null;
  subscriptionStartupTimer = null;
  if (!state.settings.autoUpdate && !state.settings.updateOnLaunch) return;
  const hours = Number(state.settings.updateIntervalHours) || 24;
  if (state.settings.updateOnLaunch || state.settings.autoUpdate) subscriptionStartupTimer = setTimeout(async () => {
    subscriptionStartupTimer = null;
    for (const profile of [...state.profiles]) {
      try { await updateSubscription(profile.id); }
      catch (error) { log('error', 'Automatic subscription update failed', removeSecretsFromError(error)); }
    }
  }, 1000);
  if (state.settings.autoUpdate) subscriptionTimer = setInterval(async () => {
    for (const profile of [...state.profiles]) {
      try { await updateSubscription(profile.id); }
      catch (error) { log('error', 'Automatic subscription update failed', removeSecretsFromError(error)); }
    }
  }, hours * 60 * 60 * 1000);
}

function schedulePingChecks() {
  if (pingTimer) clearInterval(pingTimer);
  if (pingStartupTimer) clearTimeout(pingStartupTimer);
  pingTimer = null;
  pingStartupTimer = null;

  const run = async () => {
    if (!state.profiles.length) return;
    try {
      await checkAllPings();
      sendStateChanged();
    } catch (error) {
      log('error', 'Scheduled ping check failed', removeSecretsFromError(error));
    }
  };

  if (state.settings.pingOnLaunch) pingStartupTimer = setTimeout(() => {
    pingStartupTimer = null;
    void run();
  }, 1000);
  if (state.settings.autoPing) {
    const hours = Number(state.settings.pingIntervalHours) || 1;
    pingTimer = setInterval(() => { void run(); }, hours * 60 * 60 * 1000);
  }
}

async function measureProfilePings(profile) {
  const servers = [...profile.servers];
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < servers.length) {
      const index = nextIndex++;
      const server = servers[index];
      servers[index] = { ...server, ...await measurePing(server) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(pingConcurrency, servers.length) }, worker));
  return { ...profile, servers };
}

async function measureProfileInBackground(profileId) {
  try {
    const current = state.profiles.find((profile) => profile.id === profileId);
    if (!current) return;
    const located = await enrichProfileCountries(current);
    const index = state.profiles.findIndex((profile) => profile.id === profileId);
    if (index < 0) return;
    const latest = state.profiles[index];
    state.profiles = state.profiles.map((profile, profileIndex) => profileIndex === index
      ? { ...located, name: latest.name, customName: Boolean(latest.customName), sourceURL: latest.sourceURL, expiresAt: latest.expiresAt, updatedAt: latest.updatedAt }
      : profile);
    writeState();
    sendStateChanged();
  } catch (error) {
    log('warning', 'Background server location refresh failed', removeSecretsFromError(error));
  }
}

async function refreshSavedServerCountries() {
  if (!state.profiles.length) return;
  const profiles = await Promise.all(state.profiles.map((profile) => enrichProfileCountries(profile)));
  const changed = profiles.some((profile, index) => profile.servers.some((server, serverIndex) => server.country !== state.profiles[index].servers[serverIndex].country));
  if (!changed) return;
  state.profiles = profiles;
  writeState();
  sendStateChanged();
}

async function addSubscription(rawSourceURL) {
  const sourceURL = unwrapSubscriptionURL(rawSourceURL);
  const duplicate = state.profiles.find((profile) => sourceKey(profile.sourceURL) === sourceKey(sourceURL));
  if (duplicate) {
    log('info', `Profile “${duplicate.name}” is already added`);
    return state;
  }
  if (!/^https?:\/\//i.test(sourceURL) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(sourceURL)) {
    throw new Error('Enter a subscription URL or a supported share link');
  }
  let text = sourceURL;
  let headers;
  if (/^https?:\/\//i.test(sourceURL)) ({ text, headers } = await fetchSubscription(sourceURL));
  if (headers?.get('x-hwid-not-supported')?.toLowerCase() === 'true') {
    throw new Error('The subscription provider does not support NixVPN as a client. Use a provider link compatible with Clash/sing-box or ask the provider to enable this app.');
  }
  const servers = parseSubscription(text, sourceURL);
  if (!servers.length) throw new Error('No supported servers were found in this subscription');
  const profile = {
    id: randomUUID(), name: profileTitle(headers, sourceURL), customName: false, sourceURL,
    expiresAt: subscriptionExpiry(headers), updatedAt: Date.now(), servers: servers.map((server) => normalizeServer(server, sourceURL))
  };
  state.profiles = [...state.profiles, profile];
  writeState();
  log('success', `Added profile “${profile.name}”`, `${profile.servers.length} servers detected; ping is not checked automatically`);
  void measureProfileInBackground(profile.id);
  return state;
}

function serverIdentity(server) {
  return `${String(server?.host || '').toLowerCase()}:${Number(server?.port) || 443}:${String(server?.protocol || '').toLowerCase()}`;
}

async function reconcileActiveConnectionAfterUpdate(profileId, previousActiveServer) {
  if (!previousActiveServer || state.connection !== 'Connected') return;
  const profile = state.profiles.find((item) => item.id === profileId);
  if (!profile) return;
  const replacement = profile.servers.find((server) => serverIdentity(server) === serverIdentity(previousActiveServer));
  if (!replacement) {
    try { await disconnectConnection(); }
    catch (error) { log('error', 'Connection cleanup after subscription update failed', removeSecretsFromError(error)); }
    state.activeServerId = null;
    state.connection = 'Disconnected';
    state.connectionStartedAt = null;
    writeState();
    log('warning', 'Active server disappeared after subscription update', 'The VPN was disconnected for safety');
    return;
  }

  const mode = state.mode;
  state.activeServerId = replacement.id;
  state.connection = 'Disconnected';
  state.connectionStartedAt = null;
  writeState();
  try {
    await stopCoreCompletely();
    await restoreKDEProxy();
    await cleanupTunNetworking();
    await connectCoreForServer(replacement, mode);
    state.connection = 'Connected';
    state.connectionStartedAt = Date.now();
    writeState();
    log('success', `Active connection refreshed on ${replacement.name}`, `${replacement.protocol} · ${replacement.host}`);
  } catch (error) {
    try { await stopCoreCompletely(); } catch {}
    try { await cleanupTunNetworking(); } catch {}
    try { await restoreKDEProxy(); } catch {}
    state.connection = 'Disconnected';
    state.connectionStartedAt = null;
    writeState();
    log('error', 'Active connection refresh failed', removeSecretsFromError(error));
  }
}

async function updateSubscriptionInternal(profileId, { measurePings = false } = {}) {
  const current = state.profiles.find((profile) => profile.id === profileId);
  if (!current) throw new Error('Profile was not found');
  const previousActiveServer = state.connection === 'Connected'
    ? current.servers.find((server) => server.id === state.activeServerId)
    : null;
  let text = current.sourceURL;
  let headers;
  if (/^https?:\/\//i.test(current.sourceURL)) ({ text, headers } = await fetchSubscription(current.sourceURL));
  if (headers?.get('x-hwid-not-supported')?.toLowerCase() === 'true') {
    throw new Error('The subscription provider does not support NixVPN as a client. Use a provider link compatible with Clash/sing-box or ask the provider to enable this app.');
  }
  const servers = parseSubscription(text, current.sourceURL);
  if (!servers.length) throw new Error('No supported servers were found during update');
  const previousServers = new Map(current.servers.map((server) => [serverIdentity(server), server]));
  const normalizedServers = servers.map((server) => {
    const normalized = normalizeServer(server, current.sourceURL);
    const previous = previousServers.get(serverIdentity(normalized));
    return previous && normalized.ping == null
      ? { ...normalized, ping: previous.ping, pingSource: previous.pingSource }
      : normalized;
  });
  const located = await enrichProfileCountries({ ...current, servers: normalizedServers });
  const next = measurePings ? await measureProfilePings(located) : located;
  const latest = state.profiles.find((profile) => profile.id === profileId) || current;
  state.profiles = state.profiles.map((profile) => profile.id === profileId ? {
    ...next,
    name: latest.customName ? latest.name : profileTitle(headers, current.sourceURL),
    customName: Boolean(latest.customName),
    expiresAt: subscriptionExpiry(headers) || current.expiresAt,
    updatedAt: Date.now()
  } : profile);
  writeState();
  log('success', `Updated profile “${current.name}”`, `${servers.length} servers detected`);
  await reconcileActiveConnectionAfterUpdate(profileId, previousActiveServer);
  sendStateChanged();
  return state;
}

function updateSubscription(profileId, options = {}) {
  return serializeConnectionOperation(() => updateSubscriptionInternal(profileId, options));
}

async function checkAllPings() {
  if (pingCheckPromise) return pingCheckPromise;
  pingCheckPromise = (async () => {
    const profiles = [];
    for (const profile of state.profiles) profiles.push(await measureProfilePings(profile));
    state.profiles = profiles;
    writeState();
    const servers = profiles.reduce((total, profile) => total + profile.servers.length, 0);
    log('success', 'Ping check completed', `${servers} servers checked`);
    return state;
  })();
  try { return await pingCheckPromise; }
  finally { pingCheckPromise = null; }
}

function removeSecretsFromError(error) {
  return String(error?.message || error).replace(/(https?:\/\/|vless|vmess|trojan|ss|hy2|hysteria2):\/\/[^\s]+/gi, '$1://[redacted]');
}

function registerIPC() {
  ipcMain.handle('state:get', () => publicState());
  ipcMain.handle('system:setup', async () => {
    try { return await setupNixosIntegration(); }
    catch (error) {
      log('error', 'NixOS integration setup failed', removeSecretsFromError(error));
      throw new Error(removeSecretsFromError(error));
    }
  });
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('clipboard:write', (_event, value) => {
    clipboard.writeText(String(value || ''));
    return true;
  });
  ipcMain.handle('profiles:add', async (_event, sourceURL) => {
    try { await addSubscription(String(sourceURL || '').trim()); return publicState(); }
    catch (error) { log('error', 'Subscription import failed', removeSecretsFromError(error)); throw new Error(removeSecretsFromError(error)); }
  });
  ipcMain.handle('profiles:update', async (_event, profileId) => {
    try { await updateSubscription(profileId); return publicState(); }
    catch (error) { log('error', 'Subscription update failed', removeSecretsFromError(error)); throw new Error(removeSecretsFromError(error)); }
  });
  ipcMain.handle('profiles:rename', (_event, profileId, name) => {
    const profile = state.profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error('Profile was not found');
    const nextName = String(name || '').trim();
    if (!nextName) throw new Error('Profile name cannot be empty');
    if (nextName.length > 80) throw new Error('Profile name must be 80 characters or fewer');
    profile.name = nextName;
    profile.customName = true;
    writeState();
    log('info', `Renamed profile to “${profile.name}”`);
    return publicState();
  });
  ipcMain.handle('profiles:remove', (_event, profileId) => serializeConnectionOperation(async () => {
    const profile = state.profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error('Profile was not found');
    const removesActiveServer = profile.servers.some((server) => server.id === state.activeServerId);
    if (removesActiveServer && state.connection === 'Connected') {
      await disconnectConnection();
    }
    state.profiles = state.profiles.filter((item) => item.id !== profileId);
    if (state.activeServerId && !state.profiles.some((profile) => profile.servers.some((server) => server.id === state.activeServerId))) state.activeServerId = null;
    writeState();
    log('info', 'Profile removed');
    return publicState();
  }));
  ipcMain.handle('servers:ping', async () => {
    try { await checkAllPings(); return publicState(); }
    catch (error) { log('error', 'Ping check failed', removeSecretsFromError(error)); throw new Error(removeSecretsFromError(error)); }
  });
  ipcMain.handle('connection:select-server', (_event, serverId) => serializeConnectionOperation(async () => {
    const server = state.profiles.flatMap((profile) => profile.servers).find((item) => item.id === serverId);
    if (!server) throw new Error('Server was not found');

    if (state.connection === 'Connected' && state.activeServerId !== serverId) {
      if (state.mode !== 'Proxy' && coreProcess?.stdin?.writable) {
        try {
          await switchSupervisedTunServer(server, state.mode);
          state.activeServerId = serverId;
          state.connectionStartedAt = Date.now();
          writeState();
          log('success', `Switched to ${server.name}`, `${server.protocol} · ${server.host}`);
          return publicState();
        } catch (error) {
          try { await stopCoreCompletely(); } catch {}
          try { await cleanupTunNetworking(); } catch {}
          try { await restoreKDEProxy(); } catch {}
          state.activeServerId = serverId;
          state.connection = 'Disconnected';
          state.connectionStartedAt = null;
          writeState();
          log('error', 'Server switch failed', removeSecretsFromError(error));
          sendStateChanged();
          throw new Error(removeSecretsFromError(error));
        }
      }

      try {
        await stopCoreCompletely();
        await restoreKDEProxy();
        await cleanupTunNetworking();
        state.activeServerId = serverId;
        state.connection = 'Disconnected';
        state.connectionStartedAt = null;
        writeState();
        await connectCoreForServer(server, state.mode);
        state.connection = 'Connected';
        state.connectionStartedAt = Date.now();
        writeState();
        log('success', `Switched to ${server.name}`, `${server.protocol} · ${server.host}`);
        return publicState();
      } catch (error) {
        try { await stopCoreCompletely(); } catch {}
        try { await cleanupTunNetworking(); } catch {}
        try { await restoreKDEProxy(); } catch {}
        state.activeServerId = serverId;
        state.connection = 'Disconnected';
        state.connectionStartedAt = null;
        writeState();
        log('error', 'Server switch failed', removeSecretsFromError(error));
        sendStateChanged();
        throw new Error(removeSecretsFromError(error));
      }
    }

    state.activeServerId = serverId;
    writeState();
    return publicState();
  }));
  ipcMain.handle('connection:set-mode', (_event, mode) => serializeConnectionOperation(async () => {
    if (!['Proxy', 'TUN', 'Proxy + TUN'].includes(mode)) throw new Error('Unsupported connection mode');
    if (mode === state.mode) return publicState();

    if (state.connection !== 'Connected' && mode === 'Proxy' && coreProcess?.stdin?.writable) {
      await stopCoreCompletely();
    }

    if (state.connection === 'Connected') {
      return (async () => {
        const server = state.profiles.flatMap((profile) => profile.servers).find((item) => item.id === state.activeServerId);
        if (!server) throw new Error('The active server was not found');

        try {
          await stopCoreCompletely();
          await restoreKDEProxy();
          await cleanupTunNetworking();
          state.mode = mode;
          state.connection = 'Disconnected';
          state.connectionStartedAt = null;
          writeState();
          await connectCoreForServer(server, mode);
          state.connection = 'Connected';
          state.connectionStartedAt = Date.now();
          writeState();
          log('success', `Connection mode changed to ${mode}`, `Reconnected to ${server.name}`);
          return publicState();
        } catch (error) {
          try { await stopCoreCompletely(); } catch {}
          try { await cleanupTunNetworking(); } catch {}
          try { await restoreKDEProxy(); } catch {}
          state.mode = mode;
          state.connection = 'Disconnected';
          state.connectionStartedAt = null;
          writeState();
          log('error', 'Connection mode change failed', removeSecretsFromError(error));
          sendStateChanged();
          throw new Error(removeSecretsFromError(error));
        }
      })();
    }

    state.mode = mode;
    writeState();
    log('info', `Connection mode changed to ${mode}`);
    return publicState();
  }));
  ipcMain.handle('settings:update', (_event, patch) => {
    const next = { ...state.settings, ...(patch || {}) };
    const proxyPort = Number(next.proxyPort);
    const interval = Number(next.updateIntervalHours);
    if (!Number.isInteger(proxyPort) || proxyPort < 1024 || proxyPort > 65535) throw new Error('Proxy port must be between 1024 and 65535');
    if (![1, 6, 12, 24, 168].includes(interval)) throw new Error('Unsupported subscription update interval');
    next.proxyPort = proxyPort;
    next.updateIntervalHours = interval;
    next.autoStart = Boolean(next.autoStart);
    next.autoUpdate = Boolean(next.autoUpdate);
    next.updateOnLaunch = Boolean(next.updateOnLaunch);
    next.autoRecover = Boolean(next.autoRecover);
    next.pingOnLaunch = Boolean(next.pingOnLaunch);
    next.autoPing = Boolean(next.autoPing);
    next.pingIntervalHours = Number(next.pingIntervalHours);
    if (![1, 6, 12, 24, 168].includes(next.pingIntervalHours)) throw new Error('Unsupported ping check interval');
    try { applyAutostart(next.autoStart); }
    catch (error) { log('error', 'Autostart setting failed', error.message); throw new Error(`Could not update autostart: ${error.message}`); }
    state.settings = next;
    writeState();
    scheduleSubscriptionUpdates();
    schedulePingChecks();
    log('info', 'Settings updated');
    return publicState();
  });
  ipcMain.handle('connection:toggle', () => serializeConnectionOperation(async () => {
    if (state.connection === 'Connected') {
      await disconnectConnection();
      return publicState();
    }
    const server = state.profiles.flatMap((profile) => profile.servers).find((item) => item.id === state.activeServerId) || state.profiles[0]?.servers[0];
    if (!server) { log('error', 'Connection failed', 'Add a profile and select a server first'); throw new Error('Add a profile and select a server first'); }
    try {
      if (state.mode === 'TUN') await restoreKDEProxy();
      await connectCoreForServer(server, state.mode);
    } catch (error) {
      log('error', 'Proxy startup failed', removeSecretsFromError(error));
      throw new Error(removeSecretsFromError(error));
    }
    state.activeServerId = server.id;
    state.connection = 'Connected';
    state.connectionStartedAt = Date.now();
    writeState();
    log('success', `Connected to ${server.name}`, `${server.protocol} · ${server.host}`);
    return publicState();
  }));
  ipcMain.handle('logs:clear', () => { state.logs = []; writeState(); return publicState(); });
}

app.whenReady().then(() => {
  app.setName('NixVPN');
  state = readState();
  const wasConnected = state.connection === 'Connected';
  if (wasConnected) {
    state.connection = 'Disconnected';
    state.connectionStartedAt = null;
  }
  writeState();
  restoreKDEProxy().catch(() => {});
  if (wasConnected) cleanupTunNetworking().catch((error) => log('error', 'Stale TUN cleanup failed', error.message));
  try { applyAutostart(state.settings.autoStart); }
  catch (error) { log('error', 'Autostart setup failed', error.message); }
  scheduleSubscriptionUpdates();
  schedulePingChecks();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  registerIPC();
  createWindow();
  if (wasConnected) {
    coreConfigPath = path.join(app.getPath('userData'), 'runtime-config.json');
    coreUsesPrivilege = state.mode !== 'Proxy';
    terminateOrphanedCore()
      .catch((error) => log('error', 'Stale sing-box cleanup failed', error.message))
      .finally(() => { coreConfigPath = null; coreUsesPrivilege = false; });
  }
  refreshSavedServerCountries().catch((error) => log('warning', 'IP geolocation refresh failed', error.message));
});

function gracefulShutdown() {
  if (shutdownPromise) return shutdownPromise;
  quitting = true;
  shutdownPromise = (async () => {
    if (subscriptionTimer) clearInterval(subscriptionTimer);
    if (subscriptionStartupTimer) clearTimeout(subscriptionStartupTimer);
    if (pingTimer) clearInterval(pingTimer);
    if (pingStartupTimer) clearTimeout(pingStartupTimer);
    try { await stopCoreCompletely(); } catch (error) { if (state) log('error', 'Connection shutdown failed', error.message); }
    try { await cleanupTunNetworking(); }
    catch (error) { if (state) log('error', 'TUN cleanup failed', error.message); }
    try { await stopPingCores(); } catch (error) { if (state) log('warning', 'Ping cleanup failed', error.message); }
    try { await restoreKDEProxy(); } catch (error) { if (state) log('error', 'System proxy restore failed', error.message); }
    app.exit(0);
  })();
  return shutdownPromise;
}

process.once('SIGINT', () => { void gracefulShutdown(); });
process.once('SIGTERM', () => { void gracefulShutdown(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', (event) => {
  event.preventDefault();
  void gracefulShutdown();
});
