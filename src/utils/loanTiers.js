// src/utils/loanTiers.js

// Keep symbolic constants so it's easy to change later.
const MIN_LOAN_AMOUNT = 1;        // dollars
const MAX_LOAN_AMOUNT = 250000;   // dollars

/** True if amount is a finite number in allowed range. */
function isValidAmount(n) {
  const x = Number(n);
  return Number.isFinite(x) && x >= MIN_LOAN_AMOUNT && x <= MAX_LOAN_AMOUNT;
}

/** Backwards compat export names so other modules don't break */
module.exports = {
  // no fixed tiers anymore, but keep the name to avoid runtime breaks
  ALLOWED_AMOUNTS: [],
  isAllowedAmount: isValidAmount,
  isValidAmount,
  MIN_LOAN_AMOUNT,
  MAX_LOAN_AMOUNT,
};
