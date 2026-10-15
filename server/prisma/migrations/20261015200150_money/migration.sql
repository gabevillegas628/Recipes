-- CreateEnum
CREATE TYPE "FinanceAccountKind" AS ENUM ('CHECKING', 'SAVINGS', 'CREDIT_CARD', 'LOAN', 'INVESTMENT', 'OTHER');

-- CreateTable
CREATE TABLE "FinanceConnection" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "accessUrl" TEXT NOT NULL,
    "error" TEXT,
    "warnings" TEXT[],
    "lastSyncAt" TIMESTAMP(3),
    "backfilledAt" TIMESTAMP(3),
    "connectedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceAccount" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "FinanceAccountKind" NOT NULL,
    "kindByHand" BOOLEAN NOT NULL DEFAULT false,
    "balance" DECIMAL(14,2) NOT NULL,
    "availableBalance" DECIMAL(14,2),
    "balanceDate" TIMESTAMP(3) NOT NULL,
    "holdings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceTransaction" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "transactedAt" TIMESTAMP(3) NOT NULL,
    "postedAt" TIMESTAMP(3),
    "amount" DECIMAL(14,2) NOT NULL,
    "description" TEXT NOT NULL,
    "payee" TEXT,
    "memo" TEXT,
    "pending" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'simplefin',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceBalance" (
    "accountId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "balance" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "FinanceBalance_pkey" PRIMARY KEY ("accountId","date")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinanceAccount_externalId_key" ON "FinanceAccount"("externalId");

-- CreateIndex
CREATE INDEX "FinanceTransaction_transactedAt_idx" ON "FinanceTransaction"("transactedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceTransaction_accountId_externalId_key" ON "FinanceTransaction"("accountId", "externalId");

-- AddForeignKey
ALTER TABLE "FinanceConnection" ADD CONSTRAINT "FinanceConnection_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceTransaction" ADD CONSTRAINT "FinanceTransaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "FinanceAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceBalance" ADD CONSTRAINT "FinanceBalance_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "FinanceAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
