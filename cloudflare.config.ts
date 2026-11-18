import { bindings, defineConfig, triggers } from 'cf/config';
import { readFileSync } from 'node:fs';

export default defineConfig(({ mode, isPreview }) => {
  if (isPreview) throw new Error('Preview deployments are disabled for this project.');
  if (mode !== 'stage' && mode !== 'production') {
    throw new Error('Use an explicit stage or production mode.');
  }
  const resources = JSON.parse(readFileSync(new URL('./deploy/resources.json', import.meta.url), 'utf8'));
  for (const target of ['stage', 'production']) {
    if (!/^[a-f0-9]{32}$/i.test(resources[target]?.namespaceId ?? '')) {
      throw new Error(`Missing or invalid ${target} namespaceId in deploy/resources.json.`);
    }
  }
  if (resources.stage.namespaceId.toLowerCase() === resources.production.namespaceId.toLowerCase()) {
    throw new Error('Stage and production must use different KV namespaces.');
  }
  const production = mode === 'production';
  const target = resources[mode];
  return {
    accountId: '3cd944aab212b5cb1b7066e32f17b426',
    worker: {
      name: production ? 'github-profile-prod' : 'github-profile-stage',
      entrypoint: 'src/index.mjs',
      // Keep local verification and deployment on the pinned workerd's supported date.
      compatibilityDate: '2026-10-13',
      workersDev: true,
      previewUrls: false,
      env: {
        PROFILE_STATS: bindings.kv({ id: target.namespaceId }),
        GITHUB_USERNAME: bindings.text('afadesigns'),
        ENABLE_REFRESH: bindings.text(production ? 'true' : 'false'),
        ...(production ? { GITHUB_TOKEN: bindings.secret(), GITHUB_CENSUS_TOKEN: bindings.secret() } : {}),
      },
      triggers: production ? [triggers.scheduled({ schedule: '0 * * * *' })] : [],
      observability: {
        enabled: true,
        redactQueryString: true,
        logs: { enabled: true },
        traces: { enabled: true, headSamplingRate: 0.01 },
      },
    },
  };
});
