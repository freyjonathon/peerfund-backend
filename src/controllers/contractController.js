const prisma = require('../utils/prisma');

// GET: fetch a document by ID
exports.getDocumentById = async (req, res) => {
  const { documentId } = req.params;
  const userId = req.user.userId;

  try {
    const doc = await prisma.document.findUnique({
      where: { id: documentId, userId },
    });

    if (!doc) return res.status(404).json({ error: 'Document not found' });

    res.status(200).json(doc);
  } catch (err) {
    console.error('Error fetching document:', err);
    res.status(500).json({ error: 'Could not fetch document' });
  }
};

// POST: create a contract document
exports.createContract = async (req, res) => {
  const { loanId, title, content } = req.body;
  const userId = req.user.userId;

  if (!loanId || !title || !content) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const loan = await prisma.loan.findUnique({
      where: { id: loanId },
      include: {
        borrower: { select: { isSuperUser: true, name: true } },
        lender: { select: { name: true } },
      },
    });

    if (!loan) return res.status(404).json({ error: 'Loan not found' });

    const peerFundFeePercent = loan.borrower.isSuperUser ? 0 : 1;
    const bankFeePercent = 1;

    const fullText = `
      LOAN AGREEMENT

      Loan Title: ${title}

      Borrower: ${loan.borrower.name}
      Lender: ${loan.lender.name}

      --- FEES PAID BY BORROWER ---
      - Bank Fee (1%): ${bankFeePercent}%
      - PeerFund Fee (1%): ${peerFundFeePercent}%

      -----------------------------

      TERMS:
      ${content}
    `;

    const contract = await prisma.document.create({
      data: {
        userId,
        loanId,
        title,
        type: 'contract',
        mimeType: 'text/plain',
        fileName: `${title.replace(/\s+/g, '_')}_contract.txt`,
        content: Buffer.from(fullText),
      },
    });

    res.status(201).json(contract);
  } catch (err) {
    console.error('❌ Error creating contract:', err);
    res.status(500).json({ error: 'Could not create contract' });
  }
};
