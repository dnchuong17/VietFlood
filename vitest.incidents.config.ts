import { defineConfig } from "vitest/config";
import { userInfo } from "node:os";

// Explicit opt-in configuration: never uses the application's DATABASE_URL.
process.env.INCIDENT_TEST_DATABASE_URL ??= `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:55439/vietflood_incidents_test`;
export default defineConfig({
  test: {
    include: ["apps/**/incidents/*.spec.ts"],
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 20000,
  },
});
