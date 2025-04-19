// patient.routes.js - FHIR Patient Data API with Advanced Healthcare Features
const express = require('express');
const router = express.Router();
const { FHIR } = require('fhir-kit-client');
const { Blockchain } = require('../blockchain');
const { ClinicalPredictor } = require('../prediction');
const { AuditLog } = require('../audit');
const jwt = require('jsonwebtoken');

// Initialize services
const fhirClient = new FHIR.Client({ baseUrl: process.env.FHIR_SERVER });
const blockchain = new Blockchain('patient-consent-network');
const predictor = new ClinicalPredictor();
const audit = new AuditLog();

// Middleware to verify patient access rights
async function verifyPatientAccess(req, res, next) {
  const patientId = req.params.id;
  const practitionerId = req.user.userId;

  try {
    // Check blockchain consent records
    const hasAccess = await blockchain.verifyConsent({
      practitionerId,
      patientId,
      action: req.method === 'GET' ? 'read' : 'write'
    });

    if (!hasAccess) {
      return res.status(403).json({ error: 'Consent not granted for this action' });
    }

    // Additional FHIR relationship check
    const hasRelationship = await checkFHIRRelationship(practitionerId, patientId);
    if (!hasRelationship) {
      return res.status(403).json({ error: 'No established care relationship' });
    }

    req.patientId = patientId;
    next();
  } catch (error) {
    res.status(500).json({ error: 'Access verification failed' });
  }
}

// 1. Patient Demographic Operations
router.get('/:id', verifyPatientAccess, async (req, res) => {
  try {
    const patient = await fhirClient.read({
      resourceType: 'Patient',
      id: req.patientId
    });

    // Audit the access
    await audit.log(req.user.userId, 'PATIENT_READ', {
      resourceId: req.patientId,
      ip: req.ip
    });

    res.json(sanitizePatientData(patient));
  } catch (error) {
    res.status(404).json({ error: 'Patient not found' });
  }
});

// 2. Clinical Data Access
router.get('/:id/records', verifyPatientAccess, async (req, res) => {
  const { category, _count = 100 } = req.query;

  try {
    const records = await fhirClient.search({
      resourceType: 'Observation',
      params: {
        patient: req.patientId,
        category,
        _sort: '-date',
        _count
      }
    });

    // Log data access
    await audit.log(req.user.userId, 'RECORDS_ACCESS', {
      patientId: req.patientId,
      category,
      count: records.entry?.length || 0
    });

    res.json(records.entry?.map(e => formatClinicalRecord(e.resource)) || []);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve records' });
  }
});

// 3. Predictive Health Analytics
router.get('/:id/risk/:condition', verifyPatientAccess, async (req, res) => {
  const { condition } = req.params;

  try {
    const prediction = await predictor.predictRisk(req.patientId, condition);

    // Audit prediction
    await audit.log(req.user.userId, 'RISK_PREDICTION', {
      patientId: req.patientId,
      condition,
      score: prediction.finalRiskScore
    });

    res.json(prediction);
  } catch (error) {
    res.status(500).json({ error: 'Prediction failed' });
  }
});

// 4. Real-Time Monitoring WebSocket
router.ws('/:id/live', async (ws, req) => {
  const { id: patientId } = req.params;
  const token = req.query.token;

  try {
    // Verify WebSocket token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const hasAccess = await blockchain.verifyConsent({
      practitionerId: decoded.userId,
      patientId,
      action: 'read'
    });

    if (!hasAccess) {
      return ws.close(1008, 'Consent not granted');
    }

    // Set up real-time subscriptions
    const subscriptions = [
      subscribeToFHIRUpdates('Observation', patientId, (data) => {
        ws.send(JSON.stringify({ type: 'observation', data }));
      }),
      subscribeToPredictiveAlerts(patientId, (alert) => {
        ws.send(JSON.stringify({ type: 'alert', alert }));
      })
    ];

    ws.on('close', () => {
      subscriptions.forEach(unsub => unsub());
    });

  } catch (error) {
    ws.close(1008, 'Authentication failed');
  }
});

// 5. Patient-Controlled Data Sharing
router.post('/:id/share', verifyPatientAccess, async (req, res) => {
  const { recipientId, scope, duration } = req.body;

  try {
    // Patient authorizes sharing via blockchain
    const tx = await blockchain.submitConsent({
      patientId: req.patientId,
      recipientId,
      scope,
      expiresAt: new Date(Date.now() + duration * 1000)
    });

    // Create FHIR Consent resource
    const consent = await createFHIRConsent(
      req.patientId,
      recipientId,
      scope,
      tx.hash
    );

    res.json({
      consentId: consent.id,
      blockchainTx: tx.hash,
      expiresAt: new Date(Date.now() + duration * 1000)
    });
  } catch (error) {
    res.status(500).json({ error: 'Data sharing failed' });
  }
});

// 6. Emergency Data Access Override
router.get('/:id/emergency', async (req, res) => {
  const { token } = req.query;

  try {
    // Verify emergency token (hardware/SMS based)
    const emergency = verifyEmergencyToken(token);
    if (!emergency.valid) {
      return res.status(403).json({ error: 'Invalid emergency token' });
    }

    // Get minimal required data
    const patient = await fhirClient.read({
      resourceType: 'Patient',
      id: req.params.id
    });

    // Log emergency access
    await audit.logEmergencyAccess(
      emergency.practitionerId,
      req.params.id,
      emergency.justification,
      req.ip
    );

    res.json({
      ...sanitizeEmergencyData(patient),
      medications: await getEmergencyMedications(req.params.id),
      allergies: await getEmergencyAllergies(req.params.id)
    });
  } catch (error) {
    res.status(500).json({ error: 'Emergency access failed' });
  }
});

// Helper Functions
async function checkFHIRRelationship(practitionerId, patientId) {
  const encounters = await fhirClient.search({
    resourceType: 'Encounter',
    params: {
      'participant.identifier': practitionerId,
      'subject': `Patient/${patientId}`,
      '_count': 1
    }
  });
  return encounters.entry && encounters.entry.length > 0;
}

function sanitizePatientData(patient) {
  return {
    id: patient.id,
    name: patient.name?.[0],
    birthDate: patient.birthDate,
    gender: patient.gender,
    contact: patient.telecom?.map(t => ({
      system: t.system,
      value: t.value
    })),
    address: patient.address?.map(a => ({
      line: a.line,
      city: a.city,
      state: a.state
    }))
  };
}

function formatClinicalRecord(observation) {
  return {
    id: observation.id,
    code: observation.code?.coding?.[0]?.display,
    value: observation.valueQuantity?.value || observation.valueString,
    unit: observation.valueQuantity?.unit,
    date: observation.effectiveDateTime,
    status: observation.status
  };
}

async function createFHIRConsent(patientId, recipientId, scope, txHash) {
  return await fhirClient.create({
    resourceType: 'Consent',
    status: 'active',
    scope: {
      coding: [{
        system: 'http://hl7.org/fhir/consent-scope',
        code: 'patient-privacy'
      }]
    },
    category: [{
      coding: [{
        system: 'http://terminology.hl7.org/CodeSystem/consentcategorycodes',
        code: 'smart-on-fhir'
      }]
    }],
    patient: { reference: `Patient/${patientId}` },
    performer: { reference: `Patient/${patientId}` }, // Patient self-consent
    organization: [{ reference: `Practitioner/${recipientId}` }],
    policyRule: {
      coding: [{
        system: 'http://uhrh.org/consent-policy',
        code: 'patient-authorized'
      }]
    },
    verification: [{
      verified: true,
      verificationType: {
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/verificationresult-primary-source-type',
          code: 'blockchain'
        }]
      },
      attachment: {
        url: `https://blockexplorer.uhrh.com/tx/${txHash}`
      }
    }],
    provision: {
      type: 'permit',
      action: scope.map(s => ({
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/consentaction',
          code: s.split(':')[1]
        }]
      }))
    }
  });
}

function verifyEmergencyToken(token) {
  // In production: Verify hardware/SMS token
  try {
    const decoded = jwt.verify(token, process.env.EMERGENCY_SECRET);
    return {
      valid: true,
      practitionerId: decoded.practitionerId,
      justification: decoded.justification
    };
  } catch {
    return { valid: false };
  }
}

function sanitizeEmergencyData(patient) {
  return {
    id: patient.id,
    name: patient.name?.find(n => n.use === 'official')?.text,
    birthDate: patient.birthDate,
    bloodType: patient.extension?.find(e => e.url === 'http://hl7.org/fhir/StructureDefinition/patient-bloodType')?.valueCode
  };
}

async function getEmergencyMedications(patientId) {
  const result = await fhirClient.search({
    resourceType: 'MedicationRequest',
    params: {
      patient: patientId,
      status: 'active',
      _sort: '-date',
      _count: 5
    }
  });
  return result.entry?.map(e => ({
    medication: e.resource.medicationCodeableConcept?.text,
    dosage: e.resource.dosageInstruction?.[0]?.text
  })) || [];
}

async function getEmergencyAllergies(patientId) {
  const result = await fhirClient.search({
    resourceType: 'AllergyIntolerance',
    params: {
      patient: patientId,
      _sort: '-recordedDate',
      _count: 5
    }
  });
  return result.entry?.map(e => e.resource.code?.text) || [];
}

// Real-time subscription helpers
function subscribeToFHIRUpdates(resourceType, patientId, callback) {
  const ws = new WebSocket(
    `wss://fhir-ws.uhrh.com/${resourceType}?patient=${patientId}`
  );
  ws.onmessage = (event) => callback(JSON.parse(event.data));
  return () => ws.close();
}

function subscribeToPredictiveAlerts(patientId, callback) {
  const ws = new WebSocket(
    `wss://predictive.uhrh.com/alerts?patient=${patientId}`
  );
  ws.onmessage = (event) => callback(JSON.parse(event.data));
  return () => ws.close();
}

module.exports = router;