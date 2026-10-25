-- CreateEnum
CREATE TYPE "CoaType" AS ENUM ('ASET', 'KEWAJIBAN', 'EKUITAS', 'PENDAPATAN', 'BEBAN');

-- CreateEnum
CREATE TYPE "CashFlowSection" AS ENUM ('OPERASI', 'INVESTASI', 'PENDANAAN');

-- CreateEnum
CREATE TYPE "CashAccountKind" AS ENUM ('KAS', 'BANK');

-- CreateEnum
CREATE TYPE "CashDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('ENTRY', 'REVERSAL');

-- CreateEnum
CREATE TYPE "CashEntryStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "cashAccountId" UUID;

-- CreateTable
CREATE TABLE "coa_accounts" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CoaType" NOT NULL,
    "section" "CashFlowSection" NOT NULL DEFAULT 'OPERASI',
    "manualEntry" BOOLEAN NOT NULL DEFAULT false,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coa_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_accounts" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "CashAccountKind" NOT NULL,
    "coaAccountId" UUID NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "openingBalance" BIGINT NOT NULL DEFAULT 0,
    "openingDate" DATE NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cash_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_entries" (
    "id" UUID NOT NULL,
    "entryType" "LedgerEntryType" NOT NULL DEFAULT 'ENTRY',
    "reversesEntryId" UUID,
    "entryDate" DATE NOT NULL,
    "direction" "CashDirection" NOT NULL,
    "amount" BIGINT NOT NULL,
    "cashAccountId" UUID NOT NULL,
    "counterAccountId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "payee" TEXT,
    "reference" TEXT,
    "proofFileId" UUID,
    "status" "CashEntryStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "createdById" UUID NOT NULL,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "rejectedById" UUID,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_transfers" (
    "id" UUID NOT NULL,
    "entryType" "LedgerEntryType" NOT NULL DEFAULT 'ENTRY',
    "reversesTransferId" UUID,
    "transferDate" DATE NOT NULL,
    "fromAccountId" UUID NOT NULL,
    "toAccountId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "description" TEXT,
    "reference" TEXT,
    "reason" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "coa_accounts_code_key" ON "coa_accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "cash_accounts_name_key" ON "cash_accounts"("name");

-- CreateIndex
CREATE UNIQUE INDEX "cash_entries_reversesEntryId_key" ON "cash_entries"("reversesEntryId");

-- CreateIndex
CREATE INDEX "cash_entries_entryDate_idx" ON "cash_entries"("entryDate");

-- CreateIndex
CREATE INDEX "cash_entries_cashAccountId_idx" ON "cash_entries"("cashAccountId");

-- CreateIndex
CREATE INDEX "cash_entries_counterAccountId_idx" ON "cash_entries"("counterAccountId");

-- CreateIndex
CREATE INDEX "cash_entries_status_idx" ON "cash_entries"("status");

-- CreateIndex
CREATE UNIQUE INDEX "cash_transfers_reversesTransferId_key" ON "cash_transfers"("reversesTransferId");

-- CreateIndex
CREATE INDEX "cash_transfers_transferDate_idx" ON "cash_transfers"("transferDate");

-- CreateIndex
CREATE INDEX "payments_cashAccountId_idx" ON "payments"("cashAccountId");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "cash_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_accounts" ADD CONSTRAINT "cash_accounts_coaAccountId_fkey" FOREIGN KEY ("coaAccountId") REFERENCES "coa_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_entries" ADD CONSTRAINT "cash_entries_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "cash_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_entries" ADD CONSTRAINT "cash_entries_counterAccountId_fkey" FOREIGN KEY ("counterAccountId") REFERENCES "coa_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_entries" ADD CONSTRAINT "cash_entries_proofFileId_fkey" FOREIGN KEY ("proofFileId") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_entries" ADD CONSTRAINT "cash_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_entries" ADD CONSTRAINT "cash_entries_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_entries" ADD CONSTRAINT "cash_entries_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_entries" ADD CONSTRAINT "cash_entries_reversesEntryId_fkey" FOREIGN KEY ("reversesEntryId") REFERENCES "cash_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transfers" ADD CONSTRAINT "cash_transfers_fromAccountId_fkey" FOREIGN KEY ("fromAccountId") REFERENCES "cash_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transfers" ADD CONSTRAINT "cash_transfers_toAccountId_fkey" FOREIGN KEY ("toAccountId") REFERENCES "cash_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transfers" ADD CONSTRAINT "cash_transfers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transfers" ADD CONSTRAINT "cash_transfers_reversesTransferId_fkey" FOREIGN KEY ("reversesTransferId") REFERENCES "cash_transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
