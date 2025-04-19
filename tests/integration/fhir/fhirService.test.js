// fhirService.test.js
const nock = require('nock');
const fhirService = require('../../../services/fhir/fhirService');

describe('FHIR Service - Integration Tests', () => {
  const fhirBaseUrl = 'https://fhir.testserver.com';

  beforeEach(() => {
    // Set base URL for the FHIR service if needed
    process.env.FHIR_BASE_URL = fhirBaseUrl;
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('getPatientById', () => {
    it('should fetch a FHIR patient by ID', async () => {
      const patientId = '1234';
      const mockResponse = {
        resourceType: 'Patient',
        id: patientId,
        name: [{ given: ['John'], family: 'Doe' }],
        gender: 'male',
      };

      nock(fhirBaseUrl)
        .get(`/Patient/${patientId}`)
        .reply(200, mockResponse);

      const result = await fhirService.getPatientById(patientId);
      expect(result).toBeDefined();
      expect(result.id).toBe(patientId);
      expect(result.name[0].family).toBe('Doe');
    });

    it('should throw an error if patient not found', async () => {
      const patientId = 'nonexistent';

      nock(fhirBaseUrl)
        .get(`/Patient/${patientId}`)
        .reply(404, {
          issue: [{ severity: 'error', diagnostics: 'Not found' }],
        });

      await expect(fhirService.getPatientById(patientId)).rejects.toThrow('FHIR API error');
    });
  });

  describe('createObservation', () => {
    it('should post a new FHIR Observation', async () => {
      const mockObservation = {
        resourceType: 'Observation',
        status: 'final',
        code: {
          coding: [
            {
              system: 'http://loinc.org',
              code: '718-7',
              display: 'Hemoglobin [Mass/volume] in Blood',
            },
          ],
        },
        valueQuantity: {
          value: 13.2,
          unit: 'g/dL',
        },
        subject: {
          reference: 'Patient/1234',
        },
      };

      nock(fhirBaseUrl)
        .post('/Observation', body => body.resourceType === 'Observation')
        .reply(201, {
          id: 'obs123',
          ...mockObservation,
        });

      const result = await fhirService.createObservation(mockObservation);
      expect(result.id).toBe('obs123');
      expect(result.resourceType).toBe('Observation');
    });
  });
});
