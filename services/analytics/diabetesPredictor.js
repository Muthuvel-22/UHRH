// diabetesPredictor.js - Advanced Diabetes Prediction Engine
const tf = require('@tensorflow/tfjs-node');
const { QuantumSVM } = require('quantum-ml');
const { FHIR } = require('fhir-kit-client');
const { ClinicalFeatures } = require('./clinicalFeatures');
const { explain } = require('clin-explain');
const { RiskStratifier } = require('./riskStratifier');

class DiabetesPredictor {
  constructor() {
    // Initialize services
    this.fhir = new FHIR.Client({ 
      baseUrl: process.env.FHIR_SERVER,
      auth: { token: process.env.FHIR_TOKEN }
    });
    
    // Model configuration
    this.models = {
      dnn: null,          // Deep Neural Network
      qsvm: new QuantumSVM({ backend: 'ibmq_casablanca' }), // Quantum SVM
      ensemble: null       // Stacked ensemble model
    };
    
    this.featureEngineer = new ClinicalFeatures();
    this.riskStratifier = new RiskStratifier('diabetes');
    this.explainer = explain;
  }

  // 1. Model Initialization
  async initialize() {
    await this._loadModels();
    await this._warmupModels();
    console.log('Diabetes predictor initialized with DNN + QSVM ensemble');
  }

  async _loadModels() {
    // Load TensorFlow DNN model
    this.models.dnn = await tf.loadLayersModel(
      `gs://${process.env.MODEL_BUCKET}/diabetes/dnn/model.json`
    );
    
    // Load quantum SVM circuit
    await this.models.qsvm.loadCircuit(
      'diabetes_qsvm_v3',
      { 
        featureMap: 'ZZFeatureMap', 
        reps: 3 
      }
    );
    
    // Load ensemble meta-model
    this.models.ensemble = await tf.loadLayersModel(
      `gs://${process.env.MODEL_BUCKET}/diabetes/ensemble/model.json`
    );
  }

  async _warmupModels() {
    const warmupData = tf.zeros([1, 18]); // 18 features
    this.models.dnn.predict(warmupData).dispose();
    await this.models.qsvm.predict([[0, 0, 0]]); // Minimal quantum prediction
    warmupData.dispose();
  }

  // 2. Prediction Pipeline
  async predict(patientId, options = {}) {
    const {
      horizon = '1y',       // 1y, 3y, 5y
      explainability = true, // Generate explanations
      clinicalContext = true // Add clinical context
    } = options;

    // 2A. Extract and prepare features
    const { features, rawData } = await this._prepareFeatures(patientId, horizon);
    
    // 2B. Run model predictions
    const predictions = await this._runPredictions(features);
    
    // 2C. Generate clinical output
    const result = this._formatResults(
      patientId, 
      predictions, 
      rawData,
      { horizon, explainability, clinicalContext }
    );

    return result;
  }

  // 3. Feature Engineering
  async _prepareFeatures(patientId, horizon) {
    // 3A. Extract raw data from FHIR
    const rawData = await this._extractPatientData(patientId);
    
    // 3B. Temporal feature engineering
    const temporalFeatures = this.featureEngineer.calculateTemporalFeatures(
      rawData.observations, 
      horizon
    );
    
    // 3C. Compile final feature vector
    const features = [
      ...this._normalizeDemographics(rawData.demographics),
      ...this._normalizeLabs(rawData.observations),
      ...this._processConditions(rawData.conditions),
      ...temporalFeatures
    ];

    return { features, rawData };
  }

  async _extractPatientData(patientId) {
    const [demographics, observations, conditions] = await Promise.all([
      this._getDemographics(patientId),
      this._getObservations(patientId),
      this._getConditions(patientId)
    ]);

    return { demographics, observations, conditions };
  }

  async _getDemographics(patientId) {
    const patient = await this.fhir.read({ resourceType: 'Patient', id: patientId });
    return {
      age: this._calculateAge(patient.birthDate),
      gender: patient.gender,
      bmi: await this._calculateBMI(patientId)
    };
  }

  async _getObservations(patientId) {
    const codes = [
      '2339-0',  // Glucose
      '4548-4',  // HbA1c
      '2571-8',  // Triglycerides
      '2085-9'   // HDL
    ];

    const results = await Promise.all(
      codes.map(code => 
        this.fhir.search({
          resourceType: 'Observation',
          params: {
            patient: patientId,
            code: `http://loinc.org|${code}`,
            '_sort': '-date',
            '_count': 3
          }
        })
      )
    );

    return this._processObservations(results, codes);
  }

  // 4. Model Operations
  async _runPredictions(features) {
    const [dnnOut, qsvmOut] = await Promise.all([
      this._dnnPrediction(features),
      this._quantumPrediction(features)
    ]);

    // Ensemble predictions
    const ensembleInput = tf.tensor2d([[dnnOut, qsvmOut]]);
    const ensembleOut = this.models.ensemble.predict(ensembleInput);
    const finalScore = (await ensembleOut.data())[0];
    ensembleInput.dispose();
    ensembleOut.dispose();

    return { dnnOut, qsvmOut, finalScore };
  }

  async _dnnPrediction(features) {
    const tensor = tf.tensor2d([features]);
    const prediction = this.models.dnn.predict(tensor);
    const prob = (await prediction.data())[0];
    tensor.dispose();
    prediction.dispose();
    return prob;
  }

  async _quantumPrediction(features) {
    // Select top 3 features for quantum circuit (due to qubit limitations)
    const importantFeatures = this._selectTopFeatures(features, 3);
    const scaledFeatures = this._scaleForQuantum(importantFeatures);
    return await this.models.qsvm.predict(scaledFeatures);
  }

  // 5. Result Formatting
  _formatResults(patientId, predictions, rawData, options) {
    const { finalScore, dnnOut, qsvmOut } = predictions;
    
    const result = {
      patientId,
      predictionDate: new Date().toISOString(),
      riskScore: finalScore,
      riskCategory: this.riskStratifier.categorize(finalScore),
      confidence: this._calculateConfidence(dnnOut, qsvmOut),
      modelVersions: {
        dnn: 'diabetes-dnn-v4.2',
        qsvm: 'diabetes-qsvm-v3.1',
        ensemble: 'ensemble-v2.0'
      },
      horizon: options.horizon
    };

    // Add explainability if requested
    if (options.explainability) {
      result.explanation = this.explainer.explain({
        features: this.featureEngineer.getFeatureNames(),
        values: rawData,
        prediction: finalScore
      });
    }

    // Add clinical context if requested
    if (options.clinicalContext) {
      result.clinicalContext = this._generateClinicalContext(rawData, finalScore);
    }

    return result;
  }

  _generateClinicalContext(rawData, score) {
    const context = [];
    
    // HbA1c context
    if (rawData.observations.hba1c) {
      context.push({
        marker: 'HbA1c',
        value: rawData.observations.hba1c,
        interpretation: rawData.observations.hba1c >= 5.7 ? 
          'Prediabetes range' : 'Normal range'
      });
    }
    
    // BMI context
    if (rawData.demographics.bmi) {
      context.push({
        marker: 'BMI',
        value: rawData.demographics.bmi,
        interpretation: rawData.demographics.bmi >= 30 ? 
          'Obesity (increased risk)' : 'Normal/Overweight'
      });
    }
    
    // Risk-specific recommendations
    context.push({
      recommendation: this._getRiskBasedRecommendation(score)
    });

    return context;
  }

  // 6. Utility Methods
  _calculateAge(birthDate) {
    const birth = new Date(birthDate);
    const now = new Date();
    return now.getFullYear() - birth.getFullYear();
  }

  async _calculateBMI(patientId) {
    const [height, weight] = await Promise.all([
      this._getLatestObservation(patientId, '8302-2'), // Height
      this._getLatestObservation(patientId, '29463-7') // Weight
    ]);

    if (height && weight) {
      const heightMeters = height / 100;
      return weight / (heightMeters * heightMeters);
    }
    return null;
  }

  _selectTopFeatures(features, count) {
    const importantIndices = [1, 3, 5]; // Based on feature importance analysis
    return importantIndices.map(i => features[i]);
  }

  _scaleForQuantum(features) {
    // Scale to [-π, π] range for quantum circuits
    return features.map(f => (f * 2 * Math.PI) - Math.PI);
  }

  _calculateConfidence(dnnProb, qsvmProb) {
    const disagreement = Math.abs(dnnProb - qsvmProb);
    return 1 - (disagreement * 2); // Normalized to [0,1]
  }

  _getRiskBasedRecommendation(score) {
    if (score < 0.3) return 'Continue annual screening';
    if (score < 0.7) return 'Consider lifestyle interventions';
    return 'Recommend intensive monitoring and possible pharmacotherapy';
  }
}

module.exports = DiabetesPredictor;