-- CreateTable
CREATE TABLE "HouseholdPerson" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" TEXT[],
    "adult" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "HouseholdPerson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Household" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "schoolStart" TEXT,
    "schoolEnd" TEXT,
    "travelMinutes" INTEGER NOT NULL DEFAULT 45,
    "hoursStart" TEXT NOT NULL DEFAULT '08:00',
    "hoursEnd" TEXT NOT NULL DEFAULT '17:00',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Household_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventTag" (
    "title" TEXT NOT NULL,
    "people" TEXT[],
    "everyone" BOOLEAN NOT NULL DEFAULT false,
    "unsure" BOOLEAN NOT NULL DEFAULT false,
    "byHand" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventTag_pkey" PRIMARY KEY ("title")
);

-- The family's school hours and the defaults agreed for finding times.
INSERT INTO "Household" ("id", "schoolStart", "schoolEnd", "travelMinutes", "hoursStart", "hoursEnd", "updatedAt")
VALUES ('default', '07:20', '14:50', 45, '08:00', '17:00', CURRENT_TIMESTAMP);
