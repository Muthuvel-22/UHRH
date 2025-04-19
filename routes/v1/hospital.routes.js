// hospital.routes.js - Hospital Management API with FHIR & Blockchain Integration
const express = require('express');
const router = express.Router();
const { FHIR } = require('fhir-kit-client');
const { Blockchain } = require('../blockchain');
const { FederatedLearning } = require('../federatedLearning');
const { AuditLog } = require('../audit');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

// Initialize services
const fhirClient = new FHIR.Client({ baseUrl: process.env.FHIR_SERVER });
const blockchain = new Blockchain('hospital-network');
const flEngine = new FederatedLearning('ckd-prediction-v2');
const audit = new AuditLog();

// Middleware for hospital admin verification
async function verifyHospitalAdmin(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const role = decoded.extension?.find(e => e.url === 'http://uhrh.org/roles')?.valueCode;
    
    if (role !== 'hospital-admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    req.hospitalId = decoded.hospitalId;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// 1. Hospital Census Management
router.get('/census', verifyHospitalAdmin, async (req, res) => {
  const { department, status = 'in-progress' } = req.query;

  try {
    // Get current patients by department
    const census = await fhirClient.search({
      resourceType: 'Encounter',
      params: {
        'service-provider': req.hospitalId,
        'department': department,
        'status': status,
        '_include': 'Encounter:patient',
        '_count': 500
      }
    });

    // Format response
    const patients = census.entry
      ?.filter(e => e.resource.resourceType === 'Patient')
      .map(e => ({
        id: e.resource.id,
        name: e.resource.name?.[0]?.text,
        location: getCurrentLocation(e.resource.id, census.entry)
      }));

    await audit.log(req.hospitalId, 'CENSUS_ACCESS', {
      department,
      patientCount: patients?.length || 0
    });

    res.json({ patients: patients || [] });
  } catch (error) {
    res.status(500).json({ error: 'Census retrieval failed' });
  }
});

// 2. Resource Utilization Analytics
router.get('/resources', verifyHospitalAdmin, async (req, res) => {
  try {
    const [beds, devices, staff] = await Promise.all([
      fhirClient.search({
        resourceType: 'Location',
        params: {
          'organization': req.hospitalId,
          'type': 'bed',
          '_summary': 'count'
        }
      }),
      fhirClient.search({
        resourceType: 'Device',
        params: {
          'organization': req.hospitalId,
          '_summary': 'count'
        }
      }),
      fhirClient.search({
        resourceType: 'PractitionerRole',
        params: {
          'organization': req.hospitalId,
          '_summary': 'count'
        }
      })
    ]);

    res.json({
      beds: beds.total || 0,
      devices: devices.total || 0,
      staff: staff.total || 0,
      lastUpdated: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Resource check failed' });
  }
});

// 3. Federated Learning Participation
router.post('/contribute-model', verifyHospitalAdmin, async (req, res) => {
  try {
    // Train model on local data
    const update = await flEngine.trainLocalModel(req.hospitalId);

    // Submit to blockchain
    const tx = await blockchain.submitModelUpdate({
      hospitalId: req.hospitalId,
      modelHash: update.modelHash,
      metrics: update.metrics,
      sampleSize: update.sampleSize
    });

    // Audit model contribution
    await audit.log(req.hospitalId, 'MODEL_CONTRIBUTION', {
      model: 'ckd-prediction-v2',
      txHash: tx.hash
    });

    res.json({
      txHash: tx.hash,
      metrics: update.metrics
    });
  } catch (error) {
    res.status(500).json({ error: 'Model training failed' });
  }
});

// 4. IoT Device Management
router.ws('/devices', (ws, req) => {
  // Verify admin token from query string
  const token = req.query.token;
  try {
    jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return ws.close(1008, 'Unauthorized');
  }

  // Device registration and monitoring
  const devices = new Map();

  ws.on('message', (message) => {
    const { type, deviceId, data } = JSON.parse(message);

    switch (type) {
      case 'register':
        devices.set(deviceId, {
          lastSeen: new Date(),
          status: 'active'
        });
        break;

      case 'update':
        if (devices.has(deviceId)) {
          devices.get(deviceId).lastSeen = new Date();
          
          // Critical alerts trigger FHIR Flag
          if (data.alertLevel === 'critical') {
            createFHIRFlag(deviceId, data);
          }
        }
        break;

      case 'heartbeat':
        // Maintain connection
        break;
    }
  });

  // Cleanup
  ws.on('close', () => {
    devices.clear();
  });
});

// 5. Patient Transfer Workflow
router.post('/transfer', verifyHospitalAdmin, async (req, res) => {
  const { patientId, receivingHospitalId, reason } = req.body;

  try {
    // Verify transfer agreement exists
    const agreementExists = await blockchain.checkTransferAgreement(
      req.hospitalId,
      receivingHospitalId
    );

    if (!agreementExists) {
      return res.status(403).json({ error: 'No transfer agreement' });
    }

    // Prepare FHIR transfer bundle
    const bundle = await prepareTransferBundle(patientId);

    // Submit to blockchain for consent verification
    const tx = await blockchain.initiateTransfer({
      sendingHospital: req.hospitalId,
      receivingHospital: receivingHospitalId,
      patientId,
      dataHash: hashBundle(bundle),
      reason
    });

    // Create FHIR DocumentReference for transfer
    await createTransferDocument(tx.hash, bundle);

    res.json({
      transferId: tx.hash,
      status: 'pending-consent'
    });
  } catch (error) {
    res.status(500).json({ error: 'Transfer failed' });
  }
});

// 6. Emergency Protocols
router.post('/emergency-mode', verifyHospitalAdmin, async (req, res) => {
  const { protocol, severity } = req.body;

  try {
    // Activate emergency measures
    const result = await activateEmergencyProtocol(protocol, severity);

    // Broadcast to all connected devices
    broadcastEmergencyAlert(protocol, severity);

    res.json({
      activated: new Date().toISOString(),
      protocol,
      affectedDepartments: result.affectedDepartments
    });
  } catch (error) {
    res.status(500).json({ error: 'Protocol activation failed' });
  }
});

// Helper Functions
function getCurrentLocation(patientId, encounterEntries) {
  const encounter = encounterEntries
    .find(e => e.resource.resourceType === 'Encounter' && 
               e.resource.subject?.reference === `Patient/${patientId}`);
  return encounter?.resource?.location?.[0]?.location?.display;
}

async function createFHIRFlag(deviceId, data) {
  return fhirClient.create({
    resourceType: 'Flag',
    status: 'active',
    code: { text: 'Device Critical Alert' },
    extension: [{
      url: 'http://uhrh.org/device-alert',
      valueReference: { reference: `Device/${deviceId}` }
    }],
    subject: {
      reference: data.patientId ? `Patient/${data.patientId}` : `Location/${data.location}`
    }
  });
}

async function prepareTransferBundle(patientId) {
  const [patient, conditions, meds] = await Promise.all([
    fhirClient.read({ resourceType: 'Patient', id: patientId }),
    fhirClient.search({ resourceType: 'Condition', params: { patient: patientId } }),
    fhirClient.search({ resourceType: 'MedicationRequest', params: { patient: patientId } })
  ]);

  return {
    resourceType: 'Bundle',
    type: 'document',
    meta: { tag: [{ system: 'http://uhrh.org/tags', code: 'transfer' }] },
    entry: [
      { resource: patient },
      ...(conditions.entry?.map(e => ({ resource: e.resource })) || []),
      ...(meds.entry?.map(e => ({ resource: e.resource })) || [])
    ]
  };
}

function hashBundle(bundle) {
  const crypto = require('crypto');
  return crypto.createHash('sha256')
    .update(JSON.stringify(bundle))
    .digest('hex');
}

async function createTransferDocument(txHash, bundle) {
  return fhirClient.create({
    resourceType: 'DocumentReference',
    status: 'current',
    type: {
      coding: [{
        system: 'http://loinc.org',
        code: '57133-1',
        display: 'Discharge summary'
      }]
    },
    content: [{
      attachment: {
        contentType: 'application/json',
        data: Buffer.from(JSON.stringify(bundle)).toString('base64'),
        hash: hashBundle(bundle)
      }
    }],
    context: {
      event: [{
        coding: [{
          system: 'http://uhrh.org/transfer',
          code: 'inter-hospital'
        }]
      }],
      related: [{
        identifier: {
          system: 'http://blockchain.uhrh.org/tx',
          value: txHash
        }
      }]
    }
  });
}

async function activateEmergencyProtocol(protocol, severity) {
  // Implementation varies by hospital
  return {
    activated: new Date(),
    affectedDepartments: ['ER', 'ICU', 'RADIOLOGY'],
    protocol
  };
}

function broadcastEmergencyAlert(protocol, severity) {
  // Would integrate with hospital PA/alert systems
  console.log(`EMERGENCY: ${protocol} (${severity}) activated`);
}

module.exports = router;