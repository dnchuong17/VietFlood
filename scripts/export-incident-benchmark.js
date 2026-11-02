const { spawnSync } = require("node:child_process");
const path = require("node:path");
const ragDirectory = process.argv[2];
if (!ragDirectory) {
  console.error(
    "Usage: node --env-file=.env scripts/export-incident-benchmark.js <readable-rag-directory> [python]",
  );
  process.exitCode = 1;
} else {
  const result = spawnSync(
    process.argv[3] || "python3",
    [
      path.resolve(ragDirectory, "export_incident_embeddings.py"),
      path.join(__dirname, "../test/fixtures/incident-evaluation.json"),
      "/private/tmp/vietflood-incident-vectors.json",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        TIKTOKEN_CACHE_DIR: "/private/tmp/vietflood-tiktoken-cache",
      },
      timeout: 180000,
    },
  );
  process.exitCode = result.status ?? 1;
}
