const FHIR = require('fhir-kit-client');
const AuditLog = require('./audit');
const { QuantumPredictor } = require('./quantumPredictor');

class Patient {
  constructor(fhirBaseUrl, patientId) {
    this.fhirClient = new FHIR.Client({
      baseUrl: fhirBaseUrl,
      auth: { token: process.env.FHIR_TOKEN }
    });
    this.patientId = patientId;
    this.predictor = new QuantumPredictor();
    this.audit = new AuditLog();
  }

  // 1. FHIR Data Operations
  async getDemographics() {
    this.audit.log('GET', `/Patient/${this.patientId}`);
    return await this.fhirClient.read({
      resourceType: 'Patient',
      id: this.patientId
    });
  }

  async updateRecord(updates) {
    this.audit.log('PATCH', `/Patient/${this.patientId}`);
    return await this.fhirClient.patch({
      resourceType: 'Patient',
      id: this.patientId,
      body: updates
    });
  }

  // 2. Predictive Health Analytics
  async getDiseaseRisk(diseaseType) {
    const observations = await this.fhirClient.search({
      resourceType: 'Observation',
      params: { patient: this.patientId, code: getClinicalCodes(diseaseType) }
    });
    
    const riskScore = await this.predictor.calculateRisk(
      diseaseType, 
      observations
    );
    
    this.audit.log('PREDICT', `${diseaseType}_risk`);
    return { disease: diseaseType, risk: riskScore };
  }

  // 3. Real-Time Monitoring
  async startECGStream(callback) {
    const ws = new WebSocket(`wss://api.uhrh.com/ecg?patient=${this.patientId}`);
    ws.onmessage = (event) => {
      callback(JSON.parse(event.data));
    };
    return () => ws.close();
  }

  // 4. Security & Consent
  async grantDataAccess(recipientId, scope) {
    const consent = {
      resourceType: 'Consent',
      patient: { reference: `Patient/${this.patientId}` },
      performer: [{ reference: `Practitioner/${recipientId}` }],
      scope: this._validateScope(scope)
    };
    return await this.fhirClient.create(consent);
  }

  _validateScope(scope) {
    const allowedScopes = ['read', 'write', 'predict'];
    if (!allowedScopes.includes(scope)) throw new Error('Invalid scope');
    return scope;
  }
}

// Helper Functions
function getClinicalCodes(diseaseType) {
  const codeMap = {
    'CKD': 'http://loinc.org|48643-1',
    'Diabetes': 'http://loinc.org|2339-0',
    'Hypertension': 'http://loinc.org|55284-4'
  };
  return codeMap[diseaseType] || '';
}

module.exports = Patient;