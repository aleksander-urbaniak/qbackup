import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';

const port = Number(process.env.QBACKUP_SMOKE_PORT || 8791);
const baseUrl = `http://127.0.0.1:${port}`;
const forbiddenConsolePatterns = [
  /Cannot access .* before initialization/i,
  /Content Security Policy/i,
  /Refused to execute/i,
  /failed to load module script/i,
  /ReferenceError/i
];

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  throw new Error('Production smoke test requires Playwright. Install it with: npm install --save-dev @playwright/test');
}

await waitForBuildOutput();

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port)
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let serverOutput = '';
server.stdout.on('data', (chunk) => {
  serverOutput += chunk;
});
server.stderr.on('data', (chunk) => {
  serverOutput += chunk;
});

try {
  await waitForHttp(`${baseUrl}/api/readyz`, 15_000);

  const browser = await launchBrowser();
  const page = await browser.newPage();
  const failures = [];

  page.on('console', (message) => {
    const text = message.text();
    if (forbiddenConsolePatterns.some((pattern) => pattern.test(text))) {
      failures.push(`console ${message.type()}: ${text}`);
    }
  });
  page.on('pageerror', (error) => failures.push(`page error: ${error.message}`));
  page.on('requestfailed', (failedRequest) => {
    failures.push(`request failed: ${failedRequest.url()} ${failedRequest.failure()?.errorText || ''}`.trim());
  });
  page.on('response', (assetResponse) => {
    const request = assetResponse.request();
    const resourceType = request.resourceType();
    if (['script', 'stylesheet', 'font'].includes(resourceType) && !assetResponse.ok()) {
      failures.push(`${resourceType} failed: ${assetResponse.status()} ${assetResponse.url()}`);
    }
  });

  const response = await page.goto(baseUrl, { waitUntil: 'networkidle' });
  if (!response?.ok()) failures.push(`GET / returned ${response?.status() || 'no response'}`);

  const csp = response?.headers()['content-security-policy'] || '';
  if (!/script-src[^;]*'self'/.test(csp)) failures.push(`unexpected CSP header: ${csp || '(missing)'}`);

  const hasInlineThemeScript = await page.locator('script:not([src])').evaluateAll((scripts) =>
    scripts.some((script) => script.textContent?.includes('qbackup.theme'))
  );
  if (hasInlineThemeScript) failures.push('index.html still contains an inline qbackup.theme script');

  await browser.close();

  if (failures.length) {
    throw new Error(`Production smoke failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  }
} finally {
  server.kill('SIGTERM');
  await once(server, 'exit').catch(() => null);
}

async function waitForBuildOutput() {
  const response = await fetchFileUrl(new URL('../dist/index.html', import.meta.url));
  if (!response.includes('/theme-bootstrap.js')) {
    throw new Error('dist/index.html is missing /theme-bootstrap.js. Run npm run build first.');
  }
}

async function fetchFileUrl(url) {
  const { readFile } = await import('node:fs/promises');
  return readFile(url, 'utf8');
}

async function waitForHttp(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const status = await httpStatus(url);
      if (status >= 200 && status < 500) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Server did not become ready at ${url}.\n${serverOutput || lastError?.message || ''}`.trim());
}

function httpStatus(url) {
  return new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode || 0));
    });
    req.on('error', reject);
    req.setTimeout(1000, () => {
      req.destroy(new Error(`Timed out requesting ${url}`));
    });
    req.end();
  });
}

async function launchBrowser() {
  const requestedChannel = process.env.QBACKUP_SMOKE_BROWSER;
  const attempts = requestedChannel ? [{ channel: requestedChannel }] : [{}, { channel: 'msedge' }, { channel: 'chrome' }];
  const errors = [];

  for (const options of attempts) {
    try {
      return await chromium.launch(options);
    } catch (error) {
      errors.push(`${options.channel || 'bundled chromium'}: ${error.message.split('\n')[0]}`);
    }
  }

  throw new Error(`Unable to launch a Playwright browser.\n${errors.map((error) => `- ${error}`).join('\n')}\nRun npx playwright install chromium, or set QBACKUP_SMOKE_BROWSER to an installed Chromium channel.`);
}
