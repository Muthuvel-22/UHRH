// auth.test.js
const auth = require('./authService.js');
const helpers = require('./helpers.js');
const { log } = require('./logger.js');
const faker = require('faker');

// Mock blockchain consent for testing
jest.mock('./blockchainService.js', () => ({
  verifyConsent: jest.fn().mockResolvedValue(true)
}));

// Quantum AES mock
jest.mock('./aesService.js', () => ({
  generateQKDKeys: jest.fn().mockReturnValue({
    publicKey: 'quantum_pub_xyz',
    privateKey: 'quantum_priv_xyz'
  }),
  encrypt: jest.fn().mockImplementation(text => `encrypted_${text}`)
}));

describe('UHRH Authentication Service', () => {
  let testToken;

  beforeAll(async () => {
    // Generate test token with clinical roles
    testToken = await auth.issueToken({
      userId: 'dr.smith@uhhr.org',
      roles: ['clinician', 'fhir_writer'],
      department: 'nephrology'
    });
  });

  describe('Zero-Trust Token Verification', () => {
    test('Rejects tokens without quantum signatures', async () => {
      const malformedToken = testToken.replace(/\.\w+$/, '.invalidSig');
      await expect(auth.verifyToken(malformedToken))
        .rejects
        .toThrow('Quantum signature verification failed');
    });

    test('Logs invalid token attempts', async () => {
      const spy = jest.spyOn(log, 'log');
      await auth.verifyToken('garbage_token');
      expect(spy).toHaveBeenCalledWith(
        'INVALID_TOKEN_ATTEMPT',
        expect.objectContaining({
          clientIP: expect.any(String)
        }),
        'ALERT'
      );
    });
  });

  describe('FHIR API Access Control', () => {
    test('Grants access to Patient compartment with valid consent', async () => {
      const ctx = {
        token: testToken,
        resourceType: 'Patient',
        patientId: 'fhir-patient-123'
      };
      await expect(auth.checkFhirAccess(ctx))
        .resolves
        .toBeTruthy();
    });

    test('Blocks unauthorized Observation writes', async () => {
      const nonWriterToken = await auth.issueToken({
        roles: ['clinician'] // Missing fhir_writer role
      });
      
      await expect(auth.checkFhirAccess({
        token: nonWriterToken,
        resourceType: 'Observation',
        action: 'write'
      })).rejects.toThrow('FHIR_ACCESS_DENIED');
    });
  });

  describe('Clinical Context Binding', () => {
    test('Embeds department in resource metadata', async () => {
      const resource = await auth.bindClinicalContext(
        testToken,
        { resourceType: 'DiagnosticReport' }
      );
      expect(resource.meta.extension).toContainEqual({
        url: 'http://uhhr.org/fhir/StructureDefinition/department',
        valueCode: 'nephrology'
      });
    });

    test('Auto-encounters sensitive fields', () => {
      const result = auth.applyFieldLevelSecurity(
        testToken,
        { 
          ssn: '123-45-6789',
          conditions: ['Hypertension'] 
        }
      );
      expect(result.ssn).toMatch(/^encrypted_/);
      expect(result.conditions).toEqual(['Hypertension']);
    });
  });

  describe('Stress Testing', () => {
    const concurrentRequests = 100;
    test(`Handles ${concurrentRequests} concurrent auth checks`, async () => {
      const requests = Array(concurrentRequests).fill().map(
        () => auth.verifyToken(testToken)
      );
      await expect(Promise.all(requests))
        .resolves
        .toHaveLength(concurrentRequests);
    }, 10000); // Extended timeout
  });
});

// FHIR Access Control Matrix
const FHIR_ACCESS_MATRIX = {
  clinician: {
    Patient: ['read', 'write'],
    Observation: ['read']
  },
  fhir_writer: {
    Observation: ['write'],
    DiagnosticReport: ['write']
  }
};

// Mock data generators
function generateMockPatient() {
  return {
    resourceType: 'Patient',
    name: [{ given: [faker.name.firstName()], family: faker.name.lastName() }],
    telecom: [{ system: 'email', value: faker.internet.email() }]
  };
}   