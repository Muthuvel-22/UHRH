// hl7Parser.js - HL7 v2.x to FHIR R4 Parser with Clinical Data Enhancement
const { HL7 } = require('hl7-standard');
const { FHIR } = require('fhir-kit-client');
const { ClinicalMapper } = require('./clinicalMapper');
const { QuantumChecksum } = require('./quantumCrypto');
const { AuditLog } = require('./audit');

class HL7Parser {
  constructor() {
    this.hl7 = new HL7();
    this.fhir = new FHIR.Client({ baseUrl: process.env.FHIR_SERVER });
    this.mapper = new ClinicalMapper();
    this.crypto = new QuantumChecksum();
    this.audit = new AuditLog();
    this.messageRegistry = new Map(); // For duplicate detection
  }

  // 1. Core HL7 Message Parsing
  async parse(message, metadata = {}) {
    // Validate message integrity
    const checksum = await this.crypto.verify(message);
    if (!checksum.valid) {
      throw new Error(`Message checksum invalid: ${checksum.error}`);
    }

    // Parse raw HL7
    const hl7Message = this.hl7.parse(message);

    // Check for duplicates
    if (this._isDuplicate(hl7Message)) {
      return { status: 'duplicate', messageId: hl7Message.msh.messageControlId };
    }

    // Convert to FHIR based on message type
    let fhirResources;
    switch (hl7Message.msh.messageType) {
      case 'ADT^A01':
      case 'ADT^A04':
        fhirResources = await this._parseAdt(hl7Message);
        break;
      case 'ORU^R01':
        fhirResources = await this._parseOru(hl7Message);
        break;
      case 'ORM^O01':
        fhirResources = await this._parseOrm(hl7Message);
        break;
      default:
        throw new Error(`Unsupported message type: ${hl7Message.msh.messageType}`);
    }

    // Enhance with clinical context
    const enhancedResources = await this._enhanceResources(fhirResources);

    // Audit the processing
    await this.audit.log('HL7_INGEST', {
      messageId: hl7Message.msh.messageControlId,
      messageType: hl7Message.msh.messageType,
      resourceCount: enhancedResources.length
    });

    return {
      status: 'processed',
      messageId: hl7Message.msh.messageControlId,
      resources: enhancedResources
    };
  }

  // 2. ADT Message Handling (Admit/Register)
  async _parseAdt(hl7Message) {
    const resources = [];
    const patient = this.mapper.mapPidToPatient(hl7Message.pid);
    const encounter = this.mapper.mapPv1ToEncounter(hl7Message.pv1);

    // Link resources
    encounter.subject = { reference: `Patient/${patient.id}` };
    if (hl7Message.pv1.admittingDoctor) {
      encounter.participant = [{
        individual: {
          reference: `Practitioner/${hl7Message.pv1.admittingDoctor.id}`
        }
      }];
    }

    resources.push(patient, encounter);

    // Handle insurance information
    if (hl7Message.in1) {
      const coverage = this.mapper.mapIn1ToCoverage(hl7Message.in1);
      coverage.beneficiary = { reference: `Patient/${patient.id}` };
      resources.push(coverage);
    }

    return resources;
  }

  // 3. ORU Message Handling (Observations)
  async _parseOru(hl7Message) {
    const resources = [];
    const patient = this.mapper.mapPidToPatient(hl7Message.pid);
    resources.push(patient);

    // Process each OBX segment
    for (const obx of hl7Message.obx) {
      const observation = this.mapper.mapObxToObservation(obx);
      observation.subject = { reference: `Patient/${patient.id}` };

      // Link to order if available
      if (hl7Message.orc) {
        observation.basedOn = [{
          reference: `ServiceRequest/${hl7Message.orc.orderControl}`
        }];
      }

      // Add clinical interpretation
      if (obx.interpretationCodes) {
        observation.interpretation = this.mapper.mapInterpretation(obx);
      }

      resources.push(observation);
    }

    return resources;
  }

  // 4. ORM Message Handling (Orders)
  async _parseOrm(hl7Message) {
    const resources = [];
    const patient = this.mapper.mapPidToPatient(hl7Message.pid);
    resources.push(patient);

    // Process ORC segment
    const serviceRequest = this.mapper.mapOrcToServiceRequest(hl7Message.orc);
    serviceRequest.subject = { reference: `Patient/${patient.id}` };

    // Process OBR segment if present
    if (hl7Message.obr) {
      Object.assign(serviceRequest, this.mapper.mapObrToServiceRequest(hl7Message.obr));
    }

    resources.push(serviceRequest);

    // Handle medication orders
    if (hl7Message.rxe) {
      const medicationRequest = this.mapper.mapRxeToMedicationRequest(hl7Message.rxe);
      medicationRequest.subject = { reference: `Patient/${patient.id}` };
      resources.push(medicationRequest);
    }

    return resources;
  }

  // 5. Clinical Data Enhancement
  async _enhanceResources(resources) {
    const enhanced = [];
    
    for (const resource of resources) {
      // Add clinical context to observations
      if (resource.resourceType === 'Observation') {
        const enhancedObs = await this._enhanceObservation(resource);
        enhanced.push(enhancedObs);
      } 
      // Add geocoding to addresses
      else if (resource.resourceType === 'Patient' && resource.address) {
        const enhancedPatient = await this._enhanceAddress(resource);
        enhanced.push(enhancedPatient);
      } else {
        enhanced.push(resource);
      }
    }

    return enhanced;
  }

  async _enhanceObservation(observation) {
    // Add reference ranges based on LOINC code
    if (observation.code?.coding?.[0]?.code) {
      const ranges = await this.mapper.getReferenceRanges(observation.code.coding[0].code);
      if (ranges) {
        observation.referenceRange = ranges;
      }
    }

    // Add risk flags for abnormal values
    if (observation.interpretation) {
      observation.extension = observation.extension || [];
      observation.extension.push({
        url: 'http://uhrh.org/risk-flag',
        valueCodeableConcept: this.mapper.mapRiskLevel(observation)
      });
    }

    return observation;
  }

  async _enhanceAddress(patient) {
    // Geocode addresses using external service
    const geocoded = await Promise.all(
      patient.address.map(async addr => {
        if (addr.line && addr.city && addr.state) {
          const geo = await this.mapper.geocodeAddress(addr);
          return { ...addr, extension: geo };
        }
        return addr;
      })
    );

    return { ...patient, address: geocoded };
  }

  // 6. Duplicate Detection
  _isDuplicate(hl7Message) {
    const messageId = hl7Message.msh.messageControlId;
    if (this.messageRegistry.has(messageId)) {
      return true;
    }

    // Store for 24 hours
    this.messageRegistry.set(messageId, new Date());
    setTimeout(() => this.messageRegistry.delete(messageId), 24 * 60 * 60 * 1000);
    return false;
  }

  // 7. Batch Processing
  async processBatch(messages, options = {}) {
    const results = [];
    const batchSize = options.batchSize || 10;

    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(msg => this.parse(msg, options))
      );
      results.push(...batchResults);

      // Throttle if needed
      if (options.throttle) {
        await new Promise(resolve => setTimeout(resolve, options.throttle));
      }
    }

    return results;
  }

  // 8. FHIR Submission
  async submitToFhir(resources) {
    const bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: resources.map(resource => ({
        resource,
        request: {
          method: resource.id ? 'PUT' : 'POST',
          url: `${resource.resourceType}${resource.id ? `/${resource.id}` : ''}`
        }
      }))
    };

    return this.fhir.transaction({ body: bundle });
  }
}

module.exports = HL7Parser;