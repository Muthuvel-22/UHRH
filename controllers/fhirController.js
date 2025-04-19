import Patient from "../models/Patient.js";
import Observation from "../models/Observation.js";

// ---------------- Patient Controllers ----------------

// GET /api/fhir/patients?name=
export const getAllPatients = async (req, res) => {
  try {
    const query = req.query.name;
    const filter = query ? { "name.0.text": new RegExp(query, 'i') } : {};
    const patients = await Patient.find(filter);
    res.status(200).json(patients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /api/fhir/patients/:id
export const getPatientById = async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient) return res.status(404).json({ error: "Patient not found" });
    res.json(patient);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/fhir/patients
export const createPatient = async (req, res) => {
  try {
    const patient = new Patient(req.body);
    await patient.save();
    res.status(201).json(patient);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// PUT /api/fhir/patients/:id
export const updatePatient = async (req, res) => {
  try {
    const updated = await Patient.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// DELETE /api/fhir/patients/:id
export const deletePatient = async (req, res) => {
  try {
    await Patient.findByIdAndDelete(req.params.id);
    res.json({ message: "Patient deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ---------------- Observation Controllers ----------------

// GET /api/fhir/observations?patient=
export const getObservations = async (req, res) => {
  try {
    const patientId = req.query.patient;
    const filter = patientId ? { "subject.reference": `Patient/${patientId}` } : {};
    const observations = await Observation.find(filter);
    res.json(observations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/fhir/observations
export const createObservation = async (req, res) => {
  try {
    const obs = new Observation(req.body);
    await obs.save();
    res.status(201).json(obs);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
