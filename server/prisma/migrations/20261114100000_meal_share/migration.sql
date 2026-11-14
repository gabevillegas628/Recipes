-- AlterTable
ALTER TABLE "Meal" ADD COLUMN "shareToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Meal_shareToken_key" ON "Meal"("shareToken");
