// utils/fees.js

// Existing loan/repayment fee rates
const PEERFUND_FEE_RATE = 0.02; // 2%
const BANKING_FEE_RATE = 0.05;  // 5%

// Card deposit processing estimate
const STRIPE_CARD_PERCENT = 0.029; // 2.9%
const STRIPE_CARD_FIXED_CENTS = 30;

// Set PeerFund deposit fee here.
// Use 0 for now if you only want users to cover Stripe fees.
const PEERFUND_DEPOSIT_FEE_RATE = 0.01; // 1%

function calcFees(baseAmount) {
  const peerfundFee = Number((baseAmount * PEERFUND_FEE_RATE).toFixed(2));
  const bankingFee = Number((baseAmount * BANKING_FEE_RATE).toFixed(2));
  const totalFees = Number((peerfundFee + bankingFee).toFixed(2));
  const totalCharge = Number((baseAmount + totalFees).toFixed(2));

  return { peerfundFee, bankingFee, totalFees, totalCharge };
}

function computePlatformFeeCentsFromBase(baseAmountDollars, borrower, lender) {
  const { peerfundFee } = calcFees(baseAmountDollars);

  if (borrower?.isSuperUser) return 0;

  const adjustedFee = lender?.isSuperUser
    ? peerfundFee * 0.5
    : peerfundFee;

  return Math.round(adjustedFee * 100);
}

function dollarsToCents(amountDollars) {
  return Math.round(Number(amountDollars) * 100);
}

function centsToDollars(cents) {
  return Number((Number(cents || 0) / 100).toFixed(2));
}

function grossUpForCardDeposit(netCents) {
  const totalPercent = STRIPE_CARD_PERCENT + PEERFUND_DEPOSIT_FEE_RATE;

  const grossCents = Math.ceil(
    (netCents + STRIPE_CARD_FIXED_CENTS) / (1 - totalPercent)
  );

  const estimatedStripeFeeCents = Math.ceil(
    grossCents * STRIPE_CARD_PERCENT + STRIPE_CARD_FIXED_CENTS
  );

  const peerfundFeeCents = Math.max(
    0,
    grossCents - netCents - estimatedStripeFeeCents
  );

  return {
    netCents,
    grossCents,
    estimatedStripeFeeCents,
    peerfundFeeCents,
    totalFeeCents: grossCents - netCents,
  };
}

module.exports = {
  PEERFUND_FEE_RATE,
  BANKING_FEE_RATE,
  STRIPE_CARD_PERCENT,
  STRIPE_CARD_FIXED_CENTS,
  PEERFUND_DEPOSIT_FEE_RATE,
  calcFees,
  computePlatformFeeCentsFromBase,
  dollarsToCents,
  centsToDollars,
  grossUpForCardDeposit,
};