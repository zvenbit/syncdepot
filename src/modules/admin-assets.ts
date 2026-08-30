import fs from 'node:fs/promises';
import path from 'node:path';

export type AdminAssetName = 'html' | 'css' | 'theme' | 'core' | 'analytics' | 'management';

const files: Record<AdminAssetName, { file: string; contentType: string }> = {
  html: { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  css: { file: 'admin.css', contentType: 'text/css; charset=utf-8' },
  theme: { file: 'admin-theme.js', contentType: 'text/javascript; charset=utf-8' },
  core: { file: 'admin-core.js', contentType: 'text/javascript; charset=utf-8' },
  analytics: { file: 'admin-analytics.js', contentType: 'text/javascript; charset=utf-8' },
  management: { file: 'admin-management.js', contentType: 'text/javascript; charset=utf-8' },
};

export function createAdminAssetModule(options: {
  root: string;
  cache: boolean;
  readFile?: typeof fs.readFile;
}) {
  const readFile = options.readFile || fs.readFile;
  const cached = new Map<AdminAssetName, string>();

  return {
    async read(name: AdminAssetName): Promise<{ contentType: string; body: string }> {
      const asset = files[name];
      let body = cached.get(name);
      if (body === undefined) {
        body = await readFile(path.join(options.root, asset.file), 'utf8');
        if (options.cache) cached.set(name, body);
      }
      return { contentType: asset.contentType, body };
    },
  };
}
