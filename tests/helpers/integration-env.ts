// Integration test SELALU memakai TEST_DATABASE_URL — tidak pernah DATABASE_URL (development/production).
import "dotenv/config";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("TEST_DATABASE_URL belum diatur (lihat .env.example)");
if (/prod/i.test(testUrl)) throw new Error("TEST_DATABASE_URL tampak seperti database produksi — dibatalkan");
process.env.DATABASE_URL = testUrl;
