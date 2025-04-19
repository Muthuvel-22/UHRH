// aesService.js - Quantum-Resistant AES Encryption Service for Healthcare Data
const crypto = require('crypto');
const { QuantumKeyDerivation } = require('quantum-crypto');
const { AuditLog } = require('./audit');
const { FHIR } = require('fhir-kit-client');

class AesService {
  constructor() {
    this.keyDerivation = new QuantumKeyDerivation();
    this.audit = new AuditLog();
    this.fhir = new FHIR.Client({ baseUrl: process.env.FHIR_SERVER });
    this.keyRegistry = new Map(); // For key lifecycle management
  }

  // 1. Key Management
  async generateKey(metadata = {}) {
    const { keySize = 256, keyType = 'patient-data', ownerId } = metadata;
    
    // Quantum-enhanced key derivation
    const { key, quantumSalt } = await this.keyDerivation.generateKey({
      length: keySize,
      context: `aes-${keyType}-${ownerId || 'system'}`
    });

    // Store key metadata (never the key itself)
    const keyId = crypto.randomUUID();
    this.keyRegistry.set(keyId, {
      keySize,
      keyType,
      ownerId,
      quantumSalt,
      createdAt: new Date(),
      lastUsed: null,
      rotationSchedule: this._getRotationSchedule(keyType)
    });

    await this.audit.log('KEY_GENERATED', {
      keyId,
      keyType,
      ownerId,
      quantumSalt: quantumSalt.toString('hex').slice(0, 8) + '...'
    });

    return { key, keyId };
  }

  async rotateKey(keyId) {
    const keyInfo = this.keyRegistry.get(keyId);
    if (!keyInfo) throw new Error('Key not found');

    // Generate new key while maintaining quantum salt for backward compatibility
    const { key } = await this.keyDerivation.generateKey({
      length: keyInfo.keySize,
      context: `aes-${keyInfo.keyType}-${keyInfo.ownerId || 'system'}`,
      salt: keyInfo.quantumSalt
    });

    // Mark old key for retirement
    this.keyRegistry.set(keyId, {
      ...keyInfo,
      status: 'deprecated',
      deprecatedAt: new Date()
    });

    // Generate new key record
    return this.generateKey({
      keySize: keyInfo.keySize,
      keyType: keyInfo.keyType,
      ownerId: keyInfo.ownerId
    });
  }

  // 2. Encryption Operations
  async encrypt(data, keyId, options = {}) {
    const { key, iv } = await this._prepareKeyAndIV(keyId);
    const { chunkSize = 64, encodeOutput = 'base64' } = options;

    // Validate input
    if (typeof data !== 'string') {
      throw new Error('Data must be a string');
    }

    // Chunk large data for healthcare compliance
    const chunks = this._chunkData(data, chunkSize * 1024);
    const encryptedChunks = [];

    for (const [index, chunk] of chunks.entries()) {
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      
      // Add additional authentication data for healthcare context
      if (options.contextData) {
        cipher.setAAD(Buffer.from(JSON.stringify({
          chunkIndex: index,
          ...options.contextData
        })));
      }

      let encrypted = cipher.update(chunk, 'utf8', encodeOutput);
      encrypted += cipher.final(encodeOutput);
      
      // Include authentication tag
      const tag = cipher.getAuthTag();
      encryptedChunks.push({
        data: encrypted,
        tag: tag.toString(encodeOutput),
        iv: iv.toString('hex'), // IV per chunk for enhanced security
        chunkInfo: { index, total: chunks.length }
      });

      // Generate new IV for next chunk
      iv = crypto.randomBytes(12);
    }

    await this.audit.log('DATA_ENCRYPTED', {
      keyId,
      dataLength: data.length,
      chunks: encryptedChunks.length,
      context: options.contextData || null
    });

    return chunks.length === 1 ? encryptedChunks[0] : encryptedChunks;
  }

  async decrypt(encryptedData, keyId, options = {}) {
    const { key } = await this._prepareKeyAndIV(keyId);
    const { encodeInput = 'base64' } = options;

    // Handle single chunk or multiple chunks
    const chunks = Array.isArray(encryptedData) ? encryptedData : [encryptedData];
    let decrypted = '';

    for (const chunk of chunks) {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm', 
        key, 
        Buffer.from(chunk.iv, 'hex')
      );

      // Set authentication tag
      decipher.setAuthTag(Buffer.from(chunk.tag, encodeInput));

      // Verify additional authentication data if present
      if (options.contextData) {
        decipher.setAAD(Buffer.from(JSON.stringify({
          chunkIndex: chunk.chunkInfo.index,
          ...options.contextData
        })));
      }

      decrypted += decipher.update(chunk.data, encodeInput, 'utf8');
      decrypted += decipher.final('utf8');
    }

    await this.audit.log('DATA_DECRYPTED', {
      keyId,
      dataLength: decrypted.length,
      context: options.contextData || null
    });

    return decrypted;
  }

  // 3. FHIR Resource Protection
  async encryptResource(resourceType, resource, keyId) {
    // Convert FHIR resource to secure JSON
    const resourceStr = JSON.stringify(resource);
    
    // Encrypt with context metadata
    const encrypted = await this.encrypt(resourceStr, keyId, {
      contextData: {
        resourceType,
        fhirVersion: 'R4',
        securityTags: ['PHI', 'CONFIDENTIAL']
      },
      chunkSize: 32 // Smaller chunks for FHIR resources
    });

    // Store encryption metadata in FHIR
    const provenance = await this._createProvenance(
      resourceType,
      resource.id,
      keyId,
      'encrypt'
    );

    return { encrypted, provenance };
  }

  async decryptResource(encryptedData, keyId) {
    // Decrypt with context verification
    const decrypted = await this.decrypt(encryptedData, keyId, {
      contextData: {
        resourceType: encryptedData.resourceType,
        fhirVersion: 'R4'
      }
    });

    return JSON.parse(decrypted);
  }

  // 4. Key Lifecycle Utilities
  async _prepareKeyAndIV(keyId) {
    const keyInfo = this.keyRegistry.get(keyId);
    if (!keyInfo) throw new Error('Invalid key ID');

    // Derive key from quantum parameters
    const key = await this.keyDerivation.deriveKey({
      length: keyInfo.keySize,
      salt: keyInfo.quantumSalt,
      context: `aes-${keyInfo.keyType}-${keyInfo.ownerId || 'system'}`
    });

    // Update key usage
    this.keyRegistry.set(keyId, {
      ...keyInfo,
      lastUsed: new Date()
    });

    // Generate initialization vector
    const iv = crypto.randomBytes(12); // 96 bits for GCM

    return { key, iv };
  }

  _getRotationSchedule(keyType) {
    const schedules = {
      'patient-data': '30d',      // Rotate every 30 days
      'system-master': '1y',      // Rotate annually
      'audit-logs': '90d',        // Rotate quarterly
      'phi-temporary': '24h'      // Ephemeral keys
    };
    return schedules[keyType] || '30d';
  }

  // 5. Data Chunking Utilities
  _chunkData(data, chunkSize) {
    const chunks = [];
    for (let i = 0; i < data.length; i += chunkSize) {
      chunks.push(data.substring(i, i + chunkSize));
    }
    return chunks;
  }

  // 6. FHIR Provenance Tracking
  async _createProvenance(resourceType, resourceId, keyId, action) {
    const provenance = {
      resourceType: 'Provenance',
      target: [{ reference: `${resourceType}/${resourceId}` }],
      recorded: new Date().toISOString(),
      activity: {
        coding: [{
          system: 'http://hl7.org/fhir/security-activity-type',
          code: action === 'encrypt' ? 'ENCRYPT' : 'DECRYPT'
        }]
      },
      signature: [{
        type: [{
          system: 'http://hl7.org/fhir/valueset-signature-type',
          code: '1.2.840.10065.1.12.1.1' // Author's signature
        }],
        when: new Date().toISOString(),
        who: { reference: `Device/${process.env.SYSTEM_DEVICE_ID}` },
        data: await this._generateDigitalSignature(keyId, action)
      }]
    };

    return this.fhir.create({ resourceType: 'Provenance', body: provenance });
  }

  async _generateDigitalSignature(keyId, action) {
    const keyInfo = this.keyRegistry.get(keyId);
    const signData = `${keyId}:${action}:${new Date().toISOString()}`;
    
    // Use quantum-resistant signing
    return this.keyDerivation.sign(
      signData, 
      keyInfo.quantumSalt
    );
  }
}

module.exports = AesService;