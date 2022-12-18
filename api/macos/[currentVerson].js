import { Octokit, App } from 'octokit'
import SemVer from 'semver'
import pMemoize from 'p-memoize'
import fetch from 'node-fetch'

const owner = process.env.GITHUB_OWNER
const repo = process.env.GITHUB_REPO

if (!owner) {
  throw new Error('GITHUB_OWNER is not set')
}
if (!repo) {
  throw new Error('GITHUB_REPO is not set')
}

if (!process.env.GITHUB_TOKEN) {
  throw new Error('GITHUB_TOKEN is not set')
}

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
})

async function getSignature(url) {
  const response = await fetch(url)
  const text = await response.text()
  return text
}

const memoizedSignature = pMemoize(getSignature)

async function getLatestRelese() {
  const response = await octokit.request(
    'GET /repos/{owner}/{repo}/releases/latest',
    {
      owner,
      repo,
    },
  )

  const version = response.data.tag_name.replace('app-v', '')
  if (!SemVer.valid(version)) {
    console.log(version)
    throw new Error(
      `Error parsing version from tag name ${response.data.tag_name}`,
    )
  }
  const updateUrl = response.data.assets.find((asset) =>
    asset.name.endsWith('.tar.gz'),
  )?.browser_download_url
  const signatureUrl = response.data.assets.find((asset) =>
    asset.name.endsWith('.sig'),
  )?.browser_download_url

  if (!updateUrl) {
    throw new Error('Could not find update url')
  }
  if (!signatureUrl) {
    throw new Error('Could not find signature url')
  }

  const signature = await memoizedSignature(signatureUrl)
  const publishDate = response.data.published_at
  const notes = response.data.body

  return { version, url: updateUrl, pub_date: publishDate, notes, signature }
}

export default async function handler(request, response) {
  const currentVersion = request.query.currentVerson
  const latestRelease = await getLatestRelese()

  if (SemVer.gte(currentVersion, latestRelease.version)) {
    console.log('No update available')
    response.status(204).end()
    return
  }

  console.log('Returning latest release')
  response.status(200).json(latestRelease)
}
