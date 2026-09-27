-- CreateTable
CREATE TABLE "GroceryAisle" (
    "name" TEXT NOT NULL,
    "aisle" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroceryAisle_pkey" PRIMARY KEY ("name")
);
