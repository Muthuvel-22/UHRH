// validators.js
const { Validator } = require('fhir-validator-engine');
const quantumSafe = require('./aesService.js');

class UHRHValidators {
  constructor() {
    this.fhirValidator = new Validator({
      fhirVersion: 'R4',
      clinicalSafety: true
    });

    this.schemaRegistry = {
      PATIENT: 'http://uhhr.org/fhir/StructureDefinition/uhhr-patient',
      CONSENT: 'http://hl7.org/fhir/StructureDefinition/Consent'
    };
  }

  // FHIR Resource Validation
  async validateFHIR(resource, profileType) {
    const profile = this.schemaRegistry[profileType];
    const result = await this.fhirValidator.validate(resource, profile);

    if (!result.valid) {
      throw new Error(`FHIR Validation Failed: ${result.errors.join(', ')}`);
    }
    return quantumSafe.encrypt(resource); // Auto-encrypt on validation
  }

  // Cross-Component Data Integrity Check
  static verifyDataSignature(data, digitalId) {
    const key = keyManagement.js.getPublicKey(digitalId);
    return crypto.verify(
      'SHA384',
      Buffer.from(data),
      key,
      Buffer.from(signature, 'base64')
    );
  }

  // IoT Payload Sanitization
  sanitizeIoTPayload(payload) {
    const schema = Joi.object({
      deviceId: Joi.string().pattern(/^urn:uhhr:iot:[a-z0-9-]+$/),
      observations: Joi.array().items(
        Joi.object({
          timestamp: Joi.date().iso().required(),
          value: Joi.number().required()
        })
      ).min(1)
    });

    return schema.validateAsync(payload);
  }
}

// Zero-Trust Policy Enforcement
module.exports = new Proxy(new UHRHValidators(), {
  get(target, prop) {
    if (typeof target[prop] === 'function') {
      return (...args) => {
        if (!aesService.js.verifyAuthToken(args.authToken)) {
          throw new Error('Validation request rejected: Invalid ZT token');
        }
        return target[prop](...args);
      };
    }
    return target[prop];
  }
});