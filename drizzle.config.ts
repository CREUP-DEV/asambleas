import "dotenv/config";
import { defineConfig } from "drizzle-kit";
import { requireConfigString } from "./shared/utils/config";

export default defineConfig({
  out: "./drizzle",
  schema: "./server/db/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: requireConfigString(process.env.DATABASE_URL, "DATABASE_URL"),
  },
});
