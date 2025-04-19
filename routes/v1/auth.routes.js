// auth.routes.js - Healthcare Authentication & Authorization Routes
const express = require('express');
const router = express.Router();
const { FHIR } = require('fhir-kit-client');
const jwt = require('jsonwebtoken');
const { Blockchain } = require('../blockchain');
const { AuditLog } = require('../audit');
const { sendSMSCode, sendEmailOTP } = require('../messaging');
const rateLimit = require('express-rate-limit');

// Initialize services
const fhirClient = new FHIR.Client({ baseUrl: process.env.FHIR_SERVER });
const blockchain = new Blockchain('consent-network');
const audit = new AuditLog();

// Rate limiting for security
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per window
  message: 'Too many login attempts, please try again later'
});

// 1. FHIR User Authentication
router.post('/login', authLimiter, async (req, res) => {
  const { email, password, deviceId } = req.body;

  try {
    // 1A. Verify credentials against FHIR Practitioner
    const practitioner = await authenticateFHIRUser(email, password);
    
    // 1B. Initiate MFA
    const mfaToken = generateMFAToken(practitioner.id);
    await sendEmailOTP(practitioner.telecom.find(t => t.system === 'email').value);

    // 1C. Audit login attempt
    await audit.log(practitioner.id, 'LOGIN_ATTEMPT', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      deviceId
    });

    res.json({
      mfaRequired: true,
      tempToken: mfaToken,
      userId: practitioner.id
    });

  } catch (error) {
    audit.log('SYSTEM', 'LOGIN_FAILURE', { error: error.message });
    res.status(401).json({ error: 'Authentication failed' });
  }
});

// 2. Multi-Factor Authentication
router.post('/verify-mfa', async (req, res) => {
  const { tempToken, otpCode, deviceInfo } = req.body;

  try {
    // 2A. Verify JWT and OTP
    const decoded = jwt.verify(tempToken, process.env.JWT_SECRET);
    if (!await verifyOTP(decoded.userId, otpCode)) {
      throw new Error('Invalid OTP');
    }

    // 2B. Get complete Practitioner profile
    const practitioner = await fhirClient.read({
      resourceType: 'Practitioner',
      id: decoded.userId
    });

    // 2C. Generate access tokens
    const { accessToken, refreshToken } = generateTokens(practitioner);

    // 2D. Record device authorization
    await blockchain.submitConsent({
      userId: practitioner.id,
      deviceId: deviceInfo.id,
      scope: ['ehr:read', 'ehr:write'],
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
    });

    // 2E. Audit successful login
    await audit.log(practitioner.id, 'LOGIN_SUCCESS', {
      ip: req.ip,
      device: deviceInfo
    });

    res.json({
      accessToken,
      refreshToken,
      profile: formatUserProfile(practitioner)
    });

  } catch (error) {
    audit.log('SYSTEM', 'MFA_FAILURE', { error: error.message });
    res.status(401).json({ error: 'MFA verification failed' });
  }
});

// 3. Role-Based Access Control
router.get('/roles', authenticateToken, async (req, res) => {
  try {
    // 3A. Get FHIR PractitionerRole resources
    const roles = await fhirClient.search({
      resourceType: 'PractitionerRole',
      params: { practitioner: req.user.id }
    });

    // 3B. Check blockchain for additional permissions
    const blockchainPermissions = await blockchain.getPermissions(req.user.id);

    res.json({
      fhirRoles: roles.entry?.map(e => e.resource) || [],
      blockchainPermissions
    });

  } catch (error) {
    res.status(500).json({ error: 'Failed to load roles' });
  }
});

// 4. Consent Management
router.post('/consent', authenticateToken, async (req, res) => {
  const { scope, patientId, expiresIn } = req.body;

  try {
    // 4A. Verify practitioner has relationship to patient
    const hasRelationship = await checkPatientRelationship(
      req.user.id, 
      patientId
    );

    if (!hasRelationship) {
      return res.status(403).json({ error: 'No established patient relationship' });
    }

    // 4B. Record consent on blockchain
    const tx = await blockchain.submitConsent({
      practitionerId: req.user.id,
      patientId,
      scope,
      expiresAt: new Date(Date.now() + expiresIn * 1000)
    });

    // 4C. Create FHIR Consent resource
    const fhirConsent = await createFHIRConsent(
      req.user.id,
      patientId,
      scope,
      tx.hash
    );

    res.json({
      consentId: fhirConsent.id,
      blockchainTx: tx.hash
    });

  } catch (error) {
    res.status(500).json({ error: 'Consent recording failed' });
  }
});

// 5. Break-Glass Emergency Access
router.post('/emergency-access', async (req, res) => {
  const { practitionerId, patientId, justification } = req.body;

  try {
    // 5A. Verify emergency credentials (hardware token)
    if (!verifyEmergencyToken(req.headers['x-emergency-token'])) {
      throw new Error('Invalid emergency token');
    }

    // 5B. Generate temporary token (15min expiry)
    const token = jwt.sign(
      { userId: practitionerId, emergency: true },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    // 5C. Record break-glass access
    await audit.logEmergencyAccess(
      practitionerId,
      patientId,
      justification,
      req.ip
    );

    res.json({ accessToken: token });

  } catch (error) {
    res.status(403).json({ error: 'Emergency access denied' });
  }
});

// Helper Functions
async function authenticateFHIRUser(email, password) {
  // Verify against FHIR server (implementation varies by FHIR server)
  const result = await fhirClient.search({
    resourceType: 'Practitioner',
    params: {
      'email': email,
      '_security': createSecurityHeader(password) // Basic Auth in real implementation
    }
  });

  if (!result.entry || result.entry.length === 0) {
    throw new Error('Practitioner not found');
  }

  return result.entry[0].resource;
}

function generateMFAToken(userId) {
  return jwt.sign(
    { userId, purpose: 'mfa' },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  );
}

async function verifyOTP(userId, code) {
  // Implement your OTP verification logic
  return true; // Simplified for example
}

function generateTokens(practitioner) {
  const accessToken = jwt.sign(
    {
      userId: practitioner.id,
      name: practitioner.name?.[0]?.text,
      roles: practitioner.extension?.find(e => e.url === 'http://uhrh.org/roles')?.valueCodeableConcept?.coding || []
    },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );

  const refreshToken = jwt.sign(
    { userId: practitioner.id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );

  return { accessToken, refreshToken };
}

function formatUserProfile(practitioner) {
  return {
    id: practitioner.id,
    name: practitioner.name?.[0]?.text,
    photo: practitioner.photo?.[0]?.url,
    qualifications: practitioner.qualification?.map(q => q.code.text)
  };
}

async function checkPatientRelationship(practitionerId, patientId) {
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

async function createFHIRConsent(practitionerId, patientId, scope, txHash) {
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
    performer: [{ reference: `Practitioner/${practitionerId}` }],
    policyRule: {
      coding: [{
        system: 'http://uhrh.org/consent-policy',
        code: 'blockchain-verified'
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
      period: {
        start: new Date().toISOString()
      },
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
  // Implement hardware token verification
  return token === process.env.EMERGENCY_TOKEN;
}

// Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

module.exports = router;