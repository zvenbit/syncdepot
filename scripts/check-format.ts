import fs from 'node:fs/promises';
import path from 'node:path';

const skippedDirectories = new Set(['.data', '.git', 'coverage', 'dist', 'migrations', 'node_modules', 'vendor']);
const checkedExtensions = new Set(['.css', '.html', '.js', '.json', '.md', '.sql', '.ts', '.yml', '.yaml']);

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return skippedDirectories.has(entry.name) ? [] : filesUnder(target);
    return entry.isFile() && checkedExtensions.has(path.extname(entry.name)) ? [target] : [];
  }));
  return nested.flat();
}

const errors: string[] = [];
for (const file of await filesUnder('.')) {
  const content = await fs.readFile(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, index) => {
    if (/[ \t]+$/.test(line)) errors.push(`${file}:${index + 1} 包含行尾空白`);
  });
  if (!content.endsWith('\n')) errors.push(`${file}: 文件末尾缺少换行`);
  if (content.endsWith('\n\n')) errors.push(`${file}: 文件末尾包含多余空行`);
}

if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log('格式检查通过');
}
