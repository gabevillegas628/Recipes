-- CreateTable
CREATE TABLE "FinanceRecap" (
    "month" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "points" TEXT[],
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceRecap_pkey" PRIMARY KEY ("month")
);

