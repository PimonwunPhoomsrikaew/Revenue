// Application configuration.
// Credentials are loaded from the .env file (see .env.example).
// Load .env from this file's own directory so it is found both when run from
// source and when packaged inside the Electron app (asar) as a portable .exe.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Each JHCIS branch is one web-app login mapped to its own MySQL database.
// BRANCH_CODES lists every branch's code; each code needs a matching block
// of BRANCH_<code>_* vars in .env. Whichever branch's user logs in, the app
// talks only to that branch's database for the rest of the session.
const branchCodes = (process.env.BRANCH_CODES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const branches = branchCodes.map((code) => {
  const prefix = `BRANCH_${code}_`;
  return {
    id: code,
    name: process.env[`${prefix}NAME`] || code,
    username: process.env[`${prefix}APP_USER`],
    password: process.env[`${prefix}APP_PASS`],
    db: {
      host: process.env[`${prefix}DB_HOST`],
      port: Number(process.env[`${prefix}DB_PORT`]) || 3306,
      user: process.env[`${prefix}DB_USER`],
      password: process.env[`${prefix}DB_PASSWORD`],
      database: process.env[`${prefix}DB_NAME`],
      connectTimeout: 10000,
      dateStrings: true,
      waitForConnections: true,
      connectionLimit: 5,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    },
  };
});

module.exports = {
  port: process.env.PORT || 3000,
  sessionSecret: process.env.SESSION_SECRET || 'jhcis-dashboard-secret-change-me',

  // All configured branches (web login + JHCIS MySQL connection, one per
  // branch). server.js matches the login form against these; db.js keeps one
  // connection pool per branch id.
  branches,
};
