import {describe, expect, it, vi} from 'vitest'

import {TextUnitedApiError, TextUnitedClient} from '../src/core/textunited/client'

function mockFetch(status: number, body = '') {
  return vi.fn(async () => new Response(body, {status}))
}

describe('TextUnitedClient', () => {
  it('sends a personal access token as a Bearer token', async () => {
    const fetch = mockFetch(200, '{"customId":"p1"}')
    const client = new TextUnitedClient({auth: {type: 'pat', token: 'tu_pat_x'}, fetch})

    await client.getProject('p1')

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.textunited.com/segments/projects/custom/p1')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tu_pat_x')
  })

  it('sends company id and API key as Basic auth', async () => {
    const fetch = mockFetch(200, '[]')
    const client = new TextUnitedClient({
      auth: {type: 'apiKey', companyId: '42', apiKey: 'secret'},
      baseUrl: 'https://api.example.test/',
      fetch,
    })

    await client.getSegments('p1', 'sections.a1')

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.example.test/segments/projects/custom/p1/segments?taskId=sections.a1')
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${btoa('42:secret')}`,
    )
  })

  it('returns null when a project does not exist', async () => {
    const client = new TextUnitedClient({
      auth: {type: 'pat', token: 'tu_pat_x'},
      fetch: mockFetch(404),
    })
    await expect(client.getProject('missing')).resolves.toBeNull()
  })

  it('replaces a task with appendContent false and instant translation on', async () => {
    const fetch = mockFetch(200, '{}')
    const client = new TextUnitedClient({auth: {type: 'pat', token: 'tu_pat_x'}, fetch})

    await client.replaceTask({
      customId: 'p1',
      taskId: 'title',
      segments: [{customId: 'seg-1', content: 'Hello'}],
      eventUrl: 'https://www.example.com/api/textunited/events',
    })

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.textunited.com/segments/projects')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toMatchObject({
      customId: 'p1',
      taskId: 'title',
      appendContent: false,
      instantTranslation: true,
      eventUrl: 'https://www.example.com/api/textunited/events',
    })
  })

  it('explains an expired or revoked token', async () => {
    const client = new TextUnitedClient({
      auth: {type: 'pat', token: 'tu_pat_x'},
      fetch: mockFetch(401),
    })
    const error = await client.createProject({
      customId: 'p1',
      taskId: 't',
      name: 'n',
      sourceLanguageCode: 'en-us',
      targetLanguages: [],
      segments: [],
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TextUnitedApiError)
    expect((error as Error).message).toMatch(/expired or been revoked/)
  })
})
