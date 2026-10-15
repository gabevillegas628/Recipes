-- CreateEnum
CREATE TYPE "FinanceKind" AS ENUM ('SPENDING', 'INCOME', 'TRANSFER', 'SAVING');

-- AlterTable
ALTER TABLE "FinanceTransaction" ADD COLUMN     "byHand" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "kind" "FinanceKind",
ADD COLUMN     "merchantKey" TEXT,
ADD COLUMN     "needsLook" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pairId" TEXT;

-- CreateTable
CREATE TABLE "FinanceCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fixed" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "FinanceCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceMerchant" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "FinanceKind",
    "categoryId" TEXT,
    "unsure" BOOLEAN NOT NULL DEFAULT false,
    "byHand" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceMerchant_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinanceCategory_name_key" ON "FinanceCategory"("name");

-- CreateIndex
CREATE INDEX "FinanceMerchant_name_idx" ON "FinanceMerchant"("name");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceTransaction_pairId_key" ON "FinanceTransaction"("pairId");

-- CreateIndex
CREATE INDEX "FinanceTransaction_merchantKey_idx" ON "FinanceTransaction"("merchantKey");

-- AddForeignKey
ALTER TABLE "FinanceTransaction" ADD CONSTRAINT "FinanceTransaction_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "FinanceCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceMerchant" ADD CONSTRAINT "FinanceMerchant_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "FinanceCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Starting categories; edited in Settings → Money.
INSERT INTO "FinanceCategory" ("id", "name", "fixed", "position") VALUES
  ('cat_housing', 'Housing', true, 0),
  ('cat_utilities', 'Utilities', true, 1),
  ('cat_insurance', 'Insurance', true, 2),
  ('cat_car_payments', 'Car payments', true, 3),
  ('cat_subscriptions', 'Subscriptions', true, 4),
  ('cat_childcare_school', 'Childcare & school', true, 5),
  ('cat_groceries', 'Groceries', false, 6),
  ('cat_dining_out', 'Dining out', false, 7),
  ('cat_gas_car', 'Gas & car', false, 8),
  ('cat_amazon', 'Amazon', false, 9),
  ('cat_shopping', 'Shopping', false, 10),
  ('cat_kids', 'Kids', false, 11),
  ('cat_health', 'Health', false, 12),
  ('cat_home_garden', 'Home & garden', false, 13),
  ('cat_personal_care', 'Personal care', false, 14),
  ('cat_entertainment', 'Entertainment', false, 15),
  ('cat_travel', 'Travel', false, 16),
  ('cat_gifts_donations', 'Gifts & donations', false, 17),
  ('cat_other', 'Other', false, 18);
