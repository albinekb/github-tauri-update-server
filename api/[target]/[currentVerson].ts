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

function cleanBody(body: string | null | undefined): string {
  if (!body) return ''
  return `${body.replace(/^(\* .{7}[ \s]*)/g, '* ')}`.trim()
}
function countLines(str: string) {
  return str.split(/\r\n|\r|\n/).length
}

function getVersionFromTagName(tagName: string): string {
  const version = tagName.replace(/^[\D]+/, '')
  if (!SemVer.valid(version)) {
    console.log(version)
    throw new Error(`Error parsing version from tag name ${tagName}`)
  }

  return version
}

async function collectReleaseNotes(
  latestRelease: LatestRelease,
  currentVersion: string,
) {
  const latestVersion = latestRelease.version

  const isMoreThanOneUpdateBehind = SemVer.gt(
    latestRelease.version,
    SemVer.inc(currentVersion, 'patch') || currentVersion,
  )

  if (!isMoreThanOneUpdateBehind) {
    return cleanBody(latestRelease.notes)
  }

  console.log(
    'Collecting release notes between',
    currentVersion,
    'and',
    latestVersion,
  )
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  )
  const releases: Endpoints['GET /repos/{owner}/{repo}/releases']['response']['data'] =
    await response.json()

  const releasesBetween = releases
    .map((release) => ({
      ...release,
      version: getVersionFromTagName(release.tag_name),
    }))
    .filter(
      ({ version }) =>
        SemVer.gt(version, currentVersion) &&
        SemVer.lte(version, latestVersion),
    )
    .sort((a, b) => SemVer.compare(a.version, b.version))
    .reverse()

  if (releasesBetween.length === 1) {
    return cleanBody(releasesBetween[0].body)
  }

  const notes = releasesBetween
    .map((release) => {
      const cleaned = cleanBody(release.body)
      const lines = countLines(cleaned)

      return `${release.version}\n${cleanBody(release.body)}`
    })
    .join('\n\n')

  return notes
}

type LatestRelease = {
  version: string
  url: string
  pub_date: string | null
  notes: string
  signature: string
}

async function getLatestRelese(
  target: 'x64' | 'aarch64',
): Promise<LatestRelease> {
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

  const version = getVersionFromTagName(data.tag_name)

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
  const notes = cleanBody(data.body)

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
  const currentVersion = params.currentVersion as string
  const target = parseTarget(params.target)

  const latestRelease = await getLatestRelese(target)

  if (SemVer.gte(currentVersion, latestRelease.version)) {
    console.log('No update available')

    // if (request.headers.get('sec-ch-ua')?.match(/Chromium|Chrome/)) {
    //   return new Response('No update available', { status: 200 })
    // }

    return new Response(undefined, { status: 204 })
  }

  const notes = await collectReleaseNotes(latestRelease, currentVersion)

  // @ts-expect-error This is not in lib/dom right now, and we can't augment it.
  return Response.json(
    {
      ...latestRelease,
      notes,
      signature: await getSignature(latestRelease.signature),
    },
    { status: 200 },
  )
}
