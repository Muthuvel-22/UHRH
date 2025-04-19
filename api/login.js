
app.post('/api/login', async (req, res) => {
    const { email, password, role } = req.body;
  
    const users = [
      { role: 'Admin', email: 'krithikkrishna2304@gmail.com', password: '@Krithik_2304' },
      { role: 'Doctor', email: 'mageji007@gmail.com', password: '@Mahesh23' },
      { role: 'Patient', email: 'mohammedfardin.ds.ai@gmail.com', password: '@Fardin204' }
    ];
  
    const user = users.find(
      u => u.email === email && u.password === password && u.role === role
    );
  
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials or role' });
    }
  
    const token = 'token-' + Date.now();
  
    res.status(200).json({
      message: 'Login successful',
      token,
      role: user.role,
      email: user.email
    });
  });
  