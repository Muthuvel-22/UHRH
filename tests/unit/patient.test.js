// patient.test.js
const patientController = require('../../controllers/patientController');
const Patient = require('../../models/Patient');

jest.mock('../../models/Patient');

describe('Patient Controller - Unit Tests', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getPatientById', () => {
    it('should return patient data when ID is valid', async () => {
      const mockPatient = {
        _id: '123456',
        name: 'John Doe',
        age: 40,
        gender: 'Male',
      };
      const req = { params: { id: '123456' } };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      Patient.findById.mockResolvedValue(mockPatient);

      await patientController.getPatientById(req, res);

      expect(Patient.findById).toHaveBeenCalledWith('123456');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(mockPatient);
    });

    it('should return 404 when patient is not found', async () => {
      const req = { params: { id: 'nonexistent' } };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      Patient.findById.mockResolvedValue(null);

      await patientController.getPatientById(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ message: 'Patient not found' });
    });

    it('should return 500 on internal server error', async () => {
      const req = { params: { id: '123456' } };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      Patient.findById.mockRejectedValue(new Error('DB error'));

      await patientController.getPatientById(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: 'Internal server error' });
    });
  });

  describe('createPatient', () => {
    it('should create a new patient successfully', async () => {
      const req = {
        body: {
          name: 'Alice Smith',
          age: 32,
          gender: 'Female',
        },
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      const savedPatient = { _id: 'newID', ...req.body };
      Patient.create.mockResolvedValue(savedPatient);

      await patientController.createPatient(req, res);

      expect(Patient.create).toHaveBeenCalledWith(req.body);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(savedPatient);
    });
  });
});
    