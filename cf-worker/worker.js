// https://github.com/ishiass/dandanplay-resource-service
// version: 0.0.5-alpha-branch-special_version-anime_garden
// build: 2026-10-10 01:24:42 GMT+0800
// wrangler: 2.4.2
// Dandanplay resource search service backed by Anime Garden.

const API_BASE = 'https://api.animes.garden'
const VERSION = '1.0.0-anime-garden'
const HOMEPAGE = 'https://animes.garden/docs/api'
const WEB_HOME =
  'https://cdn.jsdelivr.net/gh/LussacZheng/dandanplay-resource-service@dist/web/index.html'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

// These IDs are stable inside this adapter. Anime Garden itself filters by
// the type name, so the numeric IDs only exist for Dandanplay compatibility.
const TYPES = [
  { Id: 0, Name: '\u5168\u90e8' },
  { Id: 1, Name: '\u52a8\u753b' },
  { Id: 2, Name: '\u5408\u96c6' },
  { Id: 3, Name: '\u97f3\u4e50' },
  { Id: 4, Name: '\u65e5\u5267' },
  { Id: 5, Name: 'RAW' },
  { Id: 6, Name: '\u6f2b\u753b' },
  { Id: 7, Name: '\u6e38\u620f' },
  { Id: 8, Name: '\u7279\u6444' },
  { Id: 9, Name: '\u5176\u4ed6' },
]
const TYPE_BY_ID = new Map(TYPES.map(type => [type.Id, type.Name]))
const TYPE_BY_NAME = new Map(TYPES.map(type => [type.Name, type.Id]))

// The Worker isolate may be reused between requests. Keep this list in memory
// when possible, but refresh it automatically after a failed request.
let teamsPromise

function responseJson(value, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...JSON_HEADERS, 'cache-control': cache },
  })
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      'user-agent': 'dandanplay-resource-service/anime-garden',
      ...(init.headers || {}),
    },
  })

  if (!response.ok) {
    throw new Error(`Anime Garden returned HTTP ${response.status}`)
  }

  return response.json()
}

function positiveInt(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number.parseInt(value, 10)
  if (!Number.isFinite(number) || number < 1) return fallback
  return Math.min(number, maximum)
}

function parseKeyword(input) {
  const options = { page: 1, limit: 200, realtime: 0 }
  const keyword = String(input || '')
    .replace(/(?:^|\s)\$([a-z]+)(?::(\d+))?(?=\s|$)/gi, (_, name, value) => {
      const key = name.toLowerCase()
      if (key === 'page') options.page = positiveInt(value, 1, 10000)
      if (key === 'limit') options.limit = positiveInt(value, 200, 1000)
      if (key === 'realtime') options.realtime = positiveInt(value, 1, 1)
      return ''
    })
    .replace(/\$\$/g, '$')
    .trim()

  return { keyword, options }
}

async function getTeams() {
  if (!teamsPromise) {
    teamsPromise = fetchJson(`${API_BASE}/teams`)
      .then(data => (Array.isArray(data.teams) ? data.teams : []))
      .catch(error => {
        teamsPromise = undefined
        throw error
      })
  }
  return teamsPromise
}

async function getTeamName(id) {
  if (!id) return ''
  const team = (await getTeams()).find(item => Number(item.id) === Number(id))
  return team?.name || ''
}

function formatSize(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '0B'

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  let size = value
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }

  const digits = index === 0 ? 0 : size >= 100 ? 0 : size >= 10 ? 1 : 2
  return `${size.toFixed(digits)}${units[index]}`
}

function formatDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '1970-01-01 08:00:00'

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  )

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

function mapResource(resource) {
  const typeName = String(resource.type || '\u672a\u77e5\u7c7b\u578b')
  const fansub = resource.fansub && typeof resource.fansub === 'object' ? resource.fansub : null
  const publisher = resource.publisher && typeof resource.publisher === 'object' ? resource.publisher : null

  return {
    Title: String(resource.title || '\u672a\u80fd\u6210\u529f\u89e3\u6790\u6807\u9898'),
    TypeId: TYPE_BY_NAME.get(typeName) ?? -1,
    TypeName: typeName,
    SubgroupId: fansub?.id ? Number(fansub.id) : -1,
    // Some resources have no parsed fansub. Publisher is a useful readable fallback.
    SubgroupName: fansub?.name || publisher?.name || '\u672a\u77e5\u5b57\u5e55\u7ec4',
    Magnet: String(resource.magnet || 'magnet_not_found'),
    PageUrl: String(resource.href || ''),
    FileSize: formatSize(resource.size),
    PublishDate: formatDate(resource.createdAt),
  }
}

async function searchResources(url) {
  const parsed = parseKeyword(url.searchParams.get('keyword'))
  const requestedPage = url.searchParams.has('page')
    ? positiveInt(url.searchParams.get('page'), 1, 10000)
    : parsed.options.page
  const pageSize = url.searchParams.has('pageSize')
    ? positiveInt(url.searchParams.get('pageSize'), 200, 1000)
    : parsed.options.limit
  // Anime Garden rejects requests deeper than offset 10000.
  const page = Math.min(requestedPage, Math.max(1, Math.floor(10000 / pageSize)))
  const query = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  })

  if (parsed.keyword) query.set('search', parsed.keyword)

  const type = url.searchParams.get('type') || ''
  const typeId = Number.parseInt(type, 10)
  if (type && Number.isFinite(typeId) && typeId > 0 && TYPE_BY_ID.has(typeId)) {
    query.set('type', TYPE_BY_ID.get(typeId))
  } else if (type && !Number.isFinite(typeId)) {
    query.set('type', type)
  }

  const subgroup = url.searchParams.get('subgroup') || ''
  if (subgroup) {
    const subgroupName = await getTeamName(subgroup)
    if (subgroupName) query.set('fansub', subgroupName)
  }

  // Anime Garden has no realtime flag. Its resources endpoint is the indexed
  // API, so $realtime is accepted for client compatibility but has no effect.
  const data = await fetchJson(`${API_BASE}/resources?${query.toString()}`)
  const resources = Array.isArray(data.resources) ? data.resources.map(mapResource) : []

  return {
    HasMore: data.pagination ? !data.pagination.complete : resources.length >= pageSize,
    Resources: resources,
  }
}

async function listSubgroups() {
  const teams = await getTeams()
  return {
    Subgroups: teams
      .map(team => ({ Id: Number(team.id), Name: String(team.name || '') }))
      .filter(team => Number.isFinite(team.Id) && team.Name),
  }
}

function listTypes() {
  return { Types: TYPES }
}

function selfInfo() {
  return {
    name: 'dandanplay-resource-service',
    version: VERSION,
    dev: false,
    info: {
      homepage: HOMEPAGE,
      description: 'Dandanplay resource search adapter for Anime Garden.',
    },
    meta: {
      implementation: { platform: 'cf-worker', tool: 'wrangler' },
    },
    options: {
      instruction: HOMEPAGE,
      supported: ['$page', '$limit'],
    },
  }
}

const FALLBACK_HOME = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>\u5F39\u5F39play\u8D44\u6E90\u641C\u7D22\u8282\u70B9API - \${VERSION}</title>
</head>
<body>
  <h1>\u4F7F\u7528\u8BF4\u660E</h1>
  <h2>GitHub - <a href="\${HOMEPAGE}">LussacZheng/dandanplay-resource-service</a></h2>
  <p>\uFF08\u4E3B\u9875\u52A0\u8F7D\u5931\u8D25\uFF0C\u6B64\u9875\u9762\u4E3A\u9ED8\u8BA4\u9875\u9762\uFF09</p>
</body>
</html>
`

function replaceTemplate(value, variables) {
  return value.replace(/\$\{([\w-]+)\}/g, (_, key) => variables[key] ?? `\${${key}}`)
}

async function htmlHome() {
  try {
    const response = await fetch(WEB_HOME, {
      headers: {
        accept: 'text/html;charset=utf-8',
        'user-agent': 'dandanplay-resource-service/anime-garden',
      },
    })
    if (!response.ok) throw new Error(`Web page returned HTTP ${response.status}`)

    const html = await response.text()
    return new Response(
      replaceTemplate(html, { VERSION, HOMEPAGE, IMPL: 'cfw-impl' }),
      {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'access-control-allow-origin': '*',
        },
      },
    )
  } catch (error) {
    return new Response(
      replaceTemplate(FALLBACK_HOME, { VERSION, HOMEPAGE, IMPL: 'cfw-impl' }),
      {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'access-control-allow-origin': '*',
        },
      },
    )
  }
}

function notFound() {
  return responseJson({ status: 'ERROR', message: 'Not Found.' }, 404)
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: JSON_HEADERS })
    }

    if (request.method !== 'GET') {
      return responseJson({ status: 'ERROR', message: 'Method Not Allowed.' }, 405)
    }

    const url = new URL(request.url)
    const pathname = url.pathname.replace(/\/+$/, '') || '/'

    try {
      if (pathname === '/') return htmlHome()
      if (pathname === '/self') return responseJson(selfInfo(), 200, 'public, max-age=3600')
      if (pathname === '/type') return responseJson(listTypes(), 200, 'public, max-age=3600')
      if (pathname === '/subgroup') {
        return responseJson(await listSubgroups(), 200, 'public, max-age=3600')
      }
      if (pathname === '/list') return responseJson(await searchResources(url))
      return notFound()
    } catch (error) {
      return responseJson(
        {
          status: 'ERROR',
          message: error instanceof Error ? error.message : 'Upstream request failed.',
        },
        502,
      )
    }
  },
}
