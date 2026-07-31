import { readFile } from "node:fs/promises";
import { request as requestHttp } from "node:http";
import { createServer } from "node:https";

const listenHost = "127.0.0.1";
const listenPort = 443;
const upstreamOrigin = new URL("http://127.0.0.1:3000");
const certificateDirectory = "/etc/signalhaven-ci";

/**
 * Proxies one HTTPS request to the host-published SignalHaven endpoint.
 *
 * The release smoke test must cross a real TLS boundary so the Bonjour
 * sidecar validates the same endpoint shape that clients use in production.
 */
function proxyRequest(clientRequest, clientResponse) {
	const upstreamUrl = new URL(clientRequest.url ?? "/", upstreamOrigin);
	const upstreamRequest = requestHttp(
		upstreamUrl,
		{
			method: clientRequest.method,
			headers: {
				...clientRequest.headers,
				host: upstreamOrigin.host,
				"x-forwarded-proto": "https"
			}
		},
		(upstreamResponse) => {
			clientResponse.writeHead(
				upstreamResponse.statusCode ?? 502,
				upstreamResponse.statusMessage,
				upstreamResponse.headers
			);
			upstreamResponse.pipe(clientResponse);
		}
	);

	upstreamRequest.on("error", (error) => {
		// A short 502 is expected while Compose is still starting SignalHaven.
		console.error("proxy-upstream-error", error.message);
		if (!clientResponse.headersSent) {
			clientResponse.writeHead(502);
		}
		clientResponse.end();
	});
	clientRequest.on("aborted", () => upstreamRequest.destroy());
	clientRequest.pipe(upstreamRequest);
}

const [certificate, privateKey] = await Promise.all([
	readFile(`${certificateDirectory}/server.crt`),
	readFile(`${certificateDirectory}/server.key`)
]);
const server = createServer(
	{ cert: certificate, key: privateKey },
	proxyRequest
);

/** Stops accepting requests promptly when the workflow tears down the container. */
function shutDown(signal) {
	console.log("proxy-stopping", signal);
	server.close((error) => {
		process.exitCode = error ? 1 : 0;
	});
}

server.on("clientError", (error, socket) => {
	console.error("proxy-client-error", error.message);
	socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});
server.listen(listenPort, listenHost, () => {
	console.log("proxy-ready", `https://${listenHost}`);
});
process.once("SIGINT", () => shutDown("SIGINT"));
process.once("SIGTERM", () => shutDown("SIGTERM"));
