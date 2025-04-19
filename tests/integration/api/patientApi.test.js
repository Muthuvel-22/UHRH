// patientApi.test.js
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../../server'); // assuming this exports the Express app
const Patient = require('../../../models/Patient');

describe('Patient API Integration Tests', () => {
  let server;

  beforeAll(async () => {
    server = app.listen(4000); // bind to a test port
    await mongoose.connect(process.env.TEST_DB_URI || 'mongodb://localhost:27017/uhri_test', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
  });

  afterAll(async () => {
    await mongoose.connection.db.dropDatabase();
    await mongoose.connection.close();
    server.close();
  });

  afterEach(async () => {
    await Patient.deleteMany({});
  });

  describe('POST /api/v1/patients', () => {
    it('should create a new patient', async () => {
      const res = await request(app)
        .post('/api/v1/patients')
        .send({
          name: 'Alice Johnson',
          age: 28,
          gender: 'Female',
          contact: 'alice@example.com',
        });

      expect(res.statusCode).toBe(201);
      expect(res.body).toHaveProperty('_id');
      expect(res.body.name).toBe('Alice Johnson');
    });

    it('should return 400 for invalid data', async () => {
      const res = await request(app).post('/api/v1/patients').send({});

      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty('message');
    });
  });

  describe('GET /api/v1/patients/:id', () => {
    it('should return patient data for valid ID', async () => {
      const newPatient = new Patient({
        name: 'Test Patient',
        age: 45,
        gender: 'Male',
      });
      await newPatient.save();

      const res = await request(app).get(`/api/v1/patients/${newPatient._id}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.name).toBe('Test Patient');
    });

    it('should return 404 if patient not found', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app).get(`/api/v1/patients/${fakeId}`);

      expect(res.statusCode).toBe(404);
      expect(res.body.message).toBe('Patient not found');
    });
  });
});

