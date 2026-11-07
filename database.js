const { Pool } = require('pg');

// Railway provides DATABASE_URL automatically
// For local dev, use your own PostgreSQL or keep SQLite for testing
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/agenda_app',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test connection
pool.on('connect', () => {
  console.log('Connected to PostgreSQL');
});

pool.on('error', (err) => {
  console.error('PostgreSQL error:', err);
});

// Initialize tables
async function init() {
  const client = await pool.connect();
  
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL,
        title VARCHAR(255) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agenda_items (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        date VARCHAR(10) NOT NULL,
        time VARCHAR(5) NOT NULL,
        description TEXT NOT NULL,
        room VARCHAR(255) DEFAULT '',
        is_done INTEGER DEFAULT 0,
        assigned_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS checkins (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        status VARCHAR(50) NOT NULL,
        date VARCHAR(10) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, date)
      );

      CREATE TABLE IF NOT EXISTS room_bookings (
        id SERIAL PRIMARY KEY,
        room_name VARCHAR(255) NOT NULL,
        user_id INTEGER REFERENCES users(id),
        date VARCHAR(10) NOT NULL,
        start_time VARCHAR(5) NOT NULL,
        end_time VARCHAR(5) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS booking_attendees (
        id SERIAL PRIMARY KEY,
        booking_id INTEGER REFERENCES room_bookings(id),
        user_id INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(booking_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        message TEXT NOT NULL,
        is_read INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS leave_requests (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        type VARCHAR(255) NOT NULL,
        start_date VARCHAR(10) NOT NULL,
        end_date VARCHAR(10) NOT NULL,
        status VARCHAR(50) DEFAULT 'Pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS visitors (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        host_id INTEGER REFERENCES users(id),
        status VARCHAR(50) DEFAULT 'Expected',
        date VARCHAR(10) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    console.log('PostgreSQL tables initialized');
  } finally {
    client.release();
  }
}

// Initialize on startup
init().catch(console.error);

// Helper to run queries
const db = {
  prepare: (text) => ({
    run: async (...params) => {
      const result = await pool.query(text, params);
      return { lastInsertRowid: result.rows[0]?.id, changes: result.rowCount };
    },
    get: async (...params) => {
      const result = await pool.query(text, params);
      return result.rows[0];
    },
    all: async (...params) => {
      const result = await pool.query(text, params);
      return result.rows;
    }
  }),
  exec: async (text) => {
    await pool.query(text);
  }
};

module.exports = db;