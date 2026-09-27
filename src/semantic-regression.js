import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const offline = args.includes("--offline");
const strict = args.includes("--strict");
const manifestFlag = args.indexOf("--manifest");
const manifestPath = resolve(root, manifestFlag >= 0 ? args[manifestFlag + 1] : "semantic-pages.json");

function percent(value) { return `${Math.round(value * 100)}%`; }

function runPage(page, manifestDir) {
  const sourceArgs = page.file ? ["--file", resolve(manifestDir, page.file)] : page.url ? ["--url", page.url] : null;
  if (!sourceArgs) throw new Error(`Page '${page.id}' needs either a file or url.`);
  const result = spawnSync(process.execPath, ["src/index.js", ...sourceArgs, "--json", ...(offline ? ["--extract-only"] : [])], { cwd: root, encoding: "utf8", env: process.env });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `Could not evaluate '${page.id}'.`);
  try { return JSON.parse(result.stdout); } catch { throw new Error(`'${page.id}' did not return valid JSON.`); }
}

function evaluate(page, result) {
  const expect = page.expect ?? {};
  const checks = [];
  const add = (status, message) => checks.push({ status, message });
  const actual = result.extracted.semantics;
  if (typeof expect.hasMain === "boolean") add(actual.hasMain === expect.hasMain ? "pass" : "fail", `main landmark: expected ${expect.hasMain ? "present" : "absent"}, got ${actual.hasMain ? "present" : "absent"}`);
  if (offline) return checks;

  const answers = result.evaluation;
  const thresholds = expect.minConfidence ?? {};
  const modelCheck = (answerKey, expected, actualValue, label) => {
    if (expected === undefined) return;
    const confidence = answers[answerKey]?.confidence;
    const threshold = thresholds[answerKey] ?? 0.6;
    if (confidence < threshold) add("review", `${label}: ${actualValue} (${percent(confidence)} confidence, below ${percent(threshold)})`);
    else add(actualValue === expected ? "pass" : "fail", `${label}: expected ${expected}, got ${actualValue} (${percent(confidence)} confidence)`);
  };
  modelCheck("pageKind", expect.pageKind, answers.pageKind.choice, "page kind");
  const selectedLink = actual.links.find((link) => link.id === answers.primaryCta.choice);
  modelCheck("primaryCta", expect.primaryCtaHref, selectedLink?.href ?? "(none)", "primary CTA");
  if (expect.minSemanticClarity !== undefined) {
    const confidence = answers.semanticClarity.confidence;
    const threshold = thresholds.semanticClarity ?? 0.6;
    const score = answers.semanticClarity.score;
    if (confidence < threshold) add("review", `semantic clarity: ${score.toFixed(2)} / 2 (${percent(confidence)} confidence, below ${percent(threshold)})`);
    else add(score >= expect.minSemanticClarity ? "pass" : "fail", `semantic clarity: expected ≥ ${expect.minSemanticClarity}, got ${score.toFixed(2)} / 2 (${percent(confidence)} confidence)`);
  }
  return checks;
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!Array.isArray(manifest.pages) || manifest.pages.length === 0) throw new Error("Manifest needs a non-empty pages array.");
if (!offline && !process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required. Use --offline for structural checks only.");

let failures = 0;
let reviews = 0;
console.log(`Semantic regression ${offline ? "(offline structural checks)" : "(Jev evaluation)"}\n`);
for (const page of manifest.pages) {
  const result = runPage(page, dirname(manifestPath));
  const checks = evaluate(page, result);
  const status = checks.some((check) => check.status === "fail") ? "FAIL" : checks.some((check) => check.status === "review") ? "REVIEW" : "PASS";
  failures += status === "FAIL" ? 1 : 0;
  reviews += status === "REVIEW" ? 1 : 0;
  console.log(`${status === "PASS" ? "✓" : status === "REVIEW" ? "!" : "✗"} ${status.padEnd(6)} ${page.id}`);
  for (const check of checks) console.log(`  ${check.status === "pass" ? "✓" : check.status === "review" ? "!" : "✗"} ${check.message}`);
}
console.log(`\nResult: ${failures} failed, ${reviews} need review, ${manifest.pages.length} pages checked.`);
process.exit(failures > 0 || (strict && reviews > 0) ? 1 : 0);
