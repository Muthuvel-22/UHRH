import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

const UserSchema = new mongoose.Schema({
  fhirId: {
    type: String,
    default: () => `user-${uuidv4()}`,
    unique: true
  },
  username: {
    type: String,
    required: true,
    unique: true,
    match: /^[a-zA-Z0-9_]{4,30}$/
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true
  },
  passwordHash: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: ['patient', 'nurse', 'doctor', 'hospital_admin', 'system_admin'],
    default: 'patient'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastLogin: Date,
  failedAttempts: {
    type: Number,
    default: 0
  },
  mustResetPassword: {
    type: Boolean,
    default: false
  },
  mfaSecret: String,
  passwordChangedAt: Date,
  termsAcceptedAt: Date,
  lockedUntil: Date
}, { timestamps: true });

// Instance Methods
UserSchema.methods.verifyPassword = function (password) {
  return bcrypt.compare(password, this.passwordHash);
};

UserSchema.methods.generateAuthToken = function (isEmergency = false) {
  const privateKey = process.env.JWT_PRIVATE_KEY;
  return jwt.sign(
    {
      sub: this._id,
      role: this.role,
      scope: this.getScopes(),
      isEmergency
    },
    privateKey,
    {
      algorithm: 'RS256',
      expiresIn: isEmergency ? '15m' : process.env.JWT_EXPIRES_IN || '1h',
      issuer: 'UHRH Identity Service'
    }
  );
};

UserSchema.methods.getScopes = function () {
  const scopes = {
    patient: 'patient/*.read patient/*.write',
    nurse: 'patient/*.read observation/*.write',
    doctor: 'patient/*.read patient/*.write observation/*.read observation/*.write',
    hospital_admin: 'organization/*.read organization/*.write',
    system_admin: '*'
  };
  return scopes[this.role] || '';
};

UserSchema.methods.lockAccount = async function () {
  this.lockedUntil = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
  this.failedAttempts = 0;
  await this.save();
};

UserSchema.methods.recordFailedAttempt = async function () {
  this.failedAttempts += 1;
  if (this.failedAttempts >= 5) {
    await this.lockAccount();
    throw new Error('Account locked due to multiple failed attempts');
  }
  await this.save();
};

UserSchema.statics.findByCredentials = async function (email, password) {
  const user = await this.findOne({ email });
  if (!user || !user.isActive) throw new Error('Invalid credentials');

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new Error(`Account locked until ${user.lockedUntil.toISOString()}`);
  }

  const isMatch = await user.verifyPassword(password);
  if (!isMatch) {
    await user.recordFailedAttempt();
    throw new Error('Invalid credentials');
  }

  if (user.failedAttempts > 0) {
    user.failedAttempts = 0;
    await user.save();
  }

  return user;
};

UserSchema.statics.createWithPassword = async function (userData) {
  const hashedPassword = await bcrypt.hash(userData.password, 12);
  return this.create({
    ...userData,
    passwordHash: hashedPassword
  });
};

const User = mongoose.model('User', UserSchema);
export default User;
