-- AlterTable
ALTER TABLE "ClosetChatThread" ADD COLUMN     "hiddenBy" TEXT[] DEFAULT ARRAY[]::TEXT[];
