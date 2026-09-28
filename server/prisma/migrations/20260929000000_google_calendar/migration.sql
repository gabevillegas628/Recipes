-- AlterTable
ALTER TABLE "Note" ADD COLUMN     "googleEventId" TEXT,
ADD COLUMN     "syncError" TEXT,
ADD COLUMN     "syncPending" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "GoogleConnection" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "email" TEXT,
    "refreshToken" TEXT NOT NULL,
    "calendarId" TEXT,
    "calendarName" TEXT,
    "appUrl" TEXT NOT NULL,
    "error" TEXT,
    "connectedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Note_syncPending_idx" ON "Note"("syncPending");

-- AddForeignKey
ALTER TABLE "GoogleConnection" ADD CONSTRAINT "GoogleConnection_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
