// keyManagement.js - Quantum-Secure Key Management Service for Healthcare
const { QuantumKeyVault } = require('quantum-crypto');
const { FHIR } = require('fhir-kit-client');
const { AuditLog } = require('./audit');
const crypto = require('crypto');
const { Blockchain } = require('./blockchain');

class KeyManagementService {
  constructor() {
    this.keyVault = new QuantumKeyVault({
      endpoint: process.env.QUANTUM_KEY_VAULT_URL,
      apiKey: process.env.QUANTUM_KEY_API_KEY
    });
    this.fhir = new FHIR.Client({ baseUrl: process.env.FHIR_SERVER });
    this.audit = new AuditLog();
    this.blockchain = new Blockchain('key-management');
    this.keyCache = new Map(); // Short-term cache for active keys
  }

  // 1. Key Lifecycle Management
  async generateKey(params) {
    const { 
      keyType = 'data-encryption',
      ownerId, 
      ownerType = 'Patient',
      keySize = 256,
      rotationPolicy = 'default'
    } = params;

    // Generate quantum-seeded key material
    const keyMaterial = await this.keyVault.generateKeyMaterial({
      length: keySize,
      context: `${ownerType}/${ownerId || 'system'}/${keyType}`
    });

    // Create key metadata structure
    const keyMeta = {
      keyId: crypto.randomUUID(),
      keyType,
      owner: ownerId ? { reference: `${ownerType}/${ownerId}` } : null,
      publicKey: keyMaterial.publicKey,
      quantumFingerprint: keyMaterial.quantumFingerprint,
      generatedAt: new Date().toISOString(),
      rotationPolicy: this._getRotationPolicy(rotationPolicy, keyType),
      status: 'active',
      usage: [],
      securityTags: this._getSecurityTags(keyType)
    };

    // Store in blockchain for non-repudiation
    const tx = await this.blockchain.submitKeyGeneration(keyMeta);

    // Cache the private key temporarily (never stored persistently)
    this.keyCache.set(keyMeta.keyId, {
      privateKey: keyMaterial.privateKey,
      expiresAt: Date.now() + (5 * 60 * 1000) // 5 minute cache
    });

    await this.audit.log('KEY_GENERATED', {
      keyId: keyMeta.keyId,
      keyType,
      owner: keyMeta.owner,
      txHash: tx.hash
    });

    return {
      keyId: keyMeta.keyId,
      publicKey: keyMeta.publicKey,
      meta: await this._storeKeyMetadata(keyMeta)
    };
  }

  async rotateKey(keyId) {
    const oldKey = await this._getKeyMetadata(keyId);
    if (!oldKey) throw new Error('Key not found');

    // Generate new key with same parameters
    const newKey = await this.generateKey({
      keyType: oldKey.keyType,
      ownerId: oldKey.owner?.reference?.split('/')[1],
      ownerType: oldKey.owner?.reference?.split('/')[0],
      keySize: oldKey.publicKey.length * 8, // Convert bytes to bits
      rotationPolicy: oldKey.rotationPolicy.name
    });

    // Mark old key as retired
    await this._updateKeyMetadata(keyId, {
      status: 'retired',
      retiredAt: new Date().toISOString(),
      replacedBy: { reference: `Key/${newKey.keyId}` }
    });

    // Create FHIR Provenance for key rotation
    await this._createKeyProvenance(
      oldKey,
      newKey,
      'key-rotation',
      `Key rotated per policy ${oldKey.rotationPolicy.name}`
    );

    return newKey;
  }

  async revokeKey(keyId, reason = 'security-incident') {
    const keyMeta = await this._getKeyMetadata(keyId);
    
    // Update key status
    await this._updateKeyMetadata(keyId, {
      status: 'revoked',
      revokedAt: new Date().toISOString(),
      revocationReason: reason
    });

    // Add to blockchain revocation list
    await this.blockchain.revokeKey(keyId, reason);

    // Clear from cache if present
    this.keyCache.delete(keyId);

    await this.audit.log('KEY_REVOKED', {
      keyId,
      reason,
      owner: keyMeta.owner
    });

    return true;
  }

  // 2. Key Retrieval & Usage
  async getPublicKey(keyId) {
    const keyMeta = await this._getKeyMetadata(keyId);
    if (!keyMeta) throw new Error('Key not found');
    
    if (['revoked', 'retired'].includes(keyMeta.status)) {
      throw new Error(`Key status is ${keyMeta.status}`);
    }

    return {
      keyId: keyMeta.keyId,
      publicKey: keyMeta.publicKey,
      meta: keyMeta
    };
  }

  async getPrivateKey(keyId) {
    // Check cache first
    if (this.keyCache.has(keyId)) {
      const cached = this.keyCache.get(keyId);
      if (Date.now() < cached.expiresAt) {
        return cached.privateKey;
      }
      this.keyCache.delete(keyId);
    }

    // Retrieve from quantum vault with MFA
    const keyMeta = await this._getKeyMetadata(keyId);
    if (!keyMeta) throw new Error('Key not found');

    if (['revoked', 'retired'].includes(keyMeta.status)) {
      throw new Error(`Cannot use ${keyMeta.status} key`);
    }

    const privateKey = await this.keyVault.retrievePrivateKey({
      keyId,
      quantumFingerprint: keyMeta.quantumFingerprint,
      mfaToken: await this._generateMfaToken(keyId)
    });

    // Re-cache with short TTL
    this.keyCache.set(keyId, {
      privateKey,
      expiresAt: Date.now() + (3 * 60 * 1000) // 3 minutes
    });

    return privateKey;
  }

  // 3. Policy Management
  async defineRotationPolicy(policy) {
    const { name, description, rules } = policy;
    
    // Validate rules
    if (!rules.maxLifetime && !rules.usageLimit) {
      throw new Error('Policy must have maxLifetime or usageLimit');
    }

    // Store in FHIR as PlanDefinition
    const planDefinition = {
      resourceType: 'PlanDefinition',
      status: 'active',
      title: `Key Rotation Policy: ${name}`,
      type: {
        coding: [{
          system: 'http://hl7.org/fhir/key-management',
          code: 'key-rotation-policy'
        }]
      },
      action: [{
        title: 'Rotate Key',
        trigger: rules.maxLifetime ? [{
          type: 'periodic',
          timing: {
            repeat: {
              duration: rules.maxLifetime,
              durationUnit: 'd'
            }
          }
        }] : [],
        condition: rules.usageLimit ? [{
          kind: 'applicability',
          expression: {
            description: `Usage exceeds ${rules.usageLimit} operations`,
            language: 'text/fhirpath',
            expression: `Key.usage.count() > ${rules.usageLimit}`
          }
        }] : []
      }]
    };

    const result = await this.fhir.create({ resourceType: 'PlanDefinition', body: planDefinition });
    
    await this.audit.log('POLICY_DEFINED', {
      policy: name,
      version: result.meta.versionId
    });

    return result;
  }

  // 4. Compliance Monitoring
  async checkKeyCompliance(keyId) {
    const keyMeta = await this._getKeyMetadata(keyId);
    const issues = [];

    // Check rotation policy
    if (keyMeta.rotationPolicy.maxLifetime) {
      const generatedDate = new Date(keyMeta.generatedAt);
      const lifetimeDays = (Date.now() - generatedDate) / (1000 * 60 * 60 * 24);
      
      if (lifetimeDays > keyMeta.rotationPolicy.maxLifetime) {
        issues.push({
          severity: 'error',
          code: 'rotation-overdue',
          details: `Key exceeded max lifetime of ${keyMeta.rotationPolicy.maxLifetime} days`
        });
      }
    }

    // Check usage limits
    if (keyMeta.rotationPolicy.usageLimit && 
        keyMeta.usage.length >= keyMeta.rotationPolicy.usageLimit) {
      issues.push({
        severity: 'error',
        code: 'usage-exceeded',
        details: `Key exceeded usage limit of ${keyMeta.rotationPolicy.usageLimit} operations`
      });
    }

    // Check revocation status on blockchain
    const blockchainStatus = await this.blockchain.checkKeyStatus(keyId);
    if (blockchainStatus.revoked) {
      issues.push({
        severity: 'critical',
        code: 'blockchain-revoked',
        details: `Key revoked on blockchain: ${blockchainStatus.revocationReason}`
      });
    }

    return {
      keyId,
      status: issues.length ? 'non-compliant' : 'compliant',
      issues
    };
  }

  // 5. Emergency Procedures
  async emergencyKeyOverride(keyId, justification) {
    // Verify emergency credentials
    if (!await this._verifyEmergencyAccess(justification)) {
      throw new Error('Emergency access denied');
    }

    // Retrieve key bypassing normal checks
    const privateKey = await this.keyVault.emergencyRetrieve({
      keyId,
      justificationHash: crypto.createHash('sha256').update(justification).digest('hex')
    });

    // Create emergency audit trail
    await this.audit.logEmergencyAccess({
      keyId,
      action: 'emergency-retrieve',
      justification,
      accessedBy: 'emergency-user' // Would be actual user in production
    });

    // Create blockchain record
    await this.blockchain.recordEmergencyAccess(keyId, justification);

    return privateKey;
  }

  // ========== PRIVATE METHODS ========== //
  async _storeKeyMetadata(keyMeta) {
    // Store as FHIR Device resource
    const device = {
      resourceType: 'Device',
      identifier: [{
        system: 'urn:ietf:rfc:3986',
        value: keyMeta.keyId
      }],
      type: {
        coding: [{
          system: 'http://hl7.org/fhir/key-types',
          code: keyMeta.keyType
        }]
      },
      owner: keyMeta.owner,
      meta: {
        tag: keyMeta.securityTags
      },
      extension: [{
        url: 'http://hl7.org/fhir/key-metadata',
        extension: [
          { url: 'quantumFingerprint', valueString: keyMeta.quantumFingerprint },
          { url: 'rotationPolicy', valueString: keyMeta.rotationPolicy.name },
          { url: 'publicKey', valueString: keyMeta.publicKey.toString('base64') }
        ]
      }]
    };

    const result = await this.fhir.create({ resourceType: 'Device', body: device });
    return result;
  }

  async _getKeyMetadata(keyId) {
    const result = await this.fhir.search({
      resourceType: 'Device',
      params: { identifier: keyId }
    });

    if (!result.entry || !result.entry.length) return null;

    const device = result.entry[0].resource;
    return this._parseKeyMetadata(device);
  }

  async _updateKeyMetadata(keyId, updates) {
    const current = await this._getKeyMetadata(keyId);
    if (!current) throw new Error('Key not found');

    const device = {
      resourceType: 'Device',
      id: current.deviceId,
      meta: {
        tag: updates.securityTags || current.securityTags
      },
      extension: current.extensions.map(ext => {
        if (ext.url === 'http://hl7.org/fhir/key-metadata') {
          return {
            ...ext,
            extension: ext.extension.map(item => {
              if (item.url === 'status' && updates.status) {
                return { ...item, valueString: updates.status };
              }
              return item;
            })
          };
        }
        return ext;
      })
    };

    if (updates.status === 'retired') {
      device.extension.push({
        url: 'http://hl7.org/fhir/key-retirement',
        extension: [
          { url: 'retiredAt', valueDateTime: updates.retiredAt },
          { url: 'replacedBy', valueReference: updates.replacedBy }
        ]
      });
    }

    return this.fhir.update(device);
  }

  _parseKeyMetadata(device) {
    const keyExt = device.extension?.find(e => 
      e.url === 'http://hl7.org/fhir/key-metadata'
    );

    return {
      deviceId: device.id,
      keyId: device.identifier[0].value,
      keyType: device.type.coding[0].code,
      owner: device.owner,
      publicKey: Buffer.from(
        keyExt.extension.find(e => e.url === 'publicKey').valueString, 
        'base64'
      ),
      quantumFingerprint: keyExt.extension.find(e => e.url === 'quantumFingerprint').valueString,
      rotationPolicy: this._getRotationPolicy(
        keyExt.extension.find(e => e.url === 'rotationPolicy').valueString
      ),
      securityTags: device.meta.tag,
      status: keyExt.extension.find(e => e.url === 'status')?.valueString || 'active'
    };
  }

  _getRotationPolicy(name, keyType) {
    const policies = {
      'default': { name: 'default', maxLifetime: 90, usageLimit: 1000 },
      'strict': { name: 'strict', maxLifetime: 30, usageLimit: 500 },
      'long-term': { name: 'long-term', maxLifetime: 365, usageLimit: null },
      'ephemeral': { name: 'ephemeral', maxLifetime: 1, usageLimit: 10 }
    };

    return policies[name] || this._getDefaultPolicy(keyType);
  }

  _getDefaultPolicy(keyType) {
    switch(keyType) {
      case 'data-encryption': return { name: 'default', maxLifetime: 90, usageLimit: 1000 };
      case 'authentication': return { name: 'strict', maxLifetime: 30, usageLimit: 500 };
      case 'audit-log': return { name: 'long-term', maxLifetime: 365, usageLimit: null };
      default: return { name: 'default', maxLifetime: 90, usageLimit: 1000 };
    }
  }

  _getSecurityTags(keyType) {
    const tags = {
      'data-encryption': [
        { system: 'http://hl7.org/fhir/security-tags', code: 'CONFIDENTIAL' }
      ],
      'authentication': [
        { system: 'http://hl7.org/fhir/security-tags', code: 'AUTHENTICATION' }
      ],
      'audit-log': [
        { system: 'http://hl7.org/fhir/security-tags', code: 'INTEGRITY' }
      ]
    };
    return tags[keyType] || tags['data-encryption'];
  }

  async _generateMfaToken(keyId) {
    // In production: Generate OTP or use hardware token
    return crypto.randomBytes(16).toString('hex');
  }

  async _verifyEmergencyAccess(justification) {
    // In production: Verify hardware token + biometrics
    return justification.length > 20; // Simple mock
  }

  async _createKeyProvenance(oldKey, newKey, activity, reason) {
    const provenance = {
      resourceType: 'Provenance',
      target: [
        { reference: `Device/${oldKey.deviceId}` },
        { reference: `Device/${newKey.meta.id}` }
      ],
      recorded: new Date().toISOString(),
      activity: {
        coding: [{
          system: 'http://hl7.org/fhir/key-management-activity',
          code: activity
        }]
      },
      reason: [{
        text: reason
      }],
      signature: [{
        type: [{
          system: 'http://hl7.org/fhir/valueset-signature-type',
          code: '1.2.840.10065.1.12.1.5' // Verification signature
        }],
        who: { 
          reference: `Device/${process.env.SYSTEM_DEVICE_ID}`,
          display: 'Key Management Service'
        },
        data: await this._signProvenance(oldKey, newKey, activity)
      }]
    };

    return this.fhir.create({ resourceType: 'Provenance', body: provenance });
  }

  async _signProvenance(oldKey, newKey, activity) {
    const signData = `${oldKey.keyId}|${newKey.keyId}|${activity}|${Date.now()}`;
    return this.keyVault.sign({
      data: signData,
      keyId: process.env.SYSTEM_SIGNING_KEY
    });
  }
}

module.exports = KeyManagementService;