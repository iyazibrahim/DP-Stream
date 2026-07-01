require('dotenv').config();
const { runMigrations } = require('../services/migrationService');

runMigrations()
  .then(() => {
    console.log('Migrations complete.');
  })
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
