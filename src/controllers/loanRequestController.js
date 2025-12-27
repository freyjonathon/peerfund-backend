// src/controllers/loanRequestController.js
const prisma = require('../utils/prisma');
const { ALLOWED_AMOUNTS, isAllowedAmount } = require('../utils/loanTiers');

// 2. Get all open loan requests
exports.getOpenLoanRequests = async (req, res) => {
  try {
    const openLoanRequests = await prisma.loanRequest.findMany({
      where: { status: 'OPEN' },
      include: {
        borrower: {
          select: {
            id: true,
            name: true,
            location: true,
            // bank: { select: { name: true } },
            // loansGiven: { select: { id: true } },
            // loansReceived: { select: { id: true } },
            // maxLoanAmount: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(openLoanRequests);
  } catch (err) {
    console.error('Error fetching open loan requests:', err);
    res.status(500).json({ error: 'Failed to fetch loan requests' });
  }
};

// 3. Create a new loan request (POST from frontend)
exports.createLoanRequest = async (req, res) => {
  const userId = req.user.userId;
  const { amount, duration, interestRate, purpose } = req.body;

  try {
    // ✅ Gate: require verified docs + admin approval
    /*const check = await getVerificationChecklist(userId);
    if (!check.ok) {
      return res.status(403).json({
        error: 'Verification required before requesting a loan.',
        checklist: check, // { ok, status, hasPhotoId, paystubCount, requiredPaystubs, missing: [...] }
        howToFix: 'Upload an updated Photo ID and three recent paystubs, then wait for admin approval.',
      });
    }
    */
   
    // Coerce inputs safely
    const amt = Number(amount);
    const dur = Number.parseInt(duration, 10);
    const rate = Number(interestRate);

    // Validate amount is one of the allowed tiers
    if (!isAllowedAmount(amt)) {
      return res.status(400).json({
        error: `Amount must be one of: ${ALLOWED_AMOUNTS.join(', ')}`,
      });
    }

    // (Optional but sensible) validate other fields
    if (!Number.isInteger(dur) || dur <= 0) {
      return res.status(400).json({ error: 'Duration must be a positive integer (months).' });
    }
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      return res.status(400).json({ error: 'Interest rate must be between 0 and 100%.' });
    }

    // Fetch user (for superuser info returned in response)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { isSuperUser: true },
    });

    const loanRequest = await prisma.loanRequest.create({
      data: {
        borrowerId: userId,
        amount: amt,          // canonical tier value
        duration: dur,
        interestRate: rate,
        purpose: (purpose || '').trim(),
        status: 'OPEN',
      },
    });

    res.status(201).json({
      message: 'Loan request created',
      loanRequest,
      isSuperUser: !!user?.isSuperUser,
      peerFundFee: user?.isSuperUser
        ? 0
        : `${(amt * 0.01).toFixed(2)} (1% PeerFund Fee Estimate)`,
    });
  } catch (err) {
    console.error('❌ Error creating loan request:', err);
    res.status(500).json({ error: 'Failed to create loan request' });
  }
};


// (Optional) Update loan request — if you add an edit feature, keep enforcement here too.
exports.updateLoanRequest = async (req, res) => {
  const { loanId } = req.params;
  const userId = req.user.userId;
  const { amount, duration, interestRate, purpose, status } = req.body;

  try {
    // Only allow borrower to update their own open request (adjust to your rules)
    const existing = await prisma.loanRequest.findUnique({
      where: { id: loanId },
      select: { borrowerId: true, status: true },
    });
    if (!existing) return res.status(404).json({ error: 'Loan request not found' });
    if (existing.borrowerId !== userId) return res.status(403).json({ error: 'Not authorized' });
    if (existing.status !== 'OPEN') return res.status(400).json({ error: 'Only OPEN requests can be updated' });

    const data = {};

    if (amount != null) {
      const amt = Number(amount);
      if (!isAllowedAmount(amt)) {
        return res.status(400).json({ error: `Amount must be one of: ${ALLOWED_AMOUNTS.join(', ')}` });
      }
      data.amount = amt;
    }

    if (duration != null) {
      const dur = Number.parseInt(duration, 10);
      if (!Number.isInteger(dur) || dur <= 0) {
        return res.status(400).json({ error: 'Duration must be a positive integer (months).' });
      }
      data.duration = dur;
    }

    if (interestRate != null) {
      const rate = Number(interestRate);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        return res.status(400).json({ error: 'Interest rate must be between 0 and 100%.' });
      }
      data.interestRate = rate;
    }

    if (purpose != null) data.purpose = String(purpose).trim();
    if (status != null) data.status = status; // optionally restrict allowed status transitions

    const updated = await prisma.loanRequest.update({
      where: { id: loanId },
      data,
    });

    res.json(updated);
  } catch (err) {
    console.error('❌ Error updating loan request:', err);
    res.status(500).json({ error: 'Failed to update loan request' });
  }
};

// Get detailed loan request with messages and offers
exports.getLoanDetails = async (req, res) => {
  const { loanId } = req.params;

  try {
    const loanRequest = await prisma.loanRequest.findUnique({
      where: { id: loanId },
      include: {
        borrower: {
          select: {
            id: true,
            name: true,
            location: true,
            isSuperUser: true, // ✅ include superuser status
          },
        },
        messages: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        loanOffers: {
          include: {
            lender: {
              select: {
                id: true,
                name: true,
                isSuperUser: true, // ✅ include superuser status
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!loanRequest) {
      return res.status(404).json({ error: 'Loan not found' });
    }

    res.status(200).json(loanRequest);
  } catch (err) {
    console.error('Error fetching loan details:', err);
    res.status(500).json({ error: 'Failed to fetch loan details' });
  }
};
