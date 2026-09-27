-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isAdmin" BOOLEAN NOT NULL DEFAULT false;

-- Everyone who exists when admin roles are introduced set the app up, so they're admins.
UPDATE "User" SET "isAdmin" = true;
