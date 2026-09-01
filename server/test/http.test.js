const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('dashboard login, enrollment, and device data flow', async t => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'droidscope-http-'));
  const port = 32000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, PORT: String(port), DROIDSCOPE_ADMIN_PASSWORD: 'test-password', DROIDSCOPE_DATA_KEY: 'test-key-with-more-than-thirty-two-characters', DROIDSCOPE_STORAGE_ROOT: storage },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => { child.kill('SIGTERM'); fs.rmSync(storage, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 3000);
    child.stdout.on('data', data => { if (String(data).includes('DroidScope running')) { clearTimeout(timer); resolve(); } });
    child.on('error', reject);
  });

  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const enrollmentResponse = await fetch(`${base}/api/enrollments`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(enrollmentResponse.status, 201);
  const enrollment = await enrollmentResponse.json();
  const enrollResponse = await fetch(`${base}/api/agent/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: enrollment.token, name: 'Test Android', model: 'Emulator' }) });
  assert.equal(enrollResponse.status, 201);
  const deviceAuth = await enrollResponse.json();
  const notification = await fetch(`${base}/api/agent/notification`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Device ${deviceAuth.deviceId}:${deviceAuth.deviceSecret}` }, body: JSON.stringify({ app: 'Messages', title: 'Test sender', text: 'Owner-approved preview' }) });
  assert.equal(notification.status, 201);
  const apps = await fetch(`${base}/api/agent/apps`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Device ${deviceAuth.deviceId}:${deviceAuth.deviceSecret}` }, body: JSON.stringify({ apps: [{ name: 'Camera', packageName: 'android.camera' }] }) });
  assert.equal(apps.status, 200);
  const messages = await fetch(`${base}/api/agent/messages-import`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Device ${deviceAuth.deviceId}:${deviceAuth.deviceSecret}` }, body: JSON.stringify({ messages: [{ sender: 'Test', text: 'Imported with owner approval', messageAt: 123 }] }) });
  assert.equal(messages.status, 200);
  const detail = await fetch(`${base}/api/devices/${deviceAuth.deviceId}`, { headers: { cookie } });
  const detailBody = await detail.json();
  assert.equal(detailBody.device.name, 'Test Android');
  assert.equal(detailBody.notifications[0].text, 'Owner-approved preview');
  assert.equal(detailBody.apps[0].packageName, 'android.camera');
  assert.equal(detailBody.messages[0].text, 'Imported with owner approval');
  const exported = await fetch(`${base}/api/devices/${deviceAuth.deviceId}/export`, { headers: { cookie } });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  const purge = await fetch(`${base}/api/devices/${deviceAuth.deviceId}/purge`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(purge.status, 200);
});
