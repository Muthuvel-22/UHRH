import crypto from 'crypto';

export class AesService {
  constructor() {
    this.algorithm = 'aes-256-cbc';
    this.ivLength = 16;
  }

  async decryptResource(resource, keyId) {
    // Placeholder: simulate decryption
    const decrypted = { ...resource, decryptedWithKey: keyId };
    return decrypted;
  }

  encrypt(text, key) {
    const iv = crypto.randomBytes(this.ivLength);
    const cipher = crypto.createCipheriv(this.algorithm, Buffer.from(key, 'hex'), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return { iv: iv.toString('hex'), encryptedData: encrypted };
  }

  decrypt(encryptedData, key, iv) {
    const decipher = crypto.createDecipheriv(
      this.algorithm,
      Buffer.from(key, 'hex'),
      Buffer.from(iv, 'hex')
    );
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}
