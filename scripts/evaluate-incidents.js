// Synthetic held-out benchmark. This never writes incident data or enables automatic mode.
const fs = require("node:fs");
const path = require("node:path");
const {
  matchingConfig,
  hash,
  geoTemporalMatch,
  cosine,
  redact,
  PIPELINE,
} = require("../dist/apps/reports-service/incidents/incident-domain");
async function evaluate() {
  const dataset = JSON.parse(
    fs.readFileSync(
      process.argv[2] ||
        path.join(__dirname, "../test/fixtures/incident-evaluation.json"),
      "utf8",
    ),
  );
  const output =
    process.argv[3] || "/private/tmp/vietflood-incident-evaluation.json";
  const offline = process.env.INCIDENT_EVALUATION_VECTORS
    ? JSON.parse(
        fs.readFileSync(process.env.INCIDENT_EVALUATION_VECTORS, "utf8"),
      )
    : null;
  const cache = new Map();
  let fingerprint;
  async function analysis(report) {
    const description = redact(report.description);
    if (cache.has(description)) return cache.get(description);
    let value = offline?.analyses[description];
    if (!value) {
      if (offline) throw new Error("benchmark_vector_missing");
      const url = process.env.RAG_SERVICE_URL?.replace(/\/+$/, "");
      if (!url || !process.env.RAG_SERVICE_TOKEN)
        throw new Error("benchmark_inference_not_configured");
      const response = await fetch(url + "/incidents/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Rag-Token": process.env.RAG_SERVICE_TOKEN,
        },
        body: JSON.stringify({ description, requestId: "incident-evaluation" }),
        signal: AbortSignal.timeout(90000),
      });
      if (!response.ok) throw new Error("benchmark_inference_unavailable");
      value = await response.json();
    }
    if (
      value.pipeline !== PIPELINE ||
      value.embedding?.length !== 1536 ||
      value.embedding.some((v) => !Number.isFinite(v))
    )
      throw new Error("benchmark_invalid_analysis");
    fingerprint ??= value.fingerprint;
    if (value.fingerprint !== fingerprint)
      throw new Error("benchmark_model_changed");
    cache.set(description, value);
    return value;
  }
  let tp = 0,
    fp = 0,
    fn = 0,
    tn = 0,
    gateViolations = 0;
  const decisions = [];
  const config = matchingConfig();
  for (const sample of dataset.cases) {
    const incoming = await analysis(sample.report),
      candidate = await analysis(sample.candidate);
    const eligible =
      geoTemporalMatch(sample.report, sample.candidate, config) &&
      incoming.hasFloodEvidence &&
      !incoming.ambiguousLocation;
    const score = cosine(incoming.embedding, candidate.embedding);
    const runner = sample.runnerUp ? await analysis(sample.runnerUp) : null;
    const margin = runner
      ? score - cosine(incoming.embedding, runner.embedding)
      : Infinity;
    const predicted =
      eligible && score >= config.similarity && margin >= config.margin;
    if (predicted && !geoTemporalMatch(sample.report, sample.candidate, config))
      gateViolations++;
    if (predicted && sample.sameIncident) tp++;
    else if (predicted) fp++;
    else if (sample.sameIncident) fn++;
    else tn++;
    decisions.push({
      id: sample.id,
      expected: sample.sameIncident,
      predicted,
      score,
      margin: Number.isFinite(margin) ? margin : null,
      eligible,
    });
  }
  const result = {
    datasetVersion: dataset.version,
    datasetHash: hash(dataset),
    pipeline: PIPELINE,
    fingerprint,
    configHash: hash(config),
    configuration: config,
    precision: tp + fp ? tp / (tp + fp) : 0,
    recall: tp + fn ? tp / (tp + fn) : 0,
    positiveCases: tp + fn,
    negativeCases: fp + tn,
    gateViolations,
    truePositive: tp,
    falsePositive: fp,
    falseNegative: fn,
    trueNegative: tn,
    evaluatedAt: new Date().toISOString(),
    decisions,
  };
  result.qualifies =
    result.precision >= 0.98 &&
    result.recall >= 0.8 &&
    gateViolations === 0 &&
    result.positiveCases >= 30 &&
    result.negativeCases >= 30;
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      precision: result.precision,
      recall: result.recall,
      positiveCases: result.positiveCases,
      negativeCases: result.negativeCases,
      gateViolations,
      qualifies: result.qualifies,
      output,
    }),
  );
}
evaluate().catch(() => {
  console.error(
    "Incident evaluation failed; check inference configuration or benchmark artifacts. Automatic mode remains gated.",
  );
  process.exitCode = 1;
});
