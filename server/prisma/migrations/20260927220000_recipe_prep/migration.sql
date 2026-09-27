-- CreateTable
CREATE TABLE "RecipePrep" (
    "recipeId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipePrep_pkey" PRIMARY KEY ("recipeId")
);

-- AddForeignKey
ALTER TABLE "RecipePrep" ADD CONSTRAINT "RecipePrep_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
