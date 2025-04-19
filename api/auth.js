const express = require('express');
const router = express.Router();

// Hardcoded users — production version should use a database
const users = [
  {
    role: 'Admin',
    email: 'krithikkrishna2304@gmail.com',
    password: '@Krithik_2304',
  },
  {
    role: 'Doctor',
    email: 'mageji007@gmail.com',
    password: '@Mahesh23',
  },
  {
    role: 'Patient',
    email: 'mohammedfardin.ds.ai@gmail.com',
    password: '@Fardin204',
  },
];

// POST /api/login
router.post('/login', (req, res) => {
  const { email, password, role } = req.body;

  // Check if the user exists and credentials match
  const user = users.find(
    (u) => u.email === email && u.password === password && u.role === role
  );

  if (!user) {
    return res.status(401).json({ message: 'Invalid email, password, or role' });
  }

  // Dummy token — in production, generate a JWT
  const token = 'demo-token-' + Date.now();

  // Respond with basic session info
  return res.status(200).json({
    message: 'Login successful',
    token,
    role: user.role,
    email: user.email,
  });
});

module.exports = router;
