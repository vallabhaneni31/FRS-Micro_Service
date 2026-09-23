import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// Override CSP for Swagger UI routes so the CDN assets can load
router.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self' https://cdnjs.cloudflare.com; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data: https://cdnjs.cloudflare.com;"
  );
  next();
});

// The full spec is generated from every router.get/post/put/patch/delete(...)
// call across src/routes/*.js — see scripts/generate-openapi.js. Re-run that
// script after adding/removing routes or changing a mount prefix in server.js;
// this file just serves whatever it last produced. Read fresh on every request
// (not cached at module load) so a regenerate takes effect without a restart.
const GENERATED_SPEC_PATH = path.join(__dirname, '..', 'docs', 'openapi.generated.json');

function loadSpec() {
  try {
    return JSON.parse(fs.readFileSync(GENERATED_SPEC_PATH, 'utf8'));
  } catch (e) {
    return {
      openapi: '3.0.0',
      info: {
        title: 'Motivity Face Recognition System API',
        description: `Generated spec not found at ${GENERATED_SPEC_PATH} — run "node scripts/generate-openapi.js" from backend/api.`,
        version: '0.0.0',
      },
      paths: {},
    };
  }
}

// Route to return raw OpenAPI schema
router.get('/swagger.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.json(loadSpec());
});

// Route to render the Swagger UI html landing page
router.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>FRS Backend API Docs</title>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui.min.css" />
        <link rel="icon" type="image/png" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/favicon-32x32.png" sizes="32x32" />
        <style>
          html { box-sizing: border-box; overflow: -moz-scrollbars-vertical; overflow-y: scroll; }
          *, *:before, *:after { box-sizing: inherit; }
          body { margin: 0; background: #fafafa; }
        </style>
      </head>
      <body>
        <div id="swagger-ui"></div>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui-bundle.js"></script>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui-standalone-preset.js"></script>
        <script>
          window.onload = () => {
            window.ui = SwaggerUIBundle({
              url: '/api/docs/swagger.json?v=' + Date.now(),
              dom_id: '#swagger-ui',
              deepLinking: true,
              filter: true,
              docExpansion: 'none',
              tagsSorter: 'alpha',
              operationsSorter: 'alpha',
              presets: [
                SwaggerUIBundle.presets.apis,
                SwaggerUIStandalonePreset
              ],
              plugins: [
                SwaggerUIBundle.plugins.DownloadUrl
              ],
              layout: "BaseLayout"
            });
          };
        </script>
      </body>
    </html>
  `);
});

export default router;
