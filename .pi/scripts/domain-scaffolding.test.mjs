import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const domainsRoot = resolve(root, "src/domains");

const domains = [
  "work-intake",
  "orchestration",
  "agent-execution",
  "verification",
  "integration-and-delivery",
  "model-routing-and-evaluation",
  "codebase-knowledge",
];

const requiredCategories = [
  "terms",
  "owned state",
  "invariants",
  "public interfaces",
  "dependencies",
  "trust boundaries",
  "verification guidance",
  "relevant sources",
  "footguns",
];

function readDomainFile(domain, file) {
  return readFileSync(resolve(domainsRoot, domain, file), "utf8");
}

describe("domain scaffolding", () => {
  for (const domain of domains) {
    describe(domain, () => {
      it("has a domain directory", () => {
        assert.ok(existsSync(resolve(domainsRoot, domain)), `missing directory for ${domain}`);
      });

      it("has a sibling CLAUDE.md containing exactly @AGENTS.md", () => {
        const claudePath = resolve(domainsRoot, domain, "CLAUDE.md");
        assert.ok(existsSync(claudePath), `missing CLAUDE.md for ${domain}`);
        const content = readFileSync(claudePath, "utf8");
        assert.equal(content, "@AGENTS.md\n", `CLAUDE.md for ${domain} must be an exact pointer`);
      });

      it("has an actionable AGENTS.md", () => {
        const agentsPath = resolve(domainsRoot, domain, "AGENTS.md");
        assert.ok(existsSync(agentsPath), `missing AGENTS.md for ${domain}`);
        const content = readFileSync(agentsPath, "utf8");
        assert.ok(content.length > 0, `AGENTS.md for ${domain} must not be empty`);
        for (const category of requiredCategories) {
          assert.ok(
            content.toLowerCase().includes(category),
            `AGENTS.md for ${domain} must define ${category}`,
          );
        }
      });
    });
  }
});
