import { PrismaClient } from "@prisma/client";
import { databaseUrl } from "./paths.js";

export {
  parseJsonArray,
  toJsonArray,
  parseJsonObject,
  toJsonString,
} from "../lib/json-serialization.js";
export { ensureDatabase } from "./bootstrap.js";
export { devflowHome, databaseFile, databaseUrl } from "./paths.js";

/**
 * One client for the process. The URL is resolved here rather than read from
 * the ambient environment, so the CLI always talks to ~/.devflow/devflow.db
 * unless DATABASE_URL says otherwise.
 */
export const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl() } },
});
