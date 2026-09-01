const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class Store {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'data', 'state.json');
    this.uploads = path.join(root, 'uploads');
    this.key = crypto.createHash('sha256').update(process.env.DROIDSCOPE_DATA_KEY || 'development-only-change-me').digest();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.mkdirSync(this.uploads, { recursive: true });
    this.state = { devices: {}, enrollments: {}, notifications: [], photos: [], messages: [], apps: {}, events: [] };
    if (fs.existsSync(this.file)) {
      const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const decoded = stored.format === 'droidscope-encrypted-v1' ? JSON.parse(this.decryptEnvelope(stored).toString('utf8')) : stored;
      this.state = { ...this.state, ...decoded };
    }
  }

  save() {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.encryptEnvelope(Buffer.from(JSON.stringify(this.state)))), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  encryptEnvelope(bytes) {
    const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return { format: 'droidscope-encrypted-v1', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }

  decryptEnvelope(envelope) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  }

  writePhoto(id, ext, bytes) { fs.writeFileSync(path.join(this.uploads, `${id}.${ext}.enc`), JSON.stringify(this.encryptEnvelope(bytes)), { mode: 0o600 }); }
  readPhoto(id, ext) { return this.decryptEnvelope(JSON.parse(fs.readFileSync(path.join(this.uploads, `${id}.${ext}.enc`), 'utf8'))); }
  deletePhoto(id, ext) { try { fs.unlinkSync(path.join(this.uploads, `${id}.${ext}.enc`)); } catch {} }

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
