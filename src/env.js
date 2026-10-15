// Load .env into process.env with Node's built-in loader (no dotenv dependency).
// Node >= 20.12 / 21.7. Missing file is fine — the PAT can come from the environment.
try {
  process.loadEnvFile('.env');
} catch (e) {
  if (e?.code !== 'ENOENT') throw e;
}
