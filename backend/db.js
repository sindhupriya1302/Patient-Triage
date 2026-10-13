const mongoose = require('mongoose');

const DEFAULT_URI = 'mongodb://127.0.0.1:27017/patient_triage';

async function connectDB() {
  const uri = process.env.MONGODB_URI || DEFAULT_URI;
  try {
    await mongoose.connect(uri);
    console.log(`[OK] MongoDB connected (${uri.includes('mongodb+srv') ? 'Atlas' : uri})`);
  } catch (err) {
    console.error('[ERROR] Could not connect to MongoDB.');
    console.error(`   Tried: ${uri}`);
    console.error('   * If you are running locally, make sure mongod is started.');
    console.error('   * If you are using Atlas, check MONGODB_URI in your .env file.');
    console.error(`   Raw error: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { connectDB };
