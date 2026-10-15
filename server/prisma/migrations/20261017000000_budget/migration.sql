-- CreateTable
CREATE TABLE "FinanceBudgetSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "income" DECIMAL(14,2),
    "saving" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceBudgetSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceBudget" (
    "categoryId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceBudget_pkey" PRIMARY KEY ("categoryId")
);

-- CreateTable
CREATE TABLE "FinanceBill" (
    "name" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "categoryId" TEXT,
    "amount" DECIMAL(14,2),
    "day" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceBill_pkey" PRIMARY KEY ("name")
);

-- AddForeignKey
ALTER TABLE "FinanceBudget" ADD CONSTRAINT "FinanceBudget_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "FinanceCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

