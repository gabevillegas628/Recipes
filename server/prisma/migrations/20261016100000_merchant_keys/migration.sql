-- Merchants were keyed by SimpleFIN's payee when there was one, which is too
-- coarse ("Capital One" for card payments and the auto loan alike). Re-key
-- those transactions from their descriptions (classify.ts does it on startup),
-- and drop AI-read merchants nothing uses any more. Merchants set by hand stay,
-- so new merchants with the same name inherit those choices.
UPDATE "FinanceTransaction" SET "merchantKey" = NULL WHERE "payee" IS NOT NULL;

DELETE FROM "FinanceMerchant" m
WHERE NOT m."byHand"
  AND NOT EXISTS (SELECT 1 FROM "FinanceTransaction" t WHERE t."merchantKey" = m."key");

-- A fixed "Loans" category (student loans and the like), after Car payments.
UPDATE "FinanceCategory" SET "position" = "position" + 1
WHERE "position" > (SELECT "position" FROM "FinanceCategory" WHERE "name" = 'Car payments')
  AND NOT EXISTS (SELECT 1 FROM "FinanceCategory" WHERE lower("name") = 'loans');
INSERT INTO "FinanceCategory" ("id", "name", "fixed", "position")
SELECT 'cat_loans', 'Loans', true, COALESCE((SELECT "position" + 1 FROM "FinanceCategory" WHERE "name" = 'Car payments'), 0)
WHERE NOT EXISTS (SELECT 1 FROM "FinanceCategory" WHERE lower("name") = 'loans');

-- Merchants the AI put in Other get a second read now that Loans exists. Ones set by hand stay.
DELETE FROM "FinanceMerchant" WHERE NOT "byHand" AND "categoryId" = 'cat_other';
