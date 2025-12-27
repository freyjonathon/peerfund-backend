const generateRepaymentSchedule = async (loan) => {
  const repaymentCount = loan.duration;
  const monthlyRate = loan.interestRate / 100 / 12;
  const amount = loan.amount;

  const monthlyPayment = (amount * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -repaymentCount));
  const repayments = [];

  let balance = amount;
  let currentDueDate = new Date();

  for (let i = 0; i < repaymentCount; i++) {
    const interest = balance * monthlyRate;
    const principal = monthlyPayment - interest;
    balance -= principal;

    currentDueDate.setMonth(currentDueDate.getMonth() + 1);

    repayments.push({
      dueDate: new Date(currentDueDate),
      amount: Number(monthlyPayment.toFixed(2)),
      amountDue: Number(monthlyPayment.toFixed(2)),
      amountPaid: 0,
      status: 'PENDING',
      loanId: loan.id,
    });
  }

  return repayments;
};

module.exports = { generateRepaymentSchedule };
