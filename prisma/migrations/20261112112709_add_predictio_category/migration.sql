-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PredictionCategory" ADD VALUE 'POLITICS';
ALTER TYPE "PredictionCategory" ADD VALUE 'TECH_AI';
ALTER TYPE "PredictionCategory" ADD VALUE 'POP_CULTURE';
ALTER TYPE "PredictionCategory" ADD VALUE 'SCIENCE';
ALTER TYPE "PredictionCategory" ADD VALUE 'GLOBAL_AFFAIRS';
ALTER TYPE "PredictionCategory" ADD VALUE 'ENTERTAINMENT';
ALTER TYPE "PredictionCategory" ADD VALUE 'ECONOMY';
