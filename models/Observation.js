import mongoose from "mongoose";

const observationSchema = new mongoose.Schema({
  resourceType: {
    type: String,
    default: "Observation",
  },
  status: {
    type: String,
    enum: ["registered", "preliminary", "final", "amended"],
    default: "final",
  },
  category: [{
    coding: [{
      system: String,
      code: String,
      display: String,
    }]
  }],
  code: {
    coding: [{
      system: String,
      code: String,
      display: String,
    }]
  },
  subject: {
    reference: {
      type: String, // e.g., "Patient/123"
      required: true,
    }
  },
  effectiveDateTime: {
    type: String, // ISO date string
    required: true,
  },
  valueQuantity: {
    value: {
      type: Number,
      required: true,
    },
    unit: {
      type: String,
      required: true,
    },
    system: {
      type: String,
      default: "http://unitsofmeasure.org",
    },
    code: {
      type: String,
    }
  }
}, {
  timestamps: true,
});

export default mongoose.model("Observation", observationSchema);
