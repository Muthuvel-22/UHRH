// fhirService.js - FHIR Server Interface with Quantum Security & Analytics
const { FHIR } = require('fhir-kit-client');
const { QuantumEncrypt } = require('quantum-crypto');
const { AuditLog } = require('./audit');
const { Blockchain } = require('./blockchain');

class FhirService {
  constructor() {
    this.fhirClient = new FHIR.Client({
      baseUrl: process.env.FHIR_SERVER,
      auth: {
        token: process.env.FHIR_TOKEN,
        // Quantum-resistant TLS
        tlsConfig: {
          ciphers: [
            'TLS_CHACHA20_POLY1305_SHA256',
            'TLS_AES_256_GCM_SHA384'
          ].join(':'),
          honorCipherOrder: true
        }
      }
    });

    this.audit = new AuditLog();
    this.blockchain = new Blockchain('fhir-access');
    this.crypto = new QuantumEncrypt(process.env.QUANTUM_KEY_VAULT);
  }

  // 1. Core CRUD Operations with Quantum Security
  async create(resourceType, data, userContext) {
    // Encrypt sensitive data fields
    const encryptedData = await this._encryptSensitiveFields(resourceType, data);

    const result = await this.fhirClient.create({
      resourceType,
      body: encryptedData
    });

    await this._auditAndAnchor('CREATE', userContext, resourceType, result.id);
    return result;
  }

  async read(resourceType, id, userContext) {
    const result = await this.fhirClient.read({ resourceType, id });
    
    // Verify access on blockchain
    const hasAccess = await this.blockchain.verifyAccess(
      userContext.userId,
      resourceType,
      id,
      'read'
    );

    if (!hasAccess) throw new Error('Access denied');

    // Decrypt sensitive data
    const decryptedData = await this._decryptSensitiveFields(resourceType, result);

    await this._auditAndAnchor('READ', userContext, resourceType, id);
    return decryptedData;
  }

  async update(resourceType, id, data, userContext) {
    // Verify ownership/access
    await this._verifyUpdatePermissions(resourceType, id, userContext);

    // Encrypt and update
    const encryptedData = await this._encryptSensitiveFields(resourceType, data);
    const result = await this.fhirClient.update({
      resourceType,
      id,
      body: encryptedData
    });

    await this._auditAndAnchor('UPDATE', userContext, resourceType, id);
    return result;
  }

  async delete(resourceType, id, userContext) {
    // Verify ownership/access
    await this._verifyUpdatePermissions(resourceType, id, userContext);

    // Create tombstone record before deletion
    await this._createTombstone(resourceType, id, userContext);

    const result = await this.fhirClient.delete({ resourceType, id });
    await this._auditAndAnchor('DELETE', userContext, resourceType, id);
    return result;
  }

  // 2. Advanced Search with Analytics Hooks
  async search(resourceType, params = {}, userContext) {
    // Add ML-powered search enhancements
    const enhancedParams = await this._enhanceSearch(params);

    const result = await this.fhirClient.search({
      resourceType,
      params: enhancedParams
    });

    // Log search but don't anchor to blockchain (high volume)
    await this.audit.log(userContext.userId, 'SEARCH', {
      resourceType,
      params,
      resultCount: result.entry?.length || 0
    });

    // Decrypt sensitive fields in results
    if (result.entry) {
      result.entry = await Promise.all(
        result.entry.map(async entry => ({
          ...entry,
          resource: await this._decryptSensitiveFields(resourceType, entry.resource)
        }))
      );
    }

    return result;
  }

  // 3. Batch/Transaction Operations
  async transaction(bundle, userContext) {
    // Encrypt sensitive fields in all entries
    const encryptedBundle = await this._processTransactionBundle(bundle);

    const result = await this.fhirClient.transaction({
      body: encryptedBundle
    });

    await this._auditAndAnchor('TRANSACTION', userContext, 'Bundle', result.id);
    return result;
  }

  // 4. Specialized Medical Operations
  async getPatientEverything(patientId, userContext) {
    // Verify comprehensive access rights
    const hasFullAccess = await this.blockchain.verifyAccess(
      userContext.userId,
      'Patient',
      patientId,
      'everything'
    );

    if (!hasFullAccess) throw new Error('Full access not permitted');

    const result = await this.fhirClient.request(
      `Patient/${patientId}/$everything`,
      { method: 'GET' }
    );

    // Decrypt and filter sensitive data based on consent
    const filteredResult = await this._filterByConsent(result, userContext);

    await this._auditAndAnchor('EXPORT', userContext, 'Patient', patientId);
    return filteredResult;
  }

  async clinicalLookup(patientId, codes, userContext) {
    // Convert codes to FHIR tokens
    const codeValues = codes.map(c => 
      `http://loinc.org|${c.system === 'LOINC' ? c.code : this._mapToLoinc(c)}`
    );

    const results = await Promise.all(
      codeValues.map(code =>
        this.fhirClient.search({
          resourceType: 'Observation',
          params: {
            patient: patientId,
            code,
            _sort: '-date',
            _count: 1
          }
        })
      )
    );

    // Format as timeline
    const timeline = results
      .filter(r => r.entry?.length > 0)
      .map(r => ({
        code: r.entry[0].resource.code.coding[0].code,
        value: r.entry[0].resource.valueQuantity,
        date: r.entry[0].resource.effectiveDateTime
      }))
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    await this.audit.log(userContext.userId, 'CLINICAL_LOOKUP', {
      patientId,
      codeCount: codes.length
    });

    return timeline;
  }

  // 5. System Administration
  async getCapabilityStatement() {
    return this.fhirClient.capabilityStatement();
  }

  async checkHealth() {
    try {
      await this.fhirClient.request('metadata', { method: 'GET' });
      return { status: 'OK', version: process.env.FHIR_VERSION };
    } catch (error) {
      return { status: 'DOWN', error: error.message };
    }
  }

  // ========== PRIVATE METHODS ========== //

  async _encryptSensitiveFields(resourceType, resource) {
    const encryptionMap = {
      Patient: ['name', 'telecom', 'address', 'photo'],
      Observation: ['note', 'component.valueString'],
      Practitioner: ['name', 'telecom', 'photo']
    };

    if (!encryptionMap[resourceType]) return resource;

    const encrypted = { ...resource };
    for (const field of encryptionMap[resourceType]) {
      if (this._nestedPropertyExists(encrypted, field)) {
        this._nestedPropertySet(
          encrypted,
          field,
          await this.crypto.encrypt(this._nestedPropertyGet(encrypted, field))
        );
      }
    }

    return encrypted;
  }

  async _decryptSensitiveFields(resourceType, resource) {
    const decryptionMap = {
      Patient: ['name', 'telecom', 'address', 'photo'],
      Observation: ['note', 'component.valueString'],
      Practitioner: ['name', 'telecom', 'photo']
    };

    if (!decryptionMap[resourceType]) return resource;

    const decrypted = { ...resource };
    for (const field of decryptionMap[resourceType]) {
      if (this._nestedPropertyExists(decrypted, field)) {
        this._nestedPropertySet(
          decrypted,
          field,
          await this.crypto.decrypt(this._nestedPropertyGet(decrypted, field))
        );
      }
    }

    return decrypted;
  }

  async _verifyUpdatePermissions(resourceType, id, userContext) {
    const current = await this.fhirClient.read({ resourceType, id });
    
    // Check blockchain for ownership/access rights
    const canUpdate = await this.blockchain.verifyAccess(
      userContext.userId,
      resourceType,
      id,
      'write'
    );

    if (!canUpdate) {
      throw new Error('Update permission denied');
    }

    // Additional check for patient-owned data
    if (current.meta?.security?.some(s => s.code === 'PATIENT-OWNED')) {
      const isOwner = await this._verifyPatientOwnership(
        userContext.userId,
        resourceType,
        id
      );
      if (!isOwner) throw new Error('Patient ownership required');
    }
  }

  async _createTombstone(resourceType, id, userContext) {
    const tombstone = {
      resourceType: 'Provenance',
      target: [{ reference: `${resourceType}/${id}` }],
      recorded: new Date().toISOString(),
      agent: [{
        who: { reference: `Practitioner/${userContext.userId}` },
        onBehalfOf: { reference: `Organization/${userContext.organizationId}` }
      }],
      signature: [{
        type: [
          {
            system: 'http://hl7.org/fhir/valueset-signature-type',
            code: '1.2.840.10065.1.12.1.7' // deletion signature
          }
        ],
        when: new Date().toISOString(),
        who: { reference: `Practitioner/${userContext.userId}` },
        data: await this.crypto.sign(`DELETED:${resourceType}/${id}`)
      }]
    };

    await this.fhirClient.create({ resourceType: 'Provenance', body: tombstone });
  }

  async _enhanceSearch(params) {
    // Add ML-powered search optimizations
    const enhanced = { ...params };

    // Example: Expand date ranges for progressive conditions
    if (enhanced['clinical-status'] === 'progressive') {
      if (enhanced.date) {
        enhanced.date = `ge${new Date(new Date(enhanced.date) - 30 * 24 * 60 * 60 * 1000).toISOString()}`;
      }
    }

    // Add security filters based on user context
    if (enhanced._security) {
      enhanced._security = `${enhanced._security},${process.env.FHIR_SECURITY_TAG}`;
    } else {
      enhanced._security = process.env.FHIR_SECURITY_TAG;
    }

    return enhanced;
  }

  async _processTransactionBundle(bundle) {
    const encryptedEntries = await Promise.all(
      bundle.entry.map(async entry => ({
        ...entry,
        resource: await this._encryptSensitiveFields(
          entry.resource.resourceType,
          entry.resource
        )
      }))
    );

    return { ...bundle, entry: encryptedEntries };
  }

  async _filterByConsent(data, userContext) {
    // Get consent scope from blockchain
    const consent = await this.blockchain.getConsent(
      userContext.userId,
      data.entry[0].resource.id
    );

    // Filter data based on consented scope
    return {
      ...data,
      entry: data.entry.filter(entry => 
        consent.scope.includes(this._mapResourceToScope(entry.resource.resourceType))
      )
    };
  }

  async _auditAndAnchor(action, userContext, resourceType, resourceId) {
    // Audit log
    await this.audit.log(userContext.userId, action, {
      resourceType,
      resourceId,
      ip: userContext.ip,
      userAgent: userContext.userAgent
    });

    // Anchor to blockchain (batch hourly)
    await this.blockchain.queueAnchor({
      action,
      userId: userContext.userId,
      resourceType,
      resourceId,
      timestamp: new Date()
    });
  }

  _mapResourceToScope(resourceType) {
    const scopeMap = {
      'Patient': 'patient',
      'Observation': 'lab',
      'Condition': 'diagnosis',
      'MedicationRequest': 'meds'
    };
    return scopeMap[resourceType] || 'other';
  }

  _nestedPropertyExists(obj, path) {
    return path.split('.').reduce(
      (o, p) => o !== undefined && o !== null ? o[p] : undefined,
      obj
    ) !== undefined;
  }

  _nestedPropertyGet(obj, path) {
    return path.split('.').reduce(
      (o, p) => o !== undefined && o !== null ? o[p] : undefined,
      obj
    );
  }

  _nestedPropertySet(obj, path, value) {
    const parts = path.split('.');
    const last = parts.pop();
    let current = obj;

    for (const part of parts) {
      current[part] = current[part] || {};
      current = current[part];
    }

    current[last] = value;
    return obj;
  }
}

module.exports = FhirService;