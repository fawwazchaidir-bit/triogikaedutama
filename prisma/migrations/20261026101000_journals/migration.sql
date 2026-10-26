-- CreateEnum
CREATE TYPE "JournalKind" AS ENUM ('GENERAL', 'OPENING');

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" UUID NOT NULL,
    "numberSeq" SERIAL NOT NULL,
    "kind" "JournalKind" NOT NULL DEFAULT 'GENERAL',
    "entryType" "LedgerEntryType" NOT NULL DEFAULT 'ENTRY',
    "reversesJournalId" UUID,
    "journalDate" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "reason" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" UUID NOT NULL,
    "journalId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "accountId" UUID NOT NULL,
    "debit" BIGINT NOT NULL DEFAULT 0,
    "credit" BIGINT NOT NULL DEFAULT 0,
    "memo" TEXT,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_numberSeq_key" ON "journal_entries"("numberSeq");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_reversesJournalId_key" ON "journal_entries"("reversesJournalId");

-- CreateIndex
CREATE INDEX "journal_entries_journalDate_idx" ON "journal_entries"("journalDate");

-- CreateIndex
CREATE INDEX "journal_lines_accountId_idx" ON "journal_lines"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "journal_lines_journalId_lineNo_key" ON "journal_lines"("journalId", "lineNo");

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversesJournalId_fkey" FOREIGN KEY ("reversesJournalId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "coa_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
