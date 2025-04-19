const { FHIRServerError } = require('./errors');
const { AuditLog } = require('../models');
const { maskPHI } = require('./phiUtils');
const { OperationOutcome } = require('fhir').Fhir;

class ErrorHandler {
  /**
   * Centralized error handling middleware
   */
  static handle() {
    return async (err, req, res, next) => {
      try {
        // 1. Convert to FHIRServerError if needed
        const fhirError = this._normalizeError(err);
        
        // 2. Log the error with audit context
        await this._logError(req, fhirError);
        
        // 3. Send FHIR-compliant response
        this._sendFHIRError(res, fhirError);
      } catch (loggingError) {
        console.error('Error logging failed:', loggingError);
        this._sendFHIRError(res, new FHIRServerError(
          'Internal server error', 
          500,
          'logging-failed'
        ));
      }
    };
  }

  // --- Error Normalization --- //

  static _normalizeError(err) {
    if (err instanceof FHIRServerError) {
      return err;
    }

    // Handle JWT errors
    if (err.name === 'JsonWebTokenError') {
      return new FHIRServerError('Invalid authentication token', 401, 'security');
    }

    if (err.name === 'TokenExpiredError') {
      return new FHIRServerError('Authentication token expired', 401, 'expired');
    }

    // Handle database errors
    if (err.name === 'SequelizeValidationError') {
      return new FHIRServerError(
        `Validation error: ${err.errors.map(e => e.message).join(', ')}`,
        400,
        'validation'
      );
    }

    if (err.name === 'SequelizeUniqueConstraintError') {
      return new FHIRServerError(
        `Duplicate entry: ${err.errors.map(e => e.message).join(', ')}`,
        409,
        'duplicate'
      );
    }

    // Default to 500 for unexpected errors
    return new FHIRServerError(
      process.env.NODE_ENV === 'production' 
        ? 'Internal server error' 
        : err.message,
      500,
      'exception'
    );
  }

  // --- Error Logging --- //

  static async _logError(req, error) {
    const auditId = res.locals.audit?.id || null;
    const userId = req.user?.id || 'anonymous';

    const logData = {
      errorCode: error.code,
      statusCode: error.status,
      message: maskPHI(error.message),
      stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
      metadata: {
        path: req.path,
        method: req.method,
        ip: req.ip
      }
    };

    if (auditId) {
      // Update existing audit log
      await AuditLog.update(
        { 
          status: 'error',
          statusCode: error.status,
          metadata: {
            ...AuditLog.metadata,
            error: logData
          }
        },
        { where: { id: auditId } }
      );
    } else {
      // Create new error log
      await AuditLog.create({
        userId,
        action: req.method,
        entityType: this._getEntityType(req.path),
        status: 'error',
        statusCode: error.status,
        metadata: logData
      });
    }
  }

  static _getEntityType(path) {
    const segments = path.split('/');
    if (segments.length >= 3 && segments[1] === 'api') {
      return segments[2]; // e.g., /api/patients -> patients
    }
    return 'system';
  }

  // --- Response Formatting --- //

  static _sendFHIRError(res, error) {
    const operationOutcome = this._createOperationOutcome(error);
    
    res.status(error.status).json(operationOutcome);
  }

  static _createOperationOutcome(error) {
    return {
      resourceType: 'OperationOutcome',
      issue: [
        {
          severity: this._getSeverity(error.status),
          code: this._getIssueCode(error.code),
          details: {
            coding: [
              {
                system: 'http://hl7.org/fhir/ValueSet/operation-outcome',
                code: error.code || 'exception',
                display: error.message
              }
            ],
            text: error.message
          },
          diagnostics: process.env.NODE_ENV !== 'production' 
            ? error.stack 
            : undefined
        }
      ]
    };
  }

  static _getSeverity(status) {
    if (status >= 500) return 'error';
    if (status >= 400) return 'warning';
    return 'information';
  }

  static _getIssueCode(errorCode) {
    const codes = {
      'security': 'forbidden',
      'expired': 'expired',
      'validation': 'invalid',
      'duplicate': 'duplicate',
      'not-found': 'not-found'
    };
    return codes[errorCode] || 'exception';
  }

  // --- Specialized Handlers --- //

  /**
   * Handle 404 errors with FHIR format
   */
  static handleNotFound(req, res, next) {
    next(new FHIRServerError(
      `Resource not found: ${req.method} ${req.originalUrl}`,
      404,
      'not-found'
    ));
  }

  /**
   * Handle unauthorized errors
   */
  static handleUnauthorized(err, req, res, next) {
    if (err.status === 401) {
      res.set('WWW-Authenticate', 'Bearer realm="UHRH API"');
    }
    next(err);
  }

  /**
   * Handle rate limiting
   */
  static handleRateLimit(req, res, next) {
    res.set('Retry-After', 60);
    next(new FHIRServerError(
      'Too many requests, please try again later',
      429,
      'throttled'
    ));
  }
}

module.exports = ErrorHandler;