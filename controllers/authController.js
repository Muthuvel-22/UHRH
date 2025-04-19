const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { AuditLog, User, LoginAttempt } = require('../models');
const { FHIRServerError } = require('../utils/errors');
const { sendOTP } = require('../services/notificationService');
const { verifyBiometric } = require('../services/biometricService');
const { maskPHI } = require('../utils/phiUtils');

class AuthController {
  /**
   * Clinical Staff Login with MFA
   * @route POST /api/auth/clinician
   * @param {String} email - Provider email
   * @param {String} password - Minimum 12 chars
   * @param {String} deviceId - For MFA binding
   * @returns {Object} { accessToken, refreshToken, mfaRequired }
   */
  static async clinicianLogin(req, res, next) {
    const { email, password, deviceId } = req.body;
    const ip = req.ip;
    const userAgent = req.get('User-Agent');

    try {
      // 1. Rate limiting check
      await this._checkLoginAttempts(email, ip);

      // 2. Find user with facility context
      const user = await User.findOne({
        where: { email, role: ['doctor', 'nurse', 'admin'] },
        include: ['Facility']
      });

      if (!user) {
        throw new FHIRServerError('Invalid credentials', 401);
      }

      // 3. Verify credentials
      const isMatch = await bcrypt.compare(password, user.passwordHash);
      if (!isMatch) {
        await LoginAttempt.create({ email, ip, successful: false });
        throw new FHIRServerError('Invalid credentials', 401);
      }

      // 4. Check if MFA required (HIPAA requirement for clinicians)
      let mfaRequired = user.role !== 'nurse'; // Example policy
      let mfaVerified = false;

      if (mfaRequired) {
        const otpSent = await sendOTP(user.phone);
        mfaVerified = otpSent;
        
        if (!mfaVerified) {
          throw new FHIRServerError('MFA delivery failed', 503);
        }
      }

      // 5. Generate tokens (different scopes for roles)
      const tokens = this._generateTokens(user, deviceId);

      // 6. Audit log (HIPAA requirement)
      await AuditLog.create({
        userId: user.id,
        action: 'login',
        entityType: 'user',
        entityId: user.id,
        metadata: {
          ip,
          userAgent,
          mfaUsed: mfaRequired,
          facility: user.Facility.name
        }
      });

      res.json({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        mfaRequired,
        user: {
          id: user.id,
          role: user.role,
          facilityId: user.Facility.id
        }
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Patient Login with Biometric Fallback
   * @route POST /api/auth/patient
   * @param {String} username - Patient portal ID
   * @param {String} [password] - Either password or biometric required
   * @param {Object} [biometric] - { type: 'fingerprint|face', data: String }
   * @returns {Object} { accessToken, refreshToken }
   */
  static async patientLogin(req, res, next) {
    const { username, password, biometric } = req.body;
    const ip = req.ip;

    try {
      // 1. Find patient with PHI access logs
      const user = await User.findOne({
        where: { username, role: 'patient' },
        include: ['PatientProfile']
      });

      if (!user) {
        throw new FHIRServerError('Invalid credentials', 401);
      }

      // 2. Biometric authentication fallback
      if (biometric) {
        const isValid = await verifyBiometric(
          user.PatientProfile.biometricPublicKey,
          biometric.data,
          biometric.type
        );
        
        if (!isValid) {
          throw new FHIRServerError('Biometric verification failed', 401);
        }
      } 
      // 3. Standard password auth
      else if (password) {
        const isMatch = await bcrypt.compare(password, user.passwordHash);
        if (!isMatch) {
          throw new FHIRServerError('Invalid credentials', 401);
        }
      } else {
        throw new FHIRServerError('Authentication method required', 400);
      }

      // 4. Generate patient-specific tokens
      const tokens = this._generateTokens(user);

      // 5. PHI access log (HIPAA requirement)
      await AuditLog.create({
        userId: user.id,
        action: 'phi_access',
        entityType: 'patient',
        entityId: user.PatientProfile.id,
        metadata: {
          accessMethod: biometric ? biometric.type : 'password',
          ip
        }
      });

      res.json({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        patientId: user.PatientProfile.id
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Emergency Break-Glass Access
   * @route POST /api/auth/emergency
   * @param {String} staffId - Clinician ID
   * @param {String} reason - Emergency reason code
   * @returns {Object} { accessToken, overrideToken }
   */
  static async emergencyAccess(req, res, next) {
    const { staffId, reason } = req.body;
    
    try {
      // Validate emergency reason codes
      const validReasons = ['CRITICAL_CARE', 'LIFE_THREATENING'];
      if (!validReasons.includes(reason)) {
        throw new FHIRServerError('Invalid emergency code', 403);
      }

      // Verify clinician exists
      const clinician = await User.findOne({
        where: { id: staffId, role: ['doctor', 'admin'] }
      });

      if (!clinician) {
        throw new FHIRServerError('Staff not authorized', 403);
      }

      // Generate time-limited emergency token
      const tokens = this._generateTokens(clinician, null, true);

      // Emergency access audit log
      await AuditLog.create({
        userId: clinician.id,
        action: 'emergency_access',
        entityType: 'system',
        metadata: {
          reason,
          overrideScope: 'ALL_PATIENTS',
          expiresIn: '15 minutes'
        }
      });

      res.json({
        accessToken: tokens.accessToken,
        overrideToken: tokens.overrideToken,
        expiresIn: 900 // 15 minutes
      });
    } catch (err) {
      next(err);
    }
  }

  // --- Helper Methods --- //

  static async _checkLoginAttempts(email, ip) {
    const attempts = await LoginAttempt.count({
      where: {
        [Op.or]: [{ email }, { ip }],
        createdAt: { [Op.gt]: new Date(Date.now() - 15 * 60 * 1000) } // Last 15 mins
      }
    });

    if (attempts >= 5) {
      throw new FHIRServerError('Too many attempts. Account locked temporarily.', 429);
    }
  }

  static _generateTokens(user, deviceId = null, isEmergency = false) {
    const privateKey = process.env.JWT_PRIVATE_KEY;

    // Base claims
    const claims = {
      sub: user.id,
      role: user.role,
      facility: user.Facility?.id || null,
      scope: this._getScopeForRole(user.role)
    };

    // Emergency override claims
    if (isEmergency) {
      claims.override = true;
      claims.scope = 'ALL_PATIENTS';
    }

    // Device binding for MFA
    if (deviceId) {
      claims.did = deviceId;
    }

    // Access token (short-lived)
    const accessToken = jwt.sign(claims, privateKey, {
      algorithm: 'RS256',
      expiresIn: isEmergency ? '15m' : '1h',
      issuer: 'UHRH Identity'
    });

    // Refresh token (longer-lived, device-bound)
    const refreshToken = jwt.sign({
      sub: user.id,
      did: deviceId
    }, privateKey, {
      algorithm: 'RS256',
      expiresIn: '7d',
      issuer: 'UHRH Identity'
    });

    return { accessToken, refreshToken };
  }

  static _getScopeForRole(role) {
    const scopes = {
      patient: 'read:self write:self',
      doctor: 'read:patients write:records read:reports',
      nurse: 'read:patients write:observations',
      admin: 'admin:all'
    };
    return scopes[role] || '';
  }
}

module.exports = AuthController;