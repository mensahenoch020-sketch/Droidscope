const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class Store {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'data', 'state.json');
    this.uploads = path.join(root, 'uploads');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.mkdirSync(this.uploads, { recursive: true });
    this.state = { devices: {}, enrollments: {}, notifications: [], photos: [], messages: [], apps: {}, events: [] };
    if (fs.existsSync(this.file)) {
      try { this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch { /* start clean */ }
    }
  }

  save() {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  createEnrollment() {
    const token = crypto.randomBytes(18).toString('base64url');
    const record = { tokenHash: hash(token), createdAt: Date.now(), expiresAt: Date.now() + 15 * 60_000, used: false };
    this.state.enrollments[record.tokenHash] = record;
    this.save();
    return { token, expiresAt: record.expiresAt };
  }

  enroll(token, details) {
    const tokenHash = hash(token || '');
    const record = this.state.enrollments[tokenHash];
    if (!record || record.used || record.expiresAt < Date.now()) return null;
    record.used = true;
    const id = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString('base64url');
    this.state.devices[id] = {
      id,
      name: clean(details.name, 80) || 'Android device',
      model: clean(details.model, 100),
      manufacturer: clean(details.manufacturer, 80),
      androidVersion: clean(details.androidVersion, 40),
      sdk: Number(details.sdk) || 0,
      secretHash: hash(secret),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      revoked: false,
      scan: null
    };
    this.event(id, 'Device enrolled', 'The Android companion completed owner-approved pairing.');
    this.save();
    return { deviceId: id, deviceSecret: secret };
  }

  authDevice(id, secret) {
    const device = this.state.devices[id];
    if (!device || device.revoked) return null;
    const a = Buffer.from(device.secretHash);
    const b = Buffer.from(hash(secret || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? device : null;
  }

  event(deviceId, type, detail) {
    this.state.events.unshift({ id: crypto.randomUUID(), deviceId, type: clean(type, 100), detail: clean(detail, 500), at: Date.now() });
    this.state.events = this.state.events.slice(0, 1000);
  }
}

function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function clean(value, max) { return String(value || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }

module.exports = { Store, hash, clean };
