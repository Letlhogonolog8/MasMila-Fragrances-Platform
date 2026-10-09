/**
 * Invokes the Netlify Function handler in-process (no Netlify runtime) and
 * prints the response, so tests can check how the deployed entry point
 * behaves under a given environment.
 */
export {};

const { handler } = await import("../../netlify");

const results: Array<{ path: string; statusCode: number }> = [];
for (const path of ["/api/healthz", "/api/products", "/api/admin/summary"]) {
  const response = (await handler(
    {
      httpMethod: "GET",
      path,
      headers: { authorization: "Bearer demo:admin@masmila.co.za" },
      multiValueHeaders: {},
      queryStringParameters: null,
      body: null,
      isBase64Encoded: false,
      requestContext: {},
    },
    {},
  )) as { statusCode: number };
  results.push({ path, statusCode: response.statusCode });
}
console.log(`PROBE_RESULT ${JSON.stringify(results)}`);
process.exit(0);
