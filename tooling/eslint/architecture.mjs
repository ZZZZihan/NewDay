import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const core = "packages/core/src";
const web = "apps/web/src";
const api = "apps/api/src";
const browserGlobals = new Set([
  "window", "document", "navigator", "localStorage", "sessionStorage",
  "indexedDB", "location", "history", "screen", "matchMedia", "alert",
  "confirm", "prompt", "requestAnimationFrame", "cancelAnimationFrame",
  "HTMLElement", "HTMLInputElement", "FileReader", "DOMParser", "Image",
  "Window", "Document", "Storage", "IDBDatabase", "IDBTransaction",
]);

function inside(file, directory) {
  return file === directory || file.startsWith(`${directory}/`);
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function isTestFile(file) {
  return /(^|\/)(tests?|__tests__)(\/|$)/.test(file) || /\.(test|spec)(?:\.[^.]+)?$/.test(file);
}

function packageMatches(source, name) {
  return source === name || source.startsWith(`${name}/`);
}

function uiOrBrowserPackage(source) {
  return ["react", "react-dom", "next", "dexie", "dexie-react-hooks", "@heroui/react"]
    .some((name) => packageMatches(source, name));
}

// Resolve the same aliases used by each workspace, then check relative imports
// against those same paths so changing an import's spelling cannot bypass a rule.
function resolveImport(source, filename) {
  if (source.startsWith(".") || path.isAbsolute(source)) {
    return relative(path.resolve(path.dirname(filename), source));
  }

  for (const [name, directory] of [["@newday/core", core], ["@newday/web", web], ["@newday/api", api]]) {
    if (packageMatches(source, name)) {
      return relative(path.resolve(root, directory, source.slice(name.length + 1)));
    }
  }

  if (source.startsWith("@/")) {
    const importer = relative(filename);
    const directory = [web, api, core].find((candidate) => inside(importer, candidate));
    if (directory) return relative(path.resolve(root, directory, source.slice(2)));
  }

  return undefined;
}

function isTypeOnly(node) {
  return node.type === "TSImportType" || node.importKind === "type" || node.exportKind === "type" ||
    Boolean(node.specifiers?.length && node.specifiers.every((specifier) =>
      specifier.importKind === "type" || specifier.exportKind === "type"));
}

/** @type {import("eslint").Rule.RuleModule} */
export const importBoundariesRule = {
  meta: {
    type: "problem",
    docs: { description: "Keep NewDay's frontend, API, core, and test responsibilities separate." },
    schema: [],
    messages: {
      boundary: "{{reason}} Import: {{source}}.",
      browserGlobal: "Core must not depend on browser global '{{name}}'. Keep browser behavior in apps/web.",
    },
  },
  create(context) {
    const filename = context.filename;
    const importer = relative(filename);
    const inCore = inside(importer, core);
    const inWeb = inside(importer, web);
    const inApi = inside(importer, api);
    if ((!inCore && !inWeb && !inApi) || isTestFile(importer)) return {};

    function checkImport(node, sourceNode) {
      const source = sourceNode?.value;
      if (typeof source !== "string") return;
      const target = resolveImport(source, filename);
      let reason;

      if ((target && isTestFile(target)) ||
          ["vitest", "@testing-library", "fake-indexeddb", "@playwright/test"].some((name) => packageMatches(source, name))) {
        reason = "Production code must not import test code or test tools";
      } else if (inCore) {
        if ((target && inside(target, "apps")) || isBuiltin(source) || uiOrBrowserPackage(source)) {
          reason = "Core must stay independent of apps, UI frameworks, browser storage, and Node built-ins";
        } else if (inside(importer, `${core}/domain`) && target && inside(target, `${core}/application`)) {
          reason = "Domain must not depend on application services";
        }
      } else if (inWeb) {
        if ((target && inside(target, "apps/api")) || isBuiltin(source)) {
          reason = "Frontend must use the HTTP API instead of importing API implementation or Node built-ins";
        } else if (target && inside(target, `${core}/application`) && !isTypeOnly(node)) {
          reason = "Frontend may import core application types only; execute business commands through the HTTP API";
        }
      } else if (inApi) {
        if ((target && inside(target, "apps/web")) || uiOrBrowserPackage(source)) {
          reason = "API must not depend on frontend code, UI frameworks, or browser storage";
        } else if (inside(importer, `${api}/storage`) && target &&
                   ["http", "routes", "services"].some((layer) => inside(target, `${api}/${layer}`))) {
          reason = "Storage must not depend on HTTP handlers, API routes, or services";
        }
      }

      if (reason) context.report({ node: sourceNode, messageId: "boundary", data: { reason, source } });
    }

    return {
      ImportDeclaration(node) { checkImport(node, node.source); },
      ExportNamedDeclaration(node) { checkImport(node, node.source); },
      ExportAllDeclaration(node) { checkImport(node, node.source); },
      ImportExpression(node) { checkImport(node, node.source); },
      TSImportType(node) { checkImport(node, node.source ?? node.argument ?? node.parameter); },
      TSImportEqualsDeclaration(node) { checkImport(node, node.moduleReference.expression); },
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require") {
          checkImport(node, node.arguments[0]);
        }
      },
      "Program:exit"() {
        if (!inCore) return;
        const scope = context.sourceCode.scopeManager.globalScope;
        const references = new Set([
          ...scope.through,
          ...scope.variables.filter((variable) => variable.defs.length === 0)
            .flatMap((variable) => variable.references),
        ]);
        for (const reference of references) {
          const identifier = reference.identifier;
          let name = identifier.name;
          const parent = identifier.parent;
          if (name === "globalThis" && parent.type === "MemberExpression" && parent.object === identifier) {
            name = parent.computed ? parent.property.value : parent.property.name;
          }
          if (browserGlobals.has(name)) {
            context.report({ node: identifier, messageId: "browserGlobal", data: { name } });
          }
        }
      },
    };
  },
};

/** @type {import("eslint").Linter.Config} */
export const architectureConfig = {
  name: "newday/architecture",
  files: ["apps/{web,api}/src/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}", "packages/core/src/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
  plugins: { architecture: { rules: { "import-boundaries": importBoundariesRule } } },
  rules: { "architecture/import-boundaries": "error" },
};
