/*
  Warnings:

  - You are about to drop the column `costMinor` on the `call_legs` table. All the data in the column will be lost.
  - You are about to drop the column `costMinor` on the `calls` table. All the data in the column will be lost.
  - You are about to drop the column `amountMinor` on the `usage_ledger_entries` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "call_legs" DROP COLUMN "costMinor",
ADD COLUMN     "costMicros" BIGINT;

-- AlterTable
ALTER TABLE "calls" DROP COLUMN "costMinor",
ADD COLUMN     "costMicros" BIGINT;

-- AlterTable
ALTER TABLE "usage_ledger_entries" DROP COLUMN "amountMinor",
ADD COLUMN     "amountMicros" BIGINT;
