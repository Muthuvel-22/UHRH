const { FHIRServerError } = require('../utils/errors');
const { Patient, Encounter, Organization } = require('../models');
const { validateFHIR } = require('../services/fhirService');
const { maskPHI } = require('../utils/phiUtils');

class RoleCheck {
  /**
   * Verify user has required role and FHIR resource access
   * @param {Array} allowedRoles - Roles with permission
   * @param {String} resourceType - FHIR resource type
   * @param {String} accessLevel - read/write/admin
   * @returns {Function} Express middleware
   */
  static check(allowedRoles = [], resourceType = null, accessLevel = 'read') {
    return async (req, res, next) => {
      try {
        // 1. Basic role check
        if (allowedRoles.length > 0 && !allowedRoles.includes(req.user.role)) {
          throw new FHIRServerError('Insufficient role privileges', 403);
        }

        // 2. FHIR resource-specific checks
        if (resourceType) {
          await this._verifyFHIRAccess(
            req.user,
            resourceType,
            req.params.id,
            accessLevel
          );
        }

        // 3. Special emergency access checks
        if (req.user.isEmergency) {
          await this._logEmergencyAccess(
            req.user,
            req.method,
            req.path,
            resourceType,
            req.params.id
          );
        }

        next();
      } catch (err) {
        next(err);
      }
    };
  }

  // --- FHIR Resource Access Verification --- //

  static async _verifyFHIRAccess(user, resourceType, resourceId, accessLevel) {
    switch (resourceType.toLowerCase()) {
      case 'patient':
        return this._verifyPatientAccess(user, resourceId, accessLevel);
      case 'encounter':
        return this._verifyEncounterAccess(user, resourceId, accessLevel);
      case 'organization':
        return this._verifyOrganizationAccess(user, resourceId, accessLevel);
      default:
        throw new FHIRServerError(`Unsupported resource type: ${resourceType}`, 400);
    }
  }

  static async _verifyPatientAccess(user, patientId, accessLevel) {
    // Admins can access all patients
    if (user.role === 'admin') return true;

    // Patients can only access their own records
    if (user.role === 'patient') {
      const patient = await Patient.findOne({
        where: { fhirId: patientId, userId: user.id }
      });
      if (!patient) {
        throw new FHIRServerError('Patient access denied', 403);
      }
      return true;
    }

    // Clinicians can access patients in their facility
    const patient = await Patient.findOne({
      where: { fhirId: patientId },
      include: ['Facility']
    });

    if (!patient || patient.Facility.id !== user.facilityId) {
      throw new FHIRServerError('Patient not in your facility', 403);
    }

    // Additional checks for write access
    if (accessLevel === 'write' && user.role === 'nurse') {
      throw new FHIRServerError('Nurses require doctor approval for modifications', 403);
    }

    return true;
  }

  static async _verifyEncounterAccess(user, encounterId, accessLevel) {
    const encounter = await Encounter.findOne({
      where: { fhirId: encounterId },
      include: ['Patient', 'ServiceProvider']
    });

    if (!encounter) {
      throw new FHIRServerError('Encounter not found', 404);
    }

    // Verify underlying patient access first
    await this._verifyPatientAccess(user, encounter.Patient.fhirId, accessLevel);

    // Additional organization checks
    if (user.role === 'doctor' && 
        encounter.ServiceProvider.id !== user.facilityId) {
      throw new FHIRServerError('Encounter not in your organization', 403);
    }

    return true;
  }

  static async _verifyOrganizationAccess(user, orgId, accessLevel) {
    const organization = await Organization.findOne({
      where: { fhirId: orgId }
    });

    if (!organization) {
      throw new FHIRServerError('Organization not found', 404);
    }

    // Only admins and org members can access
    if (user.role !== 'admin' && organization.id !== user.facilityId) {
      throw new FHIRServerError('Organization access denied', 403);
    }

    // Only admins can modify org records
    if (accessLevel === 'write' && user.role !== 'admin') {
      throw new FHIRServerError('Admin role required for modifications', 403);
    }

    return true;
  }

  // --- Emergency Access Handling --- //

  static async _logEmergencyAccess(user, method, path, resourceType, resourceId) {
    await AuditLog.create({
      userId: user.id,
      action: 'emergency_override',
      entityType: resourceType || 'system',
      entityId: resourceId || null,
      metadata: {
        method,
        path,
        overrideScope: user.scopes,
        timestamp: new Date()
      }
    });
  }

  // --- Special Role Checks --- //

  /**
   * Check if user is the patient's primary care provider
   */
  static async isPCP(req, res, next) {
    try {
      const patientId = req.params.id;
      const patient = await Patient.findOne({
        where: { fhirId: patientId },
        include: ['PrimaryCareProvider']
      });

      if (!patient || patient.PrimaryCareProvider.id !== req.user.id) {
        throw new FHIRServerError('Not the primary care provider', 403);
      }

      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * Check if user is in the patient's care team
   */
  static async inCareTeam(req, res, next) {
    try {
      const patientId = req.params.id;
      const careTeam = await CareTeamMember.findOne({
        where: {
          patientId,
          providerId: req.user.id
        }
      });

      if (!careTeam) {
        throw new FHIRServerError('Not on patient care team', 403);
      }

      next();
    } catch (err) {
      next(err);
    }
  }
}

module.exports = RoleCheck;