// backend/dataHub/exchangeController.js

const exchangeService = require('./exchangeService');
const logger = require('../utils/logger');

/**
 * Handles data upload from external systems (FHIR, labs, hospitals)
 */
exports.uploadData = async (req, res, next) => {
  try {
    const result = await exchangeService.processIncomingData(req.body, req.user);
    res.status(201).json({
      message: 'Data uploaded and processed successfully.',
      data: result
    });
  } catch (error) {
    logger.error('Exchange Upload Failed:', error);
    next(error);
  }
};

/**
 * Fetches exchanged data by patient ID
 */
exports.getDataByPatient = async (req, res, next) => {
  try {
    const patientId = req.params.patientId;
    const data = await exchangeService.getDataForPatient(patientId);
    
    if (!data) {
      return res.status(404).json({ message: 'No data found for this patient.' });
    }

    res.status(200).json({
      message: 'Patient data retrieved successfully.',
      data
    });
  } catch (error) {
    logger.error('Failed to fetch patient data:', error);
    next(error);
  }
};

/**
 * Optional: Endpoint to test data transformation
 */
exports.transformDataSample = async (req, res, next) => {
  try {
    const transformed = await exchangeService.transformToInternalSchema(req.body);
    res.status(200).json({
      message: 'Data transformed to internal schema.',
      data: transformed
    });
  } catch (error) {
    logger.error('Data transformation error:', error);
    next(error);
  }
};
