import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const ignoredDirectories = new Set([
	".git",
	".next",
	"coverage",
	"dist",
	"node_modules",
	"playwright-report",
	"test-results"
]);
const ignoredFiles = new Set([".git"]);
const textExtensions = new Set([
	"",
	".cjs",
	".css",
	".env",
	".example",
	".html",
	".js",
	".json",
	".md",
	".mjs",
	".sql",
	".svg",
	".ts",
	".tsx",
	".webmanifest",
	".yaml",
	".yml"
]);
const retiredBrandPattern = /air[_-]?tv/i;

/** Finds text files recursively while excluding generated and dependency output. */
async function findTextFiles(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) {
				files.push(...(await findTextFiles(join(directory, entry.name))));
			}
			continue;
		}
		if (
			entry.isFile() &&
			!ignoredFiles.has(entry.name) &&
			textExtensions.has(extname(entry.name))
		) {
			files.push(join(directory, entry.name));
		}
	}
	return files;
}

const matches = [];
for (const file of await findTextFiles(root)) {
	const contents = await readFile(file, "utf8");
	if (retiredBrandPattern.test(contents)) {
		matches.push(relative(root, file));
	}
}

if (matches.length > 0) {
	throw new Error(`Retired brand references remain:\n${matches.join("\n")}`);
}

console.log("Brand check passed: no retired name references remain.");
