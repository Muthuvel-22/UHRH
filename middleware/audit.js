const { AuditLog, User, Patient } = require('../models');
const { FHIRServerError } = require('../utils/errors');
const { maskPHI } = require('../utils/phiUtils');
const crypto = require('crypto');

class AuditService {
  /**
   * Middleware to log all API requests
   */
  static logRequest() {
    return async (req, res, next) => {
      const startTime = Date.now();
      const auditId = crypto.randomUUID();

      // Store audit reference for response logging
      res.locals.audit = { id: auditId, startTime };

      try {
        // Log the request immediately for non-repudiation
        await this._logRequest(req, auditId);

        // Override response methods to capture the outcome
        const originalSend = res.send;
        res.send = function (body) {
          res.locals.audit.responseBody = this._sanitizeResponse(body);
          originalSend.apply(res, arguments);
        };

        const originalJson = res.json;
        res.json = function (body) {
          res.locals.audit.responseBody = this._sanitizeResponse(body);
          originalJson.apply(res, arguments);
        };

        res.on('finish', async () => {
          await this._logResponse(req, res);
        });

        next();
      } catch (err) {
        await this._logError(req, err, auditId);
        next(err);
      }
    };
  }

  /**
   * Log PHI access explicitly
   * @param {Object} options - { entityType, entityId, action }
   */
  static logPHIAccess(options) {
    return async (req, res, next) => {
      try {
        res.locals.phiAccess = {
          entityType: options.entityType,
          entityId: req.params[options.entityId] || options.entityId,
          action: options.action || req.method
        };
        next();
      } catch (err) {
        next(err);
      }
    };
  }

  // --- Private Methods --- //

  static async _logRequest(req, auditId) {
    const user = req.user || { id: 'anonymous' };
    const phiFields = this._detectPHI(req);

    await AuditLog.create({
      id: auditId,
      userId: user.id,
      action: req.method,
      entityType: this._getEntityType(req.path),
      entityId: req.params.id || null,
      status: 'started',
      metadata: {
        path: req.path,
        params: maskPHI(req.params),
        query: maskPHI(req.query),
        phiFieldsDetected: phiFields,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        requestId: req.id
      }
    });
  }

  static async _logResponse(req, res) {
    const { audit } = res.locals;
    const duration = Date.now() - audit.startTime;

    const update = {
      status: res.statusCode < 400 ? 'completed' : 'failed',
      statusCode: res.statusCode,
      metadata: {
        ...AuditLog.metadata,
        durationMs: duration,
        responseSize: res.get('Content-Length') || 0,
        responseBody: audit.responseBody
      }
    };

    // Add PHI access details if logged
    if (res.locals.phiAccess) {
      update.entityType = res.locals.phiAccess.entityType;
      update.entityId = res.locals.phiAccess.entityId;
      update.action = res.locals.phiAccess.action;
      update.isPHI = true;
    }

    await AuditLog.update(update, { where: { id: audit.id } });
  }

  static async _logError(req, err, auditId) {
    await AuditLog.update({
      status: 'error',
      statusCode: err.status || 500,
      metadata: {
        ...AuditLog.metadata,
        error: maskPHI(err.message),
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
      }
    }, { where: { id: auditId } });
  }

  static _getEntityType(path) {
    const segments = path.split('/');
    if (segments.length >= 3 && segments[1] === 'api') {
      return segments[2]; // e.g., /api/patients -> patients
    }
    return 'system';
  }

  static _detectPHI(req) {
    const phiFields = [];
    const phiPatterns = [
      { name: 'ssn', regex: /\d{3}-\d{2}-\d{4}/ },
      { name: 'mrn', regex: /[A-Z]{2}\d{6}/ },
      { name: 'dob', regex: /\d{4}-\d{2}-\d{2}/ }
    ];

    // Check body
    if (req.body) {
      phiPatterns.forEach(pattern => {
        if (JSON.stringify(req.body).match(pattern.regex)) {
          phiFields.push(`${pattern.name}_in_body`);
        }
      });
    }

    // Check params and query
    ['params', 'query'].forEach(source => {
      if (req[source]) {
        Object.entries(req[source]).forEach(([key, value]) => {
          if (key.toLowerCase().includes('patient') || 
              key.toLowerCase().includes('mrn')) {
            phiFields.push(`${key}_in_${source}`);
          }
        });
      }
    });

    return phiFields.length > 0 ? phiFields : undefined;
  }

  static _sanitizeResponse(body) {
    if (!body) return null;
    
    try {
      const str = typeof body === 'string' ? body : JSON.stringify(body);
      return maskPHI(str);
    } catch {
      return '[unserializable data]';
    }
  }

  // --- Query Methods --- //

  /**
   * Get all PHI access for a patient
   * @param {String} patientId - FHIR patient ID
   * @param {Date} [since] - Optional start date
   */
  static async getPatientAccessLog(patientId, since = null) {
    const where = {
      entityType: 'patient',
      entityId: patientId,
      isPHI: true
    };

    if (since) {
      where.createdAt = { [Op.gte]: since };
    }

    return AuditLog.findAll({
      where,
      include: [{
        model: User,
        attributes: ['id', 'role', 'name']
      }],
      order: [['createdAt', 'DESC']]
    });
  }

  /**
   * Generate HIPAA compliance report
   * @param {Date} startDate 
   * @param {Date} endDate 
   */
  static async generateComplianceReport(startDate, endDate) {
    const results = await AuditLog.findAll({
      where: {
        createdAt: { [Op.between]: [startDate, endDate] },
        isPHI: true
      },
      attributes: [
        'entityType',
        [sequelize.fn('COUNT', sequelize.col('id')), 'accessCount'],
        [sequelize.fn('COUNT', sequelize.distinct(sequelize.col('userId'))), 'uniqueUsers']
      ],
      group: ['entityType']
    });

    return {
      reportPeriod: { startDate, endDate },
      totalPHIAccesses: results.reduce((sum, r) => sum + r.accessCount, 0),
      byResourceType: results,
      generatedAt: new Date()
    };
  }
}

module.exports = AuditService;