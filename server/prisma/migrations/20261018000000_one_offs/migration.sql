-- AlterTable
ALTER TABLE "FinanceBudgetSettings" ADD COLUMN     "oneOffs" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "FinanceTransaction" ADD COLUMN     "oneOff" BOOLEAN;

