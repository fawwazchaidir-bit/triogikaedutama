-- AlterEnum
ALTER TYPE "InvoiceStatus" ADD VALUE 'SUBMITTED';

-- AlterTable
ALTER TABLE "company_settings" ALTER COLUMN "signerTitle" SET DEFAULT 'Finance Manager';

-- AlterTable
ALTER TABLE "invoice_items" ADD COLUMN     "programText" TEXT;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedById" UUID,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3),
ADD COLUMN     "submittedById" UUID;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Data: judul penandatangan baru ("Finance Manager"). Invoice yang SUDAH terbit tidak terpengaruh (memegang snapshot sendiri).
UPDATE "company_settings" SET "signerTitle" = 'Finance Manager' WHERE "signerTitle" = 'Finance';
