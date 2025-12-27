// src/controllers/directRequestController.js
const prisma = require('../utils/prisma');

/**
 * Helpers
 */
function ensureUserIsParty(reqDoc, userId) {
  return reqDoc && (reqDoc.borrowerId === userId || reqDoc.lenderId === userId);
}

async function validateAgainstLenderTerms(lenderId, amount, apr) {
  const lender = await prisma.user.findUnique({
    where: { id: String(lenderId) },
    select: { lendingTerms: true },
  });
  if (!lender) return { ok: false, message: 'Lender not found' };

  const key = String(Number(amount));
  const row = lender.lendingTerms?.[key];
  if (!row?.enabled) return { ok: false, message: 'This amount is not offered by the lender' };

  const allowedApr = Number(row.rate);
  if (!Number.isFinite(allowedApr)) {
    return { ok: false, message: 'Lender APR config invalid for this amount' };
  }
  if (apr != null) {
    const nApr = Number(apr);
    if (!Number.isFinite(nApr)) return { ok: false, message: 'Invalid APR' };
    if (nApr !== allowedApr) return { ok: false, message: 'APR not allowed for selected amount' };
  }
  // If apr not supplied, caller may derive from terms
  return { ok: true, allowedApr };
}

/**
 * POST /api/direct-requests
 * Borrower creates a PENDING direct request.
 */
exports.createDirectRequest = async (req, res) => {
  try {
    const borrowerId = req.user.userId;
    const { lenderId, amount, months, apr: aprFromBody, notes = '', listingId = null } = req.body || {};

    if (!lenderId || amount == null) {
      return res.status(400).json({ message: 'lenderId and amount are required' });
    }
    if (String(lenderId) === String(borrowerId)) {
      return res.status(400).json({ message: 'Cannot request a loan from yourself' });
    }

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ message: 'Invalid amount' });
    }

    const m = Number(months);
    const safeMonths =
      Number.isFinite(m) && m >= 1 && m <= 12
        ? m
        : amt <= 100
        ? 1
        : amt <= 200
        ? 2
        : 3;

    const termsCheck = await validateAgainstLenderTerms(lenderId, amt, aprFromBody);
    if (!termsCheck.ok) return res.status(400).json({ message: termsCheck.message });

    const apr =
      aprFromBody != null ? Number(aprFromBody) : Number(termsCheck.allowedApr);

    const created = await prisma.directLoanRequest.create({
      data: {
        lenderId: String(lenderId),
        borrowerId: String(borrowerId),
        amount: amt,
        months: safeMonths,
        apr,
        notes,
        listingId: listingId ? String(listingId) : null,
        status: 'PENDING',
      },
      select: { id: true, status: true, amount: true, months: true, apr: true, lenderId: true, borrowerId: true, createdAt: true },
    });

    // Return { id } so the client can navigate
    return res.status(201).json({ id: created.id, request: created });
  } catch (e) {
    console.error('createDirectRequest error:', e);
    return res.status(500).json({ message: 'Failed to create request' });
  }
};

/**
 * POST /api/direct-requests/:id/counter
 * Either party proposes new terms; request stays PENDING (open).
 * Body may include: amount, months, apr, notes
 */
exports.counterDirectRequest = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { amount, months, apr, notes } = req.body || {};

    const reqDoc = await prisma.directLoanRequest.findUnique({ where: { id: String(id) } });
    if (!ensureUserIsParty(reqDoc, userId)) {
      return res.status(404).json({ message: 'Request not found' });
    }
    if (reqDoc.status !== 'PENDING') {
      return res.status(400).json({ message: 'Only PENDING requests can be countered' });
    }

    const next = {
      amount: reqDoc.amount,
      months: reqDoc.months,
      apr: reqDoc.apr,
      notes: reqDoc.notes || '',
    };

    if (amount != null) {
      const nAmt = Number(amount);
      if (!Number.isFinite(nAmt) || nAmt <= 0) return res.status(400).json({ message: 'Invalid amount' });
      next.amount = nAmt;
    }
    if (months != null) {
      const m = Number(months);
      if (!Number.isFinite(m) || m < 1 || m > 12) return res.status(400).json({ message: 'Invalid months' });
      next.months = m;
    }
    if (apr != null) {
      const a = Number(apr);
      if (!Number.isFinite(a) || a < 0) return res.status(400).json({ message: 'Invalid APR' });
      next.apr = a;
    }
    if (typeof notes === 'string') {
      next.notes = notes;
    }

    // Validate new terms against lender's allowed matrix
    const termsCheck = await validateAgainstLenderTerms(reqDoc.lenderId, next.amount, next.apr);
    if (!termsCheck.ok) return res.status(400).json({ message: termsCheck.message });

    // If client omitted apr but changed amount, snap apr to lender rate for that amount
    if (apr == null) {
      next.apr = Number(termsCheck.allowedApr);
    }

    const updated = await prisma.directLoanRequest.update({
      where: { id: String(id) },
      data: {
        amount: next.amount,
        months: next.months,
        apr: next.apr,
        notes: next.notes,
        status: 'PENDING', // stays open
        decidedAt: null,   // clear any prior decision metadata just in case
      },
      select: { id: true, status: true, amount: true, months: true, apr: true, notes: true, updatedAt: true },
    });

    return res.json({ ok: true, request: updated });
  } catch (e) {
    console.error('counterDirectRequest error:', e);
    return res.status(500).json({ message: 'Failed to counter request' });
  }
};

/**
 * POST /api/direct-requests/:id/approve
 * Lender accepts current terms -> create Loan + mark request APPROVED.
 */
exports.approveDirectRequest = async (req, res) => {
  try {
    const lenderId = req.user.userId;
    const { id } = req.params;

    const request = await prisma.directLoanRequest.findUnique({ where: { id: String(id) } });
    if (!request || request.lenderId !== lenderId) {
      return res.status(404).json({ message: 'Request not found' });
    }
    if (request.status !== 'PENDING') {
      return res.status(400).json({ message: 'Request not pending' });
    }

    // Create loan (Loan model requires disbursedAmount; has no status column)
    const loan = await prisma.loan.create({
      data: {
        amount: request.amount,
        interestRate: request.apr,
        duration: request.months,
        borrowerId: request.borrowerId,
        lenderId: request.lenderId,
        disbursedAmount: 0,
      },
      select: { id: true },
    });

    await prisma.directLoanRequest.update({
      where: { id: String(id) },
      data: { status: 'APPROVED', loanId: loan.id, decidedAt: new Date() },
    });

    return res.json({ ok: true, loanId: loan.id });
  } catch (err) {
    console.error('approveDirectRequest error:', err);
    return res.status(500).json({ message: 'Failed to approve request' });
  }
};

/**
 * POST /api/direct-requests/:id/decline
 * Lender declines -> mark DECLINED (closes thread)
 */
exports.declineDirectRequest = async (req, res) => {
  try {
    const lenderId = req.user.userId;
    const { id } = req.params;

    const request = await prisma.directLoanRequest.findUnique({ where: { id: String(id) } });
    if (!request || request.lenderId !== lenderId) {
      return res.status(404).json({ message: 'Request not found' });
    }
    if (request.status !== 'PENDING') {
      return res.status(400).json({ message: 'Request not pending' });
    }

    await prisma.directLoanRequest.update({
      where: { id: String(id) },
      data: { status: 'DECLINED', decidedAt: new Date() },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('declineDirectRequest error:', err);
    return res.status(500).json({ message: 'Failed to decline request' });
  }
};

/**
 * GET /api/direct-requests/:id
 * Detail view with the counterpart's basic info for UI header
 */
exports.getDirectRequestById = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const row = await prisma.directLoanRequest.findUnique({
      where: { id: String(id) },
      include: {
        borrower: { select: { id: true, name: true } },
        lender:   { select: { id: true, name: true } },
      },
    });

    if (!ensureUserIsParty(row, userId)) {
      return res.status(404).json({ message: 'Not found' });
    }
    return res.json(row);
  } catch (e) {
    console.error('getDirectRequestById error:', e);
    return res.status(500).json({ message: 'Failed to load request' });
  }
};

/**
 * GET /api/direct-requests/open/mine
 * "My Open Loan Requests" for current user (only PENDING)
 */
exports.listOpenForUser = async (req, res) => {
  try {
    const userId = req.user.userId;
    const rows = await prisma.directLoanRequest.findMany({
      where: {
        OR: [{ borrowerId: userId }, { lenderId: userId }],
        status: 'PENDING',
      },
      orderBy: { createdAt: 'desc' },
      include: {
        borrower: { select: { id: true, name: true } },
        lender:   { select: { id: true, name: true } },
      },
    });
    res.json(rows);
  } catch (e) {
    console.error('listOpenForUser error:', e);
    res.status(500).json({ message: 'Failed to load open requests' });
  }
};

/**
 * GET /api/direct-requests?role=borrower|lender (default borrower)
 * Historical/complete list for a role.
 */
exports.getMyDirectRequests = async (req, res) => {
  try {
    const userId = req.user.userId;
    const role = (req.query.role || 'borrower').toLowerCase();

    const where = role === 'lender' ? { lenderId: userId } : { borrowerId: userId };

    const items = await prisma.directLoanRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        borrower: { select: { id: true, name: true } },
        lender:   { select: { id: true, name: true } },
        listing:  { select: { apr: true } },
      },
    });

    return res.json({ role, items });
  } catch (err) {
    console.error('getMyDirectRequests error:', err);
    return res.status(500).json({ message: 'Failed to load requests' });
  }
};

/**
 * GET /api/direct-requests/mine
 * Convenience: returns both asBorrower/asLender buckets for dashboards
 */
exports.listMyDirectRequests = async (req, res) => {
  try {
    const userId = req.user.userId;
    const asBorrower = await prisma.directLoanRequest.findMany({
      where: { borrowerId: userId },
      include: {
        lender:   { select: { id: true, name: true } },
        borrower: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const asLender = await prisma.directLoanRequest.findMany({
      where: { lenderId: userId },
      include: {
        lender:   { select: { id: true, name: true } },
        borrower: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ asBorrower, asLender });
  } catch (e) {
    console.error('listMyDirectRequests error:', e);
    res.status(500).json({ message: 'Failed to load requests' });
  }
};
