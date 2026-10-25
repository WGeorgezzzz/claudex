import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const tag = process.argv[2];
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
if (tag !== `v${pkg.version}`) throw Error('Tag must match package version.');
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
async function api(endpoint, method = 'GET', body) {
  const response = await fetch(`https://api.github.com/repos/${repository}${endpoint}`, {
    method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw Error(`GitHub ${response.status}`);
  return response.json();
}
const notes = (await fs.readFile('CHANGELOG.md', 'utf8')).split('## v1.0.0')[1]?.split('\n## ')[0];
if (!notes) throw Error('Missing v1.0.0 release notes.');
const existing = (await api('/releases?per_page=100')).find(release => release.tag_name === tag);
if (existing && !existing.draft) throw Error('Refusing to modify a published release.');
const release = existing || await api('/releases', 'POST', {
  tag_name: tag, target_commitish: process.env.GITHUB_SHA, name: `Nexagent ${tag}`,
  draft: true, body: notes.trim(),
});
if (!release.draft) throw Error('Release must remain draft.');
const files = (await fs.readdir('release-assets')).map(name => `release-assets/${name}`);
execFileSync('gh', ['release', 'upload', tag, ...files, '--repo', repository, '--clobber'], { stdio: 'inherit' });
const verified = await api(`/releases/${release.id}`);
if (!verified.draft) throw Error('Draft verification failed.');
console.log(JSON.stringify({ id: verified.id, draft: verified.draft, url: verified.html_url, assets: verified.assets.map(asset => ({ name: asset.name, size: asset.size, digest: asset.digest })) }, null, 2));
