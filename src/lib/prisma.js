import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const globalForPrisma = globalThis;

function getConnectionString() {
  if (typeof process !== "undefined") {
    if (process.env?.HYPERDRIVE?.connectionString) {
      return process.env.HYPERDRIVE.connectionString;
    }
    if (process.env?.DATABASE_URL) {
      return process.env.DATABASE_URL;
    }
  }
  return "";
}

const pool = new Pool({ connectionString: getConnectionString() });
const adapter = new PrismaPg(pool);

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
