-- AlterTable
ALTER TABLE "GoogleConnection" ADD COLUMN     "remindersCalendarId" TEXT,
ADD COLUMN     "remindersCalendarName" TEXT,
ADD COLUMN     "remindersColor" TEXT;

-- AlterTable
ALTER TABLE "Note" ADD COLUMN     "googleCalendarId" TEXT;

-- Events written so far are all on the one chosen calendar.
UPDATE "Note" SET "googleCalendarId" = (SELECT "calendarId" FROM "GoogleConnection" WHERE "id" = 'default')
WHERE "googleEventId" IS NOT NULL;
