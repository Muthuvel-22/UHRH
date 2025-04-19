import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import FHIR from 'fhir-kit-client';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';

import { Blockchain } from './blockchain.js';
import { AesService } from './aesService.js';
import { KeyManagementService } from './keyManagement.js';
import { ClinicalPredictor } from './clinicalPredictor.js';
import { AuditLog } from './audit.js';

import authRoutes from './routes/auth.js';

dotenv.config();

// Initialize services
const app = express();
const fhirClient = new FHIR({
  baseUrl: process.env.FHIR_SERVER_URL,
  auth: { token: process.env.FHIR_TOKEN }
});
const blockchain = new Blockchain(process.env.BLOCKCHAIN_NETWORK);
const aesService = new AesService();
const keyManager = new KeyManagementService();
const predictor = new ClinicalPredictor();
const audit = new AuditLog();

// Middleware
app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests'
});
app.use(limiter);

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  ssl: true, // required for AWS DocumentDB
  serverSelectionTimeoutMS: 10000
}).then(() => {
  console.log("Connected to MongoDB");
}).catch((err) => {
  console.error("MongoDB connection error:", err);
});


// Auth Routes
app.use('/api', authRoutes);

// Dummy Login (for demo/testing)
app.post('/api/login', async (req, res) => {
  const { email, password, role } = req.body;

  const users = [
    { role: 'Admin', email: 'krithikkrishna2304@gmail.com', password: '@Krithik_2304' },
    { role: 'Doctor', email: 'mageji007@gmail.com', password: '@Mahesh23' },
    { role: 'Patient', email: 'mohammedfardin.ds.ai@gmail.com', password: '@Fardin204' }
  ];

  const user = users.find(
    (u) => u.email === email && u.password === password && u.role === role
  );

  if (!user) return res.status(401).json({ message: 'Invalid credentials or role' });

  const dummyToken = 'token-' + Date.now();

  res.status(200).json({
    message: 'Login successful',
    token: dummyToken,
    role: user.role,
    email: user.email
  });
});

// Patient Access Endpoint
app.get('/api/patient/:id', async (req, res) => {
  try {
    const hasAccess = await blockchain.verifyAccess(
      req.headers['x-user-id'],
      'Patient',
      req.params.id,
      'read'
    );
    if (!hasAccess) return res.status(403).json({ error: 'Access denied' });

    const patient = await fhirClient.read({
      resourceType: 'Patient',
      id: req.params.id
    });
    const decrypted = await aesService.decryptResource(patient, req.headers['x-key-id']);

    await audit.log(req.headers['x-user-id'], 'PATIENT_ACCESS', {
      resourceId: req.params.id,
      ip: req.ip
    });

    res.json(decrypted);
  } catch (err) {
    handleError(res, err);
  }
});

// CKD Prediction Endpoint
app.post('/api/predict/ckd', async (req, res) => {
  try {
    const { patientId, horizon = '6m' } = req.body;

    const canPredict = await blockchain.verifyAccess(
      req.headers['x-practitioner-id'],
      'Patient',
      patientId,
      'predict'
    );
    if (!canPredict) return res.status(403).json({ error: 'Prediction not authorized' });

    const prediction = await predictor.predictCKD(patientId, horizon);

    res.json({
      riskScore: prediction.riskScore,
      riskCategory: prediction.riskCategory,
      keyFactors: prediction.keyFactors
    });
  } catch (err) {
    handleError(res, err);
  }
});

// Key Rotation Endpoint
app.post('/admin/keys/rotate', async (req, res) => {
  try {
    if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { keyId } = req.body;
    const newKey = await keyManager.rotateKey(keyId);

    res.json({
      newKeyId: newKey.keyId,
      status: 'rotated'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// Error Handler
function handleError(res, err) {
  console.error(err);

  if (err.response?.data?.issue) {
    return res.status(400).json({
      error: 'FHIR Operation Failed',
      details: err.response.data.issue
    });
  }

  const statusCode = err.message.includes('Access denied') ? 403 :
                     err.message.includes('not found') ? 404 : 500;

  res.status(statusCode).json({ error: err.message || 'Internal Server Error' });
}

// Startup Bootstrapping
(async () => {
  try {
    await keyManager.initialize();
    await predictor.loadModels();

    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
      console.log(`UHRH Server running on port ${PORT}`);
      console.log(`Connected to FHIR: ${process.env.FHIR_SERVER_URL}`);
    });
    
  } catch (err) {
    console.error('Fatal startup error:', err);
    process.exit(1);
  }
})();

export default app;
