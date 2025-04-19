const { Hospital, Department, Facility, AuditLog, User } = require('../models');
const { FHIRServerError } = require('../utils/errors');
const { validateFHIR } = require('../services/fhirService');
const { encryptPHI, decryptPHI } = require('../services/encryptionService');
const { maskPHI } = require('../utils/phiUtils');
const { Op } = require('sequelize');

class HospitalController {
  /**
   * Register a new hospital facility
   * @route POST /api/hospitals
   * @param {Object} hospitalData - FHIR Organization resource
   * @returns {Object} Created hospital
   */
  static async registerHospital(req, res, next) {
    const hospitalData = req.body;
    const requestingUser = req.user;

    try {
      // 1. Validate FHIR Organization resource
      const validation = validateFHIR(hospitalData, 'Organization');
      if (!validation.valid) {
        throw new FHIRServerError(`Invalid Organization data: ${validation.errors.join(', ')}`, 400);
      }

      // 2. Verify admin privileges
      if (requestingUser.role !== 'admin') {
        throw new FHIRServerError('Admin privileges required', 403);
      }

      // 3. Encrypt sensitive data
      const encryptedData = this._encryptPHIFields(hospitalData);

      // 4. Create hospital record
      const hospital = await Hospital.create(
        this._fromFHIR(encryptedData),
        { include: [Facility] }
      );

      // 5. Log the operation
      await AuditLog.create({
        userId: requestingUser.id,
        action: 'create',
        entityType: 'Hospital',
        entityId: hospital.fhirId,
        metadata: {
          changes: Object.keys(hospitalData),
          initiatedBy: requestingUser.id
        }
      });

      res.status(201).json(this._toFHIR(hospital));
    } catch (err) {
      next(err);
    }
  }

  /**
   * Get hospital details with departments
   * @route GET /api/hospitals/:id
   * @param {String} id - Hospital FHIR ID
   * @returns {Object} FHIR Organization resource with extensions
   */
  static async getHospital(req, res, next) {
    const { id } = req.params;

    try {
      // 1. Fetch hospital with departments
      const hospital = await Hospital.findOne({
        where: { fhirId: id },
        include: [
          { model: Facility, as: 'Facility' },
          { model: Department, as: 'Departments' }
        ]
      });

      if (!hospital) {
        throw new FHIRServerError('Hospital not found', 404);
      }

      // 2. Convert to FHIR format
      const fhirHospital = this._toFHIR(hospital);

      // 3. Add department extension
      fhirHospital.extension = fhirHospital.extension || [];
      fhirHospital.extension.push({
        url: `${process.env.FHIR_SERVER_URL}/StructureDefinition/hospital-departments`,
        valueReference: hospital.Departments.map(dept => ({
          reference: `Organization/${dept.fhirId}`,
          display: dept.name
        }))
      });

      // 4. Decrypt PHI fields
      const decryptedHospital = this._decryptPHIFields(fhirHospital);

      res.json(decryptedHospital);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Search hospitals with filtering
   * @route GET /api/hospitals
   * @param {String} name - Hospital name search
   * @param {String} location - City/state
   * @returns {Array} List of matching hospitals
   */
  static async searchHospitals(req, res, next) {
    const { name, location } = req.query;

    try {
      // 1. Build search criteria
      const where = {};
      if (name) where.name = { [Op.like]: `%${name}%` };
      if (location) where['$Facility.city$'] = { [Op.like]: `%${location}%` };

      // 2. Execute search
      const hospitals = await Hospital.findAll({
        where,
        include: [Facility],
        limit: 100
      });

      // 3. Convert to FHIR and mask sensitive data
      const results = hospitals.map(hospital => {
        const fhirHospital = this._toFHIR(hospital);
        return this._maskPHIFields(fhirHospital);
      });

      res.json(results);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Add/Update hospital department
   * @route POST /api/hospitals/:id/departments
   * @param {String} id - Hospital FHIR ID
   * @param {Object} departmentData - Department data
   * @returns {Object} Updated hospital
   */
  static async manageDepartment(req, res, next) {
    const { id } = req.params;
    const departmentData = req.body;
    const requestingUser = req.user;

    try {
      // 1. Verify hospital exists
      const hospital = await Hospital.findOne({ where: { fhirId: id } });
      if (!hospital) {
        throw new FHIRServerError('Hospital not found', 404);
      }

      // 2. Check admin or hospital admin privileges
      const isAuthorized = requestingUser.role === 'admin' || 
                         (requestingUser.role === 'hospital_admin' && 
                          requestingUser.hospitalId === hospital.id);
      
      if (!isAuthorized) {
        throw new FHIRServerError('Unauthorized', 403);
      }

      // 3. Create or update department
      const [department] = await Department.upsert({
        ...departmentData,
        hospitalId: hospital.id,
        fhirId: departmentData.id || generateFHIRId()
      });

      // 4. Log the operation
      await AuditLog.create({
        userId: requestingUser.id,
        action: departmentData.id ? 'update' : 'create',
        entityType: 'Department',
        entityId: department.fhirId,
        metadata: {
          hospitalId: hospital.id,
          changes: Object.keys(departmentData)
        }
      });

      res.json(this._departmentToFHIR(department));
    } catch (err) {
      next(err);
    }
  }

  // --- Helper Methods --- //

  static _toFHIR(hospital) {
    return {
      resourceType: 'Organization',
      id: hospital.fhirId,
      identifier: [
        {
          system: 'urn:oid:2.16.840.1.113883.4.7',
          value: hospital.Facility.npi
        }
      ],
      name: hospital.name,
      type: [
        {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/organization-type',
              code: 'prov',
              display: 'Healthcare Provider'
            }
          ]
        }
      ],
      telecom: [
        {
          system: 'phone',
          value: hospital.Facility.phone,
          use: 'work'
        },
        {
          system: 'email',
          value: hospital.Facility.email,
          use: 'work'
        }
      ],
      address: [
        {
          use: 'work',
          line: [hospital.Facility.addressLine1],
          city: hospital.Facility.city,
          state: hospital.Facility.state,
          postalCode: hospital.Facility.zip,
          country: 'US'
        }
      ]
    };
  }

  static _fromFHIR(fhirOrganization) {
    return {
      fhirId: fhirOrganization.id,
      name: fhirOrganization.name,
      Facility: {
        npi: fhirOrganization.identifier?.find(id => id.system.includes('2.16.840.1.113883.4.7'))?.value,
        phone: fhirOrganization.telecom?.find(t => t.system === 'phone')?.value,
        email: fhirOrganization.telecom?.find(t => t.system === 'email')?.value,
        addressLine1: fhirOrganization.address?.[0]?.line?.[0],
        city: fhirOrganization.address?.[0]?.city,
        state: fhirOrganization.address?.[0]?.state,
        zip: fhirOrganization.address?.[0]?.postalCode
      }
    };
  }

  static _departmentToFHIR(department) {
    return {
      resourceType: 'Organization',
      id: department.fhirId,
      name: department.name,
      partOf: {
        reference: `Organization/${department.hospital.fhirId}`,
        display: department.hospital.name
      },
      type: [
        {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/department',
              code: department.specialtyCode,
              display: department.specialty
            }
          ]
        }
      ]
    };
  }

  static _encryptPHIFields(fhirOrganization) {
    const encrypted = { ...fhirOrganization };
    const phiFields = ['telecom', 'address'];
    
    phiFields.forEach(field => {
      if (encrypted[field]) {
        encrypted[field] = encryptPHI(JSON.stringify(encrypted[field]));
      }
    });

    return encrypted;
  }

  static _decryptPHIFields(fhirOrganization) {
    const decrypted = { ...fhirOrganization };
    const phiFields = ['telecom', 'address'];
    
    phiFields.forEach(field => {
      if (decrypted[field]) {
        decrypted[field] = JSON.parse(decryptPHI(decrypted[field]));
      }
    });

    return decrypted;
  }

  static _maskPHIFields(fhirOrganization) {
    const masked = { ...fhirOrganization };
    
    if (masked.telecom) {
      masked.telecom = masked.telecom.map(t => ({
        ...t,
        value: maskPHI(t.value)
      }));
    }

    if (masked.address) {
      masked.address = masked.address.map(addr => ({
        ...addr,
        line: addr.line?.map(l => maskPHI(l)),
        postalCode: maskPHI(addr.postalCode)
      }));
    }

    return masked;
  }
}

module.exports = HospitalController;