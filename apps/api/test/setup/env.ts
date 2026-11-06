import { TEST_ENV } from './test-env';

for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v;
for (const k of ['PLIVO_AUTH_ID', 'PLIVO_AUTH_TOKEN', 'PLIVO_CALLER_ID', 'SMTP_URL']) delete process.env[k];
