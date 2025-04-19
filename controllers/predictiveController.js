const { Patient, Observation, Condition } = require('../models');
const { FHIRServerError } = require('../utils/errors');
const { validateFHIR } = require('../services/fhirService');
const { QuantumML } = require('../services/quantumMLService');
const { ClinicalRulesEngine } = require('../services/rulesEngine');
const { maskPHI } = require('../utils/phiUtils');
const { Op } = require('sequelize');

class PredictiveController {
  /**
   * CKD Risk Prediction (Quantum-enhanced)
   * @route POST /api/predict/ckd
   * @param {String} patientId - FHIR Patient ID
   * @returns {Object} Risk prediction with clinical context
   */
  static async predictCKD(req, res, next) {
    const { patientId } = req.body;
    const requestingUser = req.user;

    try {
      // 1. Verify access to patient data
      await this._verifyPatientAccess(requestingUser, patientId);

      // 2. Fetch required clinical data
      const clinicalData = await this._getPatientClinicalData(patientId);

      // 3. Generate quantum-enhanced prediction
      const prediction = await QuantumML.predictCKD(clinicalData);

      // 4. Apply clinical rules for interpretation
      const clinicalContext = ClinicalRulesEngine.interpretCKDResult(
        prediction, 
        clinicalData
      );

      // 5. Log prediction (for model improvement)
      await this._logPrediction({
        userId: requestingUser.id,
        patientId,
        model: 'quantum_ckd_v3',
        inputFeatures: clinicalData,
        output: prediction,
        clinicalContext
      });

      res.json({
        prediction,
        clinicalContext,
        _warnings: this._generateUsageWarnings(prediction)
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Diabetes Progression Prediction
   * @route POST /api/predict/diabetes
   * @param {String} patientId - FHIR Patient ID
   * @param {String} [timeframe] - 1y, 5y
   * @returns {Object} Risk score and progression factors
   */
  static async predictDiabetes(req, res, next) {
    const { patientId, timeframe = '1y' } = req.body;

    try {
      // 1. Verify access
      await this._verifyPatientAccess(req.user, patientId);

      // 2. Get diabetes-relevant data
      const diabetesData = await this._getDiabetesData(patientId, timeframe);

      // 3. Generate prediction
      const prediction = await QuantumML.predictDiabetes(diabetesData);

      // 4. Format as FHIR RiskAssessment
      const fhirRiskAssessment = this._toFHIRRiskAssessment(
        patientId,
        prediction,
        'diabetes',
        timeframe
      );

      res.json(fhirRiskAssessment);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Hospital Readmission Risk
   * @route POST /api/predict/readmission
   * @param {String} encounterId - FHIR Encounter ID
   * @returns {Object} Readmission risk with preventions
   */
  static async predictReadmission(req, res, next) {
    const { encounterId } = req.body;

    try {
      // 1. Get encounter context
      const encounter = await this._getEncounter(encounterId);

      // 2. Verify access to patient
      await this._verifyPatientAccess(req.user, encounter.patientId);

      // 3. Calculate readmission risk
      const riskFactors = await this._getReadmissionFactors(encounter);
      const prediction = await QuantumML.predictReadmission(riskFactors);

      // 4. Generate clinical recommendations
      const recommendations = ClinicalRulesEngine.generateReadmissionPreventions(
        prediction, 
        riskFactors
      );

      res.json({
        riskScore: prediction.score,
        riskFactors: prediction.factors,
        recommendations,
        encounter: {
          id: encounterId,
          dischargeDate: encounter.dischargeDate
        }
      });
    } catch (err) {
      next(err);
    }
  }

  // --- Helper Methods --- //

  static async _verifyPatientAccess(user, patientId) {
    // Implementation similar to PatientController
    // Checks if user has access to this patient's data
  }

  static async _getPatientClinicalData(patientId) {
    const [observations, conditions] = await Promise.all([
      Observation.findAll({
        where: { patientId },
        attributes: ['code', 'value', 'date'],
        order: [['date', 'DESC']],
        limit: 100
      }),
      Condition.findAll({
        where: { patientId },
        attributes: ['code', 'onsetDate']
      })
    ]);

    const latestLabs = observations
      .filter(o => o.code.startsWith('LAB-'))
      .reduce((acc, obs) => {
        const baseCode = obs.code.split('-')[0];
        if (!acc[baseCode] || new Date(obs.date) > new Date(acc[baseCode].date)) {
          acc[baseCode] = obs;
        }
        return acc;
      }, {});

    return {
      demographics: await Patient.findByPk(patientId, {
        attributes: ['age', 'gender', 'bmi']
      }),
      latestLabs,
      conditions: conditions.map(c => ({
        code: c.code,
        duration: (new Date() - new Date(c.onsetDate)) / (1000 * 60 * 60 * 24 * 365)
      }))
    };
  }

  static async _getDiabetesData(patientId, timeframe) {
    // Specialized data collection for diabetes prediction
    // Includes HbA1c trends, medications, etc.
  }

  static async _getEncounter(encounterId) {
    // Fetch encounter details from FHIR server
  }

  static async _getReadmissionFactors(encounter) {
    // Collect relevant clinical and social factors
  }

  static _toFHIRRiskAssessment(patientId, prediction, condition, timeframe) {
    return {
      resourceType: 'RiskAssessment',
      subject: { reference: `Patient/${patientId}` },
      occurrenceDateTime: new Date().toISOString(),
      condition: {
        coding: [{
          system: 'http://snomed.info/sct',
          code: this._getConditionCode(condition)
        }]
      },
      prediction: [{
        outcome: {
          coding: [{
            system: 'http://hl7.org/fhir/risk-assessment-outcome',
            code: 'progress'
          }]
        },
        probabilityDecimal: prediction.riskScore,
        whenRange: {
          low: { value: 0, unit: 'years' },
          high: { value: parseInt(timeframe), unit: 'years' }
        },
        rationale: prediction.factors.join(', ')
      }],
      mitigation: prediction.recommendations
    };
  }

  static _getConditionCode(condition) {
    const codes = {
      ckd: '709044004',
      diabetes: '46635009',
      readmission: '306206005'
    };
    return codes[condition];
  }

  static async _logPrediction(logData) {
    await AuditLog.create({
      userId: logData.userId,
      action: 'prediction',
      entityType: 'Patient',
      entityId: logData.patientId,
      metadata: {
        model: logData.model,
        inputFeatures: maskPHI(logData.inputFeatures),
        output: logData.output,
        clinicalContext: logData.clinicalContext
      }
    });
  }

  static _generateUsageWarnings(prediction) {
    const warnings = [];
    
    if (prediction.riskScore > 0.7) {
      warnings.push({
        code: 'high-risk',
        severity: 'serious',
        details: 'High risk prediction - clinical review recommended'
      });
    }

    if (prediction.confidence < 0.6) {
      warnings.push({
        code: 'low-confidence',
        severity: 'moderate',
        details: 'Model confidence below optimal threshold'
      });
    }

    return warnings;
  }
}

module.exports = PredictiveController;