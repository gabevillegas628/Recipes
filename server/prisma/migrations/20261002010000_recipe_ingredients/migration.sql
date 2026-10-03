-- CreateTable
CREATE TABLE "RecipeIngredients" (
    "recipeId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "main" BOOLEAN NOT NULL DEFAULT true,
    "items" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipeIngredients_pkey" PRIMARY KEY ("recipeId")
);

-- AddForeignKey
ALTER TABLE "RecipeIngredients" ADD CONSTRAINT "RecipeIngredients_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
