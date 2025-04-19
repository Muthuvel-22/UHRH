// keyManagement.js

import crypto from 'crypto';

export class KeyManagementService {
  constructor() {
    this.keys = {}; // In-memory key store (replace with DB in production)
  }

  async initialize() {
    // Simulate loading initial keys (could be from a DB)
    this.keys['default'] = this.generateKey();
    console.log('Key Management Service initialized.');
  }

  generateKey() {
    // Generates a 256-bit key (32 bytes hex)
    return crypto.randomBytes(32).toString('hex');
  }

  async rotateKey(oldKeyId) {
    const newKeyId = `key-${Date.now()}`;
    const newKey = this.generateKey();

    this.keys[newKeyId] = newKey;

    // Optionally remove the old key
    if (oldKeyId && this.keys[oldKeyId]) {
      delete this.keys[oldKeyId];
    }

    console.log(`Key rotated: ${oldKeyId} ➝ ${newKeyId}`);
    return { keyId: newKeyId, key: newKey };
  }

  getKey(keyId) {
    return this.keys[keyId];
  }
}
