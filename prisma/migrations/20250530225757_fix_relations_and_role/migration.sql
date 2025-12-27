-- CreateTable
CREATE TABLE "LenderProfile" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "maxAmount" REAL NOT NULL,
    "interestRate" REAL NOT NULL,
    "duration" INTEGER NOT NULL,
    "loanPurposes" TEXT NOT NULL,
    CONSTRAINT "LenderProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "LenderProfile_userId_key" ON "LenderProfile"("userId");
