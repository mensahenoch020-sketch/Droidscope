const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store, hash, clean } = require('./store');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.DROIDSCOPE_ADMIN_PASSWORD || 'change-me-before-production';
const SESSION_SECRET = process.env.DROIDSCOPE_DATA_KEY || crypto.randomBytes(32).toString('hex');
const store = new Store(process.env.DROIDSCOPE_STORAGE_ROOT || ROOT);
const loginAttempts = new Map();

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(x => {
    const i = x.indexOf('='); return [x.slice(0, i).trim(), decodeURIComponent(x.slice(i + 1))];
  }));
}

function signSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 60 * 60_000, nonce: crypto.randomBytes(12).toString('hex') })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function isAdmin(req) {
  const token = parseCookies(req).ds_session;
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now();
  } catch { return false; }
}

function readBody(req, max = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > max) { reject(new Error('too_large')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}

function deviceFrom(req) {
  const value = req.headers.authorization || '';
  if (!value.startsWith('Device ')) return null;
  const [id, secret] = value.slice(7).split(':');
  return store.authDevice(id, secret);
}

function safeDevice(d) {
  const { secretHash, ...safe } = d;
  safe.online = Date.now() - d.lastSeenAt < 120_000;
  return safe;
}

async function api(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const key = req.socket.remoteAddress || 'local';
    const attempt = loginAttempts.get(key) || { count: 0, until: 0 };
    if (attempt.until > Date.now()) return json(res, 429, { error: 'Try again later.' });
    const body = await readBody(req);
    const provided = crypto.scryptSync(String(body.password || ''), 'droidscope-admin', 32);
    const expected = crypto.scryptSync(PASSWORD, 'droidscope-admin', 32);
    if (!crypto.timingSafeEqual(provided, expected)) {
      attempt.count += 1; if (attempt.count >= 5) { attempt.until = Date.now() + 60_000; attempt.count = 0; }
      loginAttempts.set(key, attempt); return json(res, 401, { error: 'Incorrect password.' });
    }
    loginAttempts.delete(key);
    const secure = String(process.env.DROIDSCOPE_PUBLIC_URL || '').startsWith('https://') ? '; Secure' : '';
    return json(res, 200, { ok: true }, { 'set-cookie': `ds_session=${signSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}` });
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    return json(res, 200, { ok: true }, { 'set-cookie': 'ds_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  if (req.method === 'POST' && url.pathname === '/api/agent/enroll') {
    const body = await readBody(req, 50_000);
    const result = store.enroll(body.token, body);
    return result ? json(res, 201, result) : json(res, 400, { error: 'Enrollment link is invalid, expired, or already used.' });
  }

  if (url.pathname.startsWith('/api/agent/')) {
    const device = deviceFrom(req);
    if (!device) return json(res, 401, { error: 'Device authorization failed.' });
    device.lastSeenAt = Date.now();
    if (req.method === 'POST' && url.pathname === '/api/agent/heartbeat') {
      store.event(device.id, 'Device checked in', 'The companion confirmed it is connected.'); store.save(); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/scan') {
      const body = await readBody(req, 100_000); device.scan = { ...body, at: Date.now() };
      store.event(device.id, 'Security scan completed', 'The companion uploaded a new device security assessment.'); store.save(); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/notification') {
      const body = await readBody(req, 100_000);
      store.state.notifications.unshift({ id: crypto.randomUUID(), deviceId: device.id, app: clean(body.app, 120), title: clean(body.title, 200), text: clean(body.text, 1000), at: Date.now() });
      store.state.notifications = store.state.notifications.slice(0, 500);
      store.event(device.id, 'New notification preview', `Received an owner-approved preview from ${clean(body.app, 80) || 'an app'}.`); store.save(); return json(res, 201, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/photo') {
      const body = await readBody(req, 8_000_000);
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(body.data || '')) return json(res, 400, { error: 'Unsupported photo format.' });
      const [meta, encoded] = body.data.split(',', 2); const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length > 5_000_000) return json(res, 413, { error: 'Photo is too large.' });
      const ext = meta.includes('png') ? 'png' : meta.includes('webp') ? 'webp' : 'jpg';
      const id = crypto.randomUUID(); store.writePhoto(id, ext, bytes);
      store.state.photos.unshift({ id, ext, deviceId: device.id, name: clean(body.name, 180) || `Photo.${ext}`, at: Date.now() });
      store.event(device.id, 'Photo shared', 'The owner selected and shared a photo through Android’s system picker.'); store.save(); return json(res, 201, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/apps') {
      const body = await readBody(req, 500_000); const input = Array.isArray(body.apps) ? body.apps.slice(0, 500) : [];
      store.state.apps[device.id] = input.map(app => ({ name: clean(app.name, 120), packageName: clean(app.packageName, 180) })).filter(app => app.packageName);
      store.event(device.id, 'Application audit completed', `The owner shared ${store.state.apps[device.id].length} launchable applications.`); store.save(); return json(res, 200, { ok: true, count: store.state.apps[device.id].length });
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/messages-import') {
      const body = await readBody(req, 2_000_000); const input = Array.isArray(body.messages) ? body.messages.slice(0, 500) : [];
      const imported = input.map(message => ({ id: crypto.randomUUID(), deviceId: device.id, sender: clean(message.sender, 180), text: clean(message.text, 2000), messageAt: Number(message.messageAt) || 0, importedAt: Date.now() })).filter(message => message.text);
      store.state.messages = store.state.messages.filter(x => x.deviceId !== device.id).concat(imported);
      store.event(device.id, 'Message backup imported', `The owner selected and imported ${imported.length} messages.`); store.save(); return json(res, 200, { ok: true, count: imported.length });
    }
    return json(res, 404, { error: 'Not found.' });
  }

  if (!isAdmin(req)) return json(res, 401, { error: 'Sign in required.' });
  if (req.method === 'GET' && url.pathname === '/api/me') return json(res, 200, { authenticated: true });
  if (req.method === 'GET' && url.pathname === '/api/devices') return json(res, 200, { devices: Object.values(store.state.devices).map(safeDevice) });
  if (req.method === 'POST' && url.pathname === '/api/enrollments') return json(res, 201, store.createEnrollment());

  const match = url.pathname.match(/^\/api\/devices\/([^/]+)(?:\/(.*))?$/);
  if (match) {
    const device = store.state.devices[match[1]];
    if (!device) return json(res, 404, { error: 'Device not found.' });
    const action = match[2] || '';
    if (req.method === 'GET' && !action) return json(res, 200, {
      device: safeDevice(device),
      notifications: store.state.notifications.filter(x => x.deviceId === device.id).slice(0, 100),
      photos: store.state.photos.filter(x => x.deviceId === device.id).slice(0, 100),
      messages: store.state.messages.filter(x => x.deviceId === device.id).sort((a,b) => b.messageAt-a.messageAt).slice(0, 500),
      apps: store.state.apps[device.id] || [],
      events: store.state.events.filter(x => x.deviceId === device.id).slice(0, 100)
    });
    if (req.method === 'POST' && action === 'revoke') {
      device.revoked = true; store.event(device.id, 'Access revoked', 'Dashboard access for this companion was revoked.'); store.save(); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && action === 'purge') {
      for (const item of store.state.photos.filter(x => x.deviceId === device.id)) store.deletePhoto(item.id, item.ext);
      store.state.notifications = store.state.notifications.filter(x => x.deviceId !== device.id);
      store.state.photos = store.state.photos.filter(x => x.deviceId !== device.id);
      store.state.messages = store.state.messages.filter(x => x.deviceId !== device.id);
      delete store.state.apps[device.id];
      store.event(device.id, 'Collected data deleted', 'Notification previews, selected photos, imported messages, and application audit data were deleted.'); store.save(); return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && action === 'export') {
      const exportData = { exportedAt: new Date().toISOString(), device: safeDevice(device), notifications: store.state.notifications.filter(x => x.deviceId === device.id), messages: store.state.messages.filter(x => x.deviceId === device.id), apps: store.state.apps[device.id] || [], events: store.state.events.filter(x => x.deviceId === device.id) };
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="droidscope-${device.id}.json"`, 'cache-control': 'no-store' }); return res.end(JSON.stringify(exportData, null, 2));
    }
  }

  const photo = url.pathname.match(/^\/api\/photos\/([a-f0-9-]+)$/);
  if (req.method === 'GET' && photo) {
    const item = store.state.photos.find(x => x.id === photo[1]);
    if (!item) return json(res, 404, { error: 'Photo not found.' });
    res.writeHead(200, { 'content-type': `image/${item.ext === 'jpg' ? 'jpeg' : item.ext}`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    return res.end(store.readPhoto(item.id, item.ext));
  }
  return json(res, 404, { error: 'Not found.' });
}

function staticFile(req, res, url) {
  let relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  relative = path.normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = path.join(PUBLIC, relative);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  const ext = path.extname(file); const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try { if (url.pathname.startsWith('/api/')) await api(req, res, url); else staticFile(req, res, url); }
  catch (error) { if (!res.headersSent) json(res, error.message === 'too_large' ? 413 : 400, { error: 'Request could not be processed.' }); }
});

if (require.main === module) server.listen(PORT, () => console.log(`DroidScope running on http://localhost:${PORT}`));
module.exports = { server };
