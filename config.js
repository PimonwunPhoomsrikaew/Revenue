// Application configuration.
// Credentials are loaded from the .env file (see .env.example).
// Load .env from this file's own directory so it is found both when run from
// source and when packaged inside the Electron app (asar) as a portable .exe.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

module.exports = {
  port: process.env.PORT || 3000,
  sessionSecret: process.env.SESSION_SECRET || 'jhcis-dashboard-secret-change-me',

  // Login credentials for the web app.
  appUser: process.env.APP_USER,
  appPass: process.env.APP_PASS,

  // JHCIS MySQL connection.
  db: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectTimeout: 10000,
    dateStrings: true,
    waitForConnections: true,
    connectionLimit: 5,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
  },
};
