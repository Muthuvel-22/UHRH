// predictive.routes.js - Quantum Clinical Prediction API
const express = require('express');
const router = express.Router();
const { FHIR } = require('fhir-kit-client');
const { ClinicalPredictor } = require('../services/predictive');
const { Blockchain } = require('../blockchain');
const { AuditLog } = require('../audit');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

// Initialize services
const predictor = new ClinicalPredictor();
const fhirClient = new FHIR.Client({ baseUrl: process.env.FHIR_SERVER });
const blockchain = new Blockchain('predictive-models');
const audit = new AuditLog();

// Middleware for clinician verification
async function verifyClinician(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const roles = decoded.extension?.find(e => e.url === 'http://uhrh.org/roles')?.valueCodeableConcept?.coding || [];
    
    if (!roles.some(r => r.code === 'clinician')) {
      return res.status(403).json({ error: 'Clinical access required' });
    }

    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// 1. Individual Patient Prediction
router.post('/patient/:id/predict', verifyClinician, async (req, res) => {
  const { condition, horizon = '6m' } = req.query;

  try {
    // Verify access consent
    const hasAccess = await blockchain.verifyConsent({
      practitionerId: req.user.userId,
      patientId: req.params.id,
      action: 'predict'
    });

    if (!hasAccess) {
      return res.status(403).json({ error: 'Prediction consent required' });
    }

    // Get prediction
    const prediction = await predictor.predictRisk(
      req.params.id, 
      condition,
      horizon
    );

    // Audit prediction
    await audit.log(req.user.userId, 'PREDICTION', {
      patientId: req.params.id,
      condition,
      score: prediction.finalRiskScore,
      model: prediction.modelVersion
    });

    res.json({
      ...prediction,
      explanation: generateExplanation(prediction, condition)
    });
  } catch (error) {
    res.status(500).json({ error: 'Prediction failed' });
  }
});

// 2. Population Health Analytics
router.post('/cohort/predict', verifyClinician, async (req, res) => {
  const { condition, criteria, horizon = '1y' } = req.body;

  try {
    // Convert FHIR search criteria to patient list
    const cohort = await fhirClient.search({
      resourceType: 'Patient',
      params: criteria
    });

    if (!cohort.entry || cohort.entry.length === 0) {
      return res.status(404).json({ error: 'No patients match criteria' });
    }

    // Batch predictions
    const results = await Promise.all(
      cohort.entry.slice(0, 100).map(async (patient) => {
        const prediction = await predictor.predictRisk(
          patient.resource.id, 
          condition,
          horizon
        );
        return {
          patientId: patient.resource.id,
          risk: prediction.finalRiskScore,
          category: prediction.riskCategory
        };
      })
    );

    // Generate analytics
    const analytics = analyzeCohort(results);

    res.json({
      condition,
      patientCount: results.length,
      averageRisk: analytics.averageRisk,
      highRiskPatients: analytics.highRiskPatients,
      distribution: analytics.riskDistribution
    });
  } catch (error) {
    res.status(500).json({ error: 'Cohort analysis failed' });
  }
});

// 3. Model Training Endpoints
router.post('/models/train', async (req, res) => {
  const { apiKey } = req.query;
  if (apiKey !== process.env.MODEL_TRAIN_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  try {
    // Federated training step
    const update = await predictor.trainFederatedModel();

    // Submit to blockchain
    const tx = await blockchain.submitModelUpdate({
      modelId: 'ckd-predictor-v3',
      updateHash: update.modelHash,
      metrics: update.metrics,
      hospitals: update.contributors
    });

    res.json({
      txHash: tx.hash,
      accuracy: update.metrics.accuracy,
      rocAuc: update.metrics.rocAuc
    });
  } catch (error) {
    res.status(500).json({ error: 'Model training failed' });
  }
});

// 4. Real-Time Prediction WebSocket
router.ws('/patient/:id/live', async (ws, req) => {
  const token = req.query.token;
  const patientId = req.params.id;

  try {
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const hasAccess = await blockchain.verifyConsent({
      practitionerId: decoded.userId,
      patientId,
      action: 'monitor'
    });

    if (!hasAccess) {
      return ws.close(1008, 'Consent required');
    }

    // Set up subscriptions
    const subscriptions = [
      subscribeToVitals(patientId, async (data) => {
        const prediction = await predictor.predictFromStream(data);
        ws.send(JSON.stringify({
          type: 'risk-update',
          condition: 'deterioration',
          score: prediction.score,
          indicators: prediction.indicators
        }));
      }),
      subscribeToAlerts(patientId, (alert) => {
        ws.send(JSON.stringify({
          type: 'alert',
          level: alert.level,
          message: alert.message
        }));
      })
    ];

    ws.on('close', () => {
      subscriptions.forEach(unsub => unsub());
    });

  } catch (error) {
    ws.close(1008, 'Authentication failed');
  }
});

// 5. Explainability Endpoint
router.get('/explain/:predictionId', verifyClinician, async (req, res) => {
  try {
    const explanation = await predictor.explainPrediction(
      req.params.predictionId
    );

    res.json({
      predictionId: req.params.predictionId,
      topFeatures: explanation.features,
      shapValues: explanation.shapValues,
      decisionPath: explanation.decisionPath
    });
  } catch (error) {
    res.status(500).json({ error: 'Explanation failed' });
  }
});

// Helper Functions
function generateExplanation(prediction, condition) {
  const explanations = {
    'CKD': `The model predicts ${prediction.finalRiskScore * 100}% risk of CKD progression based on 
            elevated ${prediction.keyFeatures.join(', ')} levels.`,
    'Diabetes': `High ${prediction.finalRiskScore * 100}% risk score driven primarily by 
                HbA1c trends and comorbid conditions.`,
    'Sepsis': `Early warning due to ${prediction.keyFeatures.length} abnormal vitals 
              with ${prediction.riskCategory} severity.`
  };
  return explanations[condition] || 'Clinical risk prediction based on patient data.';
}

function analyzeCohort(results) {
  const averageRisk = results.reduce((sum, r) => sum + r.risk, 0) / results.length;
  const highRiskPatients = results.filter(r => r.category === 'High' || r.category === 'Critical');
  
  const distribution = {
    Low: results.filter(r => r.category === 'Low').length,
    Medium: results.filter(r => r.category === 'Medium').length,
    High: results.filter(r => r.category === 'High').length,
    Critical: results.filter(r => r.category === 'Critical').length
  };

  return { averageRisk, highRiskPatients, riskDistribution: distribution };
}

function subscribeToVitals(patientId, callback) {
  const ws = new WebSocket(
    `wss://fhir-ws.uhrh.com/Observation?patient=${patientId}&code=55284-4,8310-5,8867-4` // HR, Temp, RR
  );
  ws.onmessage = (event) => callback(JSON.parse(event.data));
  return () => ws.close();
}

function subscribeToAlerts(patientId, callback) {
  const ws = new WebSocket(
    `wss://alerts.uhrh.com/patient/${patientId}`
  );
  ws.onmessage = (event) => callback(JSON.parse(event.data));
  return () => ws.close();
}

module.exports = router;