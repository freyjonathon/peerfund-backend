// run-cron.js
const runAutoRepayments = require('./cron/processAutoRepayments');

runAutoRepayments()
  .then(() => {
    console.log('✅ Cron job complete');
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ Cron job failed:', err);
    process.exit(1);
  });
