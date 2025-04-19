const { Patient, AuditLog, User } = require('../models');
const { FHIRServerError } = require('../utils/errors');
const { validateFHIR } = require('../services/fhirService');
const { encryptPHI, decryptPHI } = require('../services/encryptionService');
const { maskPHI } = require('../utils/phiUtils');
const { Op } = require('sequelize');

class PatientController {
  /**
   * Get patient record with PHI protection
   * @route GET /api/patients/:id
   * @param {String} id - Patient FHIR ID
   * @returns {Object} FHIR Patient resource
   */
  static async getPatient(req, res, next) {
    const { id } = req.params;
    const requestingUser = req.user;

    try {
      // 1. Verify access permissions
      await this._verifyAccess(requestingUser, id);

      // 2. Fetch patient record
      const patient = await Patient.findOne({
        where: { fhirId: id },
        include: ['Demographics', 'MedicalHistory']
      });

      if (!patient) {
        throw new FHIRServerError('Patient not found', 404);
      }

      // 3. Convert to FHIR format
      const fhirPatient = this._toFHIR(patient);

      // 4. Decrypt PHI fields
      const decryptedPatient = this._decryptPHIFields(fhirPatient);

      // 5. Log access (HIPAA requirement)
      await AuditLog.create({
        userId: requestingUser.id,
        action: 'read',
        entityType: 'Patient',
        entityId: id,
        metadata: {
          accessedFields: ['name', 'birthDate', 'identifier'],
          ip: req.ip
        }
      });

      res.json(decryptedPatient);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Search patients with strict access controls
   * @route GET /api/patients
   * @param {String} name - Patient name search
   * @param {String} birthDate - YYYY-MM-DD format
   * @returns {Array} List of matching patients (with masked PHI)
   */
  static async searchPatients(req, res, next) {
    const { name, birthDate } = req.query;
    const facilityId = req.user.facility;

    try {
      // 1. Validate query parameters
      if (!name && !birthDate) {
        throw new FHIRServerError('Search criteria required', 400);
      }

      // 2. Build search query
      const where = { facilityId };
      if (name) where['$Demographics.lastName$'] = { [Op.like]: `${name}%` };
      if (birthDate) where['$Demographics.birthDate$'] = birthDate;

      // 3. Execute search
      const patients = await Patient.findAll({
        where,
        include: ['Demographics'],
        limit: 50, // Prevent over-fetching
        order: [['createdAt', 'DESC']]
      });

      // 4. Convert to FHIR and mask PHI
      const results = patients.map(patient => {
        const fhirPatient = this._toFHIR(patient);
        return this._maskPHIFields(fhirPatient);
      });

      // 5. Log search (HIPAA requirement)
      await AuditLog.create({
        userId: req.user.id,
        action: 'search',
        entityType: 'Patient',
        metadata: {
          criteria: { name, birthDate },
          resultCount: results.length,
          facility: facilityId
        }
      });

      res.json(results);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Create/Update patient record with validation
   * @route POST /api/patients
   * @param {Object} patientData - FHIR Patient resource
   * @returns {Object} Created/updated patient
   */
  static async upsertPatient(req, res, next) {
    const patientData = req.body;
    const requestingUser = req.user;

    try {
      // 1. Validate FHIR resource
      const validation = validateFHIR(patientData, 'Patient');
      if (!validation.valid) {
        throw new FHIRServerError(`Invalid Patient data: ${validation.errors.join(', ')}`, 400);
      }

      // 2. Encrypt PHI fields before storage
      const encryptedData = this._encryptPHIFields(patientData);

      // 3. Create/update record
      const [patient, created] = await Patient.upsert(
        this._fromFHIR(encryptedData, requestingUser.facility),
        { returning: true }
      );

      // 4. Log the operation
      await AuditLog.create({
        userId: requestingUser.id,
        action: created ? 'create' : 'update',
        entityType: 'Patient',
        entityId: patient.fhirId,
        metadata: {
          changes: Object.keys(patientData),
          facility: requestingUser.facility
        }
      });

      res.status(created ? 201 : 200).json(this._toFHIR(patient));
    } catch (err) {
      next(err);
    }
  }

  // --- Helper Methods --- //

  static async _verifyAccess(user, patientId) {
    // Admins can access all records
    if (user.role === 'admin') return true;

    // Clinicians can access patients in their facility
    const patient = await Patient.findOne({
      where: { fhirId: patientId },
      attributes: ['facilityId']
    });

    if (!patient || patient.facilityId !== user.facility) {
      throw new FHIRServerError('Access denied', 403);
    }
  }

  static _toFHIR(patient) {
    return {
      resourceType: 'Patient',
      id: patient.fhirId,
      identifier: [
        {
          system: 'urn:oid:2.16.840.1.113883.4.1',
          value: patient.Demographics.ssn
        },
        {
          system: `${process.env.FHIR_SERVER_URL}/mrn`,
          value: patient.mrn
        }
      ],
      name: [
        {
          use: 'official',
          family: patient.Demographics.lastName,
          given: [patient.Demographics.firstName]
        }
      ],
      telecom: [
        {
          system: 'phone',
          value: patient.Demographics.phone,
          use: 'home'
        }
      ],
      gender: patient.Demographics.gender,
      birthDate: patient.Demographics.birthDate,
      address: [
        {
          use: 'home',
          line: [patient.Demographics.addressLine1],
          city: patient.Demographics.city,
          state: patient.Demographics.state,
          postalCode: patient.Demographics.zip
        }
      ]
    };
  }

  static _fromFHIR(fhirPatient, facilityId) {
    return {
      fhirId: fhirPatient.id,
      mrn: fhirPatient.identifier?.find(id => id.system.includes('mrn'))?.value,
      facilityId,
      Demographics: {
        firstName: fhirPatient.name?.[0]?.given?.[0],
        lastName: fhirPatient.name?.[0]?.family,
        ssn: fhirPatient.identifier?.find(id => id.system.includes('2.16.840.1.113883.4.1'))?.value,
        phone: fhirPatient.telecom?.find(t => t.system === 'phone')?.value,
        gender: fhirPatient.gender,
        birthDate: fhirPatient.birthDate,
        addressLine1: fhirPatient.address?.[0]?.line?.[0],
        city: fhirPatient.address?.[0]?.city,
        state: fhirPatient.address?.[0]?.state,
        zip: fhirPatient.address?.[0]?.postalCode
      }
    };
  }

  static _encryptPHIFields(fhirPatient) {
    const encrypted = { ...fhirPatient };
    const phiFields = ['name', 'telecom', 'address', 'identifier'];
    
    phiFields.forEach(field => {
      if (encrypted[field]) {
        encrypted[field] = encryptPHI(JSON.stringify(encrypted[field]));
      }
    });

    return encrypted;
  }

  static _decryptPHIFields(fhirPatient) {
    const decrypted = { ...fhirPatient };
    const phiFields = ['name', 'telecom', 'address', 'identifier'];
    
    phiFields.forEach(field => {
      if (decrypted[field]) {
        decrypted[field] = JSON.parse(decryptPHI(decrypted[field]));
      }
    });

    return decrypted;
  }

  static _maskPHIFields(fhirPatient) {
    const masked = { ...fhirPatient };
    
    // Mask sensitive fields
    if (masked.name) {
      masked.name = masked.name.map(name => ({
        ...name,
        family: maskPHI(name.family),
        given: name.given?.map(g => maskPHI(g))
      }));
    }

    if (masked.telecom) {
      masked.telecom = masked.telecom.map(t => ({
        ...t,
        value: maskPHI(t.value)
      }));
    }

    if (masked.identifier) {
      masked.identifier = masked.identifier.map(id => ({
        ...id,
        value: maskPHI(id.value)
      }));
    }

    return masked;
  }
}

module.exports = PatientController;