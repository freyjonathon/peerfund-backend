/*
  Warnings:

  - The primary key for the `LenderProfile` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `duration` on the `LenderProfile` table. All the data in the column will be lost.
  - You are about to drop the column `interestRate` on the `LenderProfile` table. All the data in the column will be lost.
  - You are about to drop the column `loanPurposes` on the `LenderProfile` table. All the data in the column will be lost.
  - You are about to drop the column `maxAmount` on the `LenderProfile` table. All the data in the column will be lost.
  - Added the required column `maxLoanAmount` to the `LenderProfile` table without a default value. This is not possible if the table is not empty.
  - Added the required column `name` to the `LenderProfile` table without a default value. This is not possible if the table is not empty.
  - Added the required column `duration` to the `LoanRequest` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "LoanOffer" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "lenderId" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "interestRate" REAL NOT NULL,
    "termMonths" INTEGER NOT NULL,
    CONSTRAINT "LoanOffer_lenderId_fkey" FOREIGN KEY ("lenderId") REFERENCES "LenderProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LenderProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "maxLoanAmount" INTEGER NOT NULL,
    "interestRateLow" REAL,
    "interestRateHigh" REAL,
    "purposes" TEXT,
    "location" TEXT,
    "summary" TEXT,
    CONSTRAINT "LenderProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_LenderProfile" ("id", "userId") SELECT "id", "userId" FROM "LenderProfile";
DROP TABLE "LenderProfile";
ALTER TABLE "new_LenderProfile" RENAME TO "LenderProfile";
CREATE UNIQUE INDEX "LenderProfile_userId_key" ON "LenderProfile"("userId");
CREATE TABLE "new_LoanRequest" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "amount" REAL NOT NULL,
    "reason" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "borrowerId" INTEGER NOT NULL,
    CONSTRAINT "LoanRequest_borrowerId_fkey" FOREIGN KEY ("borrowerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_LoanRequest" ("amount", "borrowerId", "id", "reason") SELECT "amount", "borrowerId", "id", "reason" FROM "LoanRequest";
DROP TABLE "LoanRequest";
ALTER TABLE "new_LoanRequest" RENAME TO "LoanRequest";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
