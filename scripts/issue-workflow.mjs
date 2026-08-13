export const technicalLabels = [
  "bug",
  "enhancement",
  "documentation",
  "dependencies",
  "github_actions",
];

export const capabilityLabels = [
  "capability:cockpit",
  "capability:scratchpads",
  "capability:testing-coverage",
  "capability:debugger",
];

export const capabilityOptions = [
  "Cockpit",
  "Scratchpads",
  "Testing and coverage",
  "Debugger",
  "Cross-capability or unsure",
];

export const deliveryRequirements = [
  "Use a dedicated branch for this ticket; do not share an implementation branch with another ticket.",
  "Cover the user-visible workflow with a Playwright journey as the primary proof.",
  "Add focused unit, integration, or other internal tests when the code contract warrants them; these complement rather than replace the Playwright proof.",
  "After implementation is complete and all validations pass, obtain an independent read-only review as the final gate before delivery. Address actionable findings and rerun the relevant validations before delivery.",
];

export function section(name, value) {
  return `## ${name}\n\n${value}\n`;
}

export function deliverySection() {
  return section(
    "Delivery requirements",
    deliveryRequirements.map((item) => `- ${item}`).join("\n"),
  );
}

export function renderIssue({ type, fields }) {
  let body = section("Problem", fields.problem) + section("Expected behavior", fields.expected);
  if (type === "bug") {
    body += section("Actual behavior", fields.actual);
    body += section("Steps to reproduce", fields.steps);
    body += section("Environment", fields.environment);
  }
  if (fields.context) body += section("Context", fields.context);
  return body + section("Acceptance criteria", fields.acceptance) + deliverySection();
}

function yamlField(id, label, description, required, extra = "") {
  const descriptionLine = description ? `      description: ${description}\n` : "";
  return `  - type: textarea\n    id: ${id}\n    attributes:\n      label: ${label}\n${descriptionLine}${extra}    validations:\n      required: ${required}\n`;
}

function yamlHeader(name, description, title, label, notice) {
  return `name: ${name}\ndescription: ${description}\ntitle: "${title}"\nlabels:\n  - ${label}\nbody:\n  - type: markdown\n    attributes:\n      value: |\n        ${notice}\n`;
}

function yamlCapabilityField() {
  const options = capabilityOptions.map((option) => `        - ${option}`).join("\n");
  return `  - type: dropdown\n    id: capability\n    attributes:\n      label: Primary capability\n      description: Choose the primary capability. Maintainers apply the matching capability label during triage; cross-capability work may receive more than one.\n      options:\n${options}\n    validations:\n      required: true\n`;
}

function yamlDeliveryField() {
  const requirements = deliveryRequirements.map((item) => `        - ${item}`).join("\n");
  return yamlField(
    "delivery",
    "Delivery requirements",
    "Keep the delivery workflow explicit for the eventual implementation.",
    true,
    `      value: |\n${requirements}\n`,
  );
}

export function issueFormContents() {
  const capability = yamlCapabilityField();
  const core =
    yamlField("problem", "Problem", "Describe the user need and its impact.", true) +
    yamlField(
      "expected",
      "Expected behavior",
      "Describe the intended user-visible behavior, constraints, and important non-behavior.",
      true,
      "      placeholder: |\n        - ...\n",
    );
  const completion =
    yamlField(
      "acceptance",
      "Acceptance criteria",
      "List observable outcomes that demonstrate the behavior.",
      true,
      "      placeholder: |\n        - ...\n",
    ) + yamlDeliveryField();
  return {
    "bug.yml":
      yamlHeader(
        "Bug report",
        "Report incorrect PostgreSQL Workbench behavior.",
        "[Bug]: ",
        technicalLabels[0],
        "Do not include passwords, connection strings, private database data, or logs containing them.",
      ) +
      capability +
      core +
      yamlField(
        "actual",
        "Actual behavior",
        "Describe what happens now, including useful error text.",
        true,
      ) +
      yamlField(
        "reproduce",
        "Steps to reproduce",
        "",
        true,
        "      placeholder: |\n        1. ...\n        2. ...\n        3. ...\n",
      ) +
      yamlField(
        "environment",
        "Environment",
        "Include extension version, VS Code version, PostgreSQL version, and operating system when relevant.",
        true,
        "      value: |\n        - PostgreSQL Workbench:\n        - VS Code:\n        - PostgreSQL:\n        - Operating system:\n",
      ) +
      completion,
    "product-improvement.yml":
      yamlHeader(
        "Product improvement",
        "Propose a user-visible PostgreSQL Workbench improvement.",
        "[Feature]: ",
        technicalLabels[1],
        "Describe the user outcome, not a preferred implementation. Do not include passwords, connection strings, or private database data.",
      ) +
      capability +
      core +
      yamlField(
        "context",
        "Context",
        "Optional links, sketches, PostgreSQL constraints, or prior discussions.",
        false,
      ) +
      completion,
  };
}
