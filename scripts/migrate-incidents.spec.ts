import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, accessSync, constants } from "node:fs";
const require = createRequire(import.meta.url);
const { applyIncidentMigrations } = require("./migrate-incidents.js");
describe("incident migration runner", () => {
 it("applies both ordered additive migrations inside one locked transaction", async () => {
  const query=vi.fn().mockResolvedValue({rows:[{reports:true,users:true}]});
  const release=vi.fn();
  await applyIncidentMigrations({connect:async()=>({query,release})});
  const statements=query.mock.calls.map(c=>c[0]);
  expect(statements[0]).toBe("BEGIN");
  expect(statements[1]).toContain("pg_advisory_xact_lock");
  expect(statements[3]).toContain("CREATE SCHEMA IF NOT EXISTS private_incidents");
  expect(statements[4]).toContain("ADD COLUMN IF NOT EXISTS verified_pipeline");
  expect(statements[5]).toBe("COMMIT");
  expect(release).toHaveBeenCalledOnce();
 });
 it("rolls back and releases on failure", async () => {
  const query=vi.fn().mockResolvedValue({rows:[{reports:true,users:true}]}).mockRejectedValueOnce(new Error("offline"));
  const release=vi.fn();
  await expect(applyIncidentMigrations({connect:async()=>({query,release})})).rejects.toThrow("offline");
  expect(query).toHaveBeenLastCalledWith("ROLLBACK"); expect(release).toHaveBeenCalledOnce();
 });
 it("packages both migrations and the runner in both runtime images, plus PDF font/license in gateway", () => {
  for (const application of ["api-gateway", "reports-service"]) {
   const docker = readFileSync(`apps/${application}/Dockerfile`, "utf8").split(/FROM node:20-alpine\n/).at(-1)!;
   for (const file of ["db/migrations/20261101_incidents.sql", "db/migrations/20261106_incident_intelligence.sql", "scripts/migrate-incidents.js"]) {
    expect(docker).toContain(file); expect(() => accessSync(file, constants.R_OK)).not.toThrow();
   }
  }
  expect(readFileSync("apps/api-gateway/Dockerfile", "utf8")).toContain("COPY assets/fonts ./assets/fonts");
  expect(readFileSync("assets/fonts/NotoSans-Regular.ttf").readUInt32BE(0)).toBe(0x00010000);
  expect(readFileSync("assets/fonts/OFL.txt", "utf8")).toContain("SIL OPEN FONT LICENSE Version 1.1");
 });
});
