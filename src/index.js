import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { load } from "cheerio";

const MAX_HTML_BYTES = 2_000_000;
const MAX_TEXT_LENGTH = 700;
const NONE = "none";

function usage() {
  console.error(`Usage:\n  npm start -- --url https://example.com [--extract-only] [--json]\n  npm start -- --file ./page.html [--extract-only] [--json]\n\nThe supplied HTML is sent to TypeSafe only as extracted semantic structure and text.`);
}

function text(value, limit = MAX_TEXT_LENGTH) {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readHtml() {
  const url = argValue("--url");
  const file = argValue("--file");
  if ((url && file) || (!url && !file)) {
    usage();
    process.exit(1);
  }
  if (file) {
    const source = resolve(file);
    const html = await readFile(source, "utf8");
    if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new Error(`HTML file exceeds ${MAX_HTML_BYTES} bytes.`);
    return { html, source: `file://${source}` };
  }

  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("--url must be a valid absolute URL."); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only http: and https: URLs are supported.");
  const response = await fetch(parsed, { redirect: "follow" });
  if (!response.ok) throw new Error(`Could not fetch ${url}: HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) throw new Error(`Expected text/html, received ${contentType || "an unknown content type"}.`);
  const html = await response.text();
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new Error(`Fetched HTML exceeds ${MAX_HTML_BYTES} bytes.`);
  return { html, source: response.url };
}

function extractStructure(html, source) {
  const $ = load(html);
  $("script, style, noscript, template, svg").remove();
  const headings = $("h1, h2, h3, h4, h5, h6").map((_, element) => ({ level: Number(element.tagName.slice(1)), text: text($(element).text(), 240) })).get().filter((heading) => heading.text).slice(0, 40);
  const landmarks = $("header, nav, main, article, aside, footer, form, [role]").map((_, element) => ({ tag: element.tagName, role: $(element).attr("role") ?? null, label: $(element).attr("aria-label") ?? $(element).attr("aria-labelledby") ?? null })).get().slice(0, 40);
  const sections = $("main, article, [role='main'], section").map((index, element) => ({ id: `section_${index + 1}`, tag: element.tagName, heading: text($(element).find("h1, h2, h3").first().text(), 160) || null, text: text($(element).text()) })).get().filter((section) => section.text).slice(0, 40);
  const links = $("a[href]").map((index, element) => ({ id: `link_${index + 1}`, text: text($(element).text(), 180) || null, href: $(element).attr("href"), ariaLabel: $(element).attr("aria-label") ?? null })).get().filter((link) => link.text || link.ariaLabel).slice(0, 60);
  const buttons = $("button, input[type='submit'], input[type='button']").map((_, element) => text($(element).text() || $(element).attr("value"), 180)).get().filter(Boolean).slice(0, 30);

  return {
    source,
    document: { lang: $("html").attr("lang") ?? null, title: text($("title").first().text(), 240) || null, description: $("meta[name='description']").attr("content") ?? null, canonical: $("link[rel='canonical']").attr("href") ?? null },
    semantics: { headings, landmarks, sections, links, buttons, hasMain: $("main, [role='main']").length > 0, hasNav: $("nav, [role='navigation']").length > 0, hasFooter: $("footer, [role='contentinfo']").length > 0, formCount: $("form").length }
  };
}

function candidateCriteria(items, describe) {
  return Object.fromEntries(items.map((item) => [item.id, describe(item)]));
}

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

function indent(value) {
  return value ? `\n   ${value}` : "";
}

function printExtractionSummary(state) {
  const { document, semantics } = state;
  console.log(`\nHTML extraction\n───────────────\nSource: ${state.source}\nTitle:  ${document.title ?? "(none)"}\nLanguage: ${document.lang ?? "(not declared)"}\n\nStructure\n  Headings: ${semantics.headings.length}\n  Landmarks: ${semantics.landmarks.length}\n  Content sections: ${semantics.sections.length}\n  Links: ${semantics.links.length}\n  Buttons: ${semantics.buttons.length}\n  Forms: ${semantics.formCount}\n  Main landmark: ${semantics.hasMain ? "yes" : "no"}`);
}

function printEvaluationSummary(state, answers, usage) {
  const { pageKind, mainContent, primaryCta, requiresInteraction, semanticClarity } = answers;
  const section = state.semantics.sections.find((item) => item.id === mainContent.choice);
  const link = state.semantics.links.find((item) => item.id === primaryCta.choice);
  console.log(`\nJev evaluation\n──────────────\nPage purpose: ${pageKind.choice} (${percent(pageKind.confidence)} confidence)\nPrimary content: ${section ? `${section.heading ?? section.tag} [${section.id}]` : "No matching section"} (${percent(mainContent.confidence)} confidence)${indent(section?.text)}\nPrimary CTA: ${link ? `${link.text ?? link.ariaLabel} → ${link.href}` : "No CTA selected"} (${percent(primaryCta.confidence)} confidence)\nInteraction required: ${percent(requiresInteraction.noul)}\nSemantic clarity: ${semanticClarity.score.toFixed(2)} / 2 (${percent(semanticClarity.confidence)} confidence)\n\nUsage\n  Input tokens: ${usage.input_tokens}\n  Output tokens: ${usage.output_tokens}`);
}

async function main() {
  const { html, source } = await readHtml();
  const state = extractStructure(html, source);
  if (process.argv.includes("--extract-only")) {
    if (process.argv.includes("--json")) console.log(JSON.stringify({ source, extracted: state }, null, 2));
    else printExtractionSummary(state);
    return;
  }
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set. Copy .env.example and export the value in your shell.");
  const sectionOptions = candidateCriteria(state.semantics.sections, (section) => `${section.tag}${section.heading ? ` — ${section.heading}` : ""}: ${section.text}`);
  const linkOptions = candidateCriteria(state.semantics.links, (link) => `${link.text ?? link.ariaLabel} (${link.href})`);
  const client = new TypeSafeClient();
  const result = await client.systemOne({
    model: "jev-latest",
    state,
    questions: {
      pageKind: choice("What is the primary purpose of this HTML page?", { article: "A reading-oriented article, guide, or news story.", product: "A product, service, or marketing landing page.", commerce: "A page for shopping, pricing, checkout, or transaction.", account: "Sign-in, registration, account, or settings page.", search_or_listing: "A search result, directory, index, or list of items.", application: "An interactive web application or dashboard.", other: "None of the above." }),
      mainContent: choice("Which extracted section best represents the page's primary content?", { ...sectionOptions, [NONE]: "No extracted section represents the primary content." }),
      primaryCta: choice("Which link is the page's primary call to action for its intended visitor?", { ...linkOptions, [NONE]: "There is no primary call to action among these links." }),
      requiresInteraction: noul("Does the page primarily require the visitor to fill a form, sign in, purchase, or otherwise take an interactive action?"),
      semanticClarity: score("How clear and useful is the extracted semantic HTML structure for understanding the page?", ["Weak: little meaningful structure, headings, landmarks, or descriptive text.", "Adequate: some useful structure, but the primary content or navigation is ambiguous.", "Strong: headings, landmarks, and content structure clearly communicate the page's purpose."])
    }
  });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ source, extracted: state, evaluation: result.answers, usage: result.usage }, null, 2));
  } else {
    printExtractionSummary(state);
    printEvaluationSummary(state, result.answers, result.usage);
  }
}

main().catch((error) => { console.error(error.message); process.exit(1); });
