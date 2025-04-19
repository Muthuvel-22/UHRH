// helpers.js
const fhir = require('fhir-r4');
const { validate } = require('./validators.js');
const { log } = require('./logger.js');

class UHRHHelpers {
  // FHIR Resource Normalization
  static async normalizeToFHIR(data, sourceType) {
    const conversionMap = {
      'HL7v2': this._hl7ToFHIR,
      'IoT': this._iotToFHIR,
      'EHR': this._ehrToFHIR
    };

    if (!conversionMap[sourceType]) {
      throw new Error(`Unsupported source type: ${sourceType}`);
    }

    const fhirResource = await conversionMap[sourceType](data);
    return await validate(fhirResource, 'PATIENT'); // Auto-validation
  }

  // Clinical Data Transformation
  static _hl7ToFHIR(hl7Data) {
    const parser = new fhir.HL7v2Parser();
    const bundle = parser.parse(hl7Data);
    
    // Transform to UHRH-specific profiles
    return bundle.entry.map(entry => ({
      ...entry.resource,
      meta: {
        profile: [
          'http://uhhr.org/fhir/StructureDefinition/uhhr-encounter'
        ]
      }
    }));
  }

  // IoT Payload Processing
  static _iotToFHIR(iotData) {
    const observationTemplate = {
      resourceType: 'Observation',
      status: 'final',
      code: {
        coding: [{
          system: 'http://loinc.org',
          code: this._getLoincCode(iotData.deviceType)
        }]
      },
      valueQuantity: {
        value: iotData.value,
        unit: iotData.unit
      }
    };
    return observationTemplate;
  }

  // Consent Management Shortcuts
  static async checkConsent(patientId, purpose) {
    const consent = await blockchainService.queryConsent(patientId);
    return consent.purposes.includes(purpose);
  }

  // Risk Score Formatter
  static formatRiskScore(score, modelType) {
    const thresholds = {
      'CKD': [0.3, 0.7],
      'Diabetes': [0.4, 0.8]
    };
    
    const [low, high] = thresholds[modelType];
    return {
      value: score,
      interpretation: score >= high ? 'High' : score >= low ? 'Medium' : 'Low',
      lastUpdated: new Date().toISOString()
    };
  }

  // Private Utilities
  static _getLoincCode(deviceType) {
    const deviceMap = {
      'glucometer': '2339-0',
      'blood_pressure': '55284-4',
      'weight_scale': '29463-7'
    };
    return deviceMap[deviceType] || '29463-7'; // Default to weight
  }

  static _ehrToFHIR(ehrData) {
    // Normalize proprietary EHR formats
    return fhir.FHIRWrapper.wrap(ehrData);
  }
}

// Zero-Trust Security Wrapper
module.exports = new Proxy(UHRHHelpers, {
  get(target, prop) {
    if (typeof target[prop] === 'function') {
      return async (...args) => {
        // Verify JWT for all helper methods
        const token = args.pop();
        if (!aesService.js.verifyToken(token)) {
          await log('UNAUTHORIZED_HELPER_ACCESS', 
            { method: prop }, 'ALERT');
          throw new Error('ZT policy violation: Invalid access token');
        }
        return target[prop](...args);
      };
    }
    return target[prop];
  }
});