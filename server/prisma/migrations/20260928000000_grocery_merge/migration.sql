-- AlterTable
ALTER TABLE "GroceryItem" ADD COLUMN     "name" TEXT;

-- AlterTable
ALTER TABLE "GroceryAisle" ADD COLUMN     "item" TEXT;

-- CreateTable
CREATE TABLE "GroceryTotal" (
    "name" TEXT NOT NULL,
    "sources" TEXT NOT NULL,
    "buy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroceryTotal_pkey" PRIMARY KEY ("name")
);
