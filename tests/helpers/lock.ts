import { prisma } from "@/server/db";

/**
 * Pasang/cabut tanggal kunci buku langsung (tanpa menutup periode satu per satu) untuk menguji PENEGAKAN kunci:
 * service dan trigger database membaca `company_settings.booksLockedThrough`. Alur penutupan itu sendiri diuji di tes periode.
 */
export async function lockBooksThrough(date: string | null): Promise<void> {
  await prisma.companySettings.update({ where: { id: 1 }, data: { booksLockedThrough: date ? new Date(`${date}T00:00:00Z`) : null } });
}
