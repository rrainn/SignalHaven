import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/docker.yml", import.meta.url);
const dockerfileUrl = new URL("../Dockerfile", import.meta.url);
const bonjourDockerfileUrl = new URL("../Dockerfile.bonjour", import.meta.url);
const bonjourSmokeComposeUrl = new URL(
	"../.github/compose.bonjour-smoke.yml",
	import.meta.url
);

test("Docker publishing runs only when a GitHub release is published", async () => {
	const workflow = await readFile(workflowUrl, "utf8");

	assert.match(workflow, /release:\s*\n\s+types:\s*\[published\]/);
	assert.doesNotMatch(workflow, /^\s{2}(push|pull_request):/m);
	assert.match(workflow, /value=\$\{\{ github\.event\.release\.tag_name \}\}/);
});

test("prereleases publish to their moving channel without advancing latest", async () => {
	const workflow = await readFile(workflowUrl, "utf8");

	// Both platform labels and the final manifest must derive identical tags.
	assert.equal(workflow.match(/flavor:\s*\|\s*\n\s+latest=false/g)?.length, 2);
	assert.equal(
		workflow.match(
			/type=match,pattern=\^v\?\\d\+\\\.\\d\+\\\.\\d\+-\(alpha\|beta\)\(\?:\\\.\|\$\),group=1,value=\$\{\{ github\.event\.release\.tag_name \}\}/g
		)?.length,
		2
	);
	assert.equal(
		workflow.match(
			/type=raw,value=latest,enable=\$\{\{ !github\.event\.release\.prerelease \}\}/g
		)?.length,
		2
	);
	assert.match(workflow, /version_without_build="\$\{RELEASE_TAG%%\+\*\}"/);
	assert.match(workflow, /"\$IS_PRERELEASE" != "true"/);
	assert.match(workflow, /"\$IS_PRERELEASE" == "true"/);
});

test("release metadata reaches the image without changing stable cache scopes", async () => {
	const [workflow, dockerfile, bonjourDockerfile] = await Promise.all([
		readFile(workflowUrl, "utf8"),
		readFile(dockerfileUrl, "utf8"),
		readFile(bonjourDockerfileUrl, "utf8")
	]);

	assert.match(workflow, /SIGNALHAVEN_VERSION=\$\{\{[^\n]+\}\}/);
	assert.match(workflow, /SIGNALHAVEN_GIT_SHA=\$\{\{ github\.sha \}\}/);
	assert.match(workflow, /cache-from: type=gha,scope=signalhaven-linux-amd64/);
	assert.match(
		workflow,
		/cache-to: type=gha,scope=signalhaven-linux-amd64,mode=max/
	);

	const metadataArg = dockerfile.indexOf("ARG SIGNALHAVEN_VERSION");
	const finalApplicationCopy = dockerfile.lastIndexOf(
		"COPY --from=frontend-build"
	);
	assert.ok(metadataArg > finalApplicationCopy);
	assert.match(
		dockerfile.slice(metadataArg),
		/ENV SIGNALHAVEN_VERSION=\$\{SIGNALHAVEN_VERSION\}/
	);
	assert.match(bonjourDockerfile, /ARG SIGNALHAVEN_VERSION/);
	assert.match(
		bonjourDockerfile,
		/ENV SIGNALHAVEN_VERSION=\$\{SIGNALHAVEN_VERSION\}/
	);
});

test("releases publish the Bonjour sidecar for both native architectures", async () => {
	const workflow = await readFile(workflowUrl, "utf8");

	assert.match(workflow, /file: Dockerfile\.bonjour/);
	assert.match(workflow, /tags: signalhaven-bonjour:ci/);
	assert.equal(workflow.match(/dockerfile: Dockerfile\.bonjour/g)?.length, 2);
	assert.equal(workflow.match(/image_suffix: -bonjour/g)?.length, 3);
	assert.match(
		workflow,
		/pattern: digest-\$\{\{ matrix\.artifact_pattern \}\}-\*/
	);
});

test("the Bonjour image is non-root and includes Linux interface discovery", async () => {
	const dockerfile = await readFile(bonjourDockerfileUrl, "utf8");

	assert.match(dockerfile, /iproute2/);
	assert.match(dockerfile, /USER signalhaven/);
	assert.match(dockerfile, /VOLUME \["\/var\/lib\/signalhaven-bonjour"\]/);
	assert.doesNotMatch(dockerfile, /EXPOSE 5353/);
});

test("the release smoke test reaches SignalHaven through trusted HTTPS", async () => {
	const [workflow, smokeCompose] = await Promise.all([
		readFile(workflowUrl, "utf8"),
		readFile(bonjourSmokeComposeUrl, "utf8")
	]);

	// The release must exercise the same HTTPS boundary that Bonjour advertises.
	assert.match(workflow, /export PUBLIC_URL=https:\/\/127\.0\.0\.1/);
	assert.match(workflow, /bonjour-smoke-proxy\.mjs/);
	assert.match(workflow, /compose\.bonjour-smoke\.yml/);
	assert.match(smokeCompose, /NODE_EXTRA_CA_CERTS:/);
	assert.match(smokeCompose, /signalhaven-bonjour-tls\/ca\.crt/);
});

test("FFmpeg uses immutable checksum-verified artifacts with licensing material", async () => {
	const dockerfile = await readFile(dockerfileUrl, "utf8");

	assert.match(
		dockerfile,
		/ARG FFMPEG_BTBN_TAG=autobuild-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}/
	);
	assert.doesNotMatch(dockerfile, /ARG FFMPEG_BTBN_TAG=latest/);
	assert.match(dockerfile, /FFMPEG_BTBN_AMD64_SHA256=[0-9a-f]{64}/);
	assert.match(dockerfile, /FFMPEG_BTBN_ARM64_SHA256=[0-9a-f]{64}/);
	assert.match(dockerfile, /sha256sum --check/);
	assert.match(
		dockerfile,
		/COPY --from=ffmpeg \/opt\/ffmpeg\/LICENSE\.txt \/usr\/share\/doc\/signalhaven\/ffmpeg\/LICENSE\.txt/
	);
	assert.match(
		dockerfile,
		/COPY docs\/third-party\/ffmpeg\.md \/usr\/share\/doc\/signalhaven\/ffmpeg\/README\.md/
	);
});

test("the runtime image bundles Comskip with SignalHaven's EDL configuration", async () => {
	const [workflow, dockerfile] = await Promise.all([
		readFile(workflowUrl, "utf8"),
		readFile(dockerfileUrl, "utf8")
	]);

	assert.match(
		dockerfile,
		/apt-get install -y --no-install-recommends[\s\S]*comskip/
	);
	assert.match(
		dockerfile,
		/COPY config\/comskip\.ini \/etc\/signalhaven\/comskip\.ini/
	);
	assert.match(
		dockerfile,
		/\(comskip --help >\/dev\/null 2>&1 \|\| \[ "\$\?" -eq 2 \]\)/
	);
	assert.match(
		workflow,
		/docker run --rm signalhaven:ci comskip --help >\/dev\/null 2>&1 \|\| \[ "\$\?" -eq 2 \]/
	);
});
