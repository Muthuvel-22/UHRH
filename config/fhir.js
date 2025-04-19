const { Client } = require('fhir-kit-client');
const { validate } = require('fhir').Fhir;
const logger = require('../utils/logger');
const { encryptPHI } = require('../services/encryption/phiService');

class FHIRService {
  constructor() {
    this.client = new Client({
      baseUrl: process.env.FHIR_SERVER_URL || 'http://localhost:8080/fhir',
      customHeaders: {
        'Authorization': `Bearer ${process.env.FHIR_ACCESS_TOKEN}`,
        'Accept': 'application/fhir+json; fhirVersion=4.0',
        'Content-Type': 'application/fhir+json; charset=UTF-8'
      },
      requestOptions: {
        timeout: 10000, // 10-second timeout
        strictSSL: true
      }
    });

    this.supportedProfiles = {
      patient: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient',
      observation: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-observation-lab'
    };
  }

  /**
   * Validate and store a FHIR resource with PHI protection
   * @param {Object} resource - FHIR resource
   * @param {string} profile - FHIR profile URI
   * @returns {Promise<Object>} - Stored resource
   */
  async createResource(resource, profile = null) {
    try {
      // 1. Validate resource structure
      const validation = validate(resource, { profile });
      if (!validation.valid) {
        throw new Error(`FHIR validation failed: ${validation.messages.join(', ')}`);
      }

      // 2. Encrypt PHI fields
      const securedResource = this._protectPHI(resource);

      // 3. Store to FHIR server
      const response = await this.client.create({
        resourceType: securedResource.resourceType,
        body: securedResource
      });

      logger.info(`FHIR resource created: ${response.resourceType}/${response.id}`);
      return response;
    } catch (err) {
      logger.error(`FHIR create failed: ${err.message}`, {
        resourceType: resource?.resourceType,
        error: err.stack
      });
      throw new FHIRServerError(err.message);
    }
  }

  /**
   * Search FHIR resources with clinical context
   * @param {Object} params - Search parameters
   * @param {string} resourceType - FHIR resource type
   * @returns {Promise<Bundle>} - FHIR Bundle
   */
  async searchResources(params, resourceType = 'Patient') {
    const safeParams = this._sanitizeSearchParams(params);
    
    try {
      const bundle = await this.client.search({
        resourceType,
        params: safeParams,
        headers: { 'Prefer': 'handling=strict' }
      });

      // Decrypt PHI in results
      return bundle.entry?.map(entry => 
        this._unprotectPHI(entry.resource)
      ) || [];
    } catch (err) {
      logger.error(`FHIR search failed: ${err.message}`, {
        params: this._maskPHIParams(safeParams),
        error: err.stack
      });
      throw new FHIRServerError('Search operation failed');
    }
  }

  // --- Protected Methods --- //

  _protectPHI(resource) {
    const phiPaths = {
      Patient: ['name', 'telecom', 'address', 'birthDate', 'identifier'],
      Observation: ['subject.reference', 'performer.reference']
    };

    const resourceType = resource.resourceType;
    const paths = phiPaths[resourceType] || [];
    
    return paths.reduce((obj, path) => {
      const parts = path.split('.');
      let current = obj;
      
      for (let i = 0; i < parts.length - 1; i++) {
        if (!current[parts[i]]) break;
        current = current[parts[i]];
      }

      const last = parts[parts.length - 1];
      if (current[last]) {
        if (Array.isArray(current[last])) {
          current[last] = current[last].map(item => 
            typeof item === 'string' ? encryptPHI(item) : item
          );
        } else {
          current[last] = encryptPHI(current[last]);
        }
      }

      return obj;
    }, JSON.parse(JSON.stringify(resource)));
  }

  _unprotectPHI(resource) {
    // Implementation similar to _protectPHI but decrypting
    // ... (omitted for brevity)
  }

  _sanitizeSearchParams(params) {
    const allowedParams = {
      Patient: ['name', 'birthdate', 'identifier'],
      Observation: ['code', 'date', 'patient']
    };

    const resourceType = params.resourceType || 'Patient';
    const safeParams = {};
    
    Object.keys(params).forEach(key => {
      if (allowedParams[resourceType]?.includes(key)) {
        safeParams[key] = params[key];
      }
    });

    return safeParams;
  }

  _maskPHIParams(params) {
    const masked = { ...params };
    if (masked.identifier) masked.identifier = '***REDACTED***';
    if (masked.patient) masked.patient = '***REDACTED***';
    return masked;
  }
}

class FHIRServerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FHIRServerError';
    this.isOperational = true;
    this.httpStatus = 502; // Bad Gateway
  }
}

module.exports = {
  FHIRService,
  FHIRServerError
};