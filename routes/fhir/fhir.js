import express from 'express';

const router = express.Router();

// Temporary in-memory storage (replace with DB or real FHIR client)
let patients = [];
let observations = [];

/**
 * @route GET /api/fhir/patients?name=John
 * @desc Search patients by name
 */
router.get('/patients', (req, res) => {
  const { name } = req.query;
  const filtered = patients.filter((p) =>
    p.name?.toLowerCase().includes(name?.toLowerCase())
  );
  res.json(filtered);
});

/**
 * @route GET /api/fhir/patients/:id
 * @desc Get a patient by ID
 */
router.get('/patients/:id', (req, res) => {
  const patient = patients.find((p) => p.id === req.params.id);
  if (patient) {
    res.json(patient);
  } else {
    res.status(404).json({ message: 'Patient not found' });
  }
});

/**
 * @route POST /api/fhir/patients
 * @desc Create a new patient
 */
router.post('/patients', (req, res) => {
  const newPatient = {
    id: Date.now().toString(),
    ...req.body,
  };
  patients.push(newPatient);
  res.status(201).json(newPatient);
});

/**
 * @route PUT /api/fhir/patients/:id
 * @desc Update patient details
 */
router.put('/patients/:id', (req, res) => {
  const index = patients.findIndex((p) => p.id === req.params.id);
  if (index !== -1) {
    patients[index] = {
      ...patients[index],
      ...req.body,
    };
    res.json(patients[index]);
  } else {
    res.status(404).json({ message: 'Patient not found' });
  }
});

/**
 * @route DELETE /api/fhir/patients/:id
 * @desc Delete patient
 */
router.delete('/patients/:id', (req, res) => {
  const index = patients.findIndex((p) => p.id === req.params.id);
  if (index !== -1) {
    patients.splice(index, 1);
    res.json({ message: 'Patient deleted' });
  } else {
    res.status(404).json({ message: 'Patient not found' });
  }
});

/**
 * @route GET /api/fhir/observations?patient=123
 * @desc Fetch observations for a patient
 */
router.get('/observations', (req, res) => {
  const { patient } = req.query;
  const result = observations.filter((obs) => obs.patientId === patient);
  res.json(result);
});

/**
 * @route POST /api/fhir/observations
 * @desc Create a new observation
 */
router.post('/observations', (req, res) => {
  const newObs = {
    id: Date.now().toString(),
    ...req.body,
  };
  observations.push(newObs);
  res.status(201).json(newObs);
});

export default router;
