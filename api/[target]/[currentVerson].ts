import SemVer from 'semver'
import type { Endpoints } from '@octokit/types/dist-types/generated/Endpoints'

export const config = {
  runtime: 'experimental-edge',
}

const owner = process.env.GITHUB_OWNER
const repo = process.env.GITHUB_REPO

if (!process.env.GITHUB_TOKEN) {
  throw new Error('GITHUB_TOKEN is not set')
}

async function getSignature(url: string): Promise<string> {
  const response = await fetch(url)
  const text = await response.text()
  return text
}

async function getLatestRelese(target: 'x64' | 'aarch64') {
  if (!owner) {
    throw new Error('GITHUB_OWNER is not set')
  }
  if (!repo) {
    throw new Error('GITHUB_REPO is not set')
  }
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  )
  const data: Endpoints['GET /repos/{owner}/{repo}/releases/latest']['response']['data'] =
    await response.json()

  const version = data.tag_name.replace(/^(app-)?v/, '')
  if (!SemVer.valid(version)) {
    console.log(version)
    throw new Error(`Error parsing version from tag name ${data.tag_name}`)
  }
  const updateUrl = data.assets.find(
    (asset: any) =>
      asset.name.endsWith('.tar.gz') && asset.name.includes(target),
  )?.browser_download_url

  const signatureUrl = data.assets.find(
    (asset: any) => asset.name.endsWith('.sig') && asset.name.includes(target),
  )?.browser_download_url

  if (!updateUrl) {
    throw new Error('Could not find update url')
  }
  if (!signatureUrl) {
    throw new Error('Could not find signature url')
  }

  const publishDate = data.published_at
  const notes = data.body

  return {
    version,
    url: updateUrl,
    pub_date: publishDate,
    notes,
    signature: signatureUrl,
  }
}

const parseTarget = (target: string) => {
  if (target.includes('aarch64')) {
    return 'aarch64'
  }
  return 'x64'
}

const getParams = (request: Request) => {
  try {
    const { searchParams } = new URL(request.url)

    const currentVersion = searchParams.get('currentVersion') as string
    const target = searchParams.get('target') as string

    if (currentVersion && target) {
      return { currentVersion, target }
    }

    const parsed = request.url.split('?')[1].split('=')
    return {
      target: parsed[1].split('%')[0],
      currentVersion: parsed[2],
    }
  } catch (error) {
    console.log(error)
    throw new Error('Error parsing params')
  }
}

export default async function handler(request: Request) {
  const params = getParams(request)
  const currentVersion = params.currentVersion
  const target = parseTarget(params.target)

  const latestRelease = await getLatestRelese(target)

  if (SemVer.gte(currentVersion, latestRelease.version)) {
    console.log('No update available')

    return new Response(undefined, { status: 204 })
  }

  console.log('Returning latest release')
  // @ts-expect-error This is not in lib/dom right now, and we can't augment it.
  return Response.json(
    {
      ...latestRelease,
      signature: await getSignature(latestRelease.signature),
    },
    { status: 200 },
  )
}
