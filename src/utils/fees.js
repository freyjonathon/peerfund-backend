// utils/fees.js
const PEERFUND_FEE_RATE = 0.02; // 2%
const BANKING_FEE_RATE = 0.05;  // 5%

function calcFees(baseAmount) {
  const peerfundFee = Number((baseAmount * PEERFUND_FEE_RATE).toFixed(2));
  const bankingFee = Number((baseAmount * BANKING_FEE_RATE).toFixed(2));
  const totalFees = Number((peerfundFee + bankingFee).toFixed(2));
  const totalCharge = Number((baseAmount + totalFees).toFixed(2));

  return { peerfundFee, bankingFee, totalFees, totalCharge };
}

function computePlatformFeeCentsFromBase(baseAmountDollars, borrower, lender) {
  const { peerfundFee } = calcFees(baseAmountDollars);

  // If borrower is superuser → waive entirely
  if (borrower?.isSuperUser) return 0;

  // If lender is superuser → 50% discount on platform fee
  const adjustedFee = lender?.isSuperUser
    ? peerfundFee * 0.5
    : peerfundFee;

  // Stripe requires integer cents
  return Math.round(adjustedFee * 100);
}

module.exports = {
  PEERFUND_FEE_RATE,
  BANKING_FEE_RATE,
  calcFees,
  computePlatformFeeCentsFromBase,
};
