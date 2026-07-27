module.exports = {
	root: true,
	parser: "@typescript-eslint/parser",
	plugins: ["@typescript-eslint", "import", "unused-imports"],
	extends: [
		"eslint:recommended",
		"plugin:@typescript-eslint/recommended",
		"plugin:import/recommended",
		"plugin:import/typescript",
		"prettier"
	],
	env: {
		es2022: true,
		node: true,
		browser: true
	},
	parserOptions: {
		ecmaVersion: "latest",
		sourceType: "module"
	},
	settings: {
		"import/resolver": {
			typescript: {
				project: ["./packages/*/tsconfig.json", "./apps/*/tsconfig.json"]
			}
		}
	},
	ignorePatterns: ["**/dist/**", "**/.next/**", "node_modules"],
	rules: {
		"unused-imports/no-unused-imports": "error",
		"@typescript-eslint/no-unused-vars": [
			"error",
			{
				argsIgnorePattern: "^_",
				varsIgnorePattern: "^_"
			}
		]
	}
};
