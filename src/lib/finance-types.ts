/** DTO modul keuangan (basis kas). Nominal = bilangan bulat Rupiah. */
import type { CashFlowSectionValue, CoaTypeValue } from "./accounting/coa-seed";

export interface CoaAccountDto {
  id: string; code: string; name: string; type: CoaTypeValue; section: CashFlowSectionValue;
  manualEntry: boolean; isSystem: boolean; isActive: boolean;
  /** Sudah dipakai entri kas atau dipetakan ke akun kas/bank (kode & jenis terkunci). */
  inUse: boolean;
}

export interface CashAccountDto {
  id: string; name: string; kind: "KAS" | "BANK"; coaAccountId: string; coaCode: string; coaName: string;
  isDefault: boolean; isActive: boolean; openingBalance: number; openingDate: string; notes: string | null;
  /** Saldo per hari ini (saldo awal + mutasi sejak tanggal saldo awal). */
  balance: number;
  hasMovements: boolean;
}

export interface CashAccountOptionDto { id: string; name: string; kind: "KAS" | "BANK"; isDefault: boolean }

export interface CashEntryDto {
  id: string; entryType: "ENTRY" | "REVERSAL"; reversesEntryId: string | null; reversedByEntryId: string | null;
  entryDate: string; direction: "IN" | "OUT"; amount: number;
  cashAccountId: string; cashAccountName: string;
  counterAccountId: string; counterCode: string; counterName: string; counterType: CoaTypeValue;
  description: string; payee: string | null; reference: string | null; proofFileId: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED"; reason: string | null;
  createdById: string; createdByName: string; createdAt: string;
  approvedByName: string | null; approvedAt: string | null;
  rejectedByName: string | null; rejectedAt: string | null; rejectionReason: string | null;
}

export interface CashTransferDto {
  id: string; entryType: "ENTRY" | "REVERSAL"; reversesTransferId: string | null; reversedByTransferId: string | null;
  transferDate: string; fromAccountId: string; fromName: string; toAccountId: string; toName: string; amount: number;
  description: string | null; reference: string | null; reason: string | null; createdByName: string; createdAt: string;
}
