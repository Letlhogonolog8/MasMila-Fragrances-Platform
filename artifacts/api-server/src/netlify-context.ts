/**
 * Netlify's deploy context (production | deploy-preview | branch-deploy),
 * baked in at build time by build.mjs --netlify. Imported first by the Netlify
 * entry points so it is in place before app.ts checks the configuration.
 */
declare const __NETLIFY_DEPLOY_CONTEXT__: string | undefined;

const context = typeof __NETLIFY_DEPLOY_CONTEXT__ === "string" ? __NETLIFY_DEPLOY_CONTEXT__ : "";
if (context) process.env.NETLIFY_DEPLOY_CONTEXT = context;
