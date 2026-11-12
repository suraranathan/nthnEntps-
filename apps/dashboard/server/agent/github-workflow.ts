const API = 'https://api.github.com/repos/suraranathan/nthnEntps-'
const WORKFLOW = 'nthn-build-separate.yml'

function validBranch(branch: string): boolean {
  return branch === 'main' || (/^codex\/[A-Za-z0-9][A-Za-z0-9._/-]{0,90}$/.test(branch) &&
    !branch.includes('..') && !branch.includes('//') && !branch.includes('@{') && !branch.endsWith('/') && !branch.endsWith('.lock'))
}

export class GithubWorkflowService {
  private readonly token: string
  private readonly transport: typeof fetch
  constructor(token: string, transport: typeof fetch = fetch) {
    if (!token || /\s/.test(token)) throw new Error('GitHub write credential is required.')
    this.token = token
    this.transport = transport
  }

  async dispatch(branch: string, installedVersion: string): Promise<{ dispatched: true; branch: string; workflow: string; version: string }> {
    if (!validBranch(branch)) throw new Error('Invalid GitHub branch.')
    if (!/^\d+(?:\.\d+){0,2}$/.test(installedVersion)) throw new Error('Invalid installed NTHN version.')
    let versionResponse: Response
    try {
      versionResponse = await this.transport(`${API}/contents/apps/nthn/VERSION?ref=${encodeURIComponent(branch)}`, {
        method: 'GET', signal: AbortSignal.timeout(30_000), redirect: 'error',
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'User-Agent': 'NTHN-Jef/2' },
      })
    } catch { throw new Error('GitHub version check failed.') }
    if (versionResponse.status !== 200) { await versionResponse.body?.cancel(); throw new Error(`GitHub version check failed (HTTP ${versionResponse.status}).`) }
    let version: string
    try {
      const data = await versionResponse.json() as { content?: unknown; encoding?: unknown }
      if (data.encoding !== 'base64' || typeof data.content !== 'string' || data.content.length > 100) throw new Error('invalid content')
      version = Buffer.from(data.content, 'base64').toString('utf8').trim()
    } catch { throw new Error('GitHub version file is invalid.') }
    if (!/^\d+(?:\.\d+){0,2}$/.test(version)) throw new Error('GitHub version file is invalid.')
    const parts = (value: string) => value.split('.').map(Number)
    const remote = parts(version), installed = parts(installedVersion)
    if (![0, 1, 2].some(index => (remote[index] ?? 0) !== (installed[index] ?? 0) &&
      remote.slice(0, index).every((part, prior) => part === (installed[prior] ?? 0)) && (remote[index] ?? 0) > (installed[index] ?? 0))) {
      throw new Error('GitHub branch must contain a newer NTHN version.')
    }
    let response: Response
    try {
      response = await this.transport(`${API}/actions/workflows/${WORKFLOW}/dispatches`, {
        method: 'POST', signal: AbortSignal.timeout(30_000), redirect: 'error',
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'User-Agent': 'NTHN-Jef/2' },
        body: JSON.stringify({ ref: branch }),
      })
    } catch { throw new Error('GitHub workflow request failed.') }
    if (response.status !== 204) { await response.body?.cancel(); throw new Error(`GitHub workflow dispatch failed (HTTP ${response.status}).`) }
    return { dispatched: true, branch, workflow: WORKFLOW, version }
  }

  async status(runId: string): Promise<{ runId: number; status: string; conclusion: string | null; branch: string; commit: string; url: string }> {
    if (!/^[1-9]\d{0,19}$/.test(runId)) throw new Error('Invalid GitHub workflow run.')
    let response: Response
    try {
      response = await this.transport(`${API}/actions/runs/${runId}`, {
        method: 'GET', signal: AbortSignal.timeout(30_000), redirect: 'error',
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'User-Agent': 'NTHN-Jef/2' },
      })
    } catch { throw new Error('GitHub workflow status request failed.') }
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`GitHub workflow status failed (HTTP ${response.status}).`) }
    try {
      const value = await response.json() as Record<string, unknown>
      const status = String(value.status ?? ''), conclusion = value.conclusion === null ? null : String(value.conclusion ?? '')
      const branch = String(value.head_branch ?? ''), commit = String(value.head_sha ?? ''), url = String(value.html_url ?? '')
      if (value.name !== 'Build independent nthn APK' || value.event !== 'workflow_dispatch' ||
        !['queued', 'in_progress', 'completed'].includes(status) ||
        !(conclusion === null || ['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale'].includes(conclusion)) ||
        !validBranch(branch) || !/^[0-9a-f]{40}$/.test(commit) ||
        url !== `https://github.com/suraranathan/nthnEntps-/actions/runs/${runId}` || Number(value.id) !== Number(runId)) throw new Error('invalid response')
      return { runId: Number(runId), status, conclusion, branch, commit, url }
    } catch { throw new Error('GitHub workflow status response is invalid.') }
  }
}
