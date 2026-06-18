// Application configuration.
// Credentials are loaded from the .env file (see .env.example).
require('dotenv').config();

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
