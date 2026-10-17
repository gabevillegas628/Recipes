-- CreateTable
CREATE TABLE "FinanceWatch" (
    "categoryId" TEXT NOT NULL,
    "target" DECIMAL(14,2) NOT NULL,
    "start" DECIMAL(14,2) NOT NULL,
    "months" INTEGER NOT NULL,
    "startMonth" TEXT NOT NULL,
    "pausedSince" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceWatch_pkey" PRIMARY KEY ("categoryId")
);

-- AddForeignKey
ALTER TABLE "FinanceWatch" ADD CONSTRAINT "FinanceWatch_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "FinanceCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

