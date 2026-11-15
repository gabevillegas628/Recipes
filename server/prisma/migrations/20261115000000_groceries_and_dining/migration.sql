-- Groceries and Dining out become one category, "Groceries & dining": takeout and restaurants
-- stand in for cooking, so they're one budget. Big outings (birthdays) are marked as one-offs.
-- Matched by the starting id or by name, in case either was renamed or re-created in Settings.
DO $$
DECLARE
  keep TEXT;
  gone TEXT;
  keep_budget DECIMAL(14, 2);
  gone_budget DECIMAL(14, 2);
BEGIN
  SELECT "id" INTO keep FROM "FinanceCategory"
    WHERE "id" = 'cat_groceries' OR lower("name") = 'groceries'
    ORDER BY ("id" = 'cat_groceries') DESC LIMIT 1;
  SELECT "id" INTO gone FROM "FinanceCategory"
    WHERE "id" = 'cat_dining_out' OR lower("name") IN ('dining out', 'dining')
    ORDER BY ("id" = 'cat_dining_out') DESC LIMIT 1;

  IF keep IS NULL AND gone IS NULL THEN
    RETURN;
  END IF;
  -- Only one of them left: rename it and stop.
  IF keep IS NULL OR gone IS NULL OR keep = gone THEN
    UPDATE "FinanceCategory" SET "name" = 'Groceries & dining', "fixed" = false
      WHERE "id" = COALESCE(keep, gone)
        AND NOT EXISTS (SELECT 1 FROM "FinanceCategory" WHERE "name" = 'Groceries & dining');
    RETURN;
  END IF;

  UPDATE "FinanceTransaction" SET "categoryId" = keep WHERE "categoryId" = gone;
  UPDATE "FinanceMerchant" SET "categoryId" = keep WHERE "categoryId" = gone;
  UPDATE "FinanceBill" SET "categoryId" = keep WHERE "categoryId" = gone;

  -- A typed-in budget only carries over when both had one (their sum). With just one, the
  -- merged category falls back to its usual month, which already counts both.
  SELECT "amount" INTO keep_budget FROM "FinanceBudget" WHERE "categoryId" = keep;
  SELECT "amount" INTO gone_budget FROM "FinanceBudget" WHERE "categoryId" = gone;
  IF keep_budget IS NOT NULL AND gone_budget IS NOT NULL THEN
    UPDATE "FinanceBudget" SET "amount" = keep_budget + gone_budget, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "categoryId" = keep;
  ELSE
    DELETE FROM "FinanceBudget" WHERE "categoryId" = keep;
  END IF;

  -- Same for a watch: both watched adds up their starts and targets; one alone would be
  -- measured against the other's spending too, so it's dropped (start a new one on the merged category).
  IF EXISTS (SELECT 1 FROM "FinanceWatch" WHERE "categoryId" = keep)
     AND EXISTS (SELECT 1 FROM "FinanceWatch" WHERE "categoryId" = gone) THEN
    UPDATE "FinanceWatch" k SET
      "start" = k."start" + g."start",
      "target" = CASE WHEN k."target" IS NULL OR g."target" IS NULL THEN NULL ELSE k."target" + g."target" END,
      "updatedAt" = CURRENT_TIMESTAMP
      FROM "FinanceWatch" g
      WHERE k."categoryId" = keep AND g."categoryId" = gone;
  ELSE
    DELETE FROM "FinanceWatch" WHERE "categoryId" = keep;
  END IF;

  -- Cascades the old category's budget and watch.
  DELETE FROM "FinanceCategory" WHERE "id" = gone;
  UPDATE "FinanceCategory" SET "name" = 'Groceries & dining', "fixed" = false
    WHERE "id" = keep
      AND NOT EXISTS (SELECT 1 FROM "FinanceCategory" WHERE "name" = 'Groceries & dining');
END $$;
