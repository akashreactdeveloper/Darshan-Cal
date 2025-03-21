require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const admin = require('firebase-admin');
const { authenticateFirebaseUser } = require('./middlewares/AuthMiddleware');
const router = require('./routes/Index'); // Ensure the path matches your project structure

// Initialize Firebase Admin
const serviceAccount = require(process.env.FIREBASE_ADMIN_SDK_PATH || './credentials/creds.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const app = express();
const PORT = process.env.PORT || 8000;

// Middleware
app.use(cors({ origin: '*' }));
app.use(helmet());
app.use(compression());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(morgan('dev'));

// Apply Firebase authentication middleware to all API routes
app.use('/api', authenticateFirebaseUser, router);
// app.use('/api', router);

// Dummy route
app.post('/api/items/videos/', (req, res) => {
  res.json({ message: 'This is a dummy route' });
});
app.post('/api/items/assessments/', (req, res) => {
  res.json({ message: 'This is a dummy route' });
});
app.post('/api/v1/assessment/questions/', (req, res) => {
  res.json({ message: 'This is a dummy route' });
});

// Database connection
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true, 
  useUnifiedTopology: true
}).then(() => {
  console.log('MongoDB connected');
}).catch(err => {
  console.error('MongoDB connection error:', err);
});

// Public route
app.get('/', (req, res) => {
  res.send('Welcome to LMS Engine!');
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});