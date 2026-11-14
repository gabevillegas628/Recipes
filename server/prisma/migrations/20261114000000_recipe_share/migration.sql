-- AlterTable
ALTER TABLE "Recipe" ADD COLUMN "shareToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Recipe_shareToken_key" ON "Recipe"("shareToken");
