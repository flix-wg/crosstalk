import tseslint from "typescript-eslint";

const modules = ["schema", "core", "store-sqlite", "relay", "client", "cli",
  "bridge", "hooks", "githooks", "executor", "exporter"];
const allowed = {
  schema: [], core: ["schema"], "store-sqlite": ["core"],
  cli: ["client", "schema", "hooks"],
  relay: ["core", "store-sqlite", "schema"], client: ["schema"],
};
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "site/**"] },
  ...tseslint.configs.recommended,
  {
    // Dynamic imports and import types would bypass the module map below.
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error",
        { selector: "ImportExpression", message: "Use static imports so the module map is enforced." },
        { selector: "TSImportType", message: "Use static type imports so the module map is enforced." }],
    },
  },
  ...modules.map((module) => ({
    files: [`src/${module}/**/*.ts`],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", {
        patterns: [
          ...modules.filter((target) =>
            target !== module && !(allowed[module] ?? ["client", "schema"]).includes(target)
          ).map((target) => ({
            regex: `(^|/)${target}(/|$)`,
            message: `${module} must not import ${target}.`,
          })),
          ...(module === "store-sqlite" ? [{
            regex: "(^|/)core(/|$)", allowTypeImports: true,
            message: "store-sqlite may import only types from core.",
          }] : []),
        ],
      }],
    },
  })),
);
