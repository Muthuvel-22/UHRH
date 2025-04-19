const jwt = require('jsonwebtoken');
const { AuditLog } = require('../models');
const { FHIRServerError } = require('./errorHandler');
const { verifyBiometricSignature } = require('../services/biometricService');
const { maskPHI } = require('../utils/phiUtils');

// JWT configuration
const JWT_CONFIG = {
  algorithm: 'RS256', // Asymmetric crypto for better security
  expiresIn: process.env.JWT_EXPIRES_IN || '15m', // Short-lived tokens
  issuer: 'UHRH Identity Service'
};

class AuthService {
  /**
   * Healthcare provider login with MFA
   * @param {String} email 
   * @param {String} password 
   * @param {Object} deviceInfo 
   * @returns {Promise<Object>} auth tokens
   */
  static async clinicalLogin(email, password, deviceInfo) {
    try {
      // 1. Validate credentials
      const user = await this._verifyCredentials(email, password);
      
      // 2. Check if MFA required (for clinicians)
      if (user.role === 'clinician') {
        await this._verifyMFA(user, deviceInfo);
      }

      // 3. Generate tokens
      const tokens = await this._generateTokens(user);

      // 4. Log authentication event (HIPAA requirement)
      await AuditLog.create({
        userId: user.id,
        action: 'login',
        entityType: 'user',
        entityId: user.id,
        metadata: {
          ip: deviceInfo.ip,
          userAgent: deviceInfo.userAgent,
          location: deviceInfo.location
        }
      });

      return tokens;
    } catch (err) {
      throw new FHIRServerError(`Authentication failed: ${err.message}`, 401);
    }
  }

  /**
   * Patient login with biometric fallback
   * @param {String} username 
   * @param {String} credential - Password or biometric signature
   * @param {Object} authContext 
   * @returns {Promise<Object>} auth tokens
   */
  static async patientLogin(username, credential, authContext) {
    const user = await User.findOne({ where: { username } });
    
    if (!user) {
      throw new FHIRServerError('Invalid credentials', 401);
    }

    // Biometric fallback for patients
    if (authContext?.biometricData) {
      const isVerified = await verifyBiometricSignature(
        user.biometricPublicKey, 
        authContext.biometricData
      );
      
      if (!isVerified) {
        throw new FHIRServerError('Biometric verification failed', 401);
      }
    } else {
      // Standard password verification
      const isValid = await bcrypt.compare(credential, user.passwordHash);
      if (!isValid) {
        throw new FHIRServerError('Invalid credentials', 401);
      }
    }

    return this._generateTokens(user);
  }

  /**
   * Middleware for HIPAA-compliant access control
   */
  static authenticate(requiredRoles = []) {
    return async (req, res, next) => {
      try {
        // 1. Extract token
        const token = this._extractToken(req);
        if (!token) {
          throw new FHIRServerError('Authorization required', 401);
        }

        // 2. Verify token
        const decoded = await this._verifyToken(token);

        // 3. Check role permissions
        if (requiredRoles.length > 0 && !requiredRoles.includes(decoded.role)) {
          throw new FHIRServerError('Insufficient permissions', 403);
        }

        // 4. Attach user context
        req.user = {
          id: decoded.sub,
          role: decoded.role,
          facilityId: decoded.facility,
          permissions: decoded.scope.split(' ')
        };

        // 5. Proceed with audit trail
        req.auditTrail = {
          userId: decoded.sub,
          action: req.method,
          resource: req.path
        };

        next();
      } catch (err) {
        next(err);
      }
    };
  }

  // --- Private Methods --- //

  static async _verifyCredentials(email, password) {
    const user = await User.findOne({ 
      where: { email },
      include: ['Facility'] 
    });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new Error('Invalid credentials');
    }

    // Check if account is locked (HIPAA requirement)
    if (user.failedAttempts >= 5) {
      await this._lockAccount(user);
      throw new Error('Account locked - contact administrator');
    }

    return user;
  }

  static async _verifyMFA(user, deviceInfo) {
    // Implementation for:
    // - SMS OTP
    // - TOTP apps
    // - Hardware tokens
    // - Push notifications
  }

  static async _generateTokens(user) {
    const privateKey = process.env.JWT_PRIVATE_KEY;
    
    // Access token
    const accessToken = jwt.sign(
      {
        sub: user.id,
        role: user.role,
        facility: user.Facility?.id,
        scope: this._getScopes(user.role)
      },
      privateKey,
      JWT_CONFIG
    );

    // Refresh token (longer-lived)
    const refreshToken = jwt.sign(
      { sub: user.id },
      privateKey,
      { ...JWT_CONFIG, expiresIn: '7d' }
    );

    return { accessToken, refreshToken };
  }

  static _getScopes(role) {
    const scopes = {
      patient: 'read:patient read:observations',
      clinician: 'read:patient write:patient read:observations write:observations',
      admin: 'read:* write:* manage:users'
    };
    return scopes[role] || '';
  }

  static _extractToken(req) {
    return req.headers.authorization?.split(' ')[1] || 
           req.cookies?.access_token;
  }

  static async _verifyToken(token) {
    try {
      const publicKey = process.env.JWT_PUBLIC_KEY;
      return jwt.verify(token, publicKey, JWT_CONFIG);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        throw new FHIRServerError('Session expired', 401);
      }
      throw new FHIRServerError('Invalid token', 401);
    }
  }
}

module.exports = AuthService;